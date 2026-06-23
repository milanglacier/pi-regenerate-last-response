import test from "node:test";
import assert from "node:assert/strict";
import { findLastUserMessage } from "../src/index.ts";
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
