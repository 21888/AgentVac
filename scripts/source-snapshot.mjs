// Read-only source inventory; generated outputs, dependencies and profiles are excluded.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(".");
const dirs = [
  "electron",
  "shared",
  "src",
  "tests",
  "scripts",
  "build",
  ".github",
];
const files = {};
async function walk(relative) {
  const location = path.join(root, relative);
  const st = await fs.lstat(location);
  if (st.isSymbolicLink())
    throw Error("Unexpected source symlink: " + relative);
  if (st.isDirectory()) {
    for (const child of (await fs.readdir(location)).sort())
      await walk(path.posix.join(relative, child));
  } else if (st.isFile())
    files[relative] = createHash("sha256")
      .update(await fs.readFile(location))
      .digest("hex");
}
for (const dir of dirs) await walk(dir);
for (const name of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "index.html",
  ".gitignore",
]) {
  try {
    await walk(name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const sorted = Object.fromEntries(
  Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
);
const digest = createHash("sha256")
  .update(JSON.stringify(sorted))
  .digest("hex");
const production = Object.fromEntries(
  Object.entries(sorted).filter(([file]) =>
    /^(electron|shared|src)\//.test(file),
  ),
);
const productionDigest = createHash("sha256")
  .update(JSON.stringify(production))
  .digest("hex");
const report = {
  format: "agentvac-source-snapshot-v1",
  createdAt: new Date().toISOString(),
  sourceDigest: digest,
  productionDigest,
  files: sorted,
};
if (process.argv[2] === "--verify") {
  const expected = JSON.parse(await fs.readFile(process.argv[3], "utf8"));
  if (expected.sourceDigest !== digest)
    throw Error(
      `Source changed: expected ${expected.sourceDigest}, observed ${digest}`,
    );
  console.log("SOURCE_UNCHANGED", digest);
} else {
  const output = process.argv[2] ?? "docs/MULTI-SOURCE-SNAPSHOT.json";
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      sourceDigest: digest,
      productionDigest,
      fileCount: Object.keys(sorted).length,
      output,
    }),
  );
}
