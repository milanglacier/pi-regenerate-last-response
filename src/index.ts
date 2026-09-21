import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type UserMessage = Extract<SessionMessageEntry["message"], { role: "user" }>;
type UserMessageContent = UserMessage["content"];

/** A SessionMessageEntry narrowed to the real upstream user-message type. */
export type UserSessionMessageEntry = Omit<SessionMessageEntry, "message"> & {
  message: UserMessage;
};

function isUserMessageEntry(
  entry: SessionEntry,
): entry is UserSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
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
