import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { codexAdapter } from "../electron/providers/codex.js";
import { installSyntheticSafeFileIds } from "./helpers/synthetic-safe-file-ids.js";
import { trashFixture } from "./helpers/trash.js";
const clear = async () => ({
  status: "clear" as const,
  details: "synthetic fixture only",
});
const fp = (s: Stats) => ({
  dev: s.dev,
  ino: s.ino,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
  nlink: s.nlink,
  mode: s.mode,
});
async function fixture(t: TestContext, safeIds = false) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-codex-safety-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (safeIds) installSyntheticSafeFileIds(t, root);
  const key = randomBytes(32);
  const engine = new AgentVacEngine(root, key, false, clear);
  await engine.initialize();
  return { root, key, engine };
}
async function put(root: string, rel: string, body = "synthetic") {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
  await fs.utimes(p, new Date("2025-01-01"), new Date("2025-01-01"));
  return p;
}
async function signedLegacy(
  t: TestContext,
  version = 2,
  relative = "sessions/2025/01/rollout-legacy.jsonl",
  safeIds = true,
) {
  // Positive legacy compatibility requires exact, representable numeric IDs.
  // Model those IDs only within this generated tree; never repair native IDs.
  const f = await fixture(t, safeIds);
  const original = await put(f.root, relative, "legacy signed session bytes");
  const before = fp(await fs.lstat(original));
  const id = randomUUID(),
    itemId = randomUUID(),
    dir = path.join(f.root, ".agentvac-quarantine", id);
  await fs.mkdir(dir, { recursive: true });
  const payload = path.join(dir, itemId + ".data");
  await fs.rename(original, payload);
  const journal: any = {
    version,
    ...(version === 1 ? {} : { provider: "codex" }),
    id,
    root: f.root,
    createdAt: new Date().toISOString(),
    items: [
      {
        id: itemId,
        path: relative,
        size: before.size,
        status: "quarantined",
        before,
        stored: fp(await fs.lstat(payload)),
      },
    ],
  };
  const manifest = path.join(dir, "manifest.json");
  const save = async (signed = true) =>
    fs.writeFile(
      manifest,
      JSON.stringify({
        journal,
        signature: signed
          ? createHmac("sha256", f.key)
              .update(JSON.stringify(journal))
              .digest("hex")
          : "00".repeat(32),
      }),
    );
  await save();
  return { ...f, journal, save, id, payload, original, manifest };
}
test("Codex file scan and direct preview cannot quarantine even old explicitly reviewed session parents", async (t) => {
  const f = await fixture(t);
  const parent = "sessions/2025/01/rollout-parent.jsonl",
    child = "sessions/2025/01/rollout-child.jsonl";
  await put(f.root, parent, "synthetic referenced parent");
  await put(
    f.root,
    child,
    JSON.stringify({
      type: "session_meta",
      payload: {
        history_mode: "paginated",
        history_base: {
          thread_id: "synthetic-parent",
          end_ordinal_exclusive: 2,
          end_byte_offset: 40,
        },
      },
    }),
  );
  const scan = await f.engine.scan({ minAgeDays: 30, includeSessions: true });
  for (const row of scan.entries.filter((r) => r.category === "session")) {
    assert.equal(row.selectable, false);
    await assert.rejects(f.engine.preview([row.id]));
  }
  assert.equal(
    await fs.readFile(path.join(f.root, parent), "utf8"),
    "synthetic referenced parent",
  );
});
test("policy change rejects stale preview tokens before a new journal or source movement", async (t) => {
  const f = await fixture(t);
  await put(f.root, "sessions/old.jsonl");
  const legacy = {
    ...codexAdapter,
    supportsSessionCleanup: true,
    classify: (relative: string) =>
      relative === "sessions/old.jsonl"
        ? {
            category: "session" as const,
            risk: "review" as const,
            reason: "old test-only policy",
          }
        : codexAdapter.classify(relative),
  };
  const engine = new AgentVacEngine(f.root, f.key, false, clear, [], legacy);
  await engine.initialize();
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const row = scan.entries.find((r) => r.path === "sessions/old.jsonl")!;
  const preview = await engine.preview([row.id]);
  legacy.supportsSessionCleanup = false;
  await assert.rejects(engine.quarantine(preview.token, true));
  assert.equal(
    await fs.readFile(path.join(f.root, "sessions/old.jsonl"), "utf8"),
    "synthetic",
  );
  assert.equal((await engine.history()).length, 0);
});
for (const version of [1, 2])
  test(`signed legacy v${version} session with synthetic safe IDs remains exactly restorable across restart`, async (t) => {
    const f = await signedLegacy(t, version);
    const restart = new AgentVacEngine(f.root, f.key, false, clear);
    await restart.initialize();
    assert.equal((await restart.history())[0].provider, "codex");
    const result = await restart.restore(f.id, true);
    assert.equal(result.completed, 1);
    assert.equal(
      await fs.readFile(f.original, "utf8"),
      "legacy signed session bytes",
    );
    assert.equal((await restart.restore(f.id, true)).completed, 0);
  });
test("legacy session recovery with synthetic safe IDs never overwrites a newly generated destination", async (t) => {
  const f = await signedLegacy(t);
  await fs.writeFile(f.original, "new generation");
  const result = await f.engine.restore(f.id, true);
  assert.equal(result.completed, 0);
  assert.equal(await fs.readFile(f.original, "utf8"), "new generation");
  assert.equal(
    await fs.readFile(f.payload, "utf8"),
    "legacy signed session bytes",
  );
});
for (const version of [1, 2])
  test(`native signed legacy v${version} session with unsupported numeric IDs refuses recovery and Trash unchanged`, async (t) => {
    // Intentionally unmocked: this control must observe this host's raw Stats.
    const f = await signedLegacy(t, version, undefined, false);
    const unsupported = [
      f.journal.items[0].before,
      f.journal.items[0].stored,
    ].some(
      (value) =>
        !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino),
    );
    if (!unsupported) {
      t.skip(
        "generated native IDs fit safe Numbers; native unsupported-ID rejection not exercised",
      );
      return;
    }
    const exactPayloadMetadata = async () => {
      const stat = await fs.lstat(f.payload, { bigint: true });
      return [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mode,
        stat.nlink,
        stat.mtimeNs,
        stat.ctimeNs,
        stat.birthtimeNs,
      ];
    };
    const manifest = await fs.readFile(f.manifest),
      payload = await fs.readFile(f.payload),
      identity = await exactPayloadMetadata(),
      entries = (await fs.readdir(path.dirname(f.manifest))).sort(),
      restart = new AgentVacEngine(f.root, f.key, false, clear);
    await restart.initialize();
    await assert.rejects(restart.restore(f.id, true), {
      code: "ERR_AGENTVAC_FILE_IDENTITY",
    });
    await assert.rejects(
      trashFixture(restart, f.id, true, true, async () => {
        assert.fail("unsupported native legacy IDs must not reach Trash");
      }),
      { code: "ERR_AGENTVAC_FILE_IDENTITY" },
    );
    assert.equal((await restart.inspectRecovery()).batches[0].verified, false);
    assert.deepEqual(await fs.readFile(f.manifest), manifest);
    assert.deepEqual(await fs.readFile(f.payload), payload);
    assert.deepEqual(await exactPayloadMetadata(), identity);
    assert.deepEqual(
      (await fs.readdir(path.dirname(f.manifest))).sort(),
      entries,
    );
    await assert.rejects(fs.lstat(f.original), { code: "ENOENT" });
    t.diagnostic(
      "identity-control=native-unsupported; recovery=refused; trash=refused; fixture=unchanged",
    );
  });
for (const attack of [
  "unsigned",
  "auth-path",
  "traversal",
  "wrong-root",
  "wrong-provider",
  "unknown-version",
  "changed-payload",
])
  test("legacy restore refuses " + attack, async (t) => {
    const f = await signedLegacy(t);
    if (attack === "auth-path") f.journal.items[0].path = "auth.json";
    if (attack === "traversal") f.journal.items[0].path = "../outside.jsonl";
    if (attack === "wrong-root") f.journal.root = f.root + "-wrong";
    if (attack === "wrong-provider") f.journal.provider = "cline";
    if (attack === "unknown-version") f.journal.version = 3;
    if (attack === "changed-payload")
      await fs.writeFile(f.payload, "modified archived bytes!!!");
    await f.save(attack !== "unsigned");
    const result = await f.engine
      .restore(f.id, true)
      .then((r) => r.completed)
      .catch(() => 0);
    assert.equal(result, 0);
    assert.ok(await fs.lstat(f.payload));
    await assert.rejects(fs.lstat(f.original), { code: "ENOENT" });
  });
test("legacy restore preserves unknown-process guard while logs remain newly eligible", async (t) => {
  const f = await signedLegacy(t);
  const unknown = new AgentVacEngine(f.root, f.key, false, async () => ({
    status: "unknown",
    details: "synthetic uncertainty",
  }));
  await unknown.initialize();
  await assert.rejects(unknown.restore(f.id, true));
  await put(f.root, "log/codex-tui.log.1");
  const scan = await f.engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(
    scan.entries.find((r) => r.path === "log/codex-tui.log.1")?.selectable,
    true,
  );
});
