import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildNativeProviderHarness } from "../scripts/build-native-provider-harness.mjs";
import { validateDriverEvidence } from "../scripts/native-ci-summary.mjs";

const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(parentEnv: NodeJS.ProcessEnv = process.env) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-plain-driver-")),
  );
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "electron"));
  await fs.mkdir(path.join(root, "electron/process-argv-linux"));
  await fs.mkdir(path.join(root, "dist-electron"));
  await fs.writeFile(
    path.join(root, "electron/process-argv-linux/worker.ts"),
    "export const fixture = true;\n",
  );
  await fs.writeFile(path.join(root, "electron/process-argv-linux/README.md"), "# Synthetic helper scope\n");
  await fs.writeFile(
    path.join(root, "dist-electron/process-argv-worker.cjs"),
    "// inert compiled fixture worker\n",
  );
  for (const name of [
    "native-provider-driver.mjs",
    "native-driver-provenance.mjs",
  ])
    await fs.copyFile(
      new URL(`../scripts/${name}`, import.meta.url),
      path.join(root, "scripts", name),
    );
  await fs.writeFile(
    path.join(root, "electron/processes.ts"),
    'export const guard = "unchanged-fixture-guard";\n',
  );
  await fs.writeFile(
    path.join(root, "scripts/native-provider-regression.mjs"),
    'import {guard} from "../electron/processes.ts"; console.log(guard);\n',
  );
  const receipt = await buildNativeProviderHarness(root);
  const entry = path.join(root, receipt.output);
  const env = { ...parentEnv };
  delete env.NODE_OPTIONS;
  // A unit fixture must never overwrite receipts owned by the native CI run.
  delete env.AGENTVAC_NATIVE_EVIDENCE_DIR;
  return {
    root,
    entry,
    receipt,
    env,
    run(args: string[] = [entry], extraEnv = {}) {
      return spawnSync(process.execPath, args, {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
    async clean() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("compiled driver executes the same fixture harness with exact source/bundle and plain argv receipt", async () => {
  const f = await fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged-fixture-guard/);
    const evidence = JSON.parse(
      await fs.readFile(
        path.join(
          f.root,
          `.qa/native-provider-evidence/provider-driver-${process.platform}-${process.arch}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(evidence.bundleSha256, digest(await fs.readFile(f.entry)));
    assert.equal(
      evidence.sourceDigest,
      digest(JSON.stringify(evidence.sourceFiles)),
    );
    assert.deepEqual(evidence.argv, [process.execPath, f.entry]);
    assert.deepEqual(evidence.execArgv, []);
    assert.equal(evidence.unchangedProductionGuards, true);
    assert.ok(
      evidence.sourceFiles.some(
        (file: { path: string }) => file.path === "electron/processes.ts",
      ),
    );
    const expected = {
      sourceRevision: "fixture",
      ciRunId: "1",
      ciRunAttempt: "1",
      platform: process.platform,
      arch: process.arch,
    };
    const tagged = { ...evidence, ...expected };
    assert.deepEqual(validateDriverEvidence(tagged, expected), []);
    for (const patch of [
      { execArgv: ["--import", "tsx"] },
      { nodeOptionsPresent: true },
      { unchangedProductionGuards: false },
      { sourceDigest: "0".repeat(64) },
      { sourceRevision: "stale" },
      { argvSource: "raw-os-argv" },
      { argv: [...evidence.argv, "later.js"] },
    ])
      assert.ok(
        validateDriverEvidence({ ...tagged, ...patch }, expected).length,
      );
  } finally {
    await f.clean();
  }
});

test("driver refuses flags, extra args and NODE_OPTIONS before fixture code", async () => {
  const f = await fixture();
  try {
    for (const [args, env] of [
      [["--trace-warnings", f.entry], {}],
      [[f.entry, "extra.js"], {}],
      [[f.entry], { NODE_OPTIONS: "--no-warnings" }],
    ] as Array<[string[], Record<string, string>]>) {
      const result = f.run(args, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /NATIVE_DRIVER_UNEXPECTED_EXECUTION/);
      assert.doesNotMatch(result.stdout, /unchanged-fixture-guard/);
    }
  } finally {
    await f.clean();
  }
});

test("fixture receipts stay local without changing inherited shared evidence", async (t) => {
  const shared = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-shared-evidence-")),
  );
  t.after(() => fs.rm(shared, { recursive: true, force: true }));
  const receiptName = `provider-driver-${process.platform}-${process.arch}.json`;
  const preserved = new Map([
    [receiptName, '{"syntheticExternalEvidence":"must-stay-unchanged"}\n'],
    ["parent-marker.txt", "synthetic CI evidence sentinel\n"],
  ]);
  for (const [name, bytes] of preserved)
    await fs.writeFile(path.join(shared, name), bytes);

  const parentEnv = { ...process.env, AGENTVAC_NATIVE_EVIDENCE_DIR: shared };
  const f = await fixture(parentEnv);
  t.after(() => f.clean());
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parentEnv.AGENTVAC_NATIVE_EVIDENCE_DIR, shared);
  assert.deepEqual((await fs.readdir(shared)).sort(), [...preserved.keys()].sort());
  for (const [name, bytes] of preserved)
    assert.equal(await fs.readFile(path.join(shared, name), "utf8"), bytes);

  const evidence = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".qa/native-provider-evidence", receiptName),
      "utf8",
    ),
  );
  assert.equal(evidence.bundleSha256, digest(await fs.readFile(f.entry)));
  assert.deepEqual(evidence.argv, [process.execPath, f.entry]);
});

test("receipt labels Node-normalized argv rather than claiming raw OS launch arguments", async () => {
  const f = await fixture();
  try {
    const result = f.run([path.relative(f.root, f.entry)]);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(
      await fs.readFile(
        path.join(
          f.root,
          `.qa/native-provider-evidence/provider-driver-${process.platform}-${process.arch}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(evidence.argvSource, "node-normalized-process-argv");
    assert.equal(evidence.argv[1], f.entry);
  } finally {
    await f.clean();
  }
});

test("driver binds source inputs and bundle bytes, including process policy", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.root, "electron/processes.ts");
    const original = await fs.readFile(source);
    await fs.appendFile(source, "// drift\n");
    assert.match(f.run().stderr, /NATIVE_DRIVER_SOURCE_CHANGED/);
    await fs.writeFile(source, original);
    const worker = path.join(f.root, "dist-electron/process-argv-worker.cjs");
    const workerBefore = await fs.readFile(worker);
    await fs.appendFile(worker, "// worker drift\n");
    assert.match(f.run().stderr, /NATIVE_DRIVER_BUILD_CHANGED/);
    await fs.writeFile(worker, workerBefore);
    await fs.appendFile(f.entry, "\n// bundle drift\n");
    assert.match(f.run().stderr, /NATIVE_DRIVER_BUILD_CHANGED/);
  } finally {
    await f.clean();
  }
});
