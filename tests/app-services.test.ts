import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  AppDataServices,
  type AppDataServiceOptions,
} from "../electron/app-services.js";
import { WorkspaceStore } from "../electron/workspaces.js";
import type { ProcessStatus } from "../shared/types.js";

const clear = async (): Promise<ProcessStatus> => ({
  status: "clear",
  details: "test fixture only",
});
async function fixture(
  t: TestContext,
  override: Partial<AppDataServiceOptions> = {},
) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-app-services-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  const root = path.join(base, "selected");
  const home = path.join(base, "synthetic-home");
  await fs.mkdir(root);
  const options: AppDataServiceOptions = {
    home,
    env: {},
    cwd: base,
    processCheck: clear,
    ...override,
  };
  const service = new AppDataServices(profile, options);
  return {
    base,
    profile,
    root,
    home,
    options,
    service,
    restart: () => new AppDataServices(profile, options),
  };
}
async function write(
  root: string,
  relative: string,
  data = "synthetic fixture only",
) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  const old = new Date(Date.now() - 70 * 86400000);
  await fs.utimes(file, old, old);
  return file;
}
async function rootId(service: AppDataServices, root: string) {
  const id = (await service.getAppData()).workspaces.entries.find(
    (entry) => entry.path === root,
  )?.id;
  assert.ok(id);
  return id;
}
async function quarantineOne(service: AppDataServices) {
  const engine = service.engine();
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const entry = scan.entries.find((item) => item.selectable);
  assert.ok(entry);
  const preview = await engine.preview([entry.id]);
  return engine.quarantine(preview.token, true);
}
async function symlink(
  t: TestContext,
  source: string,
  target: string,
  type?: "dir",
) {
  try {
    await fs.symlink(source, target, type);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Symlink privileges unavailable");
      return false;
    }
    throw error;
  }
}

test("startup lists pure unverified candidates without inspecting the synthetic home or scanning", async (t) => {
  const f = await fixture(t);
  const envRoot = path.join(f.base, "not-selected-sqlite");
  const service = new AppDataServices(f.profile, {
    ...f.options,
    env: {
      CODEX_HOME: "relative-codex",
      CODEX_SQLITE_HOME: envRoot,
      SECRET_OTHER: "ignore",
    },
  });
  const lstat = fs.lstat,
    opendir = fs.opendir,
    readFile = fs.readFile;
  const attempted: string[] = [];
  fs.lstat = (async (p: any, ...args: any[]) => {
    if (
      String(p).startsWith(f.home) ||
      String(p).startsWith(envRoot) ||
      String(p).startsWith(path.join(f.base, "relative-codex"))
    ) {
      attempted.push(String(p));
      throw new Error("Candidates are not permission to inspect");
    }
    return (lstat as any)(p, ...args);
  }) as typeof fs.lstat;
  fs.opendir = (async () => {
    throw new Error("Startup cannot scan");
  }) as typeof fs.opendir;
  fs.readFile = (async (p: any, ...args: any[]) => {
    if (String(p).startsWith(f.home))
      throw new Error("Cannot read candidate content");
    return (readFile as any)(p, ...args);
  }) as typeof fs.readFile;
  try {
    const view = await service.initialize();
    assert.deepEqual(attempted, []);
    assert.equal(view.candidates.length, 3);
    assert.ok(
      view.candidates.every((candidate) => candidate.verified === false),
    );
    assert.equal(service.getContext().root, null);
    assert.throws(() => service.engine());
    assert.equal(view.demo.status, "absent");
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
    const another = await new AppDataServices(f.profile, {
      ...f.options,
      env: { CODEX_HOME: "relative-codex", CODEX_SQLITE_HOME: envRoot },
    }).initialize();
    assert.deepEqual(another.candidates, view.candidates);
    const key = await readFile(
      path.join(f.profile, "recovery", "journal-signing.key"),
    );
    assert.equal(JSON.stringify(view).includes(key.toString("base64")), false);
  } finally {
    fs.lstat = lstat;
    fs.opendir = opendir;
    fs.readFile = readFile;
  }
});

test("MRU selections persist, stay bounded, and reopen only the latest Codex root without scanning", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const originalId = await rootId(f.service, f.root);
  const dbRoot = path.join(f.base, "sqlite");
  await fs.mkdir(dbRoot);
  await f.service.rememberDiagnosticRoot(dbRoot, "sqlite");
  assert.equal(f.service.getContext().root, f.root);
  await f.service.activateWorkspace(await rootId(f.service, dbRoot));
  assert.equal(f.service.getContext().root, f.root);
  const opendir = fs.opendir;
  fs.opendir = (async () => {
    throw new Error("No automatic scan");
  }) as typeof fs.opendir;
  try {
    const next = f.restart();
    await next.initialize();
    assert.equal(next.getContext().root, f.root);
    assert.equal(await rootId(next, f.root), originalId);
  } finally {
    fs.opendir = opendir;
  }
  for (let i = 0; i < 13; i++) {
    const dir = path.join(f.base, `root-${i}`);
    await fs.mkdir(dir);
    await f.service.selectCodexRoot(dir);
  }
  assert.equal((await f.service.getAppData()).workspaces.entries.length, 12);
  const latest = f.service.getContext().root!;
  await fs.rename(latest, path.join(f.base, "moved-latest"));
  const next = f.restart();
  const view = await next.initialize();
  assert.equal(next.getContext().root, null);
  assert.equal(view.workspaces.entries[0].status, "missing");
  assert.ok(view.issues.length);
});

test("unknown IDs, arbitrary candidate paths and invalid diagnostic scopes are rejected", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const id = await rootId(f.service, f.root);
  await assert.rejects(f.service.activateCandidate(f.root), /标识未知/);
  await assert.rejects(f.service.activateWorkspace("f".repeat(64)), /标识未知/);
  await assert.rejects(f.service.forgetWorkspace("f".repeat(64)), /标识未知/);
  await assert.rejects(
    f.service.diagnose({ workspaceIds: ["f".repeat(64)], configOptIn: false }),
    /标识未知/,
  );
  for (const workspaceIds of [[], Array(9).fill(id), [f.root]])
    await assert.rejects(
      f.service.diagnose({ workspaceIds, configOptIn: false }),
    );
  for (const configOptIn of ["true", 1, null, undefined])
    await assert.rejects(
      f.service.diagnose({ workspaceIds: [id], configOptIn } as any),
    );
  for (const enabled of ["true", 1, null])
    await assert.rejects(
      f.service.diagnose({
        workspaceIds: [id],
        configOptIn: false,
        deepCheck: { enabled, databasePath: "", confirmedClosed: true },
      } as any),
    );
  await assert.rejects(
    f.service.rememberDiagnosticRoot(f.root, "codex" as any),
  );
  assert.equal(f.service.getContext().root, f.root);
});

test("unavailable or replaced roots cannot be activated or diagnosed and are never relocated", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const id = await rootId(f.service, f.root);
  await fs.rename(f.root, path.join(f.base, "original"));
  await fs.mkdir(f.root);
  assert.equal(
    (await f.service.getAppData()).workspaces.entries[0].status,
    "moved",
  );
  await assert.rejects(f.service.activateWorkspace(id));
  await assert.rejects(
    f.service.diagnose({ workspaceIds: [id], configOptIn: false }),
  );
  await assert.rejects(
    f.service.engine().scan({ minAgeDays: 30, includeSessions: false }),
  );
  assert.equal(
    (await f.restart().initialize()).workspaces.entries[0].path,
    f.root,
  );
  await f.service.selectCodexRoot(f.root); // A fresh explicit selection is allowed.
  assert.equal(
    (await f.service.getAppData()).workspaces.entries[0].status,
    "available",
  );
  await f.service.forgetWorkspace(id);
  assert.equal(f.service.getContext().root, null);
  assert.equal((await f.restart().initialize()).workspaces.entries.length, 0);
});

test("metadata failure preserves current selection, corrupt records and existing files", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const original = f.service.engine();
  const target = path.join(f.base, "other");
  await fs.mkdir(target);
  const file = path.join(f.profile, "recent-workspaces.json");
  await fs.writeFile(file, "{corrupt fixture");
  await assert.rejects(f.service.selectCodexRoot(target));
  assert.equal(f.service.getContext().root, f.root);
  assert.equal(f.service.engine(), original);
  assert.equal(await fs.readFile(file, "utf8"), "{corrupt fixture");
  const next = f.restart();
  const view = await next.initialize();
  assert.ok(view.workspaces.issue);
  assert.ok(view.issues.length);
  assert.equal(next.getContext().root, null);
  await assert.rejects(next.loadDemo());
  await assert.rejects(fs.stat(path.join(f.profile, "demo-workspace")), {
    code: "ENOENT",
  });
  await assert.rejects(next.selectCodexRoot(f.root));
});

test("config hints are opt-in, unverified and never scanned until their ID is activated", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const id = await rootId(f.service, f.root);
  const external = path.join(f.base, "opt-in-database");
  await fs.mkdir(external);
  await write(
    f.root,
    "config.toml",
    `sqlite_home = ${JSON.stringify(external)}\napi_key = "synthetic secret that must stay private"\n`,
  );
  await write(f.root, "state_5.sqlite", "12345");
  await write(f.root, "state_5.sqlite-wal", "12");
  await write(f.root, "logs_2.sqlite", "123");
  await write(f.root, "log/ordinary.log", "12345678901");
  await write(f.root, "sessions/deep/logs_2.sqlite", "nested data excluded");
  await write(external, "logs_2.sqlite", "1234567");
  const lstat = fs.lstat;
  const attempted: string[] = [];
  fs.lstat = (async (p: any, ...args: any[]) => {
    if (String(p).startsWith(external)) {
      attempted.push(String(p));
      throw new Error("No permission from hint alone");
    }
    return (lstat as any)(p, ...args);
  }) as typeof fs.lstat;
  let candidateId: string;
  try {
    const shallow = await f.service.diagnose({
      workspaceIds: [id],
      configOptIn: false,
    });
    assert.deepEqual(shallow.configHints, []);
    const opted = await f.service.diagnose({
      workspaceIds: [id],
      configOptIn: true,
    });
    assert.deepEqual(attempted, []);
    assert.equal(opted.sqliteTotalBytes, 10);
    assert.equal(opted.totals["ordinary-log"], 11);
    assert.equal(opted.files.length, 4);
    assert.equal(JSON.stringify(opted).includes("synthetic secret"), false);
    candidateId = opted.candidates.find(
      (candidate) => candidate.path === external,
    )!.id;
    assert.ok(candidateId);
    assert.deepEqual(JSON.parse(JSON.stringify(opted)), opted);
  } finally {
    fs.lstat = lstat;
  }
  const before = f.service.getContext();
  await f.service.activateCandidate(candidateId!);
  assert.deepEqual(f.service.getContext(), before);
  const externalId = await rootId(f.service, external);
  const result = await f.service.diagnose({
    workspaceIds: [externalId],
    configOptIn: false,
  });
  assert.equal(result.sqliteTotalBytes, 7);
  assert.equal(result.roots[0].kind, "sqlite-home");
});

test("deep checks require explicit acknowledgement and clear process checks before and after", async (t) => {
  let checks = 0;
  let statuses: Array<ProcessStatus["status"]> = ["clear"];
  const f = await fixture(t, {
    processCheck: async () => ({
      status: statuses[Math.min(checks++, statuses.length - 1)],
      details: "fixture",
    }),
  });
  await f.service.selectCodexRoot(f.root);
  const id = await rootId(f.service, f.root);
  const databasePath = await write(
    f.root,
    "logs_2.sqlite",
    "not a SQLite fixture",
  );
  const request = {
    workspaceIds: [id],
    configOptIn: false,
    deepCheck: { enabled: true, databasePath, confirmedClosed: false },
  };
  assert.equal(
    (await f.service.diagnose(request)).deepCheck.reason,
    "CLOSE_CONFIRMATION_REQUIRED",
  );
  assert.equal(checks, 0);
  await assert.rejects(
    f.service.diagnose({
      ...request,
      deepCheck: { ...request.deepCheck, confirmedClosed: "true" },
    } as any),
  );
  for (const status of ["running", "unknown"] as const) {
    checks = 0;
    statuses = [status];
    const result = await f.service.diagnose({
      ...request,
      deepCheck: { ...request.deepCheck, confirmedClosed: true },
    });
    assert.equal(
      result.deepCheck.reason,
      status === "running" ? "CODEX_RUNNING" : "PROCESS_UNKNOWN",
    );
    assert.equal(checks, 1);
    assert.equal(result.deepCheck.metrics, undefined);
  }
  checks = 0;
  statuses = ["clear", "running"];
  assert.equal(
    (
      await f.service.diagnose({
        ...request,
        deepCheck: { ...request.deepCheck, confirmedClosed: true },
      })
    ).deepCheck.reason,
    "CODEX_RUNNING",
  );
  assert.equal(checks, 2);
  checks = 0;
  statuses = ["clear", "clear"];
  assert.equal(
    (
      await f.service.diagnose({
        ...request,
        deepCheck: { ...request.deepCheck, confirmedClosed: true },
      })
    ).deepCheck.reason,
    "NOT_SQLITE",
  );
  assert.equal(checks, 2);
  await write(f.root, "logs_2.sqlite-wal", "sidecar");
  assert.equal(
    (
      await f.service.diagnose({
        ...request,
        deepCheck: { ...request.deepCheck, confirmedClosed: true },
      })
    ).deepCheck.reason,
    "SIDECARS_PRESENT",
  );
  const outside = await write(f.base, "logs_2.sqlite", "outside");
  assert.equal(
    (
      await f.service.diagnose({
        ...request,
        deepCheck: {
          enabled: true,
          confirmedClosed: true,
          databasePath: outside,
        },
      })
    ).deepCheck.reason,
    "OUTSIDE_SELECTED_ROOTS",
  );
  const noProcess = new AppDataServices(f.profile, {
    ...f.options,
    processCheck: async () => {
      throw new Error("unavailable");
    },
  });
  await noProcess.initialize();
  assert.equal(
    (
      await noProcess.diagnose({
        ...request,
        deepCheck: { ...request.deepCheck, confirmedClosed: true },
      })
    ).deepCheck.reason,
    "PROCESS_UNKNOWN",
  );
});

test("import keeps both devices' histories, invalidates old previews and returns no key bytes", async (t) => {
  const f = await fixture(t);
  await write(f.root, "log/codex-tui.log.1", "original data A");
  await f.service.selectCodexRoot(f.root);
  const a = await quarantineOne(f.service);
  const bundleA = path.join(f.base, "keys-a.json");
  await f.service.exportKeys(bundleA);
  const otherProfile = path.join(f.base, "other-profile");
  const other = new AppDataServices(otherProfile, f.options);
  await other.selectCodexRoot(f.root);
  assert.equal(
    (await other.engine().inspectRecovery()).batches[0].verified,
    false,
  );
  await write(f.root, "log/codex-tui.log.2", "original data B");
  const b = await quarantineOne(other);
  await write(f.root, "log/codex-tui.log.3", "preview only");
  const oldEngine = other.engine();
  const scan = await oldEngine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await oldEngine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const result = await other.importKeys(bundleA);
  assert.equal(result.addedKeyIds.length, 1);
  assert.notEqual(other.engine(), oldEngine);
  await assert.rejects(other.engine().quarantine(preview.token, true));
  const history = await other.engine().history();
  assert.equal(history.length, 2);
  assert.ok(
    history.every((batch) =>
      batch.items.every((item) => item.status === "quarantined"),
    ),
  );
  assert.ok(
    (await other.engine().inspectRecovery()).batches.every(
      (batch) => batch.verified,
    ),
  );
  assert.equal((await other.engine().restore(a.batchId, true)).completed, 1);
  assert.equal((await other.engine().restore(b.batchId, true)).completed, 1);
  assert.equal(
    await fs.readFile(path.join(f.root, "log/codex-tui.log.1"), "utf8"),
    "original data A",
  );
  const secret = await fs.readFile(
    path.join(f.profile, "recovery/journal-signing.key"),
  );
  assert.equal(
    JSON.stringify(result).includes(secret.toString("base64")),
    false,
  );
  await other.flush();
  const restarted = new AppDataServices(otherProfile, f.options);
  await restarted.initialize();
  assert.equal((await restarted.engine().history()).length, 2);
});

test("missing usable primary permits readonly rescue and trusted-key restore, but no new cleanup", async (t) => {
  const f = await fixture(t);
  await write(f.root, "log/codex-tui.log.1", "retain and restore");
  await f.service.selectCodexRoot(f.root);
  const operation = await quarantineOne(f.service);
  const exported = path.join(f.base, "own-key-backup.json");
  await f.service.exportKeys(exported);
  await f.service.importKeys(exported); // Retain old primary as explicitly imported trust.
  await fs.writeFile(
    path.join(f.profile, "recovery/journal-signing.key"),
    "malformed fixture",
  );
  const next = f.restart();
  const view = await next.initialize();
  assert.equal(view.recovery.canSign, false);
  assert.ok(
    view.recovery.issues.some((issue) => issue.code === "primary-unavailable"),
  );
  assert.equal(next.getContext().root, f.root);
  const rescue = await next.engine().inspectRecovery();
  assert.equal(rescue.readOnly, true);
  assert.equal(rescue.batches[0].verified, true);
  await write(f.root, "log/codex-tui.log.2", "do not move without signing key");
  await assert.rejects(quarantineOne(next), /钥匙|密钥/);
  await assert.rejects(
    next.engine().trash(operation.batchId, true, async () => {
      throw new Error("Should not reach OS Trash");
    }),
    /钥匙|密钥/,
  );
  assert.equal(
    (await next.engine().restore(operation.batchId, true)).completed,
    1,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "log/codex-tui.log.1"), "utf8"),
    "retain and restore",
  );
});

test("legacy raw key import works and committed import stays successful if selected root vanished", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const raw = path.join(f.base, "own-legacy-key");
  await fs.writeFile(raw, randomBytes(32));
  await fs.rename(f.root, path.join(f.base, "moved-root"));
  const result = await f.service.importKeys(raw);
  assert.equal(result.addedKeyIds.length, 1);
  assert.equal(f.service.getContext().root, null);
  assert.throws(() => f.service.engine());
  assert.ok(
    (await f.service.getAppData()).issues.some((message) =>
      message.includes("已导入"),
    ),
  );
  const target = path.join(f.base, "already-exists");
  await fs.writeFile(target, "keep");
  await assert.rejects(f.service.exportKeys(target));
  assert.equal(await fs.readFile(target, "utf8"), "keep");
  const again = await f.service.importKeys(raw);
  assert.equal(again.addedKeyIds.length, 0);
  assert.equal(again.duplicateKeyIds.length, 1);
});

test("persistent demo reuses the exact directory and preserves edits, quarantine and recovery across restarts", async (t) => {
  const f = await fixture(t);
  const context = await f.service.loadDemo();
  assert.equal(context.root, path.join(f.profile, "demo-workspace"));
  assert.equal(context.demo, true);
  const demo = context.root!;
  const before = await fs.stat(demo);
  const custom = await write(
    demo,
    "unknown-notes.txt",
    "user changed synthetic demo file",
  );
  const customStat = await fs.stat(custom);
  const operation = await quarantineOne(f.service);
  const marker = await fs.readFile(
    path.join(demo, ".agentvac-demo-owner.json"),
    "utf8",
  );
  await f.service.loadDemo();
  assert.equal((await f.service.engine().history()).length, 1);
  assert.equal(
    await fs.readFile(custom, "utf8"),
    "user changed synthetic demo file",
  );
  assert.equal((await fs.stat(custom)).mtimeMs, customStat.mtimeMs);
  const restarted = f.restart();
  const view = await restarted.initialize();
  assert.equal(view.demo.status, "ready");
  assert.equal(view.demo.canReset, false);
  assert.equal(restarted.getContext().root, demo);
  assert.equal(restarted.getContext().demo, true);
  await restarted.loadDemo();
  assert.equal((await fs.stat(demo)).ino, before.ino);
  assert.equal(
    await fs.readFile(path.join(demo, ".agentvac-demo-owner.json"), "utf8"),
    marker,
  );
  assert.equal((await restarted.engine().history())[0].id, operation.batchId);
  assert.equal(
    (await restarted.engine().restore(operation.batchId, true)).completed,
    1,
  );
  await restarted.loadDemo();
  assert.equal(
    (await restarted.engine().history())[0].items[0].status,
    "restored",
  );
});

test("demo reset requires literal confirmation, authentic ownership and a working Trash adapter", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.base, "MOCK-TRASH-only-test-fixtures");
  let calls = 0;
  // This is an explicit test double, not an OS Trash implementation.
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async (root) => {
      calls++;
      await fs.rename(root, destination);
    },
  });
  await service.loadDemo();
  const demo = service.getContext().root!;
  await write(demo, "unknown-notes.txt", "must survive in mocked trash");
  const old = await fs.stat(demo);
  for (const confirmation of [false, undefined, "true", 1])
    await assert.rejects(service.resetDemo(confirmation as any), /明确确认/);
  assert.equal(calls, 0);
  assert.equal((await service.getAppData()).demo.canReset, true);
  await service.resetDemo(true);
  assert.equal(calls, 1);
  assert.equal(service.getContext().root, demo);
  assert.notEqual((await fs.stat(demo)).ino, old.ino);
  assert.equal((await fs.stat(destination)).ino, old.ino);
  assert.equal(
    await fs.readFile(path.join(destination, "unknown-notes.txt"), "utf8"),
    "must survive in mocked trash",
  );
  assert.deepEqual(await service.engine().history(), []);
  assert.equal((await service.getAppData()).demo.status, "ready");
});

test("failed or no-op demo Trash preserves files without destructive fallback", async (t) => {
  const f = await fixture(t);
  let mode: "fail" | "noop" = "fail";
  let calls = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async () => {
      calls++;
      if (mode === "fail") throw new Error("test adapter refused");
    },
  });
  await service.loadDemo();
  const demo = service.getContext().root!;
  const oldEngine = service.engine();
  await write(demo, "unknown-notes.txt", "never delete fixture");
  const rm = fs.rm,
    unlink = fs.unlink,
    rename = fs.rename;
  fs.rm = (async () => {
    throw new Error("No delete fallback");
  }) as typeof fs.rm;
  fs.unlink = (async () => {
    throw new Error("No unlink fallback");
  }) as typeof fs.unlink;
  fs.rename = (async () => {
    throw new Error("No rename fallback");
  }) as typeof fs.rename;
  try {
    await assert.rejects(service.resetDemo(true), /未移离原位置/);
    mode = "noop";
    await assert.rejects(service.resetDemo(true), /未移离原位置/);
    assert.equal(calls, 2);
    assert.equal(service.engine(), oldEngine);
    assert.equal(
      await fs.readFile(path.join(demo, "unknown-notes.txt"), "utf8"),
      "never delete fixture",
    );
  } finally {
    fs.rm = rm;
    fs.unlink = unlink;
    fs.rename = rename;
  }
  const withoutAdapter = f.restart();
  await withoutAdapter.initialize();
  await assert.rejects(withoutAdapter.resetDemo(true), /系统回收站不可用/);
});

test("Trash error after a move is reported truthfully and never regenerates automatically", async (t) => {
  const f = await fixture(t);
  const moved = path.join(f.base, "MOCK-TRASH-moved-then-error");
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async (root) => {
      await fs.rename(root, moved);
      throw new Error("test adapter reported error after moving");
    },
  });
  await service.loadDemo();
  await assert.rejects(service.resetDemo(true), /已不在原位置/);
  assert.equal(service.getContext().root, null);
  assert.equal((await service.getAppData()).demo.status, "absent");
  await assert.rejects(fs.stat(path.join(f.profile, "demo-workspace")), {
    code: "ENOENT",
  });
  assert.equal((await fs.stat(moved)).isDirectory(), true);
});

test("foreign demo directories and forged markers cannot be loaded, reset or overwritten", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async () => {
      calls++;
    },
  });
  await service.initialize();
  const demo = path.join(f.profile, "demo-workspace");
  await fs.mkdir(demo);
  const foreign = await write(demo, "keep.txt", "foreign data");
  assert.equal((await service.getAppData()).demo.status, "blocked");
  await assert.rejects(service.loadDemo());
  await assert.rejects(service.resetDemo(true));
  await write(
    demo,
    ".agentvac-demo-owner.json",
    JSON.stringify({
      format: "agentvac-demo-workspace",
      version: 1,
      phase: "ready",
      root: demo,
      dev: "1",
      ino: "1",
      keyId: "0".repeat(64),
      signature: "0".repeat(64),
    }),
  );
  await assert.rejects(service.loadDemo());
  await assert.rejects(service.resetDemo(true));
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(foreign, "utf8"), "foreign data");
});

test("copied demo ownership marker is bound to its original directory identity", async (t) => {
  const f = await fixture(t);
  await f.service.loadDemo();
  const demo = f.service.getContext().root!;
  const marker = await fs.readFile(
    path.join(demo, ".agentvac-demo-owner.json"),
  );
  const original = path.join(f.base, "original-owned-demo");
  await fs.rename(demo, original);
  await fs.mkdir(demo);
  await fs.writeFile(path.join(demo, ".agentvac-demo-owner.json"), marker);
  assert.equal((await f.service.getAppData()).demo.status, "blocked");
  await assert.rejects(f.service.loadDemo());
  const restarted = f.restart();
  await restarted.initialize();
  assert.equal(restarted.getContext().root, null);
  assert.equal((await fs.stat(original)).isDirectory(), true);
});

test("demo flags cannot make an ordinary directory bypass process protections", async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  await assert.rejects(f.service.selectCodexRoot(f.root, true), /应用拥有/);
  const store = new WorkspaceStore(f.profile);
  await store.load();
  const forged = await store.remember({
    kind: "codex",
    path: f.root,
    demo: true,
    name: "forged-demo-fixture",
  });
  const restarted = f.restart();
  const view = await restarted.initialize();
  assert.equal(restarted.getContext().root, null);
  assert.ok(view.issues.length);
  await assert.rejects(restarted.activateWorkspace(forged.id), /应用拥有/);
});

test("interrupted demo creation remains preparing and never overwrites a partial fixture", async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  const open = fs.open;
  fs.open = (async (file: any, ...args: any[]) => {
    if (
      String(file) ===
      path.join(f.profile, "demo-workspace", "log/codex-tui.log.2")
    )
      throw new Error("simulated interrupted fixture creation");
    return (open as any)(file, ...args);
  }) as typeof fs.open;
  try {
    await assert.rejects(f.service.loadDemo(), /simulated interrupted/);
  } finally {
    fs.open = open;
  }
  const partial = path.join(f.profile, "demo-workspace", "log/codex-tui.log.1");
  const before = await fs.stat(partial);
  assert.equal((await f.service.getAppData()).demo.status, "preparing");
  await assert.rejects(f.service.loadDemo(), /未完成/);
  const next = f.restart();
  assert.equal((await next.initialize()).demo.status, "preparing");
  assert.equal(next.getContext().root, null);
  await assert.rejects(next.loadDemo(), /未完成/);
  assert.equal((await fs.stat(partial)).mtimeMs, before.mtimeMs);
});

test("linked profile/demo paths and linked ownership files are refused", async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  const alias = path.join(f.base, "linked-profile");
  if (!(await symlink(t, f.profile, alias, "dir"))) return;
  await assert.rejects(new AppDataServices(alias, f.options).initialize());
  const demo = path.join(f.profile, "demo-workspace");
  if (!(await symlink(t, f.root, demo, "dir"))) return;
  assert.equal((await f.service.getAppData()).demo.status, "blocked");
  await assert.rejects(f.service.loadDemo());
  await fs.unlink(demo);
  await f.service.loadDemo();
  const marker = path.join(demo, ".agentvac-demo-owner.json");
  const copy = path.join(f.base, "marker-hardlink");
  await fs.link(marker, copy);
  assert.equal((await f.service.getAppData()).demo.status, "blocked");
  await assert.rejects(f.service.loadDemo());
});

test("reset refuses unknown added demo files without reading contents or calling Trash", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async () => {
      calls++;
    },
  });
  await service.loadDemo();
  const demo = service.getContext().root!;
  const added = await write(
    demo,
    "projects/personal-addition.txt",
    "preserve extra synthetic file",
  );
  const open = fs.open,
    readFile = fs.readFile;
  fs.open = (async (file: any, ...args: any[]) => {
    if (String(file) === added) throw new Error("Must not read unknown file");
    return (open as any)(file, ...args);
  }) as typeof fs.open;
  fs.readFile = (async (file: any, ...args: any[]) => {
    if (String(file) === added) throw new Error("Must not read unknown file");
    return (readFile as any)(file, ...args);
  }) as typeof fs.readFile;
  try {
    await assert.rejects(service.resetDemo(true), /未知新增文件/);
  } finally {
    fs.open = open;
    fs.readFile = readFile;
  }
  assert.equal(calls, 0);
  assert.equal(
    await fs.readFile(added, "utf8"),
    "preserve extra synthetic file",
  );
});

test("reset accepts authentic app quarantine but rejects unrecorded data blobs", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const destination = path.join(f.base, "MOCK-TRASH-quarantine-fixture");
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async (root) => {
      calls++;
      await fs.rename(root, destination);
    },
  });
  await service.loadDemo();
  const demo = service.getContext().root!;
  const batch = await quarantineOne(service);
  const unexpected = await write(
    demo,
    `.agentvac-quarantine/${batch.batchId}/11111111-1111-4111-8111-111111111111.data`,
    "unrecorded data",
  );
  await assert.rejects(service.resetDemo(true), /未知新增文件/);
  assert.equal(calls, 0);
  await fs.unlink(unexpected); // Only this test fixture's own extra file.
  await service.resetDemo(true);
  assert.equal(calls, 1);
  assert.equal(
    (
      await fs.stat(
        path.join(destination, ".agentvac-quarantine", batch.batchId),
      )
    ).isDirectory(),
    true,
  );
});

test("queued work is serialized and flush waits for all admitted selections", async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  const second = path.join(f.base, "second");
  await fs.mkdir(second);
  const firstOperation = f.service.selectCodexRoot(f.root);
  const secondOperation = f.service.selectCodexRoot(second);
  await f.service.flush();
  assert.equal(f.service.getContext().root, second);
  await Promise.all([firstOperation, secondOperation]);
  const next = f.restart();
  await next.initialize();
  assert.equal(next.getContext().root, second);
  assert.equal((await next.getAppData()).workspaces.entries.length, 2);
});

test("failure to initialize a new engine cannot replace the current selection", async (t) => {
  const f = await fixture(t);
  await f.service.selectCodexRoot(f.root);
  const engine = f.service.engine();
  await assert.rejects(f.service.selectCodexRoot(path.join(f.base, "missing")));
  await assert.rejects(f.service.selectCodexRoot(path.parse(f.root).root));
  assert.equal(f.service.engine(), engine);
  assert.equal(f.service.getContext().root, f.root);
});

test("a signed ready-marker temporary file left by interruption can be reset, never reused or overwritten", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const moved = path.join(f.base, "MOCK-TRASH-interrupted-ready-marker");
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async (root) => {
      calls++;
      await fs.rename(root, moved);
    },
  });
  await service.initialize();
  const rename = fs.rename;
  fs.rename = (async (source: any, target: any) => {
    if (path.basename(String(source)).startsWith(".demo-ready-"))
      throw new Error("simulated ready-marker rename interruption");
    return rename(source, target);
  }) as typeof fs.rename;
  try {
    await assert.rejects(service.loadDemo(), /rename interruption/);
  } finally {
    fs.rename = rename;
  }
  const demo = path.join(f.profile, "demo-workspace");
  const temporary = (await fs.readdir(demo)).find((name) =>
    name.startsWith(".demo-ready-"),
  );
  assert.ok(temporary);
  assert.equal((await service.getAppData()).demo.status, "preparing");
  await assert.rejects(service.loadDemo(), /未完成/);
  await service.resetDemo(true);
  assert.equal(calls, 1);
  assert.equal((await service.getAppData()).demo.status, "ready");
  assert.equal((await fs.stat(path.join(moved, temporary))).isFile(), true);
});

test("a temp-shaped file with invalid ownership is never accepted for demo reset", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async () => {
      calls++;
    },
  });
  await service.loadDemo();
  const added = await write(
    service.getContext().root!,
    ".demo-ready-11111111-1111-4111-8111-111111111111.tmp",
    "foreign data shaped like a temporary marker",
  );
  await assert.rejects(service.resetDemo(true));
  assert.equal(calls, 0);
  assert.equal(
    await fs.readFile(added, "utf8"),
    "foreign data shaped like a temporary marker",
  );
});
