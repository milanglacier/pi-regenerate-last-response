# Plan: `/regenerate` and `/reg` slash commands

## Goal

Implement a pi extension package that adds `/regenerate` (and shorthand `/reg`) — a slash command
that regenerates the last agent response by branching back to the preceding user message and re-triggering
the agent. The package follows the structure and quality standards of `pi-session-local-model-switch`
(full npm-package layout, strict TypeScript, extracted pure functions, tests).

## API feasibility

- `ctx.isIdle()` — check if an agent turn is actively running.
- `ctx.abort()` — forcefully stop the current agent turn.
- `ctx.waitForIdle()` — await agent idle state (cleanup after abort).
- `ctx.sessionManager.getBranch()` — walk entries from leaf to root.
- `ctx.sessionManager.branch(entryId)` — move leaf to an earlier entry.
- `pi.sendUserMessage(content)` — inject a user message; always triggers a turn when idle.

**Conclusion: both paths are feasible.**

### Path A — agent is idle (normal case)

Find the last user message, branch to its parent entry, and call
`pi.sendUserMessage()` with the original user message content.  The agent re-responds
from that point, creating a new branch for the regenerated response.

### Path B — agent is actively running

Call `ctx.abort()`, then `await ctx.waitForIdle()`.  The current (now-aborted)
assistant response is finalized with `stopReason: "aborted"`.  Proceed exactly as
in Path A.  The aborted, incomplete response stays on the old branch; the new
branch gets a fresh full response.

No fallback to a "can't run" notification is needed — abort+wait works.

## How it works — session tree mechanics

### Normal case (leaf is an assistant message)

Given this tree (leaf = entry-4):

```
user-1 ──► assistant-2 ──► user-3 ──► assistant-4  ← current leaf
```

1. Walk backward from leaf-4; find the user message that triggered the last agent
   response → **entry-3** (`user-3`).
2. The parent of entry-3 is **entry-2** (`assistant-2`).
3. `ctx.sessionManager.branch(entry-2.id)` → leaf becomes entry-2.
4. `pi.sendUserMessage(user-3.content)` → a new user entry-5 is added as child of entry-2.
5. The agent responds → new assistant entry-6 as child of entry-5.

Result:

```
user-1 ──► assistant-2 ──► user-3 ──► assistant-4   (old, abandoned branch)
                        \─► user-5 ──► assistant-6   (new, regenerated branch)
```

Entry-5 has the same content as entry-3, and the agent generates a fresh response
(entry-6 replaces entry-4 conceptually).

### Repeated /reg calls

Each `/reg` walks the **current active branch** from leaf to root.  If a
regeneration is still in progress when the next `/reg` arrives, the handler
aborts the in-progress turn, waits for idle, then finds the user message for the
(now aborted) response and regenerates again.  Repeated calls produce sibling
branches off the same parent, each attempt independent.

## Package structure

```
pi-regenerate-last-response/
├── package.json          # npm package with "pi" field declaring extension
├── tsconfig.json         # strict TypeScript config
├── .gitignore            # node_modules, *.tgz, etc.
├── README.md             # install & usage instructions
├── CHANGELOG.md          # version history
├── LICENSE               # MIT
├── src/
│   └── index.ts          # extension entry point (default export)
└── tests/
    └── regenerate.test.ts # unit tests for pure functions
```

## Implementation details

### `src/index.ts`

Exports a default function `regenerateExtension(pi: ExtensionAPI)` that registers
two commands (`"regenerate"` and `"reg"`).

**Pure exported functions** (testable without pi runtime):

- `findLastUserMessage(entries: SessionEntry[]): SessionEntry | null`
  Walks the branch (leaf → root, index 0 = leaf) and returns the first entry
  whose `type === "message"` and `message.role === "user"`.  Non-message entries
  (`model_change`, `thinking_level_change`, `custom`, `label`, `compaction`,
  `branch_summary`, `session_info`) are skipped.  Returns `null` if none found.

  In normal usage the leaf is always an assistant or tool-result message (pi
  starts the agent immediately after appending a user message, so the leaf
  moves past the user entry before any further user input can be processed).
  If the leaf happens to be a user message (agent crashed before producing
  output, or a theoretical race), the caller checks `userEntry.id === leaf.id`
  and notifies — there is no agent response to regenerate.

**Command handler logic:**

1. If `!ctx.isIdle()` → `ctx.abort()` then `await ctx.waitForIdle()`.
2. Get branch entries via `ctx.sessionManager.getBranch()`.
3. `findLastUserMessage(branch)` → if `null`, notify `"Nothing to regenerate"` and return.
4. If `userEntry.id === leaf.id` → the last user message has no response yet.
   Notify `"No agent response to regenerate"` and return.
5. Get the parent entry ID of the user message: `userEntry.parentId`.
   - If `parentId` is `null` (first message in session), `branch(null)` resets to root.
6. `ctx.sessionManager.branch(parentId)` — rewind the leaf.
7. Extract the user message content (`userEntry.message.content`).
8. `pi.sendUserMessage(content)` — triggers the agent for a fresh response.
9. Notify `"Regenerating last response..."` (info).

**Error handling:**
- Wrap the body in try/catch; on error notify via `ctx.ui.notify(error.message, "error")`.

### `tests/regenerate.test.ts`

Uses `node:test` + `node:assert/strict` (same as the reference package).

Test `findLastUserMessage`:
- Normal: `user → assistant → user → assistant` (leaf = assistant) → returns second user.
- Only one user, leaf is assistant: `user → assistant` → returns the user.
- No user messages at all (assistant-only, defensive): returns `null`.
- Empty branch: returns `null`.
- Non-message entries interspersed: `user → model_change → assistant → user → assistant` → correctly skips `model_change` and finds the second user.
- Two consecutive user messages (unusual but defensive): `user-1 → user-2 → assistant` → returns user-2 (first from leaf).

## Configuration files

### `package.json`

```jsonc
{
  "name": "pi-regenerate-last-response",
  "version": "0.1.0",
  "description": "A pi extension that adds /regenerate and /reg slash commands to regenerate the last agent response.",
  "type": "module",
  "license": "MIT",
  "author": "Milan Glacier",
  "keywords": ["pi-package", "pi", "pi-extension"],
  "files": ["src", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "node": ">=18.0.0" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test tests/*.test.ts",
    "check": "npm run typecheck && npm test",
    "pack:dry-run": "npm pack --dry-run"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

### `tsconfig.json`

Identical to the reference package (ES2022 target, NodeNext module, strict mode).

### `.gitignore`

Match the reference (node_modules/, *.tgz, .DS_Store, etc.).

## Edge cases & defensive behavior

| Scenario | Behavior |
|----------|----------|
| No messages in session | Notify `"Nothing to regenerate"` |
| Only one user message, never responded | Notify `"No agent response to regenerate"` |
| Leaf is a user message (agent never responded) | Notify `"No agent response to regenerate"`.  This should not happen in normal usage (pi starts the agent immediately). |
| Non-message entries between messages (model_change, custom, etc.) | `findLastUserMessage` skips them |
| Agent is running when `/reg` is invoked | Abort → wait for idle → proceed |
| Abort + wait times out or fails | Catch error, notify user |
| Multiple extensions register same command | pi auto-suffixes (`/reg:1`); still works |

## Shared utilities decision

Keep `findLastUserMessage` as the single pure exported function — a simple
backward linear scan.  The command handler is thin enough (abort/wait, find
entry, branch, send) that extracting more would add indirection without
improving testability.  Pure function tests cover the "find the right user
message" logic.
