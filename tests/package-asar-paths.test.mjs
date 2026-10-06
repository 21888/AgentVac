import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { asarMemberPath, portableAsarEntry } from "../scripts/package-asar-paths.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const filesystemFile = path.join(path.dirname(require.resolve("@electron/asar")), "filesystem.js");
const filesystemSource = await fs.readFile(filesystemFile, "utf8");
const filesystemRequire = createRequire(filesystemFile);

// Execute the installed dependency itself with only its path module replaced.
// This reproduces its Win32 header traversal on any test host, without claiming
// native Windows package execution. No production global or API is patched.
function headerFilesystem(hostPath) {
  const exports = {};
  vm.runInNewContext(filesystemSource, {
    exports,
    require: (name) => name === "path" ? hostPath : filesystemRequire(name),
    Buffer, BigInt,
  }, { filename: filesystemFile });
  const instance = new exports.Filesystem("generated-asar");
  instance.setHeader({ files: {
    dist: { files: { assets: { files: { "index-fixture.css": { size: 3, offset: "0" } } } } },
    "dist-electron": { files: { "cursor-sql-worker.cjs": { size: 6, unpacked: true } } },
  } }, 0);
  return instance;
}

test("installed ASAR reproduces the Windows forward-slash member failure", () => {
  const windows = headerFilesystem(path.win32);
  assert.throws(() => windows.getFile("dist/assets/index-fixture.css"), /was not found/);
  // A one-directory helper happened to work because dirname had no separator;
  // use native paths consistently without claiming that lookup also failed.
  assert.equal(windows.getFile("dist-electron/cursor-sql-worker.cjs").unpacked, true);
});

for (const [name, hostPath] of [["Win32", path.win32], ["POSIX", path.posix]]) {
  test(`${name} ASAR resolves renderer and unpacked helper members with native paths`, () => {
    const archive = headerFilesystem(hostPath);
    assert.equal(archive.getFile(asarMemberPath("dist/assets/index-fixture.css", hostPath)).size, 3);
    assert.equal(archive.getFile(asarMemberPath("dist-electron/cursor-sql-worker.cjs", hostPath)).unpacked, true);
    assert.throws(() => archive.getFile(asarMemberPath("dist/assets/missing.css", hostPath)), /was not found/);
  });
  test(`${name} ASAR listing normalization preserves the strict package allowlist`, () => {
    const archive = headerFilesystem(hostPath);
    const allowed = /^\/(dist(?:-electron)?(?:\/|$)|build(?:\/|$)|package\.json$)/;
    const entries = archive.listFiles().map((entry) => portableAsarEntry(entry, hostPath));
    assert.ok(entries.length > 0 && entries.every((entry) => allowed.test(entry)));
    assert.ok(entries.includes("/dist/assets/index-fixture.css"));
    for (const unexpected of [hostPath.join("/", "secrets", "fixture.txt"), hostPath.join("/", "node_modules")])
      assert.equal(allowed.test(portableAsarEntry(unexpected, hostPath)), false);
  });
}

test("actual host ASAR retains exact renderer bytes and external helper bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-asar-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), archive = path.join(root, "fixture.asar");
  const members = new Map([
    ["dist/assets/index-fixture.css", Buffer.from(".fixture { color: #123; }\n")],
    ["dist-electron/cursor-sql-worker.cjs", Buffer.from("// generated helper fixture\n")],
  ]);
  for (const [member, bytes] of members) {
    const file = path.join(source, member);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  await asar.createPackageWithOptions(source, archive, { unpack: "**/cursor-sql-worker.cjs" });
  for (const [member, bytes] of members)
    assert.deepEqual(asar.extractFile(archive, asarMemberPath(member)), bytes);
  assert.equal(asar.statFile(archive, asarMemberPath("dist-electron/cursor-sql-worker.cjs")).unpacked, true);
  assert.deepEqual(await fs.readFile(path.join(archive + ".unpacked", "dist-electron/cursor-sql-worker.cjs")), members.get("dist-electron/cursor-sql-worker.cjs"));
});
