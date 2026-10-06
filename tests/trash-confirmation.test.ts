import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import {
  handlePrepareTrash,
  handleCancelTrash,
  handleTrash,
} from "../electron/trash-ipc.js";
import type { ProcessStatus } from "../shared/types.js";
// All files generated; injected sibling-directory moves, never OS Trash.
async function fixture(t: TestContext, demo = false) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-trash-consent-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root"),
    key = randomBytes(32);
  await fs.mkdir(path.join(root, "log"), { recursive: true });
  const file = path.join(root, "log/codex-tui.log.1");
  await fs.writeFile(file, "generated closure fixture");
  const old = new Date(Date.now() - 90 * 86400000);
  await fs.utimes(file, old, old);
  let processCalls = 0;
  let check: () => Promise<ProcessStatus> = async () => ({
    status: "clear",
    details: "synthetic",
  });
  const engine = new AgentVacEngine(root, key, demo, async () => {
    processCalls++;
    return check();
  });
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const q = await engine.quarantine(preview.token, true);
  assert.equal(q.completed, 1);
  let moves = 0;
  const bin = path.join(base, "generated-bin");
  const move = async (directory: string) => {
    moves++;
    await fs.rename(directory, bin);
  };
  return {
    base,
    root,
    key,
    engine,
    id: q.batchId,
    batch: path.join(root, ".agentvac-quarantine", q.batchId),
    bin,
    move,
    calls: () => ({ processCalls, moves }),
    setCheck: (value: typeof check) => {
      check = value;
    },
  };
}
for (const demo of [false, true])
  test(`Trash closure is exact true, never truthy, in ${demo ? "demo" : "real"} fixture mode`, async (t) => {
    const f = await fixture(t, demo);
    for (const closed of [
      undefined,
      null,
      false,
      0,
      1,
      "true",
      [],
      {},
      new Boolean(true),
    ]) {
      const c = await f.engine.prepareTrash(f.id),
        before = f.calls();
      await assert.rejects(
        f.engine.trash(f.id, true, closed as boolean, c.token, f.move),
        /退出全部/,
      );
      assert.deepEqual(f.calls(), before);
      await assert.rejects(
        f.engine.trash(f.id, true, true, c.token, f.move),
        /确认已失效/,
      );
    }
    const c = await f.engine.prepareTrash(f.id);
    await assert.rejects(
      (f.engine.trash as Function)(f.id, true, f.move),
      /退出全部/,
    );
    await assert.rejects(
      f.engine.trash(f.id, true, true, c.token, f.move),
      /确认已失效/,
    );
    assert.equal(f.calls().moves, 0);
    assert.ok((await fs.stat(f.batch)).isDirectory());
  });
test("Trash impact consent and exact fresh token remain independent gates", async (t) => {
  const f = await fixture(t);
  for (const value of [false, undefined, "true", 1, {}]) {
    const c = await f.engine.prepareTrash(f.id);
    await assert.rejects(
      f.engine.trash(f.id, value as boolean, true, c.token, f.move),
      /明确确认/,
    );
    await assert.rejects(
      f.engine.trash(f.id, true, true, c.token, f.move),
      /确认已失效/,
    );
  }
  for (const token of [undefined, null, true, randomUUID()]) {
    await f.engine.prepareTrash(f.id);
    await assert.rejects(
      f.engine.trash(f.id, true, true, token as string, f.move),
      /确认已失效/,
    );
  }
  assert.equal(f.calls().moves, 0);
});
test("Trash token is single-batch, replacement-confirmation, engine and cancellation bound", async (t) => {
  const f = await fixture(t);
  let c = await f.engine.prepareTrash(f.id);
  await assert.rejects(
    f.engine.trash(randomUUID(), true, true, c.token, f.move),
    /确认已失效/,
  );
  c = await f.engine.prepareTrash(f.id);
  await f.engine.prepareTrash(f.id);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  c = await f.engine.prepareTrash(f.id);
  f.engine.cancelTrashConfirmation(c.token);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  c = await f.engine.prepareTrash(f.id);
  const next = new AgentVacEngine(f.root, f.key, true);
  await assert.rejects(
    next.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  f.engine.invalidate();
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /提供方或目录已切换/,
  );
  assert.equal(f.calls().moves, 0);
});
test("Trash token expires by a main-process monotonic deadline", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id),
    now = performance.now();
  t.mock.method(performance, "now", () => now + 6 * 60_000);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  assert.equal(f.calls().moves, 0);
});
test("intervening request, cancellation or changed authenticated journal invalidates consent", async (t) => {
  const f = await fixture(t);
  let c = await f.engine.prepareTrash(f.id);
  await f.engine.history();
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  c = await f.engine.prepareTrash(f.id);
  f.engine.cancelScan();
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  c = await f.engine.prepareTrash(f.id);
  const manifest = path.join(f.batch, "manifest.json"),
    data = JSON.parse(await fs.readFile(manifest, "utf8"));
  data.journal.createdAt = new Date(0).toISOString();
  data.signature = createHmac("sha256", f.key)
    .update(JSON.stringify(data.journal))
    .digest("hex");
  await fs.writeFile(manifest, JSON.stringify(data));
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  assert.equal(f.calls().moves, 0);
});
test("root replacement after confirmation is refused before Trash", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  await fs.rename(f.root, f.root + "-saved");
  await fs.mkdir(f.root);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /根目录已被替换/,
  );
  assert.equal(f.calls().moves, 0);
});
test("running and unknown guards consume consent and require fresh retry", async (t) => {
  const f = await fixture(t);
  for (const status of ["running", "unknown"] as const) {
    const c = await f.engine.prepareTrash(f.id);
    f.setCheck(async () => ({ status, details: "synthetic guard refusal" }));
    await assert.rejects(
      f.engine.trash(f.id, true, true, c.token, f.move),
      /进程状态|正在运行/,
    );
    f.setCheck(async () => ({ status: "clear", details: "synthetic" }));
    await assert.rejects(
      f.engine.trash(f.id, true, true, c.token, f.move),
      /确认已失效/,
    );
  }
  const c = await f.engine.prepareTrash(f.id);
  assert.equal(
    (await f.engine.trash(f.id, true, true, c.token, f.move)).completed,
    1,
  );
  assert.equal(f.calls().moves, 1);
  assert.equal((await f.engine.history())[0].items[0].status, "trashed");
});
test("busy duplicate calls cannot reuse consent or invoke the callback twice", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  f.setCheck(async () => {
    entered();
    await gate;
    return { status: "clear", details: "synthetic" };
  });
  const first = f.engine.trash(f.id, true, true, c.token, f.move);
  await waiting;
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /另一项操作/,
  );
  await assert.rejects(f.engine.prepareTrash(f.id), /另一项操作/);
  release();
  assert.equal((await first).completed, 1);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  assert.equal(f.calls().moves, 1);
});
test("active cancellation while conservative process check waits blocks callback without a scope backend", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  f.setCheck(async () => {
    entered();
    await gate;
    return { status: "clear", details: "synthetic" };
  });
  const pending = f.engine.trash(f.id, true, true, c.token, f.move);
  await waiting;
  f.engine.cancelTrashConfirmation(c.token);
  release();
  await assert.rejects(pending, /操作已取消/);
  assert.equal(f.calls().moves, 0);
  assert.ok((await fs.stat(f.batch)).isDirectory());
});
test("callback failure cannot preserve consent for a later retry", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, async () => {
      throw new Error("synthetic unavailable");
    }),
    /synthetic unavailable/,
  );
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  const next = await f.engine.prepareTrash(f.id);
  assert.equal(
    (await f.engine.trash(f.id, true, true, next.token, f.move)).completed,
    1,
  );
  const name = (await fs.readdir(f.bin)).find((x) => x.endsWith(".data"))!;
  assert.equal(
    await fs.readFile(path.join(f.bin, name), "utf8"),
    "generated closure fixture",
  );
});
test("production IPC helper rejects malformed, omitted and false closure before the OS adapter", async (t) => {
  const f = await fixture(t);
  await assert.rejects(handlePrepareTrash(f.engine, {}), /无效请求/);
  await assert.rejects(handleCancelTrash(f.engine, false), /无效请求/);
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    const c = await handlePrepareTrash(f.engine, f.id),
      before = f.calls();
    await assert.rejects(
      handleTrash(f.engine, f.id, true, value, c.token, f.move),
      /无效请求|退出全部/,
    );
    assert.deepEqual(f.calls(), before);
    await assert.rejects(
      handleTrash(f.engine, f.id, true, true, c.token, f.move),
      /确认已失效/,
    );
  }
  const cancelled = await handlePrepareTrash(f.engine, f.id);
  await handleCancelTrash(f.engine, cancelled.token);
  await assert.rejects(
    handleTrash(f.engine, f.id, true, true, cancelled.token, f.move),
    /确认已失效/,
  );
  const c = await handlePrepareTrash(f.engine, f.id);
  assert.equal(
    (await handleTrash(f.engine, f.id, true, true, c.token, f.move)).completed,
    1,
  );
  await assert.rejects(
    handleTrash(f.engine, f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  assert.equal(f.calls().moves, 1);
});

test("a later operation resetting cancellation cannot revive an earlier Trash token", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  f.engine.cancelScan();
  await f.engine.scan({ minAgeDays: 30, includeSessions: false });
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  const fresh = await f.engine.prepareTrash(f.id);
  assert.equal(
    (await f.engine.trash(f.id, true, true, fresh.token, f.move)).completed,
    1,
  );
  assert.equal(f.calls().moves, 1);
});

for (const stop of ["cancel", "invalidate", "busy-prepare"] as const)
  test(`Trash preparation cannot publish a token after ${stop} during its authenticated read`, async (t) => {
    const f = await fixture(t),
      open = fs.open;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    let held = false;
    const mock = t.mock.method(
      fs,
      "open",
      async (...args: Parameters<typeof fs.open>) => {
        const h = await open(...args);
        if (!held && String(args[0]) === path.join(f.batch, "manifest.json")) {
          held = true;
          const readFile = h.readFile.bind(h);
          h.readFile = (async (...values: any[]) => {
            const bytes = await (readFile as Function)(...values);
            entered();
            await gate;
            return bytes;
          }) as typeof h.readFile;
        }
        return h;
      },
    );
    const pending = f.engine.prepareTrash(f.id);
    await waiting;
    if (stop === "cancel") f.engine.cancelScan();
    else if (stop === "invalidate") f.engine.invalidate();
    else await assert.rejects(f.engine.prepareTrash(f.id), /另一项操作/);
    release();
    try {
      await assert.rejects(pending, /确认已失效/);
    } finally {
      mock.mock.restore();
    }
    assert.equal((f.engine as any).trashConfirmation, undefined);
    assert.equal(f.calls().moves, 0);
    assert.ok((await fs.stat(f.batch)).isDirectory());
  });

test("confirmation binds exact batch and manifest identities even if signed bytes are copied", async (t) => {
  for (const target of ["batch", "manifest"] as const) {
    const f = await fixture(t),
      c = await f.engine.prepareTrash(f.id);
    if (target === "batch") {
      await fs.rename(f.batch, f.batch + "-saved");
      await fs.cp(f.batch + "-saved", f.batch, { recursive: true });
    } else {
      const manifest = path.join(f.batch, "manifest.json"),
        bytes = await fs.readFile(manifest);
      await fs.rename(manifest, manifest + ".saved");
      await fs.writeFile(manifest, bytes);
      await fs.unlink(manifest + ".saved");
    }
    await assert.rejects(
      f.engine.trash(f.id, true, true, c.token, f.move),
      /确认已失效/,
    );
    assert.equal(f.calls().moves, 0);
  }
});

test("imported origin-key journal remains origin-signed through confirmed Trash receipt", async (t) => {
  const f = await fixture(t),
    rotated = randomBytes(32);
  const e = new AgentVacEngine(
    f.root,
    rotated,
    false,
    async () => ({ status: "clear", details: "synthetic" }),
    [f.key],
  );
  const original = await fs.readFile(path.join(f.batch, "manifest.json"));
  const c = await e.prepareTrash(f.id);
  assert.deepEqual(Object.keys(c).sort(), [
    "batchId",
    "demo",
    "expiresAt",
    "provider",
    "root",
    "token",
  ]);
  assert.equal((await e.trash(f.id, true, true, c.token, f.move)).completed, 1);
  assert.deepEqual(
    await fs.readFile(path.join(f.bin, "manifest.json")),
    original,
  );
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".agentvac-quarantine", f.id + ".receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.journal.version, 4);
  assert.equal(receipt.keyId, createHash("sha256").update(f.key).digest("hex"));
  assert.equal(
    receipt.signature,
    createHmac("sha256", f.key)
      .update(JSON.stringify(receipt.journal))
      .digest("hex"),
  );
  assert.notEqual(
    receipt.keyId,
    createHash("sha256").update(rotated).digest("hex"),
  );
});

test("re-signing identical journal content under another trusted origin key invalidates consent", async (t) => {
  const f = await fixture(t),
    rotated = randomBytes(32);
  const e = new AgentVacEngine(
    f.root,
    rotated,
    false,
    async () => ({ status: "clear", details: "synthetic" }),
    [f.key],
  );
  const c = await e.prepareTrash(f.id),
    manifest = path.join(f.batch, "manifest.json");
  const data = JSON.parse(await fs.readFile(manifest, "utf8"));
  data.signature = createHmac("sha256", rotated)
    .update(JSON.stringify(data.journal))
    .digest("hex");
  data.keyId = createHash("sha256").update(rotated).digest("hex");
  await fs.writeFile(manifest, JSON.stringify(data));
  await assert.rejects(
    e.trash(f.id, true, true, c.token, f.move),
    /批次认证记录发生变化/,
  );
  assert.equal(f.calls().moves, 0);
});

for (const stop of ["cancel", "invalidate", "expire"] as const)
  test(`already-admitted Trash preserves its owned receipt after ${stop} inside the callback`, async (t) => {
    const f = await fixture(t),
      c = await f.engine.prepareTrash(f.id);
    const out = await f.engine.trash(f.id, true, true, c.token, async (dir) => {
      if (stop === "cancel") f.engine.cancelTrashConfirmation(c.token);
      else if (stop === "invalidate") f.engine.invalidate();
      else {
        const now = performance.now();
        t.mock.method(performance, "now", () => now + 6 * 60_000);
      }
      await f.move(dir);
    });
    assert.equal(out.completed, 1);
    assert.deepEqual(out.failed, []);
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(f.root, ".agentvac-quarantine", f.id + ".receipt.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.journal.version, 4);
    assert.equal(receipt.journal.items[0].status, "trashed");
    assert.equal(
      receipt.signature,
      createHmac("sha256", f.key)
        .update(JSON.stringify(receipt.journal))
        .digest("hex"),
    );
  });

test("expiry during a successful process check still blocks pre-callback admission", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id);
  f.setCheck(async () => {
    const now = performance.now();
    t.mock.method(performance, "now", () => now + 6 * 60_000);
    return { status: "clear", details: "synthetic expiry while inspecting" };
  });
  await assert.rejects(
    f.engine.trash(f.id, true, true, c.token, f.move),
    /确认已失效/,
  );
  assert.equal(f.calls().moves, 0);
  assert.ok((await fs.stat(f.batch)).isDirectory());
});

test("late cancellation of an older dialog cannot revoke its replacement confirmation", async (t) => {
  const f = await fixture(t),
    old = await f.engine.prepareTrash(f.id),
    fresh = await f.engine.prepareTrash(f.id);
  f.engine.cancelTrashConfirmation(old.token);
  assert.equal(
    (await f.engine.trash(f.id, true, true, fresh.token, f.move)).completed,
    1,
  );
  assert.equal(f.calls().moves, 1);
});

test("stale Trash confirmation never recreates a removed quarantine parent", async (t) => {
  const f = await fixture(t),
    c = await f.engine.prepareTrash(f.id),
    q = path.dirname(f.batch);
  const original = await fs.readFile(path.join(f.batch, "manifest.json"));
  await fs.rename(q, q + "-preserved");
  await assert.rejects(f.engine.trash(f.id, true, true, c.token, f.move));
  await assert.rejects(fs.lstat(q), { code: "ENOENT" });
  assert.deepEqual(
    await fs.readFile(path.join(q + "-preserved", f.id, "manifest.json")),
    original,
  );
  assert.equal(f.calls().moves, 0);
});
