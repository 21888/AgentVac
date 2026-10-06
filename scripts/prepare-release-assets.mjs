import assert from "node:assert/strict";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifySourceManifest } from "./release-draft.mjs";

export function releaseTargets(platform, arch) {
  assert.ok(arch === "x64" || (platform === "darwin" && arch === "arm64"));
  if (platform === "linux")
    return { platform: "linux", targets: ["linux-tar"] };
  if (platform === "win32")
    return {
      platform: "windows",
      targets: ["windows-portable", "windows-setup"],
    };
  assert.equal(platform, "darwin");
  return {
    platform: "macos",
    targets: [`macos-${arch}-zip`, `macos-${arch}-dmg`],
  };
}
const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
export function validatePackageReceipt(row, revision) {
  assert.equal(row.schemaVersion, 1);
  assert.equal(row.sourceRevision, revision);
  assert.equal(row.status, "PASS");
  assert.equal(row.payloadVerification?.status, "PASS");
  assert.match(row.payloadVerification.manifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(row.payloadVerification.fileCount) &&
      row.payloadVerification.fileCount > 0,
  );
  assert.equal(row.nativeAcceptance?.status, "PASS_PACKAGED_SMOKE_ONLY");
  assert.equal(row.nativeAcceptance.packagedRuntimeVerified, true);
  assert.equal(row.packagedReaders?.status, "PASS");
  assert.equal(row.cleanup?.status, "PASS");
  assert.ok(row.artifact && row.artifactAfter);
  assert.equal(row.artifactAfter.sha256, row.artifact.sha256);
  assert.equal(row.artifactAfter.bytes, row.artifact.bytes);
  assert.match(row.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(row.artifact.bytes) && row.artifact.bytes > 0);
  assert.equal(row.payloadVerification.runtimeBindings?.length, 2);
  assert.ok(
    row.payloadVerification.runtimeBindings.every(
      (binding) =>
        binding.status === "PASS" &&
        binding.artifactSha256 === row.artifact.sha256,
    ),
  );
  if (row.target === "windows-setup") {
    assert.equal(row.installer?.tested, true);
    assert.equal(row.installer.status, "PASS");
    for (const field of [
      "installedLaunchVerified",
      "directoryRemoved",
      "productRegistryRemoved",
      "shortcutsRemoved",
    ])
      assert.equal(row.installer[field], true);
  }
}
async function main() {
  const revision = process.env.GITHUB_SHA;
  assert.match(revision ?? "", /^[a-f0-9]{40}$/);
  assert.equal(process.arch, process.env.AGENTVAC_EXPECTED_ARCH);
  const sourceDigest = await verifySourceManifest();
  const selected = releaseTargets(process.platform, process.arch),
    files = [],
    packages = [];
  for (const target of selected.targets) {
    const row = JSON.parse(
      await fs.readFile(
        path.join(".qa/release-package", target, "result.json"),
        "utf8",
      ),
    );
    validatePackageReceipt(row, revision);
    assert.equal(row.target, target);
    const artifact = path.resolve(row.artifact.path),
      st = await fs.lstat(artifact);
    assert.ok(artifact.startsWith(path.resolve("release-final") + path.sep));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.size, row.artifact.bytes);
    assert.equal(await hashFile(artifact), row.artifact.sha256);
    const name = path.basename(artifact);
    assert.equal(name, row.artifact.name);
    files.push({
      name,
      path: path.relative(process.cwd(), artifact).replaceAll(path.sep, "/"),
      bytes: st.size,
      sha256: row.artifact.sha256,
    });
    packages.push({
      target,
      status: row.status,
      artifact: { name, bytes: st.size, sha256: row.artifact.sha256 },
      payloadVerification: {
        status: row.payloadVerification.status,
        manifestSha256: row.payloadVerification.manifestSha256,
        fileCount: row.payloadVerification.fileCount,
        symlinkCount: row.payloadVerification.symlinkCount,
      },
      installerTested: row.installer?.tested === true,
    });
  }
  const stageResults = JSON.parse(
    process.env.AGENTVAC_RELEASE_STAGE_RESULTS ?? "{}",
  );
  for (const required of [
    "units",
    "build",
    "durability",
    "readers",
    "packages",
    "packageSmoke",
  ])
    assert.equal(
      stageResults[required],
      "success",
      `Missing successful ${required} stage`,
    );
  if (process.platform === "win32")
    assert.equal(
      stageResults.cursorBoundary,
      "success",
      "Windows disabled-boundary check must pass",
    );
  const prefix = `AgentVac-0.2.0-${selected.platform}-${process.arch}`;
  await fs.mkdir(".qa/release-assets", { recursive: true });
  const receipt = {
    format: "agentvac-release-package-verification-v1",
    sourceRevision: revision,
    sourceDigest,
    ciRunId: process.env.GITHUB_RUN_ID,
    ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: selected.platform,
    arch: process.arch,
    stageResults,
    packages,
    allPackagePathsPassed: true,
    applicationAcceptance: false,
    publication: false,
    scope:
      "Draft packages only. Source-native failures remain failures; maintainers must review every required gate and accepted limitation before publication.",
  };
  const outputs = [
    [`${prefix}-verification.json`, JSON.stringify(receipt, null, 2) + "\n"],
    [
      `${prefix}-SHA256SUMS.txt`,
      files.map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n",
    ],
  ];
  for (const [name, content] of outputs) {
    const file = path.join(".qa/release-assets", name);
    await fs.writeFile(file, content, { flag: "wx" });
    files.push({
      name,
      path: file.replaceAll(path.sep, "/"),
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  await fs.writeFile(
    ".qa/release-assets/asset-list.json",
    JSON.stringify({ ...receipt, files }, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
