import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";

test("large batch uses bounded journal writes and restores all 300 files", async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-scale-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "log"));
  const old = new Date(Date.now() - 90 * 86400000);
  await Promise.all(
    Array.from({ length: 300 }, async (_, index) => {
      const p = path.join(root, "log", `codex-tui.log.${index + 1}`);
      await fs.writeFile(p, `fixture ${index}`);
      await fs.utimes(p, old, old);
    }),
  );
  const engine = new AgentVacEngine(root, randomBytes(32), true);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  assert.equal(scan.summary.eligibleFiles, 300);
  const preview = await engine.preview(scan.entries.map((e) => e.id));
  const open = fs.open;
  let writes = 0;
  fs.open = async (p: any, ...args: any[]) => {
    if (String(p).endsWith(".tmp")) writes++;
    return (open as any)(p, ...args);
  };
  try {
    const result = await engine.quarantine(preview.token, true);
    assert.equal(result.completed, 300);
    assert.equal(result.failed.length, 0);
    assert.equal(
      writes,
      2,
      "a large batch must not rewrite the complete journal per item",
    );
    const restored = await engine.restore(result.batchId);
    assert.equal(restored.completed, 300);
    assert.equal(restored.failed.length, 0);
    assert.equal(writes, 4);
  } finally {
    fs.open = open;
  }
  assert.equal((await fs.readdir(path.join(root, "log"))).length, 300);
  assert.equal(
    await fs.readFile(path.join(root, "log", "codex-tui.log.300"), "utf8"),
    "fixture 299",
  );
});
