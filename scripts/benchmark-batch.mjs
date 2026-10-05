import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AgentVacEngine } from "../electron/engine.ts";
const out = path.resolve("docs/performance");
await fs.mkdir(out, { recursive: true });
const root = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-review-"),
);
const report = {
  at: new Date().toISOString(),
  scope:
    "Generated 5000-file fixtures. Sparse logical sizes are NOT real storage read/write throughput. Observational timing on this filesystem, not a performance guarantee.",
  timings: {},
  memory: [],
  checks: [],
};
let peak = 0;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
const old = new Date(Date.now() - 120 * 86400000);
const key = randomBytes(32);
const time = async (name, fn) => {
  const t = performance.now();
  const value = await fn();
  report.timings[name] = +(performance.now() - t).toFixed(2);
  console.log(name, report.timings[name] + "ms");
  report.memory.push({ stage: name, ...process.memoryUsage() });
  await fs.writeFile(
    path.join(out, "performance-results.json"),
    JSON.stringify(report, null, 2),
  );
  return value;
};
const digest = async (p) =>
  createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
try {
  const logs = path.join(root, "log");
  await fs.mkdir(logs);
  const size = 32 * 1024 * 1024,
    count = 5000;
  await time("create5000SparseLogs", async () => {
    for (let base = 0; base < count; base += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, count - base) }, async (_, j) => {
          const i = base + j;
          const p = path.join(
            logs,
            `codex-tui.log.${String(i).padStart(6, "0")}`,
          );
          const h = await fs.open(p, "wx");
          await h.write("Generated AgentVac performance fixture " + i);
          await h.truncate(size);
          await h.close();
          await fs.utimes(p, old, old);
        }),
      );
  });
  const protectedPath = path.join(root, "auth.json");
  await fs.writeFile(
    protectedPath,
    "Generated protected marker; not a credential.",
  );
  const protectedDigest = await digest(protectedPath);
  const engine = new AgentVacEngine(root, key, true);
  const scan = await time("scan5000", () =>
    engine.scan({ minAgeDays: 30, includeSessions: false }),
  );
  assert.equal(scan.summary.eligibleFiles, 5000);
  assert.equal(scan.summary.safeBytes, count * size);
  report.logicalFixtureBytes = scan.summary.safeBytes;
  const first = path.join(logs, "codex-tui.log.000000");
  const inode = (await fs.stat(first)).ino;
  const originals = new Map();
  let allocated = 0;
  for (const entry of scan.entries.filter((e) => e.selectable)) {
    const st = await fs.stat(path.join(root, entry.path));
    originals.set(entry.path, { ino: st.ino, dev: st.dev, size: st.size });
    if (typeof st.blocks === "number") allocated += st.blocks * 512;
  }
  report.allocatedFixtureBytes = allocated;
  const preview = await time("preview5000", () =>
    engine.preview(scan.entries.filter((x) => x.selectable).map((x) => x.id)),
  );
  const moved = await time("quarantine5000", () =>
    engine.quarantine(preview.token, true),
  );
  assert.equal(moved.completed, count);
  assert.equal(moved.failed.length, 0);
  assert.equal((await fs.readdir(logs)).length, 0);
  const manifest = path.join(
    root,
    ".agentvac-quarantine",
    moved.batchId,
    "manifest.json",
  );
  report.manifestBytes = (await fs.stat(manifest)).size;
  const restarted = new AgentVacEngine(root, key, true);
  const history = await time("historyAfterRestart5000", () =>
    restarted.history(),
  );
  assert.equal(
    history[0].items.filter((x) => x.status === "quarantined").length,
    count,
  );
  const lost = new AgentVacEngine(root, randomBytes(32), true);
  const lostHistory = await lost.history();
  assert.equal(
    lostHistory[0].items.some((item) => item.status === "failed"),
    true,
  );
  await assert.rejects(() => lost.restore(moved.batchId, true));
  const rescue = await time("readOnlyLostKeyRescue5000", () =>
    lost.inspectRecovery(),
  );
  assert.equal(rescue.storedBytes, count * size);
  assert.equal(
    rescue.batches.reduce((n, b) => n + b.storedFiles, 0),
    count,
  );
  assert.equal(
    rescue.batches.some((b) => b.verified),
    false,
  );
  report.checks.push(
    "Unknown key refuses authenticated restore; bounded read-only rescue reports all 5000 retained data files without modifying them.",
  );
  const restored = await time("restore5000", () =>
    restarted.restore(moved.batchId, true),
  );
  assert.equal(restored.completed, count);
  assert.equal(restored.failed.length, 0);
  assert.equal((await fs.readdir(logs)).length, count);
  for (const [relative, original] of originals) {
    const st = await fs.stat(path.join(root, relative));
    assert.deepEqual({ ino: st.ino, dev: st.dev, size: st.size }, original);
  }
  assert.equal((await fs.stat(first)).ino, inode);
  assert.equal(await digest(protectedPath), protectedDigest);
  const h = await fs.open(first, "r");
  const b = Buffer.alloc(80);
  await h.read(b, 0, b.length, 0);
  await h.close();
  assert.ok(
    b.toString().startsWith("Generated AgentVac performance fixture 0"),
  );
  report.checks.push(
    "All 5000 sparse files (156.25 GiB logical) quarantined and restored after engine restart; first inode/body prefix and protected marker unchanged.",
  );
  report.peakSampledRssBytes = peak;
  report.resourceUsage = process.resourceUsage();
} catch (e) {
  report.error = { message: e.message, stack: e.stack };
  process.exitCode = 1;
  console.error(e);
} finally {
  clearInterval(sampler);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(out, "performance-results.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.rm(root, { recursive: true, force: true });
  console.log("Report", path.join(out, "performance-results.json"));
}
