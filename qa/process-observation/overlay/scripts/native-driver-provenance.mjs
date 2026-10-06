import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function verifyNativeDriverExecution(url, runtime = process) {
  const root = await fs.realpath(path.resolve("."));
  const script = fileURLToPath(url);
  const expected = path.join(
    root,
    ".qa",
    "native-harness",
    "native-provider-driver.mjs",
  );
  // No preload, loader, eval, fixture PID exclusion or policy override.
  if (
    script !== expected ||
    runtime.execArgv.length ||
    runtime.argv.length !== 2 ||
    !path.isAbsolute(runtime.argv[1]) ||
    (await fs.realpath(runtime.argv[1])) !== expected ||
    runtime.env.NODE_OPTIONS?.trim()
  )
    throw new Error("NATIVE_DRIVER_UNEXPECTED_EXECUTION");
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(script), "build-receipt.json"),
      "utf8",
    ),
  );
  if (
    receipt?.format !== "agentvac-native-driver-build-v1" ||
    !Array.isArray(receipt.files) ||
    !receipt.files.length ||
    receipt.files.length > 256 ||
    receipt.sourceDigest !== digest(JSON.stringify(receipt.files)) ||
    receipt.bundleSha256 !== digest(await fs.readFile(script)) ||
    receipt.workerSha256 !==
      digest(
        await fs.readFile(
          path.join(root, "dist-electron/process-argv-worker.cjs"),
        ),
      )
  )
    throw new Error("NATIVE_DRIVER_BUILD_CHANGED");
  const seen = new Set();
  for (const file of receipt.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !(
        /^(scripts|electron|shared)\/[A-Za-z0-9_./-]+$/.test(file.path) ||
        file.path === "qa/process-observation/core.mjs"
      ) ||
      file.path.split("/").includes("..") ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      digest(await fs.readFile(path.join(root, file.path))) !== file.sha256
    )
      throw new Error("NATIVE_DRIVER_SOURCE_CHANGED");
    seen.add(file.path);
  }
  if (
    !seen.has("scripts/native-provider-regression.mjs") ||
    !seen.has("electron/processes.ts")
  )
    throw new Error("NATIVE_DRIVER_MISSING_POLICY_INPUT");
  const instrumented =
    path.basename(root) === "agentvac-process-observed" &&
    path.basename(path.dirname(root)) === ".qa";
  const instrumentation = instrumented
    ? await (
        await import(
          pathToFileURL(path.join(root, "qa/process-observation/core.mjs")).href
        )
      ).verifyObservedProject(root)
    : null;
  return {
    format: "agentvac-native-driver-execution-v1",
    instrumented,
    productionAcceptance: false,
    ...(instrumented
      ? { instrumentation, originalProductionFilesUnchanged: true }
      : {}),
    mode: instrumented
      ? "qa-process-observed-compiled-harness"
      : "plain-compiled-same-harness",
    sourceRevision: runtime.env.GITHUB_SHA || null,
    ciRunId: runtime.env.GITHUB_RUN_ID || null,
    ciRunAttempt: runtime.env.GITHUB_RUN_ATTEMPT || null,
    platform: runtime.platform,
    arch: runtime.arch,
    bundleSha256: receipt.bundleSha256,
    workerSha256: receipt.workerSha256,
    sourceDigest: receipt.sourceDigest,
    sourceFiles: receipt.files,
    executable: runtime.execPath,
    argvSource: "node-normalized-process-argv",
    argv: [...runtime.argv],
    execArgv: [...runtime.execArgv],
    nodeOptionsPresent: false,
    unchangedProductionGuards: !instrumented,
  };
}
