import assert from "node:assert/strict";
import path from "node:path";

const stages = new Set([
  "preflight",
  "fixture-setup",
  "profile-preparation",
  "build-fingerprints",
  "native-launch",
  "window-ready",
  "sandbox-verification",
  "profile-isolation",
  "payload-manifest",
  "payload-binding",
  "reader-activate",
  "reader-consent",
  "reader-list",
  "reader-page",
  "reader-revoke",
  "alternate-source",
  "source-integrity",
  "build-integrity",
  "renderer-health",
  "cleanup",
]);
const providers = new Set(["codex", "claude-code", "cline", "cursor"]);
const errorCodes = new Set([
  "ERR_ASSERTION",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "ENOSPC",
  "EBUSY",
  "ETIMEDOUT",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ERR_INVALID_ARG_TYPE",
]);

export function readerLaunchTarget({ packageExecutable, project, profile }) {
  assert.ok(path.isAbsolute(profile), "Reader profile must be absolute");
  if (packageExecutable) {
    assert.ok(
      path.isAbsolute(packageExecutable),
      "Packaged reader target must be absolute",
    );
    // This is Chromium's supported profile selector. Production intentionally
    // ignores AGENTVAC_TEST_USER_DATA when app.isPackaged is true.
    return {
      executablePath: packageExecutable,
      args: [`--user-data-dir=${profile}`],
    };
  }
  assert.ok(path.isAbsolute(project), "Reader source project must be absolute");
  return { args: [project] };
}

// Only fixed labels leave this boundary. Never inspect message/stack, assertion
// values, child output, paths, argv, environment or arbitrary thrown objects.
export function readerFailureEvidence(stage, error, context = {}) {
  const safeStage = stages.has(stage) ? stage : "preflight";
  const provider = providers.has(context.provider)
    ? context.provider
    : undefined;
  const source =
    context.source === "explicit-read-only" ? context.source : undefined;
  const code =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined;
  const name =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, "name")?.value
      : undefined;
  const readerCase =
    provider &&
    (safeStage.startsWith("reader-") || safeStage === "alternate-source");
  const evidence = {
    stage: safeStage,
    failedCheck: readerCase
      ? `reader-${provider}${source ? "-explicit-read-only" : ""}`
      : `reader-${safeStage}`,
    category:
      code === "ERR_ASSERTION"
        ? "ASSERTION_MISMATCH"
        : name === "TimeoutError"
          ? "TIMEOUT"
          : errorCodes.has(code)
            ? "SYSTEM_ERROR"
            : "CHECK_FAILED",
  };
  if (errorCodes.has(code)) evidence.errorCode = code;
  if (readerCase) evidence.provider = provider;
  if (readerCase && source) evidence.source = source;
  return evidence;
}
