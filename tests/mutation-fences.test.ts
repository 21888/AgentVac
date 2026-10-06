import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
import { codexAdapter } from "../electron/providers/codex.js";

const clear = async () => ({
  status: "clear" as const,
  details: "generated stopped-process fixture",
});
async function fixture(t: TestContext, unit = false) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-mutation-fence-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, unit ? "Cursor" : "Codex"),
    key = randomBytes(32);
  const adapter = unit ? cursorAdapter : codexAdapter;
  const files = unit
    ? ["index", "data_0", "data_1", "data_2", "data_3"].map(
        (n) => "GPUCache/" + n,
      )
    : ["log/codex-tui.log.1"];
  if (unit) {
    await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
    await fs.mkdir(path.join(root, "logs/20250101T000000"), {
      recursive: true,
    });
  }
  for (const file of files) {
    const p = path.join(root, file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "generated " + file);
    await fs.utimes(p, new Date("2024-01-01"), new Date("2024-01-01"));
  }
  if (unit)
    await fs.utimes(
      path.join(root, "GPUCache"),
      new Date("2024-01-01"),
      new Date("2024-01-01"),
    );
  const engine = (checker = clear) =>
    new AgentVacEngine(root, key, false, checker, [], adapter);
  const writer = engine(),
    scan = await writer.scan({ minAgeDays: 30, includeSessions: false });
  const p = await writer.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const moved = await writer.quarantine(p.token, true);
  assert.equal(moved.completed, 1);
  const directory = path.join(root, ".agentvac-quarantine", moved.batchId),
    manifest = path.join(directory, "manifest.json");
  const journal = JSON.parse(await fs.readFile(manifest, "utf8")).journal;
  const stored = path.join(
    directory,
    journal.items[0].id + (unit ? ".unit" : ".data"),
  );
  return {
    root,
    base,
    key,
    files,
    engine,
    batch: moved.batchId,
    manifest,
    stored,
    directory,
    original: path.join(root, files[0]),
  };
}
async function attempt(engine: AgentVacEngine, batch: string) {
  try {
    return { result: await engine.restore(batch, true) };
  } catch (error) {
    return { error };
  }
}

for (const action of ["cancel", "invalidate"] as const)
  for (const moment of [
    "check-finish",
    "manifest-published",
    "link-created",
  ] as const)
    test(`${action} at ${moment} blocks the next ordinary payload mutation and preserves recoverability`, async (t) => {
      const f = await fixture(t);
      let hit = false,
        links = 0,
        unlinks = 0;
      const e = f.engine(async () => {
        if (moment === "check-finish") stop();
        return clear();
      });
      const stop = () => {
        if (!hit) {
          hit = true;
          action === "cancel" ? e.cancelScan() : e.invalidate();
        }
      };
      const rename = fs.rename,
        link = fs.link,
        unlink = fs.unlink;
      const before = await fs.readFile(f.manifest);
      const mocks = [
        t.mock.method(fs, "rename", async (a: PathLike, b: PathLike) => {
          await rename(a, b);
          if (moment === "manifest-published" && String(b) === f.manifest)
            stop();
        }),
        t.mock.method(fs, "link", async (a: PathLike, b: PathLike) => {
          await link(a, b);
          if (String(a) === f.stored) {
            links++;
            if (moment === "link-created") stop();
          }
        }),
        t.mock.method(fs, "unlink", async (p: PathLike) => {
          if (String(p) === f.stored) unlinks++;
          return unlink(p);
        }),
      ];
      let first;
      try {
        first = await attempt(e, f.batch);
      } finally {
        for (const m of mocks) m.mock.restore();
      }
      assert.equal(hit, true);
      assert.equal(first.result?.completed ?? 0, 0);
      assert.ok(first.error || first.result?.failed.length);
      assert.equal(links, moment === "link-created" ? 1 : 0);
      assert.equal(unlinks, 0);
      assert.equal(
        await fs.readFile(f.stored, "utf8"),
        "generated " + f.files[0],
      );
      if (moment === "link-created") {
        const a = await fs.lstat(f.stored, { bigint: true }),
          b = await fs.lstat(f.original, { bigint: true });
        assert.equal(a.ino, b.ino);
        assert.equal(a.nlink, 2n);
        assert.equal(
          JSON.parse(await fs.readFile(f.manifest, "utf8")).journal.items[0]
            .restorePending,
          true,
        );
      } else await assert.rejects(fs.lstat(f.original), { code: "ENOENT" });
      if (moment === "check-finish")
        assert.deepEqual(await fs.readFile(f.manifest), before);
      if (action === "invalidate")
        await assert.rejects(e.restore(f.batch, true), /失效/);
      const retry = action === "cancel" ? e : f.engine();
      assert.equal((await retry.restore(f.batch, true)).completed, 1);
      assert.equal(
        await fs.readFile(f.original, "utf8"),
        "generated " + f.files[0],
      );
      assert.equal((await fs.lstat(f.original)).nlink, 1);
    });

for (const action of ["cancel", "invalidate"] as const)
  test(`${action} after an admitted unit link checkpoints it and prevents later links/unlinks`, async (t) => {
    const f = await fixture(t, true),
      e = f.engine(),
      link = fs.link,
      unlink = fs.unlink;
    let hit = false,
      links = 0,
      unlinks = 0;
    const a = t.mock.method(
      fs,
      "link",
      async (from: PathLike, to: PathLike) => {
        await link(from, to);
        if (String(from).startsWith(f.stored + path.sep)) {
          links++;
          if (!hit) {
            hit = true;
            action === "cancel" ? e.cancelScan() : e.invalidate();
          }
        }
      },
    );
    const b = t.mock.method(fs, "unlink", async (p: PathLike) => {
      if (String(p).startsWith(f.stored + path.sep)) unlinks++;
      return unlink(p);
    });
    let first;
    try {
      first = await attempt(e, f.batch);
    } finally {
      a.mock.restore();
      b.mock.restore();
    }
    assert.equal(hit, true);
    assert.equal(first.result?.completed ?? 0, 0);
    assert.equal(links, 1);
    assert.equal(unlinks, 0);
    const journal = JSON.parse(await fs.readFile(f.manifest, "utf8")).journal;
    assert.equal(journal.items[0].unit.restore.linked.length, 1);
    const retry = action === "cancel" ? e : f.engine();
    assert.equal((await retry.restore(f.batch, true)).completed, 1);
    for (const file of f.files) {
      assert.equal(
        await fs.readFile(path.join(f.root, file), "utf8"),
        "generated " + file,
      );
      assert.equal((await fs.lstat(path.join(f.root, file))).nlink, 1);
    }
  });

for (const action of ["cancel", "invalidate"] as const)
  test(`${action} while preview checks processes cannot publish a stale token`, async (t) => {
    const f = await fixture(t);
    await f.engine().restore(f.batch, true);
    let armed = false;
    const e = f.engine(async () => {
      if (armed) action === "cancel" ? e.cancelScan() : e.invalidate();
      return clear();
    });
    const scan = await e.scan({ minAgeDays: 30, includeSessions: false });
    armed = true;
    await assert.rejects(
      e.preview(scan.entries.filter((x) => x.selectable).map((x) => x.id)),
      /取消|失效/,
    );
    assert.equal(
      await fs.readFile(f.original, "utf8"),
      "generated " + f.files[0],
    );
  });

test("cancelling a saved preview does not revive it when a fresh mutation is admitted", async (t) => {
  const f = await fixture(t);
  await f.engine().restore(f.batch, true);
  const e = f.engine(),
    scan = await e.scan({ minAgeDays: 30, includeSessions: false });
  const p = await e.preview(
    scan.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  e.cancelScan();
  await assert.rejects(e.quarantine(p.token, true), /预览/);
  assert.equal(
    await fs.readFile(f.original, "utf8"),
    "generated " + f.files[0],
  );
});

for (const action of ["cancel", "invalidate"] as const)
  test(`${action} after one quarantine rename records admitted work but does not move the next file`, async (t) => {
    const f = await fixture(t);
    await f.engine().restore(f.batch, true);
    const second = path.join(f.root, "log/codex-tui.log.2");
    await fs.writeFile(second, "generated second file");
    await fs.utimes(second, new Date("2024-01-01"), new Date("2024-01-01"));
    const e = f.engine(),
      scan = await e.scan({ minAgeDays: 30, includeSessions: false });
    const p = await e.preview(
        scan.entries.filter((x) => x.selectable).map((x) => x.id),
      ),
      rename = fs.rename;
    let payloadMoves = 0;
    const m = t.mock.method(fs, "rename", async (a: PathLike, b: PathLike) => {
      await rename(a, b);
      if ([f.original, second].includes(String(a))) {
        payloadMoves++;
        action === "cancel" ? e.cancelScan() : e.invalidate();
      }
    });
    let result;
    try {
      result = await e.quarantine(p.token, true);
    } finally {
      m.mock.restore();
    }
    assert.equal(payloadMoves, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 1);
    const restored = await f.engine().restore(result.batchId, true);
    assert.equal(restored.completed, 1);
    assert.equal(
      await fs.readFile(f.original, "utf8"),
      "generated " + f.files[0],
    );
    assert.equal(await fs.readFile(second, "utf8"), "generated second file");
  });

test("a newly running writer observed after link blocks unlink and a later stopped retry recovers", async (t) => {
  const f = await fixture(t);
  let running = false;
  const e = new AgentVacEngine(f.root, f.key, false, async () => ({
    status: running ? "running" : "clear",
    details: "generated writer transition",
  }));
  const link = fs.link,
    m = t.mock.method(fs, "link", async (a: PathLike, b: PathLike) => {
      await link(a, b);
      if (String(a) === f.stored) running = true;
    });
  let first;
  try {
    first = await attempt(e, f.batch);
  } finally {
    m.mock.restore();
  }
  assert.equal(first.result?.completed ?? 0, 0);
  assert.equal((await fs.lstat(f.stored)).nlink, 2);
  running = false;
  assert.equal((await e.restore(f.batch, true)).completed, 1);
});

for (const replacement of ["batch", "manifest"] as const)
  test(`interrupted checkpoint refuses a replaced ${replacement} and preserves both source generations`, async (t) => {
    const f = await fixture(t),
      e = f.engine(),
      link = fs.link;
    const preserved = f.directory + "-preserved",
      replacementText = "generated replacement must not be overwritten";
    const m = t.mock.method(fs, "link", async (a: PathLike, b: PathLike) => {
      await link(a, b);
      if (String(a) !== f.stored) return;
      if (replacement === "batch") {
        await fs.rename(f.directory, preserved);
        await fs.mkdir(f.directory);
      } else await fs.rename(f.manifest, f.manifest + ".preserved");
      await fs.writeFile(f.manifest, replacementText);
      e.cancelScan();
    });
    let first;
    try {
      first = await attempt(e, f.batch);
    } finally {
      m.mock.restore();
    }
    assert.ok(first.error || first.result?.failed.length);
    assert.equal(first.result?.completed ?? 0, 0);
    assert.equal(await fs.readFile(f.manifest, "utf8"), replacementText);
    const stored =
      replacement === "batch"
        ? path.join(preserved, path.basename(f.stored))
        : f.stored;
    assert.equal(await fs.readFile(stored, "utf8"), "generated " + f.files[0]);
    assert.equal((await fs.lstat(stored)).nlink, 2);
  });
