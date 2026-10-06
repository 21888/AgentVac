// Only allowlisted workflow outcomes. This does not summarize app acceptance.
const definitions = [
  ["source", "AV_DIAG_SOURCE", "all"],
  ["install", "AV_DIAG_INSTALL", "all"],
  ["batch-contracts", "AV_DIAG_BATCH", "all"],
  ["acl-prepare", "AV_DIAG_ACL_PREPARE", "win32"],
  ["acl-contracts", "AV_DIAG_ACL_CONTRACTS", "win32"],
  ["acl-startup", "AV_DIAG_ACL", "win32"],
  ["recovery-fixtures", "AV_DIAG_RECOVERY", "win32"],
  ["production-build", "AV_DIAG_BUILD", "darwin"],
  ["instrumented-build", "AV_DIAG_OBSERVED_BUILD", "darwin"],
  ["observer-contracts", "AV_DIAG_OBSERVER", "darwin"],
  ["instrumented-desktop", "AV_DIAG_DESKTOP", "darwin"],
  ["instrumented-providers", "AV_DIAG_PROVIDERS", "darwin"],
  ["source-after", "AV_DIAG_SOURCE_AFTER", "all"],
  ["instrumented-after", "AV_DIAG_OBSERVED_AFTER", "darwin"],
];
const allowed = new Set(["success", "failure", "cancelled", "skipped"]);
const stages = definitions.map(([stage, key, platform]) => {
  const expected = platform === "all" || platform === process.platform;
  const value = process.env[key];
  const outcome = allowed.has(value) ? value : "missing";
  return {
    stage,
    expected,
    outcome,
    evidenceMissing:
      expected && ["missing", "skipped", "cancelled"].includes(outcome),
  };
});
const counts = {
  expected: stages.filter((s) => s.expected).length,
  successfulSteps: stages.filter((s) => s.expected && s.outcome === "success")
    .length,
  failedSteps: stages.filter((s) => s.expected && s.outcome === "failure")
    .length,
  missingSteps: stages.filter((s) => s.evidenceMissing).length,
  platformInapplicableSteps: stages.filter((s) => !s.expected).length,
};
console.log(
  JSON.stringify({
    format: "agentvac-platform-diagnostic-stages-v1",
    platform: ["win32", "darwin"].includes(process.platform)
      ? process.platform
      : "unsupported",
    execution:
      process.platform === "darwin"
        ? "qa-instrumented-build"
        : "unchanged-helper-and-engine-fixtures",
    productionAccepted: false,
    ...counts,
    stages,
    limitation:
      "Workflow outcomes are not per-case proof; inspect each fixed-sequence and native fixture receipt. A successful diagnostic step is not application acceptance.",
  }),
);
if (
  counts.failedSteps ||
  counts.missingSteps ||
  !["win32", "darwin"].includes(process.platform)
)
  process.exitCode = 1;
