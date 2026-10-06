import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  validateDraft,
  reviewedEmptyDraft,
  reviewedRetargetPayload,
  resolveReleaseTag,
  requireTagTarget,
  validateAssetManifest,
  verifySourceManifest,
} from "../scripts/release-draft.mjs";
import {
  validatePackageReceipt,
  releaseTargets,
} from "../scripts/prepare-release-assets.mjs";
const sha = "a".repeat(40),
  hash = "b".repeat(64);
test("draft validation rejects published, foreign, absent and changed releases", () => {
  const draft = {
    id: 1,
    tag_name: "v0.2.0",
    draft: true,
    target_commitish: sha,
    assets: [],
  };
  assert.equal(validateDraft(draft, sha), 1);
  for (const change of [
    { draft: false },
    { tag_name: "v0.1.0" },
    { target_commitish: "master" },
    { id: 0 },
    { assets: null },
  ])
    assert.throws(() => validateDraft({ ...draft, ...change }, sha));
});
function assets(platform = "windows", arch = "x64") {
  const prefix = `AgentVac-0.2.0-${platform}-${arch}`;
  const ext =
    platform === "windows"
      ? ["-portable.exe", "-setup.exe"]
      : platform === "macos"
        ? [".zip", ".dmg"]
        : [".tar.gz"];
  return {
    sourceRevision: sha,
    platform,
    arch,
    allPackagePathsPassed: true,
    applicationAcceptance: false,
    files: [...ext, "-SHA256SUMS.txt", "-verification.json"].map((x) => ({
      name: prefix + x,
      bytes: 1,
      sha256: hash,
    })),
  };
}
test("draft asset receipt requires every exact artifact and never claims application acceptance", () => {
  for (const [p, a] of [
    ["linux", "x64"],
    ["windows", "x64"],
    ["macos", "x64"],
    ["macos", "arm64"],
  ])
    assert.doesNotThrow(() => validateAssetManifest(assets(p, a), sha));
  for (const change of [
    { applicationAcceptance: true },
    { allPackagePathsPassed: false },
    { sourceRevision: "other" },
    { arch: "arm64" },
    { files: [] },
  ])
    assert.throws(() => validateAssetManifest({ ...assets(), ...change }, sha));
  const missing = assets();
  missing.files.pop();
  assert.throws(() => validateAssetManifest(missing, sha));
  const duplicate = assets();
  duplicate.files[1] = duplicate.files[0];
  assert.throws(() => validateAssetManifest(duplicate, sha));
  const foreign = assets();
  foreign.files[0].name = "private.txt";
  assert.throws(() => validateAssetManifest(foreign, sha));
});
test("package receipt must bind passed exact payload and unchanged artifact", () => {
  const receipt = {
    schemaVersion: 1,
    sourceRevision: sha,
    status: "PASS",
    payloadVerification: {
      status: "PASS",
      manifestSha256: hash,
      fileCount: 4,
      runtimeBindings: [
        { status: "PASS", artifactSha256: hash },
        { status: "PASS", artifactSha256: hash },
      ],
    },
    nativeAcceptance: {
      status: "PASS_PACKAGED_SMOKE_ONLY",
      packagedRuntimeVerified: true,
    },
    packagedReaders: { status: "PASS" },
    cleanup: { status: "PASS" },
    artifact: { bytes: 1, sha256: hash },
    artifactAfter: { bytes: 1, sha256: hash },
  };
  assert.doesNotThrow(() => validatePackageReceipt(receipt, sha));
  for (const change of [
    { status: "BLOCKED" },
    { sourceRevision: "other" },
    { payloadVerification: { status: "UNTESTED" } },
    { artifactAfter: { bytes: 2, sha256: hash } },
    { artifactAfter: { bytes: 1, sha256: "c".repeat(64) } },
  ])
    assert.throws(() => validatePackageReceipt({ ...receipt, ...change }, sha));
  assert.deepEqual(releaseTargets("win32", "x64").targets, [
    "windows-portable",
    "windows-setup",
  ]);
  assert.throws(() => releaseTargets("win32", "arm64"));
});
test("source inventory checks every byte and refuses traversal, duplicates and links", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentvac-release-source-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/file.ts"), "fixture");
  const file = {
    path: "src/file.ts",
    bytes: 7,
    sha256: createHash("sha256").update("fixture").digest("hex"),
  };
  const write = async (files) =>
    fs.writeFile(
      path.join(root, "SOURCE-SHA256.json"),
      JSON.stringify({
        format: "agentvac-source-sha256-v1",
        files,
        sourceDigest: createHash("sha256")
          .update(JSON.stringify(files))
          .digest("hex"),
      }),
    );
  await write([file]);
  await verifySourceManifest(root);
  for (const files of [
    [],
    [file, file],
    [{ ...file, path: "../file.ts" }],
    [{ ...file, path: "src/./file.ts" }],
    [{ ...file, path: "src//file.ts" }],
    [{ ...file, bytes: 6 }],
    [{ ...file, sha256: hash }],
  ]) {
    await write(files);
    await assert.rejects(verifySourceManifest(root));
  }
  await write([file]);
  await fs.writeFile(path.join(root, file.path), "changed");
  await assert.rejects(verifySourceManifest(root));
});

test("reviewed draft retarget binds exact empty draft, prior source and unchanged tag", () => {
  const release = {
    id: reviewedEmptyDraft.id,
    tag_name: reviewedEmptyDraft.oldTag,
    draft: true,
    target_commitish: reviewedEmptyDraft.oldTarget,
    assets: [],
  };
  assert.deepEqual(reviewedRetargetPayload(release, sha, null, true), {
    tag_name: "v0.2.0",
    target_commitish: sha,
  });
  assert.deepEqual(reviewedRetargetPayload(release, sha, sha, true), {
    tag_name: "v0.2.0",
    target_commitish: sha,
  });
  for (const change of [
    { id: 1 },
    { draft: false },
    { tag_name: "other" },
    { target_commitish: "c".repeat(40) },
    { assets: [{ id: 9 }] },
    { assets: null },
  ])
    assert.throws(() =>
      reviewedRetargetPayload({ ...release, ...change }, sha, null, true),
    );
  assert.throws(() => reviewedRetargetPayload(release, sha, null, false));
  assert.throws(() =>
    reviewedRetargetPayload(release, sha, reviewedEmptyDraft.oldTarget, true),
  );
  assert.throws(() => reviewedRetargetPayload(release, "master", null, true));
});
test("release tag resolver is read-only bounded and never accepts another commit", () => {
  assert.equal(
    resolveReleaseTag(() => "[]"),
    null,
  );
  const ref = (object) => JSON.stringify([{ ref: "refs/tags/v0.2.0", object }]);
  assert.equal(
    resolveReleaseTag(() => ref({ type: "commit", sha })),
    sha,
  );
  let calls = 0;
  assert.equal(
    resolveReleaseTag(() =>
      ++calls === 1
        ? ref({ type: "tag", sha: "b".repeat(40) })
        : JSON.stringify({ object: { type: "commit", sha } }),
    ),
    sha,
  );
  assert.equal(calls, 2);
  assert.throws(() => resolveReleaseTag(() => ref({ type: "blob", sha })));
  assert.throws(() =>
    resolveReleaseTag(() => ref({ type: "commit", sha: "invalid" })),
  );
  calls = 0;
  assert.throws(() =>
    resolveReleaseTag(() =>
      ++calls === 1
        ? ref({ type: "tag", sha })
        : JSON.stringify({ object: { type: "tag", sha } }),
    ),
  );
  assert.throws(() => requireTagTarget("c".repeat(40), sha));
  assert.doesNotThrow(() => requireTagTarget(null, sha));
});
