import {
  SessionManager,
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

export default function regenerateExtension(pi: ExtensionAPI) {
  async function handleRegenerate(
    _args: string,
    ctx: ExtensionCommandContext,
  ) {
    try {
      // Path B: abort if agent is running
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

      // Access the full SessionManager to rewind the leaf pointer.
      // ReadonlySessionManager omits branch() / resetLeaf(), but the runtime
      // object is the full SessionManager.
      const sm = ctx.sessionManager as unknown as SessionManager;

      if (userEntry.parentId === null) {
        sm.resetLeaf();
      } else {
        sm.branch(userEntry.parentId);
      }

      const message = userEntry.message;
      if (message.role !== "user") {
        ctx.ui.notify("Nothing to regenerate", "info");
        return;
      }
      pi.sendUserMessage(message.content);
      ctx.ui.notify("Regenerating last response...", "info");
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
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
