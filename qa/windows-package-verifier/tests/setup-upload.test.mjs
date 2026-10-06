import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { SOURCE, RELEASE_ID, OMITTED_PORTABLE, uploadSetupAssets } from "../run.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-setup-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ["AgentVac-0.2.0-linux-x64.tar.gz", "AgentVac-0.2.0-linux-x64-SHA256SUMS.txt", "AgentVac-0.2.0-linux-x64-verification.json", ...["x64", "arm64"].flatMap((arch) => [`AgentVac-0.2.0-macos-${arch}.zip`, `AgentVac-0.2.0-macos-${arch}.dmg`, `AgentVac-0.2.0-macos-${arch}-SHA256SUMS.txt`, `AgentVac-0.2.0-macos-${arch}-verification.json`])];
  const release = { id: RELEASE_ID, tag_name: "v0.2.0", target_commitish: SOURCE, draft: true, assets: names.map((name, i) => ({ name, id: i + 1, size: 10, digest: "sha256:" + "a".repeat(64) })) };
  const manifest = { sourceRevision: SOURCE, platform: "windows", arch: "x64", allPackagePathsPassed: true, applicationAcceptance: false, selectedTargets: ["windows-setup"], omittedPortable: OMITTED_PORTABLE, files: [] };
  for (const suffix of ["setup.exe", "SHA256SUMS.txt", "verification.json"]) {
    const name = "AgentVac-0.2.0-windows-x64-" + suffix;
    const relative = (suffix === "setup.exe" ? "release-final/windows/" : ".qa/release-assets/") + name;
    const bytes = Buffer.from("generated fixture " + suffix);
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), bytes);
    manifest.files.push({ name, path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  let sends = 0;
  const hooks = { shippingRoot: root, readDraft: () => structuredClone(release), uploadFile: async (file) => {
    sends++; const bytes = await fs.readFile(file);
    release.assets.push({ name: path.basename(file), id: 100 + sends, size: bytes.length, digest: "sha256:" + digest(bytes) });
  } };
  return { root, release, manifest, hooks, sends: () => sends };
}
test("setup upload sends exactly three generated files and preserves existing eleven", async (t) => {
  const f = await fixture(t), original = structuredClone(f.release.assets);
  await uploadSetupAssets(f.manifest, f.hooks);
  assert.equal(f.sends(), 3); assert.equal(f.release.assets.length, 14);
  assert.deepEqual(f.release.assets.slice(0, 11), original);
  assert.equal(f.release.assets.some((row) => row.name.endsWith("-portable.exe")), false);
});
for (const bad of ["published", "wrong-source", "existing-windows", "changed-last-file", "escaped-path", "portable-selection"])
  test(`setup upload preflight ${bad} produces zero sends`, async (t) => {
    const f = await fixture(t);
    if (bad === "published") f.release.draft = false;
    if (bad === "wrong-source") f.release.target_commitish = "b".repeat(40);
    if (bad === "existing-windows") f.release.assets.push({ name: "AgentVac-0.2.0-windows-x64-setup.exe" });
    if (bad === "changed-last-file") await fs.appendFile(path.join(f.root, f.manifest.files[2].path), "changed");
    if (bad === "escaped-path") f.manifest.files[0].path = "../" + f.manifest.files[0].name;
    if (bad === "portable-selection") f.manifest.selectedTargets.push("windows-portable");
    await assert.rejects(uploadSetupAssets(f.manifest, f.hooks)); assert.equal(f.sends(), 0);
  });
for (const bad of ["server-digest", "existing-asset-change"])
  test(`setup upload stops after first send when ${bad} is observed`, async (t) => {
    const f = await fixture(t), upload = f.hooks.uploadFile;
    f.hooks.uploadFile = async (file) => { await upload(file); if (bad === "server-digest") f.release.assets.at(-1).digest = "sha256:" + "c".repeat(64); else f.release.assets[0].size++; };
    await assert.rejects(uploadSetupAssets(f.manifest, f.hooks)); assert.equal(f.sends(), 1);
  });
