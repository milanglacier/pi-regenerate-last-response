# Changelog

## Unreleased

- Split the extension into a composition-only entrypoint and separate regenerate and KOOT modules.
- Add `/keep-only-output-text-from-last-turn` and `/koot` with persistent, branch-aware `on`, `off`, and toggle behavior.
- Transform marked responses non-destructively for future provider context while preserving active tool loops and stored history.

## 0.1.0

- Initial release.
- Adds `/regenerate` and `/reg` slash commands to regenerate the last agent response.
