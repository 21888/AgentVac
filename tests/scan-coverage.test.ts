import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import type { ScanProgress } from "../shared/types.js";
const old = new Date(Date.now() - 120 * 86400000);
async function setup(t: any) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-coverage-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, engine: new AgentVacEngine(root, randomBytes(32), true) };
}
async function file(root: string, relative: string, bytes = 1) {
  const p = path.join(root, relative);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const handle = await fs.open(p, "wx");
  await handle.truncate(bytes);
  await handle.close();
  await fs.utimes(p, old, old);
  return p;
}
const options = { minAgeDays: 30, includeSessions: false };
function monotonic(events: ScanProgress[]) {
  for (let index = 1; index < events.length; index++) {
    assert.ok(events[index].visitedEntries >= events[index - 1].visitedEntries);
    assert.ok(
      events[index].discoveredFiles >= events[index - 1].discoveredFiles,
    );
    assert.ok(
      events[index].discoveredBytes >= events[index - 1].discoveredBytes,
    );
    assert.ok(events[index].elapsedMs >= events[index - 1].elapsedMs);
  }
}
test("complete scoped scan reports unexpanded protected directories and true terminal progress", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1", 100);
  await file(root, "projects/never-read.txt", 900000);
  const events: ScanProgress[] = [];
  const requestId = randomUUID();
  const result = await engine.scan({ ...options, requestId }, (p) =>
    events.push(p),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.coverage.protectedDirectories, 1);
  assert.equal(result.summary.totalBytes, 100);
  assert.equal(result.coverage.limitReason, null);
  assert.ok(events.every((p) => p.requestId === requestId && p.root === root));
  assert.equal(events[0].phase, "scanning");
  assert.equal(events.at(-1)?.phase, "complete");
  assert.equal(events.at(-1)?.discoveredBytes, result.summary.totalBytes);
  monotonic(events);
});
test(
  "50,011 real files cannot masquerade as complete; 100k retry includes the large file",
  { timeout: 120000 },
  async (t) => {
    const { root, engine } = await setup(t);
    const dir = path.join(root, "log");
    await fs.mkdir(dir);
    for (let base = 0; base < 50010; base += 100) {
      await Promise.all(
        Array.from(
          { length: Math.min(100, 50010 - base) },
          async (_, offset) => {
            const p = path.join(
              dir,
              `codex-tui.log.${String(base + offset).padStart(6, "0")}`,
            );
            await fs.writeFile(p, "generated");
            await fs.utimes(p, old, old);
          },
        ),
      );
    }
    const largest = await file(
      root,
      "log/codex-tui.log.999999",
      300 * 1024 ** 3,
    );
    const before = await fs.stat(largest);
    const events: ScanProgress[] = [];
    const limited = await engine.scan(options, (p) => events.push(p));
    assert.equal(limited.status, "partial");
    assert.equal(limited.coverage.limitReason, "entry-count");
    assert.equal(limited.coverage.visitedEntries, 50000);
    assert.equal(limited.entries.length, 49999);
    assert.equal(events.at(-1)?.phase, "partial");
    assert.ok(limited.warnings.some((w) => w.includes("结果不完整")));
    assert.ok(Buffer.byteLength(JSON.stringify(limited)) < 25 * 1024 ** 2);
    monotonic(events);
    const candidate = limited.entries.find((e) => e.selectable)!;
    const preview = await engine.preview([candidate.id]);
    assert.equal(preview.scanStatus, "partial");
    const complete = await engine.scan({ ...options, maxEntries: 100000 });
    assert.equal(complete.status, "complete");
    assert.equal(complete.coverage.limitReason, null);
    assert.equal(complete.entries.length, 50011);
    assert.equal(complete.entries[0].path, "log/codex-tui.log.999999");
    assert.ok(complete.summary.totalBytes >= 300 * 1024 ** 3);
    assert.equal((await fs.stat(largest)).ino, before.ino);
    await assert.rejects(() => engine.quarantine(preview.token, true), /失效/);
  },
);
test("cancel and restart have separate request identities and no stale preview or late cancellation", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const first = randomUUID();
  const events: ScanProgress[] = [];
  await assert.rejects(
    () =>
      engine.scan({ ...options, requestId: first }, (p) => {
        events.push(p);
        if (p.phase === "scanning") engine.cancelScan(first);
      }),
    /取消/,
  );
  assert.equal(events.at(-1)?.phase, "cancelled");
  await assert.rejects(() => engine.preview([randomUUID()]));
  const second = randomUUID();
  const next: ScanProgress[] = [];
  const result = await engine.scan({ ...options, requestId: second }, (p) => {
    next.push(p);
    engine.cancelScan(first);
  });
  assert.equal(result.status, "complete");
  assert.equal(next.at(-1)?.phase, "complete");
  assert.ok(next.every((p) => p.requestId === second));
});
test("fatal scan failure emits error and never retains old selectable state", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const oldScan = await engine.scan(options);
  const events: ScanProgress[] = [];
  await assert.rejects(
    () =>
      engine.scan({ ...options, maxEntries: 200000 as any }, (p) =>
        events.push(p),
      ),
    /无效/,
  );
  assert.equal(events.at(-1)?.phase, "error");
  await assert.rejects(() => engine.preview([oldScan.entries[0].id]));
  assert.equal((await engine.scan(options)).status, "complete");
});
test("read errors and depth limits are explicit partial outcomes, not protected-directory completion", async (t) => {
  const { root, engine } = await setup(t);
  const blocked = path.join(root, "log");
  await fs.mkdir(blocked);
  const deep =
    "sessions/" +
    Array.from({ length: 14 }, (_, i) => `d${i}`).join("/") +
    "/rollout.jsonl";
  await file(root, deep);
  const original = fs.opendir;
  fs.opendir = (async (p: any, ...rest: any[]) => {
    if (String(p) === blocked)
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return (original as any)(p, ...rest);
  }) as any;
  let result;
  try {
    result = await engine.scan(options);
  } finally {
    fs.opendir = original;
  }
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.inaccessibleEntries, 1);
  assert.equal(result.coverage.depthLimitedDirectories, 1);
  assert.equal(result.coverage.protectedDirectories, 0);
  assert.equal(
    result.entries.some((e) => e.path.endsWith("rollout.jsonl")),
    false,
  );
});
test(
  "long-path result serialization stops at a bounded budget with an explicit partial reason",
  { timeout: 120000 },
  async (t) => {
    const { root, engine } = await setup(t);
    const relative =
      "log/" + ["a", "b", "c"].map((s) => s.repeat(200)).join("/");
    const directory = path.join(root, relative);
    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (e) {
      if (
        ["ENAMETOOLONG", "EINVAL", "ENOENT"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        t.skip(
          "Filesystem long-path support unavailable; budget fixture not verified here",
        );
        return;
      }
      throw e;
    }
    for (let base = 0; base < 26000; base += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          fs.writeFile(
            path.join(directory, String(base + i).padStart(200, "0")),
            "fixture",
          ),
        ),
      );
    const result = await engine.scan({ ...options, maxEntries: 100000 });
    assert.equal(result.status, "partial");
    assert.equal(result.coverage.limitReason, "result-bytes");
    assert.ok(result.coverage.resultBytes <= 24 * 1024 ** 2);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 25 * 1024 ** 2);
  },
);
