import test from "node:test";
import assert from "node:assert/strict";
import {
  extractUserMessageText,
  findLastUserMessage,
  handleRegenerateCommand,
  type RegeneratePI,
  type RegenerateContext,
} from "../src/index.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Minimal mock helpers that construct just enough shape to satisfy
 * findLastUserMessage without pulling in the full AgentMessage type.
 */

function userMsg(
  id: string,
  parentId: string | null,
  content: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content,
      timestamp: Date.now(),
    },
  } as SessionEntry;
}

function assistantMsg(
  id: string,
  parentId: string | null,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      api: "anthropic" as any,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {} as any,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as SessionEntry;
}

function modelChange(
  id: string,
  parentId: string | null,
): SessionEntry {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    provider: "openai",
    modelId: "gpt-4o",
  } as SessionEntry;
}

// ---- Tests ----

test("findLastUserMessage — normal: user → assistant → user → assistant", () => {
  // Leaf-to-root order (leaf first)
  const branch: SessionEntry[] = [
    assistantMsg("e4", "e3"),
    userMsg("e3", "e2", "second question"),
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "first question"),
  ];

  const result = findLastUserMessage(branch);
  assert.ok(result);
  assert.equal(result.id, "e3");
  assert.equal(result.message.role, "user");
  assert.equal(result.message.content, "second question");
});

test("findLastUserMessage — only one user, leaf is assistant", () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];

  const result = findLastUserMessage(branch);
  assert.ok(result);
  assert.equal(result.id, "e1");
});

test("findLastUserMessage — no user messages (assistant-only)", () => {
  const branch: SessionEntry[] = [
    assistantMsg("e3", "e2"),
    assistantMsg("e2", "e1"),
    assistantMsg("e1", null),
  ];

  const result = findLastUserMessage(branch);
  assert.equal(result, null);
});

test("findLastUserMessage — empty branch", () => {
  const result = findLastUserMessage([]);
  assert.equal(result, null);
});

test("findLastUserMessage — non-message entries interspersed", () => {
  // user → model_change → assistant → user → assistant
  const branch: SessionEntry[] = [
    assistantMsg("e5", "e4"),
    userMsg("e4", "e3", "second question"),
    assistantMsg("e3", "e2"),
    modelChange("e2", "e1"),
    userMsg("e1", null, "first question"),
  ];

  const result = findLastUserMessage(branch);
  assert.ok(result);
  assert.equal(result.id, "e4");
});

test("findLastUserMessage — two consecutive user messages (unusual)", () => {
  // user-1 → user-2 → assistant → leaf
  const branch: SessionEntry[] = [
    assistantMsg("e3", "e2"),
    userMsg("e2", "e1", "follow-up"),
    userMsg("e1", null, "initial"),
  ];

  const result = findLastUserMessage(branch);
  assert.ok(result);
  // Returns e2 (first user from leaf)
  assert.equal(result.id, "e2");
});

function createCommandHarness(
  branch: SessionEntry[],
  options: {
    idle?: boolean;
    navCancelled?: boolean;
    editorText?: string;
  } = {},
) {
  const calls: string[] = [];
  const sentMessages: unknown[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let editorText = options.editorText ?? "";

  const pi: RegeneratePI = {
    sendUserMessage(content) {
      calls.push("sendUserMessage");
      sentMessages.push(content);
    },
  };

  const ctx = {
    isIdle() {
      calls.push("isIdle");
      return options.idle ?? true;
    },
    abort() {
      calls.push("abort");
    },
    async waitForIdle() {
      calls.push("waitForIdle");
    },
    sessionManager: {
      getBranch() {
        calls.push("getBranch");
        return branch;
      },
    },
    async navigateTree(targetId: string, navOptions: unknown) {
      calls.push(`navigateTree:${targetId}:${JSON.stringify(navOptions)}`);
      await Promise.resolve();
      calls.push("navigateTree:resolved");
      // Mirror real navigateTree: only prefill the editor when it is empty.
      // pi's interactive mode guards prefill with `!this.editor.getText().trim()`.
      const targetEntry = branch.find((e) => e.id === targetId);
      if (
        targetEntry?.type === "message" &&
        targetEntry.message.role === "user" &&
        editorText.trim() === ""
      ) {
        editorText = targetEntry.message.content as string;
      }
      return { cancelled: options.navCancelled ?? false };
    },
    ui: {
      notify(message: string, level: string) {
        calls.push(`notify:${message}:${level}`);
        notifications.push({ message, level });
      },
      getEditorText() {
        calls.push("getEditorText");
        return editorText;
      },
      setEditorText(text: string) {
        calls.push(`setEditorText:${text}`);
        editorText = text;
      },
    },
  } as RegenerateContext;

  return { pi, ctx, calls, sentMessages, notifications, getEditorText: () => editorText };
}

// ---- Command handler tests ----

test("handleRegenerateCommand — idle normal case uses navigateTree then sends prompt", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e4", "e3"),
    userMsg("e3", "e2", "second question"),
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "first question"),
  ];
  const { pi, ctx, calls, sentMessages } = createCommandHarness(branch);

  await handleRegenerateCommand(pi, ctx);

  assert.ok(calls.includes('navigateTree:e3:{"summarize":false}'));
  assert.deepEqual(sentMessages, ["second question"]);
  assert.ok(
    calls.indexOf("navigateTree:resolved") < calls.indexOf("sendUserMessage"),
    "sendUserMessage should run after navigateTree has resolved",
  );
});

test("handleRegenerateCommand — root user case still uses navigateTree", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];
  const { pi, ctx, calls, sentMessages } = createCommandHarness(branch);

  await handleRegenerateCommand(pi, ctx);

  assert.ok(calls.includes('navigateTree:e1:{"summarize":false}'));
  assert.deepEqual(sentMessages, ["hello"]);
});

test("handleRegenerateCommand — cancellation does not resend prompt", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];
  const { pi, ctx, calls, sentMessages, notifications } = createCommandHarness(
    branch,
    { navCancelled: true },
  );

  await handleRegenerateCommand(pi, ctx);

  assert.ok(calls.includes('navigateTree:e1:{"summarize":false}'));
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(notifications.at(-1), {
    message: "Regeneration cancelled",
    level: "info",
  });
});

test("handleRegenerateCommand — running agent aborts and waits before navigation", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];
  const { pi, ctx, calls } = createCommandHarness(branch, { idle: false });

  await handleRegenerateCommand(pi, ctx);

  assert.ok(calls.indexOf("abort") < calls.indexOf("waitForIdle"));
  assert.ok(calls.indexOf("waitForIdle") < calls.findIndex((c) => c.startsWith("navigateTree:")));
});

test("handleRegenerateCommand — leaf-is-user guard avoids navigation and send", async () => {
  const branch: SessionEntry[] = [userMsg("e1", null, "hello")];
  const { pi, ctx, calls, sentMessages, notifications } = createCommandHarness(branch);

  await handleRegenerateCommand(pi, ctx);

  assert.equal(calls.some((c) => c.startsWith("navigateTree:")), false);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(notifications.at(-1), {
    message: "No agent response to regenerate",
    level: "info",
  });
});

test("handleRegenerateCommand — clears editor text after regeneration", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];
  const { pi, ctx, calls, getEditorText } = createCommandHarness(branch);

  await handleRegenerateCommand(pi, ctx);

  assert.ok(calls.includes("setEditorText:"));
  assert.equal(getEditorText(), "");
});

test("handleRegenerateCommand — preserves unrelated editor text", async () => {
  const branch: SessionEntry[] = [
    assistantMsg("e2", "e1"),
    userMsg("e1", null, "hello"),
  ];
  const { pi, ctx, calls, getEditorText } = createCommandHarness(branch, {
    editorText: "draft note",
  });

  await handleRegenerateCommand(pi, ctx);

  // navigateTree does not overwrite a non-empty editor, so the draft stays
  // and does not match the regenerated prompt -> setEditorText is not called.
  assert.equal(calls.includes("setEditorText:"), false);
  assert.equal(getEditorText(), "draft note");
});

test("extractUserMessageText — returns string content as-is", () => {
  const result = extractUserMessageText("hello world");
  assert.equal(result, "hello world");
});

test("extractUserMessageText — joins text parts and ignores image parts", () => {
  const result = extractUserMessageText([
    { type: "text", text: "hello " },
    { type: "image", image: "base64", mediaType: "image/png" } as any,
    { type: "text", text: "world" },
  ]);

  assert.equal(result, "hello world");
});
