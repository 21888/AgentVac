import { trashFixture } from "./helpers/trash.js";
import { installSyntheticSafeFileIds } from "./helpers/synthetic-safe-file-ids.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { AgentVacEngine as V1 } from "./fixtures/historical-journal-readers/v0.1.0/electron/engine.js";
import { AgentVacEngine as V123 } from "./fixtures/historical-journal-readers/published-pre-v4/electron/engine.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
import { codexAdapter } from "../electron/providers/codex.js";

const old = new Date("2024-01-01");
const clear = async () => ({
  status: "clear" as const,
  details: "synthetic stopped processes",
});
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const sign = (j: any, key: Buffer) =>
  createHmac("sha256", key).update(JSON.stringify(j)).digest("hex");
async function fixture(t: TestContext, cursor = false, safeIds = false) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-v4-independent-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (safeIds) installSyntheticSafeFileIds(t, base);
  const root = path.join(base, cursor ? "Cursor" : "root");
  await fs.mkdir(root);
  if (cursor) {
    await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
    await fs.mkdir(path.join(root, "logs/20250202T123456"), {
      recursive: true,
    });
  }
  const put = async (relative: string) => {
    const p = path.join(root, relative);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "synthetic " + relative + "\n");
    await fs.utimes(p, old, old);
    return p;
  };
  return { base, root, key: randomBytes(32), rotated: randomBytes(32), put };
}
async function createBatch(
  t: TestContext,
  Engine: any = AgentVacEngine,
  interrupted = false,
  session = false,
  cursor = false,
  safeIds = Engine !== AgentVacEngine,
) {
  const f = await fixture(t, cursor, safeIds),
    relative = cursor
      ? "GPUCache"
      : session
        ? "sessions/2024/01/review.jsonl"
        : "log/codex-tui.log.1";
  const files = cursor
    ? ["index", "data_0", "data_1", "data_2", "data_3"].map(
        (n) => relative + "/" + n,
      )
    : [relative];
  for (const p of files) await f.put(p);
  if (cursor) await fs.utimes(path.join(f.root, relative), old, old);
  const engine = new Engine(
    f.root,
    f.key,
    false,
    clear,
    [],
    cursor ? cursorAdapter : codexAdapter,
  );
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: session });
  const selected = scan.entries.filter((e: any) => e.path === relative);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].selectable, true);
  const pv = await engine.preview([selected[0].id]);
  const rename = fs.rename;
  let publications = 0;
  const mock = interrupted
    ? t.mock.method(fs, "rename", async (a: PathLike, b: PathLike) => {
        if (
          path.basename(String(b)) === "manifest.json" &&
          ++publications === 2
        )
          throw new Error("independent interruption before checkpoint");
        return rename(a, b);
      })
    : null;
  try {
    if (interrupted)
      await assert.rejects(
        engine.quarantine(pv.token, true),
        /independent interruption/,
      );
    else assert.equal((await engine.quarantine(pv.token, true)).completed, 1);
  } finally {
    mock?.mock.restore();
  }
  const q = path.join(f.root, ".agentvac-quarantine"),
    ids = (await fs.readdir(q)).filter((n) => !n.endsWith(".json"));
  assert.equal(ids.length, 1);
  const id = ids[0],
    dir = path.join(q, id),
    manifest = path.join(dir, "manifest.json"),
    bytes = await fs.readFile(manifest),
    saved = JSON.parse(bytes.toString());
  const payload = path.join(
    dir,
    saved.journal.items[0].id + (cursor ? ".unit" : ".data"),
  );
  return {
    ...f,
    relative,
    files,
    id,
    dir,
    q,
    manifest,
    payload,
    bytes,
    saved,
    original: path.join(f.root, relative),
  };
}
async function envelope(file: string, key: Buffer, policy: number) {
  const x = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(x.journal.version, 4);
  assert.equal(x.journal.recoveryPolicyVersion, policy);
  assert.equal(x.signature, sign(x.journal, key));
  assert.equal(x.keyId, hash(key));
  return x;
}
async function tree(root: string) {
  const result: Record<string, unknown> = {};
  async function visit(p: string) {
    for (const name of (await fs.readdir(p)).sort()) {
      const file = path.join(p, name),
        s = await fs.lstat(file, { bigint: true }),
        rel = path.relative(root, file);
      result[rel] = {
        kind: s.isDirectory() ? "directory" : "file",
        dev: String(s.dev),
        ino: String(s.ino),
        mode: String(s.mode),
        nlink: String(s.nlink),
        mtime: String(s.mtimeNs),
        ctime: String(s.ctimeNs),
        ...(s.isFile()
          ? { bytes: (await fs.readFile(file)).toString("base64") }
          : {}),
      };
      if (s.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return result;
}
for (const [version, Old] of [
  [1, V1],
  [2, V123],
] as const)
  for (const interrupted of [false, true])
    test(`historical v${version} ${interrupted ? "interrupted" : "completed"} ${version === 1 ? "session" : "ordinary-file"} writer with synthetic safe IDs restores with original recovery key`, async (t) => {
      const f = await createBatch(t, Old, interrupted, version === 1),
        before = await tree(f.root);
      assert.equal(f.saved.journal.version, version);
      const engine = new AgentVacEngine(f.root, null, false, clear, [f.key]);
      assert.equal((await engine.inspectRecovery()).batches[0].verified, true);
      assert.equal((await engine.history())[0].items[0].status, "quarantined");
      assert.deepEqual(await tree(f.root), before);
      const result = await engine.restore(f.id, true);
      assert.equal(result.completed, 1, JSON.stringify(result));
      const x = await envelope(f.manifest, f.key, version);
      assert.deepEqual(
        x.journal.items[0].before,
        f.saved.journal.items[0].before,
      );
      if (interrupted)
        assert.equal(typeof x.journal.items[0].stored.ino, "string");
      else
        assert.deepEqual(
          x.journal.items[0].stored,
          f.saved.journal.items[0].stored,
        );
      assert.equal(
        await fs.readFile(f.original, "utf8"),
        "synthetic " + f.relative + "\n",
      );
      assert.equal((await fs.lstat(f.original)).nlink, 1);
      await assert.rejects(fs.lstat(f.payload), { code: "ENOENT" });
    });
for (const [version, Old] of [
  [1, V1],
  [2, V123],
] as const)
  test(`native historical v${version} unsupported numeric IDs refuse recovery and Trash without mutation`, async (t) => {
    // Deliberately unmodeled: these bytes come from the historical numeric
    // writer running against this host's actual generated fixture identities.
    const f = await createBatch(t, Old, false, version === 1, false, false);
    const unsupported = f.saved.journal.items.some((item: any) =>
      [item.before, item.stored].some(
        (fp) =>
          fp &&
          (!Number.isSafeInteger(fp.dev) || !Number.isSafeInteger(fp.ino)),
      ),
    );
    if (!unsupported) {
      t.skip(
        "generated native IDs fit safe Numbers; native unsupported-ID rejection not exercised",
      );
      return;
    }
    const before = await tree(f.root),
      engine = new AgentVacEngine(f.root, f.key, false, clear);
    await assert.rejects(engine.restore(f.id, true), {
      code: "ERR_AGENTVAC_FILE_IDENTITY",
    });
    await assert.rejects(
      trashFixture(engine, f.id, true, true, async () =>
        assert.fail("unsupported native legacy IDs must not reach Trash"),
      ),
      { code: "ERR_AGENTVAC_FILE_IDENTITY" },
    );
    assert.equal((await engine.inspectRecovery()).batches[0].verified, false);
    assert.equal((await engine.history())[0].items[0].status, "failed");
    assert.deepEqual(await tree(f.root), before);
    t.diagnostic(
      "identity-control=native-unsupported; recovery=refused; trash=refused; fixture=unchanged",
    );
  });

for (const Old of [V1, V123])
  test(`${Old === V1 ? "v1" : "v123"} reader rejects receipt produced from genuinely interrupted v4 writer batch`, async (t) => {
    const f = await createBatch(t, AgentVacEngine, true),
      engine = new AgentVacEngine(f.root, f.key, false, clear);
    assert.equal(f.saved.journal.items[0].status, "pending");
    const moved = path.join(f.base, "retained-synthetic-trash");
    assert.deepEqual(await fs.readFile(f.manifest), f.bytes);
    assert.equal(
      (
        await trashFixture(engine, f.id, true, true, (dir) =>
          fs.rename(dir, moved),
        )
      ).completed,
      1,
    );
    const receipt = path.join(f.q, f.id + ".receipt.json");
    const x = await envelope(receipt, f.key, 4);
    assert.equal(x.journal.items[0].status, "trashed");
    assert.equal(typeof x.journal.items[0].stored.ino, "string");
    assert.deepEqual(
      await fs.readFile(path.join(moved, "manifest.json")),
      f.bytes,
    );
    const before = await tree(f.base),
      reader = new Old(f.root, f.key, false, clear);
    const history = await reader.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].items[0].status, "failed");
    assert.equal(history[0].items[0].id, "receipt");
    assert.deepEqual(await tree(f.base), before);
  });
for (const fault of [
  "write",
  "file-sync",
  "publication",
  "directory-sync",
] as const)
  test(`synthetic-safe legacy receipt ${fault} fault after callback reports saved/unsaved commit accurately and retains payload`, async (t) => {
    if (fault === "directory-sync" && process.platform === "win32") {
      t.skip(
        "Windows has no directory fsync in the engine; this fault cannot be injected",
      );
      return;
    }
    const f = await createBatch(t, V1, false, true),
      engine = new AgentVacEngine(f.root, f.rotated, false, clear, [f.key]);
    const receipt = path.join(f.q, f.id + ".receipt.json"),
      moved = path.join(f.base, "retained-synthetic-trash");
    const open = fs.open,
      link = fs.link;
    let hit = false,
      committed = false,
      calls = 0;
    const fail = () => {
      hit = true;
      return Object.assign(new Error("synthetic receipt " + fault), {
        code: "EIO",
      });
    };
    const a = t.mock.method(
      fs,
      "open",
      async (...args: Parameters<typeof fs.open>) => {
        const h = await open(...args),
          p = String(args[0]);
        if (p.endsWith(".receipt.tmp")) {
          if (fault === "write")
            h.writeFile = async () => {
              throw fail();
            };
          if (fault === "file-sync")
            h.sync = async () => {
              throw fail();
            };
        }
        if (p === f.q && committed && fault === "directory-sync")
          h.sync = async () => {
            throw fail();
          };
        return h;
      },
    );
    const b = t.mock.method(
      fs,
      "link",
      async (from: PathLike, to: PathLike) => {
        if (String(to) === receipt && fault === "publication") throw fail();
        await link(from, to);
        if (String(to) === receipt) committed = true;
      },
    );
    let result;
    try {
      result = await trashFixture(engine, f.id, true, true, async (dir) => {
        calls++;
        assert.deepEqual(await fs.readFile(f.manifest), f.bytes);
        await fs.rename(dir, moved);
      });
    } finally {
      a.mock.restore();
      b.mock.restore();
    }
    assert.equal(hit, true);
    assert.equal(calls, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /文件已移入系统回收站/);
    assert.deepEqual(
      await fs.readFile(path.join(moved, "manifest.json")),
      f.bytes,
    );
    assert.equal(
      await fs.readFile(path.join(moved, path.basename(f.payload)), "utf8"),
      "synthetic " + f.relative + "\n",
    );
    if (fault === "directory-sync") await envelope(receipt, f.key, 1);
    else await assert.rejects(fs.lstat(receipt), { code: "ENOENT" });
    assert.equal(
      (await fs.readdir(f.q)).some((n) => n.endsWith(".tmp")),
      false,
    );
    await assert.rejects(
      trashFixture(engine, f.id, true, true, async () => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
  });
async function interruptedUnit(t: TestContext, safeIds = false) {
  const f = await createBatch(t, AgentVacEngine, false, false, true, safeIds),
    unlink = fs.unlink;
  let hit = false;
  const mock = t.mock.method(fs, "unlink", async (p: PathLike) => {
    if (!hit && String(p) === path.join(f.payload, "0/data_0")) {
      hit = true;
      throw new Error("synthetic linked unit interruption");
    }
    return unlink(p);
  });
  try {
    assert.equal(
      (
        await new AgentVacEngine(
          f.root,
          f.key,
          false,
          clear,
          [],
          cursorAdapter,
        ).restore(f.id, true)
      ).completed,
      0,
    );
  } finally {
    mock.mock.restore();
  }
  assert.equal(hit, true);
  const data = JSON.parse(await fs.readFile(f.manifest, "utf8"));
  assert.ok(data.journal.items[0].unit.restore.directories.length);
  assert.ok(data.journal.items[0].unit.restore.linked.length);
  return { ...f, data };
}
for (const field of ["directory", "linked"] as const)
  for (const encoding of ["mixed", "unsafe", "zero", "noncanonical"] as const)
    test(`authenticated v4 nested restore ${field} rejects ${encoding} IDs before recovery/Trash/history writes`, async (t) => {
      const f = await interruptedUnit(t),
        j = f.data.journal,
        restore = j.items[0].unit.restore,
        v =
          field === "directory"
            ? restore.directories[0]
            : restore.linked[0].fingerprint;
      if (encoding === "mixed") v.dev = Number(v.dev);
      if (encoding === "unsafe") {
        v.dev = Number(v.dev);
        v.ino = 2 ** 53;
      }
      if (encoding === "zero") v.ino = "0";
      if (encoding === "noncanonical") v.ino = "0" + v.ino;
      await fs.writeFile(
        f.manifest,
        JSON.stringify({
          journal: j,
          signature: sign(j, f.key),
          keyId: hash(f.key),
        }),
      );
      const before = await tree(f.root),
        e = new AgentVacEngine(f.root, f.key, false, clear, [], cursorAdapter);
      await assert.rejects(e.restore(f.id, true));
      await assert.rejects(
        trashFixture(e, f.id, true, true, async () =>
          assert.fail("invalid unit must not reach Trash"),
        ),
      );
      assert.equal((await e.inspectRecovery()).batches[0].verified, false);
      assert.equal((await e.history())[0].items[0].status, "failed");
      assert.deepEqual(await tree(f.root), before);
    });
for (const fault of ["before-rename", "after-rename-sync"] as const)
  test(`synthetic-safe signed v3 unit linked pair survives migration ${fault}, then fresh engine resumes without overwrite`, async (t) => {
    if (fault === "after-rename-sync" && process.platform === "win32") {
      t.skip(
        "Windows has no directory fsync in the engine; this fault cannot be injected",
      );
      return;
    }
    const f = await interruptedUnit(t, true),
      j = f.data.journal;
    j.version = 3;
    delete j.recoveryPolicyVersion;
    const numeric = (x: any): void => {
      if (!x || typeof x !== "object") return;
      if (Object.hasOwn(x, "dev") && Object.hasOwn(x, "ino")) {
        for (const k of ["dev", "ino"]) {
          x[k] = Number(x[k]);
          assert.equal(Number.isSafeInteger(x[k]), true);
        }
      }
      for (const c of Object.values(x)) numeric(c);
    };
    numeric(j);
    await fs.writeFile(
      f.manifest,
      JSON.stringify({
        journal: j,
        signature: sign(j, f.key),
        keyId: hash(f.key),
      }),
    );
    const bytes = await fs.readFile(f.manifest),
      state = structuredClone(j.items[0].unit.restore);
    const rename = fs.rename,
      open = fs.open;
    let committed = false,
      hit = false;
    const fail = () => {
      hit = true;
      return Object.assign(new Error("synthetic unit migration"), {
        code: "EIO",
      });
    };
    const a = t.mock.method(
      fs,
      "rename",
      async (from: PathLike, to: PathLike) => {
        if (String(to) === f.manifest && fault === "before-rename")
          throw fail();
        await rename(from, to);
        if (String(to) === f.manifest) committed = true;
      },
    );
    const b = t.mock.method(
      fs,
      "open",
      async (...args: Parameters<typeof fs.open>) => {
        const h = await open(...args);
        if (
          String(args[0]) === f.dir &&
          committed &&
          fault === "after-rename-sync"
        )
          h.sync = async () => {
            throw fail();
          };
        return h;
      },
    );
    try {
      await assert.rejects(
        new AgentVacEngine(
          f.root,
          f.rotated,
          false,
          clear,
          [f.key],
          cursorAdapter,
        ).restore(f.id, true),
        /synthetic unit migration/,
      );
    } finally {
      a.mock.restore();
      b.mock.restore();
    }
    assert.equal(hit, true);
    if (fault === "before-rename")
      assert.deepEqual(await fs.readFile(f.manifest), bytes);
    else
      assert.deepEqual(
        (await envelope(f.manifest, f.key, 3)).journal.items[0].unit.restore,
        state,
      );
    const stored = path.join(f.payload, "0/data_0"),
      target = path.join(f.original, "data_0");
    const aStat = await fs.lstat(stored, { bigint: true }),
      bStat = await fs.lstat(target, { bigint: true });
    assert.equal(aStat.ino, bStat.ino);
    assert.equal(aStat.nlink, 2n);
    const result = await new AgentVacEngine(
      f.root,
      null,
      false,
      clear,
      [f.key],
      cursorAdapter,
    ).restore(f.id, true);
    assert.equal(result.completed, 1, JSON.stringify(result));
    await envelope(f.manifest, f.key, 3);
    for (const relative of f.files) {
      const p = path.join(f.root, relative);
      assert.equal(
        await fs.readFile(p, "utf8"),
        "synthetic " + relative + "\n",
      );
      assert.equal((await fs.lstat(p)).nlink, 1);
    }
  });

for (const Old of [V1, V123])
  for (const interrupted of [false, true])
    for (const unit of [false, true])
      test(`actual old reader ${Old === V1 ? "v1" : "published v1-v3"} preserves ${interrupted ? "interrupted" : "completed"} new v4 ${unit ? "unit" : "file"} batch before reconciliation`, async (t) => {
        const f =
          unit && interrupted
            ? await interruptedUnit(t)
            : await createBatch(t, AgentVacEngine, interrupted, false, unit);
        const before = await tree(f.root);
        assert.equal(f.saved.journal.version, 4);
        const reader = new Old(
          f.root,
          f.key,
          false,
          clear,
          [],
          unit ? cursorAdapter : codexAdapter,
        );
        assert.equal((await reader.history())[0].items[0].status, "failed");
        await assert.rejects(reader.restore(f.id, true));
        let called = false;
        await assert.rejects(
          reader.trash(f.id, true, async () => {
            called = true;
          }),
        );
        assert.equal(called, false);
        assert.deepEqual(await tree(f.root), before);
      });

for (const policy of [0, 5, "1", null, [], {}, true])
  test(`authenticated v4 rejects invalid recovery policy ${JSON.stringify(policy)} without changing payloads`, async (t) => {
    const f = await createBatch(t),
      j = f.saved.journal;
    j.recoveryPolicyVersion = policy;
    await fs.writeFile(
      f.manifest,
      JSON.stringify({
        journal: j,
        signature: sign(j, f.key),
        keyId: hash(f.key),
      }),
    );
    const before = await tree(f.root),
      e = new AgentVacEngine(f.root, f.key, false, clear);
    await assert.rejects(e.restore(f.id, true));
    let called = false;
    await assert.rejects(
      trashFixture(e, f.id, true, true, async () => {
        called = true;
      }),
    );
    assert.equal(called, false);
    assert.deepEqual(await tree(f.root), before);
  });

for (const attack of ["clone", "policy", "version", "wrong-key"] as const)
  test(`v4 publication rejects object origin substitution: ${attack}`, async (t) => {
    const f = await createBatch(t),
      e = new AgentVacEngine(f.root, f.rotated, false, clear, [f.key]);
    let j = await (e as any).readJournal(f.id, false, false);
    if (attack === "clone") j = structuredClone(j);
    if (attack === "policy") j.recoveryPolicyVersion = 2;
    if (attack === "version") {
      j.version = 2;
      delete j.recoveryPolicyVersion;
    }
    const before = await tree(f.root);
    await assert.rejects(
      (e as any).writeJournal(
        j,
        attack === "wrong-key" ? f.rotated : undefined,
      ),
      /绑定/,
    );
    assert.deepEqual(await tree(f.root), before);
  });

for (const version of [1, 2, 3])
  test(`legacy storage v${version} cannot smuggle an origin-policy field`, async (t) => {
    const f = await createBatch(t),
      j = f.saved.journal;
    j.version = version;
    if (version === 1) delete j.provider;
    await fs.writeFile(
      f.manifest,
      JSON.stringify({
        journal: j,
        signature: sign(j, f.key),
        keyId: hash(f.key),
      }),
    );
    const before = await tree(f.root);
    await assert.rejects(
      new AgentVacEngine(f.root, f.key, false, clear).restore(f.id, true),
    );
    assert.deepEqual(await tree(f.root), before);
  });
