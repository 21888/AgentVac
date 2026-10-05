// Read-only native Windows ACL evidence. Creates only new synthetic fixture files;
// never changes ACLs, copies a provider database, or enables a production gate.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  inspectCursorSnapshotWindowsAclDetailed,
  inspectCursorSnapshotWindowsLocalityDetailed,
  canonicalizeCursorSnapshotWindowsPath,
  CURSOR_WINDOWS_ACL_POLICY,
} from "../electron/conversations/cursor-windows-acl.ts";
import {
  initializeCursorSnapshotStorage,
  getCursorSnapshotStorageAvailability,
} from "../electron/conversations/cursor-temp.ts";
const result = {
  format: "agentvac-native-cursor-acl-v1",
  platform: process.platform,
  arch: process.arch,
  sourceRevision: process.env.GITHUB_SHA ?? null,
  ciRunId: process.env.GITHUB_RUN_ID ?? null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  runtimeAclPolicy: CURSOR_WINDOWS_ACL_POLICY,
  changesPermissions: false,
  copiesProviderData: false,
  checks: {},
  diagnostics: {},
  status: "NOT_APPLICABLE",
};
let fixture;
try {
  if (process.platform === "win32") {
    const temporaryParent = canonicalizeCursorSnapshotWindowsPath(os.tmpdir());
    assert.ok(temporaryParent, "Local temporary metadata target unavailable");
    const parentLocality =
      await inspectCursorSnapshotWindowsLocalityDetailed(temporaryParent);
    result.diagnostics.localTemporaryParent = parentLocality;
    result.checks.localTemporaryParentVerified =
      parentLocality.outcome === "verified-local";
    assert.equal(
      result.checks.localTemporaryParentVerified,
      true,
      "Local temporary parent could not be verified",
    );
    fixture = await fs.mkdtemp(
      path.join(await fs.realpath(temporaryParent), "AgentVac-ACL-Fixture-"),
    );
    const child = path.join(fixture, "child");
    await fs.mkdir(child);
    const file = path.join(child, "synthetic.txt");
    await fs.writeFile(file, "synthetic private-boundary probe");
    const before = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
    const inspect = async (name, target, isDirectory, expectedOutcome) => {
      const detail = await inspectCursorSnapshotWindowsAclDetailed(
        target,
        isDirectory,
      );
      result.diagnostics[name] = detail;
      result.checks[name] = detail.outcome === expectedOutcome;
    };
    await inspect("privateDirectory", fixture, true, "verified-private");
    await inspect("inheritedChildDirectory", child, true, "verified-private");
    await inspect("inheritedFile", file, false, "verified-private");
    const publicRoot = process.env.PUBLIC;
    assert.ok(
      publicRoot && path.win32.isAbsolute(publicRoot),
      "Public directory metadata target unavailable",
    );
    // A timeout, failed helper or malformed output does not prove that a public
    // directory was measured and rejected by the ACL policy.
    await inspect("publicDirectoryRejected", publicRoot, true, "acl-rejected");
    result.checks.sourceUnchanged =
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex") === before;
    const initializationStarted = performance.now();
    try {
      await initializeCursorSnapshotStorage(
        path.join(fixture, "gated-snapshot-root"),
      );
      result.checks.runtimeInitializationPassed =
        getCursorSnapshotStorageAvailability().available;
    } catch {
      result.checks.runtimeInitializationPassed = false;
    }
    result.diagnostics.runtimeInitialization = {
      elapsedMs: Math.round(performance.now() - initializationStarted),
      reason: getCursorSnapshotStorageAvailability().reason,
    };
    for (const [name, value] of Object.entries(result.checks))
      assert.equal(value, true, `Required native ACL check failed: ${name}`);
    result.status = "PASS";
  }
} catch (error) {
  result.status = "FAIL";
  result.failure =
    error instanceof assert.AssertionError
      ? error.message
      : "Native ACL probe could not complete safely.";
  process.exitCode = 1;
} finally {
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  const directory = path.resolve(
    process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ?? ".qa/native-conversation-acl",
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(
      directory,
      `conversation-acl-${process.platform}-${process.arch}.json`,
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
