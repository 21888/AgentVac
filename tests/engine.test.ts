import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  AgentVacEngine,
  classify,
  validRelative,
  loadKey,
} from "../electron/engine.js";
import type { ProcessStatus } from "../shared/types.js";
const DAY = 86_400_000;
async function symlinkOrSkip(t: any, target: string, link: string) {
  try {
    await fs.symlink(target, link);
    return true;
  } catch (e) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Windows symlink privilege unavailable; not verified");
      return false;
    }
    throw e;
  }
}
async function setup(
  t: any,
  processCheck?: () => Promise<ProcessStatus>,
  demo = true,
) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const engine = new AgentVacEngine(root, key, demo, processCheck);
  await engine.initialize();
  return { root, key, engine };
}
async function file(
  root: string,
  rel: string,
  age = 60,
  text = "fixture only",
) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
  const d = new Date(Date.now() - age * DAY);
  await fs.utimes(p, d, d);
  return p;
}
async function scan(engine: AgentVacEngine, includeSessions = false) {
  return engine.scan({ minAgeDays: 30, includeSessions });
}
async function previewAll(engine: AgentVacEngine) {
  const s = await scan(engine);
  return engine.preview(s.entries.filter((e) => e.selectable).map((e) => e.id));
}
test("only allowlisted rotated logs are safe; active logs remain protected", () => {
  assert.equal(classify("log/codex-tui.log.1").risk, "safe");
  assert.equal(classify("log/codex-tui.log.2025-01-01.gz").risk, "safe");
  assert.equal(classify("log/codex-tui.log").risk, "protected");
  assert.equal(classify("log/unrecognized.log").risk, "protected");
});
test("protect credentials, config, state, input history, index, skills, MCP and projects", () => {
  for (const p of [
    "auth.json",
    "config.toml",
    "history.jsonl",
    "session_index.jsonl",
    "state_5.sqlite",
    "state_5.sqlite-wal",
    "state_5.sqlite-shm",
    "skills/foo/SKILL.md",
    "mcp/server.json",
    "projects/code.ts",
  ])
    assert.equal(classify(p).risk, "protected", p);
});
test("unknown cache candidates are never automatically safe", () =>
  assert.notEqual(classify("cache/example.cache").risk, "safe"));
test("reject traversal, absolute paths and cross-platform drive/UNC forms", () => {
  for (const p of [
    "../auth.json",
    "log/../../auth.json",
    "/etc/passwd",
    "C:/Windows/file",
    "C:\\Windows\\file",
    "\\\\server\\share",
    "log//file",
    "log/./file",
    "log/a\0b",
    "log/name:stream",
  ])
    assert.equal(validRelative(p), false, p);
  assert.equal(validRelative("sessions/2025/one.jsonl"), true);
});
test("scan requires explicit root and validates age range", async (t) => {
  const { engine } = await setup(t);
  await assert.rejects(engine.scan({ minAgeDays: 0, includeSessions: false }));
  await assert.rejects(
    engine.scan({ minAgeDays: 1.2, includeSessions: false }),
  );
  await assert.rejects(
    engine.scan({ minAgeDays: 4000, includeSessions: false }),
  );
});
test("sessions are protected by default, old review sessions only when opted in", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "sessions/2025/rollout.jsonl");
  let s = await scan(engine);
  assert.equal(s.entries[0].selectable, false);
  s = await scan(engine, true);
  assert.equal(s.entries[0].risk, "review");
  assert.equal(s.entries[0].selectable, true);
});
test("recent sessions stay protected even after review opt in", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "sessions/recent.jsonl", 1);
  const s = await scan(engine, true);
  assert.equal(s.entries[0].selectable, false);
});
test("unknown directories are not traversed or counted as known file bytes", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "projects/log/codex-tui.log.1");
  const s = await scan(engine);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].kind, "directory");
  assert.equal(s.summary.totalBytes, 0);
});
test("metadata scan protects symlinks and does not follow them", async (t) => {
  const { root, engine } = await setup(t);
  const external = path.join(root, "outside.txt");
  await file(root, "outside.txt");
  await fs.mkdir(path.join(root, "log"));
  if (
    !(await symlinkOrSkip(t, external, path.join(root, "log/codex-tui.log.1")))
  )
    return;
  const s = await scan(engine);
  assert.equal(
    s.entries.find((e) => e.path === "log/codex-tui.log.1")!.selectable,
    false,
  );
});
test("root symlinks are refused", async (t) => {
  const { root, key } = await setup(t);
  await fs.mkdir(path.join(root, "real"));
  if (
    !(await symlinkOrSkip(t, path.join(root, "real"), path.join(root, "alias")))
  )
    return;
  const engine = new AgentVacEngine(path.join(root, "alias"), key);
  await assert.rejects(engine.initialize(), /链接/);
});
test("hard-linked eligible file is protected", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1");
  await fs.link(p, path.join(root, "other"));
  const s = await scan(engine);
  assert.equal(s.entries.find((e) => e.path.endsWith(".1"))!.selectable, false);
});
test("no selection, duplicate ids and protected selection are rejected", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "auth.json");
  const s = await scan(engine);
  await assert.rejects(engine.preview([]));
  await assert.rejects(engine.preview([s.entries[0].id]));
  await assert.rejects(engine.preview(["x", "x"]));
});
test("preview rejects modified source", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1");
  const s = await scan(engine);
  await fs.appendFile(p, "changed");
  await assert.rejects(engine.preview([s.entries[0].id]), /变化/);
});
test("quarantine revalidates and skips files modified after preview", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await fs.appendFile(p, "changed");
  const r = await engine.quarantine(v.token, true);
  assert.equal(r.completed, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(await fs.readFile(p, "utf8"), "fixture onlychanged");
});
test("quarantine and restore preserve exact bytes; no permanent delete", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1", 60, "preserve these bytes");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  assert.equal(r.completed, 1);
  await assert.rejects(fs.stat(p));
  let history = await engine.history();
  assert.equal(history[0].items[0].status, "quarantined");
  const restored = await engine.restore(r.batchId);
  assert.equal(restored.completed, 1);
  assert.equal(await fs.readFile(p, "utf8"), "preserve these bytes");
  history = await engine.history();
  assert.equal(history[0].items[0].status, "restored");
});
test("preview token is single-use", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await engine.quarantine(v.token, true);
  await assert.rejects(engine.quarantine(v.token, true), /失效/);
});
test("new scan invalidates prior preview", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await scan(engine);
  await assert.rejects(engine.quarantine(v.token, true), /失效/);
});
test("restoring never overwrites an existing destination", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  await fs.writeFile(p, "new content");
  const restored = await engine.restore(r.batchId);
  assert.equal(restored.completed, 0);
  assert.match(restored.failed[0].error, /不会覆盖/);
  assert.equal(await fs.readFile(p, "utf8"), "new content");
});
test("partial failures do not discard successfully quarantined files", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const p = await file(root, "log/codex-tui.log.2");
  const v = await previewAll(engine);
  await fs.appendFile(p, "mutated");
  const r = await engine.quarantine(v.token, true);
  assert.equal(r.completed, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(
    (await engine.history())[0].items.filter((i) => i.status === "quarantined")
      .length,
    1,
  );
});
test("tampered manifests cannot redirect restore", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  const p = path.join(root, ".agentvac-quarantine", r.batchId, "manifest.json");
  const j = JSON.parse(await fs.readFile(p, "utf8"));
  j.journal.items[0].path = "../escape";
  await fs.writeFile(p, JSON.stringify(j));
  await assert.rejects(engine.restore(r.batchId), /校验失败/);
});
test("quarantine symlinks are rejected", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  await fs.mkdir(path.join(root, "redirect"));
  if (
    !(await symlinkOrSkip(
      t,
      path.join(root, "redirect"),
      path.join(root, ".agentvac-quarantine"),
    ))
  )
    return;
  const v = await previewAll(engine);
  await assert.rejects(engine.quarantine(v.token, true), /链接/);
});
test("swapped parent directory symlink is rejected before quarantine", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await fs.rename(path.join(root, "log"), path.join(root, "old-log"));
  if (
    !(await symlinkOrSkip(
      t,
      path.join(root, "old-log"),
      path.join(root, "log"),
    ))
  )
    return;
  const r = await engine.quarantine(v.token, true);
  assert.equal(r.completed, 0);
  assert.equal(r.failed.length, 1);
});
test("quarantined file changes block restore", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  const h = (await engine.history())[0];
  await fs.appendFile(
    path.join(root, ".agentvac-quarantine", r.batchId, h.items[0].id + ".data"),
    "tamper",
  );
  const restored = await engine.restore(r.batchId);
  assert.equal(restored.completed, 0);
  assert.match(restored.failed[0].error, /变化/);
});
test("real quarantine requires closed-process confirmation", async (t) => {
  const { root, engine } = await setup(
    t,
    async () => ({ status: "clear", details: "test" }),
    false,
  );
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await assert.rejects(engine.quarantine(v.token, false), /确认/);
});
test("running Codex processes prevent quarantine and restore", async (t) => {
  let running = false;
  const { root, engine } = await setup(
    t,
    async () => ({ status: running ? "running" : "clear", details: "test" }),
    false,
  );
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  running = true;
  await assert.rejects(engine.quarantine(v.token, true), /正在运行/);
  running = false;
  const v2 = await previewAll(engine);
  const r = await engine.quarantine(v2.token, true);
  running = true;
  await assert.rejects(engine.restore(r.batchId, true), /正在运行/);
});
test("invalid batch identifiers cannot traverse quarantine", async (t) => {
  const { engine } = await setup(t);
  await assert.rejects(engine.restore("../auth"), /批次/);
});
test("history survives a fresh engine using same signing key", async (t) => {
  const { root, engine, key } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  const restarted = new AgentVacEngine(root, key, true);
  await restarted.initialize();
  assert.equal((await restarted.history())[0].id, r.batchId);
  assert.equal((await restarted.restore(r.batchId)).completed, 1);
});
test("foreign recovery key refuses manifest", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  const r = await engine.quarantine(v.token, true);
  const foreign = new AgentVacEngine(root, randomBytes(32), true);
  await assert.rejects(foreign.restore(r.batchId), /校验失败/);
});
test("local signing key is persisted and has correct length", async (t) => {
  const { root } = await setup(t);
  const a = await loadKey(path.join(root, "app-state"));
  const b = await loadKey(path.join(root, "app-state"));
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
});

test("scan cancellation leaves fixtures intact and a new scan succeeds", async (t) => {
  const { root, engine } = await setup(t);
  const p = await file(root, "log/codex-tui.log.1");
  const promise = scan(engine);
  engine.cancelScan();
  await assert.rejects(promise, /扫描已取消/);
  assert.equal(await fs.readFile(p, "utf8"), "fixture only");
  assert.equal((await scan(engine)).summary.eligibleFiles, 1);
});

test("active logs and live logging databases have log attribution but remain protected", () => {
  for (const p of [
    "log/codex-tui.log",
    "logs_1.sqlite",
    "logs_1.sqlite-wal",
    "logs_1.sqlite-shm",
  ]) {
    assert.equal(classify(p).category, "log");
    assert.equal(classify(p).risk, "protected");
  }
});

test("closure acknowledgement must be the exact boolean true at engine boundary", async (t) => {
  const { root, engine } = await setup(
    t,
    async () => ({ status: "clear", details: "test" }),
    false,
  );
  await file(root, "log/codex-tui.log.1");
  const v = await previewAll(engine);
  await assert.rejects(
    engine.quarantine(v.token, "true" as unknown as boolean),
    /确认/,
  );
});
test("intrinsically protected recent files retain their actual protection reason", async (t) => {
  const { root, engine } = await setup(t);
  await file(root, "auth.json", 0);
  await file(root, "logs_1.sqlite", 0);
  const s = await scan(engine);
  assert.match(s.entries.find((e) => e.path === "auth.json")!.reason, /凭据/);
  assert.match(
    s.entries.find((e) => e.path === "logs_1.sqlite")!.reason,
    /实时日志数据库/,
  );
});

test("explicit session review quarantines and restores exact bytes without touching index or credentials", async (t) => {
  const { root, engine, key } = await setup(
    t,
    async () => ({ status: "clear", details: "fixture process check" }),
    false,
  );
  const content =
    '{"type":"generated_test_session","payload":"not real user data"}\n';
  const rel = "sessions/2025/01/rollout-selected.jsonl";
  const original = await file(root, rel, 120, content);
  const protectedFiles = [
    "auth.json",
    "history.jsonl",
    "session_index.jsonl",
    "state_5.sqlite",
  ];
  for (const p of protectedFiles)
    await file(root, p, 120, `protected fixture ${p}`);
  const before = await scan(engine);
  assert.equal(before.entries.find((e) => e.path === rel)?.selectable, false);
  const reviewed = await scan(engine, true);
  const session = reviewed.entries.find((e) => e.path === rel)!;
  assert.equal(session.risk, "review");
  const preview = await engine.preview([session.id]);
  await assert.rejects(() => engine.quarantine(preview.token, false));
  const fresh = await engine.preview([session.id]);
  const quarantined = await engine.quarantine(fresh.token, true);
  assert.equal(quarantined.completed, 1);
  assert.equal(quarantined.failed.length, 0);
  await assert.rejects(() => fs.stat(original), { code: "ENOENT" });
  const restarted = new AgentVacEngine(root, key, false, async () => ({
    status: "clear",
    details: "fixture process check",
  }));
  const restored = await restarted.restore(quarantined.batchId, true);
  assert.equal(restored.completed, 1);
  assert.equal(await fs.readFile(original, "utf8"), content);
  for (const p of protectedFiles)
    assert.equal(
      await fs.readFile(path.join(root, p), "utf8"),
      `protected fixture ${p}`,
    );
});
