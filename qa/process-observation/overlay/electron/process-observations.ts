import path from "node:path";
import { constants, promises as fs } from "node:fs";
import type { ProviderId } from "../shared/types.js";

const stages = [
  "windows-enumeration",
  "windows-parse",
  "posix-names",
  "posix-commands",
  "posix-parse-names",
  "posix-parse-commands",
  "posix-reconcile",
  "linux-arguments",
  "snapshot",
  "stable-attempt",
  "stable-result",
  "provider-result",
] as const;
const outcomes = [
  "complete",
  "incomplete",
  "invalid-data",
  "unsupported",
  "command-failed",
  "command-terminated",
  "timeout",
  "cancelled",
  "truncated",
  "clear",
  "running",
  "unknown",
] as const;
const operations = [
  "preview",
  "quarantine",
  "restore",
  "prepare-trash",
  "trash",
  "diagnose-storage",
  "scan",
  "startup",
  "other",
] as const;
const counts = [
  "elapsedMs",
  "bytes",
  "rows",
  "namesRows",
  "commandRows",
  "missingRows",
  "extraRows",
  "parentChanges",
  "stateChanges",
  "attempt",
  "attempts",
  "verifiedRows",
  "unavailableRows",
  "truncatedRows",
] as const;
const flags = ["complete", "timeout", "truncated", "cancelled"] as const;
export type ProcessInspectionObservation = {
  stage: (typeof stages)[number];
  outcome: (typeof outcomes)[number];
} & Partial<Record<(typeof counts)[number], number>> &
  Partial<Record<(typeof flags)[number], boolean>>;
export type ProcessInspectionObserver = (
  event: ProcessInspectionObservation,
) => void;
type RetainedObservation = ProcessInspectionObservation & {
  call: number;
  provider: ProviderId;
  operation: (typeof operations)[number];
};

/** Copy only fixed enums, booleans and bounded counters. No free text crosses this boundary. */
export function sanitizeProcessObservation(
  value: ProcessInspectionObservation,
): ProcessInspectionObservation | undefined {
  if (
    !value ||
    !stages.includes(value.stage) ||
    !outcomes.includes(value.outcome)
  )
    return;
  const output: ProcessInspectionObservation = {
    stage: value.stage,
    outcome: value.outcome,
  };
  for (const key of counts) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0)
      output[key] = Math.min(1_000_000_000, Math.floor(count));
  }
  for (const key of flags)
    if (typeof value[key] === "boolean") output[key] = value[key];
  return output;
}

/** Observation must never change a guard result, including a throwing/rejecting observer. */
export function observeProcessInspection(
  observer: ProcessInspectionObserver | undefined,
  value: ProcessInspectionObservation,
): void {
  if (!observer) return;
  try {
    const clean = sanitizeProcessObservation(value);
    if (!clean) return;
    const result: unknown = observer(Object.freeze(clean));
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      void Promise.resolve(result).catch(() => {});
  } catch {
    /* Diagnostics have no authority over process safety. */
  }
}

export function createProcessObservationSink(capacity = 512) {
  const limit = Number.isSafeInteger(capacity)
    ? Math.max(1, Math.min(capacity, 512))
    : 512;
  let observations: RetainedObservation[] = [],
    dropped = 0,
    calls = 0;
  return {
    begin(provider: ProviderId, operation: string): ProcessInspectionObserver {
      const call = ++calls;
      const safeOperation = operations.includes(
        operation as (typeof operations)[number],
      )
        ? (operation as (typeof operations)[number])
        : "other";
      return (value) => {
        const clean = sanitizeProcessObservation(value);
        if (
          !clean ||
          !["codex", "claude-code", "cursor", "cline"].includes(provider)
        )
          return;
        if (observations.length >= limit) {
          observations.shift();
          dropped++;
        }
        observations.push({
          ...clean,
          call,
          provider,
          operation: safeOperation,
        });
      };
    },
    read() {
      const result = {
        version: 1 as const,
        observations: observations.map((row) => ({ ...row })),
        dropped,
        calls,
      };
      observations = [];
      dropped = 0;
      return result;
    },
  };
}

/** A QA marker in an isolated generated profile is required in addition to explicit opt-in. */
export async function processObservationProfileEnabled(options: {
  packaged: boolean;
  optIn?: string;
  testUserData?: string;
  profile: string;
}): Promise<boolean> {
  if (options.packaged || options.optIn !== "1" || !options.testUserData)
    return false;
  try {
    const profile = path.resolve(options.testUserData);
    if (
      profile !== options.profile ||
      path.basename(profile) !== "profile" ||
      !/^(?:native-providers|agentvac-native-suite)-[A-Za-z0-9]{6}$/.test(
        path.basename(path.dirname(profile)),
      )
    )
      return false;
    if ((await fs.realpath(profile)) !== profile) return false;
    const directory = await fs.lstat(profile);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const marker = path.join(profile, ".agentvac-process-observations");
    const stat = await fs.lstat(marker, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size !== 42n
    )
      return false;
    // No-follow where supported; nonblocking also prevents a swapped FIFO from
    // hanging setup. Handle identity is checked on platforms without O_NOFOLLOW.
    const handle = await fs.open(
      marker,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const same = (other: typeof stat) =>
        other.isFile() &&
        !other.isSymbolicLink() &&
        other.dev === stat.dev &&
        other.ino === stat.ino &&
        other.size === stat.size &&
        other.nlink === stat.nlink &&
        other.mode === stat.mode &&
        other.mtimeNs === stat.mtimeNs &&
        other.ctimeNs === stat.ctimeNs;
      if (!same(await handle.stat({ bigint: true }))) return false;
      // One bounded read: an appended/replaced marker never causes an unbounded readFile.
      const bytes = Buffer.alloc(43);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (
        bytesRead !== 42 ||
        !same(await handle.stat({ bigint: true })) ||
        !same(await fs.lstat(marker, { bigint: true }))
      )
        return false;
      return (
        bytes.subarray(0, bytesRead).toString("utf8") ===
        "agentvac-generated-process-observation-v1\n"
      );
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
