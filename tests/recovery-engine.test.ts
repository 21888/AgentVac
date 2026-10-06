import { trashFixture } from "./helpers/trash.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
async function setup(t: any) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-key-engine-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "log"));
  for (const index of [1, 2, 3]) {
    const p = path.join(root, "log", `codex-tui.log.${index}`);
    await fs.writeFile(p, `fixture-${index}`);
    const old = new Date(Date.now() - 100 * 86400000);
    await fs.utimes(p, old, old);
  }
  const key = randomBytes(32);
  const engine = new AgentVacEngine(root, key, true);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.slice(0, 2).map((e) => e.id),
  );
  const result = await engine.quarantine(preview.token, true);
  return {
    root,
    key,
    result,
    manifest: path.join(
      root,
      ".agentvac-quarantine",
      result.batchId,
      "manifest.json",
    ),
  };
}
test("imported trusted key restores old batch without replacing or orphaning the new primary", async (t) => {
  const { root, key, result, manifest } = await setup(t);
  const newKey = randomBytes(32);
  const engine = new AgentVacEngine(root, newKey, true, undefined, [key]);
  assert.equal(
    (await engine.history())[0].items.filter((i) => i.status === "quarantined")
      .length,
    2,
  );
  const restored = await engine.restore(result.batchId, true);
  assert.equal(restored.completed, 2);
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal(
    saved.keyId,
    createHash("sha256").update(key).digest("hex"),
    "restore preserves the existing batch's authentic signing key",
  );
  assert.ok(
    (await new AgentVacEngine(root, key, true).history())[0].items.every(
      (i) => i.status === "restored",
    ),
  );
  assert.equal(
    await fs.readFile(path.join(root, "log/codex-tui.log.1"), "utf8"),
    "fixture-1",
  );
});
test("unavailable primary blocks new quarantine/trash but permits authenticated recovery", async (t) => {
  const { root, key, result } = await setup(t);
  const readonly = new AgentVacEngine(root, null, true, undefined, [key]);
  const scan = await readonly.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await readonly.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  await assert.rejects(() => readonly.quarantine(preview.token, true), /密钥/);
  let called = false;
  await assert.rejects(
    () =>
      trashFixture(readonly, result.batchId, true, true, async () => {
        called = true;
      }),
    /密钥/,
  );
  assert.equal(called, false);
  const info = await readonly.inspectRecovery();
  assert.equal(info.readOnly, true);
  assert.equal(info.batches[0].verified, true);
  assert.equal(info.batches[0].storedFiles, 2);
  const restored = await readonly.restore(result.batchId, true);
  assert.equal(restored.completed, 2);
});
test("lost key inspection reports actual preserved data, never authenticates or changes it", async (t) => {
  const { root, result, manifest } = await setup(t);
  const before = await fs.readFile(manifest);
  const dir = path.dirname(manifest);
  const names = (await fs.readdir(dir)).sort();
  const snapshots = await Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await fs.readFile(path.join(dir, name)),
      stat: await fs.stat(path.join(dir, name)),
    })),
  );
  const lost = new AgentVacEngine(root, null, true);
  const info = await lost.inspectRecovery();
  assert.equal(info.truncated, false);
  assert.equal(info.batches[0].id, result.batchId);
  assert.equal(info.batches[0].verified, false);
  assert.equal(info.batches[0].storedFiles, 2);
  assert.equal(info.storedBytes, 18);
  assert.match(info.batches[0].explanation, /缺少原恢复钥匙/);
  assert.deepEqual(await fs.readFile(manifest), before);
  for (const snapshot of snapshots) {
    const file = path.join(dir, snapshot.name);
    assert.deepEqual(await fs.readFile(file), snapshot.bytes);
    const after = await fs.stat(file);
    assert.equal(after.ino, snapshot.stat.ino);
    assert.equal(after.mtimeMs, snapshot.stat.mtimeMs);
    assert.equal(after.ctimeMs, snapshot.stat.ctimeMs);
  }
  await assert.rejects(() => lost.restore(result.batchId, true));
});
test("recovery inspection does not create quarantine directories or accept malformed key collections", async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-empty-inspect-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new AgentVacEngine(root, null, true);
  assert.equal((await engine.inspectRecovery()).batches.length, 0);
  assert.deepEqual(await fs.readdir(root), []);
  assert.throws(() => new AgentVacEngine(root, Buffer.alloc(1), true), /密钥/);
  assert.throws(
    () =>
      new AgentVacEngine(
        root,
        null,
        true,
        undefined,
        Array.from({ length: 17 }, () => randomBytes(32)),
      ),
    /密钥/,
  );
});
