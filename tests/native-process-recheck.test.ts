import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { collectStableProcessSnapshot } from "../electron/processes.js";
import { codexAdapter } from "../electron/providers/codex.js";
test("fresh inventory is rechecked before quarantine and restore; a newly running writer never inherits earlier clear state", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-process-fence-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "log"));
  const file = path.join(root, "log", "codex-tui.log.1");
  await fs.writeFile(file, "synthetic preserved log");
  const old = new Date(Date.now() - 90 * 86400000);
  await fs.utimes(file, old, old);
  let running = false,
    observations = 0;
  const check = async () => {
    let attempt = 0;
    return codexAdapter.assessProcesses(
      await collectStableProcessSnapshot(
        async () => {
          observations++;
          return {
            platform: "linux",
            complete: ++attempt > 3,
            processes: [
              running
                ? { name: "codex", commandLine: "/usr/bin/codex" }
                : { name: "init", commandLine: "/sbin/init" },
            ],
          };
        },
        { retryDelayMs: 0 },
      ),
    );
  };
  const engine = new AgentVacEngine(root, randomBytes(32), false, check);
  await engine.initialize();
  let scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  let preview = await engine.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  assert.equal(preview.processStatus.status, "clear");
  running = true;
  await assert.rejects(engine.quarantine(preview.token, true), /正在运行/);
  assert.equal(await fs.readFile(file, "utf8"), "synthetic preserved log");
  assert.equal((await engine.history()).length, 0);
  running = false;
  scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  preview = await engine.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1);
  running = true;
  await assert.rejects(engine.restore(moved.batchId!, true), /正在运行/);
  assert.equal((await engine.inspectRecovery()).batches[0].storedFiles, 1);
  running = false;
  assert.equal((await engine.restore(moved.batchId!, true)).completed, 1);
  assert.equal(await fs.readFile(file, "utf8"), "synthetic preserved log");
  assert.ok(observations >= 10);
});
