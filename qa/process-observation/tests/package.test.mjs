import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  digest,
  inventory,
  checkedRead,
  checkRelative,
  sourceDirectories,
  sourceRootFiles,
  targetRelative,
  limits,
  outputFiles,
} from "../core.mjs";
const packageSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-observer-package-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = path.join(root, "qa/process-observation");
  await fs.mkdir(pkg, { recursive: true });
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  for (const dir of sourceDirectories)
    await write(`${dir}/fixture.txt`, `${dir} fixture\n`);
  for (const file of sourceRootFiles)
    await write(file, file.endsWith(".json") ? "{}\n" : `${file} fixture\n`);
  await write(
    "package.json",
    '{"name":"synthetic-agentvac","type":"module"}\n',
  );
  await write("electron/main.ts", "// original main\n");
  await write("electron/processes.ts", "// original guard\n");
  await write(
    "dist/index.html",
    "<!doctype html><title>synthetic fixture</title>\n",
  );
  await write("build/icon.png", "synthetic icon\n");
  const entries = outputFiles.filter((file) =>
    file.startsWith("dist-electron/"),
  );
  await write(
    "scripts/build-electron.mjs",
    `import { promises as fs } from 'node:fs'; await fs.mkdir('dist-electron'); for (const name of ${JSON.stringify(entries)}) await fs.writeFile(name, '// synthetic compiled fixture\\n');\n`,
  );
  await write(
    "scripts/build-native-provider-harness.mjs",
    `import { promises as fs } from 'node:fs'; await fs.mkdir('.qa/native-harness',{recursive:true}); await fs.writeFile('.qa/native-harness/native-provider-driver.mjs','// synthetic driver\\n'); await fs.writeFile('.qa/native-harness/build-receipt.json','{}\\n');\n`,
  );
  for (const file of ["core.mjs", "prepare.mjs", "verify.mjs"])
    await fs.copyFile(path.join(packageSource, file), path.join(pkg, file));
  for (const file of [
    "README.md",
    "core-observer.patch",
    "observer-overlay.patch",
    "tests/sentinel.test.mjs",
  ])
    await write(`qa/process-observation/${file}`, `// synthetic ${file}\n`);
  await write(
    "qa/process-observation/overlay/electron/main.ts",
    "// instrumented fixture main\n",
  );
  await write(
    "qa/process-observation/overlay/electron/process-observations.ts",
    "// instrumented fixture observer\n",
  );
  const sourceFiles = await inventory(root, sourceDirectories, sourceRootFiles);
  const overlay = await inventory(pkg, ["overlay"]);
  const packageFiles = await inventory(
    pkg,
    ["tests"],
    ["core.mjs", "README.md", "core-observer.patch", "observer-overlay.patch"],
  );
  const pins = {
    format: "agentvac-process-observer-source-pins-v1",
    target: targetRelative,
    sourceFiles,
    overlays: overlay.map((row) => ({ ...row, path: row.path.slice(8) })),
    packageFiles,
  };
  const pinBytes = JSON.stringify(pins, null, 2) + "\n";
  await fs.writeFile(path.join(pkg, "source-pins.json"), pinBytes);
  for (const file of ["prepare.mjs", "verify.mjs"]) {
    const content = await fs.readFile(path.join(pkg, file), "utf8");
    await fs.writeFile(
      path.join(pkg, file),
      content.replace(
        /const expectedPinsSha256\s*=\s*"[^"]+";/,
        `const expectedPinsSha256 = "${digest(pinBytes)}";`,
      ),
    );
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  function run(name = "prepare.mjs", args = [], options = {}) {
    return spawnSync(process.execPath, [path.join(pkg, name), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env,
      ...options,
    });
  }
  return {
    root,
    pkg,
    target: path.join(root, targetRelative),
    write,
    run,
    sourceFiles,
  };
}

test("fixed copy builds pinned fixture entries without changing original source and verifies receipts", async (t) => {
  const f = await fixture(t);
  const built = f.run();
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /AGENTVAC_INSTRUMENTED_BUILD/);
  assert.deepEqual(
    await inventory(f.root, sourceDirectories, sourceRootFiles),
    f.sourceFiles,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "electron/main.ts"), "utf8"),
    "// original main\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.target, "electron/main.ts"), "utf8"),
    "// instrumented fixture main\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.target, "electron/processes.ts"), "utf8"),
    "// original guard\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.target, "dist/index.html"), "utf8"),
    await fs.readFile(path.join(f.root, "dist/index.html"), "utf8"),
  );
  await assert.rejects(fs.lstat(path.join(f.target, "node_modules")), {
    code: "ENOENT",
  });
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(f.target, "process-observer-build.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.instrumented, true);
  assert.equal(receipt.productionAcceptance, false);
  assert.equal(receipt.nativeExecution, false);
  assert.equal(receipt.sourceDigestBefore, receipt.sourceDigestAfter);
  assert.equal(receipt.productionDigestBefore, receipt.productionDigestAfter);
  assert.equal(receipt.builtFiles.length, outputFiles.length);
  const verified = f.run("verify.mjs");
  assert.equal(verified.status, 0, verified.stderr);
});

test("existing generated target is never reused or changed", async (t) => {
  const f = await fixture(t);
  await f.write(`${targetRelative}/sentinel`, "preserve");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TARGET_EXISTS/);
  assert.equal(
    await fs.readFile(path.join(f.target, "sentinel"), "utf8"),
    "preserve",
  );
  assert.deepEqual(await fs.readdir(f.target), ["sentinel"]);
});

test("builder refuses source, overlay, pin, and package tampering before creating target", async (t) => {
  for (const [relative, expected] of [
    ["electron/processes.ts", "SOURCE_CHANGED"],
    ["qa/process-observation/overlay/electron/main.ts", "OVERLAY_CHANGED"],
    ["qa/process-observation/source-pins.json", "PINS_CHANGED"],
    ["qa/process-observation/README.md", "PACKAGE_CHANGED"],
  ]) {
    const f = await fixture(t);
    await fs.appendFile(path.join(f.root, relative), "\n");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
    await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  }
});

test("copy verification refuses modified output, copied input, original input, assets and receipts", async (t) => {
  for (const [where, relative, expected] of [
    ["target", "dist-electron/main.cjs", "BUILT_OUTPUT_CHANGED"],
    ["target", "electron/main.ts", "COPIED_SOURCE_CHANGED"],
    ["root", "electron/processes.ts", "SOURCE_CHANGED"],
    ["root", "dist/index.html", "RECEIPT_CHANGED"],
    ["target", "qa/process-observation/README.md", "COPIED_PACKAGE_CHANGED"],
  ]) {
    const f = await fixture(t);
    const built = f.run();
    assert.equal(built.status, 0, built.stderr);
    await fs.appendFile(path.join(f[where], relative), "\n");
    const result = f.run("verify.mjs");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
  }
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const receiptFile = path.join(f.target, "process-observer-build.json");
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  receipt.instrumented = false;
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  assert.match(f.run("verify.mjs").stderr, /INVALID_RECEIPT/);
});

test("symlink and hardlink source/asset/package input or .qa targets are refused", async (t) => {
  for (const [relative, kind] of [
    ["electron/main.ts", "symbolic"],
    ["electron/main.ts", "hard"],
    ["dist/index.html", "symbolic"],
    ["qa/process-observation/overlay/electron/main.ts", "symbolic"],
  ]) {
    const f = await fixture(t);
    const file = path.join(f.root, relative),
      saved = `${file}.outside`;
    await fs.rename(file, saved);
    if (kind === "hard") await fs.link(saved, file);
    else await fs.symlink(saved, file);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNSAFE_FILE/);
    await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  }
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "external"));
  await fs.symlink(path.join(f.root, "external"), path.join(f.root, ".qa"));
  assert.match(f.run().stderr, /LINKED_DIRECTORY/);
});

test("safe reads refuse directory links, special paths, oversize input, and hardlinks", async (t) => {
  const f = await fixture(t);
  for (const relative of [
    "../escape",
    "/absolute",
    "electron/../main",
    "electron//main",
    "electron\\main",
    ".",
    "a/" + "x/".repeat(13) + "file",
  ])
    assert.throws(() => checkRelative(relative), /INVALID_PATH/);
  await fs.mkdir(path.join(f.root, "linked-target"));
  await fs.symlink(
    path.join(f.root, "linked-target"),
    path.join(f.root, "linked"),
  );
  await assert.rejects(checkedRead(f.root, "linked/file"), /LINKED_DIRECTORY/);
  await f.write("oversize", "x".repeat(32));
  await assert.rejects(checkedRead(f.root, "oversize", 8), /UNSAFE_FILE/);
  await fs.link(path.join(f.root, "oversize"), path.join(f.root, "hardlink"));
  await assert.rejects(checkedRead(f.root, "hardlink"), /UNSAFE_FILE/);
});

test("inventory enforces file and total-byte limits", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "count"));
  for (let i = 0; i <= limits.files; i++)
    await f.write(`count/${String(i).padStart(5, "0")}`, "");
  await assert.rejects(inventory(f.root, ["count"]), /FILE_LIMIT/);
  await fs.mkdir(path.join(f.root, "volume"));
  for (let i = 0; i < 5; i++)
    await f.write(`volume/${i}`, Buffer.alloc(limits.fileBytes));
  await assert.rejects(inventory(f.root, ["volume"]), /BYTE_LIMIT/);
});

test("no arbitrary root, output, loader, or NODE_OPTIONS overrides are accepted", async (t) => {
  const f = await fixture(t);
  for (const [args, options] of [
    [["--root", f.root], {}],
    [["--out", "elsewhere"], {}],
    [[], { cwd: path.dirname(f.root) }],
    [[], { env: { ...process.env, NODE_OPTIONS: "--no-warnings" } }],
  ]) {
    const result = f.run("prepare.mjs", args, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNEXPECTED_EXECUTION/);
  }
  const result = spawnSync(
    process.execPath,
    ["--trace-warnings", path.join(f.pkg, "prepare.mjs")],
    { cwd: f.root, encoding: "utf8" },
  );
  assert.match(result.stderr, /UNEXPECTED_EXECUTION/);
});

test("unexpected build files and malformed receipt provenance cannot validate", async (t) => {
  const f = await fixture(t);
  const built = f.run();
  assert.equal(built.status, 0, built.stderr);
  const receiptFile = path.join(f.target, "process-observer-build.json");
  const original = await fs.readFile(receiptFile, "utf8");
  for (const patch of [
    { pinsSha256: null },
    { mode: "production" },
    { nativeExecution: true },
    { packagedArtifactTested: true },
  ]) {
    await fs.writeFile(
      receiptFile,
      JSON.stringify({ ...JSON.parse(original), ...patch }),
    );
    assert.match(f.run("verify.mjs").stderr, /INVALID_RECEIPT/);
  }
  await fs.writeFile(receiptFile, original);
  await fs.writeFile(
    path.join(f.target, "dist-electron/unexpected.cjs"),
    "// extra compiled input\n",
  );
  assert.match(f.run("verify.mjs").stderr, /BUILT_OUTPUT_CHANGED/);
});

test("directory enumeration is capped before unbounded names can be materialized", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "entries"));
  for (let index = 0; index <= limits.entriesPerDirectory; index++)
    await f.write(`entries/${String(index).padStart(5, "0")}`, "");
  await assert.rejects(inventory(f.root, ["entries"]), /ENTRY_LIMIT/);
  await fs.mkdir(path.join(f.root, "aggregate"));
  for (const directory of ["a", "b"]) {
    await fs.mkdir(path.join(f.root, "aggregate", directory));
    for (let index = 0; index < 600; index++)
      await f.write(
        `aggregate/${directory}/${String(index).padStart(5, "0")}`,
        "",
      );
  }
  await assert.rejects(inventory(f.root, ["aggregate"]), /ENTRY_LIMIT/);
});
