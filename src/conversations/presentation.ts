/** Plain-text presentation only. Conversation content is never HTML or a URL. */
export interface DisplayBlock {
  kind: "text" | "code";
  text: string;
  language?: string;
}
export interface DisplayText {
  blocks: DisplayBlock[];
  truncated: boolean;
}
export function displayText(input: string, limit = 12000): DisplayText {
  const text = input.slice(0, Math.max(0, Math.min(48000, limit)));
  const blocks: DisplayBlock[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [],
    code = false,
    language = "";
  const flush = () => {
    if (buffer.length)
      blocks.push({
        kind: code ? "code" : "text",
        text: buffer.join("\n"),
        ...(code && language ? { language } : {}),
      });
    buffer = [];
  };
  for (const line of lines) {
    const fence = /^```([a-zA-Z0-9_+.-]{0,32})\s*$/.exec(line);
    if (fence && (!code || !fence[1]) && blocks.length < 6) {
      flush();
      code = !code;
      language = code ? fence[1] : "";
    } else buffer.push(line);
  }
  flush();
  return { blocks, truncated: input.length > text.length };
}
export function virtualWindow(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight = 100,
) {
  const count = Math.max(0, Math.floor(total));
  const height = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 100;
  const visible = Math.min(
    40,
    Math.max(1, Math.ceil(Math.max(0, viewport) / height)),
  );
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, count - visible),
      Math.floor(Math.max(0, scrollTop) / height) - 3,
    ),
  );
  const end = Math.min(count, start + visible + 6);
  return { start, end, before: start * height, after: (count - end) * height };
}
export function formatConversationTime(value: string | null | undefined) {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "未知时间";
}
export function dateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("请选择有效日期。");
  const [year, month, day] = value.split("-").map(Number);
  // Date inputs represent the user's local calendar day, not an implicit UTC day.
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    throw new Error("请选择有效日期。");
  // Advancing the calendar day, rather than adding 24 hours, survives DST.
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
export function hiddenSelection<T extends { id: string }>(
  selected: ReadonlyMap<string, T>,
  currentPage: readonly T[],
) {
  const visible = new Set(currentPage.map((item) => item.id));
  return [...selected.values()].filter((item) => !visible.has(item.id));
}
export function formatConversationSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
export const roleLabels: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
  tool: "工具",
  unknown: "未知角色",
};
export const partLabels: Record<string, string> = {
  "tool-call": "工具调用",
  "tool-result": "工具结果",
  thinking: "思考记录",
  attachment: "附件",
  notice: "记录说明",
};
/** Bound a text slice without breaking UTF-16 surrogate pairs at either edge. */
export function textChunk(
  text: string,
  requestedOffset: number,
  requestedLimit = 12000,
) {
  let start = Math.max(
    0,
    Math.min(
      text.length,
      Math.floor(Number.isFinite(requestedOffset) ? requestedOffset : 0),
    ),
  );
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[start - 1])
  )
    start--;
  const limit = Math.max(
    1,
    Math.min(
      48000,
      Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 12000),
    ),
  );
  let end = Math.min(text.length, start + limit);
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    end++;
  return { start, end, text: text.slice(start, end), more: end < text.length };
}
