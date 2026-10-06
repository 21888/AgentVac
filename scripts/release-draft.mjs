// Runner-only publication helper. Never publishes a release or overwrites assets.
import assert from "node:assert/strict";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY = "21888/AgentVac";
const TAG = "v0.2.0";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function validateDraft(release, revision) {
  assert.equal(release.tag_name, TAG);
  assert.equal(release.draft, true, "Refuse an already published release");
  assert.equal(
    release.target_commitish,
    revision,
    "Refuse another source revision",
  );
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  assert.ok(Array.isArray(release.assets));
  return release.id;
}
function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function findDraft() {
  const releases = JSON.parse(
    gh(["api", `repos/${REPOSITORY}/releases?per_page=100`]),
  );
  assert.ok(
    Array.isArray(releases) && releases.length < 100,
    "Release inventory needs explicit pagination review",
  );
  const matches = releases.filter((row) => row.tag_name === TAG);
  assert.ok(matches.length <= 1, "Ambiguous release inventory");
  return matches[0];
}
export function validateAssetName(name, platform, arch) {
  const prefix = `AgentVac-0.2.0-${platform}-${arch}`;
  const names =
    platform === "windows"
      ? [`${prefix}-portable.exe`, `${prefix}-setup.exe`]
      : platform === "macos"
        ? [`${prefix}.zip`, `${prefix}.dmg`]
        : [`${prefix}.tar.gz`];
  return [
    ...names,
    `${prefix}-SHA256SUMS.txt`,
    `${prefix}-verification.json`,
  ].includes(name);
}
export function validateAssetManifest(manifest, revision) {
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.allPackagePathsPassed, true);
  assert.equal(manifest.applicationAcceptance, false);
  assert.ok(["linux", "windows", "macos"].includes(manifest.platform));
  assert.ok(
    manifest.arch === "x64" ||
      (manifest.platform === "macos" && manifest.arch === "arm64"),
  );
  assert.ok(Array.isArray(manifest.files));
  assert.equal(manifest.files.length, manifest.platform === "linux" ? 3 : 4);
  const seen = new Set();
  for (const file of manifest.files) {
    assert.ok(validateAssetName(file.name, manifest.platform, manifest.arch));
    assert.ok(!seen.has(file.name));
    seen.add(file.name);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifySourceManifest(root = process.cwd()) {
  const source = JSON.parse(
    await fs.readFile(path.join(root, "SOURCE-SHA256.json"), "utf8"),
  );
  assert.equal(source.format, "agentvac-source-sha256-v1");
  assert.ok(
    Array.isArray(source.files) &&
      source.files.length > 0 &&
      source.files.length <= 5000,
  );
  assert.equal(source.sourceDigest, digest(JSON.stringify(source.files)));
  const seen = new Set();
  let totalBytes = 0;
  for (const row of source.files) {
    assert.ok(
      typeof row.path === "string" &&
        /^[A-Za-z0-9_./-]+$/.test(row.path) &&
        !path.isAbsolute(row.path) &&
        !row.path.includes("\\") &&
        row.path
          .split("/")
          .every((part) => part && part !== "." && part !== "..") &&
        !seen.has(row.path),
    );
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        row.bytes <= 16 * 1024 * 1024,
    );
    totalBytes += row.bytes;
    assert.ok(totalBytes <= 64 * 1024 * 1024);
    seen.add(row.path);
    let parent = root;
    for (const component of row.path.split("/").slice(0, -1)) {
      parent = path.join(parent, component);
      const st = await fs.lstat(parent);
      assert.ok(st.isDirectory() && !st.isSymbolicLink());
    }
    const file = path.join(root, row.path),
      st = await fs.lstat(file);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.size, row.bytes);
    assert.equal(
      await hashFile(file),
      row.sha256,
      `Source changed: ${row.path}`,
    );
  }
  return source.sourceDigest;
}
async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.ok(process.env.GH_TOKEN, "Runner token missing");
  const revision = process.env.GITHUB_SHA;
  await verifySourceManifest();
  if (process.argv[2] === "ensure") {
    let release = findDraft();
    if (!release) {
      gh([
        "release",
        "create",
        TAG,
        "--repo",
        REPOSITORY,
        "--draft",
        "--latest=false",
        "--target",
        revision,
        "--title",
        "AgentVac 0.2.0",
        "--notes-file",
        "docs/RELEASE-NOTES-0.2.0.md",
      ]);
      release = findDraft();
    }
    const id = validateDraft(release, revision);
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, `release_id=${id}\n`);
    console.log(
      JSON.stringify({
        draft: true,
        releaseId: id,
        sourceRevision: revision,
        publication: false,
      }),
    );
    return;
  }
  assert.equal(process.argv[2], "upload");
  const manifest = JSON.parse(
    await fs.readFile(".qa/release-assets/asset-list.json", "utf8"),
  );
  validateAssetManifest(manifest, revision);
  let release = findDraft();
  validateDraft(release, revision);
  assert.equal(String(release.id), process.env.AGENTVAC_DRAFT_RELEASE_ID);
  for (const row of manifest.files) {
    assert.ok(validateAssetName(row.name, manifest.platform, manifest.arch));
    assert.equal(path.basename(row.path), row.name);
    const absolute = path.resolve(row.path);
    assert.ok(
      absolute.startsWith(path.resolve("release-final") + path.sep) ||
        absolute.startsWith(path.resolve(".qa/release-assets") + path.sep),
    );
    const st = await fs.lstat(absolute);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.size, row.bytes);
    assert.equal(await hashFile(absolute), row.sha256);
    assert.ok(
      !release.assets.some((asset) => asset.name === row.name),
      "Existing assets require maintainer review; never clobber",
    );
    gh(["release", "upload", TAG, absolute, "--repo", REPOSITORY]);
    release = findDraft();
    validateDraft(release, revision);
    const matches = release.assets.filter((asset) => asset.name === row.name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].size, row.bytes);
    assert.equal(
      matches[0].digest,
      `sha256:${row.sha256}`,
      "Uploaded asset digest is unavailable or differs",
    );
    console.log(
      JSON.stringify({
        draftAsset: row.name,
        bytes: row.bytes,
        sha256: row.sha256,
        verified: true,
      }),
    );
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
