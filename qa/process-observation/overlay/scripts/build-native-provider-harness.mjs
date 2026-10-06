// Test-only build. No provider/process-policy special cases are introduced.
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function buildNativeProviderHarness(projectRoot = ".") {
  const root = await fs.realpath(path.resolve(projectRoot));
  const directory = path.join(root, ".qa", "native-harness");
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, "native-provider-driver.mjs");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/native-provider-driver.mjs"],
    outfile: output,
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node24",
    format: "esm",
    metafile: true,
    write: true,
  });
  const files = [];
  const inputs = new Set(Object.keys(result.metafile.inputs));
  // The process worker is deliberately outside the main/harness bundle.
  // Bind its complete fixed source directory and built output as well.
  for (const name of await fs.readdir(
    path.join(root, "electron/process-argv-linux"),
  )) {
    if (name !== "README.md" && !/^[a-z][a-z0-9-]*\.ts$/.test(name))
      throw new Error("NATIVE_DRIVER_UNKNOWN_WORKER_SOURCE");
    inputs.add("electron/process-argv-linux/" + name);
  }
  for (const input of [...inputs].sort()) {
    if (path.isAbsolute(input) || input.split(/[\\/]/).includes(".."))
      throw new Error("NATIVE_DRIVER_SOURCE_OUTSIDE_PROJECT");
    const bytes = await fs.readFile(path.join(root, input));
    files.push({ path: input.replaceAll("\\", "/"), sha256: digest(bytes) });
  }
  const instrumented =
    path.basename(root) === "agentvac-process-observed" &&
    path.basename(path.dirname(root)) === ".qa";
  const receipt = {
    format: "agentvac-native-driver-build-v1",
    instrumented,
    productionAcceptance: false,
    mode: instrumented
      ? "qa-process-observed-compiled-harness"
      : "plain-compiled-same-harness",
    source: "scripts/native-provider-regression.mjs",
    output: ".qa/native-harness/native-provider-driver.mjs",
    bundleSha256: digest(await fs.readFile(output)),
    workerSha256: digest(
      await fs.readFile(
        path.join(root, "dist-electron/process-argv-worker.cjs"),
      ),
    ),
    sourceDigest: digest(JSON.stringify(files)),
    files,
  };
  await fs.writeFile(
    path.join(directory, "build-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const receipt = await buildNativeProviderHarness();
  console.log(
    `NATIVE_DRIVER_BUILD ${receipt.bundleSha256} ${receipt.sourceDigest}`,
  );
}
