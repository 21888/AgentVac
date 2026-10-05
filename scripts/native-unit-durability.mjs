// Actual process-kill durability of the source engine on synthetic native filesystems.
// These checkpoints are after durable commit but before caller acknowledgement;
// this does not claim power-loss atomicity or every possible interrupted syscall.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { AgentVacEngine } from "../electron/engine.ts";
import { claudeCodeAdapter } from "../electron/providers/claude-code.ts";
const thisFile = fileURLToPath(import.meta.url);
const clear = async () => ({
  status: "clear",
  details: "Synthetic fixture-only process guard",
});
const make = async (root, key) => {
  const engine = new AgentVacEngine(
    root,
    key,
    false,
    clear,
    [],
    claudeCodeAdapter,
  );
  await engine.initialize();
  return engine;
};
if (process.argv[2] === "child") {
  const [phase, root, batch] = process.argv.slice(3);
  const key = Buffer.from(process.env.AGENTVAC_SYNTHETIC_TEST_KEY ?? "", "hex");
  assert.equal(key.length, 32);
  assert.equal(
    await fs.readFile(path.join(root, "fixture-marker.txt"), "utf8"),
    "AgentVac generated durability fixture",
  );
  const engine = await make(root, key);
  let result;
  if (phase === "quarantine") {
    const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
    const rows = scan.entries.filter((r) => r.selectable);
    assert.equal(rows.length, 1);
    result = await engine.quarantine(
      (await engine.preview(rows.map((r) => r.id))).token,
      true,
    );
  } else result = await engine.restore(batch, true);
  assert.equal(result.completed, 1);
  assert.equal(result.failed.length, 0);
  process.stdout.write(
    JSON.stringify({
      checkpoint: phase + "-committed-before-ack",
      batchId: result.batchId,
    }) + "\n",
  );
  setInterval(() => {}, 1000);
} else {
  const out = path.resolve(
    process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ?? ".qa/native-unit-durability",
  );
  await fs.mkdir(out, { recursive: true });
  const base = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "AgentVac-Durability-Fixture-"),
    ),
    root = path.join(base, "claude-data"),
    key = randomBytes(32),
    hash = (b) => createHash("sha256").update(b).digest("hex");
  const originals = new Map();
  const sid = "11111111-1111-4111-8111-111111111111";
  const put = async (relative, age = 90) => {
    const p = path.join(root, relative);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const bytes = Buffer.from("synthetic durability bytes " + relative);
    await fs.writeFile(p, bytes);
    const d = new Date(Date.now() - age * 86400000);
    await fs.utimes(p, d, d);
    originals.set(relative, hash(bytes));
  };
  const result = {
    format: "agentvac-native-unit-durability-v1",
    sourceRevision: process.env.GITHUB_SHA ?? null,
    ciRunId: process.env.GITHUB_RUN_ID ?? null,
    ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    platform: process.platform,
    arch: process.arch,
    mode: "native-filesystem-source-engine",
    synthetic: true,
    powerLossAtomicityClaimed: false,
    checkpoints: [],
    status: "FAIL",
  };
  async function crash(phase, batch = "") {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", thisFile, "child", phase, root, batch],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          AGENTVAC_SYNTHETIC_TEST_KEY: key.toString("hex"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "",
      errors = "";
    child.stderr.on("data", (b) => {
      errors += b;
    });
    const exit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const checkpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Durability checkpoint timeout"));
      }, 15000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", () => {
        if (!text.includes("\n")) {
          clearTimeout(timer);
          reject(Error("Fixture child exited before checkpoint"));
        }
      });
      child.stdout.on("data", (b) => {
        text += b;
        if (text.length > 4096) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(Error("Unexpected checkpoint output"));
        }
        if (text.includes("\n")) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(text.split("\n")[0]));
          } catch {
            reject(Error("Invalid checkpoint"));
          }
        }
      });
    });
    assert.equal(checkpoint.checkpoint, phase + "-committed-before-ack");
    assert.equal(child.kill("SIGKILL"), true);
    await exit;
    return checkpoint;
  }
  try {
    await put("settings.json");
    await put(`projects/-synthetic/${sid}.jsonl`);
    await put(`projects/-synthetic/${sid}/subagents/agent-a.jsonl`);
    await put(
      "projects/-synthetic/22222222-2222-4222-8222-222222222222.jsonl",
      1,
    );
    await fs.writeFile(
      path.join(root, "fixture-marker.txt"),
      "AgentVac generated durability fixture",
    );
    for (const relative of [
      `projects/-synthetic/${sid}/subagents`,
      `projects/-synthetic/${sid}`,
    ])
      await fs.utimes(
        path.join(root, relative),
        new Date("2025-01-01"),
        new Date("2025-01-01"),
      );
    const q = await crash("quarantine");
    let engine = await make(root, key);
    const history = await engine.history();
    assert.equal(
      history.find((b) => b.id === q.batchId)?.items[0].status,
      "quarantined",
    );
    const rescue = await engine.inspectRecovery();
    assert.equal(
      rescue.batches.find((b) => b.id === q.batchId)?.storedFiles,
      2,
    );
    result.checkpoints.push({
      name: q.checkpoint,
      processKilled: true,
      restartRecovered: true,
      retainedFiles: 2,
    });
    const r = await crash("restore", q.batchId);
    engine = await make(root, key);
    assert.equal(
      (await engine.history()).find((b) => b.id === q.batchId)?.items[0].status,
      "restored",
    );
    for (const [relative, expected] of originals)
      assert.equal(
        hash(await fs.readFile(path.join(root, relative))),
        expected,
      );
    assert.equal((await engine.restore(q.batchId, true)).completed, 0);
    result.checkpoints.push({
      name: r.checkpoint,
      processKilled: true,
      restartRecovered: true,
      exactBytes: true,
      duplicateRefused: true,
    });
    result.status = "PASS";
  } catch (error) {
    result.failure =
      error instanceof assert.AssertionError
        ? error.message
        : "Native durability fixture failed safely.";
    process.exitCode = 1;
  } finally {
    await fs.writeFile(
      path.join(out, `durability-${process.platform}-${process.arch}.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
    await fs.rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
