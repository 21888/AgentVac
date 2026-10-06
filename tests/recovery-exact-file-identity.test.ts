import { trashFixture } from "./helpers/trash.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  promises as fs,
  type PathLike,
  type Stats,
  type BigIntStats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHmac } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import {
  assertFileFingerprint,
  exactFileId,
  fileFingerprint,
  sameFileId,
  sameFileIdentity,
  sameFileFingerprint,
  statMilliseconds,
} from "../electron/file-identity.js";

const A = 9007199254740992n,
  B = A + 1n,
  MAX = (1n << 64n) - 1n;
const relative = "log/codex-tui.log.1";
const payload = "generated ordinary identity fixture";
const clear = async () => ({
  status: "clear" as const,
  details: "Synthetic closed process",
});

/** Pure numeric precision model. The host's native IDs are only used to keep
 * generated aliases stable through rename/link. This is NOT an NTFS collision.
 * Both lstat and fstat honor bigint options, as Node does.
 */
async function fixture(t: TestContext, large = true) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-exact-ordinary-"),
  );
  const root = path.join(base, "root"),
    source = path.join(root, relative);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, payload);
  const old = new Date(Date.now() - 90 * 86_400_000);
  await fs.utimes(source, old, old);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const lstat = fs.lstat,
    open = fs.open;
  const ids = new Map<string, bigint>(),
    overrides = new Map<string, { ino?: bigint; dev?: bigint }>();
  const observed = new Map<string, { ino: bigint; dev: bigint }>();
  let next = large ? A : 100n;
  const patch = (
    s: Stats | BigIntStats,
    p: string,
    bigint: boolean,
    kind = "path",
  ) => {
    if (p !== root && !p.startsWith(root + path.sep)) return s;
    const key = `${s.dev}:${s.ino}`;
    if (!ids.has(key)) {
      ids.set(key, next);
      next += 4n;
    }
    const change = overrides.get(kind + ":" + p) ?? overrides.get(p);
    const ino = change?.ino ?? ids.get(key)!,
      dev = change?.dev ?? (large ? A + 100n : 1n);
    observed.set(p, { ino, dev });
    Object.assign(s, {
      ino: bigint ? ino : Number(ino),
      dev: bigint ? dev : Number(dev),
    });
    return s;
  };
  t.mock.method(fs, "lstat", async (p: PathLike, options?: any) =>
    patch(await (lstat as any)(p, options), String(p), !!options?.bigint),
  );
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const h = await open(...args),
      stat = h.stat.bind(h);
    h.stat = (async (options?: any) =>
      patch(
        await stat(options),
        String(args[0]),
        !!options?.bigint,
        "handle",
      )) as typeof h.stat;
    return h;
  });
  const key = randomBytes(32);
  const engine = () => new AgentVacEngine(root, key, true, clear);
  const select = async (e: AgentVacEngine) => {
    const scan = await e.scan({ minAgeDays: 30, includeSessions: false });
    const entry = scan.entries.find((v) => v.path === relative)!;
    assert.equal(entry?.selectable, true, JSON.stringify(scan));
    return entry;
  };
  const quarantine = async () => {
    const e = engine(),
      entry = await select(e);
    const result = await e.quarantine(
      (await e.preview([entry.id])).token,
      true,
    );
    assert.equal(result.completed, 1, JSON.stringify(result));
    const dir = path.join(root, ".agentvac-quarantine", result.batchId);
    const manifest = path.join(dir, "manifest.json");
    const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
    return {
      e,
      result,
      dir,
      manifest,
      saved,
      data: path.join(dir, saved.journal.items[0].id + ".data"),
    };
  };
  const sign = async (q: Awaited<ReturnType<typeof quarantine>>) => {
    q.saved.signature = createHmac("sha256", key)
      .update(JSON.stringify(q.saved.journal))
      .digest("hex");
    await fs.writeFile(q.manifest, JSON.stringify(q.saved, null, 2));
  };
  return {
    root,
    base,
    source,
    key,
    engine,
    select,
    quarantine,
    sign,
    observed,
    overrides,
  };
}

function fingerprint(dev: string | number, ino: string | number): any {
  return {
    dev,
    ino,
    size: 42,
    mtimeMs: 1234.123456,
    ctimeMs: 5678.987654,
    nlink: 1,
    mode: 0o100600,
  };
}

test("decimal ID schema is bounded and refuses rounded numbers, missing/zero inodes and mixed encodings", () => {
  assert.equal(Number(A), Number(B));
  for (const id of [1n, A, B, MAX])
    assert.equal(exactFileId(id, true), id.toString());
  for (const value of [
    0,
    "0",
    0n,
    -1,
    -1n,
    "-1",
    "01",
    "1e3",
    "+1",
    " 1",
    "1.0",
    "1\n",
    "1\r\n",
    "1\u2028",
    "1\u2029",
    "1\u00a0",
    "\u00a01",
    "1\t",
    "",
    Number(A),
    NaN,
    Infinity,
    MAX + 1n,
    (MAX + 1n).toString(),
    "1".repeat(100),
  ])
    assert.throws(() => exactFileId(value, true), /身份/);
  assert.equal(exactFileId(0), "0");
  assert.throws(() => exactFileId(-0), /身份/);
  assert.throws(() => assertFileFingerprint(fingerprint(-0, 1)), /身份/);
  assert.equal(sameFileId(123, "123"), true);
  assert.equal(sameFileId(A.toString(), B.toString()), false);
  assert.equal(sameFileId(Number(A), A.toString()), false);
  assert.equal(
    sameFileIdentity(fingerprint("0", "1"), fingerprint(0, 1)),
    true,
  );
  for (const f of [
    fingerprint("1", "0"),
    fingerprint("1", 2),
    fingerprint(1, "2"),
    fingerprint(1, Number(A)),
    { ...fingerprint(1, 2), extra: 1 },
    { ...fingerprint(1, 2), nlink: 0 },
    { ...fingerprint(1, 2), mode: -1 },
    { ...fingerprint(1, 2), size: Number(A) },
    { ...fingerprint(1, 2), ctimeMs: Infinity },
  ])
    assert.throws(() => assertFileFingerprint(f), /身份/);
  assertFileFingerprint(fingerprint(1, 2));
  assertFileFingerprint(fingerprint("1", MAX.toString()));
  const a = fingerprint(1, 2),
    b = fingerprint("1", "2");
  assert.equal(sameFileFingerprint(a, b), true);
  for (const k of ["size", "mtimeMs", "ctimeMs", "nlink", "mode"])
    assert.equal(sameFileFingerprint(a, { ...b, [k]: b[k] + 1 }), false, k);
});

test("single bigint sample preserves real numeric Stats timestamp bytes and synthetic negative-epoch edges", async (t) => {
  const f = await fixture(t, false);
  const numeric = await fs.lstat(f.source),
    exact = await fs.lstat(f.source, { bigint: true });
  assert.equal(
    JSON.stringify(fileFingerprint(numeric)),
    JSON.stringify(fileFingerprint(exact)),
  );
  for (const [sec, ns] of [
    [0n, 1n],
    [1n, 999999999n],
    [1750000000n, 123456789n],
    [-1n, 999999999n],
    [-1n, 1n],
    [-1750000000n, 123456789n],
  ] as const)
    assert.equal(
      statMilliseconds(sec * 1_000_000_000n + ns),
      Number(sec) * 1000 + Number(ns) / 1_000_000,
    );
  const s = Object.assign(Object.create(numeric), { ino: Number(A) });
  assert.throws(() => fileFingerprint(s), /身份/);
});

for (const field of ["ino", "dev"] as const)
  test(`adjacent large ${field} rejects actual generated root replacement`, async (t) => {
    const f = await fixture(t),
      e = f.engine();
    await e.initialize();
    const before = f.observed.get(f.root)!;
    await fs.rename(f.root, path.join(f.base, "original-root"));
    await fs.mkdir(path.join(f.root, "log"), { recursive: true });
    f.overrides.set(f.root, { ...before, [field]: before[field] + 1n });
    assert.equal(Number(before[field]), Number(before[field] + 1n));
    await assert.rejects(
      e.scan({ minAgeDays: 30, includeSessions: false }),
      /根目录已被替换/,
    );
    assert.equal(
      await fs.readFile(path.join(f.base, "original-root", relative), "utf8"),
      payload,
    );
  });

for (const stage of ["preview", "handle", "path", "post-move"] as const)
  test(`adjacent large ordinary file ID is checked at ${stage}`, async (t) => {
    const f = await fixture(t),
      e = f.engine(),
      entry = await f.select(e);
    const id = f.observed.get(f.source)!;
    if (stage === "preview") {
      f.overrides.set(f.source, { ...id, ino: id.ino + 1n });
      await assert.rejects(e.preview([entry.id]), /发生变化/);
    } else {
      const p = await e.preview([entry.id]);
      if (stage === "handle")
        f.overrides.set("handle:" + f.source, { ...id, ino: id.ino + 1n });
      if (stage === "path") {
        const open = fs.open;
        t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
          const h = await open(...args);
          if (String(args[0]) === f.source)
            f.overrides.set("path:" + f.source, { ...id, ino: id.ino + 1n });
          return h;
        });
      }
      if (stage === "post-move") {
        const rename = fs.rename;
        t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
          await rename(from, to);
          if (String(from) === f.source)
            f.overrides.set(String(to), { ...id, ino: id.ino + 1n });
        });
      }
      const result = await e.quarantine(p.token, true);
      assert.equal(result.completed, 0);
      assert.equal(result.failed.length, 1);
      assert.match(
        result.failed[0].error,
        stage === "post-move" ? /移动后文件标识/ : /源文件已变化/,
      );
      if (stage === "post-move") {
        const dir = path.join(f.root, ".agentvac-quarantine", result.batchId);
        const saved = JSON.parse(
          await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
        );
        assert.equal(
          await fs.readFile(
            path.join(dir, saved.journal.items[0].id + ".data"),
            "utf8",
          ),
          payload,
        );
        const history = await f.engine().history();
        assert.equal(history[0].items[0].status, "failed");
        return;
      }
    }
    assert.equal(await fs.readFile(f.source, "utf8"), payload);
  });

test("new signed v4 large identities survive restart, exact timestamps, hardlink interruption and resume", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine();
  assert.equal(q.saved.journal.version, 4);
  assert.equal(q.saved.journal.recoveryPolicyVersion, 4);
  const item = q.saved.journal.items[0];
  assert.equal(typeof item.before.dev, "string");
  assert.equal(typeof item.stored.ino, "string");
  assert.ok(BigInt(item.stored.ino) > BigInt(Number.MAX_SAFE_INTEGER));
  const originalBytes = await fs.readFile(q.manifest);
  const fresh = f.engine();
  assert.equal((await fresh.history())[0].items[0].status, "quarantined");
  assert.deepEqual(
    await fs.readFile(q.manifest),
    originalBytes,
    "read-only history must not normalize signed bytes",
  );
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (p: PathLike) => {
    if (String(p) === q.data)
      throw new Error("synthetic interruption after linking");
    return unlink(p);
  });
  assert.equal((await fresh.restore(q.result.batchId, true)).completed, 0);
  assert.equal(
    (await fs.lstat(q.data, { bigint: true })).ino,
    (await fs.lstat(f.source, { bigint: true })).ino,
  );
  fs.unlink = unlink;
  const resumed = await f.engine().restore(q.result.batchId, true);
  assert.equal(resumed.completed, 1, JSON.stringify(resumed));
  assert.equal(await fs.readFile(f.source, "utf8"), payload);
  assert.equal((await fs.lstat(f.source)).nlink, 1);
});

for (const version of [1, 2] as const)
  test(`authenticated safe-number v${version} history and restore preserve original signed representations`, async (t) => {
    const f = await fixture(t, false),
      q = await f.quarantine();
    q.saved.journal.version = version;
    delete q.saved.journal.recoveryPolicyVersion;
    if (version === 1) delete q.saved.journal.provider;
    for (const value of [
      q.saved.journal.items[0].before,
      q.saved.journal.items[0].stored,
    ]) {
      value.dev = Number(value.dev);
      value.ino = Number(value.ino);
    }
    await f.sign(q);
    const bytes = await fs.readFile(q.manifest);
    const fresh = new AgentVacEngine(f.root, randomBytes(32), true, clear, [
      f.key,
    ]);
    assert.equal((await fresh.inspectRecovery()).batches[0].verified, true);
    assert.equal((await fresh.history())[0].items[0].status, "quarantined");
    assert.deepEqual(await fs.readFile(q.manifest), bytes);
    assert.equal((await fresh.restore(q.result.batchId, true)).completed, 1);
    const saved = JSON.parse(await fs.readFile(q.manifest, "utf8"));
    assert.equal(typeof saved.journal.items[0].before.ino, "number");
    assert.equal(typeof saved.journal.items[0].stored.ino, "number");
    assert.equal(
      saved.signature,
      createHmac("sha256", f.key)
        .update(JSON.stringify(saved.journal))
        .digest("hex"),
    );
  });

for (const version of [1, 2] as const)
  for (const location of ["before", "stored"] as const)
    test(`unsafe legacy v${version} ${location} refuses recovery and Trash without touching payload or journal`, async (t) => {
      const f = await fixture(t),
        q = await f.quarantine();
      q.saved.journal.version = version;
      delete q.saved.journal.recoveryPolicyVersion;
      if (version === 1) delete q.saved.journal.provider;
      q.saved.journal.items[0][location].dev = Number(A);
      q.saved.journal.items[0][location].ino = Number(B);
      await f.sign(q);
      const bytes = await fs.readFile(q.manifest),
        data = await fs.readFile(q.data);
      const fresh = f.engine();
      await assert.rejects(fresh.restore(q.result.batchId, true), {
        code: "ERR_AGENTVAC_FILE_IDENTITY",
      });
      await assert.rejects(
        trashFixture(fresh, q.result.batchId, true, true, async () => {
          assert.fail("unsafe archive must not reach Trash");
        }),
        /精确范围/,
      );
      const inspection = await fresh.inspectRecovery();
      assert.equal(inspection.batches[0].verified, false);
      assert.equal(inspection.batches[0].storedFiles, 1);
      assert.match(inspection.batches[0].explanation, /复制导出/);
      assert.match((await fresh.history())[0].items[0].error!, /精确范围/);
      assert.equal(await fresh.getBatchQuarantinePath(q.result.batchId), q.dir);
      assert.deepEqual(await fs.readFile(q.manifest), bytes);
      assert.deepEqual(await fs.readFile(q.data), data);
    });

test("journal forgery remains unauthenticated even with valid exact IDs", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine();
  q.saved.journal.items[0].stored.ino = B.toString();
  await fs.writeFile(q.manifest, JSON.stringify(q.saved));
  await assert.rejects(f.engine().restore(q.result.batchId, true), /校验失败/);
  const inspection = await f.engine().inspectRecovery();
  assert.match(inspection.batches[0].explanation, /无法认证/);
  assert.equal(await fs.readFile(q.data, "utf8"), payload);
});

test("signed malformed exact journal IDs fail before reconciliation and preserve all bytes", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine(),
    original = structuredClone(q.saved);
  for (const invalid of [
    "0",
    "01",
    "-1",
    "1\n",
    "1\r\n",
    "1\u2028",
    "1\u2029",
    "1\u00a0",
    (MAX + 1n).toString(),
    "9".repeat(100),
    null,
    1.5,
  ]) {
    q.saved = structuredClone(original);
    q.saved.journal.items[0].before.ino = invalid;
    q.saved.journal.items[0].status = "pending";
    await f.sign(q);
    const bytes = await fs.readFile(q.manifest);
    await assert.rejects(f.engine().restore(q.result.batchId, true), /身份/);
    assert.deepEqual(await fs.readFile(q.manifest), bytes);
    assert.equal(await fs.readFile(q.data, "utf8"), payload);
  }
});

for (const mismatch of [false, true])
  test(`pending and completed-restore reconciliation compares exact IDs (${mismatch ? "adjacent mismatch" : "match"})`, async (t) => {
    const f = await fixture(t),
      q = await f.quarantine();
    const item = q.saved.journal.items[0];
    item.status = "pending";
    delete item.stored;
    await f.sign(q);
    if (mismatch)
      f.overrides.set(q.data, { ino: BigInt(item.before.ino) + 1n });
    assert.equal(
      (await f.engine().history())[0].items[0].status,
      mismatch ? "failed" : "quarantined",
    );
    assert.equal(await fs.readFile(q.data, "utf8"), payload);
    f.overrides.delete(q.data);
    item.status = "quarantined";
    item.stored = fileFingerprint(await fs.lstat(q.data, { bigint: true }));
    await fs.rename(q.data, f.source);
    await f.sign(q);
    if (mismatch)
      f.overrides.set(f.source, { ino: BigInt(item.stored.ino) + 1n });
    assert.equal(
      (await f.engine().history())[0].items[0].status,
      mismatch ? "quarantined" : "restored",
    );
    assert.equal(await fs.readFile(f.source, "utf8"), payload);
  });

for (const action of ["restore", "trash"] as const)
  test(`${action} refuses adjacent replacement payload ID, even when numeric Stats aliases`, async (t) => {
    const f = await fixture(t),
      q = await f.quarantine();
    const item = q.saved.journal.items[0];
    f.overrides.set(q.data, { ino: BigInt(item.stored.ino) + 1n });
    if (action === "restore")
      assert.equal(
        (await f.engine().restore(q.result.batchId, true)).completed,
        0,
      );
    else {
      let called = false;
      await assert.rejects(
        trashFixture(f.engine(), q.result.batchId, true, true, async () => {
          called = true;
        }),
        /隔离文件已变化/,
      );
      assert.equal(called, false);
    }
    assert.equal(await fs.readFile(q.data, "utf8"), payload);
  });

test("same-parent hardlink aliases remain protected; unsigned links never become owned restore links", async (t) => {
  const f = await fixture(t),
    sibling = path.join(path.dirname(f.source), "codex-tui.log.2");
  await fs.link(f.source, sibling);
  const scan = await f
    .engine()
    .scan({ minAgeDays: 30, includeSessions: false });
  assert.equal(scan.entries.filter((e) => e.selectable).length, 0);
  await fs.unlink(sibling);
  const q = await f.quarantine();
  await fs.link(q.data, f.source);
  assert.equal((await f.engine().restore(q.result.batchId, true)).completed, 0);
  assert.equal((await fs.lstat(q.data)).nlink, 2);
  assert.equal(await fs.readFile(f.source, "utf8"), payload);
});

test("signed interrupted-link resume refuses adjacent alias at either link and preserves both", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine();
  q.saved.journal.items[0].restorePending = true;
  await f.sign(q);
  await fs.link(q.data, f.source);
  for (const target of [f.source, q.data]) {
    f.overrides.set(target, {
      ino: BigInt(q.saved.journal.items[0].stored.ino) + 1n,
    });
    const result = await f.engine().restore(q.result.batchId, true);
    assert.equal(result.completed, 0);
    assert.equal(await fs.readFile(q.data, "utf8"), payload);
    assert.equal(await fs.readFile(f.source, "utf8"), payload);
    f.overrides.delete(target);
  }
});

test("new exact v4 Trash receipt preserves original signing key after key rotation", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine();
  const e = new AgentVacEngine(f.root, randomBytes(32), true, clear, [f.key]);
  let called = false;
  await assert.rejects(
    trashFixture(e, q.result.batchId, false, true, async () => {
      called = true;
    }),
    /确认/,
  );
  assert.equal(called, false);
  const moved = await trashFixture(
    e,
    q.result.batchId,
    true,
    true,
    async (dir) => {
      called = true;
      await fs.rename(dir, path.join(f.base, "simulated-trash"));
    },
  );
  assert.equal(called, true);
  assert.equal(moved.completed, 1);
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(
        f.root,
        ".agentvac-quarantine",
        q.result.batchId + ".receipt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(receipt.journal.version, 4);
  assert.equal(receipt.journal.recoveryPolicyVersion, 4);
  assert.equal(
    receipt.signature,
    createHmac("sha256", f.key)
      .update(JSON.stringify(receipt.journal))
      .digest("hex"),
  );
  assert.equal(typeof receipt.journal.items[0].stored.ino, "string");
  assert.equal((await f.engine().history())[0].items[0].status, "trashed");
  assert.equal(
    await fs.readFile(
      path.join(f.base, "simulated-trash", path.basename(q.data)),
      "utf8",
    ),
    payload,
  );
});

test("read-only rescue inventory detects adjacent large device boundaries in generated unit folders", async (t) => {
  const f = await fixture(t),
    q = await f.quarantine();
  const unit = path.join(q.dir, q.saved.journal.items[0].id + ".unit");
  await fs.mkdir(unit);
  const child = path.join(unit, "generated.bin");
  await fs.writeFile(child, "must not count across a device boundary");
  await fs.lstat(unit, { bigint: true });
  const dev = f.observed.get(unit)!.dev;
  assert.equal(Number(dev), Number(dev + 1n));
  f.overrides.set(child, { dev: dev + 1n });
  const result = await f.engine().inspectRecovery();
  assert.equal(result.batches[0].storedFiles, 1);
  assert.equal(result.batches[0].storedBytes, Buffer.byteLength(payload));
  assert.equal(result.batches[0].irregularEntries, 1);
  assert.equal(
    await fs.readFile(child, "utf8"),
    "must not count across a device boundary",
  );
});

for (const invalid of [0n, -1n, MAX + 1n])
  test(`live unsupported root/file inode ${invalid} fails closed without writes`, async (t) => {
    const f = await fixture(t);
    f.overrides.set(f.root, { ino: invalid });
    await assert.rejects(f.engine().initialize(), /身份/);
    f.overrides.delete(f.root);
    f.overrides.set(f.source, { ino: invalid });
    const scan = await f
      .engine()
      .scan({ minAgeDays: 30, includeSessions: false });
    assert.equal(
      scan.entries.some((e) => e.selectable),
      false,
    );
    assert.equal(scan.status, "partial");
    assert.equal(await fs.readFile(f.source, "utf8"), payload);
    await assert.rejects(
      fs.lstat(path.join(f.root, ".agentvac-quarantine")),
      /ENOENT/,
    );
  });

test("safe legacy pending reconciliation creates only a new exact stored sample, retaining numeric before bytes", async (t) => {
  const f = await fixture(t, false),
    q = await f.quarantine();
  q.saved.journal.version = 2;
  delete q.saved.journal.recoveryPolicyVersion;
  const item = q.saved.journal.items[0];
  item.before.dev = Number(item.before.dev);
  item.before.ino = Number(item.before.ino);
  item.status = "pending";
  delete item.stored;
  const originalBefore = JSON.stringify(item.before);
  await f.sign(q);
  assert.equal((await f.engine().restore(q.result.batchId, true)).completed, 1);
  const saved = JSON.parse(await fs.readFile(q.manifest, "utf8"));
  assert.equal(JSON.stringify(saved.journal.items[0].before), originalBefore);
  assert.equal(typeof saved.journal.items[0].stored.ino, "string");
  assert.equal(await fs.readFile(f.source, "utf8"), payload);
});
