// Independent audit of new diagnostics/recovery/workspace services.
// Only generated fixtures are touched. OS trash is always an injected test adapter.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppDataServices } from "../electron/app-services.js";
import { diagnoseStorage } from "../electron/diagnostics.js";
import { inspectSqliteInWorker } from "../electron/diagnostic-parser.js";
import { RecoveryKeyring, recoveryKeyId } from "../electron/recovery-keys.js";
import { AgentVacEngine } from "../electron/engine.js";

const secret = "synthetic-secret-marker-no-real-user-data";
const ddl = `CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);
CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_thread_id ON logs(thread_id);
CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;`;
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-next-security-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  await fs.mkdir(root);
  const profile = path.join(base, "profile");
  return {
    base,
    root,
    profile,
    options: {
      home: base,
      env: {},
      cwd: base,
      processCheck: async () => ({
        status: "clear" as const,
        details: "generated fixture",
      }),
    },
  };
}
function createDatabase(root: string) {
  const file = path.join(root, "logs_2.sqlite");
  const db = new DatabaseSync(file);
  db.exec(ddl);
  db.prepare(
    "INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body) VALUES(1,0,'INFO','fixture',?)",
  ).run(secret);
  db.close();
  return file;
}
function bundle(keys: Buffer[]) {
  return JSON.stringify({
    format: "agentvac-recovery-keys",
    version: 1,
    keys: keys.map((key) => ({
      id: recoveryKeyId(key),
      keyBase64: key.toString("base64"),
    })),
  });
}

test("audit: demo reset refuses later-added unknown content before invoking Trash", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    trashItem: async (source) => {
      calls++;
      await fs.rename(source, path.join(f.base, "mock-trash"));
    },
  });
  const demo = (await service.loadDemo()).root!;
  const unknown = path.join(demo, "private-notes-fixture.txt");
  await fs.writeFile(unknown, secret);
  await assert.rejects(service.resetDemo(true));
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(unknown, "utf8"), secret);
});

test("audit parser unit: actual SQLite queries are nonempty schema/PRAGMA only, never log rows", async (t) => {
  const { root } = await fixture(t);
  const file = createDatabase(root);
  await fs.writeFile(
    path.join(root, "config.toml"),
    `api_key = "${secret}"\nlog_dir = "${root.replaceAll("\\", "\\\\")}"\n`,
  );
  const before = await fs.readFile(file);
  const queries: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    queries.push(sql);
    assert.match(
      sql,
      /^(?:PRAGMA\s+(?:database_list|page_size|page_count|freelist_count|auto_vacuum|journal_mode)$|SELECT type, name, tbl_name, CASE WHEN length\(sql\) <= 20000 THEN sql ELSE NULL END AS sql FROM sqlite_schema LIMIT 17$)/,
    );
    return prepare.call(this, sql);
  };
  let result;
  try {
    // Deliberate parser-layer test on a regular synthetic DB. Process-lifetime
    // tests separately exercise the isolated supervisor/worker transport.
    const metadata = await diagnoseStorage({
      roots: [{ path: root, kind: "codex-home" }],
      configOptIn: true,
    });
    result = {
      ...metadata,
      deepCheck: await inspectSqliteInWorker(file, [
        { path: root, kind: "codex-home" },
      ]),
    };
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(result.deepCheck.status, "ok");
  assert.ok(
    queries.length > 0,
    "spy must observe the actual parser, not a vacuous parent-process array",
  );
  assert.ok(queries.some((q) => q === "PRAGMA page_count"));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "config.toml",
    "logs_2.sqlite",
  ]);
});

test("audit parser unit: observed sidecar injection during inspection invalidates metrics", async (t) => {
  const { root } = await fixture(t);
  const file = createDatabase(root);
  const before = await fs.readFile(file);
  const stamp = await fs.stat(file, { bigint: true });
  let injected = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === "PRAGMA page_count") {
      injected++;
      writeFileSync(file + "-wal", "synthetic concurrent sidecar");
    }
    return prepare.call(this, sql);
  };
  let result;
  try {
    result = await inspectSqliteInWorker(file, [
      { path: root, kind: "sqlite-home" },
    ]);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(injected, 1, "mutation hook must run inside the actual parser");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "SOURCE_CHANGED");
  assert.equal(result.metrics, undefined);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file, { bigint: true })).mtimeNs, stamp.mtimeNs);
  assert.equal(
    await fs.readFile(file + "-wal", "utf8"),
    "synthetic concurrent sidecar",
  );
});

test("audit: process becomes running after deep check, app view withholds metrics", async (t) => {
  const f = await fixture(t);
  const file = createDatabase(f.root);
  let checks = 0;
  const service = new AppDataServices(f.profile, {
    ...f.options,
    processCheck: async () => ({
      status: (++checks === 1 ? "clear" : "running") as "clear" | "running",
      details: "fixture",
    }),
  });
  await service.rememberDiagnosticRoot(f.root, "sqlite");
  const id = (await service.getAppData()).workspaces.entries[0].id;
  const result = await service.diagnose({
    workspaceIds: [id],
    configOptIn: false,
    deepCheck: { enabled: true, databasePath: file, confirmedClosed: true },
  });
  assert.equal(result.deepCheck.reason, "CODEX_RUNNING");
  assert.equal(result.deepCheck.metrics, undefined);
  assert.equal(checks, 2);
});

test("audit: process unknown blocks every database open even with explicit confirmation", async (t) => {
  const f = await fixture(t);
  const file = createDatabase(f.root);
  const service = new AppDataServices(f.profile, {
    ...f.options,
    processCheck: async () => ({ status: "unknown", details: "fixture" }),
  });
  await service.rememberDiagnosticRoot(f.root, "sqlite");
  const id = (await service.getAppData()).workspaces.entries[0].id;
  const prepare = DatabaseSync.prototype.prepare;
  let queries = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    queries++;
    return prepare.call(this, sql);
  };
  let result;
  try {
    result = await service.diagnose({
      workspaceIds: [id],
      configOptIn: false,
      deepCheck: { enabled: true, databasePath: file, confirmedClosed: true },
    });
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(queries, 0);
  assert.equal(result.deepCheck.reason, "PROCESS_UNKNOWN");
});

test("audit: external primary replacement blocks export and leaves destination nonexistent", async (t) => {
  const { base } = await fixture(t);
  const recovery = path.join(base, "recovery");
  const ring = new RecoveryKeyring(recovery);
  await ring.load();
  await fs.writeFile(
    path.join(recovery, "journal-signing.key"),
    randomBytes(32),
  );
  const output = path.join(base, "must-not-be-created.json");
  await assert.rejects(ring.exportFile(output), /已变化/);
  await assert.rejects(fs.lstat(output), { code: "ENOENT" });
});

test("audit: import failure after reading malformed bundle preserves keyring bytes", async (t) => {
  const { base } = await fixture(t);
  const recovery = path.join(base, "recovery");
  const ring = new RecoveryKeyring(recovery);
  await ring.load();
  const metadata = path.join(recovery, "trusted-recovery-keys.json");
  const before = await fs.readFile(metadata);
  const file = path.join(base, "malformed.json");
  const key = randomBytes(32);
  const invalid = JSON.parse(bundle([key]));
  invalid.keys[0].id = "0".repeat(64);
  await fs.writeFile(file, JSON.stringify(invalid));
  await assert.rejects(ring.importFile(file));
  assert.deepEqual(await fs.readFile(metadata), before);
  assert.equal(ring.describe().trustedKeyIds.length, 1);
});

test("audit: manifest-only authentication never permits restoring modified payload", async (t) => {
  const { root } = await fixture(t);
  const key = randomBytes(32);
  await fs.mkdir(path.join(root, "log"));
  const source = path.join(root, "log/codex-tui.log.1");
  await fs.writeFile(source, secret);
  const age = new Date(Date.now() - 80 * 86400000);
  await fs.utimes(source, age, age);
  const engine = new AgentVacEngine(root, key, true);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const operation = await engine.quarantine(preview.token, true);
  const h = (await engine.history())[0];
  const data = path.join(
    root,
    ".agentvac-quarantine",
    operation.batchId,
    h.items[0].id + ".data",
  );
  await fs.appendFile(data, " modified fixture");
  const info = await engine.inspectRecovery();
  assert.equal(info.batches[0].verified, true);
  assert.match(info.batches[0].explanation, /清单.*认证/);
  const restore = await engine.restore(operation.batchId, true);
  assert.equal(restore.completed, 0);
  assert.equal(restore.failed.length, 1);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
});

test("audit: authenticated ready-marker crash residue can be reset after restart", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = {
    ...f.options,
    trashItem: async (source: string) => {
      calls++;
      await fs.rename(source, path.join(f.base, "mock-ready-trash"));
    },
  };
  const service = new AppDataServices(f.profile, options);
  const rename = fs.rename;
  let residue: Buffer | undefined;
  let residueName = "";
  fs.rename = async (source: any, target: any) => {
    if (path.basename(String(source)).startsWith(".demo-ready-")) {
      residue = await fs.readFile(source);
      residueName = path.basename(String(source));
      throw new Error("injected interruption before ready marker commit");
    }
    return rename(source, target);
  };
  try {
    await assert.rejects(service.loadDemo(), /injected interruption/);
  } finally {
    fs.rename = rename;
  }
  assert.ok(residue);
  assert.ok(residueName);
  // Restore the exact authenticated temporary marker that a process crash could leave,
  // regardless of whether a caught in-process failure has already cleaned up its temp.
  await fs.writeFile(
    path.join(f.profile, "demo-workspace", residueName),
    residue,
  );
  const restarted = new AppDataServices(f.profile, options);
  assert.equal((await restarted.initialize()).demo.status, "preparing");
  const result = await restarted.resetDemo(true);
  assert.equal(calls, 1);
  assert.equal(result.demo, true);
  assert.equal((await restarted.getAppData()).demo.status, "ready");
});
