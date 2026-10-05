import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
