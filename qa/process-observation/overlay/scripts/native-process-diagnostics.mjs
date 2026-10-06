// Read only the exact guard-call observations already retained by Electron main.
// Keep this module plain JavaScript: desktop QA runs without a TypeScript loader.
const maximumObservations = 512;
const providers = new Set(["codex", "claude-code", "cursor", "cline"]);
const operations = new Set([
  "preview",
  "quarantine",
  "restore",
  "prepare-trash",
  "trash",
  "diagnose-storage",
  "scan",
  "startup",
  "other",
]);
const stages = new Set([
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
]);
const outcomes = new Set([
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
]);
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
];
const flags = ["complete", "timeout", "truncated", "cancelled"];
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const add = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

function sanitizeObservation(value, calls) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !counter(value.call) ||
    value.call < 1 ||
    value.call > calls ||
    !providers.has(value.provider) ||
    !operations.has(value.operation) ||
    !stages.has(value.stage) ||
    !outcomes.has(value.outcome)
  )
    return null;
  const result = {
    call: value.call,
    provider: value.provider,
    operation: value.operation,
    stage: value.stage,
    outcome: value.outcome,
  };
  for (const key of counts) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0)
      result[key] = Math.min(1_000_000_000, Math.floor(count));
  }
  for (const key of flags)
    if (typeof value[key] === "boolean") result[key] = value[key];
  return result;
}

function unavailable(reason) {
  return {
    version: 1,
    available: false,
    reason,
    observations: [],
    dropped: 0,
    calls: 0,
  };
}

export async function nativeProcessObservation(application) {
  try {
    const value = await application.evaluate(() => {
      const read = globalThis.__agentvacReadProcessObservations;
      return typeof read === "function" ? read() : null;
    });
    if (value === null) return unavailable("unavailable");
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.observations) ||
      !counter(value.dropped) ||
      !counter(value.calls)
    )
      return unavailable("invalid-data");
    const observations = [];
    let dropped = value.dropped;
    for (const event of value.observations.slice(-maximumObservations)) {
      const clean = sanitizeObservation(event, value.calls);
      if (clean) observations.push(clean);
      else dropped = add(dropped, 1);
    }
    dropped = add(
      dropped,
      Math.max(0, value.observations.length - maximumObservations),
    );
    return {
      version: 1,
      available: true,
      observations,
      dropped,
      calls: value.calls,
    };
  } catch {
    // Error messages can contain process names, paths, or raw command output.
    return unavailable("read-failed");
  }
}

export function createNativeProcessObservationCollector(
  capacity = maximumObservations,
) {
  const limit = counter(capacity)
    ? Math.max(1, Math.min(capacity, maximumObservations))
    : maximumObservations;
  const applications = new WeakMap();
  const observations = [];
  const failures = { unavailable: 0, "read-failed": 0, "invalid-data": 0 };
  let sessions = 0,
    reads = 0,
    availableReads = 0,
    calls = 0,
    dropped = 0;
  return {
    async drain(application) {
      let session = applications.get(application);
      if (!session) {
        session = { id: ++sessions, calls: 0 };
        applications.set(application, session);
      }
      const result = await nativeProcessObservation(application);
      reads++;
      if (!result.available) {
        failures[result.reason]++;
        return { ...result, session: session.id };
      }
      if (result.calls < session.calls) {
        failures["invalid-data"]++;
        dropped = add(dropped, add(result.dropped, result.observations.length));
        return { ...unavailable("invalid-data"), session: session.id };
      }
      availableReads++;
      calls = add(calls, result.calls - session.calls);
      session.calls = result.calls;
      dropped = add(dropped, result.dropped);
      for (const event of result.observations) {
        if (observations.length >= limit) {
          observations.shift();
          dropped = add(dropped, 1);
        }
        observations.push({ ...event, session: session.id });
      }
      return { ...result, session: session.id };
    },
    snapshot() {
      return {
        version: 1,
        sessions,
        reads,
        availableReads,
        unavailableReads: failures.unavailable,
        failedReads: failures["read-failed"],
        invalidReads: failures["invalid-data"],
        calls,
        dropped,
        observations: observations.map((event) => ({ ...event })),
      };
    },
  };
}
