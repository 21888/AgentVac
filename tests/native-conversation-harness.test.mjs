import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  readerLaunchTarget,
  readerFailureEvidence,
} from "../scripts/native-conversation-harness.mjs";

test("packaged readers select the exact generated profile through one supported argument", () => {
  const profile = path.resolve("generated profile 中", "profile");
  const executable = path.resolve("generated package", "agentvac");
  const target = readerLaunchTarget({
    packageExecutable: executable,
    project: path.resolve("source"),
    profile,
  });
  assert.equal(target.executablePath, executable);
  assert.deepEqual(target.args, [`--user-data-dir=${profile}`]);
  assert.deepEqual(
    readerLaunchTarget({ project: path.resolve("source"), profile }),
    { args: [path.resolve("source")] },
  );
  assert.throws(() =>
    readerLaunchTarget({ packageExecutable: "relative-app", profile }),
  );
  assert.throws(() =>
    readerLaunchTarget({
      packageExecutable: executable,
      profile: "relative-profile",
    }),
  );
});

test("profile and payload failures retain stage and safe cause without raw error or assertion data", () => {
  const secret =
    "/private/generated/profile SECRET_FIXTURE_CONTENT " + "x".repeat(20000);
  const error = new assert.AssertionError({
    actual: secret,
    expected: secret + "other",
    operator: "strictEqual",
  });
  Object.assign(error, { stdout: secret, stderr: secret });
  for (const stage of [
    "profile-isolation",
    "payload-manifest",
    "payload-binding",
  ]) {
    const evidence = readerFailureEvidence(stage, error);
    assert.deepEqual(evidence, {
      stage,
      failedCheck: `reader-${stage}`,
      category: "ASSERTION_MISMATCH",
      errorCode: "ERR_ASSERTION",
    });
    assert.ok(JSON.stringify(evidence).length < 256);
    assert.ok(!JSON.stringify(evidence).includes(secret));
  }
});

test("reader failures identify their bounded case without copying paths, values or untrusted labels", () => {
  const error = Object.assign(new Error("secret"), {
    code: "EACCES",
    path: "/private/data",
  });
  assert.deepEqual(
    readerFailureEvidence("reader-page", error, { provider: "cursor" }),
    {
      stage: "reader-page",
      failedCheck: "reader-cursor",
      category: "SYSTEM_ERROR",
      errorCode: "EACCES",
      provider: "cursor",
    },
  );
  assert.deepEqual(
    readerFailureEvidence("alternate-source", error, {
      provider: "cline",
      source: "explicit-read-only",
    }),
    {
      stage: "alternate-source",
      failedCheck: "reader-cline-explicit-read-only",
      category: "SYSTEM_ERROR",
      errorCode: "EACCES",
      provider: "cline",
      source: "explicit-read-only",
    },
  );
  const hostile = {
    get code() {
      throw Error("must not inspect thrown objects");
    },
    toString() {
      throw Error("must not stringify thrown objects");
    },
  };
  assert.deepEqual(
    readerFailureEvidence("/private/stage", hostile, {
      provider: "/private/provider",
      source: "/private/source",
    }),
    {
      stage: "preflight",
      failedCheck: "reader-preflight",
      category: "CHECK_FAILED",
    },
  );
  const getterError = new Error("secret");
  Object.defineProperty(getterError, "code", {
    get() {
      throw Error("must not invoke getters");
    },
  });
  assert.equal(
    readerFailureEvidence("native-launch", getterError).category,
    "CHECK_FAILED",
  );
});

test("an early invalid packaged target writes bounded failure evidence before any native launch", async (t) => {
  const out = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentvac-reader-evidence-test-"),
  );
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const secret = "PRIVATE_TARGET_SENTINEL";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/native-conversation-regression.mjs"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        AGENTVAC_PACKAGE_EXECUTABLE: secret,
        AGENTVAC_CONVERSATION_EVIDENCE: out,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 1);
  const raw = await fs.readFile(path.join(out, "results.json"), "utf8");
  const evidence = JSON.parse(raw);
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.failedCheck, "reader-preflight");
  assert.equal(evidence.failure.errorCode, "ERR_ASSERTION");
  assert.equal(evidence.security, null);
  assert.equal(evidence.nativeLaunchAttempted, false);
  assert.equal(evidence.nativeElectron, false);
  assert.equal(evidence.realMainPreloadIPC, false);
  assert.equal(evidence.profileIsolationVerified, false);
  assert.deepEqual(evidence.checks, []);
  assert.equal(evidence.cleanup.appClosed, true);
  assert.ok(!raw.includes(secret));
  assert.ok(!result.stdout.includes(secret));
});
