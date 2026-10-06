import { trashFixture } from "./helpers/trash.js";
// Independent regression audit. All roots and file contents are generated fixtures.
// OS trash operations are injected directory moves; these are not native shell.trashItem tests.
// No production Codex directory or user transcript is accessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AgentVacEngine } from "../electron/engine.js";
const DAY = 86400000;
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
      t.skip(
        "Windows symlink privilege unavailable; this path protection case is not verified",
      );
      return false;
    }
    throw e;
  }
}
async function fixture(t: any) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-audit-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  await fs.mkdir(path.join(root, "log"), { recursive: true });
  const file = path.join(root, "log/codex-tui.log.1");
  await fs.writeFile(file, "generated fixture");
  const d = new Date(Date.now() - 60 * DAY);
  await fs.utimes(file, d, d);
  const key = randomBytes(32),
    engine = new AgentVacEngine(root, key, true);
  await engine.initialize();
  return { base, root, file, key, engine };
}
async function run(e: AgentVacEngine) {
  const s = await e.scan({ minAgeDays: 30, includeSessions: false });
  const v = await e.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  return e.quarantine(v.token, true);
}
test("root directory replacement is refused", async (t) => {
  const { root, engine } = await fixture(t);
  await fs.rename(root, root + "-old");
  await fs.mkdir(root);
  await assert.rejects(
    engine.scan({ minAgeDays: 30, includeSessions: false }),
    /根目录已被替换/,
  );
});
test("replayed old signed pending manifest restores exactly once", async (t) => {
  const { root, file, key, engine } = await fixture(t);
  const originalRename = fs.rename;
  let pending = "";
  let journalPath = "";
  fs.rename = async (src: any, dest: any) => {
    if (src === file) {
      const q = path.join(root, ".agentvac-quarantine");
      const files = await fs.readdir(q);
      journalPath = path.join(
        q,
        files.find((n) => /^[0-9a-f-]{36}$/.test(n))!,
        "manifest.json",
      );
      pending = await fs.readFile(journalPath, "utf8");
    }
    return originalRename(src, dest);
  };
  let r;
  try {
    r = await run(engine);
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(JSON.parse(pending).journal.items[0].status, "pending");
  await fs.writeFile(journalPath, pending);
  const restarted = new AgentVacEngine(root, key, true);
  assert.equal((await restarted.history())[0].items[0].status, "quarantined");
  assert.equal((await restarted.restore(r!.batchId)).completed, 1);
  await fs.writeFile(journalPath, pending);
  assert.equal((await restarted.restore(r!.batchId)).completed, 0);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("unlink failure after restore link is retryable without data loss", async (t) => {
  const { root, file, engine } = await fixture(t);
  const r = await run(engine);
  const h = (await engine.history())[0];
  const source = path.join(
    root,
    ".agentvac-quarantine",
    r.batchId,
    h.items[0].id + ".data",
  );
  const unlink = fs.unlink;
  fs.unlink = async (p: any) => {
    if (p === source)
      throw Object.assign(new Error("injected transient unlink failure"), {
        code: "EACCES",
      });
    return unlink(p);
  };
  try {
    const first = await engine.restore(r.batchId);
    assert.equal(first.completed, 0);
    assert.equal(first.failed.length, 1);
  } finally {
    fs.unlink = unlink;
  }
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
  assert.equal((await fs.lstat(source)).nlink, 2);
  const retry = await engine.restore(r.batchId);
  assert.equal(retry.completed, 1);
  assert.equal(retry.failed.length, 0);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
  await assert.rejects(fs.lstat(source));
});
test("corrupt manifest does not block valid history or opening quarantine", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  await fs.mkdir(
    path.join(
      root,
      ".agentvac-quarantine",
      "12345678-1234-4123-8123-123456789012",
    ),
  );
  await fs.writeFile(
    path.join(
      root,
      ".agentvac-quarantine",
      "12345678-1234-4123-8123-123456789012",
      "manifest.json",
    ),
    "{}",
  );
  await fs.writeFile(
    path.join(root, ".agentvac-quarantine", "unrelated.json"),
    "{}",
  );
  const h = await engine.history();
  assert.equal(
    h.find((x) => x.id === r.batchId)!.items[0].status,
    "quarantined",
  );
  assert.equal(
    h.find((x) => x.id.startsWith("12345678"))!.items[0].status,
    "failed",
  );
  assert.equal(
    await engine.getQuarantinePath(),
    path.join(root, ".agentvac-quarantine"),
  );
  assert.equal((await engine.restore(r.batchId)).completed, 1);
});
test("expired preview refuses move", async (t) => {
  const { engine, file } = await fixture(t);
  const s = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const v = await engine.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  const now = Date.now;
  Date.now = () => now() + 360000;
  try {
    await assert.rejects(engine.quarantine(v.token, true), /失效/);
  } finally {
    Date.now = now;
  }
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("same-engine concurrent operations refuse rather than interleave", async (t) => {
  const { engine } = await fixture(t);
  const p = engine.scan({ minAgeDays: 30, includeSessions: false });
  await assert.rejects(engine.history(), /正在进行/);
  await p;
});
test("replaced source symlink after preview is not moved", async (t) => {
  const { root, file, engine } = await fixture(t);
  const s = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const v = await engine.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  await fs.rename(file, file + ".saved");
  if (!(await symlinkOrSkip(t, file + ".saved", file))) return;
  const r = await engine.quarantine(v.token, true);
  assert.equal(r.completed, 0);
  assert.equal(r.failed.length, 1);
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(file + ".saved", "utf8"), "generated fixture");
});
test("restore parent symlink replacement is refused", async (t) => {
  const { root, file, engine } = await fixture(t);
  const r = await run(engine);
  await fs.rename(path.dirname(file), path.dirname(file) + "-old");
  if (
    !(await symlinkOrSkip(t, path.dirname(file) + "-old", path.dirname(file)))
  )
    return;
  const restore = await engine.restore(r.batchId);
  assert.equal(restore.completed, 0);
  assert.match(restore.failed[0].error, /链接/);
  assert.equal((await engine.history())[0].items[0].status, "quarantined");
});
test("restore competing destination creation never overwrites", async (t) => {
  const { file, engine } = await fixture(t);
  const r = await run(engine);
  const link = fs.link;
  fs.link = async (src: any, dest: any) => {
    if (dest === file)
      await fs.writeFile(file, "competing fixture", { flag: "wx" });
    return link(src, dest);
  };
  try {
    const out = await engine.restore(r.batchId);
    assert.equal(out.completed, 0);
    assert.equal(out.failed.length, 1);
  } finally {
    fs.link = link;
  }
  assert.equal(await fs.readFile(file, "utf8"), "competing fixture");
});
test("unknown process check fails closed even with explicit closure acknowledgement", async (t) => {
  const { root, key } = await fixture(t);
  let state: "unknown" | "clear" = "unknown";
  const engine = new AgentVacEngine(root, key, false, async () => ({
    status: state,
    details: "fixture",
  }));
  const s = await engine.scan({ minAgeDays: 30, includeSessions: false });
  let v = await engine.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  await assert.rejects(engine.quarantine(v.token, false), /确认/);
  v = await engine.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  await assert.rejects(engine.quarantine(v.token, true), /无法确认进程状态/);
  state = "clear";
  v = await engine.preview(
    s.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  const r = await engine.quarantine(v.token, true);
  await assert.rejects(engine.restore(r.batchId, false), /确认/);
  state = "unknown";
  await assert.rejects(engine.restore(r.batchId, true), /无法确认进程状态/);
  state = "clear";
  assert.equal((await engine.restore(r.batchId, true)).completed, 1);
});
test("journal creation failure before move leaves all source bytes intact", async (t) => {
  const { file, engine } = await fixture(t);
  const open = fs.open;
  fs.open = async (p: any, ...args: any[]) => {
    if (String(p).endsWith(".tmp"))
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    return (open as any)(p, ...args);
  };
  try {
    await assert.rejects(run(engine), /ENOSPC/);
  } finally {
    fs.open = open;
  }
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("final quarantine journal failure recovers moved file after fresh engine", async (t) => {
  const { root, file, key, engine } = await fixture(t);
  const rename = fs.rename;
  let commits = 0;
  fs.rename = async (src: any, dest: any) => {
    if (
      String(src).endsWith(".tmp") &&
      String(dest).endsWith(".json") &&
      ++commits === 2
    )
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    return rename(src, dest);
  };
  try {
    await assert.rejects(run(engine), /ENOSPC/);
  } finally {
    fs.rename = rename;
  }
  await assert.rejects(fs.lstat(file));
  const fresh = new AgentVacEngine(root, key, true);
  const h = await fresh.history();
  assert.equal(h[0].items[0].status, "quarantined");
  assert.equal((await fresh.restore(h[0].id)).completed, 1);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("final restore journal failure recognizes already-restored original after restart", async (t) => {
  const { root, file, key, engine } = await fixture(t);
  const r = await run(engine);
  const rename = fs.rename;
  let commits = 0;
  fs.rename = async (src: any, dest: any) => {
    if (
      String(src).endsWith(".tmp") &&
      String(dest).endsWith(".json") &&
      ++commits === 2
    )
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    return rename(src, dest);
  };
  try {
    await assert.rejects(engine.restore(r.batchId), /ENOSPC/);
  } finally {
    fs.rename = rename;
  }
  const fresh = new AgentVacEngine(root, key, true);
  const h = await fresh.history();
  assert.equal(h[0].items[0].status, "restored");
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
  assert.equal((await fresh.restore(r.batchId)).completed, 0);
});
test("post-move stat error keeps recoverable bytes available to restore", async (t) => {
  const { root, file, engine } = await fixture(t);
  const lstat = fs.lstat,
    rename = fs.rename;
  let movedTarget = "";
  fs.rename = async (src: any, dest: any) => {
    const r = await rename(src, dest);
    if (src === file) movedTarget = String(dest);
    return r;
  };
  fs.lstat = async (p: any, ...args: any[]) => {
    if (p === movedTarget) {
      movedTarget = "";
      throw Object.assign(new Error("injected transient EIO after rename"), {
        code: "EIO",
      });
    }
    return (lstat as any)(p, ...args);
  };
  let r;
  try {
    r = await run(engine);
  } finally {
    fs.lstat = lstat;
    fs.rename = rename;
  }
  assert.equal(r!.completed, 0);
  await assert.rejects(fs.lstat(file));
  const h = await engine.history();
  assert.equal(h[0].items[0].status, "quarantined");
  assert.equal(
    await fs.readFile(
      path.join(
        root,
        ".agentvac-quarantine",
        r!.batchId,
        h[0].items[0].id + ".data",
      ),
      "utf8",
    ),
    "generated fixture",
  );
  assert.equal((await engine.restore(r!.batchId)).completed, 1);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("trash requires exact explicit confirmation and never invokes callback without it", async (t) => {
  const { engine } = await fixture(t);
  const r = await run(engine);
  let invoked = false;
  await assert.rejects(
    trashFixture(engine, r.batchId, false, true, async () => {
      invoked = true;
    }),
    /确认/,
  );
  assert.equal(invoked, false);
  assert.equal((await engine.history())[0].items[0].status, "quarantined");
});
test("trash rejects unknown added files and preserves whole batch", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  const unknown = path.join(
    root,
    ".agentvac-quarantine",
    r.batchId,
    "not-owned.txt",
  );
  await fs.writeFile(unknown, "unrelated generated fixture");
  let invoked = false;
  await assert.rejects(
    trashFixture(engine, r.batchId, true, true, async () => {
      invoked = true;
    }),
    /未知文件/,
  );
  assert.equal(invoked, false);
  assert.equal(
    await fs.readFile(unknown, "utf8"),
    "unrelated generated fixture",
  );
  assert.equal((await engine.restore(r.batchId)).completed, 1);
});
test("trash rejects modified isolated files", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  const h = (await engine.history())[0];
  const source = path.join(
    root,
    ".agentvac-quarantine",
    r.batchId,
    h.items[0].id + ".data",
  );
  await fs.appendFile(source, "changed");
  let invoked = false;
  await assert.rejects(
    trashFixture(engine, r.batchId, true, true, async () => {
      invoked = true;
    }),
    /变化/,
  );
  assert.equal(invoked, false);
  assert.equal(await fs.readFile(source, "utf8"), "generated fixturechanged");
});
test("trash callback failure cannot trigger permanent deletion fallback", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  await assert.rejects(
    trashFixture(engine, r.batchId, true, true, async () => {
      throw new Error("injected OS trash unavailable");
    }),
    /unavailable/,
  );
  assert.equal(
    (
      await fs.lstat(path.join(root, ".agentvac-quarantine", r.batchId))
    ).isDirectory(),
    true,
  );
  assert.equal((await engine.restore(r.batchId)).completed, 1);
});
test("trash callback that does not move batch cannot report success", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  await assert.rejects(
    trashFixture(engine, r.batchId, true, true, async () => {}),
    /未确认/,
  );
  assert.equal(
    (
      await fs.lstat(path.join(root, ".agentvac-quarantine", r.batchId))
    ).isDirectory(),
    true,
  );
  assert.equal((await engine.restore(r.batchId)).completed, 1);
});
test("trash passes exactly selected batch to injected OS adapter; fixture bin bytes retained", async (t) => {
  const { base, root, engine } = await fixture(t);
  const r = await run(engine);
  const h = (await engine.history())[0];
  const mockBin = path.join(base, "mock-os-recycle-bin");
  let got = "";
  const out = await trashFixture(engine, r.batchId, true, true, async (p) => {
    got = p;
    await fs.rename(p, mockBin);
  });
  assert.equal(got, path.join(root, ".agentvac-quarantine", r.batchId));
  assert.equal(out.completed, 1);
  assert.equal(
    await fs.readFile(path.join(mockBin, h.items[0].id + ".data"), "utf8"),
    "generated fixture",
  );
  await assert.rejects(fs.lstat(got));
});
test("trash refuses batch directory replaced by symlink", async (t) => {
  const { root, engine } = await fixture(t);
  const r = await run(engine);
  const original = path.join(root, ".agentvac-quarantine", r.batchId);
  await fs.rename(original, original + "-saved");
  if (!(await symlinkOrSkip(t, original + "-saved", original))) return;
  let called = false;
  await assert.rejects(
    trashFixture(engine, r.batchId, true, true, async () => {
      called = true;
    }),
    /链接/,
  );
  assert.equal(called, false);
});
test("pending quarantine collision remains recoverable after conflict is removed", async (t) => {
  const { root, file, key, engine } = await fixture(t);
  const rename = fs.rename;
  let pending = "",
    manifest = "";
  fs.rename = async (src: any, dest: any) => {
    if (src === file) {
      manifest = path.join(path.dirname(String(dest)), "manifest.json");
      pending = await fs.readFile(manifest, "utf8");
    }
    return rename(src, dest);
  };
  let r;
  try {
    r = await run(engine);
  } finally {
    fs.rename = rename;
  }
  await fs.writeFile(manifest, pending);
  await fs.writeFile(file, "new conflicting fixture");
  const fresh = new AgentVacEngine(root, key, true);
  assert.equal((await fresh.history())[0].items[0].status, "quarantined");
  assert.equal((await fresh.restore(r!.batchId)).completed, 0);
  assert.equal(await fs.readFile(file, "utf8"), "new conflicting fixture");
  await fs.unlink(file);
  assert.equal((await fresh.restore(r!.batchId)).completed, 1);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
test("trash receipt survives engine restart and rejects replay restore", async (t) => {
  const { base, root, key, engine } = await fixture(t);
  const r = await run(engine);
  await trashFixture(engine, r.batchId, true, true, (p) =>
    fs.rename(p, path.join(base, "mock-bin")),
  );
  const fresh = new AgentVacEngine(root, key, true);
  const h = await fresh.history();
  assert.equal(h.find((x) => x.id === r.batchId)!.items[0].status, "trashed");
  await assert.rejects(fresh.restore(r.batchId));
});
test("trash receipt write failure reports moved bytes and warning, never false failure of OS move", async (t) => {
  const { base, engine } = await fixture(t);
  const r = await run(engine);
  const open = fs.open;
  fs.open = async (p: any, ...args: any[]) => {
    if (String(p).endsWith(".receipt.tmp"))
      throw new Error("injected receipt ENOSPC");
    return (open as any)(p, ...args);
  };
  let out;
  try {
    out = await trashFixture(engine, r.batchId, true, true, (p) =>
      fs.rename(p, path.join(base, "mock-bin")),
    );
  } finally {
    fs.open = open;
  }
  assert.equal(out!.completed, 1);
  assert.equal(out!.failed.length, 1);
  assert.match(out!.failed[0].error, /文件已移入/);
  assert.equal(
    (await fs.lstat(path.join(base, "mock-bin"))).isDirectory(),
    true,
  );
});
test("scan and preview never open generated source contents", async (t) => {
  const { root, engine } = await fixture(t);
  const session = path.join(root, "sessions/fixture-only.jsonl");
  await fs.mkdir(path.dirname(session));
  await fs.writeFile(
    session,
    "synthetic transcript contents that scanning must not read",
  );
  const old = new Date(Date.now() - 60 * DAY);
  await fs.utimes(session, old, old);
  const open = fs.open,
    read = fs.readFile;
  let sourceRead = 0;
  fs.open = async (p: any, ...args: any[]) => {
    if (String(p).startsWith(root)) {
      sourceRead++;
      throw new Error("source content access forbidden by test");
    }
    return (open as any)(p, ...args);
  };
  fs.readFile = async (p: any, ...args: any[]) => {
    if (String(p).startsWith(root)) {
      sourceRead++;
      throw new Error("source content access forbidden by test");
    }
    return (read as any)(p, ...args);
  };
  try {
    const s = await engine.scan({ minAgeDays: 30, includeSessions: true });
    assert.equal(s.entries.filter((x) => x.selectable).length, 1);
    assert.equal(
      (
        await engine.preview(
          s.entries.filter((x) => x.selectable).map((x) => x.id),
        )
      ).items.length,
      1,
    );
  } finally {
    fs.open = open;
    fs.readFile = read;
  }
  assert.equal(sourceRead, 0);
});

test("FIFO manifests are rejected without blocking a fresh process", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX FIFO fixture is not available on Windows");
    return;
  }
  const { root } = await fixture(t);
  const batch = path.join(
    root,
    ".agentvac-quarantine",
    "12345678-1234-4123-8123-123456789012",
  );
  await fs.mkdir(batch, { recursive: true });
  const fifo = path.join(batch, "manifest.json");
  const create = spawnSync("mkfifo", [fifo], {
    encoding: "utf8",
    timeout: 3000,
  });
  if ((create.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip(
      "mkfifo is unavailable; FIFO nonblocking protection is not verified",
    );
    return;
  }
  assert.equal(create.status, 0, create.stderr);
  const engineUrl = new URL("../electron/engine.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { AgentVacEngine } from ${JSON.stringify(engineUrl)};
        import { randomBytes } from 'node:crypto';
        const engine = new AgentVacEngine(${JSON.stringify(root)}, randomBytes(32), true);
        const rows = await engine.history();
        if (rows.length !== 1 || rows[0].items[0].status !== 'failed') process.exit(2);
        console.log('FIFO refused');
    `,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /FIFO refused/);
});

test("post-move directory sync failure preserves restart recovery", async (t) => {
  if (process.platform === "win32") {
    t.skip("Directory fsync is intentionally not implemented on Windows");
    return;
  }
  const { root, file, key, engine } = await fixture(t);
  const open = fs.open;
  const rename = fs.rename;
  let movedDirectory = "";
  fs.rename = async (source: any, target: any) => {
    const result = await rename(source, target);
    if (source === file) movedDirectory = path.dirname(String(target));
    return result;
  };
  fs.open = async (target: any, ...args: any[]) => {
    const handle = await (open as any)(target, ...args);
    if (target === movedDirectory) {
      handle.sync = async () => {
        throw Object.assign(new Error("injected directory sync EIO"), {
          code: "EIO",
        });
      };
    }
    return handle;
  };
  try {
    await assert.rejects(run(engine), /directory sync EIO/);
  } finally {
    fs.open = open;
    fs.rename = rename;
  }
  await assert.rejects(fs.lstat(file));
  const restarted = new AgentVacEngine(root, key, true);
  const history = await restarted.history();
  assert.equal(history[0].items[0].status, "quarantined");
  assert.equal((await restarted.restore(history[0].id)).completed, 1);
  assert.equal(await fs.readFile(file, "utf8"), "generated fixture");
});
