/** Read-only projections from pinned Cline SDK v1 and legacy 3.67 schemas. */
export const CLINE_SDK_SOURCE_PIN = "afabc824d88ebd0c779ab06f0cfb14c5483dc50f";
export const CLINE_LEGACY_SOURCE_PIN =
  "31e8c85f0a5e038bd02b160fc4cc18c5ba611b00";
export const CLINE_SDK_SESSION_ID =
  /^\d{13}_[a-z0-9]{5}(?:__[a-zA-Z0-9._-]{1,156})?$/;
export const CLINE_LEGACY_TASK_ID = /^\d{10,16}$/;
const statuses = new Set([
  "idle",
  "running",
  "pending",
  "completed",
  "failed",
  "cancelled",
]);
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.trim()
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim()
        .slice(0, max)
    : undefined;
}
export function dateMs(value: unknown): number | undefined {
  const normalized = strictTimestamp(value);
  if (!normalized) return undefined;
  const n = Date.parse(normalized);
  return n >= 0 ? n : undefined;
}

export interface ClineManifest {
  version: 1;
  session_id: string;
  source: string;
  pid: number;
  started_at: string;
  ended_at?: string;
  status: string;
  interactive: boolean;
  provider: string;
  model: string;
  cwd: string;
  workspace_root: string;
  team_name?: string;
  enable_tools: boolean;
  enable_spawn: boolean;
  enable_teams: boolean;
  prompt?: string;
  metadata?: Record<string, unknown>;
  messages_path?: string;
  compaction_path?: string;
}
export function parseClineManifest(
  value: unknown,
  id: string,
): ClineManifest | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.session_id !== id ||
    !CLINE_SDK_SESSION_ID.test(id)
  )
    return;
  if (
    !Number.isSafeInteger(value.pid) ||
    dateMs(value.started_at) === undefined ||
    typeof value.status !== "string" ||
    !statuses.has(value.status)
  )
    return;
  if (
    ["source", "provider", "model", "cwd", "workspace_root"].some(
      (key) => !text(value[key]),
    )
  )
    return;
  if (
    ["interactive", "enable_tools", "enable_spawn", "enable_teams"].some(
      (key) => typeof value[key] !== "boolean",
    )
  )
    return;
  if (value.ended_at !== undefined && dateMs(value.ended_at) === undefined)
    return;
  if (value.metadata !== undefined && !record(value.metadata)) return;
  if (
    ["prompt", "team_name", "messages_path", "compaction_path"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    )
  )
    return;
  return value as unknown as ClineManifest;
}
export interface ClineProjectedBlock {
  kind:
    | "text"
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "attachment"
    | "unknown";
  text: string;
  name?: string;
  isError?: boolean;
  truncated?: boolean;
}
export interface ClineMessageSegment {
  blockIndex: number;
  textOffset: number;
}
export interface ClineProjectedMessage {
  role: "user" | "assistant";
  id: string;
  timestamp?: number;
  blocks: ClineProjectedBlock[];
  text: string;
  truncated: boolean;
  nextSegment?: ClineMessageSegment;
  continued: boolean;
  nativeMessageId: string;
  segmentStart: ClineMessageSegment;
}
const MAX_BLOCK_TEXT = 16 * 1024;
function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[无法显示的内容]";
  }
}
function projectBlock(raw: unknown): ClineProjectedBlock | undefined {
  if (!record(raw)) return { kind: "unknown", text: "[无法识别的内容块]" };
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string"
        ? { kind: "text", text: raw.text }
        : undefined;
    case "thinking":
      return typeof raw.thinking === "string"
        ? { kind: "thinking", text: raw.thinking }
        : undefined;
    case "tool_use":
      return {
        kind: "tool-call",
        name: text(raw.name, 128) ?? "tool",
        text: printable(raw.input),
      };
    case "tool_result": {
      const result = Array.isArray(raw.content)
        ? raw.content
            .map((part) =>
              record(part) &&
              part.type === "text" &&
              typeof part.text === "string"
                ? part.text
                : "[附件或结构化工具结果]",
            )
            .join("\n")
        : typeof raw.content === "string"
          ? raw.content
          : "[结构化工具结果]";
      return {
        kind: "tool-result",
        text: result,
        ...(typeof raw.is_error === "boolean" ? { isError: raw.is_error } : {}),
      };
    }
    case "image":
    case "document":
      return {
        kind: "attachment",
        text: "[附件：仅显示类型，不加载或发送内容]",
      };
    case "redacted_thinking":
      return { kind: "thinking", text: "[提供方已隐去的推理内容]" };
    default:
      return {
        kind: "unknown",
        text: `[未知内容块：${text(raw.type, 64) ?? "unknown"}]`,
      };
  }
}
/** Bounded display segment. Every ordinary text character remains reachable by nextSegment. */
export function projectClineMessage(
  value: unknown,
  index: number,
  legacy = false,
  segment?: ClineMessageSegment,
): ClineProjectedMessage | undefined {
  if (!record(value) || (value.role !== "user" && value.role !== "assistant"))
    return;
  if (
    !Array.isArray(value.content) &&
    !(legacy && typeof value.content === "string")
  )
    return;
  const content =
    typeof value.content === "string"
      ? [{ type: "text", text: value.content }]
      : value.content;
  let blockIndex = segment?.blockIndex ?? 0,
    textOffset = segment?.textOffset ?? 0;
  if (
    !Number.isSafeInteger(blockIndex) ||
    blockIndex < 0 ||
    blockIndex > content.length ||
    !Number.isSafeInteger(textOffset) ||
    textOffset < 0
  )
    return;
  const blocks: ClineProjectedBlock[] = [];
  let remaining = MAX_BLOCK_TEXT;
  while (blockIndex < content.length && remaining > 0 && blocks.length < 64) {
    const block = projectBlock(content[blockIndex]);
    if (!block || textOffset > block.text.length) return;
    let end = Math.min(block.text.length, textOffset + remaining);
    if (
      end < block.text.length &&
      end > textOffset &&
      /[\uD800-\uDBFF]/.test(block.text[end - 1])
    )
      end--;
    if (end === textOffset && block.text.length > textOffset) break;
    const next = { ...block, text: block.text.slice(textOffset, end) };
    blocks.push(next);
    remaining -= next.text.length;
    if (end < block.text.length) {
      textOffset = end;
      break;
    }
    blockIndex++;
    textOffset = 0;
  }
  const nextSegment =
    blockIndex < content.length ? { blockIndex, textOffset } : undefined;
  return {
    role: value.role,
    id: `message-${index}:${text(value.id, 256) ?? "native"}:${segment?.blockIndex ?? 0}-${segment?.textOffset ?? 0}`,
    ...(typeof value.ts === "number" &&
    Number.isFinite(value.ts) &&
    value.ts >= 0
      ? { timestamp: value.ts }
      : {}),
    blocks,
    text: blocks.map((block) => block.text).join("\n\n"),
    truncated: false,
    ...(nextSegment ? { nextSegment } : {}),
    continued: !!segment,
    nativeMessageId: `message-${index}:${text(value.id, 256) ?? "native"}`,
    segmentStart: segment ?? { blockIndex: 0, textOffset: 0 },
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConversationMessage } from "../../shared/conversations.js";
import type {
  ConversationDescriptor,
  ConversationReader,
  ConversationReaderContext,
  ConversationReaderPage,
} from "./types.js";
import {
  checkConversationAbort,
  ConversationReadError,
  openConversationFile,
} from "./safe-read.js";
import {
  ClineReadError,
  readClineArrayPage,
  readClineMessageHeader,
  type ClineArrayCursor,
} from "./cline-json-stream.js";
import { timestamp as strictTimestamp } from "./jsonl-content.js";
import { validateClineReadRoot } from "./cline-read-root.js";

const MAX_SESSIONS = 2000;
const MAX_MANIFEST_BYTES = 128 * 1024;
const EXTENSION_SUFFIX = "/globalstorage/saoudrizwan.claude-dev";
const ARCHIVE_WARNING =
  "Cline 会话归档尚未开放：索引、子任务和检查点需要一致性事务。";
function issue(context: ConversationReaderContext, message: string) {
  context.warn?.(message);
}
function cancelled(error: unknown): boolean {
  return (
    (error instanceof ConversationReadError &&
      error.code === "CONVERSATION_CANCELLED") ||
    (error instanceof ClineReadError && error.code === "CLINE_CANCELLED")
  );
}
function iso(value: unknown): string | null {
  const time = dateMs(value);
  return time === undefined ? null : new Date(time).toISOString();
}
async function manifestFile(
  context: ConversationReaderContext,
  relative: string,
): Promise<{ value: unknown; fingerprint: string }> {
  const file = await openConversationFile(
    context.root,
    relative,
    context.signal,
  );
  try {
    if (file.stat.size > MAX_MANIFEST_BYTES)
      throw new ClineReadError("CLINE_READ_LIMIT");
    const bytes = Buffer.alloc(
      Math.min(MAX_MANIFEST_BYTES + 1, file.stat.size + 1),
    );
    const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES)
      throw new ClineReadError("CLINE_READ_LIMIT");
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, bytesRead),
        ),
      );
    } catch {
      throw new ClineReadError("CLINE_INVALID_JSON");
    }
    await file.verifyUnchanged();
    return { value, fingerprint: file.fingerprint };
  } finally {
    await file.close();
  }
}

function sdkMessagesPaths(id: string): string[] {
  const paths = [`sessions/${id}/${id}.messages.json`];
  const marker = id.indexOf("__");
  if (marker < 0) return paths;
  const root = id.slice(0, marker),
    suffix = id.slice(marker + 2);
  if (!/^\d{13}_[a-z0-9]{5}$/.test(root)) return paths;
  if (suffix.startsWith("teamtask__")) {
    const rest = suffix.slice("teamtask__".length),
      last = rest.lastIndexOf("__");
    if (last > 0 && /^[A-Za-z0-9_-]{6}$/.test(rest.slice(last + 2)))
      paths.push(`sessions/${root}/${rest}.messages.json`);
  } else paths.push(`sessions/${root}/${suffix}.messages.json`);
  return paths;
}
async function* linkedChildren(
  context: ConversationReaderContext,
  parent: ConversationDescriptor,
): AsyncIterable<ConversationDescriptor> {
  const parentId = parent.locator.sessionId as string;
  if (parentId.includes("__")) return;
  const directory = await fs.opendir(
    path.join(context.root, "sessions", parentId),
  );
  let visited = 0;
  for await (const entry of directory) {
    checkConversationAbort(context.signal);
    if (++visited > 1000) {
      issue(context, "关联 Cline 内容达到目录上限，结果不完整。");
      break;
    }
    if (
      !entry.isFile() ||
      !/^[A-Za-z0-9._-]{1,180}\.messages\.json$/.test(entry.name) ||
      entry.name === `${parentId}.messages.json`
    )
      continue;
    const messagesPath = `sessions/${parentId}/${entry.name}`;
    try {
      const file = await openConversationFile(
        context.root,
        messagesPath,
        context.signal,
      );
      try {
        const header = await readClineMessageHeader(
          file.handle,
          undefined,
          context.signal,
        );
        if (
          !CLINE_SDK_SESSION_ID.test(header.sessionId) ||
          !header.sessionId.startsWith(`${parentId}__`) ||
          !["subagent", "teammate"].includes(header.agent) ||
          !sdkMessagesPaths(header.sessionId).includes(messagesPath)
        ) {
          issue(context, "关联 Cline 文件的身份或路径不匹配，已跳过。");
          continue;
        }
        let title: string | undefined;
        try {
          const first = await readClineArrayPage(file.handle, {
            format: "sdk-v1",
            sessionId: header.sessionId,
            limit: 1,
            maxValueBytes: 256 * 1024,
            maxReadBytes: 1024 * 1024,
            signal: context.signal,
          });
          const message = first.values[0];
          if (
            record(message) &&
            message.role === "user" &&
            Array.isArray(message.content)
          ) {
            const block = message.content.find(
              (part) =>
                record(part) &&
                part.type === "text" &&
                typeof part.text === "string",
            );
            if (record(block))
              title = text(block.text, 240)?.replace(/\s+/g, " ");
          }
        } catch (error) {
          if (cancelled(error)) throw error;
        }
        await file.verifyUnchanged();
        const anchor = await openConversationFile(
          context.root,
          parent.locator.manifestPath as string,
          context.signal,
        );
        try {
          if (anchor.fingerprint !== parent.locator.manifestFingerprint)
            throw new ConversationReadError("CONVERSATION_CHANGED");
          await anchor.verifyUnchanged();
        } finally {
          await anchor.close();
        }
        yield {
          sourceKey: `cline-sdk-v1:${header.sessionId}`,
          sourceRevision: `${parent.locator.manifestFingerprint}:${file.fingerprint}`,
          summary: {
            title: title ?? `Cline ${header.sessionId}`,
            titleSource: title ? "first-user-message" : "identifier",
            project: parent.summary.project,
            createdAt: null,
            updatedAt: iso(header.updatedAt),
            timeSource: iso(header.updatedAt) ? "native" : "unknown",
            messageCount: null,
            sizeBytes: file.stat.size,
            sourceLabel:
              header.agent === "teammate"
                ? "Cline 团队关联会话"
                : "Cline 关联子会话",
            identityVerified: true,
            warnings: [
              ARCHIVE_WARNING,
              "关联子会话与父任务共享文件目录；创建时间未从原生索引读取。",
            ],
          },
          locator: {
            format: "sdk-v1",
            sessionId: header.sessionId,
            messagesPath,
            manifestPath: parent.locator.manifestPath,
            manifestFingerprint: parent.locator.manifestFingerprint,
            fingerprint: file.fingerprint,
          },
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (cancelled(error)) throw error;
      issue(context, "部分关联 Cline 会话无法安全读取，已跳过。");
    }
  }
}

async function* enumerateSdk(
  context: ConversationReaderContext,
): AsyncIterable<ConversationDescriptor> {
  const parent = path.join(context.root, "sessions");
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  const directory = await fs.opendir(parent);
  const ids: string[] = [];
  let scanned = 0;
  for await (const entry of directory) {
    checkConversationAbort(context.signal);
    if (++scanned > MAX_SESSIONS * 4) {
      issue(context, "Cline 目录枚举达到保护上限，结果不完整。");
      break;
    }
    if (entry.isDirectory() && CLINE_SDK_SESSION_ID.test(entry.name))
      ids.push(entry.name);
  }
  ids.sort((a, b) => b.localeCompare(a));
  if (ids.length > MAX_SESSIONS)
    issue(
      context,
      "Cline 会话超过本次读取上限，仅显示最新标识范围；请缩小所选数据目录。",
    );
  const seen = new Set<string>();
  for (const id of ids.slice(0, MAX_SESSIONS)) {
    checkConversationAbort(context.signal);
    const manifestPath = `sessions/${id}/${id}.json`;
    let messagesPath = `sessions/${id}/${id}.messages.json`;
    try {
      const raw = await manifestFile(context, manifestPath);
      const manifest = parseClineManifest(raw.value, id);
      if (!manifest) {
        issue(context, "部分 Cline 清单版本或字段无法验证，已跳过。");
        continue;
      }
      if (manifest.messages_path !== undefined) {
        const match = sdkMessagesPaths(id).find(
          (relative) =>
            path.isAbsolute(manifest.messages_path!) &&
            path.resolve(manifest.messages_path!) ===
              path.join(context.root, ...relative.split("/")),
        );
        if (!match) {
          issue(
            context,
            "部分 Cline 会话指向所选目录外或非标准消息路径，已保护。",
          );
          continue;
        }
        messagesPath = match;
      }
      const file = await openConversationFile(
        context.root,
        messagesPath,
        context.signal,
      );
      let descriptor: ConversationDescriptor;
      try {
        const header = await readClineMessageHeader(
          file.handle,
          id,
          context.signal,
        );
        let title =
          text(manifest.metadata?.title, 240) ?? text(manifest.prompt, 240);
        let titleSource: "native" | "first-user-message" | "identifier" = title
          ? "native"
          : "identifier";
        if (!title) {
          try {
            const first = await readClineArrayPage(file.handle, {
              format: "sdk-v1",
              sessionId: id,
              limit: 8,
              signal: context.signal,
              maxReadBytes: 1024 * 1024,
              maxValueBytes: 256 * 1024,
            });
            for (const rawMessage of first.values) {
              if (
                !record(rawMessage) ||
                rawMessage.role !== "user" ||
                !Array.isArray(rawMessage.content)
              )
                continue;
              const firstText = rawMessage.content.find(
                (block) =>
                  record(block) &&
                  block.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.trim(),
              );
              if (record(firstText)) {
                title = text(firstText.text, 240)?.replace(/\s+/g, " ");
                if (title) {
                  titleSource = "first-user-message";
                  break;
                }
              }
            }
          } catch (error) {
            if (cancelled(error)) throw error;
          }
        }
        const updatedAt = iso(header.updatedAt) ?? iso(manifest.ended_at);
        const warnings = [ARCHIVE_WARNING];
        if (!updatedAt)
          warnings.push("原生记录未提供有效更新时间；不以文件修改时间替代。");
        if (header.agent !== "lead" || id.includes("__"))
          warnings.push("这是关联子会话，不能作为独立清理单元。");
        descriptor = {
          sourceKey: `cline-sdk-v1:${id}`,
          sourceRevision: `${raw.fingerprint}:${file.fingerprint}`,
          summary: {
            title: title ?? `Cline ${id}`,
            titleSource,
            project:
              text(manifest.workspace_root) ?? text(manifest.cwd) ?? null,
            createdAt: iso(manifest.started_at),
            updatedAt,
            timeSource: "native",
            messageCount: null,
            sizeBytes: file.stat.size,
            sourceLabel: "Cline SDK 会话 · v1",
            identityVerified: true,
            warnings,
          },
          locator: {
            format: "sdk-v1",
            sessionId: id,
            messagesPath,
            manifestPath,
            manifestFingerprint: raw.fingerprint,
            fingerprint: file.fingerprint,
          },
        };
        await file.verifyUnchanged();
      } finally {
        await file.close();
      }
      // Pair the manifest and message observations; never publish a stale pair.
      const verify = await openConversationFile(
        context.root,
        manifestPath,
        context.signal,
      );
      try {
        if (verify.fingerprint !== raw.fingerprint)
          throw new ConversationReadError("CONVERSATION_CHANGED");
        await verify.verifyUnchanged();
      } finally {
        await verify.close();
      }
      if (!seen.has(descriptor.sourceKey)) {
        seen.add(descriptor.sourceKey);
        yield descriptor;
      }
      for await (const child of linkedChildren(context, descriptor)) {
        if (!seen.has(child.sourceKey)) {
          seen.add(child.sourceKey);
          yield child;
        }
        if (seen.size >= MAX_SESSIONS) {
          issue(context, "Cline 及关联子会话达到总数上限，结果不完整。");
          return;
        }
      }
    } catch (error) {
      if (cancelled(error)) throw error;
      issue(
        context,
        "部分 Cline 会话正在变化、格式不支持或无法安全读取，已跳过；可刷新重试。",
      );
    }
  }
}

async function* enumerateLegacy(
  context: ConversationReaderContext,
): AsyncIterable<ConversationDescriptor> {
  const index = await openConversationFile(
    context.root,
    "state/taskHistory.json",
    context.signal,
  );
  try {
    let cursor: ClineArrayCursor | undefined;
    let scanned = 0;
    const ids = new Set<string>();
    do {
      const page = await readClineArrayPage(index.handle, {
        format: "legacy-history",
        cursor,
        limit: 100,
        signal: context.signal,
        maxValueBytes: MAX_MANIFEST_BYTES,
      });
      const descriptors: ConversationDescriptor[] = [];
      for (const row of page.values) {
        checkConversationAbort(context.signal);
        if (++scanned > MAX_SESSIONS) {
          issue(context, "Cline 历史索引达到本次读取上限，结果不完整。");
          break;
        }
        if (
          !record(row) ||
          typeof row.id !== "string" ||
          !CLINE_LEGACY_TASK_ID.test(row.id) ||
          typeof row.task !== "string" ||
          typeof row.ts !== "number" ||
          !Number.isSafeInteger(row.ts) ||
          row.ts < 0 ||
          row.ts > 8.64e15
        ) {
          issue(context, "部分 Cline 历史记录格式未知，已跳过。");
          continue;
        }
        if (ids.has(row.id)) {
          issue(context, "Cline 历史索引包含重复任务标识，重复项已跳过。");
          continue;
        }
        ids.add(row.id);
        const messagesPath = `tasks/${row.id}/api_conversation_history.json`;
        try {
          const file = await openConversationFile(
            context.root,
            messagesPath,
            context.signal,
          );
          try {
            const title = text(row.task, 240);
            descriptors.push({
              sourceKey: `cline-legacy-api:${row.id}`,
              sourceRevision: `${index.fingerprint}:${file.fingerprint}`,
              summary: {
                title: title ?? `Cline ${row.id}`,
                titleSource: title ? "native" : "identifier",
                project: text(row.cwdOnTaskInitialization) ?? null,
                createdAt: null,
                updatedAt: new Date(row.ts).toISOString(),
                timeSource: "native",
                messageCount: null,
                sizeBytes: file.stat.size,
                sourceLabel: "Cline 扩展历史 · 旧格式",
                identityVerified: true,
                warnings: [
                  ARCHIVE_WARNING,
                  "旧索引只提供一个原生时间字段，无法独立确认创建时间。",
                ],
              },
              locator: {
                format: "legacy-api",
                sessionId: row.id,
                messagesPath,
                fingerprint: file.fingerprint,
                indexFingerprint: index.fingerprint,
              },
            });
            await file.verifyUnchanged();
          } finally {
            await file.close();
          }
        } catch (error) {
          if (cancelled(error)) throw error;
          issue(
            context,
            "部分 Cline 历史任务缺少可安全读取的对话文件，已跳过。",
          );
        }
      }
      await index.verifyUnchanged();
      for (const descriptor of descriptors) yield descriptor;
      cursor = page.next;
    } while (cursor && scanned <= MAX_SESSIONS);
  } finally {
    await index.close();
  }
}

function messageForRenderer(
  message: ClineProjectedMessage,
  sessionId: string,
): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    ...(message.nextSegment || message.continued
      ? {
          continuation: {
            messageId: message.nativeMessageId,
            partIndex: message.segmentStart.blockIndex,
            offset: message.segmentStart.textOffset,
            hasMore: !!message.nextSegment,
          },
        }
      : {}),
    source: {
      kind: sessionId.includes("__") ? "subagent" : "main",
      label: sessionId.includes("__") ? "Cline 子会话" : "Cline 会话",
      id: sessionId,
    },
    timestamp:
      message.timestamp !== undefined && message.timestamp <= 8.64e15
        ? new Date(message.timestamp).toISOString()
        : null,
    parts: message.blocks.map((block) => ({
      type: block.kind === "unknown" ? ("notice" as const) : block.kind,
      text: (block.kind === "tool-call" ? `${block.name}: ` : "") + block.text,
    })),
  };
}

export const clineConversationReader: ConversationReader = {
  provider: "cline",
  async *enumerate(context) {
    checkConversationAbort(context.signal);
    // Metadata-only root identity validation; never read settings, secrets or DB rows.
    await validateClineReadRoot(context.root, context.signal);
    const legacy = context.root
      .replaceAll("\\", "/")
      .toLowerCase()
      .endsWith(EXTENSION_SUFFIX);
    if (legacy) yield* enumerateLegacy(context);
    else yield* enumerateSdk(context);
  },
  async read(context, descriptor, options): Promise<ConversationReaderPage> {
    checkConversationAbort(context.signal);
    const locator = descriptor.locator;
    const format = locator.format;
    const id = locator.sessionId;
    if (
      (format !== "sdk-v1" && format !== "legacy-api") ||
      typeof id !== "string" ||
      typeof locator.messagesPath !== "string" ||
      typeof locator.fingerprint !== "string" ||
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new ClineReadError("CLINE_UNSUPPORTED_FORMAT");
    const expectedPath = locator.messagesPath;
    if (
      !(format === "sdk-v1" ? CLINE_SDK_SESSION_ID : CLINE_LEGACY_TASK_ID).test(
        id,
      ) ||
      !(
        format === "sdk-v1"
          ? sdkMessagesPaths(id)
          : [`tasks/${id}/api_conversation_history.json`]
      ).includes(expectedPath)
    )
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    let cursor: ClineArrayCursor | undefined,
      segment: ClineMessageSegment | undefined;
    if (options.cursor !== undefined && options.cursor !== null) {
      if (
        !record(options.cursor) ||
        options.cursor.fingerprint !== locator.fingerprint
      )
        throw new ConversationReadError("CONVERSATION_CHANGED");
      if (
        options.cursor.arrayCursor !== null &&
        options.cursor.arrayCursor !== undefined
      ) {
        const inner = options.cursor.arrayCursor;
        if (
          !record(inner) ||
          !Number.isSafeInteger(inner.byteOffset) ||
          !Number.isSafeInteger(inner.messageIndex)
        )
          throw new ConversationReadError("CONVERSATION_CHANGED");
        cursor = {
          byteOffset: inner.byteOffset as number,
          messageIndex: inner.messageIndex as number,
        };
      }
      if (options.cursor.segment !== undefined) {
        const inner = options.cursor.segment;
        if (
          !record(inner) ||
          !Number.isSafeInteger(inner.blockIndex) ||
          !Number.isSafeInteger(inner.textOffset)
        )
          throw new ConversationReadError("CONVERSATION_CHANGED");
        segment = {
          blockIndex: inner.blockIndex as number,
          textOffset: inner.textOffset as number,
        };
      }
    }
    // Verify source-pair identity before and after reading each page.
    const anchorPath =
      format === "sdk-v1" ? locator.manifestPath : "state/taskHistory.json";
    if (
      typeof anchorPath !== "string" ||
      (format === "sdk-v1" &&
        ![
          `sessions/${id}/${id}.json`,
          `sessions/${id.split("__")[0]}/${id.split("__")[0]}.json`,
        ].includes(anchorPath))
    )
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    const anchor = await openConversationFile(
      context.root,
      anchorPath,
      context.signal,
    );
    let file: Awaited<ReturnType<typeof openConversationFile>> | undefined;
    try {
      if (
        anchor.fingerprint !==
        (format === "sdk-v1"
          ? locator.manifestFingerprint
          : locator.indexFingerprint)
      )
        throw new ConversationReadError("CONVERSATION_CHANGED");
      file = await openConversationFile(
        context.root,
        expectedPath,
        context.signal,
      );
      if (file.fingerprint !== locator.fingerprint)
        throw new ConversationReadError("CONVERSATION_CHANGED");
      const messages: ConversationMessage[] = [],
        warnings: string[] = [];
      let partial = false,
        done = false;
      let pending: Awaited<ReturnType<typeof readClineArrayPage>> | undefined;
      // Stream one source message at a time. Display segments bound renderer payloads
      // without dropping the tail of an otherwise supported message.
      const pageLimit = Math.min(options.limit, 24);
      for (let visited = 0; visited < pageLimit && !done; visited++) {
        checkConversationAbort(context.signal);
        const page =
          pending ??
          (await readClineArrayPage(file.handle, {
            format,
            sessionId: id,
            cursor,
            limit: 1,
            signal: context.signal,
            maxValueBytes: 8 * 1024 * 1024,
          }));
        if (!page.values.length) {
          done = true;
          break;
        }
        const projected = projectClineMessage(
          page.values[0],
          page.indexes[0],
          format === "legacy-api",
          segment,
        );
        if (!projected) {
          partial = true;
          if (!warnings.length)
            warnings.push("部分消息结构不受支持，未尝试猜测内容。");
          segment = undefined;
          cursor = page.next;
          pending = undefined;
          done = !cursor;
          continue;
        }
        messages.push(messageForRenderer(projected, id));
        if (projected.nextSegment) {
          segment = projected.nextSegment;
          pending = page;
        } else {
          segment = undefined;
          cursor = page.next;
          pending = undefined;
          done = !cursor;
        }
      }
      await file.verifyUnchanged();
      await anchor.verifyUnchanged();
      return {
        messages,
        nextCursor: done
          ? null
          : {
              arrayCursor: cursor ?? null,
              ...(segment ? { segment } : {}),
              fingerprint: file.fingerprint,
            },
        partial,
        warnings,
      };
    } finally {
      if (file) await file.close();
      await anchor.close();
    }
  },
};
