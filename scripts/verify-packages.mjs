// Read-only package checks. This does not launch any packaged desktop application.
import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const base = path.resolve(process.argv[2] || "release-final");
import { selectPackageTargets } from "./package-targets.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function files(dir) {
  let out = [];
  for (const name of await fs.readdir(dir)) {
    const p = path.join(dir, name);
    const s = await fs.lstat(p);
    if (s.isDirectory()) out.push(...(await files(p)));
    else if (s.isFile()) out.push(p);
  }
  return out;
}
const expected = [
  ...(await files("dist")),
  ...(await files("dist-electron")),
  "build/icon.png",
];
const report = [];
const onlyPlatform = process.argv[3];
const onlyArch = process.argv[4];
for (const target of selectPackageTargets(onlyPlatform, onlyArch)) {
  const app = path.join(base, target.app);
  const resources = path.join(
    app,
    target.platform === "macos" ? "Resources" : "resources",
  );
  const archive = path.join(resources, "app.asar");
  for (const file of expected)
    assert.deepEqual(
      asar.extractFile(archive, file.replaceAll(path.sep, "/")),
      await fs.readFile(file),
      `${target.platform}/${target.arch}: ${file} differs from tested build`,
    );
  const unpackedHelpers = {};
  for (const name of [
    "diagnostic-supervisor.cjs",
    "diagnostic-worker.cjs",
    "cursor-sql-worker.cjs",
    "process-argv-worker.cjs",
  ]) {
    const relative = "dist-electron/" + name;
    assert.equal(
      asar.statFile(archive, relative).unpacked,
      true,
      `${target.platform}/${target.arch}: helper must be outside ASAR`,
    );
    const helper = await fs.readFile(
      path.join(archive + ".unpacked", relative),
    );
    assert.deepEqual(
      helper,
      await fs.readFile(relative),
      `unpacked helper differs: ${relative}`,
    );
    unpackedHelpers[name] = { bytes: helper.length, sha256: hash(helper) };
  }
  const entries = asar.listPackage(archive);
  assert.ok(
    entries.every((entry) =>
      /^\/(dist(?:-electron)?(?:\/|$)|build(?:\/|$)|package\.json$)/.test(
        entry,
      ),
    ),
    "unexpected packaged source or data",
  );
  const meta = JSON.parse(asar.extractFile(archive, "package.json").toString());
  assert.equal(meta.name, "agentvac");
  assert.equal(meta.main, "dist-electron/main.cjs");
  const executable = await fs.readFile(path.join(app, target.exe));
  if (target.kind === "elf") {
    assert.equal(executable.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(executable.readUInt16LE(18), 62);
  }
  if (target.kind === "pe") {
    assert.equal(executable.subarray(0, 2).toString(), "MZ");
    const pos = executable.readUInt32LE(0x3c);
    assert.equal(executable.readUInt32LE(pos), 0x4550);
    assert.equal(executable.readUInt16LE(pos + 4), 0x8664);
  }
  if (target.kind === "macho") {
    assert.equal(executable.readUInt32LE(0), 0xfeedfacf);
    assert.equal(
      executable.readUInt32LE(4),
      target.arch === "arm64" ? 0x0100000c : 0x01000007,
    );
  }
  const notices = {};
  for (const name of [
    "LICENSE.agentvac.txt",
    "THIRD-PARTY-NOTICES.txt",
    "LICENSE.electron.txt",
    "LICENSES.chromium.html",
  ]) {
    const b = await fs.readFile(path.join(resources, name));
    assert.ok(b.length > 100);
    notices[name] = { bytes: b.length, sha256: hash(b) };
  }
  report.push({
    platform: target.platform,
    arch: target.arch,
    app: target.app,
    asarBytes: (await fs.stat(archive)).size,
    asarSha256: hash(await fs.readFile(archive)),
    verifiedFiles: expected.length,
    architectureVerified: true,
    notices,
    unpackedHelpers,
    nativeExecuted: false,
  });
  console.log(
    "PASS packaged build, architecture and notices:",
    target.platform,
    target.arch,
  );
}
await fs.writeFile(
  onlyPlatform
    ? `docs/package-verification-${onlyPlatform}${onlyArch ? "-" + onlyArch : ""}.json`
    : "docs/package-verification.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scope:
        "Read-only unpacked package structure, exact tested renderer/main/preload bytes and target CPU architecture; NOT native runtime acceptance",
      targets: report,
    },
    null,
    2,
  ),
);
