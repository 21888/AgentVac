import { constants, promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import {
  runDiagnosticProcess,
  shutdownDiagnosticWorkers,
} from "./diagnostic-process.js";
export { shutdownDiagnosticWorkers };

/** This module never discovers process.env/os.homedir implicitly or starts Codex. */
export type DiagnosticRootKind = "codex-home" | "sqlite-home" | "log-dir";
export interface DiagnosticRoot {
  path: string;
  kind: DiagnosticRootKind;
}
export interface DiagnosticCandidate extends DiagnosticRoot {
  source:
    | "default"
    | "CODEX_HOME"
    | "CODEX_SQLITE_HOME"
    | "config.sqlite_home"
    | "config.log_dir";
}
export interface CandidateInputs {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}
export type DiagnosticFileKind =
  "sqlite" | "wal" | "shm" | "journal" | "ordinary-log";
export interface DiagnosticFile {
  path: string;
  root: string;
  kind: DiagnosticFileKind;
  bytes: number;
  allocatedBytes: number | null;
  mtimeMs: number;
}
export interface VolumeObservation {
  root: string;
  sampledAt: string;
  observational: true;
  availableBytes: number | null;
  totalBytes: number | null;
  reason?: "VOLUME_SAMPLE_UNAVAILABLE";
}
export type DiagnosticWarning =
  | "INVALID_ROOT"
  | "ROOT_UNAVAILABLE"
  | "UNSAFE_PATH"
  | "ENTRY_UNAVAILABLE"
  | "FILE_LIMIT_REACHED"
  | "CONFIG_UNAVAILABLE"
  | "CONFIG_TOO_LARGE"
  | "CONFIG_CHANGED"
  | "CONFIG_PATH_UNSUPPORTED"
  | "CONFIG_FORMAT_UNSUPPORTED";
export type DeepCheckReason =
  | "NOT_ENABLED"
  | "OUTSIDE_SELECTED_ROOTS"
  | "NOT_LOGS_DATABASE"
  | "UNSAFE_PATH"
  | "DATABASE_UNAVAILABLE"
  | "SIDECARS_PRESENT"
  | "SOURCE_CHANGED"
  | "NOT_SQLITE"
  | "UNKNOWN_SCHEMA"
  | "SQLITE_UNAVAILABLE"
  | "IMMUTABLE_OPEN_UNAVAILABLE"
  | "READ_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "WORKER_FAILED"
  | "WORKER_PROTOCOL_INVALID"
  | "PROCESS_ISOLATION_UNAVAILABLE";
export interface SqliteMetrics {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  freePageBytes: number;
  occupiedPageBytes: number;
  autoVacuum: "none" | "full" | "incremental";
  journalMode: "delete" | "truncate" | "persist" | "memory" | "wal" | "off";
}
export interface DeepCheckResult {
  status: "disabled" | "blocked" | "ok";
  reason?: DeepCheckReason;
  schema?: "codex-logs-v2";
  metrics?: SqliteMetrics;
  /** Stable observations do not prove another process cannot start writing later. */
  consistency?: "stable-file-observations";
  /** Identity/size/time/sidecar comparison only; never a full source-content hash. */
  sourceUnchanged?: boolean;
}
export interface StorageDiagnosticOptions {
  roots: DiagnosticRoot[];
  configOptIn?: boolean;
  deepCheck?: { enabled: boolean; databasePath: string };
}
/** Main-process controls. Never deserialize these from renderer input. */
export interface DiagnosticRuntime {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface StorageDiagnostics {
  sampledAt: string;
  roots: DiagnosticRoot[];
  files: DiagnosticFile[];
  totals: Record<DiagnosticFileKind, number>;
  volumes: VolumeObservation[];
  configHints: DiagnosticCandidate[];
  warnings: DiagnosticWarning[];
  deepCheck: DeepCheckResult;
  /** No mutation, cleanup approval, or guaranteed reclaim estimate is represented here. */
  observational: true;
}

const MAX_ROOTS = 8;
const MAX_FILES = 5000;
const MAX_CONFIG_BYTES = 64 * 1024;
const KINDS = new Set<DiagnosticRootKind>([
  "codex-home",
  "sqlite-home",
  "log-dir",
]);
const ROOT_FILE =
  /^([A-Za-z][A-Za-z0-9_-]*\.(?:sqlite|sqlite3|db))(?:(-wal|-shm|-journal))?$/;
const LOG_FILE = /^[A-Za-z0-9_.-]+\.log(?:\.[A-Za-z0-9_.-]+)?(?:\.gz)?$/;
const safeText = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v) &&
  !v.includes("://");
const validAbsolute = (v: unknown): v is string =>
  safeText(v) && path.isAbsolute(v);
/** JSON-safe identity helper: file IDs first, platform-normalized paths otherwise. */
export function diagnosticFileKey(
  filePath: string,
  identity: { dev?: string; ino?: string },
  platform: string = process.platform,
): string {
  if (
    /^\d{1,20}$/.test(identity.dev ?? "") &&
    /^\d{1,20}$/.test(identity.ino ?? "") &&
    BigInt(identity.ino!) > 0n
  )
    return `file:${identity.dev}:${identity.ino}`;
  return `path:${platform === "win32" ? path.win32.resolve(filePath).toLowerCase() : path.resolve(filePath)}`;
}
const safeNumber = (n: bigint | number): number | null => {
  const v = Number(n);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
};

/** Candidate discovery is pure. Returned paths still require explicit selection. */
export function discoverDiagnosticCandidates(
  input: CandidateInputs,
): DiagnosticCandidate[] {
  const out: DiagnosticCandidate[] = [];
  if (validAbsolute(input.home))
    out.push({
      path: path.join(input.home, ".codex"),
      kind: "codex-home",
      source: "default",
    });
  for (const [key, kind] of [
    ["CODEX_HOME", "codex-home"],
    ["CODEX_SQLITE_HOME", "sqlite-home"],
  ] as const) {
    const raw = input.env[key]?.trim();
    if (!safeText(raw)) continue;
    const resolved = path.isAbsolute(raw)
      ? path.normalize(raw)
      : validAbsolute(input.cwd)
        ? path.resolve(input.cwd, raw)
        : null;
    if (resolved) out.push({ path: resolved, kind, source: key });
  }
  return out;
}

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

async function inspectConfig(
  root: string,
): Promise<{ hints: DiagnosticCandidate[]; warnings: DiagnosticWarning[] }> {
  const hints: DiagnosticCandidate[] = [];
  const warnings: DiagnosticWarning[] = [];
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const p = path.join(root, "config.toml");
    const before = await safePath(p);
    if (before.size > BigInt(MAX_CONFIG_BYTES))
      return { hints, warnings: ["CONFIG_TOO_LARGE"] };
    handle = await fs.open(
      p,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    if (identity(await handle.stat({ bigint: true })) !== identity(before))
      return { hints, warnings: ["CONFIG_CHANGED"] };
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > MAX_CONFIG_BYTES)
      return { hints, warnings: ["CONFIG_TOO_LARGE"] };
    const text = buffer.subarray(0, read.bytesRead).toString("utf8");
    // Deliberately restricted extraction, not a TOML/config resolver. Do not parse
    // or return credentials, profiles, includes, sections, errors, or raw lines.
    // Never mistake the contents of a multiline value for top-level assignments.
    // Profiles/quoted keys/other complex forms require the real Codex resolver.
    if (
      /"""|'''|^\s*\[\[|^\s*\[\s*profiles(?:\.|\])|^\s*profile\s*=|^\s*["'](?:sqlite_home|log_dir)["']\s*=/m.test(
        text,
      )
    )
      return { hints, warnings: ["CONFIG_FORMAT_UNSUPPORTED"] };
    if (
      text
        .split(/\r?\n/)
        .some(
          (line) =>
            /^\s*\[/.test(line) &&
            !/^\s*\[[A-Za-z0-9_.-]+\]\s*(?:#.*)?$/.test(line),
        )
    )
      return { hints, warnings: ["CONFIG_FORMAT_UNSUPPORTED"] };
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const key = /^\s*(sqlite_home|log_dir)\s*=/.exec(line)?.[1];
      if (!key) continue;
      const match =
        /^\s*(sqlite_home|log_dir)\s*=\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*(?:#.*)?$/.exec(
          line,
        );
      if (!match || seen.has(key)) {
        warnings.push("CONFIG_FORMAT_UNSUPPORTED");
        continue;
      }
      seen.add(key);
      let value: unknown;
      try {
        value = match[2].startsWith("'")
          ? match[2].slice(1, -1)
          : JSON.parse(match[2]);
      } catch {
        warnings.push("CONFIG_FORMAT_UNSUPPORTED");
        continue;
      }
      // Relative/TOML multiline paths require the full Codex resolver; don't guess.
      if (!validAbsolute(value)) {
        warnings.push("CONFIG_PATH_UNSUPPORTED");
        continue;
      }
      hints.push({
        path: path.normalize(value),
        kind: key === "sqlite_home" ? "sqlite-home" : "log-dir",
        source: key === "sqlite_home" ? "config.sqlite_home" : "config.log_dir",
      });
    }
    if (
      identity(await safePath(p)) !== identity(before) ||
      identity(await handle.stat({ bigint: true })) !== identity(before)
    )
      return { hints: [], warnings: ["CONFIG_CHANGED"] };
    // Ambiguous duplicate/unsupported syntax means no inferred config destinations.
    return {
      hints: warnings.includes("CONFIG_FORMAT_UNSUPPORTED") ? [] : hints,
      warnings,
    };
  } catch {
    return { hints: [], warnings: ["CONFIG_UNAVAILABLE"] };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function classifyFile(
  name: string,
  ordinary: boolean,
): DiagnosticFileKind | null {
  const db = ROOT_FILE.exec(name);
  if (db)
    return db[2] === "-wal"
      ? "wal"
      : db[2] === "-shm"
        ? "shm"
        : db[2] === "-journal"
          ? "journal"
          : "sqlite";
  return ordinary && LOG_FILE.test(name) ? "ordinary-log" : null;
}

async function volume(root: string): Promise<VolumeObservation> {
  const base = {
    root,
    sampledAt: new Date().toISOString(),
    observational: true as const,
  };
  try {
    const v = await fs.statfs(root, { bigint: true });
    return {
      ...base,
      availableBytes: safeNumber(v.bavail * v.bsize),
      totalBytes: safeNumber(v.blocks * v.bsize),
    };
  } catch {
    return {
      ...base,
      availableBytes: null,
      totalBytes: null,
      reason: "VOLUME_SAMPLE_UNAVAILABLE",
    };
  }
}

/** Bounded metadata inventory. Never recurses into sessions, credentials or projects. */
export async function diagnoseStorage(
  options: StorageDiagnosticOptions,
  runtime: DiagnosticRuntime = {},
): Promise<StorageDiagnostics> {
  const result: StorageDiagnostics = {
    sampledAt: new Date().toISOString(),
    roots: [],
    files: [],
    totals: { sqlite: 0, wal: 0, shm: 0, journal: 0, "ordinary-log": 0 },
    volumes: [],
    configHints: [],
    warnings: [],
    observational: true,
    deepCheck: { status: "disabled", reason: "NOT_ENABLED" },
  };
  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  const roots = Array.isArray(options.roots) ? options.roots : [];
  if (roots.length > MAX_ROOTS) result.warnings.push("INVALID_ROOT");
  for (const root of roots.slice(0, MAX_ROOTS)) {
    if (!root || !KINDS.has(root.kind) || !validAbsolute(root.path)) {
      result.warnings.push("INVALID_ROOT");
      continue;
    }
    const selected = { path: path.resolve(root.path), kind: root.kind };
    const key = `${selected.kind}:${selected.path}`;
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    try {
      await safePath(selected.path, true);
    } catch (e) {
      result.warnings.push(unsafe(e) ? "UNSAFE_PATH" : "ROOT_UNAVAILABLE");
      continue;
    }
    result.roots.push(selected);
    result.volumes.push(await volume(selected.path));
    const dirs = [
      { path: selected.path, ordinary: selected.kind === "log-dir" },
    ];
    if (selected.kind === "codex-home")
      dirs.push({ path: path.join(selected.path, "log"), ordinary: true });
    for (const dir of dirs) {
      try {
        await safePath(dir.path, true);
        const stream = await fs.opendir(dir.path);
        let examined = 0;
        for await (const entry of stream) {
          if (++examined > MAX_FILES || result.files.length >= MAX_FILES) {
            result.warnings.push("FILE_LIMIT_REACHED");
            break;
          }
          const kind = classifyFile(entry.name, dir.ordinary);
          if (!kind) continue;
          const p = path.join(dir.path, entry.name);
          try {
            const s = await safePath(p);
            const fileKey = diagnosticFileKey(p, {
              dev: String(s.dev),
              ino: String(s.ino),
            });
            if (seenFiles.has(fileKey)) continue;
            const bytes = safeNumber(s.size);
            if (bytes === null) {
              result.warnings.push("ENTRY_UNAVAILABLE");
              continue;
            }
            seenFiles.add(fileKey);
            result.files.push({
              path: p,
              root: selected.path,
              kind,
              bytes,
              allocatedBytes:
                process.platform === "win32" || typeof s.blocks !== "bigint"
                  ? null
                  : safeNumber(s.blocks * 512n),
              mtimeMs: Number(s.mtimeNs) / 1e6,
            });
            result.totals[kind] += bytes;
          } catch (e) {
            result.warnings.push(
              unsafe(e) ? "UNSAFE_PATH" : "ENTRY_UNAVAILABLE",
            );
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          result.warnings.push(unsafe(e) ? "UNSAFE_PATH" : "ENTRY_UNAVAILABLE");
      }
    }
    if (options.configOptIn === true && selected.kind === "codex-home") {
      const config = await inspectConfig(selected.path);
      result.configHints.push(...config.hints);
      result.warnings.push(...config.warnings);
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  if (options.deepCheck?.enabled === true)
    result.deepCheck = await inspectSqlite(
      options.deepCheck.databasePath,
      result.roots,
      runtime,
    );
  result.warnings = [...new Set(result.warnings)];
  return result;
}

async function inspectSqlite(
  p: string,
  roots: DiagnosticRoot[],
  runtime: DiagnosticRuntime,
): Promise<DeepCheckResult> {
  const blocked = (reason: DeepCheckReason): DeepCheckResult => ({
    status: "blocked",
    reason,
  });
  if (runtime.signal?.aborted) return blocked("CANCELLED");
  if (
    !validAbsolute(p) ||
    !roots.some(
      (r) => r.kind !== "log-dir" && path.dirname(path.resolve(p)) === r.path,
    )
  )
    return blocked("OUTSIDE_SELECTED_ROOTS");
  if (path.basename(p) !== "logs_2.sqlite") return blocked("NOT_LOGS_DATABASE");
  let expected: string;
  try {
    expected = identity(await safePath(p));
  } catch (e) {
    return blocked(unsafe(e) ? "UNSAFE_PATH" : "DATABASE_UNAVAILABLE");
  }
  return runDiagnosticProcess({ databasePath: p, expected }, runtime);
}
