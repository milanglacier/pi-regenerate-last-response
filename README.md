# pi-regenerate-last-response

A standard [pi](https://pi.dev) package that adds `/regenerate` and `/reg` slash commands.

`/regenerate` regenerates the last agent response by branching back to the preceding user message and re-triggering the agent.

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

```text
/regenerate
```

Or the shorthand:

```text
/reg
```

The command regenerates the last agent response by finding the most recent user message, branching to its parent, and re-sending the user message to the agent. A fresh response is generated on a new branch.

## Development

```bash
npm run check
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
