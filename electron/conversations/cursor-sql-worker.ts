/** Isolated SQLite parser. Only receives a private snapshot path, never a source root. */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const MAX_VALUE = 8 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_HEADERS = 40_000;
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;
const decode = (v: unknown): Record<string, unknown> | null => {
  try {
    const s =
      typeof v === "string"
        ? v
        : v instanceof Uint8Array
          ? new TextDecoder("utf-8", { fatal: true }).decode(v)
          : "";
    if (Buffer.byteLength(s) > MAX_VALUE) return null;
    const parsed: unknown = JSON.parse(s);
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const time = (v: unknown): string | null => {
  if (
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= 946684800000 &&
    v <= 4133980800000
  )
    return new Date(v).toISOString();
  if (typeof v === "string") {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
        v,
      );
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match
      .slice(1, 7)
      .map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 2000 ||
      year > 2100 ||
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      Number(match[8] ?? 0) > 23 ||
      Number(match[9] ?? 0) > 59
    )
      return null;
    const n = Date.parse(v);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  return null;
};
let db: DatabaseSync | undefined;
try {
  const request = workerData as {
    path: string;
    mode: "list" | "headers" | "read" | "workspace-index";
    after?: string;
    composerId?: string;
    offset?: number;
    textOffset?: number;
    limit: number;
  };
  db = new DatabaseSync(request.path, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 0,
  });
  db.exec(
    "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA mmap_size=0; PRAGMA cache_size=-4096",
  );
  const table = (name: string, columns: string[]) => {
    const schema = db!
      .prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?")
      .get(name);
    if (
      !schema ||
      schema.type !== "table" ||
      typeof schema.sql !== "string" ||
      /\bVIRTUAL\b/i.test(schema.sql)
    )
      return false;
    const info = db!.prepare(`PRAGMA table_xinfo('${name}')`).all();
    return (
      info.length <= 32 &&
      columns.every((c) => info.some((r) => r.name === c && r.hidden === 0))
    );
  };
  const kv = table("cursorDiskKV", ["key", "value"]);
  const headers = table("composerHeaders", ["composerId", "value"]);
  const workspaceIndex =
    request.mode === "workspace-index" && table("ItemTable", ["key", "value"]);
  if (!kv && !headers && !workspaceIndex)
    throw new Error("CURSOR_UNSUPPORTED_SCHEMA");
  const hasUnique = (name: string, column: string) => {
    const primary = db!
      .prepare(`PRAGMA table_info('${name}')`)
      .all()
      .filter((r) => typeof r.pk === "number" && r.pk > 0);
    if (primary.length === 1 && primary[0].name === column) return true;
    return db!
      .prepare(`PRAGMA index_list('${name}')`)
      .all()
      .some((r) => {
        if (
          r.unique !== 1 ||
          r.partial !== 0 ||
          typeof r.name !== "string" ||
          !/^[A-Za-z0-9_]+$/.test(r.name)
        )
          return false;
        const info = db!.prepare(`PRAGMA index_info('${r.name}')`).all();
        return info.length === 1 && info[0].name === column;
      });
  };
  if (
    (kv && !hasUnique("cursorDiskKV", "key")) ||
    (headers && !hasUnique("composerHeaders", "composerId"))
  )
    throw new Error("CURSOR_UNSUPPORTED_SCHEMA");
  if (request.mode === "workspace-index") {
    if (!workspaceIndex || !hasUnique("ItemTable", "key"))
      throw new Error("CURSOR_UNSUPPORTED_SCHEMA");
    const row = db
      .prepare(
        "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value FROM ItemTable WHERE key = 'composer.composerData'",
      )
      .get(MAX_VALUE);
    const index = decode(row?.value);
    if (
      row &&
      (!index ||
        !Array.isArray(index.allComposers) ||
        index.allComposers.length > MAX_HEADERS ||
        !index.allComposers.every((r) => object(r) && id(r.composerId)))
    )
      throw new Error("CURSOR_UNSUPPORTED_WORKSPACE_INDEX");
    parentPort?.postMessage({
      ok: true,
      composerIds: Array.isArray(index?.allComposers)
        ? index.allComposers.map((r) => r.composerId)
        : [],
      indexOnly: !kv && !headers,
    });
    db.close();
    db = undefined;
    process.exit(0);
  }
  const getKV = (key: string) =>
    kv
      ? db!
          .prepare(
            "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value, length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key = ?",
          )
          .get(MAX_VALUE, key)
      : undefined;
  const getHeader = (composerId: string) =>
    headers
      ? decode(
          db!
            .prepare(
              "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value FROM composerHeaders WHERE composerId = ?",
            )
            .get(MAX_VALUE, composerId)?.value,
        )
      : null;
  const summary = (
    composerId: string,
    data: Record<string, unknown> | null,
    bytes: number,
  ) => {
    const h = getHeader(composerId);
    const record = data ?? h;
    if (
      !record ||
      (record.composerId !== undefined && record.composerId !== composerId) ||
      (h?.composerId !== undefined && h.composerId !== composerId)
    )
      return null;
    const title =
      text(record.name, 300)?.trim() ||
      text(h?.name, 300)?.trim() ||
      composerId;
    const createdAt = time(record.createdAt) ?? time(h?.createdAt);
    const updatedAt = time(record.lastUpdatedAt) ?? time(h?.lastUpdatedAt);
    const refs = data?.fullConversationHeadersOnly;
    const validRefs =
      Array.isArray(refs) &&
      refs.length <= MAX_HEADERS &&
      refs.every((r) => object(r) && id(r.bubbleId)) &&
      new Set(refs.map((r) => r.bubbleId)).size === refs.length;
    const warnings: string[] = [];
    let payloadBytes = bytes;
    if (validRefs && kv) {
      const size = db!.prepare(
        "SELECT length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key = ?",
      );
      for (const ref of refs) {
        const n = size.get(`bubbleId:${composerId}:${ref.bubbleId}`)?.bytes;
        if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
          payloadBytes += n;
      }
    }
    warnings.push(
      "Displayed bytes cover recognized metadata and referenced message payloads only; shared storage and reclaimable disk space are not included.",
    );
    if (
      (typeof record.name === "string" && record.name.length > 300) ||
      (typeof h?.name === "string" && h.name.length > 300)
    )
      warnings.push("The native title exceeds the title-preview limit.");
    if (!createdAt && !updatedAt)
      warnings.push(
        "Cursor did not provide a supported native conversation timestamp.",
      );
    if (!data)
      warnings.push(
        "Only a conversation index entry is available; message storage is missing or unsupported.",
      );
    else if (!validRefs)
      warnings.push(
        "This conversation has an unsupported message-reference layout; use Cursor's native transcript export.",
      );
    if (
      record.isArchived === true ||
      record.isArchived === 1 ||
      h?.isArchived === true ||
      h?.isArchived === 1
    )
      warnings.push("Cursor marks this conversation as archived.");
    if (record.isDeleted === true || record.deletedAt != null)
      warnings.push(
        "A deletion marker is present; this record is read-only and may be incomplete.",
      );
    return {
      composerId,
      title,
      titleSource: title === composerId ? "identifier" : "native",
      createdAt,
      updatedAt,
      timeSource: createdAt || updatedAt ? "native" : "unknown",
      createdAtSource: createdAt ? "native" : "unknown",
      updatedAtSource: updatedAt ? "native" : "unknown",
      messageCount: validRefs ? refs.length : null,
      sizeBytes: payloadBytes,
      identityVerified: !!data && data.composerId === composerId,
      warnings,
    };
  };
  const limit = Math.max(
    1,
    Math.min(100, Number.isInteger(request.limit) ? request.limit : 50),
  );
  if (request.mode === "list" || request.mode === "headers") {
    const mode = request.mode;
    if ((mode === "list" && !kv) || (mode === "headers" && !headers))
      parentPort?.postMessage({
        ok: true,
        items: [],
        next: null,
        warnings: [],
      });
    else {
      const rows =
        mode === "list"
          ? db
              .prepare(
                "SELECT key, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value, length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND key > ? ORDER BY key LIMIT ?",
              )
              .all(MAX_VALUE, request.after ?? "", limit + 1)
          : db
              .prepare(
                `SELECT composerId AS key, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value, length(CAST(value AS BLOB)) AS bytes FROM composerHeaders WHERE composerId > ? ${kv ? "AND NOT EXISTS (SELECT 1 FROM cursorDiskKV WHERE key = 'composerData:' || composerHeaders.composerId)" : ""} ORDER BY composerId LIMIT ?`,
              )
              .all(MAX_VALUE, request.after ?? "", limit + 1);
      const items: unknown[] = [],
        warnings: string[] = [];
      for (const row of rows.slice(0, limit)) {
        const composerId =
          mode === "list" && typeof row.key === "string"
            ? row.key.slice(13)
            : row.key;
        if (!id(composerId)) {
          warnings.push("An unsupported conversation identifier was skipped.");
          continue;
        }
        const data = decode(row.value);
        if (!data) {
          warnings.push(
            "An oversized or malformed conversation record was skipped.",
          );
          continue;
        }
        const item = summary(
          composerId,
          mode === "list" ? data : null,
          Number(row.bytes) || 0,
        );
        if (item) items.push(item);
        else warnings.push("A conversation identity mismatch was skipped.");
      }
      parentPort?.postMessage({
        ok: true,
        items,
        next: rows.length > limit ? rows[limit - 1].key : null,
        warnings: [...new Set(warnings)],
      });
    }
  } else if (request.mode === "read" && id(request.composerId)) {
    const data = decode(getKV(`composerData:${request.composerId}`)?.value);
    if (!data || data.composerId !== request.composerId)
      throw new Error("CURSOR_CONTENT_UNAVAILABLE");
    const refs = data.fullConversationHeadersOnly;
    if (
      !Array.isArray(refs) ||
      refs.length > MAX_HEADERS ||
      !refs.every((r) => object(r) && id(r.bubbleId)) ||
      new Set(refs.map((r) => r.bubbleId)).size !== refs.length
    )
      throw new Error("CURSOR_UNSUPPORTED_MESSAGE_LAYOUT");
    const offset = request.offset ?? 0;
    const textOffset = request.textOffset ?? 0;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > refs.length ||
      !Number.isSafeInteger(textOffset) ||
      textOffset < 0
    )
      throw new Error("CURSOR_INVALID_CURSOR");
    const messages = [],
      warnings: string[] = [];
    let end = offset,
      outputBytes = 0;
    let continuationCursor: { index: number; textOffset: number } | undefined;
    for (const ref of refs.slice(offset, offset + limit)) {
      const raw = getKV(`bubbleId:${request.composerId}:${ref.bubbleId}`);
      const bubble = decode(raw?.value);
      const parts: { type: string; text: string }[] = [];
      const segmentStart = end === offset ? textOffset : 0;
      let segmentEnd = 0,
        hasMore = false;
      const rawText = typeof bubble?.text === "string" ? bubble.text : "";
      if (segmentStart > rawText.length)
        throw new Error("CURSOR_INVALID_CURSOR");
      if (
        !bubble ||
        bubble.bubbleId !== ref.bubbleId ||
        (bubble.composerId !== undefined &&
          bubble.composerId !== request.composerId)
      ) {
        parts.push({
          type: "notice",
          text: "This referenced message is missing, oversized, or has an unsupported identity.",
        });
        warnings.push("Some referenced messages could not be read.");
      } else {
        if (typeof bubble.text === "string" && bubble.text) {
          segmentEnd = Math.min(bubble.text.length, segmentStart + MAX_TEXT);
          // Do not split a UTF-16 surrogate pair across pages.
          if (
            segmentEnd < bubble.text.length &&
            /[\uD800-\uDBFF]/.test(bubble.text[segmentEnd - 1])
          )
            segmentEnd--;
          hasMore = segmentEnd < bubble.text.length;
          parts.push({
            type: "text",
            text: bubble.text.slice(segmentStart, segmentEnd),
          });
        }
        if (
          !hasMore &&
          (bubble.richText ||
            bubble.toolFormerData ||
            bubble.images ||
            bubble.attachedCodeChunks ||
            bubble.thinking)
        ) {
          parts.push({
            type: "notice",
            text: "Additional rich, tool, attachment, or reasoning data is present. Only supported plain text is displayed; no embedded content is executed or fetched.",
          });
          warnings.push("Rich or tool payloads may not be fully represented.");
        }
        if (!parts.length)
          parts.push({
            type: "notice",
            text: "No supported plain-text content is stored in this message.",
          });
      }
      const segmented = hasMore || segmentStart > 0;
      const message = {
        id: segmented
          ? `${ref.bubbleId}:segment:${segmentStart}`
          : ref.bubbleId,
        role:
          bubble?.type === 1
            ? "user"
            : bubble?.type === 2
              ? "assistant"
              : "unknown",
        timestamp: time(bubble?.createdAt),
        parts,
        source: {
          kind:
            data.isSubagent === true ||
            data.isSubagent === 1 ||
            object(data.subagentInfo)
              ? "subagent"
              : "main",
          label: "Cursor native message",
          id: ref.bubbleId,
        },
        ...(segmented
          ? {
              continuation: {
                messageId: ref.bubbleId,
                partIndex: 0,
                offset: segmentStart,
                hasMore,
              },
            }
          : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(message));
      if (messages.length && outputBytes + size > 1024 * 1024) break;
      outputBytes += size;
      messages.push(message);
      if (hasMore) {
        continuationCursor = { index: end, textOffset: segmentEnd };
        break;
      }
      end++;
    }
    if (!refs.length)
      warnings.push(
        "The native message-reference list is empty; no orphan rows were guessed into the conversation.",
      );
    parentPort?.postMessage({
      ok: true,
      messages,
      next: continuationCursor ?? (end < refs.length ? end : null),
      partial: warnings.length > 0,
      warnings: [...new Set(warnings)],
    });
  } else throw new Error("CURSOR_INVALID_REQUEST");
} catch (error) {
  const code =
    error instanceof Error && /^CURSOR_[A-Z_]+$/.test(error.message)
      ? error.message
      : "CURSOR_DATABASE_READ_FAILED";
  parentPort?.postMessage({ ok: false, code });
} finally {
  try {
    db?.close();
  } catch {}
}
