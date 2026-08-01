import test from "node:test";
import assert from "node:assert/strict";
import type {
  ContextEvent,
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  KOOT_CAPTURE_ENTRY_TYPE,
  KOOT_STATE_ENTRY_TYPE,
  KOOT_STATUS_KEY,
  KOOT_USAGE,
  deduplicateMarkedResponseGroups,
  findLastCompletedResponseGroup,
  getAssistantMessageIdentity,
  getToolResultMessageIdentity,
  handleKootCommand,
  keepOnlyOutputTextFromMarkedResponses,
  registerKootCommands,
  restoreKootState,
  type KootAgentMessage,
  type MarkedResponseGroup,
} from "../src/koot.ts";

type Message = KootAgentMessage;
type Assistant = Extract<Message, { role: "assistant" }>;
type ToolResult = Extract<Message, { role: "toolResult" }>;

let timestamp = 100;

function user(content: string, at = timestamp++): Message {
  return { role: "user", content, timestamp: at } as Message;
}

function assistant(
  content: Assistant["content"],
  at = timestamp++,
  overrides: Partial<Assistant> = {},
): Assistant {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: at,
    ...overrides,
  } as Assistant;
}

function toolResult(
  toolCallId: string,
  toolName: string,
  at = timestamp++,
): ToolResult {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: `secret output for ${toolCallId}` }],
    isError: false,
    timestamp: at,
  } as ToolResult;
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: Message,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  } as SessionEntry;
}

function customEntry(
  id: string,
  parentId: string | null,
  customType: string,
  data: unknown,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType,
    data,
  } as SessionEntry;
}

function groupFor(
  userEntryId: string,
  assistants: Assistant[],
  results: ToolResult[] = [],
): MarkedResponseGroup {
  return {
    initiatingUserEntryId: userEntryId,
    assistantMessageIdentities: assistants.map(getAssistantMessageIdentity),
    toolResultMessageIdentities: results.map(getToolResultMessageIdentity),
  };
}

test("findLastCompletedResponseGroup selects a simple latest response", () => {
  const first = assistant([{ type: "text", text: "first" }]);
  const last = assistant([{ type: "text", text: "last" }]);
  const branch = [
    messageEntry("u1", null, user("one")),
    messageEntry("a1", "u1", first),
    messageEntry("u2", "a1", user("two")),
    messageEntry("a2", "u2", last),
  ];

  assert.deepEqual(findLastCompletedResponseGroup(branch), groupFor("u2", [last]));
});

test("selection captures an interleaved assistant/tool chain and only matching results", () => {
  const a1 = assistant([
    { type: "thinking", thinking: "reason", thinkingSignature: "encrypted" },
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]);
  const r1 = toolResult("call-1", "read");
  const unrelated = toolResult("other", "bash");
  const a2 = assistant([
    { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
  ]);
  const r2 = toolResult("call-2", "bash");
  const a3 = assistant([{ type: "text", text: "done" }]);
  const branch: SessionEntry[] = [
    messageEntry("u1", null, user("go")),
    messageEntry("a1", "u1", a1),
    messageEntry("r1", "a1", r1),
    messageEntry("rx", "r1", unrelated),
    messageEntry("a2", "rx", a2),
    messageEntry("r2", "a2", r2),
    messageEntry("a3", "r2", a3),
    {
      type: "model_change",
      id: "meta",
      parentId: "a3",
      timestamp: new Date().toISOString(),
      provider: "openai",
      modelId: "gpt",
    } as SessionEntry,
  ];

  assert.deepEqual(
    findLastCompletedResponseGroup(branch),
    groupFor("u1", [a1, a2, a3], [r1, r2]),
  );
});

test("selection handles parallel tool calls and malformed legacy content", () => {
  const parallel = assistant([
    { type: "toolCall", id: "left", name: "read", arguments: {} },
    { type: "toolCall", id: "right", name: "read", arguments: {} },
  ]);
  const left = toolResult("left", "read");
  const right = toolResult("right", "read");
  const malformed = assistant([], timestamp++);
  (malformed as unknown as { content: null }).content = null;
  const branch = [
    messageEntry("u", null, user("parallel")),
    messageEntry("a1", "u", parallel),
    messageEntry("r1", "a1", left),
    messageEntry("r2", "r1", right),
    messageEntry("a2", "r2", malformed),
  ];

  assert.deepEqual(
    findLastCompletedResponseGroup(branch),
    groupFor("u", [parallel, malformed], [left, right]),
  );
});

test("selection returns null for empty, user-only, and assistant-free latest turns", () => {
  assert.equal(findLastCompletedResponseGroup([]), null);
  assert.equal(
    findLastCompletedResponseGroup([
      messageEntry("u1", null, user("unanswered")),
    ]),
    null,
  );
  assert.equal(
    findLastCompletedResponseGroup([
      messageEntry("u1", null, user("answered")),
      messageEntry("a1", "u1", assistant([{ type: "text", text: "yes" }])),
      messageEntry("u2", "a1", user("unanswered")),
      messageEntry("r", "u2", toolResult("unknown", "read")),
    ]),
    null,
  );
});

test("deduplicateMarkedResponseGroups uses the initiating user id", () => {
  const a = assistant([{ type: "text", text: "one" }]);
  const first = groupFor("u1", [a]);
  const duplicate = { ...first, assistantMessageIdentities: ["different"] };
  assert.deepEqual(
    deduplicateMarkedResponseGroups([first, duplicate]),
    [first],
  );
});

test("transform collapses exactly the marked boundary and strips every signature/trace", () => {
  const u1 = user("first");
  const a1 = assistant([
    {
      type: "thinking",
      thinking: "private",
      thinkingSignature: "opaque-encrypted-thinking",
      redacted: true,
    },
    {
      type: "text",
      text: "part one",
      textSignature: "signed-text",
    },
    {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "secret" },
      thoughtSignature: "signed-thought",
    },
  ]);
  const r1 = toolResult("call-1", "read");
  const a2 = assistant([
    { type: "thinking", thinking: "more private" },
    { type: "text", text: "part two", textSignature: "another-signature" },
  ]);
  const u2 = user("second");
  const output = keepOnlyOutputTextFromMarkedResponses(
    [u1, a1, r1, a2, u2],
    [groupFor("u1", [a1, a2], [r1])],
  );

  assert.equal(output.length, 3);
  assert.equal(output[0], u1);
  assert.equal(output[2], u2);
  assert.deepEqual((output[1] as Assistant).content, [
    { type: "text", text: "part one" },
    { type: "text", text: "part two" },
  ]);
  assert.equal((output[1] as Assistant).timestamp, a2.timestamp);
  assert.equal(JSON.stringify(output).includes("Signature"), false);
  assert.equal(JSON.stringify(output).includes("secret output"), false);
  assert.equal(JSON.stringify(output).includes("toolCall"), false);
  assert.equal(JSON.stringify(output).includes('"thinking"'), false);
});

test("transform preserves unmarked and current-run tool chains unchanged", () => {
  const old = assistant([{ type: "text", text: "old" }]);
  const current = assistant([
    { type: "thinking", thinking: "keep me", thinkingSignature: "keep signature" },
    { type: "toolCall", id: "current-call", name: "read", arguments: {} },
  ]);
  const currentResult = toolResult("current-call", "read");
  const messages = [user("old q"), old, user("new q"), current, currentResult];
  const output = keepOnlyOutputTextFromMarkedResponses(
    messages,
    [groupFor("old-user", [old])],
  );

  assert.equal(output[3], current);
  assert.equal(output[4], currentResult);
  assert.deepEqual((output[3] as Assistant).content, current.content);
});

test("textless and missing/compacted targets are safe", () => {
  const firstUser = user("q");
  const trace = assistant([
    { type: "thinking", thinking: "private" },
    { type: "toolCall", id: "c", name: "read", arguments: {} },
  ]);
  const result = toolResult("c", "read");
  const nextUser = user("next");
  const group = groupFor("u", [trace], [result]);

  assert.deepEqual(
    keepOnlyOutputTextFromMarkedResponses(
      [firstUser, trace, result, nextUser],
      [group],
    ),
    [firstUser, nextUser],
  );
  const compacted = [nextUser];
  assert.equal(
    keepOnlyOutputTextFromMarkedResponses(compacted, [group]),
    compacted,
  );
});

test("multiple marked responses transform independently", () => {
  const a1 = assistant([{ type: "text", text: "one", textSignature: "x" }]);
  const a2 = assistant([{ type: "text", text: "two", textSignature: "y" }]);
  const messages = [user("q1"), a1, user("q2"), a2, user("q3")];
  const output = keepOnlyOutputTextFromMarkedResponses(messages, [
    groupFor("u1", [a1]),
    groupFor("u2", [a2]),
  ]);
  assert.deepEqual(
    output.filter((message) => message.role === "assistant").map((message) => message.content),
    [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]],
  );
});

test("restoreKootState uses latest valid mode and deduplicates valid captures", () => {
  const a = assistant([{ type: "text", text: "answer" }]);
  const group = groupFor("u1", [a]);
  const branch = [
    customEntry("s1", null, KOOT_STATE_ENTRY_TYPE, { version: 1, enabled: true }),
    customEntry("bad", "s1", KOOT_STATE_ENTRY_TYPE, { version: 2, enabled: false }),
    customEntry("c1", "bad", KOOT_CAPTURE_ENTRY_TYPE, { version: 1, group }),
    customEntry("c2", "c1", KOOT_CAPTURE_ENTRY_TYPE, { version: 1, group }),
    customEntry("s2", "c2", KOOT_STATE_ENTRY_TYPE, { version: 1, enabled: false }),
    customEntry("malformed", "s2", KOOT_CAPTURE_ENTRY_TYPE, { version: 1, group: {} }),
  ];
  assert.deepEqual(restoreKootState(branch), {
    modeEnabled: false,
    markedGroups: [group],
  });
});

test("handleKootCommand supports on/off/toggle normalization and avoids redundant writes", async () => {
  let enabled = false;
  const entries: unknown[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  const state = {
    getEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      statuses.push([KOOT_STATUS_KEY, enabled ? "KOOT on" : undefined]);
    },
  };
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push([customType, data]);
    },
  };
  const ctx = {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push([key, text]);
      },
      notify(message: string, level?: string) {
        notifications.push([message, level]);
      },
    },
  };

  await handleKootCommand("  ON ", ctx as never, pi, state);
  assert.equal(enabled, true);
  assert.deepEqual(entries, [[KOOT_STATE_ENTRY_TYPE, { version: 1, enabled: true }]]);

  await handleKootCommand("on", ctx as never, pi, state);
  assert.equal(entries.length, 1, "explicit no-op should not persist again");

  await handleKootCommand("", ctx as never, pi, state);
  assert.equal(enabled, false);
  await handleKootCommand("OFF", ctx as never, pi, state);
  assert.equal(entries.length, 2, "redundant off should not persist");

  await handleKootCommand("maybe", ctx as never, pi, state);
  assert.deepEqual(notifications.at(-1), [KOOT_USAGE, "warning"]);
});

interface RegistrationHarness {
  api: ExtensionAPI;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  handlers: Map<string, (event: any, ctx: any) => any>;
  appended: Array<[string, unknown]>;
}

function registrationHarness(): RegistrationHarness {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const appended: Array<[string, unknown]> = [];
  const api = {
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
    appendEntry(type: string, data: unknown) {
      appended.push([type, data]);
    },
  } as ExtensionAPI;
  return { api, commands, handlers, appended };
}

function eventContext(branch: SessionEntry[]) {
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  return {
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push([key, text]);
      },
      notify(message: string, level?: string) {
        notifications.push([message, level]);
      },
    },
    statuses,
    notifications,
  };
}

test("lifecycle marks only the previous turn and leaves the active tool loop intact", async () => {
  const harness = registrationHarness();
  registerKootCommands(harness.api);
  assert.ok(harness.commands.has("keep-only-output-text-from-last-turn"));
  assert.ok(harness.commands.has("koot"));

  const oldAssistant = assistant([
    { type: "thinking", thinking: "old thought" },
    { type: "text", text: "old output" },
  ]);
  const oldUser = user("prompt 1");
  const branch1 = [
    messageEntry("u1", null, oldUser),
    messageEntry("a1", "u1", oldAssistant),
  ];
  const ctx1 = eventContext(branch1);
  harness.handlers.get("session_start")?.({ type: "session_start" }, ctx1);
  await harness.commands.get("koot")?.("on", ctx1);
  harness.handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx1);
  assert.equal(harness.appended.at(-1)?.[0], KOOT_CAPTURE_ENTRY_TYPE);

  const newUser = user("prompt 2");
  const firstContext = harness.handlers.get("context")?.(
    { type: "context", messages: [oldUser, oldAssistant, newUser] },
    ctx1,
  );
  assert.deepEqual(firstContext.messages[1].content, [
    { type: "text", text: "old output" },
  ]);

  const currentAssistant = assistant([
    { type: "thinking", thinking: "current thought", thinkingSignature: "signed" },
    { type: "toolCall", id: "new-call", name: "read", arguments: {} },
  ]);
  const currentResult = toolResult("new-call", "read");
  const internalMessages = [
    oldUser,
    oldAssistant,
    newUser,
    currentAssistant,
    currentResult,
  ];
  const internalContext = harness.handlers.get("context")?.(
    { type: "context", messages: internalMessages },
    ctx1,
  );
  assert.equal(internalContext.messages.at(-2), currentAssistant);
  assert.equal(internalContext.messages.at(-1), currentResult);

  const finalAssistant = assistant([{ type: "text", text: "new output" }]);
  const branch2 = [
    ...branch1,
    messageEntry("u2", "a1", newUser),
    messageEntry("a2", "u2", currentAssistant),
    messageEntry("r2", "a2", currentResult),
    messageEntry("a3", "r2", finalAssistant),
  ];
  const ctx2 = eventContext(branch2);
  harness.handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx2);
  assert.equal(
    harness.appended.filter(([type]) => type === KOOT_CAPTURE_ENTRY_TYPE).length,
    2,
    "only a later top-level boundary marks response 2",
  );
});

test("disabling blocks new captures while restored old captures stay transformed", async () => {
  const harness = registrationHarness();
  registerKootCommands(harness.api);
  const old = assistant([{ type: "text", text: "old", textSignature: "signed" }]);
  const group = groupFor("u1", [old]);
  const branch = [
    customEntry("state-on", null, KOOT_STATE_ENTRY_TYPE, { version: 1, enabled: true }),
    customEntry("capture", "state-on", KOOT_CAPTURE_ENTRY_TYPE, { version: 1, group }),
    messageEntry("u2", "capture", user("second")),
    messageEntry("a2", "u2", assistant([{ type: "text", text: "second answer" }])),
  ];
  const ctx = eventContext(branch);
  harness.handlers.get("session_start")?.({ type: "session_start" }, ctx);
  await harness.commands.get("koot")?.("off", ctx);
  const capturesBefore = harness.appended.filter(([type]) => type === KOOT_CAPTURE_ENTRY_TYPE).length;
  harness.handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
  assert.equal(
    harness.appended.filter(([type]) => type === KOOT_CAPTURE_ENTRY_TYPE).length,
    capturesBefore,
  );

  const transformed = harness.handlers.get("context")?.(
    { type: "context", messages: [user("first"), old, user("third")] },
    ctx,
  );
  assert.deepEqual(transformed.messages[1].content, [{ type: "text", text: "old" }]);
  assert.deepEqual(ctx.statuses.at(-1), [KOOT_STATUS_KEY, undefined]);
});
