import type { FileHandle } from "node:fs/promises";
import { checkConversationAbort } from "./safe-read.js";

export const JSONL_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  lineBytes: 1024 * 1024,
  scanBytes: 128 * 1024 * 1024,
  records: 100_000,
  chainNodes: 40_000,
});
export type JsonlIssue =
  | "invalid-json"
  | "invalid-utf8"
  | "oversized-record"
  | "scan-limit"
  | "record-limit"
  | "unterminated-record";
export interface JsonlRecord {
  value: Record<string, unknown> | null;
  start: number;
  end: number;
  line: number;
  issue?: JsonlIssue;
}
export interface JsonlScanOptions {
  signal?: AbortSignal;
  start?: number;
  end?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  maxRecords?: number;
}

/** Bounded byte scanner: an enormous line is discarded without concatenating it. */
export async function* readJsonl(
  handle: FileHandle,
  size: number,
  options: JsonlScanOptions = {},
): AsyncGenerator<JsonlRecord> {
  const bounded = (v: number | undefined, max: number) =>
    v === undefined
      ? max
      : Number.isSafeInteger(v) && v > 0
        ? Math.min(v, max)
        : max;
  const maxBytes = bounded(options.maxBytes, JSONL_LIMITS.scanBytes);
  const maxLineBytes = bounded(options.maxLineBytes, JSONL_LIMITS.lineBytes);
  const maxRecords = bounded(options.maxRecords, JSONL_LIMITS.records);
  const start = options.start ?? 0;
  const end = options.end ?? size;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > size ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end > size
  )
    throw new Error("Invalid conversation read range.");
  const stop = Math.min(end, start + maxBytes);
  const buffer = Buffer.allocUnsafe(
    Math.min(JSONL_LIMITS.chunkBytes, Math.max(1, stop - start)),
  );
  let position = start;
  let lineStart = start;
  let line = 0;
  let fragments: Buffer[] = [];
  let length = 0;
  let oversized = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parse = (
    lineEnd: number,
    terminated: boolean,
  ): JsonlRecord | undefined => {
    const base = { start: lineStart, end: lineEnd, line: ++line };
    if (oversized) return { ...base, value: null, issue: "oversized-record" };
    let text: string;
    try {
      text = decoder.decode(Buffer.concat(fragments, length));
    } catch {
      return { ...base, value: null, issue: "invalid-utf8" };
    }
    // A complete JSON value without final newline is common in interrupted writes.
    // Preserve it for viewing but record the uncertainty in the issue field.
    text = text.trim();
    if (!text) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { ...base, value: null, issue: "invalid-json" };
      return {
        ...base,
        value: value as Record<string, unknown>,
        ...(!terminated ? { issue: "unterminated-record" as const } : {}),
      };
    } catch {
      return { ...base, value: null, issue: "invalid-json" };
    }
  };
  while (position < stop) {
    checkConversationAbort(options.signal);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stop - position),
      position,
    );
    if (!bytesRead) break;
    let segmentStart = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] !== 10) continue;
      const segmentLength = i - segmentStart;
      if (length + segmentLength > maxLineBytes) {
        oversized = true;
        fragments = [];
      }
      if (!oversized && segmentLength)
        fragments.push(Buffer.from(buffer.subarray(segmentStart, i)));
      length += segmentLength;
      const result = parse(position + i + 1, true);
      if (result) yield result;
      fragments = [];
      length = 0;
      oversized = false;
      lineStart = position + i + 1;
      segmentStart = i + 1;
      if (line >= maxRecords) {
        if (lineStart < end)
          yield {
            value: null,
            start: lineStart,
            end: lineStart,
            line,
            issue: "record-limit",
          };
        return;
      }
      if (line % 128 === 0) {
        checkConversationAbort(options.signal);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const remaining = bytesRead - segmentStart;
    if (length + remaining > maxLineBytes) {
      oversized = true;
      fragments = [];
    }
    if (!oversized && remaining)
      fragments.push(Buffer.from(buffer.subarray(segmentStart, bytesRead)));
    length += remaining;
    position += bytesRead;
  }
  checkConversationAbort(options.signal);
  if (position < end) {
    yield {
      value: null,
      start: lineStart,
      end: position,
      line: line + 1,
      issue: "scan-limit",
    };
  } else if (length || oversized) {
    const result = parse(position, false);
    if (result) yield result;
  }
}
