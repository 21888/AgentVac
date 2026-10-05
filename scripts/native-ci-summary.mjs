import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const requiredNativeChecks = [
  "fixture-disk-and-diagnostic-data",
  "native-window-preload-ipc-sandbox",
  "demo-ui-scan-quarantine-history-restore",
  "preference-and-demo-persistence-restart",
  "single-instance-lock",
  "generated-root-adapter",
  "duplicate-quarantine-and-restore",
  "native-trash-generated-batch",
  "diagnostic-real-helper-ipc-readonly",
  "diagnostic-cancel-no-orphans",
  "diagnostic-window-close-no-orphans",
];

export function validateNativeEvidence(result, expected) {
  const problems = [];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched or missing ${field}`);
  if (
    result.nativeExecution !== true ||
    result.packagedArtifactTested !== false
  )
    problems.push(
      "Expected source-native evidence, not self-test or packaged acceptance",
    );
  if (!["PASS", "PASS_WITH_LIMITATIONS"].includes(result.status))
    problems.push(`Native result: ${result.status || "missing"}`);
  for (const name of requiredNativeChecks)
    if (result.checks?.[name]?.status !== "PASS")
      problems.push(`${name}: ${result.checks?.[name]?.status || "MISSING"}`);
  return problems;
}

export const requiredProviderChecks = ["claude-code", "cline", "cursor"];
export function validateDriverEvidence(result, expected) {
  if (!result || typeof result !== "object")
    return ["Missing compiled driver evidence"];
  const problems = [];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched driver ${field}`);
  if (
    result.format !== "agentvac-native-driver-execution-v1" ||
    result.mode !== "plain-compiled-same-harness" ||
    result.argvSource !== "node-normalized-process-argv" ||
    result.unchangedProductionGuards !== true ||
    result.nodeOptionsPresent !== false ||
    !Array.isArray(result.execArgv) ||
    result.execArgv.length ||
    !Array.isArray(result.argv) ||
    result.argv.length !== 2 ||
    result.argv[0] !== result.executable ||
    typeof result.argv[1] !== "string" ||
    !result.argv[1]
      .replaceAll("\\", "/")
      .endsWith("/.qa/native-harness/native-provider-driver.mjs") ||
    !/^[a-f0-9]{64}$/.test(result.bundleSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(result.workerSha256 ?? "") ||
    !Array.isArray(result.sourceFiles) ||
    !result.sourceFiles.length ||
    result.sourceFiles.length > 256 ||
    result.sourceDigest !==
      createHash("sha256")
        .update(JSON.stringify(result.sourceFiles))
        .digest("hex")
  )
    problems.push(
      "Compiled driver provenance missing or unexpected execution mode",
    );
  return problems;
}
export function validateProviderEvidence(result, expected) {
  if (!result || typeof result !== "object")
    return ["Missing provider evidence"];
  const problems = [];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched or missing provider ${field}`);
  if (
    result.format !== "agentvac-native-providers-v1" ||
    result.status !== "PASS" ||
    result.nativeExecution !== true ||
    result.packagedArtifactTested !== false ||
    result.synthetic !== true ||
    result.vendorRuntimeTested !== false
  )
    problems.push(
      "Provider evidence must be successful source-native synthetic execution",
    );
  const security = result.security;
  if (
    !security ||
    security.sandbox !== true ||
    security.contextIsolation !== true ||
    security.nodeIntegration !== false ||
    security.webSecurity !== true ||
    security.disabledSandbox !== false ||
    security.arch !== result.arch ||
    security.appVersion !== result.appVersion
  )
    problems.push(
      "Provider sandbox, runtime architecture or version check missing",
    );
  if (!Array.isArray(result.errors) || result.errors.length)
    problems.push("Provider renderer errors or missing error evidence");
  for (const provider of requiredProviderChecks) {
    const row = result.checks?.[provider];
    if (
      row?.status !== "PASS" ||
      row.actualProcessGuard !== "clear" ||
      row.quarantine !== 1 ||
      row.restore !== 1 ||
      row.mutationNotTested === true ||
      !Number.isSafeInteger(row.files) ||
      row.files < 1 ||
      !Number.isSafeInteger(row.directories) ||
      row.directories < 0 ||
      [
        "restart",
        "exactBytes",
        "protectedFilesUnchanged",
        "conflictRefused",
        "duplicateRefused",
        "providerSwitchInvalidates",
        "retainedCounts",
      ].some((field) => row[field] !== true)
    )
      problems.push(
        `${provider}: required native mutation/recovery case did not pass`,
      );
  }
  return problems;
}

export function validateConversationEvidence(result, expected) {
  const problems = [];
  if (!result || typeof result !== "object")
    return ["Missing native conversation evidence"];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched conversation ${field}`);
  if (
    result.format !== "agentvac-native-conversations-v1" ||
    result.status !== "PASS" ||
    result.nativeElectron !== true ||
    result.realMainPreloadIPC !== true ||
    result.syntheticFixturesOnly !== true ||
    result.installedVendorRuntimeTested !== false ||
    result.packagedArtifactTested !== false ||
    result.sourcesUnchanged !== true ||
    result.builtUnchanged !== true
  )
    problems.push("Conversation runtime/source checks missing or failed");
  const security = result.security;
  if (
    !security ||
    security.sandbox !== true ||
    security.contextIsolation !== true ||
    security.nodeIntegration !== false ||
    security.webSecurity !== true ||
    security.noSandbox !== false
  )
    problems.push("Conversation renderer security not verified");
  if (!Array.isArray(result.errors) || result.errors.length)
    problems.push("Conversation renderer errors or missing observations");
  for (const file of [
    "dist-electron/main.cjs",
    "dist-electron/preload.cjs",
    "dist-electron/cursor-sql-worker.cjs",
  ])
    if (!/^[a-f0-9]{64}$/.test(result.built?.[file] ?? ""))
      problems.push(`Missing build fingerprint ${file}`);
  for (const provider of ["codex", "claude-code", "cline", "cursor"]) {
    const row = result.checks?.find(
      (r) => r.provider === provider && !r.source,
    );
    if (
      row?.status !== "PASS" ||
      [
        "lateContentSearch",
        "fullUnicodePaging",
        "actualTimestamp",
        "consentBeforeRead",
        "revokeInvalidates",
      ].some((k) => row[k] !== true)
    )
      problems.push(`Missing native conversation ${provider}`);
  }
  for (const provider of ["cline", "cursor"]) {
    const row = result.checks?.find(
      (r) => r.provider === provider && r.source === "explicit-read-only",
    );
    if (
      row?.status !== "PASS" ||
      [
        "realDialogRoute",
        "newConsent",
        "cleanupRootUnchanged",
        "archiveDisabled",
        "resetRevokes",
      ].some((k) => row[k] !== true)
    )
      problems.push(`Missing native read-only source ${provider}`);
  }
  return problems;
}
export function validateAclEvidence(result, expected) {
  const problems = [];
  if (!result || typeof result !== "object")
    return ["Missing native Windows ACL evidence"];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched ACL ${field}`);
  if (
    result.format !== "agentvac-native-cursor-acl-v1" ||
    result.status !== "PASS" ||
    result.changesPermissions !== false ||
    result.copiesProviderData !== false ||
    result.runtimeAclPolicy !== "runtime-read-only-allowlist-v1"
  )
    problems.push("ACL proof failed or modified permissions");
  for (const key of [
    "privateDirectory",
    "inheritedChildDirectory",
    "inheritedFile",
    "publicDirectoryRejected",
    "sourceUnchanged",
    "runtimeInitializationPassed",
  ])
    if (result.checks?.[key] !== true)
      problems.push(`Missing native ACL ${key}`);
  return problems;
}

export function validateDurabilityEvidence(result, expected) {
  const problems = [];
  if (!result || typeof result !== "object")
    return ["Missing durability evidence"];
  for (const [field, value] of Object.entries(expected))
    if (!value || result[field] !== value)
      problems.push(`Mismatched durability ${field}`);
  if (
    result.format !== "agentvac-native-unit-durability-v1" ||
    result.mode !== "native-filesystem-source-engine" ||
    result.status !== "PASS" ||
    result.synthetic !== true ||
    result.powerLossAtomicityClaimed !== false
  )
    problems.push("Durability result missing or overstated");
  for (const name of [
    "quarantine-committed-before-ack",
    "restore-committed-before-ack",
  ]) {
    const row = result.checkpoints?.find((r) => r.name === name);
    if (row?.processKilled !== true || row?.restartRecovered !== true)
      problems.push(`Missing process-kill recovery ${name}`);
    if (name.startsWith("quarantine") && row?.retainedFiles !== 2)
      problems.push("Missing retained unit payload");
    if (
      name.startsWith("restore") &&
      (row?.exactBytes !== true || row?.duplicateRefused !== true)
    )
      problems.push("Missing exact restored payload");
  }
  return problems;
}

async function main() {
  const directory = process.env.AGENTVAC_NATIVE_EVIDENCE_DIR;
  if (!directory) throw new Error("Missing run-specific evidence directory");
  const file = path.join(
    directory,
    `next-${process.platform}-${process.arch}.json`,
  );
  const result = JSON.parse(await fs.readFile(file, "utf8"));
  console.log("Source-native result:", result.status);
  console.log("Packaged app and installer acceptance: UNTESTED");
  for (const [name, row] of Object.entries(result.checks || {}))
    console.log(`${row.status}: ${name}`);
  const problems = validateNativeEvidence(result, {
    sourceRevision: process.env.GITHUB_SHA,
    ciRunId: process.env.GITHUB_RUN_ID,
    ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: process.platform,
    arch: process.env.AGENTVAC_EXPECTED_ARCH,
  });
  const providerFile = path.join(
    directory,
    `providers-${process.platform}-${process.arch}.json`,
  );
  const providers = JSON.parse(await fs.readFile(providerFile, "utf8"));
  const version = JSON.parse(
    await fs.readFile(path.resolve("package.json"), "utf8"),
  ).version;
  problems.push(
    ...validateProviderEvidence(providers, {
      sourceRevision: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: process.platform,
      arch: process.env.AGENTVAC_EXPECTED_ARCH,
      appVersion: version,
    }),
  );
  for (const provider of requiredProviderChecks)
    console.log(
      `${providers.checks?.[provider]?.status || "MISSING"}: native-provider ${provider}`,
    );
  const expected = {
    sourceRevision: process.env.GITHUB_SHA,
    ciRunId: process.env.GITHUB_RUN_ID,
    ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: process.platform,
    arch: process.env.AGENTVAC_EXPECTED_ARCH,
  };
  const driver = JSON.parse(
    await fs.readFile(
      path.join(
        directory,
        `provider-driver-${process.platform}-${process.arch}.json`,
      ),
      "utf8",
    ),
  );
  problems.push(...validateDriverEvidence(driver, expected));
  const currentBundle = createHash("sha256")
    .update(
      await fs.readFile(
        path.resolve(".qa/native-harness/native-provider-driver.mjs"),
      ),
    )
    .digest("hex");
  if (driver.bundleSha256 !== currentBundle)
    problems.push("Compiled driver bundle changed after execution");
  const currentWorker = createHash("sha256")
    .update(
      await fs.readFile(path.resolve("dist-electron/process-argv-worker.cjs")),
    )
    .digest("hex");
  if (driver.workerSha256 !== currentWorker)
    problems.push("Process observation worker changed after execution");
  const conversations = JSON.parse(
    await fs.readFile(
      path.join(
        directory,
        `conversations-${process.platform}-${process.arch}.json`,
      ),
      "utf8",
    ),
  );
  problems.push(
    ...validateConversationEvidence(conversations, {
      ...expected,
      appVersion: version,
    }),
  );
  if (process.platform === "win32") {
    const acl = JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          `conversation-acl-${process.platform}-${process.arch}.json`,
        ),
        "utf8",
      ),
    );
    problems.push(...validateAclEvidence(acl, expected));
  }
  const durable = JSON.parse(
    await fs.readFile(
      path.join(
        directory,
        `durability-${process.platform}-${process.arch}.json`,
      ),
      "utf8",
    ),
  );
  problems.push(...validateDurabilityEvidence(durable, expected));
  if (problems.length) throw new Error(problems.join("\n"));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error("Source-native acceptance incomplete:", String(error));
    process.exitCode = 1;
  });
