import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConversationMessage } from "../../shared/conversations.js";
import type {
  ConversationDescriptor,
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
import { JSONL_LIMITS, readJsonl, type JsonlRecord } from "./jsonl.js";
import {
  obj,
  str,
  timestamp,
  UUID,
  plainTextContent,
  toolResultText,
  toolResultParts,
  toolResultSupported,
  displayTitle,
  boundedMessage,
  messageChunk,
  type JsonObject,
  type ParsedMessage,
} from "./jsonl-content.js";

// Public source contract: openai/codex@3f1ccb7ceb814e54314826f68d61c892e2f5a48e.
const FILE =
  /^(?:sessions|archived_sessions)\/(?:\d{4}\/\d{2}\/\d{2}\/)?rollout-[^/]{1,100}?-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
const IGNORED_RECORDS = new Set([
  "turn_context",
  "token_usage_record",
  "world_state",
  "security_risk_score",
  "inter_agent_communication_metadata",
]);
const IGNORED_EVENTS = new Set([
  "token_count",
  "task_started",
  "task_complete",
  "turn_started",
  "turn_complete",
  "agent_message_delta",
  "agent_reasoning",
  "agent_reasoning_delta",
  "agent_reasoning_raw_content",
  "agent_reasoning_raw_content_delta",
  "agent_reasoning_section_break",
  "item_started",
  "agent_message_content_delta",
  "plan_delta",
  "reasoning_content_delta",
  "reasoning_raw_content_delta",
  "mcp_startup_update",
  "mcp_startup_complete",
  "background_event",
  "stream_error",
  "warning",
  "error",
  "session_configured",
  "shutdown_complete",
]);
interface Pointer {
  start: number;
  end: number;
  id: string;
  signature: string;
  family: "response" | "legacy" | "item" | "notice";
  paired: Set<string>;
  turn: string;
  role: string;
}
interface CodexIndex {
  summary: ReaderSummary;
  messages: Pointer[];
  partial: boolean;
  fingerprint: string;
  sessionId: string | null;
  subagent: boolean;
}

function message(
  record: JsonObject,
  id: string,
  full = false,
): {
  message: ParsedMessage;
  family: Pointer["family"];
  unsupported: boolean;
} | null {
  const bounded = (m: Omit<ParsedMessage, "truncated">) =>
    boundedMessage(m, full ? 4 * 1024 * 1024 : undefined);
  const payload = obj(record.payload);
  if (!payload) return null;
  const time = timestamp(record.timestamp);
  if (record.type === "compacted")
    return {
      family: "notice",
      unsupported: false,
      message: bounded({
        id,
        role: "system",
        kind: "notice",
        text: typeof payload.message === "string" ? payload.message : "",
        parts:
          typeof payload.message === "string"
            ? [{ type: "text", text: payload.message }]
            : [
                {
                  type: "notice",
                  text: "Compacted history is not available as text.",
                },
              ],
        timestamp: time,
        summary: true,
      }),
    };
  if (typeof payload.type !== "string") return null;
  if (record.type === "event_msg") {
    if (
      (payload.type === "user_message" || payload.type === "agent_message") &&
      typeof payload.message === "string"
    ) {
      const images = Array.isArray(payload.images) ? payload.images.length : 0;
      const files = Array.isArray(payload.file_ids)
        ? payload.file_ids.length
        : 0;
      const local = Array.isArray(payload.local_images)
        ? payload.local_images.length
        : 0;
      return {
        family: "legacy",
        unsupported: false,
        message: bounded({
          id,
          role: payload.type === "user_message" ? "user" : "assistant",
          kind: "message",
          timestamp: time,
          text: payload.message,
          parts: [
            { type: "text", text: payload.message },
            ...Array.from(
              { length: Math.min(128, images + files + local) },
              () => ({
                type: "attachment" as const,
                text: "Image attachment: preview disabled.",
              }),
            ),
          ],
        }),
      };
    }
    if (payload.type === "item_completed") {
      const item = obj(payload.item);
      if (!item) return null;
      if (item.type === "UserMessage" || item.type === "AgentMessage") {
        const text = plainTextContent(item.content, "codex");
        return {
          family: "item",
          unsupported: text.unsupported,
          message: bounded({
            id,
            role: item.type === "UserMessage" ? "user" : "assistant",
            kind: "message",
            text: text.text,
            parts: text.parts,
            timestamp: time,
          }),
        };
      }
      if (item.type === "FunctionCallOutput")
        return {
          family: "item",
          unsupported: !toolResultSupported(item.output),
          message: bounded({
            id,
            role: "tool",
            kind: "tool-result",
            text: toolResultText(item.output),
            parts: toolResultParts(item.output),
            timestamp: time,
            ...(typeof item.name === "string"
              ? { toolName: item.name.slice(0, 256) }
              : {}),
          }),
        };
    }
    return null;
  }
  if (record.type === "response_item") {
    if (
      payload.type === "message" &&
      typeof payload.role === "string" &&
      ["user", "assistant", "system", "developer"].includes(payload.role)
    ) {
      const text = plainTextContent(payload.content, "codex");
      return {
        family: "response",
        unsupported: text.unsupported,
        message: bounded({
          id,
          role:
            payload.role === "developer"
              ? "system"
              : (payload.role as ParsedMessage["role"]),
          kind: "message",
          text: text.text,
          parts: text.parts,
          timestamp: time,
        }),
      };
    }
    if (
      ["function_call", "custom_tool_call", "local_shell_call"].includes(
        payload.type,
      )
    ) {
      const name = str(payload.name, 256);
      const content =
        typeof payload.arguments === "string"
          ? payload.arguments
          : typeof payload.input === "string"
            ? payload.input
            : JSON.stringify(payload.action ?? {});
      return {
        family: "response",
        unsupported: false,
        message: bounded({
          id,
          role: "assistant",
          kind: "tool-call",
          text: (name ? name + "\n" : "") + content,
          timestamp: time,
          ...(name ? { toolName: name } : {}),
        }),
      };
    }
    if (
      [
        "function_call_output",
        "custom_tool_call_output",
        "local_shell_call_output",
      ].includes(payload.type)
    )
      return {
        family: "response",
        unsupported: !toolResultSupported(payload.output),
        message: bounded({
          id,
          role: "tool",
          kind: "tool-result",
          text: toolResultText(payload.output),
          parts: toolResultParts(payload.output),
          timestamp: time,
        }),
      };
    if (payload.type === "reasoning") return null; // Encrypted/internal reasoning is not projected into dialogue.
  }
  return null;
}

function fullSemantic(
  record: JsonObject,
  candidate: ReturnType<typeof message>,
): string {
  // Hash original content, never a truncated preview; two long messages with a
  // common prefix are distinct. Known duplicate event/response text normalizes
  // through the same representation. Nothing from the digest reaches logging.
  const content = message(record, candidate!.message.id, true)!.message.text;
  const payload = obj(record.payload)!;
  const phase =
    str(payload.phase, 64) ?? str(obj(payload.item)?.phase, 64) ?? "";
  return createHash("sha256")
    .update(candidate!.message.role)
    .update("\0")
    .update(candidate!.message.kind)
    .update("\0")
    .update(phase)
    .update("\0")
    .update(content)
    .digest("hex");
}

async function sourceTitle(
  root: string,
  id: string,
  context: ConversationReaderContext,
): Promise<string | null> {
  const key = "codex:source-titles:" + root;
  const cached = context.cache?.get(key);
  if (cached instanceof Map) return cached.get(id.toLowerCase()) ?? null;
  let file: SafeConversationFile | undefined;
  const titles = new Map<string, string>();
  try {
    file = await openConversationFile(
      root,
      "session_index.jsonl",
      context.signal,
    );
    let complete = true;
    for await (const row of readJsonl(file.handle, file.stat.size, {
      signal: context.signal,
      maxBytes: 8 * 1024 * 1024,
      maxRecords: 20000,
    })) {
      if (row.issue) {
        complete = false;
        continue;
      }
      if (
        typeof row.value?.id === "string" &&
        UUID.test(row.value.id) &&
        typeof row.value.thread_name === "string" &&
        timestamp(row.value.updated_at)
      )
        titles.set(
          row.value.id.toLowerCase(),
          displayTitle(row.value.thread_name),
        );
    }
    await file.verifyUnchanged();
    if (!complete) titles.clear();
    context.cache?.set(key, titles);
    return titles.get(id.toLowerCase()) ?? null;
  } catch (error) {
    if (
      error instanceof ConversationReadError &&
      error.code === "CONVERSATION_CANCELLED"
    )
      throw error;
    context.cache?.set(key, titles);
    return null;
  } finally {
    await file?.close();
  }
}

async function indexCodex(
  context: ConversationReaderContext,
  relative: string,
  expectedFingerprint?: string,
): Promise<{ index: CodexIndex; file: SafeConversationFile }> {
  const match = FILE.exec(relative);
  if (
    !match ||
    !UUID.test(match[1]) ||
    (match[2] !== undefined && !UUID.test(match[2]))
  )
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  const expectedId = match[1].toLowerCase();
  const physicalRolloutId = (match[2] ?? match[1]).toLowerCase();
  const reverted = match[2] !== undefined;
  const file = await openConversationFile(
    context.root,
    relative,
    context.signal,
  );
  try {
    if (expectedFingerprint && expectedFingerprint !== file.fingerprint)
      throw new ConversationReadError("CONVERSATION_CHANGED");
    const cached = context.cache?.get("codex:current-index") as
      CodexIndex | undefined;
    if (cached?.fingerprint === file.fingerprint)
      return { file, index: cached };
    const warnings = new Set<string>();
    const messages: Pointer[] = [];
    let sessionId: string | null = null;
    let project: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let title: string | null = null;
    let turn = "initial";
    let metaCount = 0;
    let valid = !reverted;
    if (reverted)
      warnings.add(
        "A reverted physical rollout is shown as a distinct local source version; the active version is not inferred from file time. Native lifecycle actions remain disabled.",
      );
    let partial = false;
    let currentTurnExplicit = false;
    let inferredTurn = 0;
    let subagentStart = 0;
    let subagent = false;
    for await (const row of readJsonl(file.handle, file.stat.size, {
      signal: context.signal,
    })) {
      if (row.issue) {
        warnings.add(
          "Some transcript records are incomplete, malformed, or exceed the bounded reader limits.",
        );
        partial = true;
        valid = false;
      }
      if (!row.value) continue;
      const r = row.value;
      const p = obj(r.payload);
      if (!p || typeof r.type !== "string") {
        partial = true;
        valid = false;
        warnings.add(
          "Unknown transcript schema; this conversation is read-only.",
        );
        continue;
      }
      const recordTime = timestamp(r.timestamp);
      if (recordTime && (!updatedAt || recordTime > updatedAt))
        updatedAt = recordTime;
      if (r.type === "session_meta") {
        metaCount++;
        const id = str(p.id, 36);
        if (
          !id ||
          !UUID.test(id) ||
          id.toLowerCase() !== expectedId ||
          metaCount > 1
        ) {
          valid = false;
          warnings.add(
            "Transcript session identity does not match its storage location.",
          );
        } else sessionId = id;
        project = str(p.cwd);
        createdAt = timestamp(p.timestamp);
        if (!createdAt)
          warnings.add(
            "The source does not contain a valid conversation creation time.",
          );
        if (!project || !createdAt) valid = false;
        if (p.history_mode === "paginated") {
          valid = false;
          warnings.add(
            "Paginated rollout storage can be referenced by other conversations. Archival requires a separate verified dependency inventory.",
          );
        }
        if (p.history_base != null || p.forked_from_id != null) {
          valid = false;
          partial = true;
          warnings.add(
            "This transcript references inherited history. Only local records are shown; linked conversations are not opened or archived.",
          );
        }
        if (p.parent_thread_id != null || obj(p.source)?.subagent != null) {
          subagent = true;
          valid = false;
          warnings.add(
            "Subagent conversation: managed separately from its parent and read-only here.",
          );
        }
        if (
          typeof p.subagent_history_start_ordinal === "number" &&
          Number.isSafeInteger(p.subagent_history_start_ordinal)
        )
          subagentStart = p.subagent_history_start_ordinal;
        continue;
      }
      if (r.type === "turn_context" && typeof p.turn_id === "string") {
        turn = p.turn_id.slice(0, 160);
        currentTurnExplicit = true;
      }
      if (
        r.type === "event_msg" &&
        ["task_started", "turn_started"].includes(
          typeof p.type === "string" ? p.type : "",
        ) &&
        typeof p.turn_id === "string"
      ) {
        turn = p.turn_id.slice(0, 160);
        currentTurnExplicit = true;
      }
      if (
        r.type === "event_msg" &&
        ["thread_rolled_back", "thread_compacted"].includes(
          typeof p.type === "string" ? p.type : "",
        )
      ) {
        valid = false;
        partial = true;
        warnings.add(
          "The source contains history rewrites; local records are shown read-only rather than guessing the resumed state.",
        );
      }
      if (
        subagentStart &&
        typeof r.ordinal === "number" &&
        r.ordinal < subagentStart
      )
        continue;
      const candidate = message(r, "codex-" + row.start);
      if (!candidate) {
        if (
          !IGNORED_RECORDS.has(r.type) &&
          !(
            r.type === "event_msg" &&
            IGNORED_EVENTS.has(typeof p.type === "string" ? p.type : "")
          ) &&
          !(r.type === "response_item" && p.type === "reasoning")
        ) {
          partial = true;
          valid = false;
          warnings.add(
            "Some source event types are not projected; this conversation is read-only.",
          );
        }
        continue;
      }
      if (candidate.unsupported) {
        partial = true;
        warnings.add(
          "Some content blocks are unsupported or shortened for safe display.",
        );
      }
      const signature = fullSemantic(r, candidate);
      const recent = messages.slice(-64).reverse();
      const duplicate = recent.find(
        (m, i) =>
          m.signature === signature &&
          m.turn === turn &&
          m.family !== candidate.family &&
          !m.paired.has(candidate.family) &&
          !recent
            .slice(0, i)
            .some(
              (intervening) =>
                intervening.role === "user" ||
                (candidate.message.role === "user" &&
                  intervening.role === "assistant"),
            ),
      );
      if (duplicate) {
        duplicate.paired.add(candidate.family);
        continue;
      }
      if (candidate.message.role === "user" && !currentTurnExplicit) {
        turn = "inferred-" + ++inferredTurn;
      }
      if (messages.length >= JSONL_LIMITS.chainNodes) {
        partial = true;
        valid = false;
        warnings.add("Conversation message index reached its bounded limit.");
        break;
      }
      messages.push({
        start: row.start,
        end: row.end,
        id: candidate.message.id,
        signature,
        family: candidate.family,
        paired: new Set([candidate.family]),
        turn,
        role: candidate.message.role,
      });
      if (
        !title &&
        candidate.message.role === "user" &&
        candidate.message.kind === "message"
      )
        title = displayTitle(candidate.message.text);
    }
    if (!sessionId || metaCount !== 1) {
      valid = false;
      warnings.add("A unique native session identity could not be verified.");
    }
    // Never disclose content from a file claiming a different native identity.
    if (!sessionId || metaCount !== 1) {
      messages.length = 0;
      title = project = createdAt = updatedAt = null;
      partial = true;
    }
    const nativeTitle = sessionId
      ? await sourceTitle(context.root, sessionId, context)
      : null;
    await file.verifyUnchanged();
    const index: CodexIndex = {
      messages,
      partial,
      fingerprint: file.fingerprint,
      sessionId,
      subagent,
      summary: {
        title: nativeTitle || title || expectedId,
        titleSource: nativeTitle
          ? "native"
          : title
            ? "first-user-message"
            : "identifier",
        project,
        createdAt,
        updatedAt,
        timeSource: createdAt ? "native" : updatedAt ? "messages" : "unknown",
        messageCount: messages.length,
        sizeBytes: file.stat.size,
        sourceLabel: `Codex 本地历史版本（未判定当前版本） · ${physicalRolloutId}`,
        identityVerified: valid,
        warnings: [...warnings],
      },
    };
    context.cache?.set("codex:current-index", index);
    return { file, index };
  } catch (error) {
    await file.close();
    throw error;
  }
}

function projected(message: ParsedMessage): ConversationMessage {
  return {
    id: message.id,
    source: {
      kind: "main",
      label: message.summary
        ? "Codex compaction summary"
        : "Codex local conversation",
    },
    role: message.role,
    timestamp: message.timestamp,
    parts: message.parts ?? [
      {
        type: message.kind === "message" ? "text" : message.kind,
        text: message.text,
      },
      ...(message.truncated
        ? [
            {
              type: "notice" as const,
              text: "This message is shortened at the bounded display limit.",
            },
          ]
        : []),
    ],
  };
}

async function* discover(
  context: ConversationReaderContext,
): AsyncGenerator<string> {
  let count = 0;
  for (const directory of ["sessions", "archived_sessions"]) {
    const queue = [directory];
    while (queue.length) {
      const relative = queue.shift()!;
      checkConversationAbort(context.signal);
      try {
        const dir = path.join(context.root, ...relative.split("/"));
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const handle = await fs.opendir(dir);
        for await (const entry of handle) {
          if (++count > 20000) {
            context.warn?.("Codex discovery reached its bounded file limit.");
            return;
          }
          const child = relative + "/" + entry.name;
          if (
            entry.isDirectory() &&
            relative.split("/").length < 4 &&
            /^\d{2,4}$/.test(entry.name)
          )
            queue.push(child);
          else if (entry.isFile() && FILE.test(child)) yield child;
          else if (
            entry.isFile() &&
            child.endsWith(".jsonl.zst") &&
            FILE.test(child.slice(0, -4))
          )
            context.warn?.(
              "Compressed Codex rollout records are present but bounded decompression is not enabled; this inventory is incomplete.",
              "UNSUPPORTED_SCHEMA",
            );
        }
      } catch (error) {
        if (
          error instanceof ConversationReadError &&
          error.code === "CONVERSATION_CANCELLED"
        )
          throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          context.warn?.(
            "Some Codex transcript folders could not be read safely.",
          );
      }
    }
  }
}

export const codexConversationReader: ConversationReader = {
  provider: "codex",
  async *enumerate(context) {
    context = { ...context, cache: context.cache ?? new Map() };
    for await (const relative of discover(context)) {
      checkConversationAbort(context.signal);
      try {
        const { file, index } = await indexCodex(context, relative);
        await file.close();
        yield {
          sourceKey: relative,
          sourceRevision: index.fingerprint,
          summary: index.summary,
          locator: {
            relativePath: relative,
            fingerprint: index.fingerprint,
            sessionId: index.sessionId,
          },
        };
      } catch (error) {
        if (
          error instanceof ConversationReadError &&
          error.code === "CONVERSATION_CANCELLED"
        )
          throw error;
        context.warn?.(
          "A Codex transcript changed or could not be read safely.",
        );
      }
    }
  },
  async read(context, descriptor, options) {
    const relative = str(descriptor.locator.relativePath);
    const fingerprint = str(descriptor.locator.fingerprint, 64);
    const offset =
      options.cursor === undefined ? 0 : obj(options.cursor)?.offset;
    if (
      !relative ||
      relative !== descriptor.sourceKey ||
      !fingerprint ||
      descriptor.sourceRevision !== fingerprint ||
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error("Invalid conversation page.");
    let character =
      options.cursor === undefined
        ? 0
        : (obj(options.cursor)?.characterOffset ?? 0);
    if (
      !Number.isSafeInteger(character) ||
      (character as number) < 0 ||
      (character as number) > 4 * 1024 * 1024
    )
      throw new Error("Invalid conversation continuation.");
    const { file, index } = await indexCodex(context, relative, fingerprint);
    try {
      const messages: ConversationMessage[] = [];
      let next = offset as number;
      while (messages.length < options.limit && next < index.messages.length) {
        const pointer = index.messages[next];
        checkConversationAbort(context.signal);
        for await (const row of readJsonl(file.handle, file.stat.size, {
          start: pointer.start,
          end: pointer.end,
          signal: context.signal,
        })) {
          const candidate = row.value
            ? message(row.value, pointer.id, true)
            : null;
          if (!candidate)
            throw new ConversationReadError("CONVERSATION_CHANGED");
          const projectedMessage = projected(candidate.message);
          if (index.subagent)
            projectedMessage.source = {
              kind: "subagent",
              label: "Codex subagent conversation",
              ...(index.sessionId ? { id: index.sessionId } : {}),
            };
          const chunk = messageChunk(projectedMessage, character as number);
          messages.push(chunk.message);
          character = chunk.nextCharacter ?? 0;
          if (chunk.nextCharacter === null) next++;
        }
      }
      await file.verifyUnchanged();
      return {
        messages,
        nextCursor:
          next < index.messages.length
            ? { offset: next, characterOffset: character }
            : null,
        partial: index.partial,
        warnings: index.summary.warnings,
      };
    } finally {
      await file.close();
    }
  },
};
