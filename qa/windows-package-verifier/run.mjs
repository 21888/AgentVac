// QA-only follow-up of the original 4a523 release source. No app files change.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const SOURCE = "4a523b95c1098eeb3e220cc58d290819ef97a01f";
export const RELEASE_ID = 405138314;
const REPO = "21888/AgentVac";
const own = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(own, "../..");
const shipping = path.join(project, "release-source");
const overlay = path.join(shipping, ".qa/windows-asar-verifier");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceManifestSha = "bdf46cafa101d517b44fe8a17bbbb5831084b55d4745e0e784fa20fdd17e7b8a";
const helperSha = "c22c00deefad41ef7107b6917d7d793529c7010fc83e959f509ec8a34e53adbd";

export const PRIOR = Object.freeze({
  runId: 37536722747, jobId: 112519594642, attempt: 1, sourceRevision: SOURCE,
  logSha256: "0d8bb12e9ca4dd49fd69ad2f780ce7b7d26676b54e23b886b5511b4760e53fb7",
  units: { total: 1070, passed: 1026, failed: 0, skipped: 44, rerun: false },
  skippedCategories: { disabledCursorDatabase: 19, verifiedFixtureRenameRefusal: 7, LinuxOnlyProcessObservation: 9, POSIXFifo: 2, POSIXPermissionMode: 2, unavailableWindowsDirectoryFsync: 3, nativeUnsafeIdConditionUnavailable: 2 },
  stages: { cursorBoundary: "success", units: "success", durability: "success", desktop: "success", providers: "failure", readers: "success" },
  limitations: ["Three provider mutations refused a complete unknown-process inventory; source and protected payload bytes remained unchanged after restart.", "Windows Cursor IDE database reading is disabled; explicit agent-transcripts are supported.", "The original package verifier failed before portable/NSIS execution; this QA run addresses that gate only."],
});

export function mergeStageEvidence(current) {
  for (const key of ["overlayTests", "build", "packages", "packageBytes", "portable", "setup"])
    assert.equal(current[key], "success", `Current QA stage did not pass: ${key}`);
  return {
    stageResults: { ...PRIOR.stages, build: "success", packages: "success", packageSmoke: "success" },
    stageOrigins: {
      ...Object.fromEntries(Object.keys(PRIOR.stages).map((key) => [key, { kind: "prior-source-run", runId: PRIOR.runId, jobId: PRIOR.jobId }])),
      ...Object.fromEntries(["build", "packages", "packageSmoke"].map((key) => [key, { kind: "current-qa-run" }])),
    },
  };
}

const existingNames = [
  "AgentVac-0.2.0-linux-x64.tar.gz", "AgentVac-0.2.0-linux-x64-SHA256SUMS.txt", "AgentVac-0.2.0-linux-x64-verification.json",
  ...["x64", "arm64"].flatMap((arch) => ["zip", "dmg", "SHA256SUMS.txt", "verification.json"].map((suffix) => `AgentVac-0.2.0-macos-${arch}${["zip", "dmg"].includes(suffix) ? "." : "-"}${suffix}`)),
].sort();
const windowsNames = ["portable.exe", "setup.exe", "SHA256SUMS.txt", "verification.json"].map((suffix) => `AgentVac-0.2.0-windows-x64-${suffix}`).sort();

export function validateExistingDraft(release) {
  assert.equal(release.id, RELEASE_ID); assert.equal(release.tag_name, "v0.2.0");
  assert.equal(release.target_commitish, SOURCE); assert.equal(release.draft, true);
  assert.ok(Array.isArray(release.assets));
  assert.deepEqual(release.assets.map((row) => row.name).sort(), existingNames);
  return release.assets.map((row) => {
    assert.ok(Number.isSafeInteger(row.id) && row.id > 0);
    assert.ok(Number.isSafeInteger(row.size) && row.size > 0);
    assert.match(row.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    return { id: row.id, name: row.name, size: row.size, digest: row.digest };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export function validatePreservedDraft(release, previous) {
  assert.equal(release.id, RELEASE_ID); assert.equal(release.tag_name, "v0.2.0");
  assert.equal(release.target_commitish, SOURCE); assert.equal(release.draft, true);
  assert.deepEqual(release.assets.map((row) => row.name).sort(), [...existingNames, ...windowsNames].sort());
  const existing = release.assets.filter((row) => existingNames.includes(row.name));
  assert.deepEqual(validateExistingDraft({ ...release, assets: existing }), previous);
}

async function inputs() {
  const list = JSON.parse(await fs.readFile(path.join(own, "INPUTS.json"), "utf8"));
  assert.equal(list.format, "agentvac-windows-asar-qa-inputs-v1");
  assert.ok(Array.isArray(list.files) && list.files.length > 0 && list.files.length < 30);
  assert.equal(list.sourceDigest, sha(JSON.stringify(list.files)));
  const seen = new Set();
  for (const row of list.files) {
    assert.ok(typeof row.path === "string" && /^[A-Za-z0-9_./-]+$/.test(row.path));
    assert.ok(row.path.split("/").every((part) => part && part !== "." && part !== "..") && !seen.has(row.path)); seen.add(row.path);
    const file = path.join(own, row.path), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.size, row.bytes);
    assert.equal(sha(await fs.readFile(file)), row.sha256);
  }
  return list;
}
async function verifyShipping() {
  assert.equal(execFileSync("git", ["-C", shipping, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 }).trim(), SOURCE);
  assert.equal(sha(await fs.readFile(path.join(shipping, "SOURCE-SHA256.json"))), sourceManifestSha);
  assert.equal(sha(await fs.readFile(path.join(shipping, "scripts/release-draft.mjs"))), helperSha);
  const helper = await import(pathToFileURL(path.join(shipping, "scripts/release-draft.mjs")));
  return helper.verifySourceManifest(shipping);
}
export function sourceChildEnvironment(parent, extras = {}) {
  assert.match(parent.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  // Only these legacy source helpers consume this child-local value. The actual
  // workflow revision is recorded separately and is never called the source SHA.
  return { ...parent, ...extras, GITHUB_SHA: SOURCE, AGENTVAC_WORKFLOW_QA_SHA: parent.GITHUB_SHA };
}
function child(script, args = [], extras = {}) {
  execFileSync(process.execPath, [path.join(shipping, script), ...args], { cwd: shipping, stdio: "inherit", timeout: 360000, env: sourceChildEnvironment(process.env, extras) });
}
function canonicalDraft() {
  return JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/releases/${RELEASE_ID}`], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }));
}
async function main() {
  assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
  assert.equal(process.env.GITHUB_REPOSITORY, REPO);
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 }).trim(), process.env.GITHUB_SHA);
  const phase = process.argv[2]; assert.ok(["stage", "prepare", "upload"].includes(phase));
  const list = await inputs(), sourceDigest = await verifyShipping();
  const provenance = { releaseSourceRevision: SOURCE, workflowQaRevision: process.env.GITHUB_SHA, qaInputDigest: list.sourceDigest, qaFiles: list.files, originalSourceManifestSha256: sourceManifestSha, originalSourceDigest: sourceDigest, priorSourceEvidence: PRIOR };
  if (phase === "stage") {
    await fs.mkdir(path.dirname(overlay), { recursive: true });
    await fs.mkdir(overlay, { recursive: false });
    for (const row of list.files) {
      const target = path.join(overlay, row.path); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(own, row.path), target, 1);
      assert.equal(sha(await fs.readFile(target)), row.sha256);
    }
    await fs.writeFile(path.join(overlay, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ phase, ...provenance })); return;
  }
  const staged = JSON.parse(await fs.readFile(path.join(overlay, "provenance.json"), "utf8"));
  assert.deepEqual(staged, provenance);
  for (const row of list.files)
    assert.equal(sha(await fs.readFile(path.join(overlay, row.path))), row.sha256);
  if (phase === "prepare") {
    const current = JSON.parse(process.env.AGENTVAC_WINDOWS_QA_STAGES ?? "{}");
    const evidence = mergeStageEvidence(current);
    child("scripts/prepare-release-assets.mjs", [], { AGENTVAC_RELEASE_STAGE_RESULTS: JSON.stringify(evidence.stageResults) });
    const dir = path.join(shipping, ".qa/release-assets"), receiptFile = path.join(dir, "AgentVac-0.2.0-windows-x64-verification.json"), manifestFile = path.join(dir, "asset-list.json");
    const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const extra = { qaProvenance: provenance, stageOrigins: evidence.stageOrigins, currentQaStages: current, priorSourceStagesRerun: false };
    Object.assign(receipt, extra); Object.assign(manifest, extra);
    const content = JSON.stringify(receipt, null, 2) + "\n";
    const row = manifest.files.find((item) => item.name === path.basename(receiptFile)); assert.ok(row);
    row.bytes = Buffer.byteLength(content); row.sha256 = sha(content);
    await fs.writeFile(receiptFile, content); await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    await verifyShipping(); console.log(JSON.stringify({ phase, ...extra, applicationAcceptance: false })); return;
  }
  assert.ok(process.env.GH_TOKEN);
  const before = validateExistingDraft(canonicalDraft());
  child("scripts/release-draft.mjs", ["upload"], { AGENTVAC_DRAFT_RELEASE_ID: String(RELEASE_ID) });
  validatePreservedDraft(canonicalDraft(), before);
  await verifyShipping();
  console.log(JSON.stringify({ phase, releaseId: RELEASE_ID, releaseSourceRevision: SOURCE, workflowQaRevision: process.env.GITHUB_SHA, existingAssetsPreserved: 11, newWindowsAssets: 4, published: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
