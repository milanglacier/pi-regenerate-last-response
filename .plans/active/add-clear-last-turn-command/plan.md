# Goal

Add `/clear-last-turn` and `/clt` to the existing pi extension so an idle session can replace the latest completed assistant turn—including thinking, tool calls, tool results, and subsequent assistant steps—with one canonical assistant message whose sole output text is `""`.

## Chosen implementation boundary

Use a **narrow, runtime-checked cast** from Pi’s read-only extension `sessionManager` view to only the concrete methods needed: `branch()` and `appendMessage()`.

Why:

- Pi sessions are append-only, and the public extension API has no operation for appending a synthetic assistant message.
- A synthetic provider request intercepted through `message_end` would use public APIs, but would unnecessarily require authentication/network access, incur latency and token cost, and introduce one-shot cleanup failure modes.
- The compatibility bridge gives exact, immediate behavior without an LLM request. Keep it isolated, verify both methods exist before mutation, fail safely when unavailable, and document that a future Pi release could require adapting this helper.

Do not rewrite existing JSONL lines. “Replace” means creating a new active sibling branch; the original response remains available in the session tree.

## Command semantics

- Register `/clear-last-turn` and `/clt` with one shared handler.
- If `ctx.isIdle()` is false, notify and return immediately. Unlike `/regenerate`, never call `abort()`, never wait, and never queue the command.
- Require the current raw session leaf to be a finalized assistant message and require a preceding user message on the active branch.
- In the suffix beginning at the latest user message, find the first assistant entry. Treat that entry and everything after it through the assistant leaf as the response being cleared.
- Branch from the entry immediately before that first assistant entry. This is normally the user entry, but preserves any pre-response custom/control entries injected between the user prompt and first assistant message.
- Append a canonical synthetic assistant message:
  - `content: [{ type: "text", text: "" }]`
  - `stopReason: "stop"`
  - zero token usage and zero cost
  - fresh timestamp
  - `api`, `provider`, `model`, and forward-compatible assistant metadata copied from the old final assistant
  - prior `errorMessage` removed
- If the current leaf already has this canonical empty shape, report an informational no-op rather than creating another branch.
- On success, notify that the last assistant turn was cleared.

## Session and live-runtime synchronization

Direct `SessionManager` mutation alone does not update `AgentSession.agent.state.messages`, so synchronize through public tree navigation:

1. Read `getBranch()` in root-to-leaf order and fully validate the turn before any mutation.
2. Save the original assistant leaf ID and branch-point ID.
3. Runtime-check that the concrete manager exposes `branch` and `appendMessage`.
4. Branch to the branch point and append the synthetic empty assistant; save its new entry ID.
5. Navigate to the original assistant leaf with `ctx.navigateTree(originalLeafId, { summarize: false })`.
   - Since live agent state still contains the original branch, this navigation synchronizes the session-manager leaf and runtime/TUI to that same known-good branch.
   - If append fails, or this first navigation is cancelled/throws, directly restore the session-manager leaf to the original leaf. The runtime never left the original branch, so state remains consistent. The command reports cancellation/error.
6. Navigate to the synthetic assistant entry with `ctx.navigateTree(emptyAssistantId, { summarize: false })`.
   - This activates the new branch and rebuilds live model context/TUI from it.
   - If this second navigation is cancelled, the original branch remains active; the unselected synthetic entry is harmless append-only history.
7. Both navigation targets are assistant entries, so the command must not alter editor text.

## Code changes

### `src/index.ts`

- Keep `/regenerate` and `/reg` behavior unchanged.
- Add an assistant session-entry type guard.
- Add a pure turn-analysis helper returning either:
  - `{ originalLeaf, branchPoint }`, or
  - a reason such as empty history, non-assistant leaf, no preceding user, unresolved tool-use leaf, or already canonical-empty.
- Add a pure helper that builds the canonical empty assistant message and zeroes all known usage/cost fields while retaining unknown forward-compatible fields.
- Add an isolated compatibility helper/type exposing only `branch()` and `appendMessage()` and checking both functions at runtime before use.
- Export `handleClearLastTurnCommand()` for tests.
- Register both new command names and descriptions through one shared handler.
- Keep command errors contained and surfaced through `ctx.ui.notify(..., "error")`.

### Tests

Prefer a new `tests/clear-last-turn.test.ts` so existing regeneration tests remain focused. Add lightweight session/navigation mocks covering:

#### Turn analysis

- Normal `user → assistant` selects the user as branch point.
- `user → assistant(tool call) → tool result → assistant(final)` selects the point before the first assistant, proving the entire response span is removed.
- A pre-response custom/control entry between user and first assistant is retained as the branch point.
- Empty branch, user leaf, tool-result leaf, non-message leaf, assistant-only history, and no preceding user are rejected.
- A leaf assistant with unresolved `toolUse` is rejected defensively.
- A canonical empty assistant is recognized as already clear.
- Empty/error or empty/aborted assistant messages that are not canonical can still be normalized.

#### Synthetic assistant shape

- Exactly one empty text block and no thinking/tool-call content.
- `stopReason: "stop"` and no `errorMessage`.
- All token and cost counters are zero, including total fields.
- Provider/model/API and unknown metadata are retained.
- Timestamp is refreshed.

#### Handler behavior and ordering

- Busy state only notifies; it never aborts, waits, mutates, appends, or navigates.
- Successful order is: validate → branch → append → navigate original → navigate synthetic.
- Appended assistant is a direct child of the chosen branch point.
- First-navigation cancellation or failure restores the original session leaf and does not activate the synthetic branch.
- Second-navigation cancellation leaves the original branch active.
- Missing concrete mutation methods fail before changing the branch.
- Append failures roll the manager leaf back to the original assistant.
- Already-clear and all ineligible cases perform no mutation.
- Long and shorthand commands invoke the same handler (verify through a registration mock or shared handler assertions).
- Errors are converted to user-visible error notifications.

## Documentation and metadata

### `README.md`

- Describe all four commands: `/regenerate`, `/reg`, `/clear-last-turn`, `/clt`.
- Explain that clear is idle-only and does not interrupt active generation.
- Show the conceptual transformation and state that thinking/tool trace entries are removed from the **active branch**.
- Explain append-only behavior: `/tree` can still recover the old response.
- Warn prominently that clearing conversation history does **not** undo file changes, shell commands, network calls, or other tool side effects already performed.
- Note that Pi provider adapters generally omit empty assistant blocks from later provider payloads; the persisted session/TUI still ends in the requested empty assistant turn.

### `CHANGELOG.md`

- Add an `Unreleased` section documenting both commands, idle-only behavior, and append-only branch preservation.

### `package.json`

- Broaden the description to mention both regenerating and clearing the latest response.
- Keep version `0.1.0` unless a release/version bump is separately requested.
- Do not raise the Pi peer dependency solely for this feature; the concrete methods exist in the currently installed compatibility baseline.

## Edge-case policy

| Case | Behavior |
|---|---|
| Agent streaming, retrying, compacting, or draining a queued continuation | Refuse; never abort or queue `/clt` |
| Empty session / no preceding user | Informational no-op |
| Raw leaf is user, tool result, custom/control entry, or compaction | Refuse because the active branch does not end in an assistant turn |
| Leaf assistant contains unresolved tool calls | Refuse to avoid malformed/orphan tool history |
| Final assistant ended with `length`, `error`, or `aborted` and has content | Allow clearing and normalize the replacement to canonical empty/`stop` |
| Empty error/aborted assistant | Replace unless it already matches the full canonical empty shape |
| Turn contains thinking and tools | Remove the whole response span from the new active branch, not only final text |
| Tools changed files or external systems | History only is cleared; side effects remain |
| Already canonical-empty assistant | Informational no-op; no redundant sibling branch |
| Another extension vetoes tree navigation | Keep/restore the original active branch and report cancellation |
| Concrete manager methods unavailable after a future Pi change | Fail before mutation with a compatibility error |
| Persisted session reload | Empty branch survives because it is appended to JSONL; old response remains in the tree |
| Later provider request | Empty assistant is usually omitted by provider serialization, avoiding invalid empty-content payloads |

## Validation

- Run `npm run check`.
- Run `npm run pack:dry-run`.
- Manual TUI smoke test with Pi 0.82.x:
  1. Clear a plain final response.
  2. Clear a response that used a tool and confirm all response/tool trace entries disappear from the active transcript.
  3. Confirm `/tree` still exposes and can restore the original response branch.
  4. Invoke `/clt` during streaming and confirm generation continues uninterrupted while the command refuses.
  5. Invoke `/clt` twice and confirm the second call is a no-op.
  6. Send a later user prompt and confirm old assistant/tool content is absent from active model context.
  7. Reload/resume the session and confirm the empty branch remains active.

## Acceptance criteria

- `/clear-last-turn` and `/clt` invoke identical idle-only behavior.
- A successful clear leaves the active branch ending in the prior user turn/pre-response context plus one assistant message whose sole output text is `""`.
- Thinking, tool calls, and tool results from the cleared response are absent from active context and transcript.
- The original response remains recoverable as an abandoned session-tree branch.
- Active generation is never aborted and no provider request is made by the clear command.
- The unsupported compatibility bridge is isolated, runtime-checked, and rollback-safe.
- Existing regeneration behavior remains unchanged and all checks pass.
