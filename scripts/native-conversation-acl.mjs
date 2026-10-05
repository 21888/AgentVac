// Read-only native Windows ACL evidence. Creates only new synthetic fixture files;
// never changes ACLs, copies a provider database, or enables a production gate.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  inspectCursorSnapshotWindowsAcl,
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
  status: "NOT_APPLICABLE",
};
let fixture;
try {
  if (process.platform === "win32") {
    fixture = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "AgentVac-ACL-Fixture-"),
    );
    const child = path.join(fixture, "child");
    await fs.mkdir(child);
    const file = path.join(child, "synthetic.txt");
    await fs.writeFile(file, "synthetic private-boundary probe");
    const before = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
    result.checks.privateDirectory = await inspectCursorSnapshotWindowsAcl(
      fixture,
      true,
    );
    result.checks.inheritedChildDirectory =
      await inspectCursorSnapshotWindowsAcl(child, true);
    result.checks.inheritedFile = await inspectCursorSnapshotWindowsAcl(
      file,
      false,
    );
    const publicRoot = process.env.PUBLIC;
    assert.ok(
      publicRoot && path.win32.isAbsolute(publicRoot),
      "Public directory metadata target unavailable",
    );
    result.checks.publicDirectoryRejected =
      !(await inspectCursorSnapshotWindowsAcl(publicRoot, true));
    result.checks.sourceUnchanged =
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex") === before;
    await initializeCursorSnapshotStorage(
      path.join(fixture, "gated-snapshot-root"),
    );
    result.checks.runtimeInitializationPassed =
      getCursorSnapshotStorageAvailability().available;
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
