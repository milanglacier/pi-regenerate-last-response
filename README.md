# pi-regenerate-last-response

A standard [pi](https://pi.dev) package for regenerating or clearing the latest assistant response.

It adds four slash commands:

- `/regenerate` and `/reg` regenerate the latest response.
- `/clear-last-turn` and `/clt` replace the latest completed assistant turn on the active branch with an empty assistant message.

## Install

From npm after publishing:

```bash
pi install npm:pi-regenerate-last-response
```

Or install via GitHub:

```bash
pi install github:milanglacier/pi-regenerate-last-response
```

For local development:

```bash
pi install /absolute/path/to/pi-regenerate-last-response
# or try it for one run
pi -e /absolute/path/to/pi-regenerate-last-response/src/index.ts
```

## Usage

### Regenerate the latest response

```text
/regenerate
/reg
```

The command finds the latest user message, navigates back to it, and re-sends it. If the agent is active, regeneration aborts the current run and waits for it to stop first. A fresh response is generated on a new branch.

### Clear the latest assistant turn

```text
/clear-last-turn
/clt
```

Clear is **idle-only**. It refuses while the agent is generating, retrying, compacting, or processing a continuation; it does not abort or queue work.

Conceptually, it changes the active branch from:

```text
user → assistant thinking/tool calls → tool results → assistant response
```

to:

```text
user → assistant ""
```

The replacement is one normalized assistant message whose sole text is empty. Thinking, tool calls, tool results, and subsequent assistant steps in that response are absent from the new active branch.

Pi sessions are append-only: the original response is not deleted from the session file. `/tree` can select and recover the old response branch.

> **Warning:** clearing conversation history does not undo side effects. File changes, shell commands, network requests, messages, and any other actions already performed by tools remain in effect.

Pi provider adapters generally omit empty assistant blocks from later provider payloads. The persisted session and TUI still end in the empty assistant turn.

## Development

```bash
npm run check
npm run pack:dry-run
```

## Package manifest

This package declares the extension in `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
