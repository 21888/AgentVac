import test from "node:test";
import assert from "node:assert/strict";
import { releaseBuildArguments } from "../scripts/build-release-artifacts.mjs";

test("native package rows have bounded targets and never publish", () => {
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["win32", "x64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
  ]) {
    const args = releaseBuildArguments(platform, arch);
    assert.equal(args[args.indexOf("--publish") + 1], "never");
    assert.ok(args.includes(`--${arch}`));
    assert.equal(
      args.filter((a) => a.startsWith("-c.directories.output=")).length,
      1,
    );
  }
  for (const row of [
    ["linux", "arm64"],
    ["win32", "arm64"],
    ["darwin", "ia32"],
    ["other", "x64"],
  ])
    assert.throws(() => releaseBuildArguments(...row));
});
test("Windows portable and installer names cannot collide; no elevation or user-data removal", () => {
  const args = releaseBuildArguments("win32", "x64");
  assert.ok(
    args.includes(
      "-c.nsis.artifactName=AgentVac-${version}-windows-${arch}-setup.${ext}",
    ),
  );
  assert.ok(
    args.includes(
      "-c.portable.artifactName=AgentVac-${version}-windows-${arch}-portable.${ext}",
    ),
  );
  for (const option of [
    "perMachine=false",
    "allowElevation=false",
    "deleteAppDataOnUninstall=false",
  ])
    assert.ok(args.includes("-c.nsis." + option));
});
