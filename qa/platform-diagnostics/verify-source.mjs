// Read-only verification for this diagnostic candidate. No private target inputs.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const productionExpected =
  "260021d77224da299a7aa0ca9a69440c61a853965cb2a8fa8eeb60255397190b";
const plain = async (relative) => {
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const st = await fs.lstat(current);
    if (
      st.isSymbolicLink() ||
      (index + 1 < parts.length ? !st.isDirectory() : !st.isFile())
    )
      throw new Error("SOURCE_FILE_TYPE");
  }
  return current;
};
try {
  const manifestFile = await plain("SOURCE-SHA256.json");
  const stat = await fs.stat(manifestFile);
  if (stat.size > 2 * 1024 * 1024) throw new Error("SOURCE_MANIFEST_LIMIT");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  if (
    manifest.format !== "agentvac-source-sha256-v1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > 5000 ||
    digest(JSON.stringify(manifest.files)) !== manifest.sourceDigest
  )
    throw new Error("SOURCE_MANIFEST_INVALID");
  const seen = new Set(),
    production = {};
  let declaredTotal = 0;
  for (const row of manifest.files) {
    if (
      !row ||
      typeof row.path !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(row.path) ||
      row.path.split("/").some((v) => !v || v === "." || v === "..") ||
      seen.has(row.path) ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > 64 * 1024 * 1024
    )
      throw new Error("SOURCE_RECORD_INVALID");
    declaredTotal += row.bytes;
    if (declaredTotal > 128 * 1024 * 1024)
      throw new Error("SOURCE_TOTAL_LIMIT");
    seen.add(row.path);
    const handle = await fs.open(await plain(row.path), "r");
    let observedBytes = 0;
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("SOURCE_FILE_TYPE");
      for (;;) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, row.bytes - observedBytes + 1),
          null,
        );
        if (!result.bytesRead) break;
        observedBytes += result.bytesRead;
        if (observedBytes > row.bytes) throw new Error("SOURCE_MISMATCH");
        hash.update(buffer.subarray(0, result.bytesRead));
      }
    } finally {
      await handle.close();
    }
    if (observedBytes !== row.bytes || hash.digest("hex") !== row.sha256)
      throw new Error("SOURCE_MISMATCH");
    if (/^(electron|shared|src)\//.test(row.path))
      production[row.path] = row.sha256;
  }
  const actualProduction = [];
  let entryCount = 0,
    directoryCount = 0;
  const walk = async (relative, depth = 0) => {
    if (depth > 16 || ++directoryCount > 512)
      throw new Error("PRODUCTION_DIRECTORY_LIMIT");
    const names = [];
    const directory = await fs.opendir(path.join(root, relative));
    for await (const entry of directory) {
      if (++entryCount > 5000 || names.length >= 1024)
        throw new Error("PRODUCTION_ENTRY_LIMIT");
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const next = relative + "/" + name,
        st = await fs.lstat(path.join(root, next));
      if (st.isSymbolicLink()) throw new Error("SOURCE_FILE_TYPE");
      if (st.isDirectory()) await walk(next, depth + 1);
      else if (st.isFile()) actualProduction.push(next);
      else throw new Error("SOURCE_FILE_TYPE");
    }
  };
  for (const dir of ["electron", "shared", "src"]) await walk(dir);
  if (
    actualProduction.length !== Object.keys(production).length ||
    actualProduction.some((p) => !Object.hasOwn(production, p))
  )
    throw new Error("PRODUCTION_INVENTORY");
  const productionDigest = digest(JSON.stringify(production));
  if (
    productionDigest !== productionExpected ||
    manifest.productionDigest !== productionExpected
  )
    throw new Error("PRODUCTION_CHANGED");
  console.log(
    JSON.stringify({
      format: "agentvac-diagnostic-source-verification-v1",
      sourceDigest: manifest.sourceDigest,
      productionDigest,
      files: seen.size,
      unchangedProductionFiles: actualProduction.length,
      productionAccepted: false,
    }),
  );
} catch {
  console.error("DIAGNOSTIC_SOURCE_VERIFICATION_FAILED");
  process.exitCode = 1;
}
