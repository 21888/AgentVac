import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  diagnoseStorage,
  discoverDiagnosticCandidates,
  diagnosticFileKey,
} from "../electron/diagnostics.js";
import type {
  DiagnosticRoot,
  StorageDiagnosticOptions,
} from "../electron/diagnostics.js";

const SECRET = "synthetic-do-not-disclose-credential-9a829f";
const LOG_DDL = `
CREATE TABLE logs (
id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT,
file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL,
checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);
CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_thread_id ON logs(thread_id);
CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;
`;

async function fixture(t: any) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-diagnostics-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root: string, rel: string, content = SECRET) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
}
async function snapshot(root: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  async function walk(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const p = path.join(dir, name),
        rel = path.relative(root, p);
      const s = await fs.lstat(p, { bigint: true });
      if (s.isSymbolicLink())
        out[rel] = { link: await fs.readlink(p), mtime: String(s.mtimeNs) };
      else if (s.isDirectory()) {
        out[rel] = { directory: true, mtime: String(s.mtimeNs) };
        await walk(p);
      } else
        out[rel] = {
          size: String(s.size),
          mtime: String(s.mtimeNs),
          ctime: String(s.ctimeNs),
          hash: createHash("sha256")
            .update(await fs.readFile(p))
            .digest("hex"),
        };
    }
  }
  await walk(root);
  return out;
}
async function unchanged(root: string, opts: StorageDiagnosticOptions) {
  const before = await snapshot(root);
  const result = await diagnoseStorage(opts);
  assert.deepEqual(
    await snapshot(root),
    before,
    "diagnosis must not change bytes, mtime, ctime, or sidecar presence",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(SECRET),
    "no config/log/database secret in serialized output",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    result,
    "IPC result is JSON-safe",
  );
  return result;
}
const selected = (
  root: string,
  kind: DiagnosticRoot["kind"] = "codex-home",
): DiagnosticRoot[] => [{ path: root, kind }];
const deep = (
  root: string,
  name = "logs_2.sqlite",
): StorageDiagnosticOptions => ({
  roots: selected(root),
  deepCheck: { enabled: true, databasePath: path.join(root, name) },
});
function database(
  root: string,
  mode: "none" | "full" | "incremental" = "incremental",
  wal = false,
) {
  const p = path.join(root, "logs_2.sqlite");
  const db = new DatabaseSync(p);
  db.exec(`PRAGMA auto_vacuum=${mode};`);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(LOG_DDL);
  db.prepare(
    "INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body,estimated_bytes) VALUES(0,0,'INFO','fixture',?,?)",
  ).run(SECRET, SECRET.length);
  return db;
}

test("candidate discovery uses only injected home/env/cwd and never probes them", () => {
  const home = path.resolve("/nonexistent-fixture-home"),
    cwd = path.resolve("/nonexistent-fixture-cwd");
  const candidates = discoverDiagnosticCandidates({
    home,
    cwd,
    env: {
      CODEX_HOME: "relative-codex",
      CODEX_SQLITE_HOME: path.join(home, "sqlite"),
      API_KEY: SECRET,
    },
  });
  assert.deepEqual(candidates, [
    { path: path.join(home, ".codex"), kind: "codex-home", source: "default" },
    {
      path: path.join(cwd, "relative-codex"),
      kind: "codex-home",
      source: "CODEX_HOME",
    },
    {
      path: path.join(home, "sqlite"),
      kind: "sqlite-home",
      source: "CODEX_SQLITE_HOME",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(candidates), new RegExp(SECRET));
  assert.equal(
    discoverDiagnosticCandidates({
      home,
      env: { CODEX_HOME: "relative", CODEX_SQLITE_HOME: "bad\npath" },
    }).length,
    1,
  );
});

test("file identity prefers reliable dev/inode; Windows fallback folds case and normalizes paths", () => {
  assert.equal(
    diagnosticFileKey(
      "C:\\data\\logs_2.sqlite",
      { dev: "5", ino: "99" },
      "win32",
    ),
    diagnosticFileKey(
      "C:\\DATA\\logs_2.sqlite",
      { dev: "5", ino: "99" },
      "win32",
    ),
  );
  assert.notEqual(
    diagnosticFileKey(
      "C:\\data\\logs_2.sqlite",
      { dev: "5", ino: "99" },
      "win32",
    ),
    diagnosticFileKey(
      "C:\\DATA\\logs_2.sqlite",
      { dev: "5", ino: "100" },
      "win32",
    ),
  );
  assert.equal(
    diagnosticFileKey(
      "C:\\data\\.\\logs_2.sqlite",
      { dev: "0", ino: "0" },
      "win32",
    ),
    diagnosticFileKey("c:/DATA/logs_2.sqlite", {}, "win32"),
  );
  assert.notEqual(
    diagnosticFileKey("/fixture/A/logs_2.sqlite", {}, "linux"),
    diagnosticFileKey("/fixture/a/logs_2.sqlite", {}, "linux"),
  );
});

test("overlapping Codex, SQLite, and ordinary-log roots count each physical file once", async (t) => {
  const root = await fixture(t);
  await write(root, "logs_2.sqlite", "fake-database");
  await write(root, "logs_2.sqlite-wal", "fake-wal");
  await write(root, "log/codex-tui.log", SECRET);
  const result = await unchanged(root, {
    roots: [
      ...selected(root),
      ...selected(root, "sqlite-home"),
      ...selected(path.join(root, "log"), "log-dir"),
      ...selected(root),
    ],
  });
  assert.equal(result.files.length, 3);
  assert.equal(result.totals.sqlite, 13);
  assert.equal(result.totals.wal, 8);
  assert.equal(result.totals["ordinary-log"], SECRET.length);
});

test("metadata separates SQLite/WAL/SHM/journal/plain logs, never traverses sessions", async (t) => {
  const root = await fixture(t);
  await write(root, "logs_2.sqlite", "sqlite-fixture");
  await write(root, "logs_2.sqlite-wal", "wal");
  await write(root, "logs_2.sqlite-shm", "shm");
  await write(root, "state_5.sqlite-journal", "journal");
  await write(root, "log/codex-tui.log");
  await write(root, "log/codex-tui.log.1.gz");
  await write(root, "sessions/never-read.jsonl");
  await write(root, "auth.json");
  await write(root, "config.toml", `api_key = "${SECRET}"`);
  const result = await unchanged(root, { roots: selected(root) });
  assert.equal(result.files.length, 6);
  assert.equal(result.totals.sqlite, 14);
  assert.equal(result.totals.wal, 3);
  assert.equal(result.totals.shm, 3);
  assert.equal(result.totals.journal, 7);
  assert.equal(result.totals["ordinary-log"], SECRET.length * 2);
  assert.equal(result.volumes[0].observational, true);
  assert.equal(typeof result.volumes[0].availableBytes, "number");
  assert.equal(result.deepCheck.status, "disabled");
  assert.deepEqual(result.configHints, []);
});

test("strict opt-ins, top-level config hints only, external hint is not scanned", async (t) => {
  const root = await fixture(t),
    external = await fixture(t);
  await write(external, "logs_2.sqlite");
  await write(
    root,
    "config.toml",
    `api_key = "${SECRET}"\nsqlite_home = ${JSON.stringify(external)}\nlog_dir = '${path.join(external, "logs")}'\n[projects.fixture]\nsecret = "${SECRET}"\nsqlite_home = "/must-not-select-section-value"\n`,
  );
  const disabled = await unchanged(root, {
    roots: selected(root),
    configOptIn: "true" as unknown as boolean,
    deepCheck: {
      enabled: "true" as unknown as boolean,
      databasePath: path.join(root, "logs_2.sqlite"),
    },
  });
  assert.deepEqual(disabled.configHints, []);
  assert.equal(disabled.deepCheck.status, "disabled");
  const beforeExternal = await snapshot(external);
  const result = await unchanged(root, {
    roots: selected(root),
    configOptIn: true,
  });
  assert.equal(result.configHints.length, 2);
  assert.equal(result.configHints[0].path, external);
  assert.equal(result.files.length, 0);
  assert.deepEqual(await snapshot(external), beforeExternal);
});

test("complex TOML, profiles and multiline embedded fake keys fail closed", async (t) => {
  const root = await fixture(t);
  for (const content of [
    `note = '''\nsqlite_home = "/do-not-infer"\n${SECRET}\n'''`,
    `sqlite_home = "/possible"\n[profiles.x]\nmodel = "${SECRET}"`,
    `sqlite_home = "/possible"\n["profiles"."x"]\nmodel = "${SECRET}"`,
    `profile = "x"\nsqlite_home = "/possible"\nsecret = "${SECRET}"`,
    `sqlite_home = "/one"\nsqlite_home = "/two"\nsecret = "${SECRET}"`,
  ]) {
    await write(root, "config.toml", content);
    const result = await unchanged(root, {
      roots: selected(root),
      configOptIn: true,
    });
    assert.deepEqual(result.configHints, []);
    assert.ok(result.warnings.includes("CONFIG_FORMAT_UNSUPPORTED"));
  }
});

test("unsupported relative config, oversized config and malformed values never echo data", async (t) => {
  const root = await fixture(t);
  for (const [value, warning] of [
    [
      `sqlite_home = "relative"\nsecret = "${SECRET}"`,
      "CONFIG_PATH_UNSUPPORTED",
    ],
    [`sqlite_home = "unterminated-${SECRET}`, "CONFIG_FORMAT_UNSUPPORTED"],
    [SECRET.repeat(3000), "CONFIG_TOO_LARGE"],
  ]) {
    await write(root, "config.toml", value);
    const result = await unchanged(root, {
      roots: selected(root),
      configOptIn: true,
    });
    assert.deepEqual(result.configHints, []);
    assert.ok(result.warnings.includes(warning as any));
  }
});

test("only explicit selected directories are accessed; state and outside DB deep checks refused", async (t) => {
  const root = await fixture(t);
  await write(root, "state_5.sqlite");
  let result = await unchanged(root, deep(root, "state_5.sqlite"));
  assert.equal(result.deepCheck.reason, "NOT_LOGS_DATABASE");
  result = await unchanged(root, {
    roots: [],
    deepCheck: {
      enabled: true,
      databasePath: path.join(root, "logs_2.sqlite"),
    },
  });
  assert.equal(result.deepCheck.reason, "OUTSIDE_SELECTED_ROOTS");
  result = await unchanged(root, {
    roots: [{ path: "relative", kind: "codex-home" }],
  });
  assert.deepEqual(result.warnings, ["INVALID_ROOT"]);
});

test("known closed schemas report PRAGMA metrics without reading log bodies or altering bytes", async (t) => {
  for (const mode of ["none", "full", "incremental"] as const) {
    const root = await fixture(t),
      db = database(root, mode);
    db.exec(
      "INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body) VALUES(0,0,'INFO','fixture',zeroblob(131072)); DELETE FROM logs WHERE id=2;",
    );
    db.close();
    const result = await unchanged(root, deep(root));
    assert.equal(
      result.deepCheck.status,
      "ok",
      JSON.stringify(result.deepCheck),
    );
    assert.equal(result.deepCheck.schema, "codex-logs-v2");
    assert.equal(result.deepCheck.metrics?.autoVacuum, mode);
    assert.equal(result.deepCheck.sourceUnchanged, true);
    assert.ok((result.deepCheck.metrics?.pageCount ?? 0) > 0);
    if (mode !== "full")
      assert.ok((result.deepCheck.metrics?.freePageBytes ?? 0) > 0);
  }
});

test("closed WAL-header database uses immutable URI and creates no WAL or SHM", async (t) => {
  const root = await fixture(t),
    db = database(root, "incremental", true);
  db.close();
  assert.deepEqual(await fs.readdir(root), ["logs_2.sqlite"]);
  const result = await unchanged(root, deep(root));
  assert.equal(result.deepCheck.status, "ok", JSON.stringify(result.deepCheck));
  assert.equal(result.deepCheck.metrics?.journalMode, "wal");
  assert.deepEqual(await fs.readdir(root), ["logs_2.sqlite"]);
});

test("live WAL writer and stale or empty sidecars are blocked with every source byte preserved", async (t) => {
  const root = await fixture(t),
    db = database(root, "incremental", true);
  try {
    const result = await unchanged(root, deep(root));
    assert.equal(result.deepCheck.reason, "SIDECARS_PRESENT");
  } finally {
    db.close();
  }
  for (const [suffix, content] of [
    ["-wal", SECRET],
    ["-wal", ""],
    ["-shm", SECRET],
    ["-journal", SECRET],
  ]) {
    await write(root, `logs_2.sqlite${suffix}`, content);
    const result = await unchanged(root, deep(root));
    assert.equal(result.deepCheck.reason, "SIDECARS_PRESENT");
    await fs.unlink(path.join(root, `logs_2.sqlite${suffix}`));
  }
});

test("unknown schema and corrupt DB are blocked without leaking SQL, comments or log bodies", async (t) => {
  const root = await fixture(t),
    db = database(root);
  db.exec(`CREATE TABLE unexpected(secret TEXT DEFAULT '${SECRET}');`);
  db.close();
  let result = await unchanged(root, deep(root));
  assert.equal(result.deepCheck.reason, "UNKNOWN_SCHEMA");
  await fs.writeFile(path.join(root, "logs_2.sqlite"), SECRET);
  result = await unchanged(root, deep(root));
  assert.equal(result.deepCheck.reason, "NOT_SQLITE");
});

test("source changed during stability window returns blocked and diagnosis adds no changes", async (t) => {
  const root = await fixture(t),
    db = database(root);
  db.close();
  const p = path.join(root, "logs_2.sqlite");
  // Deterministically mutate after the main-process identity observation rather
  // than assuming child startup or filesystem timing on another OS.
  const lstat = fs.lstat;
  let observations = 0;
  let externallyChanged: Awaited<ReturnType<typeof snapshot>> | undefined;
  fs.lstat = (async (file: any, ...args: any[]) => {
    const stat = await (lstat as any)(file, ...args);
    if (file === p && ++observations === 4) {
      await fs.utimes(
        p,
        new Date(Date.now() + 5000),
        new Date(Date.now() + 5000),
      );
      externallyChanged = await snapshot(root);
    }
    return stat;
  }) as typeof fs.lstat;
  let result;
  try {
    result = await diagnoseStorage(deep(root));
  } finally {
    fs.lstat = lstat;
  }
  assert.ok(
    externallyChanged,
    "synthetic concurrent mutation must actually occur",
  );
  assert.equal(result.deepCheck.reason, "SOURCE_CHANGED");
  assert.deepEqual(await snapshot(root), externallyChanged);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("symlink/hardlink roots, DBs, logs and config are never followed", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  const db = database(outside);
  db.close();
  await write(outside, "secret-config", `sqlite_home="/${SECRET}"`);
  try {
    await fs.symlink(
      path.join(outside, "logs_2.sqlite"),
      path.join(root, "logs_2.sqlite"),
    );
    await fs.symlink(
      path.join(outside, "secret-config"),
      path.join(root, "config.toml"),
    );
    await fs.symlink(outside, path.join(root, "log"));
  } catch (e) {
    if (
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("symlink privilege unavailable");
      return;
    }
    throw e;
  }
  const outsideBefore = await snapshot(outside);
  const result = await unchanged(root, { ...deep(root), configOptIn: true });
  assert.equal(result.deepCheck.reason, "UNSAFE_PATH");
  assert.deepEqual(result.configHints, []);
  assert.deepEqual(await snapshot(outside), outsideBefore);
  await fs.unlink(path.join(root, "logs_2.sqlite"));
  await fs.link(
    path.join(outside, "logs_2.sqlite"),
    path.join(root, "logs_2.sqlite"),
  );
  const linkedBefore = await snapshot(outside);
  const linked = await unchanged(root, deep(root));
  assert.equal(linked.deepCheck.reason, "UNSAFE_PATH");
  assert.deepEqual(await snapshot(outside), linkedBefore);
});
