// One reviewed metadata transition. No builds, uploads, tag writes, or retries.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "21888/AgentVac";
export const SOURCE = "4a523b95c1098eeb3e220cc58d290819ef97a01f";
export const RELEASE_ID = 405138314;
export const TAG = "v0.2.0";
export const WINDOWS_QA = Object.freeze({
  revision: "6da2a960a2034b43595f9fbdbe0a44447f3514d8",
  runId: 37541701609,
  jobId: 112535997318,
});
export const NOTES_PATH = "docs/RELEASE-NOTES-0.2.0.md";
const own = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(own, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const apiRoot = `repos/${REPOSITORY}`;
const smallLimit = 512 * 1024;
export const groups = Object.freeze([
  { platform: "linux", arch: "x64", suffixes: [".tar.gz"] },
  { platform: "macos", arch: "x64", suffixes: [".zip", ".dmg"] },
  { platform: "macos", arch: "arm64", suffixes: [".zip", ".dmg"] },
  { platform: "windows", arch: "x64", suffixes: ["-setup.exe"] },
]);
const prefix = (group) => `AgentVac-0.2.0-${group.platform}-${group.arch}`;
export const assetNames = groups.flatMap((group) => [
  ...group.suffixes.map((suffix) => prefix(group) + suffix),
  prefix(group) + "-SHA256SUMS.txt",
  prefix(group) + "-verification.json",
]).sort();

function exactKeys(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function validPath(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.\/-]+$/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}
function nonshippingPath(value) {
  return /^(?:qa|tests|docs)\//.test(value) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(value) ||
    /^\.github\/[^/]+\.marker$/.test(value) ||
    /^README(?:\.[A-Za-z-]+)?\.md$/.test(value) || value === "SOURCE-SHA256.json" ||
    ["scripts/verify-packages.mjs", "scripts/package-asar-paths.mjs"].includes(value);
}
export function assetSignature(assets) {
  assert.ok(Array.isArray(assets));
  assert.equal(assets.length, 14, "Exactly fourteen reviewed assets are required");
  const ids = new Set();
  const records = assets.map((asset) => {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && !ids.has(asset.id));
    ids.add(asset.id);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.digest ?? "", digestPattern, "Missing or changed server SHA256");
    return { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest };
  }).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(records.map((asset) => asset.name).sort(), assetNames);
  return records;
}
export function validateLock(lock) {
  exactKeys(lock, ["format", "reviewed", "repository", "releaseId", "tag", "sourceRevision", "notesSha256", "allowedPaths", "assets"]);
  assert.equal(lock.format, "agentvac-final-publication-lock-v1");
  assert.equal(lock.reviewed, true, "The publication lock has not been finalized and reviewed");
  assert.equal(lock.repository, REPOSITORY);
  assert.equal(lock.releaseId, RELEASE_ID);
  assert.equal(lock.tag, TAG);
  assert.equal(lock.sourceRevision, SOURCE);
  assert.match(lock.notesSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(lock.allowedPaths) && lock.allowedPaths.length > 0 && lock.allowedPaths.length <= 500);
  assert.equal(new Set(lock.allowedPaths).size, lock.allowedPaths.length);
  for (const name of lock.allowedPaths) {
    assert.ok(validPath(name) && nonshippingPath(name), `Not an explicit nonshipping path: ${name}`);
  }
  for (const asset of lock.assets ?? []) exactKeys(asset, ["id", "name", "size", "digest"]);
  assetSignature(lock.assets);
  for (const asset of lock.assets.filter((row) => /-(?:SHA256SUMS\.txt|verification\.json)$/.test(row.name)))
    assert.ok(asset.size <= smallLimit, "Receipt download exceeds its small-file limit");
  return lock;
}
export function validateRepository(repository, branch, revision) {
  assert.equal(repository.full_name, REPOSITORY);
  assert.equal(repository.private, false);
  assert.equal(repository.visibility, "public");
  assert.equal(repository.default_branch, "master");
  assert.equal(repository.archived, false);
  assert.equal(repository.disabled, false);
  assert.equal(branch.ref, "refs/heads/master");
  assert.equal(branch.object?.type, "commit");
  assert.equal(branch.object.sha, revision, "master moved away from this workflow revision");
}
export function validateRelease(release, lock, revision, published = false, body) {
  assert.equal(release?.id, RELEASE_ID);
  assert.equal(release.tag_name, TAG);
  assert.equal(release.target_commitish, published ? revision : SOURCE);
  assert.equal(release.draft, !published, "Unexpected release publication state");
  assert.equal(release.prerelease, false);
  assert.deepEqual(assetSignature(release.assets), assetSignature(lock.assets));
  assert.ok(release.assets.every((asset) => asset.state === "uploaded"));
  if (published) {
    assert.equal(release.body, body);
    assert.equal(release.html_url, `https://github.com/${REPOSITORY}/releases/tag/${TAG}`);
    assert.ok(typeof release.published_at === "string" && Number.isFinite(Date.parse(release.published_at)));
  }
}
function treeMap(tree, expectedSha) {
  assert.equal(tree.sha, expectedSha);
  assert.equal(tree.truncated, false, "Incomplete recursive Git tree");
  assert.ok(Array.isArray(tree.tree) && tree.tree.length > 0 && tree.tree.length <= 10000);
  const entries = new Map();
  for (const row of tree.tree) {
    assert.ok(validPath(row.path) && !entries.has(row.path));
    assert.match(row.sha ?? "", shaPattern);
    assert.ok((["100644", "100755", "120000"].includes(row.mode) && row.type === "blob") ||
      (row.mode === "040000" && row.type === "tree") || (row.mode === "160000" && row.type === "commit"));
    entries.set(row.path, { type: row.type, mode: row.mode, sha: row.sha });
  }
  // Every directory must be represented, and empty/opaque directories are refused.
  for (const [name, row] of entries) {
    const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null;
    if (parent) assert.equal(entries.get(parent)?.type, "tree");
    if (row.type === "tree") assert.ok([...entries.keys()].some((child) => child.startsWith(name + "/")));
  }
  return entries;
}
export function compareTrees(original, candidate, allowedPaths, originalSha, candidateSha) {
  const before = treeMap(original, originalSha), after = treeMap(candidate, candidateSha);
  const changed = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(name), right = after.get(name);
    // Directory object IDs reflect descendants; leaves and directory modes/types are checked.
    if (left?.type === "tree" && right?.type === "tree") continue;
    if (left?.type === "tree" || right?.type === "tree") {
      const existing = left ?? right;
      assert.equal(existing.type, "tree", `Directory/file conversion: ${name}`);
      assert.ok(!left || !right, `Directory/file conversion: ${name}`);
      continue;
    }
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    assert.ok(allowedPaths.includes(name), `Unreviewed source or mode change: ${name}`);
    for (const row of [left, right].filter(Boolean))
      assert.ok(row.type === "blob" && ["100644", "100755"].includes(row.mode), `Non-regular allowlisted file: ${name}`);
    changed.push(name);
  }
  assert.deepEqual(changed.sort(), [...allowedPaths].sort(), "Allowed paths must exactly match reviewed changed files");
  return changed;
}
export function resolveTag(read) {
  const refs = read(`${apiRoot}/git/matching-refs/tags/${TAG}`);
  assert.ok(Array.isArray(refs) && refs.length < 100, "Incomplete tag inventory");
  const matches = refs.filter((row) => row.ref === `refs/tags/${TAG}`);
  assert.ok(matches.length <= 1);
  if (!matches.length) return null;
  let object = matches[0].object;
  const seen = new Set();
  for (let depth = 0; depth < 5; depth++) {
    assert.match(object?.sha ?? "", shaPattern);
    assert.ok(!seen.has(object.sha), "Cyclic tag object"); seen.add(object.sha);
    if (object.type === "commit") return object.sha;
    assert.equal(object.type, "tag");
    const tag = read(`${apiRoot}/git/tags/${object.sha}`);
    assert.equal(tag.sha, object.sha);
    object = tag.object;
  }
  throw Error("Tag depth exceeded");
}
export function requireTagTarget(target, revision) {
  assert.ok(target === null || target === revision, "Existing v0.2.0 tag resolves elsewhere; never move or delete it");
}
export function verifySmallAssets(lock, contents) {
  for (const group of groups) {
    const binaries = group.suffixes.map((suffix) => lock.assets.find((row) => row.name === prefix(group) + suffix));
    for (const suffix of ["-SHA256SUMS.txt", "-verification.json"]) {
      const asset = lock.assets.find((row) => row.name === prefix(group) + suffix), bytes = contents.get(asset.name);
      assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, asset.size);
      assert.equal(`sha256:${sha256(bytes)}`, asset.digest, `Downloaded content differs: ${asset.name}`);
    }
    const sums = contents.get(prefix(group) + "-SHA256SUMS.txt").toString("utf8");
    const expected = binaries.map((row) => `${row.digest.slice(7)}  ${row.name}`).sort();
    assert.deepEqual(sums.trimEnd().split("\n").sort(), expected);
    const receipt = JSON.parse(contents.get(prefix(group) + "-verification.json").toString("utf8"));
    assert.equal(receipt.format, "agentvac-release-package-verification-v1");
    assert.equal(receipt.sourceRevision, SOURCE);
    assert.equal(receipt.platform, group.platform); assert.equal(receipt.arch, group.arch);
    assert.equal(receipt.allPackagePathsPassed, true); assert.equal(receipt.applicationAcceptance, false);
    assert.equal(receipt.publication, false); // Immutable draft-time provenance, not current release status.
    assert.equal(receipt.packages?.length, binaries.length);
    assert.deepEqual(receipt.packages.map((row) => row.artifact.name).sort(), binaries.map((row) => row.name).sort());
    for (const row of receipt.packages) {
      const asset = binaries.find((item) => item.name === row.artifact.name);
      assert.equal(row.status, "PASS"); assert.equal(row.payloadVerification?.status, "PASS");
      assert.equal(row.artifact.bytes, asset.size); assert.equal(`sha256:${row.artifact.sha256}`, asset.digest);
    }
    if (group.platform === "windows") {
      assert.equal(receipt.ciRunId, String(WINDOWS_QA.runId));
      assert.equal(receipt.qaProvenance?.releaseSourceRevision, SOURCE);
      assert.equal(receipt.qaProvenance.workflowQaRevision, WINDOWS_QA.revision);
      assert.deepEqual(receipt.selectedTargets, ["windows-setup"]);
      assert.equal(receipt.packages[0].target, "windows-setup"); assert.equal(receipt.packages[0].installerTested, true);
      assert.equal(receipt.omittedPortable?.distributed, false);
      assert.equal(receipt.omittedPortable.status, "FAIL_NATIVE_ACCEPTANCE");
      assert.equal(receipt.omittedPortable.rerun, false);
      assert.equal(receipt.priorSourceStagesRerun, false);
      assert.equal(receipt.qaProvenance.priorSourceEvidence?.units?.skipped, 44);
      assert.equal(receipt.stageResults?.providers, "failure");
      for (const stage of ["overlayTests", "build", "packages", "packageBytes", "setup"])
        assert.equal(receipt.currentQaStages?.[stage], "success");
    }
  }
}
function gh(args, input, limit = 4 * 1024 * 1024) {
  return execFileSync("gh", args, { timeout: 20000, maxBuffer: limit, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
}
const read = (endpoint) => JSON.parse(gh(["api", endpoint]).toString("utf8"));
function readTree(revision) {
  const commit = read(`${apiRoot}/git/commits/${revision}`);
  assert.equal(commit.sha, revision); assert.match(commit.tree?.sha ?? "", shaPattern);
  return { tree: read(`${apiRoot}/git/trees/${commit.tree.sha}?recursive=1`), sha: commit.tree.sha };
}
function validateWindowsRun() {
  const run = read(`${apiRoot}/actions/runs/${WINDOWS_QA.runId}`);
  assert.equal(run.id, WINDOWS_QA.runId); assert.equal(run.head_sha, WINDOWS_QA.revision);
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  assert.equal(run.repository?.full_name, REPOSITORY);
  const job = read(`${apiRoot}/actions/jobs/${WINDOWS_QA.jobId}`);
  assert.equal(job.id, WINDOWS_QA.jobId); assert.equal(job.run_id, WINDOWS_QA.runId);
  assert.equal(job.head_sha, WINDOWS_QA.revision);
  assert.equal(job.status, "completed"); assert.equal(job.conclusion, "success");
}
function validateAssetInventory(lock) {
  const assets = read(`${apiRoot}/releases/${RELEASE_ID}/assets?per_page=100`);
  assert.deepEqual(assetSignature(assets), assetSignature(lock.assets));
  assert.ok(assets.every((asset) => asset.state === "uploaded"));
}
export async function main() {
  assert.ok(["check", "publish"].includes(process.argv[2]) && process.argv.length === 3);
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  const revision = process.env.GITHUB_SHA; assert.match(revision ?? "", shaPattern);
  assert.equal(process.env.GITHUB_REF, "refs/heads/master");
  assert.ok(["workflow_dispatch", "push"].includes(process.env.GITHUB_EVENT_NAME));
  assert.ok(process.env.GH_TOKEN, "Runner token missing");
  const lock = validateLock(JSON.parse(await fs.readFile(path.join(own, "lock.json"), "utf8")));
  const notes = await fs.readFile(path.join(root, NOTES_PATH));
  assert.ok(notes.length > 100 && notes.length <= 64 * 1024);
  assert.equal(sha256(notes), lock.notesSha256, "Final release notes differ from reviewed lock");
  const body = notes.toString("utf8");
  assert.equal(Buffer.from(body).compare(notes), 0, "Release notes must be valid UTF-8");
  const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), revision);
  assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]), "", "Checkout is not clean");
  const repository = read(apiRoot);
  const checkBranch = () => validateRepository(repository, read(`${apiRoot}/git/ref/heads/master`), revision);
  checkBranch();
  const draft = () => read(`${apiRoot}/releases/${RELEASE_ID}`);
  validateRelease(draft(), lock, revision);
  validateAssetInventory(lock);
  requireTagTarget(resolveTag(read), revision);
  const original = readTree(SOURCE), candidate = readTree(revision);
  const changedPaths = compareTrees(original.tree, candidate.tree, lock.allowedPaths, original.sha, candidate.sha);
  const contents = new Map();
  for (const asset of lock.assets.filter((row) => /-(?:SHA256SUMS\.txt|verification\.json)$/.test(row.name)))
    contents.set(asset.name, gh(["api", `${apiRoot}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"], undefined, smallLimit));
  verifySmallAssets(lock, contents);
  validateWindowsRun();
  // Re-read mutable guards immediately before the single permitted mutation.
  checkBranch(); validateRelease(draft(), lock, revision); validateAssetInventory(lock);
  requireTagTarget(resolveTag(read), revision);
  const evidence = { releaseId: RELEASE_ID, tag: TAG, builtSourceRevision: SOURCE, publicationRevision: revision, changedPaths, assets: assetSignature(lock.assets), windowsQa: WINDOWS_QA, applicationAcceptance: false };
  if (process.argv[2] === "check") {
    console.log(JSON.stringify({ ...evidence, published: false, action: "read-only-preflight-passed" })); return;
  }
  const payload = { tag_name: TAG, target_commitish: revision, draft: false, body, make_latest: "true" };
  console.log(JSON.stringify({ action: "attempting-single-reviewed-publication", releaseId: RELEASE_ID, target: revision }));
  // Never retry this PATCH. An uncertain response requires canonical read-only inspection.
  const changed = JSON.parse(gh(["api", "--method", "PATCH", `${apiRoot}/releases/${RELEASE_ID}`, "--input", "-"], JSON.stringify(payload)));
  validateRelease(changed, lock, revision, true, body);
  const canonical = draft(); validateRelease(canonical, lock, revision, true, body);
  validateRelease(read(`${apiRoot}/releases/latest`), lock, revision, true, body);
  validateAssetInventory(lock);
  assert.equal(resolveTag(read), revision, "Published tag must resolve to the workflow commit");
  checkBranch();
  console.log(JSON.stringify({ ...evidence, published: true, latest: true, action: "published-existing-reviewed-release", url: canonical.html_url, publishedAt: canonical.published_at, assetsPreserved: 14, tagCommitVerified: revision }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(`Final publication stopped: ${error.message}\nIf a PATCH was attempted, inspect canonical release/tag state before any further action. No automatic retry is performed.`); process.exitCode = 1; });
