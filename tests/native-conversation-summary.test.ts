import test from "node:test";
import assert from "node:assert/strict";
import {
  validateConversationEvidence,
  validateAclEvidence,
  validateDurabilityEvidence,
} from "../scripts/native-ci-summary.mjs";
const expected = {
  sourceRevision: "sha",
  ciRunId: "1",
  ciRunAttempt: "1",
  platform: "win32",
  arch: "x64",
  appVersion: "0.2.0",
};
const reader = () => ({
  ...expected,
  format: "agentvac-native-conversations-v1",
  status: "PASS",
  nativeElectron: true,
  realMainPreloadIPC: true,
  syntheticFixturesOnly: true,
  installedVendorRuntimeTested: false,
  packagedArtifactTested: false,
  sourcesUnchanged: true,
  builtUnchanged: true,
  security: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    noSandbox: false,
  },
  errors: [],
  built: Object.fromEntries(
    ["main", "preload", "cursor-sql-worker"].map((name) => [
      "dist-electron/" + name + ".cjs",
      "a".repeat(64),
    ]),
  ),
  checks: [
    ...["codex", "claude-code", "cline", "cursor"].map((provider) => ({
      provider,
      status: "PASS",
      lateContentSearch: true,
      fullUnicodePaging: true,
      actualTimestamp: true,
      consentBeforeRead: true,
      revokeInvalidates: true,
    })),
    ...["cline", "cursor"].map((provider) => ({
      provider,
      source: "explicit-read-only",
      status: "PASS",
      realDialogRoute: true,
      newConsent: true,
      cleanupRootUnchanged: true,
      archiveDisabled: true,
      resetRevokes: true,
    })),
  ],
});
test("fresh complete native viewer evidence is required", () =>
  assert.deepEqual(validateConversationEvidence(reader(), expected), []));
test("stale viewer revision/run/platform and guard-blocked source cannot pass", () => {
  for (const field of Object.keys(expected))
    assert.ok(
      validateConversationEvidence({ ...reader(), [field]: "other" }, expected)
        .length,
    );
  const value = reader();
  value.checks[3].status = "BLOCKED";
  assert.ok(validateConversationEvidence(value, expected).length);
});
test("missing source immutability, sandbox, native read-source controls or fingerprints fail", () => {
  for (const field of [
    "sourcesUnchanged",
    "builtUnchanged",
    "realMainPreloadIPC",
  ])
    assert.ok(
      validateConversationEvidence({ ...reader(), [field]: false }, expected)
        .length,
    );
  const value = reader();
  value.checks.pop();
  assert.ok(validateConversationEvidence(value, expected).length);
  assert.ok(
    validateConversationEvidence({ ...reader(), built: {} }, expected).length,
  );
  assert.ok(
    validateConversationEvidence(
      { ...reader(), security: { ...reader().security, noSandbox: true } },
      expected,
    ).length,
  );
});
test("Windows ACL evidence cannot pass missing native checks or permission mutation", () => {
  const { appVersion, ...tags } = expected;
  const value = {
    ...tags,
    format: "agentvac-native-cursor-acl-v1",
    status: "PASS",
    changesPermissions: false,
    copiesProviderData: false,
    runtimeAclPolicy: "runtime-read-only-allowlist-v1",
    checks: {
      privateDirectory: true,
      inheritedChildDirectory: true,
      inheritedFile: true,
      publicDirectoryRejected: true,
      sourceUnchanged: true,
      runtimeInitializationPassed: true,
    },
  };
  assert.deepEqual(validateAclEvidence(value, tags), []);
  for (const key of Object.keys(value.checks))
    assert.ok(
      validateAclEvidence(
        { ...value, checks: { ...value.checks, [key]: false } },
        tags,
      ).length,
    );
  assert.ok(
    validateAclEvidence({ ...value, changesPermissions: true }, tags).length,
  );
});

test("native durability cannot pass without real process-kill restart and exact payload checks", () => {
  const { appVersion, ...tags } = expected;
  const value = {
    ...tags,
    format: "agentvac-native-unit-durability-v1",
    mode: "native-filesystem-source-engine",
    status: "PASS",
    synthetic: true,
    powerLossAtomicityClaimed: false,
    checkpoints: [
      {
        name: "quarantine-committed-before-ack",
        processKilled: true,
        restartRecovered: true,
        retainedFiles: 2,
      },
      {
        name: "restore-committed-before-ack",
        processKilled: true,
        restartRecovered: true,
        exactBytes: true,
        duplicateRefused: true,
      },
    ],
  };
  assert.deepEqual(validateDurabilityEvidence(value, tags), []);
  assert.ok(
    validateDurabilityEvidence({ ...value, checkpoints: [] }, tags).length,
  );
  assert.ok(
    validateDurabilityEvidence(
      { ...value, powerLossAtomicityClaimed: true },
      tags,
    ).length,
  );
});
