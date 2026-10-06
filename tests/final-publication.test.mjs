import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY, SOURCE, RELEASE_ID, TAG, WINDOWS_QA, NOTES_PATH, groups,
  validateLock, assetSignature, validateRepository, validateRelease,
  compareTrees, resolveTag, requireTagTarget, verifySmallAssets,
} from "../qa/final-publication/publish.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (text) => createHash("sha1").update(text).digest("hex");
const originalTreeSha = "b".repeat(40), candidateTreeSha = "c".repeat(40);
const api = `repos/${REPOSITORY}`;
const clone = (value) => structuredClone(value);
const prefix = (group) => `AgentVac-0.2.0-${group.platform}-${group.arch}`;
function tree(files, sha) {
  const entries = new Map();
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      entries.set(parent, { path: parent, type: "tree", mode: "040000", sha: object(parent) });
    }
    entries.set(name, { path: name, type: "blob", mode: "100644", sha: object(content) });
  }
  return { sha, truncated: false, tree: [...entries.values()] };
}
function fixture() {
  let assetId = 1000;
  const assets = [], contents = {};
  const add = (name, bytes) => {
    bytes = Buffer.from(bytes);
    const asset = { id: ++assetId, name, size: bytes.length, digest: `sha256:${digest(bytes)}` };
    assets.push(asset); contents[name] = bytes.toString("base64"); return asset;
  };
  for (const group of groups) {
    const binaries = group.suffixes.map((suffix) => add(prefix(group) + suffix, "fake package bytes " + suffix));
    const receipt = {
      format: "agentvac-release-package-verification-v1", sourceRevision: SOURCE,
      platform: group.platform, arch: group.arch, allPackagePathsPassed: true,
      applicationAcceptance: false, publication: false,
      packages: binaries.map((row) => ({ status: "PASS", artifact: { name: row.name, bytes: row.size, sha256: row.digest.slice(7) }, payloadVerification: { status: "PASS" } })),
    };
    if (group.platform === "windows") Object.assign(receipt, {
      ciRunId: String(WINDOWS_QA.runId), selectedTargets: ["windows-setup"],
      qaProvenance: { releaseSourceRevision: SOURCE, workflowQaRevision: WINDOWS_QA.revision, priorSourceEvidence: { units: { skipped: 44 } } },
      omittedPortable: { distributed: false, status: "FAIL_NATIVE_ACCEPTANCE", rerun: false },
      priorSourceStagesRerun: false, stageResults: { providers: "failure" },
      currentQaStages: Object.fromEntries(["overlayTests", "build", "packages", "packageBytes", "setup"].map((key) => [key, "success"])),
      packages: [{ ...receipt.packages[0], target: "windows-setup", installerTested: true }],
    });
    add(prefix(group) + "-verification.json", JSON.stringify(receipt) + "\n");
    add(prefix(group) + "-SHA256SUMS.txt", binaries.map((row) => `${row.digest.slice(7)}  ${row.name}`).join("\n") + "\n");
  }
  const body = `AgentVac v0.2.0\nBuilt from ${SOURCE}.\nPackage verification only; source-native cleanup limitations, unit skips, and signing gaps remain. Windows portable is excluded.\n`;
  const allowedPaths = [NOTES_PATH, "qa/final-publication/lock.json", "qa/final-publication/publish.mjs"];
  const shipping = {
    "src/runtime.ts": "runtime", "electron/main.ts": "main", "shared/protocol.ts": "protocol",
    "package.json": "package", "package-lock.json": "locked dependencies", "build/icon.png": "icon",
    "scripts/build-electron.mjs": "build", "scripts/release-draft.mjs": "draft", "vite.config.ts": "vite", "tsconfig.json": "tsconfig",
  };
  return {
    body, contents,
    lock: { format: "agentvac-final-publication-lock-v1", reviewed: true, repository: REPOSITORY, releaseId: RELEASE_ID, tag: TAG, sourceRevision: SOURCE, notesSha256: digest(body), allowedPaths, assets },
    repository: { full_name: REPOSITORY, private: false, visibility: "public", default_branch: "master", archived: false, disabled: false },
    originalTree: tree({ ...shipping, [NOTES_PATH]: "old notes" }, originalTreeSha),
    candidateTree: tree({ ...shipping, ...Object.fromEntries(allowedPaths.map((name) => [name, "new metadata " + name])) }, candidateTreeSha),
    release: { id: RELEASE_ID, tag_name: TAG, target_commitish: SOURCE, draft: true, prerelease: false, assets: assets.map((row) => ({ ...row, state: "uploaded" })) },
    run: { id: WINDOWS_QA.runId, head_sha: WINDOWS_QA.revision, status: "completed", conclusion: "success", repository: { full_name: REPOSITORY } },
    job: { id: WINDOWS_QA.jobId, run_id: WINDOWS_QA.runId, head_sha: WINDOWS_QA.revision, status: "completed", conclusion: "success" },
  };
}
const decoded = (f) => new Map(Object.entries(f.contents).map(([name, value]) => [name, Buffer.from(value, "base64")]));

test("reviewed lock is strict; placeholders, unknown fields, broad exemptions and shipping paths fail closed", () => {
  const f = fixture(); validateLock(f.lock);
  for (const change of [{ reviewed: false }, { assets: null }, { assets: [] }, { notesSha256: null }, { allowedPaths: null }, { allowedPaths: [] }, { extra: true }, { repository: "other/repo" }, { sourceRevision: "a".repeat(40) }])
    assert.throws(() => validateLock({ ...f.lock, ...change }));
  for (const name of ["qa/*", "qa/", "qa/../src/runtime.ts", "package.json", "package-lock.json", "scripts/build-electron.mjs", "scripts/release-draft.mjs", "build/icon.png", "vite.config.ts", "tsconfig.json", "electron/main.ts", "src/runtime.ts", "shared/protocol.ts"])
    assert.throws(() => validateLock({ ...f.lock, allowedPaths: [name] }), name);
  for (const name of ["scripts/verify-packages.mjs", "scripts/package-asar-paths.mjs", "tests/package-asar-paths.test.mjs", ".github/final-once.marker"])
    assert.doesNotThrow(() => validateLock({ ...f.lock, allowedPaths: [name] }));
});

test("asset lock binds all fourteen exact IDs, names, bytes and server digests", () => {
  const f = fixture(); assert.equal(assetSignature(f.lock.assets).length, 14);
  for (const change of [{ id: 0 }, { size: 0 }, { digest: null }, { name: "AgentVac-0.2.0-windows-x64-portable.exe" }]) {
    const assets = clone(f.lock.assets); Object.assign(assets[0], change); assert.throws(() => assetSignature(assets));
  }
  const duplicate = clone(f.lock.assets); duplicate[0].id = duplicate[1].id;
  assert.throws(() => assetSignature(duplicate));
  for (const field of ["id", "size", "digest"]) {
    const release = clone(f.release); release.assets[0][field] = field === "digest" ? "sha256:" + "d".repeat(64) : release.assets[0][field] + 1;
    assert.throws(() => validateRelease(release, f.lock, "a".repeat(40)));
  }
});

test("complete trees protect all nonallowlisted blobs and modes, reject truncation and directory tricks", () => {
  const f = fixture();
  const check = (candidate = f.candidateTree, allowed = f.lock.allowedPaths, original = f.originalTree) => compareTrees(original, candidate, allowed, originalTreeSha, candidateTreeSha);
  assert.deepEqual(check(), [...f.lock.allowedPaths].sort());
  for (const name of ["src/runtime.ts", "electron/main.ts", "shared/protocol.ts", "package.json", "package-lock.json", "build/icon.png", "scripts/build-electron.mjs", "scripts/release-draft.mjs", "vite.config.ts", "tsconfig.json"]) {
    const candidate = clone(f.candidateTree); candidate.tree.find((row) => row.path === name).sha = "d".repeat(40);
    assert.throws(() => check(candidate), name);
  }
  let candidate = clone(f.candidateTree); candidate.tree.find((row) => row.path === "src/runtime.ts").mode = "100755"; assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.tree.find((row) => row.path === NOTES_PATH).mode = "120000"; assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.truncated = true; assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.tree.push(candidate.tree[0]); assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.tree.push({ path: "empty", type: "tree", mode: "040000", sha: "e".repeat(40) }); assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.tree = candidate.tree.filter((row) => row.path !== "src"); assert.throws(() => check(candidate));
  candidate = clone(f.candidateTree); candidate.tree.find((row) => row.path === "src").mode = "100644"; candidate.tree.find((row) => row.path === "src").type = "blob"; assert.throws(() => check(candidate));
  assert.throws(() => check(f.candidateTree, [...f.lock.allowedPaths, "docs/not-changed.md"]));
});

test("tag resolution is bounded and never moves another commit", () => {
  const revision = "a".repeat(40), tagSha = "d".repeat(40);
  const ref = (object) => [{ ref: `refs/tags/${TAG}`, object }];
  assert.equal(resolveTag(() => []), null);
  assert.equal(resolveTag(() => ref({ type: "commit", sha: revision })), revision);
  assert.equal(resolveTag((url) => url.includes("matching-refs") ? ref({ type: "tag", sha: tagSha }) : { sha: tagSha, object: { type: "commit", sha: revision } }), revision);
  assert.throws(() => resolveTag((url) => url.includes("matching-refs") ? ref({ type: "tag", sha: tagSha }) : { sha: tagSha, object: { type: "tag", sha: tagSha } }));
  assert.throws(() => requireTagTarget(SOURCE, revision));
  assert.doesNotThrow(() => requireTagTarget(null, revision));
});

test("small receipt contents bind hashes, source, package payloads and Windows evidence without promoting limitations", () => {
  const f = fixture(); verifySmallAssets(f.lock, decoded(f));
  const changed = decoded(f); changed.set(changed.keys().next().value, Buffer.from("changed"));
  // The first entry is a package, which is intentionally never fetched by the helper.
  changed.set("AgentVac-0.2.0-linux-x64-verification.json", Buffer.from("changed"));
  assert.throws(() => verifySmallAssets(f.lock, changed));
  for (const mutate of [
    (row) => { row.sourceRevision = "a".repeat(40); },
    (row) => { row.applicationAcceptance = true; },
    (row) => { row.qaProvenance.workflowQaRevision = SOURCE; },
    (row) => { row.ciRunId = "wrong"; },
    (row) => { row.omittedPortable.distributed = true; },
    (row) => { row.qaProvenance.priorSourceEvidence.units.skipped = 0; },
    (row) => { row.stageResults.providers = "success"; },
    (row) => { row.currentQaStages.setup = "failure"; },
  ]) {
    const next = fixture(), name = "AgentVac-0.2.0-windows-x64-verification.json";
    const row = JSON.parse(Buffer.from(next.contents[name], "base64")); mutate(row);
    const bytes = Buffer.from(JSON.stringify(row)); next.contents[name] = bytes.toString("base64");
    Object.assign(next.lock.assets.find((asset) => asset.name === name), { size: bytes.length, digest: "sha256:" + digest(bytes) });
    assert.throws(() => verifySmallAssets(next.lock, decoded(next)));
  }
});

// The real entrypoint is spawned with this first-in-PATH fake gh. It only reads
// fixture JSON and writes its local call log. It cannot invoke gh or networking.
const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const args = process.argv.slice(2), method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const endpoint = method === "GET" ? args[1] : args[3];
const input = method === "GET" ? null : JSON.parse(fs.readFileSync(0, "utf8"));
const past = fs.existsSync(process.env.FAKE_GH_LOG) ? fs.readFileSync(process.env.FAKE_GH_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, method, endpoint, input }) + "\\n");
const published = past.find((row) => row.method === "PATCH");
const count = past.filter((row) => row.endpoint === endpoint).length;
let result;
const api = "repos/21888/AgentVac";
const postRelease = (payload) => ({ ...fixture.release, ...payload, html_url: "https://github.com/21888/AgentVac/releases/tag/v0.2.0", published_at: "2026-10-06T22:00:00Z" });
if (args[0] !== "api") throw Error("Only the API is permitted");
if (method === "PATCH") {
  if (endpoint !== api + "/releases/405138314" || published) throw Error("Unexpected or repeated write");
  if (fixture.patchFailure) { process.stderr.write("Simulated uncertain PATCH response"); process.exit(1); }
  result = postRelease(input);
  if (fixture.badPatchResponse) result.assets = [];
} else if (method !== "GET") throw Error("Forbidden write");
else if (endpoint === api) result = fixture.repository;
else if (endpoint === api + "/git/ref/heads/master") result = { ref: "refs/heads/master", object: { type: "commit", sha: fixture.branchMismatch || (fixture.raceBranch && count > 0) ? "f".repeat(40) : fixture.revision } };
else if (endpoint === api + "/releases/405138314") result = published ? postRelease(published.input) : fixture.release;
else if (endpoint === api + "/releases/latest") result = fixture.badLatest ? { id: 42 } : postRelease(published.input);
else if (endpoint === api + "/releases/405138314/assets?per_page=100") result = fixture.assetInventory || fixture.release.assets;
else if (endpoint === api + "/git/matching-refs/tags/v0.2.0") result = published ? [{ ref: "refs/tags/v0.2.0", object: { type: "commit", sha: fixture.badPublishedTag ? "f".repeat(40) : fixture.revision } }] : fixture.tagTarget ? [{ ref: "refs/tags/v0.2.0", object: { type: "commit", sha: fixture.tagTarget } }] : [];
else if (endpoint === api + "/git/commits/" + fixture.source) result = { sha: fixture.source, tree: { sha: fixture.originalTree.sha } };
else if (endpoint === api + "/git/commits/" + fixture.revision) result = { sha: fixture.revision, tree: { sha: fixture.candidateTree.sha } };
else if (endpoint === api + "/git/trees/" + fixture.originalTree.sha + "?recursive=1") result = fixture.originalTree;
else if (endpoint === api + "/git/trees/" + fixture.candidateTree.sha + "?recursive=1") result = fixture.candidateTree;
else if (endpoint === api + "/actions/runs/" + fixture.run.id) result = fixture.run;
else if (endpoint === api + "/actions/jobs/" + fixture.job.id) result = fixture.job;
else if (endpoint.startsWith(api + "/releases/assets/")) {
  if (args[2] !== "-H" || args[3] !== "Accept: application/octet-stream") throw Error("Unbounded asset flow");
  const asset = fixture.lock.assets.find((row) => endpoint.endsWith("/" + row.id));
  if (!asset || !/-(SHA256SUMS.txt|verification.json)$/.test(asset.name)) throw Error("Package binary fetch is forbidden");
  process.stdout.write(Buffer.from(fixture.contents[asset.name], "base64")); process.exit(0);
} else throw Error("Unexpected endpoint " + endpoint);
process.stdout.write(JSON.stringify(result));
`;

async function runEntrypoint(t, mutate = () => {}, mode = "publish") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-publication-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "checkout"), bin = path.join(directory, "bin");
  await fs.mkdir(path.join(checkout, "qa/final-publication"), { recursive: true });
  await fs.mkdir(path.join(checkout, "docs")); await fs.mkdir(bin);
  await fs.copyFile(path.join(repositoryRoot, "qa/final-publication/publish.mjs"), path.join(checkout, "qa/final-publication/publish.mjs"));
  await fs.writeFile(path.join(bin, "gh"), fakeGh, { mode: 0o755 });
  const f = fixture(); mutate(f);
  await fs.writeFile(path.join(checkout, "qa/final-publication/lock.json"), JSON.stringify(f.lock));
  await fs.writeFile(path.join(checkout, NOTES_PATH), f.body);
  const git = (args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--quiet"]); git(["add", "."]);
  git(["-c", "user.name=Offline Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  f.revision = git(["rev-parse", "HEAD"]); f.source = SOURCE;
  if (f.dirty) await fs.writeFile(path.join(checkout, "unexpected.txt"), "uncommitted");
  const fixturePath = path.join(directory, "fixture.json"), logPath = path.join(directory, "calls.jsonl");
  await fs.writeFile(fixturePath, JSON.stringify(f));
  const result = spawnSync(process.execPath, [path.join(checkout, "qa/final-publication/publish.mjs"), mode], {
    cwd: checkout, encoding: "utf8", timeout: 20000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GH_TOKEN: "offline-fixture-token", GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: f.revision, GITHUB_REF: "refs/heads/master", GITHUB_EVENT_NAME: "workflow_dispatch", FAKE_GH_FIXTURE: fixturePath, FAKE_GH_LOG: logPath, ...f.env },
  });
  const calls = await fs.readFile(logPath, "utf8").then((text) => text.trim().split("\n").filter(Boolean).map(JSON.parse), (error) => { if (error.code === "ENOENT") return []; throw error; });
  return { result, calls, f, writes: calls.filter((row) => row.method !== "GET") };
}

test("real entrypoint permits exactly one tag-preserving publication PATCH and verifies canonical latest/tag/assets", async (t) => {
  const { result, calls, f, writes } = await runEntrypoint(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, ["api", "--method", "PATCH", `${api}/releases/${RELEASE_ID}`, "--input", "-"]);
  assert.deepEqual(writes[0].input, { tag_name: TAG, target_commitish: f.revision, draft: false, body: f.body, make_latest: "true" });
  assert.equal(calls.filter((row) => row.endpoint.includes("/releases/assets/")).length, 8);
  assert.ok(calls.some((row) => row.endpoint === `${api}/releases/latest`));
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.published, true); assert.equal(report.latest, true); assert.equal(report.applicationAcceptance, false);
  assert.equal(report.assetsPreserved, 14); assert.equal(report.tagCommitVerified, f.revision);
});

test("real entrypoint read-only preflight never writes", async (t) => {
  const { result, writes } = await runEntrypoint(t, () => {}, "check");
  assert.equal(result.status, 0, result.stderr); assert.equal(writes.length, 0);
});

for (const [name, mutate] of [
  ["unreviewed lock", (f) => { f.lock.reviewed = false; }],
  ["changed notes", (f) => { f.body += "changed"; }],
  ["wrong repository environment", (f) => { f.env = { GITHUB_REPOSITORY: "other/repo" }; }],
  ["wrong checkout revision", (f) => { f.env = { GITHUB_SHA: "f".repeat(40) }; }],
  ["dirty checkout", (f) => { f.dirty = true; }],
  ["private repository", (f) => { f.repository.private = true; }],
  ["nonmaster default", (f) => { f.repository.default_branch = "main"; }],
  ["master mismatch", (f) => { f.branchMismatch = true; }],
  ["master race before PATCH", (f) => { f.raceBranch = true; }],
  ["different draft ID", (f) => { f.release.id++; }],
  ["different tag", (f) => { f.release.tag_name = "v0.2.1"; }],
  ["different original target", (f) => { f.release.target_commitish = "master"; }],
  ["already published", (f) => { f.release.draft = false; }],
  ["prerelease", (f) => { f.release.prerelease = true; }],
  ["missing asset", (f) => { f.release.assets.pop(); }],
  ["extra asset", (f) => { f.release.assets.push({ ...f.release.assets[0], id: 99 }); }],
  ["replaced asset", (f) => { f.release.assets[0].id++; }],
  ["changed server digest", (f) => { f.release.assets[0].digest = "sha256:" + "e".repeat(64); }],
  ["changed asset bytes", (f) => { f.release.assets[0].size++; }],
  ["not uploaded", (f) => { f.release.assets[0].state = "starter"; }],
  ["separate asset inventory differs", (f) => { f.assetInventory = f.release.assets.slice(1); }],
  ["tag exists elsewhere", (f) => { f.tagTarget = SOURCE; }],
  ["truncated tree", (f) => { f.originalTree.truncated = true; }],
  ["shipping change", (f) => { f.candidateTree.tree.find((row) => row.path === "package-lock.json").sha = "f".repeat(40); }],
  ["shipping mode change", (f) => { f.candidateTree.tree.find((row) => row.path === "src/runtime.ts").mode = "100755"; }],
  ["receipt bytes differ", (f) => { f.contents["AgentVac-0.2.0-windows-x64-verification.json"] = Buffer.from("bad").toString("base64"); }],
  ["Windows QA run failed", (f) => { f.run.conclusion = "failure"; }],
  ["Windows QA job differs", (f) => { f.job.head_sha = SOURCE; }],
]) test(`real entrypoint rejects ${name} with zero writes`, async (t) => {
  const { result, writes } = await runEntrypoint(t, mutate);
  assert.notEqual(result.status, 0); assert.equal(writes.length, 0, result.stderr);
});

for (const flag of ["patchFailure", "badPatchResponse", "badLatest", "badPublishedTag"])
  test(`real entrypoint never retries after ${flag}`, async (t) => {
    const { result, writes } = await runEntrypoint(t, (f) => { f[flag] = true; });
    assert.notEqual(result.status, 0); assert.equal(writes.length, 1);
    assert.match(result.stderr, /inspect canonical release\/tag state/);
  });
