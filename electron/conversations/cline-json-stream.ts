import type { FileHandle } from "node:fs/promises";

export class ClineReadError extends Error {
  constructor(
    readonly code:
      | "CLINE_INVALID_JSON"
      | "CLINE_UNSUPPORTED_FORMAT"
      | "CLINE_READ_LIMIT"
      | "CLINE_CANCELLED",
  ) {
    super(code);
    this.name = "ClineReadError";
  }
}

const fail = (code: ConstructorParameters<typeof ClineReadError>[0]): never => {
  throw new ClineReadError(code);
};
const whitespace = (byte: number) =>
  byte === 32 || byte === 10 || byte === 13 || byte === 9;
const delimiter = (byte: number) =>
  whitespace(byte) || byte === 44 || byte === 93 || byte === 125;

/** Incremental UTF-8 JSON framing. At most one bounded JSON value is materialized. */
class ByteReader {
  private buffer = Buffer.alloc(64 * 1024);
  private position = 0;
  private length = 0;
  private base: number;
  private readBytes = 0;
  constructor(
    private readonly file: FileHandle,
    start: number,
    private readonly signal: AbortSignal | undefined,
    private readonly maxBytes: number,
  ) {
    this.base = start;
  }
  get offset() {
    return this.base + this.position;
  }
  async ensure(): Promise<boolean> {
    if (this.signal?.aborted) return fail("CLINE_CANCELLED");
    if (this.position < this.length) return true;
    this.base += this.length;
    this.position = this.length = 0;
    if (this.readBytes >= this.maxBytes) return fail("CLINE_READ_LIMIT");
    const n = Math.min(this.buffer.length, this.maxBytes - this.readBytes);
    const { bytesRead } = await this.file.read(this.buffer, 0, n, this.base);
    this.length = bytesRead;
    this.readBytes += bytesRead;
    if (this.signal?.aborted) return fail("CLINE_CANCELLED");
    return bytesRead > 0;
  }
  async peek(): Promise<number> {
    return (await this.ensure()) ? this.buffer[this.position]! : -1;
  }
  async skipSpace() {
    while (await this.ensure()) {
      while (
        this.position < this.length &&
        whitespace(this.buffer[this.position]!)
      )
        this.position++;
      if (this.position < this.length) return;
    }
  }
  async expect(byte: number) {
    await this.skipSpace();
    if ((await this.peek()) !== byte) return fail("CLINE_INVALID_JSON");
    this.position++;
  }
  async value(maxBytes: number): Promise<unknown> {
    await this.skipSpace();
    if (!(await this.ensure())) return fail("CLINE_INVALID_JSON");
    const parts: Buffer[] = [];
    let bytes = 0,
      quoted = false,
      escaped = false,
      primitive = false,
      initialized = false,
      complete = false;
    const stack: number[] = [];
    while (!complete && (await this.ensure())) {
      const start = this.position;
      while (this.position < this.length) {
        const byte = this.buffer[this.position]!;
        if (!initialized) {
          initialized = true;
          primitive = byte !== 34 && byte !== 123 && byte !== 91;
        }
        if (primitive && !quoted && !stack.length && delimiter(byte)) {
          complete = true;
          break;
        }
        this.position++;
        if (++bytes > maxBytes) return fail("CLINE_READ_LIMIT");
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) {
            quoted = false;
            if (!stack.length) {
              complete = true;
              break;
            }
          }
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
          stack.push(byte);
          if (stack.length > 64) return fail("CLINE_READ_LIMIT");
        } else if (byte === 125 || byte === 93) {
          const previous = stack.pop();
          if (previous !== (byte === 125 ? 123 : 91))
            return fail("CLINE_INVALID_JSON");
          if (!stack.length) {
            complete = true;
            break;
          }
        }
      }
      if (this.position > start)
        parts.push(Buffer.from(this.buffer.subarray(start, this.position)));
    }
    if (!initialized || quoted || stack.length || (!complete && !primitive))
      return fail("CLINE_INVALID_JSON");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(parts, bytes),
        ),
      );
    } catch {
      return fail("CLINE_INVALID_JSON");
    }
  }
}

async function readEnvelope(
  reader: ByteReader,
  expectedId: string | undefined,
  seen: Set<string>,
): Promise<{ updatedAt?: string; agent: string; sessionId: string }> {
  await reader.expect(123);
  let version: unknown, sessionId: unknown, agent: unknown, updatedAt: unknown;
  for (;;) {
    const key = await reader.value(4096);
    if (typeof key !== "string" || seen.has(key))
      return fail("CLINE_INVALID_JSON");
    seen.add(key);
    await reader.expect(58);
    if (key === "messages") {
      if (
        version !== 1 ||
        typeof sessionId !== "string" ||
        sessionId.length > 256 ||
        !sessionId ||
        (expectedId !== undefined && sessionId !== expectedId) ||
        typeof agent !== "string" ||
        !["lead", "subagent", "teammate"].includes(agent)
      )
        return fail("CLINE_UNSUPPORTED_FORMAT");
      await reader.expect(91);
      return {
        agent: String(agent),
        sessionId: String(sessionId),
        ...(typeof updatedAt === "string" ? { updatedAt } : {}),
      };
    }
    const value = await reader.value(64 * 1024);
    if (key === "version") version = value;
    if (key === "sessionId") sessionId = value;
    if (key === "agent") agent = value;
    if (key === "updated_at") updatedAt = value;
    if (seen.size > 32) return fail("CLINE_READ_LIMIT");
    await reader.expect(44);
  }
}

/** Reads only the bounded official envelope prefix, never a message or system prompt. */
export async function readClineMessageHeader(
  file: FileHandle,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<{ updatedAt?: string; agent: string; sessionId: string }> {
  return readEnvelope(
    new ByteReader(file, 0, signal, 256 * 1024),
    sessionId,
    new Set(),
  );
}

export interface ClineArrayCursor {
  byteOffset: number;
  messageIndex: number;
}
export interface ClineArrayPage {
  values: unknown[];
  next?: ClineArrayCursor;
  indexes: number[];
  complete: boolean;
}
export interface ClineArrayReadOptions {
  format: "sdk-v1" | "legacy-api" | "legacy-history";
  sessionId?: string;
  cursor?: ClineArrayCursor;
  limit?: number;
  signal?: AbortSignal;
  maxValueBytes?: number;
  maxReadBytes?: number;
}

/**
 * Canonical SDK envelope is version/sessionId before messages (official writer).
 * Unknown additive keys are tolerated, duplicate envelope keys are not. Legacy
 * arrays have a separate explicit source-layout gate in the Cline adapter.
 * Cursors are process-private bookmarks issued after parsing a complete value;
 * never accept renderer-provided byte offsets without a trusted registry.
 */
export async function readClineArrayPage(
  file: FileHandle,
  options: ClineArrayReadOptions,
): Promise<ClineArrayPage> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    return fail("CLINE_READ_LIMIT");
  const cap = options.maxValueBytes ?? 2 * 1024 * 1024;
  const budget = options.maxReadBytes ?? 16 * 1024 * 1024;
  let reader = new ByteReader(file, 0, options.signal, budget);
  const seen = new Set<string>();
  if (options.format === "sdk-v1")
    await readEnvelope(reader, options.sessionId, seen);
  else await reader.expect(91);
  if (options.cursor) {
    const { byteOffset, messageIndex } = options.cursor;
    if (
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < reader.offset ||
      !Number.isSafeInteger(messageIndex) ||
      messageIndex < 0
    )
      return fail("CLINE_INVALID_JSON");
    reader = new ByteReader(file, byteOffset, options.signal, budget);
  }
  const values: unknown[] = [],
    indexes: number[] = [];
  let index = options.cursor?.messageIndex ?? 0;
  await reader.skipSpace();
  if ((await reader.peek()) !== 93) {
    for (;;) {
      values.push(await reader.value(cap));
      indexes.push(index++);
      await reader.skipSpace();
      const separator = await reader.peek();
      if (separator === 93) break;
      await reader.expect(44);
      await reader.skipSpace();
      if ((await reader.peek()) === 93) return fail("CLINE_INVALID_JSON");
      if (values.length >= limit)
        return {
          values,
          indexes,
          next: { byteOffset: reader.offset, messageIndex: index },
          complete: false,
        };
    }
  }
  await reader.expect(93);
  if (options.format === "sdk-v1") {
    for (;;) {
      await reader.skipSpace();
      if ((await reader.peek()) === 125) break;
      await reader.expect(44);
      const key = await reader.value(4096);
      if (typeof key !== "string" || seen.has(key))
        return fail("CLINE_INVALID_JSON");
      seen.add(key);
      if (seen.size > 64) return fail("CLINE_READ_LIMIT");
      await reader.expect(58);
      await reader.value(cap);
    }
    await reader.expect(125);
  }
  await reader.skipSpace();
  if ((await reader.peek()) !== -1) return fail("CLINE_INVALID_JSON");
  return { values, indexes, complete: true };
}
