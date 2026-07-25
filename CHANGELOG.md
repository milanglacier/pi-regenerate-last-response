# Changelog

## Unreleased

- Adds `/clear-last-turn` and `/clt` to replace the latest completed assistant turn with a canonical empty assistant message.
- Clear is idle-only and never interrupts active generation.
- Cleared responses remain recoverable as inactive branches in Pi's append-only session tree.

## 0.1.0

- Initial release.
- Adds `/regenerate` and `/reg` slash commands to regenerate the last agent response.
