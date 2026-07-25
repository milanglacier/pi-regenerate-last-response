import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type AssistantMessage = Extract<
  SessionMessageEntry["message"],
  { role: "assistant" }
>;

/** A persisted assistant message entry. */
export type AssistantSessionMessageEntry = Omit<
  SessionMessageEntry,
  "message"
> & {
  message: AssistantMessage;
};

/**
 * A SessionMessageEntry whose message is a user message, with content narrowed
 * to the sendUserMessage input shape (string | (TextContent | ImageContent)[]).
 */
export type UserSessionMessageEntry = Omit<SessionMessageEntry, "message"> & {
  message: { role: "user"; content: UserMessageContent; timestamp: number };
};

function isUserMessageEntry(
  entry: SessionEntry,
): entry is UserSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

/** Narrow a raw session entry without relying on rendered transcript state. */
export function isAssistantMessageEntry(
  entry: SessionEntry,
): entry is AssistantSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "assistant";
}

/**
 * Walk the branch from leaf to root and find the first user message.
 * pi's sessionManager.getBranch() returns entries in root-to-leaf order, so
 * scan backward from the leaf. Non-message entries (model_change,
 * thinking_level_change, custom, label, compaction, branch_summary,
 * session_info) are skipped.
 *
 * @param entries - Branch entries in root-to-leaf order (last index = leaf)
 * @returns The user message closest to the leaf, or null if none
 */
export function findLastUserMessage(
  entries: SessionEntry[],
): UserSessionMessageEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isUserMessageEntry(entry)) {
      return entry;
    }
  }
  return null;
}

export type RegeneratePI = Pick<ExtensionAPI, "sendUserMessage">;

export type RegenerateContext = Pick<
  ExtensionCommandContext,
  "isIdle" | "abort" | "waitForIdle" | "sessionManager" | "navigateTree" | "ui"
>;

export type ClearLastTurnContext = Pick<
  ExtensionCommandContext,
  "isIdle" | "sessionManager" | "navigateTree" | "ui"
>;

export type ClearLastTurnRejection =
  | "empty-history"
  | "non-message-leaf"
  | "non-assistant-leaf"
  | "no-preceding-user"
  | "unresolved-tool-use"
  | "already-clear";

export type ClearLastTurnAnalysis =
  | {
      ok: true;
      originalLeaf: AssistantSessionMessageEntry;
      branchPoint: SessionEntry;
    }
  | { ok: false; reason: ClearLastTurnRejection };

/**
 * Analyze a raw root-to-leaf branch and identify the whole assistant response.
 * The new sibling starts immediately before the first assistant entry after the
 * latest user, retaining any intervening custom/control entries.
 */
export function analyzeLastAssistantTurn(
  entries: SessionEntry[],
): ClearLastTurnAnalysis {
  if (entries.length === 0) {
    return { ok: false, reason: "empty-history" };
  }

  const leaf = entries[entries.length - 1];
  if (leaf.type !== "message") {
    return { ok: false, reason: "non-message-leaf" };
  }
  if (!isAssistantMessageEntry(leaf)) {
    return { ok: false, reason: "non-assistant-leaf" };
  }

  let userIndex = -1;
  for (let i = entries.length - 2; i >= 0; i--) {
    if (isUserMessageEntry(entries[i])) {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) {
    return { ok: false, reason: "no-preceding-user" };
  }

  if (
    leaf.message.stopReason === "toolUse" ||
    leaf.message.content.some(
      (part) => part.type === "toolCall" || (part as { type: string }).type === "toolUse",
    )
  ) {
    return { ok: false, reason: "unresolved-tool-use" };
  }

  if (isCanonicalEmptyAssistant(leaf.message)) {
    return { ok: false, reason: "already-clear" };
  }

  const firstAssistantIndex = entries.findIndex(
    (entry, index) => index > userIndex && isAssistantMessageEntry(entry),
  );

  // The assistant leaf itself guarantees this exists after the preceding user.
  const branchPoint = entries[firstAssistantIndex - 1];
  return { ok: true, originalLeaf: leaf, branchPoint };
}

/** Return whether a message already has the exact normalized empty shape. */
export function isCanonicalEmptyAssistant(message: AssistantMessage): boolean {
  const usage = message.usage;
  return (
    message.content.length === 1 &&
    message.content[0].type === "text" &&
    message.content[0].text === "" &&
    message.stopReason === "stop" &&
    message.errorMessage === undefined &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    (usage.cacheWrite1h === undefined || usage.cacheWrite1h === 0) &&
    usage.totalTokens === 0 &&
    usage.cost.input === 0 &&
    usage.cost.output === 0 &&
    usage.cost.cacheRead === 0 &&
    usage.cost.cacheWrite === 0 &&
    usage.cost.total === 0
  );
}

/** Build the one canonical assistant message used by both clear commands. */
export function createCanonicalEmptyAssistant(
  oldMessage: AssistantMessage,
): AssistantMessage {
  const { errorMessage: _errorMessage, ...metadata } = oldMessage;
  return {
    ...metadata,
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
    usage: {
      ...oldMessage.usage,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      totalTokens: 0,
      cost: {
        ...oldMessage.usage.cost,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  };
}

/**
 * Unsupported compatibility bridge to SessionManager's concrete append-only
 * methods. Keep this isolated: Pi's public extension view is intentionally
 * read-only and a future release may require adapting this check.
 */
type SessionMutationBridge = {
  branch(entryId: string): void;
  appendMessage(message: AssistantMessage): string;
};

function getSessionMutationBridge(
  manager: ClearLastTurnContext["sessionManager"],
): SessionMutationBridge | null {
  const candidate = manager as unknown as Partial<SessionMutationBridge>;
  if (
    typeof candidate.branch !== "function" ||
    typeof candidate.appendMessage !== "function"
  ) {
    return null;
  }
  return candidate as SessionMutationBridge;
}

/**
 * Mirrors pi's tree-navigation editor prefill conversion for user messages.
 * Image parts have no editable text representation, so only text parts are used.
 */
export function extractUserMessageText(content: UserMessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export async function handleRegenerateCommand(
  pi: RegeneratePI,
  ctx: RegenerateContext,
): Promise<void> {
  try {
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }

    const branch = ctx.sessionManager.getBranch();
    const leaf = branch[branch.length - 1]; // last index = leaf

    const userEntry = findLastUserMessage(branch);
    if (!userEntry) {
      ctx.ui.notify("Nothing to regenerate", "info");
      return;
    }

    if (userEntry.id === leaf?.id) {
      ctx.ui.notify("No agent response to regenerate", "info");
      return;
    }

    const content = userEntry.message.content;
    const regeneratedEditorText = extractUserMessageText(content);
    const nav = await ctx.navigateTree(userEntry.id, { summarize: false });
    if (nav.cancelled) {
      ctx.ui.notify("Regeneration cancelled", "info");
      return;
    }

    pi.sendUserMessage(content);

    if (ctx.ui.getEditorText() === regeneratedEditorText) {
      ctx.ui.setEditorText("");
    }

    ctx.ui.notify("Regenerating last response...", "info");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}

const CLEAR_REJECTION_MESSAGES: Record<ClearLastTurnRejection, string> = {
  "empty-history": "Nothing to clear",
  "non-message-leaf": "The active branch does not end in an assistant turn",
  "non-assistant-leaf": "The active branch does not end in an assistant turn",
  "no-preceding-user": "No preceding user message to clear a response for",
  "unresolved-tool-use": "Cannot clear an assistant turn with unresolved tool calls",
  "already-clear": "The last assistant turn is already clear",
};

function restoreManagerLeaf(
  bridge: SessionMutationBridge,
  originalLeafId: string,
  error: unknown,
): never {
  try {
    bridge.branch(originalLeafId);
  } catch (restoreError) {
    const firstMessage = error instanceof Error ? error.message : String(error);
    const restoreMessage =
      restoreError instanceof Error ? restoreError.message : String(restoreError);
    throw new Error(
      `${firstMessage} (also failed to restore the original branch: ${restoreMessage})`,
    );
  }
  throw error;
}

/** Clear the latest completed assistant response without making a model call. */
export async function handleClearLastTurnCommand(
  ctx: ClearLastTurnContext,
): Promise<void> {
  try {
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        "Cannot clear the last turn while the agent is busy",
        "info",
      );
      return;
    }

    // Validate everything using one root-to-leaf snapshot before mutating.
    const analysis = analyzeLastAssistantTurn(ctx.sessionManager.getBranch());
    if (!analysis.ok) {
      ctx.ui.notify(CLEAR_REJECTION_MESSAGES[analysis.reason], "info");
      return;
    }

    const bridge = getSessionMutationBridge(ctx.sessionManager);
    if (!bridge) {
      throw new Error(
        "This Pi version does not expose the session methods required to clear the last turn",
      );
    }

    const originalLeafId = analysis.originalLeaf.id;
    const emptyMessage = createCanonicalEmptyAssistant(
      analysis.originalLeaf.message,
    );

    let emptyAssistantId: string;
    try {
      bridge.branch(analysis.branchPoint.id);
      emptyAssistantId = bridge.appendMessage(emptyMessage);
    } catch (error) {
      restoreManagerLeaf(bridge, originalLeafId, error);
    }

    let originalNavigation: { cancelled: boolean };
    try {
      originalNavigation = await ctx.navigateTree(originalLeafId, {
        summarize: false,
      });
    } catch (error) {
      restoreManagerLeaf(bridge, originalLeafId, error);
    }

    if (originalNavigation.cancelled) {
      bridge.branch(originalLeafId);
      ctx.ui.notify("Clear last turn cancelled", "info");
      return;
    }

    const emptyNavigation = await ctx.navigateTree(emptyAssistantId, {
      summarize: false,
    });
    if (emptyNavigation.cancelled) {
      ctx.ui.notify("Clear last turn cancelled", "info");
      return;
    }

    ctx.ui.notify("Last assistant turn cleared", "info");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}

export default function regenerateExtension(pi: ExtensionAPI) {
  async function handleRegenerate(
    _args: string,
    ctx: ExtensionCommandContext,
  ) {
    await handleRegenerateCommand(pi, ctx);
  }

  async function handleClearLastTurn(
    _args: string,
    ctx: ExtensionCommandContext,
  ) {
    await handleClearLastTurnCommand(ctx);
  }

  pi.registerCommand("regenerate", {
    description: "Regenerate the last agent response",
    handler: handleRegenerate,
  });

  pi.registerCommand("reg", {
    description: "Regenerate the last agent response (shorthand)",
    handler: handleRegenerate,
  });

  pi.registerCommand("clear-last-turn", {
    description: "Clear the last completed assistant turn",
    handler: handleClearLastTurn,
  });

  pi.registerCommand("clt", {
    description: "Clear the last completed assistant turn (shorthand)",
    handler: handleClearLastTurn,
  });
}
