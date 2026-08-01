# Goal

Refactor the extension into a small entrypoint plus separate command modules, then add the provider-safe `/keep-only-output-text-from-last-turn` command with `/koot` shorthand. While KOOT mode is on, submitting a new top-level prompt marks the immediately preceding completed user→assistant response so future provider requests retain only that response’s assistant output-text blocks. The newly starting response is never filtered during its own tool loop.

## Target source layout

```text
src/
├── index.ts       # Pi package entrypoint; composes command modules only
├── regenerate.ts  # Existing /regenerate and /reg implementation
└── koot.ts        # New /keep-only-output-text-from-last-turn and /koot implementation
```

The repository is currently a TypeScript source package loaded directly by Pi through `package.json` (`"pi.extensions": ["./src/index.ts"]`) and has no JavaScript build output. Therefore the organized entrypoint should remain `src/index.ts`, which is the TypeScript equivalent of the requested `index.js`. Do not add a compile-to-`index.js` build pipeline solely for this refactor.

Tests should mirror the source organization:

```text
tests/
├── regenerate.test.ts
└── koot.test.ts
```

## Design conclusion

The infinite-loop concern is valid for a design that filters the **currently executing** response before an internal tool-follow-up request. If the model’s assistant tool call and result disappear before the next provider call, the model can lose evidence that the tool was requested/executed, rethink the same step, and repeatedly request it.

The implementation must operate only at a top-level user-turn boundary:

```text
Stored session:
user-1
→ assistant/tool chain for response-1
→ user-2

Provider context when user-2 starts and KOOT is enabled:
user-1
→ one assistant message containing only response-1 text blocks
→ user-2
```

The response being generated for `user-2` remains completely intact for every internal provider request. It becomes eligible for conversion only if KOOT is still enabled when a later top-level prompt starts.

## Confirmed product decisions

- Commands: `/keep-only-output-text-from-last-turn` and `/koot`.
- Accepted arguments: `on`, `off`, or no argument (toggle).
- Mode is evaluated when a new top-level agent run begins, not when the preceding response was generated.
- When mode is on at that boundary, only the immediately preceding completed response is newly marked.
- Previously marked responses remain output-text-only after mode is turned off and after session resume/reload.
- Turning mode off prevents the next prompt from marking its preceding response; it does not restore earlier marked traces.
- Retain all assistant `text` blocks from a marked response in source order and collapse them into one assistant message.
- Persisted session messages, TUI rendering, usage totals, and local tool history remain unchanged. Only future provider context is transformed.
- Slash commands themselves do not mark a response. `/koot on` arms the behavior; the mark is created when the next actual top-level prompt begins.

## Safety rules

- Never replace thinking with `""`; opaque/encrypted signatures cannot safely be fabricated or altered.
- Never retain a marked tool call after removing its signed thinking.
- Never retain a marked tool result after removing its originating tool call.
- Remove marked assistant thinking/tool-call blocks and exact matching tool results as one unit, then synthesize one unsigned text-only assistant message.
- Never transform messages from the newly active run.
- Use Pi’s non-destructive `context` hook. Do not use `message_end` replacement, which can mutate a tool-calling assistant message before Pi executes its tools.

## Implementation plan

### 1. Turn `src/index.ts` into a composition-only entrypoint

Replace the current all-in-one implementation with a minimal extension entrypoint.

- Import `registerRegenerateCommands` from `./regenerate.ts`.
- Import `registerKootCommands` from `./koot.ts`.
- Default-export one extension factory that calls both registration functions with the same `ExtensionAPI` instance.
- Keep the entrypoint free of command logic, event state, and helper functions.
- Re-export testable public helpers and relevant types from the two modules only if preserving the package’s current import surface is useful; tests should preferably import each module directly.
- Keep `package.json` pointed at `./src/index.ts`.

Expected responsibility:

```text
index.ts
  ├─ registerRegenerateCommands(pi)
  └─ registerKootCommands(pi)
```

### 2. Move the existing regenerate feature to `src/regenerate.ts`

Move, without behavioral changes:

- `UserSessionMessageEntry`
- `findLastUserMessage()`
- `extractUserMessageText()`
- `RegeneratePI`
- `RegenerateContext`
- `handleRegenerateCommand()`
- registration of `/regenerate` and `/reg`

Refactor the old default extension export into a named registration function:

- `registerRegenerateCommands(pi: ExtensionAPI): void`

Update `tests/regenerate.test.ts` to import helpers and types from `../src/regenerate.ts` instead of `../src/index.ts`.

Acceptance for this extraction:

- No regenerate logic remains in `src/index.ts`.
- `/regenerate` and `/reg` retain exactly the current behavior and notifications.
- Existing regenerate tests pass unchanged apart from import paths.

### 3. Implement all KOOT behavior in `src/koot.ts`

Keep the feature self-contained in one module:

- command registration
- event registration
- session-local mode state
- marked-response persistence and restoration
- message identity helpers
- previous-response selection
- outgoing context transformation
- exported pure helpers/types used by `tests/koot.test.ts`

Derive the agent-message type from `ContextEvent["messages"]` so no direct dependency on `pi-agent-core` or `pi-ai` is needed.

Define versioned state:

- mode state: `{ version: 1, enabled: boolean }`
- marked response group: initiating user session-entry id, assistant message identity keys, and matching tool-result identity keys
- capture entry: `{ version: 1, group: MarkedResponseGroup }`

Use namespaced custom entry types:

- `keep-only-output-text-from-last-turn-state`
- `keep-only-output-text-from-last-turn-capture`

Do not persist thinking text, encrypted signatures, tool arguments, output text, or tool output in marker entries.

### 4. Add previous-response selection helpers in `src/koot.ts`

Add deterministic message identity helpers using stable metadata that survives `structuredClone` and context rebuilding:

- assistant: role, timestamp, provider, model, optional response id, and tool-call ids
- tool result: role, timestamp, tool-call id, and tool name

Add `findLastCompletedResponseGroup(branch)`:

1. Locate the most recent user message on the active root-to-leaf branch.
2. Examine message entries after that user through the current leaf.
3. Ignore custom/model/thinking-level/label/compaction metadata entries.
4. Collect all assistant messages belonging to that response.
5. Collect only tool-result messages whose ids match tool calls in those assistant messages.
6. Return no group if no assistant response follows the user message.
7. Use the initiating user session-entry id as the stable group id.

Deduplicate groups by that id so reloads or defensive duplicate capture entries cannot apply conversion twice.

### 5. Add the output-text-only context transformer in `src/koot.ts`

Add `keepOnlyOutputTextFromMarkedResponses(messages, groups)`:

1. Map marked assistant and tool-result identities to each marked group.
2. For each marked group present in context, collect every assistant `text` block in source order.
3. Recreate retained blocks as plain `{ type: "text", text }`, dropping `textSignature` and all reasoning/tool signatures.
4. Use the last marked assistant message as metadata for one synthetic assistant message at that message’s original position.
5. Drop all other marked assistant messages and every marked matching tool result.
6. If the response has no output text, emit no synthetic assistant message.
7. Leave all unmarked messages unchanged.
8. Tolerate target messages missing because compaction or an earlier context hook removed them.

### 6. Mark only the previous response in `before_agent_start`

Maintain module-local extension-instance state inside `registerKootCommands()`:

- `modeEnabled`
- deduplicated `markedGroups`

Register `before_agent_start`:

- If mode is off, do nothing.
- If mode is on:
  1. Read `ctx.sessionManager.getBranch()` before the new user message is persisted.
  2. Find the immediately preceding response.
  3. Do nothing if no completed response exists.
  4. Do nothing if the group is already marked.
  5. Add the group to memory immediately so the upcoming first `context` event transforms it.
  6. Persist its compact marker with `pi.appendEntry()`.

No `agent_start`/`agent_settled` capture tracker is needed. Since the new run’s messages do not exist during `before_agent_start`, they cannot accidentally enter the marker.

### 7. Transform persisted marked groups in `context`

Register `context` independently of `modeEnabled`:

- Return nothing if no marked groups exist.
- Otherwise return `keepOnlyOutputTextFromMarkedResponses(event.messages, markedGroups)`.
- Keep earlier marked responses transformed even when mode is off.
- Leave the complete current response untouched throughout internal thinking/tool-call iterations.
- Steering and queued follow-up messages within the existing run do not invoke a new `before_agent_start`, so they cannot trigger mid-run stripping.

### 8. Restore KOOT state in `session_start`

Inside `src/koot.ts`, register `session_start` to:

- reset KOOT in-memory state for the newly bound session;
- scan `ctx.sessionManager.getBranch()` root-to-leaf;
- restore the latest valid mode-state entry, defaulting to off;
- restore and deduplicate every valid capture entry on the active branch;
- ignore malformed or unsupported marker versions;
- refresh the footer indicator.

Markers remain branch-aware because they are attached to the session tree.

### 9. Register `/keep-only-output-text-from-last-turn` and `/koot`

Use one shared handler in `src/koot.ts`.

- `on`: arm marking for the next top-level prompt boundary.
- `off`: stop marking at future boundaries.
- empty argument: toggle.
- invalid input: warn with `Usage: /keep-only-output-text-from-last-turn [on|off]`.
- Avoid redundant persistence when explicitly setting the current state.
- On change:
  - update `modeEnabled`;
  - append a versioned state entry;
  - display `KOOT on` in a namespaced footer status while armed;
  - notify with boundary-specific wording.

Suggested notifications:

- On: `KOOT enabled. The previous response will become output-text-only when the next prompt starts.`
- Off: `KOOT disabled. No additional previous responses will be marked; existing marks remain active.`

### 10. Add `tests/koot.test.ts`

Keep KOOT tests separate from regenerate tests.

#### Previous-response selection

- Simple `user → assistant` response.
- Interleaved `user → assistant(tool) → toolResult → assistant(tool) → toolResult → assistant(text)` response.
- Trailing custom/state/model/thinking-level entries.
- Empty branch, user-only leaf, and no assistant after last user.
- Matching versus unrelated tool results.
- Duplicate group id handling.

#### Context transformation

- Exact boundary shape:
  - input: `user-1 → assistant trace → user-2`
  - output: `user-1 → one assistant with only text → user-2`.
- Removal of normal, redacted, and encrypted thinking.
- Removal of thinking signatures, tool thought signatures, text signatures, tool calls, and matching tool results.
- No blank thinking/signature fabrication.
- Multiple text blocks preserve source order.
- Parallel tool calls/results are paired and removed.
- Unmarked history and current-run messages remain unchanged.
- Textless marked response produces no empty assistant.
- Multiple marked responses transform independently.
- Missing/compacted target messages are safe.

#### Loop-prevention lifecycle

- `before_agent_start` marks only entries already present before the new prompt.
- First context for the new prompt contains collapsed previous output plus the new user message.
- Later internal context calls retain the new response’s thinking, tool calls, and results unchanged.
- Only a later top-level `before_agent_start` can mark that response.
- Steering/follow-up messages cannot trigger capture.

#### Mode and persistence

- `on`, `off`, bare toggle, whitespace/case normalization, and invalid arguments.
- Enabling after response-1 and starting prompt-2 marks response-1.
- Disabling before prompt-3 prevents response-2 from being marked.
- Existing response-1 marker remains effective after disabling.
- Session restoration rebuilds mode and markers from active-branch entries.

### 11. Update documentation and metadata

- `README.md`:
  - document the source module layout for contributors;
  - retain `/regenerate` and `/reg` usage;
  - document `/keep-only-output-text-from-last-turn [on|off]` and `/koot`;
  - show the prompt-boundary workflow;
  - explain that live tool chains are never stripped;
  - explain non-destructive, persistent, branch-aware behavior;
  - warn that information existing only in removed tool output/thinking is unavailable to later model requests.
- `package.json`: keep `"pi.extensions": ["./src/index.ts"]`; broaden description/keywords only as needed.
- `CHANGELOG.md`: add an Unreleased entry covering the module split and KOOT commands.
- Leave historical root planning artifacts untouched unless repository convention explicitly requires replacing them.

## Validation

Run:

1. `npm run typecheck`
2. `npm test`
3. `npm run check`
4. `npm run pack:dry-run`

Manual provider-payload smoke test:

1. Complete a task with at least two tool calls.
2. Run `/koot on`.
3. Submit a new prompt.
4. Confirm its first outgoing payload represents the preceding response as one unsigned assistant text message with no reasoning, tool-call, or tool-result items.
5. During the new response, confirm internal follow-up payloads retain the new response’s complete signed thinking/tool chain.
6. Run `/koot off`, submit another prompt, and confirm the new response was not marked while the older marker remains effective.
7. Reload/resume and confirm persistence.

## Acceptance criteria

- `src/index.ts` is a minimal composition-only Pi entrypoint.
- Existing regenerate code lives in `src/regenerate.ts`; new KOOT code lives in `src/koot.ts`.
- Tests are split by feature and import their feature modules directly.
- `/regenerate` and `/reg` retain current behavior.
- `/keep-only-output-text-from-last-turn` and `/koot` support `on`, `off`, and bare toggle.
- KOOT marks only the completed response immediately preceding a new top-level prompt.
- Provider context becomes `previous user → previous output text only → new user`.
- The current response’s thinking/tool chain remains intact throughout internal provider calls.
- Marked thinking, tool calls, and exact matching tool results are absent without fabricated blank signatures.
- Turning mode off prevents new marking but preserves prior markers.
- Session/TUI history remains untouched and behavior survives branch navigation, reload, and resume.
- Typecheck, all tests, and package dry-run pass.
