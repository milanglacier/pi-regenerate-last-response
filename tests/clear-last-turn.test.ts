import test from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import registerExtension, {
  analyzeLastAssistantTurn,
  createCanonicalEmptyAssistant,
  handleClearLastTurnCommand,
  type ClearLastTurnContext,
} from "../src/index.ts";

type AssistantEntry = Extract<
  ReturnType<typeof analyzeLastAssistantTurn>,
  { ok: true }
>["originalLeaf"];
type AssistantMessage = AssistantEntry["message"];

const usage = {
  input: 11,
  output: 12,
  cacheRead: 13,
  cacheWrite: 14,
  cacheWrite1h: 15,
  totalTokens: 50,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
  },
};

function userMsg(id: string, parentId: string | null, content = "question"): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content, timestamp: Date.now() },
  } as SessionEntry;
}

function assistantMsg(
  id: string,
  parentId: string | null,
  overrides: Partial<AssistantMessage> = {},
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: structuredClone(usage),
      stopReason: "stop",
      timestamp: 123,
      ...overrides,
    },
  } as SessionEntry;
}

function customEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: "control",
    data: { retain: true },
  } as SessionEntry;
}

function toolResult(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: Date.now(),
    },
  } as SessionEntry;
}

function nonMessage(id: string, parentId: string | null): SessionEntry {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    provider: "openai",
    modelId: "gpt-4o",
  } as SessionEntry;
}

function canonicalAssistant(id: string, parentId: string): SessionEntry {
  return assistantMsg(id, parentId, {
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

// ---- Turn analysis ----

test("analysis selects the user before a normal assistant response", () => {
  const result = analyzeLastAssistantTurn([
    userMsg("u", null),
    assistantMsg("a", "u"),
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.originalLeaf.id, "a");
    assert.equal(result.branchPoint.id, "u");
  }
});

test("analysis removes the complete tool response span", () => {
  const result = analyzeLastAssistantTurn([
    userMsg("u", null),
    assistantMsg("tool-call", "u", {
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    }),
    toolResult("tool-result", "tool-call"),
    assistantMsg("final", "tool-result"),
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.originalLeaf.id, "final");
    assert.equal(result.branchPoint.id, "u");
  }
});

test("analysis retains pre-response custom/control entries", () => {
  const result = analyzeLastAssistantTurn([
    userMsg("u", null),
    customEntry("control", "u"),
    assistantMsg("a", "control"),
  ]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.branchPoint.id, "control");
});

const rejectedBranches: Array<[string, SessionEntry[], string]> = [
  ["empty history", [], "empty-history"],
  ["user leaf", [userMsg("u", null)], "non-assistant-leaf"],
  [
    "tool-result leaf",
    [userMsg("u", null), toolResult("t", "u")],
    "non-assistant-leaf",
  ],
  [
    "non-message leaf",
    [userMsg("u", null), nonMessage("m", "u")],
    "non-message-leaf",
  ],
  ["assistant-only history", [assistantMsg("a", null)], "no-preceding-user"],
  [
    "no user before the leaf",
    [customEntry("c", null), assistantMsg("a", "c")],
    "no-preceding-user",
  ],
];

for (const [name, branch, reason] of rejectedBranches) {
  test(`analysis rejects ${name}`, () => {
    assert.deepEqual(analyzeLastAssistantTurn(branch), { ok: false, reason });
  });
}

test("analysis rejects a leaf with unresolved tool use", () => {
  const result = analyzeLastAssistantTurn([
    userMsg("u", null),
    assistantMsg("a", "u", {
      content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    }),
  ]);
  assert.deepEqual(result, { ok: false, reason: "unresolved-tool-use" });
});

test("analysis recognizes an already canonical empty leaf", () => {
  const result = analyzeLastAssistantTurn([
    userMsg("u", null),
    canonicalAssistant("a", "u"),
  ]);
  assert.deepEqual(result, { ok: false, reason: "already-clear" });
});

test("empty error and aborted messages can be normalized", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const result = analyzeLastAssistantTurn([
      userMsg("u", null),
      assistantMsg("a", "u", {
        content: [{ type: "text", text: "" }],
        stopReason,
        errorMessage: "failed",
      }),
    ]);
    assert.equal(result.ok, true, stopReason);
  }
});

// ---- Synthetic message ----

test("canonical assistant has one empty text block and zero usage", () => {
  const old = (assistantMsg("a", "u", {
    content: [
      { type: "thinking", thinking: "secret" },
      { type: "toolCall", id: "call", name: "read", arguments: {} },
      { type: "text", text: "answer" },
    ],
    stopReason: "error",
    errorMessage: "provider failed",
    responseId: "response-1",
    diagnostics: [{ type: "unknown", message: "kept" }] as any,
    futureMetadata: { keep: true },
    usage: {
      ...structuredClone(usage),
      futureCounter: 99,
      cost: { ...usage.cost, futureCost: 8 },
    },
  } as Partial<AssistantMessage> & Record<string, unknown>) as AssistantEntry).message;
  const before = Date.now();

  const result = createCanonicalEmptyAssistant(old) as any;

  assert.deepEqual(result.content, [{ type: "text", text: "" }]);
  assert.equal(result.stopReason, "stop");
  assert.equal("errorMessage" in result, false);
  assert.equal(result.api, old.api);
  assert.equal(result.provider, old.provider);
  assert.equal(result.model, old.model);
  assert.equal(result.responseId, "response-1");
  assert.deepEqual(result.futureMetadata, { keep: true });
  assert.equal(result.usage.futureCounter, 99);
  assert.equal(result.usage.cost.futureCost, 8);
  assert.deepEqual(
    {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      cacheWrite1h: result.usage.cacheWrite1h,
      totalTokens: result.usage.totalTokens,
      cost: {
        input: result.usage.cost.input,
        output: result.usage.cost.output,
        cacheRead: result.usage.cost.cacheRead,
        cacheWrite: result.usage.cost.cacheWrite,
        total: result.usage.cost.total,
      },
    },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  );
  assert.ok(result.timestamp >= before);
  assert.notEqual(result.timestamp, old.timestamp);
});

// ---- Handler ----

type HarnessOptions = {
  idle?: boolean;
  missingMethods?: boolean;
  appendError?: Error;
  firstNavigation?: "success" | "cancel" | "throw";
  secondNavigation?: "success" | "cancel" | "throw";
};

function createClearHarness(initialBranch: SessionEntry[], options: HarnessOptions = {}) {
  const calls: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const entries = new Map(initialBranch.map((entry) => [entry.id, entry]));
  const originalLeafId = initialBranch.at(-1)?.id ?? null;
  let leafId = originalLeafId;
  let appended: AssistantMessage | undefined;
  let appendedParentId: string | null = null;
  let navigationCount = 0;

  const sessionManager: Record<string, unknown> = {
    getBranch() {
      calls.push("getBranch");
      return initialBranch;
    },
  };

  if (!options.missingMethods) {
    sessionManager.branch = (targetId: string) => {
      calls.push(`branch:${targetId}`);
      if (!entries.has(targetId)) throw new Error(`Unknown entry: ${targetId}`);
      leafId = targetId;
    };
    sessionManager.appendMessage = (message: AssistantMessage) => {
      calls.push("appendMessage");
      if (options.appendError) throw options.appendError;
      appended = message;
      appendedParentId = leafId;
      const id = "empty-assistant";
      entries.set(id, assistantMsg(id, leafId, message));
      leafId = id;
      return id;
    };
  }

  const ctx = {
    isIdle() {
      calls.push("isIdle");
      return options.idle ?? true;
    },
    sessionManager,
    async navigateTree(targetId: string, navOptions: unknown) {
      navigationCount++;
      calls.push(`navigate:${targetId}:${JSON.stringify(navOptions)}`);
      const outcome =
        navigationCount === 1
          ? options.firstNavigation ?? "success"
          : options.secondNavigation ?? "success";
      if (outcome === "throw") throw new Error(`navigation ${navigationCount} failed`);
      if (outcome === "cancel") return { cancelled: true };
      leafId = targetId;
      return { cancelled: false };
    },
    ui: {
      notify(message: string, level: string) {
        calls.push(`notify:${level}`);
        notifications.push({ message, level });
      },
    },
  } as unknown as ClearLastTurnContext;

  return {
    ctx,
    calls,
    notifications,
    getLeafId: () => leafId,
    getAppended: () => appended,
    getAppendedParentId: () => appendedParentId,
    originalLeafId,
  };
}

const normalBranch = () => [
  userMsg("u", null),
  assistantMsg("original", "u"),
];

test("busy state only notifies and never reads or mutates the session", async () => {
  const harness = createClearHarness(normalBranch(), { idle: false });
  await handleClearLastTurnCommand(harness.ctx);

  assert.deepEqual(harness.calls, ["isIdle", "notify:info"]);
  assert.match(harness.notifications[0].message, /busy/);
});

test("successful clear branches, appends, synchronizes original, then activates empty", async () => {
  const harness = createClearHarness(normalBranch());
  await handleClearLastTurnCommand(harness.ctx);

  assert.deepEqual(harness.calls.slice(0, -1), [
    "isIdle",
    "getBranch",
    "branch:u",
    "appendMessage",
    'navigate:original:{"summarize":false}',
    'navigate:empty-assistant:{"summarize":false}',
  ]);
  assert.equal(harness.getAppendedParentId(), "u");
  assert.deepEqual(harness.getAppended()?.content, [{ type: "text", text: "" }]);
  assert.equal(harness.getLeafId(), "empty-assistant");
  assert.deepEqual(harness.notifications.at(-1), {
    message: "Last assistant turn cleared",
    level: "info",
  });
});

test("first-navigation cancellation restores the original manager leaf", async () => {
  const harness = createClearHarness(normalBranch(), { firstNavigation: "cancel" });
  await handleClearLastTurnCommand(harness.ctx);

  assert.equal(harness.getLeafId(), "original");
  assert.ok(harness.calls.includes("branch:original"));
  assert.equal(harness.calls.some((call) => call.includes("empty-assistant:{")), false);
  assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/);
});

test("first-navigation failure restores the original manager leaf", async () => {
  const harness = createClearHarness(normalBranch(), { firstNavigation: "throw" });
  await handleClearLastTurnCommand(harness.ctx);

  assert.equal(harness.getLeafId(), "original");
  assert.ok(harness.calls.includes("branch:original"));
  assert.deepEqual(harness.notifications.at(-1), {
    message: "navigation 1 failed",
    level: "error",
  });
});

test("second-navigation cancellation leaves the original branch active", async () => {
  const harness = createClearHarness(normalBranch(), { secondNavigation: "cancel" });
  await handleClearLastTurnCommand(harness.ctx);

  assert.equal(harness.getLeafId(), "original");
  assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/);
});

test("missing mutation methods fail before changing the branch", async () => {
  const harness = createClearHarness(normalBranch(), { missingMethods: true });
  await handleClearLastTurnCommand(harness.ctx);

  assert.equal(harness.getLeafId(), "original");
  assert.equal(harness.calls.some((call) => call.startsWith("branch:")), false);
  assert.match(harness.notifications.at(-1)?.message ?? "", /does not expose/);
  assert.equal(harness.notifications.at(-1)?.level, "error");
});

test("append failure rolls the manager leaf back to the original assistant", async () => {
  const harness = createClearHarness(normalBranch(), {
    appendError: new Error("append failed"),
  });
  await handleClearLastTurnCommand(harness.ctx);

  assert.deepEqual(harness.calls.slice(0, -1), [
    "isIdle",
    "getBranch",
    "branch:u",
    "appendMessage",
    "branch:original",
  ]);
  assert.equal(harness.getLeafId(), "original");
  assert.deepEqual(harness.notifications.at(-1), {
    message: "append failed",
    level: "error",
  });
});

test("already-clear and ineligible branches never mutate or navigate", async () => {
  const branches = [
    [userMsg("u", null), canonicalAssistant("a", "u")],
    [],
    [userMsg("u", null)],
    [assistantMsg("a", null)],
    [userMsg("u", null), toolResult("t", "u")],
    [userMsg("u", null), nonMessage("m", "u")],
  ];

  for (const branch of branches) {
    const harness = createClearHarness(branch);
    await handleClearLastTurnCommand(harness.ctx);
    assert.equal(harness.calls.some((call) => call.startsWith("branch:")), false);
    assert.equal(harness.calls.includes("appendMessage"), false);
    assert.equal(harness.calls.some((call) => call.startsWith("navigate:")), false);
  }
});

test("navigation errors become user-visible error notifications", async () => {
  const harness = createClearHarness(normalBranch(), { secondNavigation: "throw" });
  await handleClearLastTurnCommand(harness.ctx);
  assert.deepEqual(harness.notifications.at(-1), {
    message: "navigation 2 failed",
    level: "error",
  });
});

// ---- Registration ----

test("long and shorthand clear commands register the same handler", () => {
  const commands = new Map<string, { description?: string; handler: Function }>();
  const pi = {
    registerCommand(name: string, options: { description?: string; handler: Function }) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;

  registerExtension(pi);

  assert.equal(commands.get("clear-last-turn")?.handler, commands.get("clt")?.handler);
  assert.ok(commands.has("regenerate"));
  assert.ok(commands.has("reg"));
});
