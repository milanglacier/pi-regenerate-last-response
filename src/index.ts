import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Walk the branch from leaf to root and find the first user message.
 * Non-message entries (model_change, thinking_level_change, custom, label,
 * compaction, branch_summary, session_info) are skipped.
 *
 * @param entries - Branch entries in leaf-to-root order (index 0 = leaf)
 * @returns The first user message entry found, or null if none
 */
export function findLastUserMessage(
  entries: SessionEntry[],
): SessionMessageEntry | null {
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      return entry;
    }
  }
  return null;
}

type RegeneratePI = Pick<ExtensionAPI, "sendUserMessage">;

type RegenerateContext = Pick<
  ExtensionCommandContext,
  "isIdle" | "abort" | "waitForIdle" | "sessionManager" | "navigateTree" | "ui"
>;

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

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
    const leaf = branch[0]; // index 0 = leaf

    const userEntry = findLastUserMessage(branch);
    if (!userEntry) {
      ctx.ui.notify("Nothing to regenerate", "info");
      return;
    }

    if (userEntry.id === leaf?.id) {
      ctx.ui.notify("No agent response to regenerate", "info");
      return;
    }

    const message = userEntry.message;
    if (message.role !== "user") {
      ctx.ui.notify("Nothing to regenerate", "info");
      return;
    }

    const regeneratedEditorText = extractUserMessageText(message.content);
    const nav = await ctx.navigateTree(userEntry.id, { summarize: false });
    if (nav.cancelled) {
      ctx.ui.notify("Regeneration cancelled", "info");
      return;
    }

    pi.sendUserMessage(message.content);

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

export default function regenerateExtension(pi: ExtensionAPI) {
  async function handleRegenerate(
    _args: string,
    ctx: ExtensionCommandContext,
  ) {
    await handleRegenerateCommand(pi, ctx);
  }

  pi.registerCommand("regenerate", {
    description: "Regenerate the last agent response",
    handler: handleRegenerate,
  });

  pi.registerCommand("reg", {
    description: "Regenerate the last agent response (shorthand)",
    handler: handleRegenerate,
  });
}
