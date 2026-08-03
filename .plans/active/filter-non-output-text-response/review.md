# Review: `feat/filter-non-output-text-response` vs `master`

## Scope

One commit (`320e22b`) over merge-base `5375aca`: a module split (`index.ts` →
composition-only entrypoint, `regenerate.ts` extraction, new `koot.ts`), plus the
new `/keep-only-output-text-from-last-turn` / `/koot` feature, tests, docs, and
this plan file.

## Does the plan make sense?

Yes. The plan correctly identifies the one dangerous failure mode — filtering the
*currently executing* response would remove the tool call/result evidence between
internal provider calls and cause re-request loops — and designs around it: marks
are created only at `before_agent_start` (a top-level boundary, before the new
user message is persisted), and the `context` hook only ever transforms
*previously marked* responses. The key premises were verified against the
installed `@earendil-works/pi-coding-agent` runtime rather than taken on faith:

- `before_agent_start` fires in `prompt()` before the new user message is
  appended to the session (`agent-session.js:881`); `steer()`/`followUp()` queue
  paths return before the event, so mid-run marking is impossible. The README's
  claims about steering/queued follow-ups are accurate.
- The `context` hook is wired to the agent loop's `transformContext`, runs before
  `convertToLlm` on every LLM call, and its result is request-scoped only — so
  the transform is genuinely non-destructive. Messages are `structuredClone`'d
  first, which justifies the value-based identity keys
  (timestamp/provider/model/responseId/tool-call ids) instead of object identity.
- Session message entries pass through `sessionEntryToContextMessages` unchanged,
  so identities computed at mark time from `getBranch()` match context messages
  at request time, including after resume/reload.
- `type: "custom"` entries never enter LLM context, and they live on the session
  tree — so markers are persistent and branch-aware as designed.
- Safety rules are honored in `keepOnlyOutputTextFromMarkedResponses`: text
  blocks are recreated unsigned (`{type:"text", text}`), thinking/tool-calls/
  matching results drop as one unit, no blank signatures are fabricated, and
  textless responses emit no synthetic message.

## Does the implementation make sense?

Yes — it's faithful to the plan, including the extras that matter (`session_tree`
restore for tree navigation, dedup by initiating user entry id,
redundant-persistence avoidance, restore tolerating malformed/future entry
versions). The regenerate extraction is behavior-preserving;
`tests/regenerate.test.ts` changed only its import path. Validation:
`npm run check` (typecheck + 28/28 tests) and `npm run pack:dry-run` pass.

## Findings

None that meet the bar for a discrete, actionable bug.

Non-blocking observations (intentional design or cosmetic; no action required):

1. **Silent disarm on tree navigation** — `/koot on` appends its state entry at
   the current leaf; `/regenerate` (or any navigation to before that entry)
   triggers `session_tree` restore, which finds no state entry on the new branch
   and reverts mode to off. This is the documented "branch-aware" behavior, but a
   user who enables KOOT then immediately regenerates may not expect it disarmed.
2. **Implicit UI contract in `KootCommandState`** (`src/koot.ts:330-375`) — on
   state change, footer refresh happens only because the caller wires
   `setEnabled` → `refreshStatus`; on a no-op explicit set, `handleKootCommand`
   calls `ctx.ui.setStatus` itself. The asymmetry is invisible to the interface's
   doc.
3. **Inert marks after auto-compaction** — if compaction runs at the same prompt
   boundary, `findLastCompletedResponseGroup` can mark pre-compaction messages
   that no longer exist in context; the transform safely no-ops, leaving a dead
   (but tiny) marker entry.

## Verdict

**Correct as-is.** The plan's core safety reasoning (mark only completed prior
responses at top-level boundaries; never touch the active run) holds up against
the actual pi runtime behavior, and the implementation matches the plan's
acceptance criteria with passing typecheck, tests, and pack dry-run.
