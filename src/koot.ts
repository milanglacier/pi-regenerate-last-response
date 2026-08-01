import {
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const KOOT_STATE_ENTRY_TYPE =
  "keep-only-output-text-from-last-turn-state";
export const KOOT_CAPTURE_ENTRY_TYPE =
  "keep-only-output-text-from-last-turn-capture";
export const KOOT_STATUS_KEY = "keep-only-output-text-from-last-turn";
export const KOOT_USAGE =
  "Usage: /keep-only-output-text-from-last-turn [on|off]";

export interface KootModeState {
  version: 1;
  enabled: boolean;
}

export interface MarkedResponseGroup {
  initiatingUserEntryId: string;
  assistantMessageIdentities: string[];
  toolResultMessageIdentities: string[];
}

export interface KootCaptureEntry {
  version: 1;
  group: MarkedResponseGroup;
}

export type KootAgentMessage = ContextEvent["messages"][number];
type AssistantMessage = Extract<KootAgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<KootAgentMessage, { role: "toolResult" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantMessage(message: KootAgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function isToolResultMessage(message: KootAgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

/**
 * Build an identity from provider metadata that survives session context
 * rebuilding and structuredClone(). No assistant content is included.
 */
export function getAssistantMessageIdentity(message: AssistantMessage): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const toolCallIds = content
    .filter((block) => block.type === "toolCall")
    .map((block) => block.id);

  return JSON.stringify([
    "assistant",
    message.timestamp,
    message.provider,
    message.model,
    message.responseId ?? null,
    toolCallIds,
  ]);
}

/** Build a stable identity for a tool result without including its output. */
export function getToolResultMessageIdentity(message: ToolResultMessage): string {
  return JSON.stringify([
    "toolResult",
    message.timestamp,
    message.toolCallId,
    message.toolName,
  ]);
}

/**
 * Select the completed response after the latest user entry on a root-to-leaf
 * branch. Metadata and unrelated tool results are ignored.
 */
export function findLastCompletedResponseGroup(
  branch: SessionEntry[],
): MarkedResponseGroup | null {
  let userIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "user") {
      userIndex = i;
      break;
    }
  }

  if (userIndex < 0) {
    return null;
  }

  const userEntry = branch[userIndex];
  const assistantMessages: AssistantMessage[] = [];
  const toolResults: ToolResultMessage[] = [];

  for (let i = userIndex + 1; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") {
      continue;
    }
    if (isAssistantMessage(entry.message)) {
      assistantMessages.push(entry.message);
    } else if (isToolResultMessage(entry.message)) {
      toolResults.push(entry.message);
    }
  }

  if (assistantMessages.length === 0) {
    return null;
  }

  const calledToolIds = new Set(
    assistantMessages.flatMap((message) => {
      const content = Array.isArray(message.content) ? message.content : [];
      return content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id);
    }),
  );

  return {
    initiatingUserEntryId: userEntry.id,
    assistantMessageIdentities: assistantMessages.map(
      getAssistantMessageIdentity,
    ),
    toolResultMessageIdentities: toolResults
      .filter((message) => calledToolIds.has(message.toolCallId))
      .map(getToolResultMessageIdentity),
  };
}

/** Deduplicate captures by their initiating user session-entry id. */
export function deduplicateMarkedResponseGroups(
  groups: readonly MarkedResponseGroup[],
): MarkedResponseGroup[] {
  const byUserEntryId = new Map<string, MarkedResponseGroup>();
  for (const group of groups) {
    if (!byUserEntryId.has(group.initiatingUserEntryId)) {
      byUserEntryId.set(group.initiatingUserEntryId, group);
    }
  }
  return [...byUserEntryId.values()];
}

interface GroupTransform {
  assistantIndexes: number[];
  toolResultIndexes: number[];
  textBlocks: Array<{ type: "text"; text: string }>;
}

/**
 * Non-destructively collapse marked traces into one unsigned text-only
 * assistant message per response. Unmarked messages retain object identity.
 */
export function keepOnlyOutputTextFromMarkedResponses(
  messages: ContextEvent["messages"],
  groups: readonly MarkedResponseGroup[],
): ContextEvent["messages"] {
  const uniqueGroups = deduplicateMarkedResponseGroups(groups);
  if (uniqueGroups.length === 0) {
    return messages;
  }

  const assistantGroupByIdentity = new Map<string, string>();
  const toolResultGroupByIdentity = new Map<string, string>();
  for (const group of uniqueGroups) {
    for (const identity of group.assistantMessageIdentities) {
      if (!assistantGroupByIdentity.has(identity)) {
        assistantGroupByIdentity.set(identity, group.initiatingUserEntryId);
      }
    }
    for (const identity of group.toolResultMessageIdentities) {
      if (!toolResultGroupByIdentity.has(identity)) {
        toolResultGroupByIdentity.set(identity, group.initiatingUserEntryId);
      }
    }
  }

  const transforms = new Map<string, GroupTransform>();
  const transformFor = (groupId: string): GroupTransform => {
    let transform = transforms.get(groupId);
    if (!transform) {
      transform = {
        assistantIndexes: [],
        toolResultIndexes: [],
        textBlocks: [],
      };
      transforms.set(groupId, transform);
    }
    return transform;
  };

  messages.forEach((message, index) => {
    if (isAssistantMessage(message)) {
      const groupId = assistantGroupByIdentity.get(
        getAssistantMessageIdentity(message),
      );
      if (groupId) {
        const transform = transformFor(groupId);
        transform.assistantIndexes.push(index);
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (block.type === "text") {
            transform.textBlocks.push({ type: "text", text: block.text });
          }
        }
      }
      return;
    }

    if (isToolResultMessage(message)) {
      const groupId = toolResultGroupByIdentity.get(
        getToolResultMessageIdentity(message),
      );
      if (groupId) {
        transformFor(groupId).toolResultIndexes.push(index);
      }
    }
  });

  if (transforms.size === 0) {
    return messages;
  }

  const indexesToDrop = new Set<number>();
  const syntheticAtIndex = new Map<number, AssistantMessage>();

  for (const transform of transforms.values()) {
    for (const index of transform.assistantIndexes) {
      indexesToDrop.add(index);
    }
    for (const index of transform.toolResultIndexes) {
      indexesToDrop.add(index);
    }

    const lastAssistantIndex = transform.assistantIndexes.at(-1);
    if (lastAssistantIndex === undefined || transform.textBlocks.length === 0) {
      continue;
    }

    const metadataSource = messages[lastAssistantIndex];
    if (isAssistantMessage(metadataSource)) {
      syntheticAtIndex.set(lastAssistantIndex, {
        ...metadataSource,
        content: transform.textBlocks,
      });
    }
  }

  const result: ContextEvent["messages"] = [];
  messages.forEach((message, index) => {
    const synthetic = syntheticAtIndex.get(index);
    if (synthetic) {
      result.push(synthetic);
    } else if (!indexesToDrop.has(index)) {
      result.push(message);
    }
  });
  return result;
}

function parseModeState(value: unknown): KootModeState | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.enabled !== "boolean"
  ) {
    return null;
  }
  return { version: 1, enabled: value.enabled };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return [...new Set(value)];
}

function parseMarkedResponseGroup(value: unknown): MarkedResponseGroup | null {
  if (
    !isRecord(value) ||
    typeof value.initiatingUserEntryId !== "string" ||
    value.initiatingUserEntryId.length === 0
  ) {
    return null;
  }
  const assistantMessageIdentities = parseStringArray(
    value.assistantMessageIdentities,
  );
  const toolResultMessageIdentities = parseStringArray(
    value.toolResultMessageIdentities,
  );
  if (
    !assistantMessageIdentities ||
    assistantMessageIdentities.length === 0 ||
    !toolResultMessageIdentities
  ) {
    return null;
  }
  return {
    initiatingUserEntryId: value.initiatingUserEntryId,
    assistantMessageIdentities,
    toolResultMessageIdentities,
  };
}

function parseCaptureEntry(value: unknown): KootCaptureEntry | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const group = parseMarkedResponseGroup(value.group);
  return group ? { version: 1, group } : null;
}

/** Restore branch-local mode and captures, ignoring malformed/future entries. */
export function restoreKootState(branch: SessionEntry[]): {
  modeEnabled: boolean;
  markedGroups: MarkedResponseGroup[];
} {
  let modeEnabled = false;
  const markedGroups: MarkedResponseGroup[] = [];

  for (const entry of branch) {
    if (entry.type !== "custom") {
      continue;
    }
    if (entry.customType === KOOT_STATE_ENTRY_TYPE) {
      const state = parseModeState(entry.data);
      if (state) {
        modeEnabled = state.enabled;
      }
    } else if (entry.customType === KOOT_CAPTURE_ENTRY_TYPE) {
      const capture = parseCaptureEntry(entry.data);
      if (capture) {
        markedGroups.push(capture.group);
      }
    }
  }

  return {
    modeEnabled,
    markedGroups: deduplicateMarkedResponseGroups(markedGroups),
  };
}

function normalizedModeArgument(args: string): "on" | "off" | "toggle" | null {
  const normalized = args.trim().toLowerCase();
  if (normalized === "") return "toggle";
  if (normalized === "on" || normalized === "off") return normalized;
  return null;
}

export interface KootCommandState {
  getEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

/** Shared implementation for both KOOT command names. */
export async function handleKootCommand(
  args: string,
  ctx: Pick<ExtensionCommandContext, "ui">,
  pi: Pick<ExtensionAPI, "appendEntry">,
  state: KootCommandState,
): Promise<void> {
  const requested = normalizedModeArgument(args);
  if (!requested) {
    ctx.ui.notify(KOOT_USAGE, "warning");
    return;
  }

  const current = state.getEnabled();
  const enabled = requested === "toggle" ? !current : requested === "on";
  if (enabled !== current) {
    state.setEnabled(enabled);
    pi.appendEntry<KootModeState>(KOOT_STATE_ENTRY_TYPE, {
      version: 1,
      enabled,
    });
  } else {
    ctx.ui.setStatus(KOOT_STATUS_KEY, enabled ? "KOOT on" : undefined);
  }

  ctx.ui.notify(
    enabled
      ? "KOOT enabled. The previous response will become output-text-only when the next prompt starts."
      : "KOOT disabled. No additional previous responses will be marked; existing marks remain active.",
    "info",
  );
}

/** Register KOOT commands and its branch-local lifecycle hooks. */
export function registerKootCommands(pi: ExtensionAPI): void {
  let modeEnabled = false;
  let markedGroups: MarkedResponseGroup[] = [];

  const refreshStatus = (ctx: Pick<ExtensionContext, "ui">): void => {
    ctx.ui.setStatus(
      KOOT_STATUS_KEY,
      modeEnabled ? "KOOT on" : undefined,
    );
  };

  const restoreFromContext = (
    ctx: Pick<ExtensionContext, "sessionManager" | "ui">,
  ): void => {
    const restored = restoreKootState(ctx.sessionManager.getBranch());
    modeEnabled = restored.modeEnabled;
    markedGroups = restored.markedGroups;
    refreshStatus(ctx);
  };

  const commandState: KootCommandState = {
    getEnabled: () => modeEnabled,
    setEnabled(enabled) {
      modeEnabled = enabled;
    },
  };

  async function handle(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    await handleKootCommand(args, ctx, pi, {
      getEnabled: commandState.getEnabled,
      setEnabled(enabled) {
        commandState.setEnabled(enabled);
        refreshStatus(ctx);
      },
    });
  }

  pi.registerCommand("keep-only-output-text-from-last-turn", {
    description: "Keep only assistant output text from marked previous responses",
    handler: handle,
  });
  pi.registerCommand("koot", {
    description: "Toggle output-text-only capture for the previous response",
    handler: handle,
  });

  pi.on("session_start", (_event, ctx) => {
    restoreFromContext(ctx);
  });

  // Tree navigation changes the active branch without creating a new extension
  // instance, so rebuild branch-local state there as well.
  pi.on("session_tree", (_event, ctx) => {
    restoreFromContext(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!modeEnabled) {
      return;
    }

    const group = findLastCompletedResponseGroup(
      ctx.sessionManager.getBranch(),
    );
    if (
      !group ||
      markedGroups.some(
        (marked) =>
          marked.initiatingUserEntryId === group.initiatingUserEntryId,
      )
    ) {
      return;
    }

    markedGroups.push(group);
    pi.appendEntry<KootCaptureEntry>(KOOT_CAPTURE_ENTRY_TYPE, {
      version: 1,
      group,
    });
  });

  pi.on("context", (event) => {
    if (markedGroups.length === 0) {
      return;
    }
    return {
      messages: keepOnlyOutputTextFromMarkedResponses(
        event.messages,
        markedGroups,
      ),
    };
  });
}
