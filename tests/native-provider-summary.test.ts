import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requiredProviderChecks,
  validateProviderEvidence,
} from "../scripts/native-ci-summary.mjs";
const expected = {
  sourceRevision: "fixture-sha",
  ciRunId: "12",
  ciRunAttempt: "2",
  platform: "linux",
  arch: "x64",
  appVersion: "0.2.0",
};
function evidence() {
  return {
    ...expected,
    format: "agentvac-native-providers-v1",
    status: "PASS",
    nativeExecution: true,
    packagedArtifactTested: false,
    synthetic: true,
    vendorRuntimeTested: false,
    errors: [],
    security: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      disabledSandbox: false,
      arch: "x64",
      appVersion: "0.2.0",
    },
    checks: Object.fromEntries(
      requiredProviderChecks.map((provider) => [
        provider,
        {
          status: "PASS",
          actualProcessGuard: "clear",
          quarantine: 1,
          restore: 1,
          restart: true,
          exactBytes: true,
          protectedFilesUnchanged: true,
          conflictRefused: true,
          duplicateRefused: true,
          providerSwitchInvalidates: true,
          retainedCounts: true,
          files: 2,
          directories: 1,
        },
      ]),
    ),
  };
}
test("all three actual native provider lifecycles require fresh exact revision/version evidence", () =>
  assert.deepEqual(validateProviderEvidence(evidence(), expected), []));
test("guard-blocked skipped or omitted provider mutation cannot satisfy native acceptance", () => {
  for (const provider of requiredProviderChecks) {
    for (const status of ["SKIP", "FAIL", "BLOCKED"]) {
      const data = evidence();
      data.checks[provider].status = status;
      assert.ok(validateProviderEvidence(data, expected).length);
    }
    const data = evidence();
    delete data.checks[provider];
    assert.ok(validateProviderEvidence(data, expected).length);
  }
});
test("a claimed PASS cannot hide a guard block or missing recovery/conflict/data evidence", () => {
  for (const provider of requiredProviderChecks) {
    for (const field of [
      "restart",
      "exactBytes",
      "protectedFilesUnchanged",
      "conflictRefused",
      "duplicateRefused",
      "providerSwitchInvalidates",
      "retainedCounts",
    ]) {
      const data = evidence();
      (data.checks[provider] as any)[field] = false;
      assert.ok(validateProviderEvidence(data, expected).length);
    }
    const data = evidence();
    data.checks[provider].actualProcessGuard = "unknown";
    assert.ok(validateProviderEvidence(data, expected).length);
  }
});
test("stale revision run attempt platform architecture or app version rejects provider evidence", () => {
  for (const field of Object.keys(expected))
    assert.ok(
      validateProviderEvidence({ ...evidence(), [field]: "old" }, expected)
        .length,
    );
});
test("disabled security malformed renderer evidence and altered runtime identity are rejected", () => {
  for (const security of [
    { ...evidence().security, sandbox: false },
    { ...evidence().security, disabledSandbox: true },
    { ...evidence().security, arch: "arm64" },
  ])
    assert.ok(
      validateProviderEvidence({ ...evidence(), security }, expected).length,
    );
  assert.ok(
    validateProviderEvidence(
      { ...evidence(), errors: ["renderer error"] },
      expected,
    ).length,
  );
  assert.ok(validateProviderEvidence(null, expected).length);
});
