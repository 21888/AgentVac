// One native build per runner. Never signs, publishes, installs or changes OS policy.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function releaseBuildArguments(platform, arch) {
  assert.ok(arch === "x64" || (platform === "darwin" && arch === "arm64"));
  const common = ["--publish", "never", `--${arch}`];
  if (platform === "linux")
    return [
      "--linux",
      "tar.gz",
      ...common,
      "-c.directories.output=release-final/linux",
      "-c.linux.artifactName=AgentVac-${version}-linux-${arch}.${ext}",
    ];
  if (platform === "darwin")
    return [
      "--mac",
      "dmg",
      "zip",
      ...common,
      "-c.directories.output=release-final/macos",
      "-c.mac.artifactName=AgentVac-${version}-macos-${arch}.${ext}",
    ];
  assert.equal(platform, "win32");
  return [
    "--win",
    "nsis",
    "portable",
    ...common,
    "-c.directories.output=release-final/windows",
    "-c.nsis.artifactName=AgentVac-${version}-windows-${arch}-setup.${ext}",
    "-c.portable.artifactName=AgentVac-${version}-windows-${arch}-portable.${ext}",
    "-c.nsis.perMachine=false",
    "-c.nsis.allowElevation=false",
    "-c.nsis.deleteAppDataOnUninstall=false",
  ];
}

async function main() {
  const require = createRequire(import.meta.url);
  const meta = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.equal(meta.version, "0.2.0");
  assert.equal(process.arch, process.env.AGENTVAC_EXPECTED_ARCH);
  const args = releaseBuildArguments(process.platform, process.arch);
  await fs.access("dist-electron/main.cjs");
  const child = spawn(
    process.execPath,
    [require.resolve("electron-builder/out/cli/cli.js"), ...args],
    {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      signal ? reject(Error("Release builder terminated")) : resolve(code),
    );
  });
  assert.equal(code, 0, "Native package generation failed");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
