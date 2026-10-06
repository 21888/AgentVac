import test from "node:test";
import assert from "node:assert/strict";
import { selectPackageTargets } from "../scripts/package-targets.mjs";
test("default package verification still covers all four published artifact targets", () => {
  assert.deepEqual(
    selectPackageTargets().map((t) => `${t.platform}/${t.arch}`),
    ["linux/x64", "windows/x64", "macos/x64", "macos/arm64"],
  );
});
test("existing macOS platform-only call still requires both architectures", () => {
  assert.deepEqual(
    selectPackageTargets("macos").map((t) => t.arch),
    ["x64", "arm64"],
  );
});
for (const arch of ["x64", "arm64"])
  test(`single native Mac ${arch} selects exactly its matching package`, () => {
    const selected = selectPackageTargets("macos", arch);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].arch, arch);
    assert.equal(selected[0].kind, "macho");
    assert.equal(
      selected[0].app,
      arch === "arm64"
        ? "macos/mac-arm64/AgentVac.app/Contents"
        : "macos/mac/AgentVac.app/Contents",
    );
  });
test("explicit x64 keeps the existing Windows and Linux package locations", () => {
  assert.equal(
    selectPackageTargets("windows", "x64")[0].app,
    "windows/win-unpacked",
  );
  assert.equal(
    selectPackageTargets("linux", "x64")[0].app,
    "linux/linux-unpacked",
  );
});
test("unsupported, empty and malformed filters cannot silently produce no verification", () => {
  for (const [platform, arch] of [
    ["linux", "arm64"],
    ["windows", "arm64"],
    ["macOS", "x64"],
    ["", "x64"],
    ["macos", ""],
    ["macos", "ARM64"],
    ["macos", "x64\n"],
    [undefined, "x64"],
  ])
    assert.throws(() => selectPackageTargets(platform, arch));
});
