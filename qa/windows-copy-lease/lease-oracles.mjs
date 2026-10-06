/** Generated-fixture test oracles only. Never an application authorization API. */
const expectations = Object.freeze({
  broad: Object.freeze({ outcome: "acl-rejected", reason: "none" }),
  nonempty: Object.freeze({
    outcome: "identity-unavailable",
    reason: "initial-file-nonempty",
  }),
  hardlink: Object.freeze({
    outcome: "identity-unavailable",
    reason: "initial-file-hardlink",
  }),
  deleteAccess: Object.freeze({
    outcome: "metadata-unavailable",
    reason: "sharing-conflict",
  }),
});
const unavailable = new Set([
  "metadata-unavailable",
  "identity-unavailable",
  "context-rejected",
  "caller-rejected",
  "locality-rejected",
]);
export function classifyNativeFixtureRefusal(error, kind) {
  const expected = expectations[kind];
  if (
    !expected ||
    error?.code !== "LEASE_NATIVE_REFUSED" ||
    error?.verifiedTerminalRefusal !== true
  )
    return "unverified";
  if (
    error.nativeOutcome === expected.outcome &&
    error.nativeReason === expected.reason
  )
    return "expected";
  if (
    (error.nativeReason === "none" && unavailable.has(error.nativeOutcome)) ||
    error.nativeReason === "filesystem-unsupported"
  )
    return "blocked";
  return "wrong-reason";
}
export function requireNativeFixtureRefusal(error, kind) {
  const classification = classifyNativeFixtureRefusal(error, kind);
  if (classification === "expected") return;
  if (classification === "blocked") throw error;
  throw Object.assign(new Error("LEASE_EXPECTED_REFUSAL_NOT_PROVEN"), {
    code: "LEASE_EXPECTED_REFUSAL_NOT_PROVEN",
  });
}
export function requireInvalidControlRefusal(evidence, exit) {
  if (
    evidence?.phase !== "refused" ||
    evidence.outcome !== "invalid-request" ||
    evidence.reason !== "none" ||
    evidence.nonceBound !== true ||
    evidence.teardownConfirmed !== true ||
    exit?.code !== 0 ||
    exit.signal !== null
  )
    throw Object.assign(new Error("LEASE_INVALID_CONTROL_NOT_REFUSED"), {
      code: "LEASE_INVALID_CONTROL_NOT_REFUSED",
    });
}

const fixtureError = (code) => Object.assign(new Error(code), { code });
export async function requireHeldRenameRefusal(lease, attempt) {
  if (lease?.isLive?.() !== true)
    throw fixtureError("LEASE_LOST_AT_RENAME_ATTEMPT");
  let refused,
    succeeded = false;
  try {
    await attempt();
    succeeded = true;
  } catch (error) {
    refused = error;
  }
  if (lease.isLive() !== true) throw fixtureError("LEASE_LOST_DURING_RENAME");
  if (succeeded) throw fixtureError("LEASE_RENAME_SUCCEEDED");
  if (!["EPERM", "EACCES", "EBUSY"].includes(refused?.code))
    throw fixtureError("LEASE_RENAME_UNEXPECTED_ERROR");
}

export function requireNoReadyUnderDeleteHolder(wasReady) {
  if (wasReady !== false)
    throw fixtureError("LEASE_UNEXPECTED_READY_UNDER_DELETE_HOLDER");
}
