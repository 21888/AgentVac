import type { DeepCheckResult } from "./diagnostics.js";

export const MAX_DIAGNOSTIC_OUTPUT = 8192;
export const MAX_DIAGNOSTIC_REQUEST = 8192;
export const DEFAULT_DIAGNOSTIC_TIMEOUT = 5000;
export const HEARTBEAT_INTERVAL = 250;
export const HEARTBEAT_DEADLINE = 2000;
export interface DiagnosticRequest {
  databasePath: string;
  expected: string;
}
const reasons = new Set([
  "NOT_ENABLED",
  "OUTSIDE_SELECTED_ROOTS",
  "NOT_LOGS_DATABASE",
  "UNSAFE_PATH",
  "DATABASE_UNAVAILABLE",
  "SIDECARS_PRESENT",
  "SOURCE_CHANGED",
  "NOT_SQLITE",
  "UNKNOWN_SCHEMA",
  "SQLITE_UNAVAILABLE",
  "IMMUTABLE_OPEN_UNAVAILABLE",
  "READ_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "WORKER_FAILED",
  "WORKER_PROTOCOL_INVALID",
  "PROCESS_ISOLATION_UNAVAILABLE",
]);
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).every((k) => names.includes(k));
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Validate and reconstruct, never relay arbitrary worker fields/SQL/error strings. */
export function validateDiagnosticResult(v: unknown): DeepCheckResult | null {
  if (!object(v)) return null;
  if (v.status === "blocked") {
    if (
      !keys(v, ["status", "reason", "sourceUnchanged"]) ||
      typeof v.reason !== "string" ||
      !reasons.has(v.reason) ||
      (v.sourceUnchanged !== undefined &&
        typeof v.sourceUnchanged !== "boolean")
    )
      return null;
    return {
      status: "blocked",
      reason: v.reason as DeepCheckResult["reason"],
      ...(typeof v.sourceUnchanged === "boolean"
        ? { sourceUnchanged: v.sourceUnchanged }
        : {}),
    };
  }
  if (
    v.status !== "ok" ||
    !keys(v, [
      "status",
      "schema",
      "metrics",
      "consistency",
      "sourceUnchanged",
    ]) ||
    v.schema !== "codex-logs-v2" ||
    v.consistency !== "stable-file-observations" ||
    v.sourceUnchanged !== true ||
    !object(v.metrics)
  )
    return null;
  const m = v.metrics;
  if (
    !keys(m, [
      "pageSize",
      "pageCount",
      "freelistCount",
      "freePageBytes",
      "occupiedPageBytes",
      "autoVacuum",
      "journalMode",
    ]) ||
    !integer(m.pageSize) ||
    m.pageSize < 512 ||
    m.pageSize > 65536 ||
    !Number.isInteger(Math.log2(m.pageSize)) ||
    !integer(m.pageCount) ||
    !integer(m.freelistCount) ||
    m.freelistCount > m.pageCount ||
    !integer(m.freePageBytes) ||
    !integer(m.occupiedPageBytes) ||
    !integer(m.pageCount * m.pageSize) ||
    m.freePageBytes !== m.freelistCount * m.pageSize ||
    m.occupiedPageBytes !== (m.pageCount - m.freelistCount) * m.pageSize ||
    typeof m.autoVacuum !== "string" ||
    !["none", "full", "incremental"].includes(m.autoVacuum) ||
    typeof m.journalMode !== "string" ||
    !["delete", "truncate", "persist", "memory", "wal", "off"].includes(
      m.journalMode,
    )
  )
    return null;
  return {
    status: "ok",
    schema: "codex-logs-v2",
    consistency: "stable-file-observations",
    sourceUnchanged: true,
    metrics: {
      pageSize: m.pageSize,
      pageCount: m.pageCount,
      freelistCount: m.freelistCount,
      freePageBytes: m.freePageBytes,
      occupiedPageBytes: m.occupiedPageBytes,
      autoVacuum: m.autoVacuum as "none" | "full" | "incremental",
      journalMode: m.journalMode as
        "delete" | "truncate" | "persist" | "memory" | "wal" | "off",
    },
  };
}
export function parseDiagnosticResult(text: string): DeepCheckResult | null {
  try {
    return validateDiagnosticResult(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Minimal OS bootstrap environment. Never inherit credentials or loader options. */
export function diagnosticEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return env;
}
