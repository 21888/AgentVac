import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const inputs = JSON.parse(
  await readFile(new URL("SOURCE-INPUTS.json", root), "utf8"),
);
if (
  !Array.isArray(inputs) ||
  inputs.length < 10 ||
  inputs.length > 100 ||
  new Set(inputs).size !== inputs.length ||
  inputs.some(
    (p) =>
      typeof p !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(p) ||
      p.startsWith("/") ||
      p.split("/").includes(".."),
  )
)
  throw Error("INVALID_SOURCE_INPUTS");
inputs.sort();
const sources = {};
for (const p of inputs) sources[p] = hash(await readFile(new URL(p, root)));
const sourceTreeSha256 = hash(
  Buffer.from(inputs.map((p) => `${p}\0${sources[p]}\n`).join("")),
);
const result = {
  schema: 1,
  profile: "generated-private-copy-lease-v2",
  status: "source-staged-not-native-accepted",
  sourceTreeSha256,
  sources,
  baselineSourceTreeSha256:
    "9aa841b040191b4e705aabfed6913b2f6d3b3d79a45daeda87a4824665eb088b",
  nativeWindows: "NOT_RUN",
  productionAccepted: false,
  privateCopyActivated: false,
};
await writeFile(
  new URL("results/lease-source-manifest.json", root),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify({ sourceTreeSha256, nativeWindows: "NOT_RUN" }));
