import type {
  ConversationPart,
  ConversationMessage,
} from "../../shared/conversations.js";
export type JsonObject = Record<string, unknown>;
export type MessageRole = "user" | "assistant" | "tool" | "system";
export interface ParsedMessage {
  id: string;
  role: MessageRole;
  kind: "message" | "tool-call" | "tool-result" | "notice";
  text: string;
  timestamp: string | null;
  truncated: boolean;
  summary?: boolean;
  toolName?: string;
  parts?: ConversationPart[];
}
export const MESSAGE_TEXT_LIMIT = 32_768;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const obj = (v: unknown): JsonObject | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonObject)
    : null;
export const str = (v: unknown, max = 4096): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
export function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 48) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!m) return null;
  const [, year, month, day, hour, minute, second, , zoneHour, zoneMinute] = m;
  if (
    +month < 1 ||
    +month > 12 ||
    +day < 1 ||
    +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59 ||
    +(zoneHour ?? 0) > 23 ||
    +(zoneMinute ?? 0) > 59
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export const displayTitle = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, 200);
export function plainTextContent(
  content: unknown,
  flavor: "codex" | "claude",
): {
  text: string;
  parts: ConversationPart[];
  unsupported: boolean;
  kind: ParsedMessage["kind"];
  toolName?: string;
} {
  const parts: ConversationPart[] = [];
  let unsupported = false;
  let kind: ParsedMessage["kind"] = "message";
  let toolName: string | undefined;
  if (typeof content === "string") parts.push({ type: "text", text: content });
  else if (!Array.isArray(content)) {
    unsupported = true;
    parts.push({ type: "notice", text: "Unsupported content schema." });
  } else {
    unsupported = content.length > 128;
    for (const raw of content.slice(0, 128)) {
      const b = obj(raw);
      if (!b || typeof b.type !== "string") {
        unsupported = true;
        parts.push({ type: "notice", text: "Unsupported content block." });
        continue;
      }
      if (
        ["text", "Text", "input_text", "output_text"].includes(b.type) &&
        typeof b.text === "string"
      )
        parts.push({ type: "text", text: b.text });
      else if (["image", "input_image", "local_image"].includes(b.type))
        parts.push({
          type: "attachment",
          text: "Image attachment: preview disabled.",
        });
      else if (["audio", "input_audio", "local_audio"].includes(b.type))
        parts.push({
          type: "attachment",
          text: "Audio attachment: preview disabled.",
        });
      else if (b.type === "document")
        parts.push({
          type: "attachment",
          text: "Document attachment: preview disabled.",
        });
      else if (
        flavor === "claude" &&
        b.type === "thinking" &&
        typeof b.thinking === "string"
      )
        parts.push({ type: "thinking", text: b.thinking });
      else if (flavor === "claude" && b.type === "redacted_thinking")
        parts.push({ type: "notice", text: "Redacted thinking." });
      else if (flavor === "claude" && b.type === "tool_use") {
        kind = "tool-call";
        toolName = str(b.name, 256) ?? undefined;
        parts.push({
          type: "tool-call",
          text:
            (toolName ? toolName + "\n" : "") + JSON.stringify(b.input ?? null),
        });
      } else if (flavor === "claude" && b.type === "tool_result") {
        kind = "tool-result";
        unsupported ||= !toolResultSupported(b.content);
        parts.push(...toolResultParts(b.content));
      } else if (
        flavor === "codex" &&
        (b.type === "skill" || b.type === "mention") &&
        typeof b.name === "string"
      )
        parts.push({ type: "text", text: b.name.slice(0, 256) });
      else {
        unsupported = true;
        parts.push({ type: "notice", text: "Unsupported content block." });
      }
    }
  }
  return {
    text: parts
      .filter((p) => p.type !== "attachment" && p.type !== "notice")
      .map((p) => p.text)
      .join("\n"),
    parts,
    unsupported,
    kind,
    ...(toolName ? { toolName } : {}),
  };
}
export function toolResultSupported(content: unknown): boolean {
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.length <= 128 &&
      content.every((raw) => {
        const b = obj(raw);
        return (
          typeof b?.type === "string" &&
          ((["text", "input_text", "output_text"].includes(b.type) &&
            typeof b.text === "string") ||
            ["image", "input_image"].includes(b.type))
        );
      }))
  );
}
export function toolResultParts(content: unknown): ConversationPart[] {
  if (typeof content === "string")
    return [{ type: "tool-result", text: content }];
  if (!Array.isArray(content))
    return [{ type: "notice", text: "Structured tool output is unsupported." }];
  return content.slice(0, 128).map((raw) => {
    const b = obj(raw);
    if (
      typeof b?.type === "string" &&
      ["text", "input_text", "output_text"].includes(b.type) &&
      typeof b.text === "string"
    )
      return { type: "tool-result", text: b.text };
    if (
      typeof b?.type === "string" &&
      ["image", "input_image"].includes(b.type)
    )
      return {
        type: "attachment",
        text: "Image tool output: preview disabled.",
      };
    return { type: "notice", text: "Unsupported tool output block." };
  });
}
export function toolResultText(content: unknown): string {
  return toolResultParts(content)
    .filter((p) => p.type === "tool-result")
    .map((p) => p.text)
    .join("\n");
}
export function boundedMessage(
  message: Omit<ParsedMessage, "truncated">,
  limit = MESSAGE_TEXT_LIMIT,
): ParsedMessage {
  return {
    ...message,
    text: message.text.slice(0, limit),
    truncated: message.text.length > limit,
  };
}

/** All chunks remain available through opaque paging; no permanent prefix-only view. */
export function messageChunk(
  message: ConversationMessage,
  offset = 0,
): { message: ConversationMessage; nextCharacter: number | null } {
  const total = message.parts.reduce((n, p) => n + p.text.length, 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total)
    throw new Error("Invalid conversation continuation.");
  let position = 0;
  let partIndex = 0;
  for (; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];
    if (position + part.text.length > offset) break;
    position += part.text.length;
  }
  if (partIndex >= message.parts.length)
    return {
      message: { ...message, parts: [{ type: "text", text: "" }] },
      nextCharacter: null,
    };
  const part = message.parts[partIndex];
  const localOffset = offset - position;
  let end = Math.min(part.text.length, localOffset + MESSAGE_TEXT_LIMIT);
  if (end < part.text.length && /[\uD800-\uDBFF]/.test(part.text[end - 1]))
    end--;
  const next = position + end;
  return {
    message: {
      ...message,
      id: message.id + (offset ? ":" + offset : ""),
      parts: [{ type: part.type, text: part.text.slice(localOffset, end) }],
      ...(message.parts.length > 1 || total > MESSAGE_TEXT_LIMIT || offset
        ? {
            continuation: {
              messageId: message.id,
              partIndex,
              offset: localOffset,
              hasMore: next < total,
            },
          }
        : {}),
    },
    nextCharacter: next < total ? next : null,
  };
}
