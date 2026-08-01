import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

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

/** Find the user message closest to the leaf of a root-to-leaf branch. */
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

/** Convert a user message to the text pi places in the tree-navigation editor. */
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
    const leaf = branch[branch.length - 1];

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

/** Register the long and shorthand regenerate commands. */
export function registerRegenerateCommands(pi: ExtensionAPI): void {
  async function handleRegenerate(
    _args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
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
