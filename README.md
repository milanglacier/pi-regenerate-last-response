# pi-regenerate-last-response

A standard [pi](https://pi.dev) package providing response regeneration and provider-safe output-text-only history controls.

## Install

From npm after publishing:

```bash
pi install npm:pi-regenerate-last-response
```

Or from GitHub/local source:

```bash
pi install github:milanglacier/pi-regenerate-last-response
pi install /absolute/path/to/pi-regenerate-last-response
# try it for one run
pi -e /absolute/path/to/pi-regenerate-last-response/src/index.ts
```

## Regenerate

Use `/regenerate` or its `/reg` shorthand. The command finds the most recent user message, navigates back to it, and resends it so pi generates a fresh response on a new branch.

## Keep only output text (KOOT)

```text
/keep-only-output-text-from-last-turn [on|off]
/koot [on|off]
```

The argument may be `on`, `off`, or omitted to toggle the mode. Enabling KOOT arms the next top-level prompt boundary:

```text
user-1 → complete assistant/tool response-1 → /koot on → user-2
```

Future provider context represents that boundary as:

```text
user-1 → one assistant message containing response-1 output text → user-2
```

All assistant text blocks are retained in order. Thinking, tool calls, and their matching tool results are omitted from future provider requests. The response currently being generated is never filtered during its own tool loop; it can only be marked when a later top-level prompt begins. Slash commands, steering, and queued follow-ups do not mark a response.

KOOT is non-destructive: persisted session messages, TUI history, tool history, and usage totals remain unchanged. Mode changes and response markers are persistent and branch-aware. Turning KOOT off prevents new marks but does not restore traces from responses already marked for provider context. If information existed only in removed thinking or tool output, later model requests will no longer receive it.

## Development

The TypeScript source is loaded directly by pi:

```text
src/
├── index.ts       # composition-only package entrypoint
├── regenerate.ts  # /regenerate and /reg
└── koot.ts        # output-text-only commands and lifecycle hooks

tests/
├── regenerate.test.ts
└── koot.test.ts
```

Run all checks with:

```bash
npm run check
npm run pack:dry-run
```

The package manifest intentionally points to the TypeScript entrypoint:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
