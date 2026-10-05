import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConversationMessage } from "../../shared/conversations.js";
import type {
  ConversationReader,
  ConversationReaderContext,
  ReaderSummary,
} from "./types.js";
import {
  openConversationFile,
  checkConversationAbort,
  ConversationReadError,
  type SafeConversationFile,
} from "./safe-read.js";
import { JSONL_LIMITS, readJsonl } from "./jsonl.js";
import {
  obj,
  str,
  timestamp,
  UUID,
  plainTextContent,
  displayTitle,
  boundedMessage,
  messageChunk,
  type JsonObject,
} from "./jsonl-content.js";

// Anthropic official Python SDK v0.2.163, 1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7.
const FILE = /^projects\/[A-Za-z0-9_-]{1,240}\/([0-9a-f-]{36})\.jsonl$/i;
const SUBFILE =
  /^projects\/[A-Za-z0-9_-]{1,240}\/([0-9a-f-]{36})\/(?:subagents\/(?:workflows\/[A-Za-z0-9_-]{1,160}\/)?agent-([A-Za-z0-9_-]{1,160})|([0-9a-f-]{36}))\.jsonl$/i;
const CHAIN_TYPES = new Set([
  "user",
  "assistant",
  "progress",
  "system",
  "attachment",
]);
const META_TYPES = new Set([
  "summary",
  "custom-title",
  "ai-title",
  "last-prompt",
  "tag",
  "file-history-snapshot",
  "queue-operation",
  "permission-mode",
  "agent-name",
  "agent-color",
  "agent-setting",
  "agent_metadata",
]);
interface ChainNode {
  id: string;
  parent: string | null;
  start: number;
  end: number;
  order: number;
  type: string;
  visible: boolean;
  sidechain: boolean;
}
interface ClaudeIndex {
  summary: ReaderSummary;
  messages: ChainNode[];
  partial: boolean;
  fingerprint: string;
}

function parseMessage(
  record: JsonObject,
  id: string,
  full = false,
  subagent = false,
): { message: ConversationMessage; unsupported: boolean } | null {
  if (
    (record.type !== "user" && record.type !== "assistant") ||
    (!subagent &&
      (record.isMeta === true ||
        record.isSidechain === true ||
        record.teamName))
  )
    return null;
  const data = obj(record.message);
  if (!data || (data.role !== undefined && data.role !== record.type))
    return null;
  const content = plainTextContent(data.content, "claude");
  const parsed = boundedMessage(
    {
      id,
      role: content.kind === "tool-result" ? "tool" : record.type,
      kind: content.kind,
      text: content.text,
      timestamp: timestamp(record.timestamp),
    },
    full ? 4 * 1024 * 1024 : undefined,
  );
  return {
    unsupported: content.unsupported,
    message: {
      id,
      source: { kind: "main", label: "Claude Code main branch" },
      role: parsed.role,
      timestamp: parsed.timestamp,
      parts: [
        ...(record.isCompactSummary === true
          ? [
              {
                type: "notice" as const,
                text: "Compaction summary supplied by Claude Code. Earlier context may have been replaced.",
              },
            ]
          : []),
        ...content.parts,
        ...(parsed.truncated
          ? [
              {
                type: "notice" as const,
                text: "This message is shortened at the bounded display limit.",
              },
            ]
          : []),
      ],
    },
  };
}

/** Select the latest main parentUuid branch, including progress-chain bridges.
 * logicalParentUuid intentionally stays ignored, matching the official SDK.
 * Only bounded IDs and byte ranges persist between passes, never message text.
 */
function activeChain(
  nodes: Map<string, ChainNode>,
  subagent = false,
): {
  chain: ChainNode[];
  invalid: boolean;
} {
  const parents = new Set<string>();
  for (const node of nodes.values()) if (node.parent) parents.add(node.parent);
  let best: ChainNode | undefined;
  if (subagent)
    for (const node of nodes.values())
      if (
        (node.type === "user" || node.type === "assistant") &&
        (!best || node.order > best.order)
      )
        best = node;
  // Shared progress ancestry is memoized so a fan-out transcript cannot turn
  // bounded 40k-node reconstruction into a quadratic CPU operation.
  const nearest = new Map<string, ChainNode | null>();
  let graphInvalid = false;
  for (const terminal of subagent ? [] : nodes.values()) {
    if (parents.has(terminal.id)) continue;
    let current: ChainNode | undefined = terminal;
    const walked: ChainNode[] = [];
    const seen = new Set<string>();
    let leaf: ChainNode | null = null;
    while (current) {
      if (seen.has(current.id)) {
        graphInvalid = true;
        break;
      }
      if (nearest.has(current.id)) {
        leaf = nearest.get(current.id)!;
        break;
      }
      seen.add(current.id);
      walked.push(current);
      if (current.type === "user" || current.type === "assistant") {
        leaf = current;
        break;
      }
      current = current.parent ? nodes.get(current.parent) : undefined;
    }
    for (const node of walked) nearest.set(node.id, leaf);
    if (leaf?.visible && (!best || leaf.order > best.order)) best = leaf;
  }
  if (!best) return { chain: [], invalid: nodes.size > 0 };
  const chain: ChainNode[] = [];
  const seen = new Set<string>();
  let current: ChainNode | undefined = best;
  let invalid = graphInvalid;
  while (current) {
    if (seen.has(current.id)) {
      invalid = true;
      break;
    }
    seen.add(current.id);
    if (current.visible) chain.push(current);
    if (current.parent && !nodes.has(current.parent)) invalid = true;
    current = current.parent ? nodes.get(current.parent) : undefined;
  }
  return { chain: chain.reverse(), invalid };
}

async function indexClaude(
  context: ConversationReaderContext,
  relative: string,
  expectedFingerprint?: string,
): Promise<{ index: ClaudeIndex; file: SafeConversationFile }> {
  const match = FILE.exec(relative) ?? SUBFILE.exec(relative);
  const subagent = SUBFILE.test(relative);
  if (!match || !UUID.test(match[1]))
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  const expectedId = match[1].toLowerCase();
  const file = await openConversationFile(
    context.root,
    relative,
    context.signal,
  );
  try {
    if (expectedFingerprint && file.fingerprint !== expectedFingerprint)
      throw new ConversationReadError("CONVERSATION_CHANGED");
    const cached = context.cache?.get("claude:current-index") as
      ClaudeIndex | undefined;
    if (cached?.fingerprint === file.fingerprint)
      return { file, index: cached };
    const nodes = new Map<string, ChainNode>();
    const warnings = new Set<string>();
    let partial = false;
    let valid = true;
    let identity = false;
    let mismatch = false;
    let customTitle: string | null = null;
    let aiTitle: string | null = null;
    let summaryTitle: string | null = null;
    let firstPrompt: string | null = null;
    let project: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let sourceOrder = 0;
    for await (const row of readJsonl(file.handle, file.stat.size, {
      signal: context.signal,
    })) {
      if (row.issue) {
        partial = true;
        valid = false;
        warnings.add(
          "Some transcript records are incomplete, malformed, or exceed the bounded reader limits.",
        );
      }
      const r = row.value;
      if (!r) continue;
      const type = str(r.type, 64);
      if (!type || (!CHAIN_TYPES.has(type) && !META_TYPES.has(type))) {
        partial = true;
        valid = false;
        warnings.add(
          "Unknown Claude Code record types are omitted; this conversation is read-only.",
        );
        continue;
      }
      if (r.sessionId !== undefined) {
        if (
          typeof r.sessionId !== "string" ||
          r.sessionId.toLowerCase() !== expectedId
        ) {
          mismatch = true;
          valid = false;
        } else if (CHAIN_TYPES.has(type)) identity = true;
      }
      const time = timestamp(r.timestamp);
      if (time) {
        if (!createdAt || time < createdAt) createdAt = time;
        if (!updatedAt || time > updatedAt) updatedAt = time;
      }
      if (!project && typeof r.cwd === "string" && r.cwd.length <= 4096)
        project = r.cwd;
      // Typed metadata only. A tool input containing customTitle must never rename a conversation.
      if (type === "custom-title" && typeof r.customTitle === "string")
        customTitle = displayTitle(r.customTitle);
      if (type === "ai-title" && typeof r.aiTitle === "string")
        aiTitle = displayTitle(r.aiTitle);
      if (type === "summary" && typeof r.summary === "string")
        summaryTitle = displayTitle(r.summary);
      if (!CHAIN_TYPES.has(type)) continue;
      const id = str(r.uuid, 160);
      const parent =
        r.parentUuid === null || r.parentUuid === undefined
          ? null
          : str(r.parentUuid, 160);
      if (
        !id ||
        (r.parentUuid !== null && r.parentUuid !== undefined && !parent)
      ) {
        partial = true;
        valid = false;
        warnings.add(
          "Some message chain identities are missing or unsupported.",
        );
        continue;
      }
      if (nodes.size >= JSONL_LIMITS.chainNodes && !nodes.has(id)) {
        partial = true;
        valid = false;
        warnings.add("Conversation chain index reached its bounded limit.");
        break;
      }
      const parsed = parseMessage(r, "claude-" + row.start, false, subagent);
      if (parsed?.unsupported) {
        partial = true;
        warnings.add(
          "Some message content blocks are unsupported or shortened for safe display.",
        );
      }
      if (
        (type === "user" || type === "assistant") &&
        !parsed &&
        !r.isSidechain &&
        !r.isMeta &&
        !r.teamName
      ) {
        partial = true;
        valid = false;
        warnings.add("Some conversation messages use an unsupported schema.");
      }
      nodes.set(id, {
        id,
        parent,
        start: row.start,
        end: row.end,
        order: sourceOrder++,
        type,
        visible: parsed !== null,
        sidechain: r.isSidechain === true,
      });
      if (
        !firstPrompt &&
        type === "user" &&
        parsed &&
        !r.isCompactSummary &&
        parsed.message.role === "user"
      ) {
        const text =
          parsed.message.parts.find((part) => part.type === "text")?.text ?? "";
        if (
          text.trim() &&
          !/^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user|\s*<ide_opened_file>|\s*<ide_selection>)/.test(
            text,
          )
        )
          firstPrompt = displayTitle(text);
      }
    }
    const { chain, invalid } = activeChain(nodes, subagent);
    if (invalid) {
      partial = true;
      valid = false;
      warnings.add(
        "The native message chain is incomplete or cyclic; only the verified visible branch is shown.",
      );
    }
    if (!identity || mismatch) {
      valid = false;
      warnings.add(
        "Native session identity could not be matched consistently to the transcript filename.",
      );
    }
    if (!createdAt)
      warnings.add(
        "No valid source timestamps are available. Filesystem modification time is not used as conversation time.",
      );
    if (mismatch) {
      chain.length = 0;
      customTitle =
        aiTitle =
        summaryTitle =
        firstPrompt =
        project =
        createdAt =
        updatedAt =
          null;
    }
    await file.verifyUnchanged();
    const index: ClaudeIndex = {
      messages: chain,
      partial,
      fingerprint: file.fingerprint,
      summary: {
        title:
          customTitle || aiTitle || firstPrompt || summaryTitle || expectedId,
        titleSource:
          customTitle || aiTitle || (summaryTitle && !firstPrompt)
            ? "native"
            : firstPrompt
              ? "first-user-message"
              : "identifier",
        project,
        createdAt,
        updatedAt,
        timeSource: createdAt ? "messages" : "unknown",
        messageCount: chain.length,
        sizeBytes: file.stat.size,
        sourceLabel: "Claude Code local main conversation branch",
        identityVerified: valid && identity,
        warnings: [...warnings],
      },
    };
    context.cache?.set("claude:current-index", index);
    return { file, index };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function* discover(
  context: ConversationReaderContext,
): AsyncGenerator<string> {
  let count = 0;
  const projects = path.join(context.root, "projects");
  try {
    const stat = await fs.lstat(projects);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const handle = await fs.opendir(projects);
    for await (const project of handle) {
      checkConversationAbort(context.signal);
      if (++count > 20000) {
        context.warn?.("Claude Code discovery reached its bounded file limit.");
        return;
      }
      if (
        !project.isDirectory() ||
        !/^[A-Za-z0-9_-]{1,240}$/.test(project.name)
      )
        continue;
      const projectPath = path.join(projects, project.name);
      try {
        const ps = await fs.lstat(projectPath);
        if (!ps.isDirectory() || ps.isSymbolicLink()) continue;
        const entries = await fs.opendir(projectPath);
        for await (const entry of entries) {
          checkConversationAbort(context.signal);
          if (++count > 20000) {
            context.warn?.(
              "Claude Code discovery reached its bounded file limit.",
            );
            return;
          }
          const relative = "projects/" + project.name + "/" + entry.name;
          if (entry.isFile() && FILE.test(relative)) yield relative;
        }
      } catch (error) {
        if (
          error instanceof ConversationReadError &&
          error.code === "CONVERSATION_CANCELLED"
        )
          throw error;
        context.warn?.(
          "Some Claude Code project transcripts could not be read safely.",
        );
      }
    }
  } catch (error) {
    if (
      error instanceof ConversationReadError &&
      error.code === "CONVERSATION_CANCELLED"
    )
      throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      context.warn?.("Claude Code transcript discovery is incomplete.");
  }
}

interface ClaudeSource {
  relative: string;
  fingerprint: string;
  agentId?: string;
  size: number;
}
interface CompositePointer extends ChainNode {
  source: ClaudeSource;
}
interface CompositeIndex {
  summary: ReaderSummary;
  messages: CompositePointer[];
  revision: string;
  partial: boolean;
}

/** Audited companion paths only; no directory name supplied in content is followed. */
async function companionInventory(
  context: ConversationReaderContext,
  relative: string,
) {
  const files: ClaudeSource[] = [];
  const stamps: string[] = [];
  const warnings = new Set<string>();
  const main = await openConversationFile(
    context.root,
    relative,
    context.signal,
  );
  try {
    files.push({
      relative,
      fingerprint: main.fingerprint,
      size: main.stat.size,
    });
    await main.verifyUnchanged();
  } finally {
    await main.close();
  }
  const parent = relative.slice(0, -6);
  const queue = [parent];
  let entriesSeen = 0;
  while (queue.length) {
    checkConversationAbort(context.signal);
    const directory = queue.shift()!;
    try {
      const s = await fs.lstat(
        path.join(context.root, ...directory.split("/")),
      );
      if (!s.isDirectory() || s.isSymbolicLink()) {
        warnings.add("Some companion paths are unsafe and were not opened.");
        stamps.push(directory + ":unsafe");
        continue;
      }
      stamps.push(
        directory + ":" + [s.dev, s.ino, s.mtimeMs, s.ctimeMs].join(":"),
      );
      const handle = await fs.opendir(
        path.join(context.root, ...directory.split("/")),
      );
      for await (const entry of handle) {
        checkConversationAbort(context.signal);
        if (++entriesSeen > 512) {
          warnings.add(
            "Companion discovery reached its bounded inventory limit.",
          );
          queue.length = 0;
          break;
        }
        const child = directory + "/" + entry.name;
        if (entry.isDirectory()) {
          if (
            child === parent + "/subagents" ||
            child === parent + "/subagents/workflows" ||
            (directory === parent + "/subagents/workflows" &&
              /^[A-Za-z0-9_-]{1,160}$/.test(entry.name))
          )
            queue.push(child);
          else if (child !== parent + "/tool-results")
            warnings.add(
              "Unknown companion directories are not projected into the conversation.",
            );
          continue;
        }
        const sub = SUBFILE.exec(child);
        if (sub && entry.isFile()) {
          if (files.length >= 33) {
            warnings.add(
              "At most 32 companion transcripts can be inspected in one conversation.",
            );
            continue;
          }
          try {
            const file = await openConversationFile(
              context.root,
              child,
              context.signal,
            );
            try {
              files.push({
                relative: child,
                fingerprint: file.fingerprint,
                agentId: sub[2] ?? sub[3],
                size: file.stat.size,
              });
              await file.verifyUnchanged();
            } finally {
              await file.close();
            }
          } catch (error) {
            if (
              error instanceof ConversationReadError &&
              error.code === "CONVERSATION_CANCELLED"
            )
              throw error;
            warnings.add(
              "A companion transcript is unavailable or unsafe and was not opened.",
            );
            stamps.push(child + ":unavailable");
          }
        } else if (
          /^agent-[A-Za-z0-9_-]{1,160}\.meta\.json$/.test(entry.name) &&
          entry.isFile()
        ) {
          // Sidecars are fingerprinted, never parsed. No parent tool relationship is guessed.
          const s = await fs.lstat(
            path.join(context.root, ...child.split("/")),
          );
          stamps.push(
            child +
              ":" +
              [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(":"),
          );
          if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1)
            warnings.add("A companion metadata file is unsafe.");
        } else
          warnings.add(
            "Unknown companion files are not projected into the conversation.",
          );
      }
    } catch (error) {
      if (
        error instanceof ConversationReadError &&
        error.code === "CONVERSATION_CANCELLED"
      )
        throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        stamps.push(directory + ":absent");
      else {
        warnings.add("Companion transcript discovery is incomplete.");
        stamps.push(directory + ":unavailable");
      }
    }
  }
  const sources = [
    files[0],
    ...files.slice(1).sort((a, b) => a.relative.localeCompare(b.relative)),
  ];
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        sources,
        stamps: stamps.sort(),
        warnings: [...warnings].sort(),
      }),
    )
    .digest("hex");
  return { sources, revision, warnings: [...warnings] };
}

async function compositeIndex(
  context: ConversationReaderContext,
  relative: string,
  expectedRevision?: string,
): Promise<CompositeIndex> {
  if (!FILE.test(relative))
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  const inventory = await companionInventory(context, relative);
  if (expectedRevision && expectedRevision !== inventory.revision)
    throw new ConversationReadError("CONVERSATION_CHANGED");
  const cached = context.cache?.get("claude:composite-index") as
    CompositeIndex | undefined;
  if (cached?.revision === inventory.revision) return cached;
  let summary: ReaderSummary | undefined;
  const messages: CompositePointer[] = [];
  let partial = inventory.warnings.length > 0;
  const warnings = new Set(inventory.warnings);
  let indexedBytes = 0;
  for (const source of inventory.sources) {
    indexedBytes += source.size;
    if (source.agentId && indexedBytes > JSONL_LIMITS.scanBytes) {
      partial = true;
      warnings.add(
        "Combined transcript data exceeded the bounded read budget; remaining companions were not searched.",
      );
      break;
    }
    if (messages.length >= JSONL_LIMITS.chainNodes) {
      partial = true;
      warnings.add(
        "Combined conversation message index reached its bounded limit.",
      );
      break;
    }
    const { file, index } = await indexClaude(
      context,
      source.relative,
      source.fingerprint,
    );
    try {
      await file.verifyUnchanged();
      if (!summary) summary = { ...index.summary, warnings: [] };
      else {
        summary.identityVerified &&= index.summary.identityVerified;
        if (
          index.summary.updatedAt &&
          (!summary.updatedAt || index.summary.updatedAt > summary.updatedAt)
        )
          summary.updatedAt = index.summary.updatedAt;
      }
      partial ||= index.partial;
      for (const warning of index.summary.warnings) warnings.add(warning);
      if (
        !source.agentId &&
        index.messages.length === 0 &&
        index.summary.warnings.some((w) =>
          w.startsWith("Native session identity"),
        )
      ) {
        partial = true;
        warnings.add(
          "Companions were not opened because their parent conversation identity is inconsistent.",
        );
        break;
      }
      const remaining = JSONL_LIMITS.chainNodes - messages.length;
      messages.push(
        ...index.messages
          .slice(0, remaining)
          .map((node) => ({ ...node, source })),
      );
      if (index.messages.length > remaining) {
        partial = true;
        warnings.add(
          "Combined conversation message index reached its bounded limit.",
        );
      }
    } finally {
      await file.close();
    }
  }
  if (!summary) throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  if (
    (await companionInventory(context, relative)).revision !==
    inventory.revision
  )
    throw new ConversationReadError("CONVERSATION_CHANGED");
  summary.messageCount = messages.length;
  summary.sizeBytes = inventory.sources.reduce(
    (n, source) => n + source.size,
    0,
  );
  summary.warnings = [...warnings];
  summary.identityVerified &&= !partial;
  if (inventory.sources.length > 1)
    summary.sourceLabel = `Claude Code main branch and ${inventory.sources.length - 1} separate subagent transcripts`;
  const result = { summary, messages, partial, revision: inventory.revision };
  context.cache?.set("claude:composite-index", result);
  return result;
}

export const claudeCodeConversationReader: ConversationReader = {
  provider: "claude-code",
  async *enumerate(context) {
    context = { ...context, cache: context.cache ?? new Map() };
    for await (const relative of discover(context)) {
      try {
        const index = await compositeIndex(context, relative);
        yield {
          sourceKey: relative,
          sourceRevision: index.revision,
          summary: index.summary,
          locator: { relativePath: relative, fingerprint: index.revision },
        };
      } catch (error) {
        if (
          error instanceof ConversationReadError &&
          error.code === "CONVERSATION_CANCELLED"
        )
          throw error;
        context.warn?.(
          "A Claude Code transcript changed or could not be read safely.",
        );
      }
    }
  },
  async read(context, descriptor, options) {
    const relative = str(descriptor.locator.relativePath);
    const fingerprint = str(descriptor.locator.fingerprint, 64);
    const offset =
      options.cursor === undefined ? 0 : obj(options.cursor)?.offset;
    let character =
      options.cursor === undefined
        ? 0
        : (obj(options.cursor)?.characterOffset ?? 0);
    if (
      !relative ||
      relative !== descriptor.sourceKey ||
      !fingerprint ||
      descriptor.sourceRevision !== fingerprint ||
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100 ||
      !Number.isSafeInteger(character) ||
      (character as number) < 0 ||
      (character as number) > 4 * 1024 * 1024
    )
      throw new Error("Invalid conversation page.");
    const index = await compositeIndex(context, relative, fingerprint);
    const messages: ConversationMessage[] = [];
    let next = offset as number;
    while (messages.length < options.limit && next < index.messages.length) {
      const pointer = index.messages[next];
      const file = await openConversationFile(
        context.root,
        pointer.source.relative,
        context.signal,
      );
      try {
        if (file.fingerprint !== pointer.source.fingerprint)
          throw new ConversationReadError("CONVERSATION_CHANGED");
        for await (const row of readJsonl(file.handle, file.stat.size, {
          start: pointer.start,
          end: pointer.end,
          signal: context.signal,
        })) {
          const id =
            "claude-" +
            createHash("sha256")
              .update(pointer.source.relative)
              .digest("hex")
              .slice(0, 16) +
            "-" +
            pointer.start;
          const parsed = row.value
            ? parseMessage(row.value, id, true, !!pointer.source.agentId)
            : null;
          if (!parsed) throw new ConversationReadError("CONVERSATION_CHANGED");
          parsed.message.source = pointer.source.agentId
            ? {
                kind: "subagent",
                label: "Claude Code subagent " + pointer.source.agentId,
                id: pointer.source.agentId,
              }
            : { kind: "main", label: "Claude Code main branch" };
          const chunk = messageChunk(parsed.message, character as number);
          messages.push(chunk.message);
          character = chunk.nextCharacter ?? 0;
          if (chunk.nextCharacter === null) next++;
        }
        await file.verifyUnchanged();
      } finally {
        await file.close();
      }
    }
    if ((await companionInventory(context, relative)).revision !== fingerprint)
      throw new ConversationReadError("CONVERSATION_CHANGED");
    return {
      messages,
      nextCursor:
        next < index.messages.length
          ? { offset: next, characterOffset: character }
          : null,
      partial: index.partial,
      warnings: index.summary.warnings,
    };
  },
};
