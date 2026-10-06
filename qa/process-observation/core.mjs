// QA-only copy/build provenance. This module never launches Electron.
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const targetRelative = ".qa/agentvac-process-observed";
export const sourceDirectories = [
  "electron",
  "shared",
  "src",
  "scripts",
  "tests",
];
export const sourceRootFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "index.html",
  "LICENSE",
  "THIRD-PARTY-NOTICES.txt",
];
export const outputFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/diagnostic-supervisor.cjs",
  "dist-electron/diagnostic-worker.cjs",
  "dist-electron/cursor-sql-worker.cjs",
  "dist-electron/process-argv-worker.cjs",
  ".qa/native-harness/native-provider-driver.mjs",
  ".qa/native-harness/build-receipt.json",
];
export const limits = Object.freeze({
  files: 1024,
  directories: 128,
  entriesPerDirectory: 1152,
  totalEntries: 1152,
  depth: 12,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const jsonDigest = (value) => digest(JSON.stringify(value));
const fail = (code) => {
  throw new Error(`PROCESS_OBSERVER_${code}`);
};
const identity = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
export function checkRelative(relative) {
  if (
    typeof relative !== "string" ||
    relative.length > 240 ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relative) ||
    relative.split("/").some((part) => part === "." || part === "..") ||
    relative.split("/").length > limits.depth
  )
    fail("INVALID_PATH");
  return relative;
}
export async function checkedDirectory(root, relative = "") {
  const canonical = path.resolve(root);
  if ((await fs.realpath(canonical)) !== canonical) fail("LINKED_ROOT");
  const base = await fs.lstat(canonical);
  if (!base.isDirectory() || base.isSymbolicLink()) fail("INVALID_DIRECTORY");
  if (!relative) return canonical;
  checkRelative(relative);
  let current = canonical;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("LINKED_DIRECTORY");
  }
  return current;
}
export async function checkedRead(root, relative, maxBytes = limits.fileBytes) {
  checkRelative(relative);
  const parent = path.posix.dirname(relative);
  await checkedDirectory(root, parent === "." ? "" : parent);
  const location = path.join(root, relative);
  const before = await fs.lstat(location, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes)
  )
    fail("UNSAFE_FILE");
  const handle = await fs.open(
    location,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!identity(before, opened) || opened.nlink !== 1n) fail("FILE_CHANGED");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const locationAfter = await fs.lstat(location, { bigint: true });
    if (
      length !== Number(opened.size) ||
      !identity(opened, after) ||
      !identity(after, locationAfter) ||
      locationAfter.nlink !== 1n ||
      !locationAfter.isFile() ||
      locationAfter.isSymbolicLink()
    )
      fail("FILE_CHANGED");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export async function inventory(root, directories, filenames = []) {
  const records = [];
  let bytes = 0,
    directoryCount = 0,
    entryCount = 0;
  const seen = new Set();
  async function walk(relative) {
    checkRelative(relative);
    if (seen.has(relative)) fail("DUPLICATE_PATH");
    seen.add(relative);
    const st = await fs.lstat(path.join(root, relative));
    if (st.isSymbolicLink()) fail("UNSAFE_FILE");
    if (st.isDirectory()) {
      if (++directoryCount > limits.directories) fail("DIRECTORY_LIMIT");
      await checkedDirectory(root, relative);
      const names = [];
      const directory = await fs.opendir(path.join(root, relative), {
        bufferSize: 32,
      });
      for await (const entry of directory) {
        if (
          names.length >= limits.entriesPerDirectory ||
          ++entryCount > limits.totalEntries
        )
          fail("ENTRY_LIMIT");
        names.push(entry.name);
      }
      for (const name of names.sort()) await walk(`${relative}/${name}`);
    } else {
      if (records.length >= limits.files) fail("FILE_LIMIT");
      const data = await checkedRead(root, relative);
      bytes += data.length;
      if (bytes > limits.totalBytes) fail("BYTE_LIMIT");
      records.push({
        path: relative,
        sha256: digest(data),
        bytes: data.length,
      });
    }
  }
  await checkedDirectory(root);
  for (const relative of [...directories, ...filenames]) await walk(relative);
  return records.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
function validateRecords(records) {
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.length > limits.files
  )
    fail("INVALID_PINS");
  let previous = "",
    total = 0;
  for (const row of records) {
    if (!row || Object.keys(row).sort().join(",") !== "bytes,path,sha256")
      fail("INVALID_PINS");
    checkRelative(row.path);
    if (
      row.path <= previous ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > limits.fileBytes
    )
      fail("INVALID_PINS");
    previous = row.path;
    total += row.bytes;
  }
  if (total > limits.totalBytes) fail("INVALID_PINS");
}
function equal(actual, expected, code) {
  if (jsonDigest(actual) !== jsonDigest(expected)) fail(code);
}
const production = (records) =>
  records.filter((row) => /^(electron|shared|src)\//.test(row.path));
export async function loadPins(packageRoot, expectedHash) {
  const bytes = await checkedRead(packageRoot, "source-pins.json", 1024 * 1024);
  if (expectedHash && digest(bytes) !== expectedHash) fail("PINS_CHANGED");
  const pins = JSON.parse(bytes);
  if (
    pins.format !== "agentvac-process-observer-source-pins-v1" ||
    pins.target !== targetRelative
  )
    fail("INVALID_PINS");
  validateRecords(pins.sourceFiles);
  validateRecords(pins.overlays);
  validateRecords(pins.packageFiles);
  for (const row of pins.sourceFiles)
    if (!(
      sourceRootFiles.includes(row.path) ||
      sourceDirectories.some((dir) => row.path.startsWith(`${dir}/`))
    ))
      fail("INVALID_SOURCE_SCOPE");
  for (const row of pins.overlays)
    if (!/^(electron|scripts|tests)\//.test(row.path))
      fail("INVALID_OVERLAY_SCOPE");
  for (const row of pins.packageFiles)
    if (
      !/^(?:core\.mjs|core-observer\.patch|observer-overlay\.patch|README\.md|tests\/[A-Za-z0-9_.-]+)$/.test(
        row.path,
      )
    )
      fail("INVALID_PACKAGE_SCOPE");
  return { pins, pinsSha256: digest(bytes) };
}
async function verifyInputs(root, packageRoot, pins) {
  equal(
    await inventory(root, sourceDirectories, sourceRootFiles),
    pins.sourceFiles,
    "SOURCE_CHANGED",
  );
  const overlays = await inventory(packageRoot, ["overlay"]);
  equal(
    overlays.map((row) => ({ ...row, path: row.path.slice(8) })),
    pins.overlays,
    "OVERLAY_CHANGED",
  );
  equal(
    await inventory(
      packageRoot,
      [],
      pins.packageFiles.map((row) => row.path),
    ),
    pins.packageFiles,
    "PACKAGE_CHANGED",
  );
}
async function writeNew(root, relative, data) {
  checkRelative(relative);
  const parent = path.posix.dirname(relative);
  if (parent !== ".")
    await fs.mkdir(path.join(root, parent), { recursive: true });
  await checkedDirectory(root, parent === "." ? "" : parent);
  await fs.writeFile(path.join(root, relative), data, {
    flag: "wx",
    mode: 0o600,
  });
}
export async function buildObservedProject(root, expectedPinsSha256) {
  if (
    path.resolve(root) !== process.cwd() ||
    path.basename(root) === "agentvac-process-observed"
  )
    fail("WRONG_PROJECT");
  await checkedDirectory(root);
  const packageRoot = await checkedDirectory(root, "qa/process-observation");
  const { pins, pinsSha256 } = await loadPins(packageRoot, expectedPinsSha256);
  await verifyInputs(root, packageRoot, pins);
  const assets = await inventory(root, ["dist"], ["build/icon.png"]);
  if (!assets.some((row) => row.path === "dist/index.html"))
    fail("MISSING_FRONTEND");
  const packageBefore = await inventory(
    packageRoot,
    ["overlay", "tests"],
    [
      "core.mjs",
      "prepare.mjs",
      "verify.mjs",
      "source-pins.json",
      "README.md",
      "core-observer.patch",
      "observer-overlay.patch",
    ],
  );
  const qa = path.join(root, ".qa");
  try {
    await fs.mkdir(qa);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await checkedDirectory(root, ".qa");
  // mkdir is exclusive: never reuse, replace, or clean an existing target.
  const target = path.join(root, targetRelative);
  try {
    await fs.mkdir(target);
  } catch (error) {
    if (error.code === "EEXIST") fail("TARGET_EXISTS");
    throw error;
  }
  try {
    const overlayMap = new Map(pins.overlays.map((row) => [row.path, row]));
    const copied = new Map();
    for (const row of [...pins.sourceFiles, ...assets]) {
      const useOverlay = overlayMap.has(row.path);
      const bytes = await checkedRead(
        useOverlay ? packageRoot : root,
        useOverlay ? `overlay/${row.path}` : row.path,
      );
      const expected = useOverlay ? overlayMap.get(row.path) : row;
      if (digest(bytes) !== expected.sha256 || bytes.length !== expected.bytes)
        fail("COPY_INPUT_CHANGED");
      await writeNew(target, row.path, bytes);
      copied.set(row.path, { ...expected, path: row.path });
      overlayMap.delete(row.path);
    }
    for (const row of overlayMap.values()) {
      const bytes = await checkedRead(packageRoot, `overlay/${row.path}`);
      if (digest(bytes) !== row.sha256 || bytes.length !== row.bytes)
        fail("COPY_INPUT_CHANGED");
      await writeNew(target, row.path, bytes);
      copied.set(row.path, row);
    }
    for (const row of packageBefore) {
      const bytes = await checkedRead(packageRoot, row.path);
      if (digest(bytes) !== row.sha256) fail("PACKAGE_CHANGED");
      await writeNew(target, `qa/process-observation/${row.path}`, bytes);
    }
    const copiedFiles = [...copied.values()].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    );
    equal(
      await inventory(
        target,
        [...sourceDirectories, "dist"],
        [...sourceRootFiles, "build/icon.png"],
      ),
      copiedFiles,
      "COPIED_SOURCE_CHANGED",
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (env.NODE_OPTIONS?.trim()) fail("NODE_OPTIONS");
    for (const script of [
      "scripts/build-electron.mjs",
      "scripts/build-native-provider-harness.mjs",
    ]) {
      const result = await run(process.execPath, [script], {
        cwd: target,
        env,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.stderr.trim()) console.error(result.stderr.trim());
    }
    const builtFiles = await inventory(target, [
      "dist-electron",
      ".qa/native-harness",
    ]);
    equal(
      builtFiles.map((row) => row.path),
      [...outputFiles].sort(),
      "UNEXPECTED_OUTPUT",
    );
    await verifyInputs(root, packageRoot, pins);
    equal(
      await inventory(root, ["dist"], ["build/icon.png"]),
      assets,
      "ASSETS_CHANGED",
    );
    equal(
      await inventory(
        packageRoot,
        ["overlay", "tests"],
        [
          "core.mjs",
          "prepare.mjs",
          "verify.mjs",
          "source-pins.json",
          "README.md",
          "core-observer.patch",
          "observer-overlay.patch",
        ],
      ),
      packageBefore,
      "PACKAGE_CHANGED",
    );
    equal(
      await inventory(
        target,
        [...sourceDirectories, "dist"],
        [...sourceRootFiles, "build/icon.png"],
      ),
      copiedFiles,
      "COPIED_SOURCE_CHANGED",
    );
    const receipt = {
      format: "agentvac-process-observed-build-v1",
      instrumented: true,
      productionAcceptance: false,
      mode: "qa-generated-process-observed-copy",
      target: targetRelative,
      pinsSha256,
      originalProductionFilesUnchanged: true,
      sourceDigestBefore: jsonDigest(pins.sourceFiles),
      sourceDigestAfter: jsonDigest(
        await inventory(root, sourceDirectories, sourceRootFiles),
      ),
      productionDigestBefore: jsonDigest(production(pins.sourceFiles)),
      productionDigestAfter: jsonDigest(
        production(await inventory(root, sourceDirectories, sourceRootFiles)),
      ),
      originalSourceFiles: pins.sourceFiles,
      originalProductionFiles: production(pins.sourceFiles),
      overlayFiles: pins.overlays,
      packageFiles: packageBefore,
      copiedFiles,
      builtFiles,
      copiedSourceDigest: jsonDigest(copiedFiles),
      builtDigest: jsonDigest(builtFiles),
      nativeExecution: false,
      packagedArtifactTested: false,
    };
    await writeNew(
      target,
      "process-observer-build.json",
      JSON.stringify(receipt, null, 2) + "\n",
    );
    await verifyObservedProject(target);
    return receipt;
  } catch (error) {
    await writeNew(
      target,
      "BUILD-FAILED.json",
      JSON.stringify({
        format: "agentvac-process-observed-failed-v1",
        instrumented: true,
        status: "FAILED",
        target: targetRelative,
      }) + "\n",
    ).catch(() => {});
    throw error;
  }
}
export async function verifyObservedProject(target) {
  await checkedDirectory(target);
  const root = path.dirname(path.dirname(target));
  if (target !== path.join(root, targetRelative)) fail("WRONG_COPY");
  const packageRoot = await checkedDirectory(root, "qa/process-observation");
  const receipt = JSON.parse(
    await checkedRead(target, "process-observer-build.json", 2 * 1024 * 1024),
  );
  if (
    receipt.format !== "agentvac-process-observed-build-v1" ||
    receipt.instrumented !== true ||
    receipt.productionAcceptance !== false ||
    receipt.target !== targetRelative ||
    receipt.originalProductionFilesUnchanged !== true ||
    receipt.mode !== "qa-generated-process-observed-copy" ||
    receipt.nativeExecution !== false ||
    receipt.packagedArtifactTested !== false ||
    typeof receipt.pinsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.pinsSha256)
  )
    fail("INVALID_RECEIPT");
  const { pins, pinsSha256 } = await loadPins(packageRoot, receipt.pinsSha256);
  await verifyInputs(root, packageRoot, pins);
  equal(receipt.originalSourceFiles, pins.sourceFiles, "RECEIPT_CHANGED");
  equal(
    receipt.originalProductionFiles,
    production(pins.sourceFiles),
    "RECEIPT_CHANGED",
  );
  equal(receipt.overlayFiles, pins.overlays, "RECEIPT_CHANGED");
  if (
    receipt.sourceDigestBefore !== jsonDigest(pins.sourceFiles) ||
    receipt.sourceDigestAfter !== receipt.sourceDigestBefore ||
    receipt.productionDigestBefore !==
      jsonDigest(production(pins.sourceFiles)) ||
    receipt.productionDigestAfter !== receipt.productionDigestBefore
  )
    fail("RECEIPT_CHANGED");
  for (const rows of [
    receipt.packageFiles,
    receipt.copiedFiles,
    receipt.builtFiles,
  ])
    validateRecords(rows);
  const actualPackage = await inventory(
    packageRoot,
    ["overlay", "tests"],
    [
      "core.mjs",
      "prepare.mjs",
      "verify.mjs",
      "source-pins.json",
      "README.md",
      "core-observer.patch",
      "observer-overlay.patch",
    ],
  );
  equal(actualPackage, receipt.packageFiles, "PACKAGE_CHANGED");
  equal(
    await inventory(target, ["qa/process-observation"]),
    actualPackage.map((row) => ({
      ...row,
      path: `qa/process-observation/${row.path}`,
    })),
    "COPIED_PACKAGE_CHANGED",
  );
  const assets = await inventory(root, ["dist"], ["build/icon.png"]);
  const expected = new Map(
    [...pins.sourceFiles, ...assets].map((row) => [row.path, row]),
  );
  for (const row of pins.overlays) expected.set(row.path, row);
  const expectedCopy = [...expected.values()].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  equal(receipt.copiedFiles, expectedCopy, "RECEIPT_CHANGED");
  equal(
    await inventory(
      target,
      [...sourceDirectories, "dist"],
      [...sourceRootFiles, "build/icon.png"],
    ),
    expectedCopy,
    "COPIED_SOURCE_CHANGED",
  );
  equal(
    await inventory(target, ["dist-electron", ".qa/native-harness"]),
    receipt.builtFiles,
    "BUILT_OUTPUT_CHANGED",
  );
  if (
    receipt.copiedSourceDigest !== jsonDigest(expectedCopy) ||
    receipt.builtDigest !== jsonDigest(receipt.builtFiles)
  )
    fail("RECEIPT_CHANGED");
  return {
    format: "agentvac-process-observed-execution-v1",
    instrumented: true,
    productionAcceptance: false,
    mode: receipt.mode,
    originalProductionFilesUnchanged: true,
    pinsSha256,
    sourceDigest: receipt.sourceDigestBefore,
    copiedSourceDigest: receipt.copiedSourceDigest,
    builtDigest: receipt.builtDigest,
  };
}
