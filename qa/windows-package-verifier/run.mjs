// QA-only follow-up of the original 4a523 release source. No app files change.
import assert from "node:assert/strict";
import { promises as fs, createReadStream } from "node:fs";
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
async function hashFile(file) { const hash = createHash("sha256"); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest("hex"); }
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
export const OMITTED_PORTABLE = Object.freeze({
  distributed: false, status: "FAIL_NATIVE_ACCEPTANCE", runId: 37540075963, jobId: 112530652671,
  sourceRevision: SOURCE, failedCheck: "actual-package-native-smoke", nestedFailedCheck: "harness-fatal-error",
  cause: "Not established by the retained bounded log; launcher/debugger transport is a hypothesis only.",
  byteVerification: "PASS", installerAcceptance: "NOT_RUN_IN_THAT_JOB", rerun: false,
});

export function mergeStageEvidence(current) {
  for (const key of ["overlayTests", "build", "packages", "packageBytes", "setup"])
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
const windowsNames = ["setup.exe", "SHA256SUMS.txt", "verification.json"].map((suffix) => `AgentVac-0.2.0-windows-x64-${suffix}`).sort();

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
export function validateSetupAssetList(manifest) {
  assert.equal(manifest.sourceRevision, SOURCE);
  assert.equal(manifest.platform, "windows"); assert.equal(manifest.arch, "x64");
  assert.equal(manifest.allPackagePathsPassed, true); assert.equal(manifest.applicationAcceptance, false);
  assert.deepEqual(manifest.selectedTargets, ["windows-setup"]);
  assert.deepEqual(manifest.omittedPortable, OMITTED_PORTABLE);
  assert.ok(Array.isArray(manifest.files));
  assert.deepEqual(manifest.files.map((row) => row.name).sort(), windowsNames);
  for (const row of manifest.files) {
    assert.equal(path.basename(row.path), row.name);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    assert.match(row.sha256 ?? "", /^[a-f0-9]{64}$/);
  }
}
export async function uploadSetupAssets(manifest, { shippingRoot, readDraft, uploadFile }) {
  validateSetupAssetList(manifest);
  const before = validateExistingDraft(await readDraft());
  const selected = [];
  // Validate every file before admitting the first remote upload.
  for (const row of manifest.files) {
    const file = path.resolve(shippingRoot, row.path);
    const expected = row.name.endsWith("-setup.exe") ? path.join(shippingRoot, "release-final/windows", row.name) : path.join(shippingRoot, ".qa/release-assets", row.name);
    assert.equal(file, expected);
    const stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, row.bytes); assert.equal(await hashFile(file), row.sha256);
    selected.push({ file, row });
  }
  for (const { file, row } of selected) {
    await uploadFile(file);
    const release = await readDraft();
    assert.equal(release.id, RELEASE_ID); assert.equal(release.draft, true); assert.equal(release.target_commitish, SOURCE); assert.equal(release.tag_name, "v0.2.0");
    const matches = release.assets.filter((item) => item.name === row.name); assert.equal(matches.length, 1);
    assert.equal(matches[0].size, row.bytes); assert.equal(matches[0].digest, `sha256:${row.sha256}`);
    assert.deepEqual(validateExistingDraft({ ...release, assets: release.assets.filter((item) => existingNames.includes(item.name)) }), before);
  }
  validatePreservedDraft(await readDraft(), before);
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
    const { validatePackageReceipt } = await import(pathToFileURL(path.join(shipping, "scripts/prepare-release-assets.mjs")));
    const row = JSON.parse(await fs.readFile(path.join(shipping, ".qa/release-package/windows-setup/result.json"), "utf8"));
    validatePackageReceipt(row, SOURCE); assert.equal(row.target, "windows-setup");
    const artifact = path.resolve(row.artifact.path);
    assert.equal(artifact, path.join(shipping, "release-final/windows/AgentVac-0.2.0-windows-x64-setup.exe"));
    assert.equal(row.artifact.name, path.basename(artifact));
    const stat = await fs.lstat(artifact); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, row.artifact.bytes); assert.equal(await hashFile(artifact), row.artifact.sha256);
    const dir = path.join(shipping, ".qa/release-assets"); await fs.mkdir(dir, { recursive: true });
    const files = [{ name: row.artifact.name, path: path.relative(shipping, artifact).split(path.sep).join("/"), bytes: stat.size, sha256: row.artifact.sha256 }];
    const receipt = {
      format: "agentvac-release-package-verification-v1", sourceRevision: SOURCE, sourceDigest,
      ciRunId: process.env.GITHUB_RUN_ID, ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: "windows", arch: "x64", selectedTargets: ["windows-setup"], omittedPortable: OMITTED_PORTABLE,
      ...evidence, qaProvenance: provenance, currentQaStages: current, priorSourceStagesRerun: false,
      packages: [{ target: "windows-setup", status: "PASS", artifact: { name: row.artifact.name, bytes: stat.size, sha256: row.artifact.sha256 }, payloadVerification: { status: row.payloadVerification.status, manifestSha256: row.payloadVerification.manifestSha256, fileCount: row.payloadVerification.fileCount, symlinkCount: row.payloadVerification.symlinkCount }, installerTested: true }],
      allPackagePathsPassed: true, applicationAcceptance: false, publication: false,
      scope: "Verified Windows NSIS setup only. Optional portable failed native acceptance and is not distributed. Prior provider failures remain explicit; no whole-app acceptance claim.",
    };
    const prefix = "AgentVac-0.2.0-windows-x64";
    for (const [name, content] of [
      [`${prefix}-verification.json`, JSON.stringify(receipt, null, 2) + "\n"],
      [`${prefix}-SHA256SUMS.txt`, `${files[0].sha256}  ${files[0].name}\n`],
    ]) {
      const file = path.join(dir, name); await fs.writeFile(file, content, { flag: "wx" });
      files.push({ name, path: path.relative(shipping, file).split(path.sep).join("/"), bytes: Buffer.byteLength(content), sha256: sha(content) });
    }
    const manifest = { ...receipt, files }; validateSetupAssetList(manifest);
    await fs.writeFile(path.join(dir, "asset-list.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    await verifyShipping(); console.log(JSON.stringify(receipt)); return;
  }
  assert.ok(process.env.GH_TOKEN);
  const { resolveReleaseTag, requireTagTarget } = await import(pathToFileURL(path.join(shipping, "scripts/release-draft.mjs")));
  requireTagTarget(resolveReleaseTag(), SOURCE);
  const manifest = JSON.parse(await fs.readFile(path.join(shipping, ".qa/release-assets/asset-list.json"), "utf8"));
  validateSetupAssetList(manifest); assert.deepEqual(manifest.qaProvenance, provenance);
  await uploadSetupAssets(manifest, { shippingRoot: shipping, readDraft: canonicalDraft, uploadFile: (file) => execFileSync("gh", ["release", "upload", "v0.2.0", file, "--repo", REPO], { encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 }) });
  for (const row of manifest.files) console.log(JSON.stringify({ draftAsset: row.name, bytes: row.bytes, sha256: row.sha256, verified: true }));
  await verifyShipping();
  console.log(JSON.stringify({ phase, releaseId: RELEASE_ID, releaseSourceRevision: SOURCE, workflowQaRevision: process.env.GITHUB_SHA, existingAssetsPreserved: 11, newWindowsAssets: 3, omittedPortable: true, published: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
