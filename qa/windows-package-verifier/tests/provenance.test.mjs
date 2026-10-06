import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE, RELEASE_ID, PRIOR, mergeStageEvidence, validateExistingDraft, validatePreservedDraft, sourceChildEnvironment } from "../run.mjs";

const priorNames = [
  "AgentVac-0.2.0-linux-x64.tar.gz", "AgentVac-0.2.0-linux-x64-SHA256SUMS.txt", "AgentVac-0.2.0-linux-x64-verification.json",
  ...["x64", "arm64"].flatMap((arch) => [`AgentVac-0.2.0-macos-${arch}.zip`, `AgentVac-0.2.0-macos-${arch}.dmg`, `AgentVac-0.2.0-macos-${arch}-SHA256SUMS.txt`, `AgentVac-0.2.0-macos-${arch}-verification.json`]),
];
const asset = (name, index) => ({ id: index + 1, name, size: 100 + index, digest: `sha256:${String(index % 10).repeat(64)}` });
const draft = () => ({ id: RELEASE_ID, target_commitish: SOURCE, tag_name: "v0.2.0", draft: true, assets: priorNames.map(asset) });
const current = { overlayTests: "success", build: "success", packages: "success", packageBytes: "success", portable: "success", setup: "success" };

test("receipt separates prior unchanged-source checks from newly executed package checks", () => {
  const result = mergeStageEvidence(current);
  assert.equal(result.stageResults.providers, "failure");
  assert.equal(result.stageOrigins.units.kind, "prior-source-run");
  assert.equal(result.stageOrigins.units.jobId, 112519594642);
  assert.equal(result.stageOrigins.packageSmoke.kind, "current-qa-run");
  assert.deepEqual(PRIOR.units, { total: 1070, passed: 1026, failed: 0, skipped: 44, rerun: false });
  for (const field of Object.keys(current)) for (const status of [undefined, "failure", "skipped", "cancelled"])
    assert.throws(() => mergeStageEvidence({ ...current, [field]: status }));
});
test("child helper source revision does not replace the actual QA workflow provenance", () => {
  const parent = { GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "new-qa-run", ORDINARY_FIXTURE: "kept" };
  const result = sourceChildEnvironment(parent);
  assert.equal(result.GITHUB_SHA, SOURCE);
  assert.equal(result.AGENTVAC_WORKFLOW_QA_SHA, parent.GITHUB_SHA);
  assert.equal(result.GITHUB_RUN_ID, "new-qa-run");
  assert.equal(result.ORDINARY_FIXTURE, "kept");
  assert.equal(parent.GITHUB_SHA, "a".repeat(40));
  assert.throws(() => sourceChildEnvironment({}));
});
test("upload admission requires exact unpublished original-source draft and all eleven existing assets", () => {
  assert.equal(validateExistingDraft(draft()).length, 11);
  for (const delta of [{ id: RELEASE_ID + 1 }, { draft: false }, { tag_name: "v0.2.1" }, { target_commitish: "b".repeat(40) }, { assets: [] }])
    assert.throws(() => validateExistingDraft({ ...draft(), ...delta }));
  for (const change of [
    (r) => r.assets.push(asset("AgentVac-0.2.0-windows-x64-portable.exe", 15)),
    (r) => r.assets[0].digest = null,
    (r) => r.assets[0].size = 0,
    (r) => r.assets[0].name = "unrecognized.txt",
    (r) => r.assets[0].name = r.assets[1].name,
  ]) { const row = draft(); change(row); assert.throws(() => validateExistingDraft(row)); }
});
test("successful upload requires four Windows assets and byte-identical existing asset receipts", () => {
  const before = draft(), original = validateExistingDraft(before);
  const after = structuredClone(before);
  after.assets.push(...["portable.exe", "setup.exe", "SHA256SUMS.txt", "verification.json"].map((suffix, index) => asset(`AgentVac-0.2.0-windows-x64-${suffix}`, index + 20)));
  assert.doesNotThrow(() => validatePreservedDraft(after, original));
  for (const field of ["id", "size", "digest"]) { const changed = structuredClone(after); changed.assets[0][field] = field === "digest" ? "sha256:" + "f".repeat(64) : 999; assert.throws(() => validatePreservedDraft(changed, original)); }
  const missing = structuredClone(after); missing.assets.pop(); assert.throws(() => validatePreservedDraft(missing, original));
  assert.throws(() => validatePreservedDraft({ ...after, target_commitish: "c".repeat(40) }, original));
});
