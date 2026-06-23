# Goal

Fix `/regenerate` and `/reg` so they truly regenerate the last assistant response from the previous user prompt’s parent context, instead of appending the previous prompt onto the still-active old agent context.

## Debug findings

- Current implementation is in `src/index.ts`.
- The command handler finds the right last user entry with `findLastUserMessage()`.
- The bug is in `src/index.ts:54-70`:
  - It casts `ctx.sessionManager` to the full `SessionManager`.
  - It calls `resetLeaf()` / `branch()` directly on the session manager.
  - It then calls `pi.sendUserMessage(message.content)`.
- Directly mutating `SessionManager` only moves the persisted session leaf. It does **not** update the live `AgentSession.agent.state.messages` that the model uses for the next provider request.
- Pi’s own tree navigation path (`AgentSession.navigateTree`) does both:
  1. moves the session leaf, and
  2. rebuilds live agent context via `this.agent.state.messages = this.sessionManager.buildSessionContext().messages`.
- Because the current extension bypasses `navigateTree`, the next model turn still contains the old branch in memory, then appends the repeated user message. That matches the observed behavior: the agent sees the previous question/answer history and interprets the resent prompt as the user asking the same thing again, not as a regenerated response.
- Existing tests pass because they only cover `findLastUserMessage()` and do not exercise command/session state synchronization.

## Fix approach

Use the public command-safe API `ctx.navigateTree(userEntry.id, { summarize: false })` instead of directly casting and mutating `SessionManager`.

Why this works:

- Selecting a user message via `navigateTree()` has exactly the semantics needed for regeneration:
  - leaf becomes the selected user message’s parent,
  - root user messages reset to the empty root,
  - live agent state is rebuilt from the new leaf,
  - no old assistant response remains in LLM context.
- After navigation completes, call `pi.sendUserMessage(userEntry.message.content)` to create a new user entry on a sibling branch and trigger a fresh assistant response.

## Concrete implementation steps

1. Update imports in `src/index.ts`:
   - Remove the `SessionManager` value import, because the extension should no longer cast the read-only session manager.
   - Keep the existing type imports needed by `findLastUserMessage()` and the command handler.

2. Replace `src/index.ts:54-63` manual branching block with command navigation:
   - Call `const nav = await ctx.navigateTree(userEntry.id, { summarize: false });`
   - If `nav.cancelled`, notify something like `"Regeneration cancelled"` and return.
   - Do not call `resetLeaf()` or `branch()` directly.

3. Keep the existing leaf guard:
   - `if (userEntry.id === leaf?.id)` should still notify `"No agent response to regenerate"`.
   - This prevents resending a user message that has no assistant response yet.

4. Send the original content after successful navigation:
   - Keep `pi.sendUserMessage(message.content)`.
   - Keep `ctx.ui.notify("Regenerating last response...", "info")`.

5. Prevent stale editor text if needed:
   - `ctx.navigateTree()` may prefill the editor with the selected user message, because that is normal `/tree` behavior.
   - After `pi.sendUserMessage(...)`, clear only the navigation-prefilled editor text if it exactly matches the regenerated prompt text. Avoid unconditionally clearing arbitrary user/editor state.
   - If this is awkward to test, make this a small helper that extracts text from user message content for comparison.

6. Consider extracting the command handler for tests:
   - Export an internal helper such as `handleRegenerateCommand(pi, ctx)` or a smaller `regenerateFromBranch(pi, ctx)`.
   - The default extension registration can call this helper for both `regenerate` and `reg`.

## Test plan

1. Keep the existing `findLastUserMessage()` unit tests.

2. Add command-handler unit tests with lightweight mocks:
   - Idle normal case:
     - branch is `[assistant e4, user e3, assistant e2, user e1]`.
     - assert `ctx.navigateTree("e3", { summarize: false })` is awaited.
     - assert `pi.sendUserMessage("second question")` is called after navigation.
     - assert `ctx.sessionManager.branch` / `resetLeaf` are not required by the mock.
   - Root user case:
     - branch is `[assistant e2, user e1(parentId null)]`.
     - assert `ctx.navigateTree("e1", { summarize: false })`, not manual `resetLeaf()`.
   - Cancellation:
     - mock `navigateTree()` returns `{ cancelled: true }`.
     - assert `pi.sendUserMessage` is not called.
   - Running agent case:
     - `ctx.isIdle()` returns false.
     - assert `ctx.abort()` then `ctx.waitForIdle()` before `ctx.navigateTree()`.
   - Leaf-is-user guard:
     - branch leaf is the user entry.
     - assert no navigation/send, notify `"No agent response to regenerate"`.

3. Run validation:
   - `npm run check`
   - Optional manual smoke test in pi:
     1. Start pi with this extension.
     2. Ask a question.
     3. Run `/reg`.
     4. Confirm the provider context does not include the old assistant answer before the regenerated turn.

## Acceptance criteria

- `/reg` and `/regenerate` create a sibling branch from the previous user prompt’s parent.
- The regenerated model call sees only the context before that previous user prompt plus a freshly sent copy of the prompt.
- The old assistant response is not included in the next LLM context.
- No private `SessionManager` cast remains.
- Existing and new tests pass with `npm run check`.
