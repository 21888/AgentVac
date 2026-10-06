import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";

async function fixture(t: TestContext, parent = os.tmpdir()) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(parent), "agentvac-ancestor-"),
  );
  const root = path.join(base, "provider"),
    relative = "log/codex-tui.log.1";
  await fs.mkdir(path.join(root, "log"), { recursive: true });
  const file = path.join(root, relative),
    content = "generated ancestor boundary fixture";
  await fs.writeFile(file, content);
  const old = new Date("2024-01-01T00:00:00Z");
  await fs.utimes(file, old, old);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, relative, file, content, key: randomBytes(32) };
}

test("real workspace ancestors require directory/no-link checks without unused identity normalization", async (t) => {
  const f = await fixture(t, process.cwd());
  const engine = new AgentVacEngine(f.root, f.key, true);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const entry = scan.entries.find((e) => e.path === f.relative)!;
  assert.equal(entry.selectable, true);
  const moved = await engine.quarantine(
    (await engine.preview([entry.id])).token,
    true,
  );
  assert.equal(moved.completed, 1);
  assert.equal(
    (await new AgentVacEngine(f.root, f.key, true).restore(moved.batchId, true))
      .completed,
    1,
  );
  assert.equal(await fs.readFile(f.file, "utf8"), f.content);
});

test("synthetic unsupported identity on a type-only ancestor does not become a signed identity", async (t) => {
  const f = await fixture(t),
    lstat = fs.lstat;
  t.mock.method(fs, "lstat", async (p: PathLike, options?: any) => {
    const s = await (lstat as any)(p, options);
    if (String(p) === f.base)
      Object.assign(s, { ino: options?.bigint ? -2n : -2 });
    return s;
  });
  const e = new AgentVacEngine(f.root, f.key, true);
  const scan = await e.scan({ minAgeDays: 30, includeSessions: false });
  const moved = await e.quarantine(
    (await e.preview(scan.entries.filter((x) => x.selectable).map((x) => x.id)))
      .token,
    true,
  );
  assert.equal(moved.completed, 1);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".agentvac-quarantine", moved.batchId, "manifest.json"),
      "utf8",
    ),
  );
  assert.ok(BigInt(manifest.journal.items[0].before.ino) > 0n);
  assert.equal((await e.restore(moved.batchId, true)).completed, 1);
});

test("selected-root unsupported identity still fails before any quarantine directory is created", async (t) => {
  const f = await fixture(t),
    lstat = fs.lstat;
  t.mock.method(fs, "lstat", async (p: PathLike, options?: any) => {
    const s = await (lstat as any)(p, options);
    if (String(p) === f.root)
      Object.assign(s, { ino: options?.bigint ? -2n : -2 });
    return s;
  });
  await assert.rejects(
    new AgentVacEngine(f.root, f.key, true).initialize(),
    /身份/,
  );
  await assert.rejects(fs.lstat(path.join(f.root, ".agentvac-quarantine")), {
    code: "ENOENT",
  });
  assert.equal(await fs.readFile(f.file, "utf8"), f.content);
});

test("ancestry-only checks still reject linked and non-directory components", async (t) => {
  const f = await fixture(t),
    alias = path.join(f.base, "alias"),
    ordinaryFile = path.join(f.base, "file");
  await fs.symlink(f.root, alias, "dir");
  await fs.writeFile(ordinaryFile, "generated non-directory");
  await assert.rejects(
    new AgentVacEngine(path.join(alias, "log"), f.key, true).initialize(),
    /链接|目录/,
  );
  await assert.rejects(
    new AgentVacEngine(
      path.join(ordinaryFile, "child"),
      f.key,
      true,
    ).initialize(),
    /链接|目录/,
  );
  assert.equal(await fs.readFile(f.file, "utf8"), f.content);
});
