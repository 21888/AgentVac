import { constants, promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type {
  DeepCheckReason,
  DeepCheckResult,
  DiagnosticRoot,
  SqliteMetrics,
} from "./diagnostics.js";
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const safeText = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v) &&
  !v.includes("://");
const validAbsolute = (v: unknown): v is string =>
  safeText(v) && path.isAbsolute(v);
const safeNumber = (n: bigint | number): number | null => {
  const v = Number(n);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
};

// Reject symlinks in every existing ancestor, not only the final component.
async function safePath(p: string, directory = false): Promise<BigIntStats> {
  if (!validAbsolute(p)) throw new Error("UNSAFE_PATH");
  const normalized = path.resolve(p);
  const { root } = path.parse(normalized);
  let current = root;
  for (const component of normalized
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const s = await fs.lstat(current, { bigint: true });
    if (s.isSymbolicLink() || (current !== normalized && !s.isDirectory()))
      throw new Error("UNSAFE_PATH");
  }
  const s = await fs.lstat(normalized, { bigint: true });
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (!directory && s.nlink !== 1n)
  )
    throw new Error("UNSAFE_PATH");
  return s;
}
const identity = (s: BigIntStats) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink]
    .map(String)
    .join(":");
const unsafe = (e: unknown) =>
  e instanceof Error && e.message === "UNSAFE_PATH";

interface Observation {
  database: string;
  sidecars: string[];
}
async function observeDatabase(p: string): Promise<Observation> {
  const database = identity(await safePath(p));
  const sidecars: string[] = [];
  for (const suffix of SIDECARS) {
    try {
      sidecars.push(`${suffix}:${identity(await safePath(p + suffix))}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return { database, sidecars };
}
const sameObservation = (a: Observation, b: Observation) =>
  JSON.stringify(a) === JSON.stringify(b);
const blocked = (
  reason: DeepCheckReason,
  sourceUnchanged?: boolean,
): DeepCheckResult => ({
  status: "blocked",
  reason,
  ...(sourceUnchanged === undefined ? {} : { sourceUnchanged }),
});

const LOG_COLUMNS =
  "id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0";
const MIGRATION_COLUMNS =
  "version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL";
const normalizeSql = (s: string) =>
  s
    .toLowerCase()
    .replace(/if\s+not\s+exists/g, "")
    .replace(/[\s"`\[\];]/g, "");
const KNOWN_SQL = new Map(
  [
    ["logs", `CREATE TABLE logs (${LOG_COLUMNS})`],
    [
      "_sqlx_migrations",
      `CREATE TABLE _sqlx_migrations (${MIGRATION_COLUMNS})`,
    ],
    ["sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)"],
    [
      "idx_logs_ts",
      "CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC)",
    ],
    [
      "idx_logs_thread_id",
      "CREATE INDEX idx_logs_thread_id ON logs(thread_id)",
    ],
    [
      "idx_logs_thread_id_ts",
      "CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC)",
    ],
    [
      "idx_logs_process_uuid_threadless_ts",
      "CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL",
    ],
  ].map(([name, sql]) => [name, normalizeSql(sql)]),
);

function knownSchema(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, CASE WHEN length(sql) <= 20000 THEN sql ELSE NULL END AS sql FROM sqlite_schema LIMIT 17",
    )
    .all();
  if (rows.length !== KNOWN_SQL.size + 1) return false;
  const found = new Set<string>();
  for (const row of rows) {
    if (
      row.name === "sqlite_autoindex__sqlx_migrations_1" &&
      row.type === "index" &&
      row.tbl_name === "_sqlx_migrations" &&
      row.sql === null
    )
      continue;
    if (
      typeof row.name !== "string" ||
      typeof row.sql !== "string" ||
      row.sql.length > 20000 ||
      !KNOWN_SQL.has(row.name)
    )
      return false;
    if (normalizeSql(row.sql) !== KNOWN_SQL.get(row.name)) return false;
    found.add(row.name);
  }
  return found.size === KNOWN_SQL.size;
}

export async function inspectSqliteInWorker(
  p: string,
  roots: DiagnosticRoot[],
  expected?: string,
): Promise<DeepCheckResult> {
  if (
    !validAbsolute(p) ||
    !roots.some(
      (r) => r.kind !== "log-dir" && path.dirname(path.resolve(p)) === r.path,
    )
  )
    return blocked("OUTSIDE_SELECTED_ROOTS");
  if (path.basename(p) !== "logs_2.sqlite") return blocked("NOT_LOGS_DATABASE");
  let before: Observation;
  try {
    before = await observeDatabase(p);
  } catch (e) {
    return blocked(unsafe(e) ? "UNSAFE_PATH" : "DATABASE_UNAVAILABLE");
  }
  if (expected !== undefined && expected !== before.database)
    return blocked("SOURCE_CHANGED", false);
  // More conservative than checking WAL length: even zero-length or stale sidecars
  // are an ambiguous writer/recovery state. Immutable must never ignore a live WAL.
  if (before.sidecars.length) return blocked("SIDECARS_PRESENT");
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    if (!sameObservation(before, await observeDatabase(p)))
      return blocked("SOURCE_CHANGED", false);
  } catch {
    return blocked("SOURCE_CHANGED", false);
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let sourceWalHeader = false;
  try {
    handle = await fs.open(
      p,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    if (identity(await handle.stat({ bigint: true })) !== before.database)
      return blocked("SOURCE_CHANGED", false);
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead < 100 ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    )
      return blocked("NOT_SQLITE");
    sourceWalHeader = header[18] === 2 && header[19] === 2;
  } catch {
    return blocked("READ_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return blocked("SQLITE_UNAVAILABLE", true);
  }
  let probe: DatabaseSync | undefined;
  try {
    // A URI string is intentional: a URL object may lose query parameters in
    // some Node versions. readOnly prevents literal-path fallback file creation.
    probe = new sqlite.DatabaseSync("file::memory:?mode=memory&cache=private", {
      readOnly: true,
    });
    const list = probe.prepare("PRAGMA database_list").all();
    if (list.length !== 1 || list[0].file !== "")
      return blocked("IMMUTABLE_OPEN_UNAVAILABLE", true);
  } catch {
    return blocked("IMMUTABLE_OPEN_UNAVAILABLE", true);
  } finally {
    probe?.close();
  }
  let db: DatabaseSync | undefined;
  let answer: DeepCheckResult = blocked("READ_FAILED");
  try {
    if (!sameObservation(before, await observeDatabase(p)))
      return blocked("SOURCE_CHANGED", false);
    const uri = pathToFileURL(path.resolve(p));
    uri.searchParams.set("mode", "ro");
    uri.searchParams.set("immutable", "1");
    // SQLite immutable=1 disables filesystem writes/locking/recovery. Plain
    // readOnly=true is insufficient: it can create WAL/SHM even during PRAGMAs.
    db = new sqlite.DatabaseSync(uri.href, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    const opened = db.prepare("PRAGMA database_list").all();
    if (
      opened.length !== 1 ||
      typeof opened[0].file !== "string" ||
      path.resolve(opened[0].file) !== path.resolve(p)
    )
      answer = blocked("IMMUTABLE_OPEN_UNAVAILABLE");
    else if (!knownSchema(db)) answer = blocked("UNKNOWN_SCHEMA");
    else {
      const integer = (name: string) => {
        const row = db!.prepare(`PRAGMA ${name}`).get();
        const value = row ? Object.values(row)[0] : undefined;
        if (typeof value !== "number" || safeNumber(value) === null)
          throw new Error("READ_FAILED");
        return value;
      };
      const pageSize = integer("page_size"),
        pageCount = integer("page_count"),
        freelistCount = integer("freelist_count"),
        mode = integer("auto_vacuum");
      const journalMode = Object.values(
        db.prepare("PRAGMA journal_mode").get() ?? {},
      )[0];
      if (
        mode > 2 ||
        freelistCount > pageCount ||
        pageSize < 512 ||
        pageSize > 65536 ||
        !Number.isInteger(Math.log2(pageSize)) ||
        safeNumber(pageSize * pageCount) === null ||
        typeof journalMode !== "string" ||
        !["delete", "truncate", "persist", "memory", "wal", "off"].includes(
          journalMode,
        )
      )
        throw new Error("READ_FAILED");
      answer = {
        status: "ok",
        schema: "codex-logs-v2",
        consistency: "stable-file-observations",
        metrics: {
          pageSize,
          pageCount,
          freelistCount,
          freePageBytes: freelistCount * pageSize,
          occupiedPageBytes: (pageCount - freelistCount) * pageSize,
          autoVacuum: (["none", "full", "incremental"] as const)[mode],
          journalMode: sourceWalHeader
            ? "wal"
            : (journalMode as SqliteMetrics["journalMode"]),
        },
      };
    }
  } catch {
    answer = blocked("READ_FAILED");
  } finally {
    try {
      db?.close();
    } catch {
      answer = blocked("READ_FAILED");
    }
  }
  try {
    if (!sameObservation(before, await observeDatabase(p)))
      return blocked("SOURCE_CHANGED", false);
    return { ...answer, sourceUnchanged: true };
  } catch {
    return blocked("SOURCE_CHANGED", false);
  }
}
