import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import {
  cursorConversationReader,
  cursorTranscriptReader,
} from "../electron/conversations/cursor.js";
import { withCursorSnapshot } from "../electron/conversations/cursor-snapshot.js";
import {
  initializeCursorSnapshotStorage,
  createCursorSnapshotDirectory,
  scavengeCursorSnapshotStorage,
  getCursorSnapshotStorageAvailability,
} from "../electron/conversations/cursor-temp.js";
import {
  cursorSnapshotAclIsPrivate,
  CURSOR_WINDOWS_ACL_POLICY,
} from "../electron/conversations/cursor-windows-acl.js";
import type {
  ConversationDescriptor,
  ConversationReader,
  ConversationReaderContext,
} from "../electron/conversations/types.js";

const REL = "User/globalStorage/state.vscdb";
const CREATED = 1780000000000;
// v0.2.0 deliberately disables the IDE database/private-copy path on Windows.
// Transcript reading, pure ACL parsing and fail-closed availability still apply.
const databaseTestOptions = {
  skip:
    process.platform === "win32"
      ? "v0.2.0 Windows Cursor IDE database reading and private snapshot storage are disabled"
      : false,
};
async function filesystemFixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-cursor-test-")),
  );
  const root = path.join(base, "Cursor");
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { root, base };
}
async function databaseFixture(
  t: { after(fn: () => Promise<void>): void },
  wal = false,
) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-cursor-test-")),
  );
  await initializeCursorSnapshotStorage(path.join(base, "snapshot-storage"));
  const root = path.join(base, "Cursor");
  await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
  const db = new DatabaseSync(path.join(root, REL));
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  db.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
  );
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
    "synthetic-auth-sentinel",
    "not-real-secret",
  );
  const put = (key: string, value: unknown) =>
    db
      .prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  put("composerData:conv-one", {
    composerId: "conv-one",
    name: "Fix preview 🧪",
    createdAt: CREATED,
    lastUpdatedAt: CREATED + 1000,
    fullConversationHeadersOnly: [
      { bubbleId: "bubble-two" },
      { bubbleId: "bubble-one" },
    ],
  });
  put("bubbleId:conv-one:bubble-two", {
    bubbleId: "bubble-two",
    type: 1,
    createdAt: "2026-05-28T20:00:00.000Z",
    text: "<script>window.pwned=true</script> Search 中文",
  });
  put("bubbleId:conv-one:bubble-one", {
    bubbleId: "bubble-one",
    type: 2,
    createdAt: "2026-05-28T20:00:01+00:00",
    text: "The answer",
    toolFormerData: { dangerous: "must-not-execute" },
  });
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await fs.rm(base, { recursive: true, force: true });
  });
  return { root, base, db, put };
}
async function list(
  reader: ConversationReader,
  context: ConversationReaderContext,
) {
  const result: ConversationDescriptor[] = [];
  for await (const item of reader.enumerate(context)) result.push(item);
  return result;
}
async function hashes(root: string) {
  const dir = path.join(root, "User/globalStorage");
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(dir)).sort().map(async (name) => [
        name,
        createHash("sha256")
          .update(await fs.readFile(path.join(dir, name)))
          .digest("hex"),
      ]),
    ),
  );
}

test(
  "Cursor SQLite metadata uses native title/times and referenced message order",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const before = await hashes(f.root);
    const records = await list(cursorConversationReader, { root: f.root });
    assert.equal(records.length, 1);
    assert.equal(records[0].summary.title, "Fix preview 🧪");
    assert.equal(records[0].summary.createdAt, new Date(CREATED).toISOString());
    assert.equal(records[0].summary.timeSource, "native");
    assert.equal(records[0].summary.messageCount, 2);
    const expectedBytes = f.db
      .prepare(
        "SELECT SUM(length(CAST(value AS BLOB))) AS bytes FROM cursorDiskKV",
      )
      .get()!.bytes;
    assert.equal(records[0].summary.sizeBytes, expectedBytes);
    assert.equal(records[0].summary.createdAtSource, "native");
    assert.ok(
      records[0].summary.warnings.some((w) => /reclaimable disk/.test(w)),
    );
    const page = await cursorConversationReader.read(
      { root: f.root },
      records[0],
      { limit: 1 },
    );
    assert.equal(page.messages[0].id, "bubble-two");
    assert.equal(page.messages[0].role, "user");
    assert.match(page.messages[0].parts[0].text, /<script>/);
    assert.equal(page.nextCursor, 1);
    const next = await cursorConversationReader.read(
      { root: f.root },
      records[0],
      { limit: 10, cursor: page.nextCursor },
    );
    assert.equal(next.messages[0].id, "bubble-one");
    assert.ok(next.warnings.some((w) => /Rich or tool/.test(w)));
    assert.deepEqual(await hashes(f.root), before);
  },
);

test(
  "Cursor snapshot preserves committed WAL-only content and source bytes",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t, true);
    const before = await hashes(f.root);
    assert.ok(Object.keys(before).includes("state.vscdb-wal"));
    const records = await list(cursorConversationReader, { root: f.root });
    assert.equal(records.length, 1);
    const page = await cursorConversationReader.read(
      { root: f.root },
      records[0],
      { limit: 100 },
    );
    assert.equal(page.messages.length, 2);
    assert.deepEqual(await hashes(f.root), before);
  },
);

test(
  "Cursor snapshots detect source edits and new WAL sidecars before publishing",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => {
        f.put("composerData:another", { composerId: "another" });
        return true;
      }),
      /changed|CHANGED/,
    );
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => {
        await fs.writeFile(path.join(f.root, REL + "-wal"), "synthetic");
        return true;
      }),
      /CHANGED/,
    );
  },
);

test(
  "Cursor stale descriptors fail after database change",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const records = await list(cursorConversationReader, { root: f.root });
    f.put("composerData:new", { composerId: "new" });
    await assert.rejects(
      cursorConversationReader.read({ root: f.root }, records[0], { limit: 5 }),
      /CHANGED/,
    );
  },
);

test(
  "Cursor native timestamp validation rejects rollover, seconds, and zoneless strings",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const invalid: unknown[] = [
      "2026-02-30T12:00:00Z",
      "2026-01-01T25:00:00Z",
      "2026-01-01T00:00:00",
      1780000000,
      -1,
      "2026-01-01T00:00:00+99:00",
    ];
    for (let i = 0; i < invalid.length; i++)
      f.put(`composerData:bad-${i}`, {
        composerId: `bad-${i}`,
        name: `Invalid time ${i}`,
        createdAt: invalid[i],
        fullConversationHeadersOnly: [],
      });
    const records = await list(cursorConversationReader, { root: f.root });
    for (const record of records.filter((r) => r.sourceKey.includes("bad-"))) {
      assert.equal(record.summary.createdAt, null);
      assert.equal(record.summary.updatedAt, null);
      assert.equal(record.summary.timeSource, "unknown");
    }
  },
);

test(
  "Cursor mismatched identities and unsupported schema fail closed",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    f.put("composerData:mismatch", {
      composerId: "different",
      name: "Should not be shown",
      fullConversationHeadersOnly: [],
    });
    const warnings: string[] = [];
    const records = await list(cursorConversationReader, {
      root: f.root,
      warn: (w) => warnings.push(w),
    });
    assert.equal(records.length, 1);
    assert.ok(warnings.some((w) => /identity mismatch/.test(w)));
    f.db.exec(
      "DROP TABLE cursorDiskKV; CREATE VIEW cursorDiskKV AS SELECT key, value FROM ItemTable",
    );
    assert.deepEqual(
      await list(cursorConversationReader, {
        root: f.root,
        warn: (w) => warnings.push(w),
      }),
      [],
    );
    assert.ok(warnings.some((w) => /not supported/.test(w)));
  },
);

test(
  "Cursor composite primary keys and multibyte oversize records cannot bypass schema/value bounds",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const warnings: string[] = [];
    f.put("composerData:large", {
      composerId: "large",
      name: "界".repeat(3 * 1024 * 1024),
      fullConversationHeadersOnly: [],
    });
    let records = await list(cursorConversationReader, {
      root: f.root,
      warn: (w) => warnings.push(w),
    });
    assert.equal(records.length, 1);
    assert.ok(warnings.some((w) => /oversized/.test(w)));
    f.db.exec(
      "DROP TABLE cursorDiskKV; CREATE TABLE cursorDiskKV (key TEXT, other TEXT, value TEXT, PRIMARY KEY(key, other))",
    );
    const insert = f.db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?, ?)");
    for (const other of ["one", "two"])
      insert.run(
        "composerData:shared",
        other,
        JSON.stringify({
          composerId: "shared",
          fullConversationHeadersOnly: [],
        }),
      );
    records = await list(cursorConversationReader, {
      root: f.root,
      warn: (w) => warnings.push(w),
    });
    assert.equal(records.length, 0);
    assert.ok(warnings.some((w) => /not supported/.test(w)));
  },
);

test(
  "Cursor request-local snapshots are reused then disposed without a persisted transcript cache",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const cache = new Map<string, unknown>();
    const cleanups: (() => Promise<void>)[] = [];
    const context = {
      root: f.root,
      cache,
      registerCleanup: (fn: () => Promise<void>) => cleanups.push(fn),
    };
    try {
      const records = await list(cursorConversationReader, context);
      assert.equal(cleanups.length, 1);
      await cursorConversationReader.read(context, records[0], { limit: 1 });
      await cursorConversationReader.read(context, records[0], {
        limit: 1,
        cursor: 1,
      });
      assert.equal(cleanups.length, 1);
      const snapshot = cache.get(`cursor-snapshot:${f.root}:${REL}`) as {
        path: string;
      };
      assert.ok((await fs.stat(snapshot.path)).isFile());
      for (const cleanup of cleanups) await cleanup();
      await assert.rejects(fs.stat(snapshot.path));
    } finally {
      for (const cleanup of cleanups) await cleanup();
    }
  },
);

test(
  "Cursor private snapshot storage keeps active leases and removes only verified dead-session copies",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const root = path.join(f.base, "snapshot-storage");
    const snapshot = await createCursorSnapshotDirectory();
    await fs.writeFile(path.join(snapshot, "state.vscdb"), "synthetic", {
      mode: 0o600,
    });
    const before = await scavengeCursorSnapshotStorage(root);
    assert.equal(before.removedSessions, 0);
    assert.ok(before.retainedSessions > 0);
    assert.ok((await fs.stat(snapshot)).isDirectory());
    assert.equal((await fs.stat(snapshot)).mode & 0o077, 0);
    assert.equal(
      (await fs.stat(path.join(snapshot, "state.vscdb"))).mode & 0o077,
      0,
    );
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const session = path.dirname(snapshot);
    const leasePath = path.join(session, "lease.json");
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
    lease.pid = child.pid;
    await fs.writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
    const after = await scavengeCursorSnapshotStorage(root);
    assert.equal(after.removedSessions, 1);
    await assert.rejects(fs.stat(session));
  },
);

test(
  "Cursor snapshot scavenger refuses unknown roots, linked files and unrecognized contents",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const root = path.join(f.base, "snapshot-storage");
    const unmarked = path.join(f.base, "unmarked");
    await fs.mkdir(unmarked, { mode: 0o700 });
    await assert.rejects(initializeCursorSnapshotStorage(unmarked));
    assert.equal(getCursorSnapshotStorageAvailability().available, false);
    await assert.rejects(createCursorSnapshotDirectory(), /UNAVAILABLE/);
    await initializeCursorSnapshotStorage(root);
    const snapshot = await createCursorSnapshotDirectory();
    const outside = path.join(f.base, "outside-data");
    await fs.writeFile(outside, "preserve");
    await fs.symlink(outside, path.join(snapshot, "state.vscdb"));
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const leasePath = path.join(path.dirname(snapshot), "lease.json");
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
    lease.pid = child.pid;
    await fs.writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
    const status = await scavengeCursorSnapshotStorage(root);
    assert.equal(status.removedSessions, 0);
    assert.ok(status.retainedSessions > 0);
    assert.equal(await fs.readFile(outside, "utf8"), "preserve");
    await fs.unlink(path.join(snapshot, "state.vscdb"));
    await fs.writeFile(path.join(snapshot, "not-app-owned.txt"), "preserve");
    assert.equal(
      (await scavengeCursorSnapshotStorage(root)).removedSessions,
      0,
    );
    assert.equal(
      await fs.readFile(path.join(snapshot, "not-app-owned.txt"), "utf8"),
      "preserve",
    );
  },
);

test("Cursor Windows ACL parser allows only verified owner/current-user/System/admin boundary", () => {
  const current = "S-1-5-21-100-200-300-1001";
  const ace = (sid: string, extra = {}) => ({
    sid,
    rights: 2032127,
    type: "allow",
    inherited: false,
    inheritance: 3,
    propagation: 0,
    ...extra,
  });
  const good = {
    currentUserSid: current,
    ownerSid: current,
    canonical: true,
    entries: [ace(current), ace("S-1-5-18"), ace("S-1-5-32-544")],
  };
  assert.equal(cursorSnapshotAclIsPrivate(good, true), true);
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [...good.entries, ace("S-1-1-0")] },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [...good.entries, ace("S-1-5-32-545")] },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, ownerSid: "S-1-5-21-9-9-9-1002" },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate({ ...good, canonical: false }, true),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [ace(current, { rights: "2032127" })] },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [ace(current, { propagation: 2 })] },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [ace(current, { inheritance: 0 })] },
      true,
    ),
    false,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [ace(current, { inheritance: 0 })] },
      false,
    ),
    true,
  );
  assert.equal(
    cursorSnapshotAclIsPrivate(
      { ...good, entries: [ace(current, { type: "deny" })] },
      true,
    ),
    false,
  );
  assert.equal(cursorSnapshotAclIsPrivate(null, true), false);
  assert.equal(
    CURSOR_WINDOWS_ACL_POLICY,
    "runtime-read-only-allowlist-v1",
    "Every Windows target requires actual runtime ACL validation.",
  );
});

test("Cursor private storage failures expose only stable codes, never profile paths", async (t) => {
  const f = await filesystemFixture(t);
  const privatePath = path.join(
    f.base,
    "private-profile-name",
    "missing-snapshot-root",
  );
  await assert.rejects(
    initializeCursorSnapshotStorage(privatePath),
    (error: Error) => {
      assert.equal(
        error.message,
        "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE",
      );
      assert.ok(!error.message.includes("private-profile-name"));
      return true;
    },
  );
  assert.equal(getCursorSnapshotStorageAvailability().available, false);
  await assert.rejects(
    withCursorSnapshot(f.root, REL, undefined, async () => true),
    /PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE/,
  );
});

test(
  "Cursor cumulative request quota fails before copy and reports partial coverage",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const cache = new Map<string, unknown>([
      ["cursor-snapshot-bytes", 512 * 1024 * 1024 - 1],
    ]);
    const warnings: string[] = [],
      codes: (string | undefined)[] = [],
      cleanups: (() => Promise<void>)[] = [];
    const before = await hashes(f.root);
    const records = await list(cursorConversationReader, {
      root: f.root,
      cache,
      registerCleanup: (fn) => cleanups.push(fn),
      warn: (w, code) => {
        warnings.push(w);
        codes.push(code);
      },
    });
    assert.equal(records.length, 0);
    assert.equal(cleanups.length, 0);
    assert.ok(warnings.some((w) => /512 MiB/.test(w)));
    assert.ok(codes.includes("SNAPSHOT_LIMIT"));
    assert.deepEqual(await hashes(f.root), before);
  },
);

test(
  "Cursor no-space and post-copy cancellation leave no snapshot payloads",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const before = await hashes(f.root);
    const statfs = fs.statfs;
    try {
      Object.defineProperty(fs, "statfs", {
        value: async () => ({ bavail: 0, bsize: 4096 }),
        configurable: true,
      });
      await assert.rejects(
        withCursorSnapshot(f.root, REL, undefined, async () => true),
        /NO_SPACE/,
      );
    } finally {
      Object.defineProperty(fs, "statfs", {
        value: statfs,
        configurable: true,
      });
    }
    const abort = new AbortController();
    await assert.rejects(
      withCursorSnapshot(f.root, REL, abort.signal, async () => {
        abort.abort();
        return true;
      }),
      /cancelled/,
    );
    const storage = path.join(f.base, "snapshot-storage");
    for (const session of (await fs.readdir(storage)).filter((n) =>
      n.startsWith("session-"),
    ))
      assert.deepEqual(await fs.readdir(path.join(storage, session)), [
        "lease.json",
      ]);
    assert.deepEqual(await hashes(f.root), before);
  },
);

test(
  "Cursor missing and duplicate bubble references are explicit, never stitched by guessed order",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    f.put("composerData:missing", {
      composerId: "missing",
      fullConversationHeadersOnly: [{ bubbleId: "absent" }],
    });
    f.put("composerData:duplicate", {
      composerId: "duplicate",
      fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "a" }],
    });
    const records = await list(cursorConversationReader, { root: f.root });
    assert.equal(
      records.find((r) => r.sourceKey.endsWith(":duplicate"))!.summary
        .messageCount,
      null,
    );
    const page = await cursorConversationReader.read(
      { root: f.root },
      records.find((r) => r.sourceKey.endsWith(":missing"))!,
      { limit: 5 },
    );
    assert.equal(page.messages[0].parts[0].type, "notice");
    assert.equal(page.partial, true);
    await assert.rejects(
      cursorConversationReader.read(
        { root: f.root },
        records.find((r) => r.sourceKey.endsWith(":duplicate"))!,
        { limit: 5 },
      ),
      /UNSUPPORTED_MESSAGE_LAYOUT/,
    );
  },
);

test(
  "Cursor long SQLite messages continue without clipping or splitting Unicode",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const body =
      "a".repeat(65535) + "🧪" + "b".repeat(70000) + "ONLY_AT_THE_END";
    f.put("bubbleId:conv-one:bubble-two", {
      bubbleId: "bubble-two",
      type: 1,
      text: body,
    });
    const record = (await list(cursorConversationReader, { root: f.root }))[0];
    let cursor: unknown = undefined,
      rebuilt = "";
    const ids = new Set<string>();
    let pages = 0;
    do {
      const page = await cursorConversationReader.read(
        { root: f.root },
        record,
        {
          limit: 1,
          cursor,
        },
      );
      const message = page.messages[0];
      if (message.role !== "user") break;
      assert.ok(!ids.has(message.id));
      ids.add(message.id);
      const text = message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      assert.doesNotMatch(text, /[\uD800-\uDBFF]$/);
      rebuilt += text;
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    assert.equal(rebuilt, body);
    assert.equal(pages, 3);
    await assert.rejects(
      cursorConversationReader.read({ root: f.root }, record, {
        limit: 1,
        cursor: { index: "0", textOffset: 5 },
      }),
      /INVALID_CURSOR/,
    );
  },
);

test(
  "Cursor rollback journals, symlinks, hardlinks, cancellation and oversized databases are refused",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      withCursorSnapshot(f.root, REL, abort.signal, async () => true),
      /cancelled/,
    );
    await fs.writeFile(path.join(f.root, REL + "-journal"), "pending");
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => true),
      /JOURNAL/,
    );
    await fs.rm(path.join(f.root, REL + "-journal"));
    await fs.link(path.join(f.root, REL), path.join(f.base, "hardlink"));
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => true),
      /unsafe/,
    );
    await fs.rm(path.join(f.base, "hardlink"));
    await fs.symlink(
      path.join(f.base, "missing-target"),
      path.join(f.root, REL + "-shm"),
    );
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => true),
      /unsafe/,
    );
    await fs.rm(path.join(f.root, REL + "-shm"));
    f.db.close();
    await fs.truncate(path.join(f.root, REL), 512 * 1024 * 1024 + 1);
    await assert.rejects(
      withCursorSnapshot(f.root, REL, undefined, async () => true),
      /SIZE_LIMIT/,
    );
  },
);

test(
  "Cursor workspace project URI is literal metadata and header-only rows remain incomplete",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const workspace = path.join(f.root, "User/workspaceStorage/abc123");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "workspace.json"),
      JSON.stringify({ folder: "vscode-remote://ssh-remote+host/work/repo" }),
    );
    const db = new DatabaseSync(path.join(workspace, "state.vscdb"));
    db.exec(
      "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)",
    );
    db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run(
      "header-only",
      JSON.stringify({
        composerId: "header-only",
        name: "Archived source",
        createdAt: CREATED,
        isArchived: true,
      }),
    );
    db.close();
    const records = await list(cursorConversationReader, { root: f.root });
    const row = records.find((r) => r.sourceKey.endsWith(":header-only"))!;
    assert.equal(
      row.summary.project,
      "vscode-remote://ssh-remote+host/work/repo",
    );
    assert.equal(row.summary.identityVerified, false);
    assert.equal(row.summary.messageCount, null);
    assert.ok(row.summary.warnings.some((w) => /index entry/.test(w)));
  },
);

test(
  "Cursor global conversations join project metadata only by exact workspace-index identity",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const workspace = path.join(f.root, "User/workspaceStorage/project-one");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "workspace.json"),
      JSON.stringify({ folder: "file:///synthetic/project-one" }),
    );
    let db = new DatabaseSync(path.join(workspace, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "conv-one" }] }),
    );
    db.close();
    let records = await list(cursorConversationReader, { root: f.root });
    assert.equal(records.length, 1);
    assert.equal(records[0].summary.project, "file:///synthetic/project-one");
    const second = path.join(f.root, "User/workspaceStorage/project-two");
    await fs.mkdir(second);
    await fs.writeFile(
      path.join(second, "workspace.json"),
      JSON.stringify({ folder: "file:///synthetic/project-two" }),
    );
    db = new DatabaseSync(path.join(second, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "conv-one" }] }),
    );
    db.close();
    records = await list(cursorConversationReader, { root: f.root });
    assert.equal(records[0].summary.project, null);
    assert.ok(
      records[0].summary.warnings.some((w) => /multiple projects/.test(w)),
    );
  },
);

test("Cursor selected native transcript reads content without inventing time/project/tool output", async (t) => {
  const f = await filesystemFixture(t);
  const root = path.join(f.base, "agent-transcripts");
  await fs.mkdir(path.join(root, "session-one"), { recursive: true });
  const rows = [
    {
      role: "user",
      message: {
        content: [{ type: "text", text: "Find the <img src=x> bug" }],
      },
    },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking now" },
          {
            type: "tool_use",
            name: "Shell",
            input: { command: "do not run this" },
          },
        ],
      },
    },
    {
      role: "assistant",
      message: {
        content: [
          { type: "image", source: { url: "https://example.invalid/private" } },
        ],
      },
    },
  ];
  const file = path.join(root, "session-one/session-one.jsonl");
  await fs.writeFile(
    file,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const records = await list(cursorTranscriptReader, { root });
  assert.equal(records.length, 1);
  assert.equal(records[0].summary.titleSource, "first-user-message");
  assert.equal(records[0].summary.createdAt, null);
  assert.equal(records[0].summary.project, null);
  const page = await cursorTranscriptReader.read({ root }, records[0], {
    limit: 1,
  });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].timestamp, null);
  let nextCursor = page.nextCursor;
  const remaining = [];
  while (nextCursor !== null) {
    const next = await cursorTranscriptReader.read({ root }, records[0], {
      limit: 10,
      cursor: nextCursor,
    });
    remaining.push(...next.messages);
    nextCursor = next.nextCursor;
    assert.ok(next.warnings.some((w) => /omit tool outputs/.test(w)));
  }
  assert.ok(remaining.some((m) => m.parts.some((p) => p.type === "tool-call")));
  assert.ok(remaining.some((m) => m.parts[0].type === "notice"));
  await assert.rejects(
    cursorTranscriptReader.read({ root }, records[0], { cursor: 2, limit: 1 }),
    /INVALID_CURSOR/,
  );
  await fs.appendFile(file, "{}\n");
  await assert.rejects(
    cursorTranscriptReader.read({ root }, records[0], { limit: 1 }),
    /CHANGED/,
  );
  await assert.rejects(
    list(cursorTranscriptReader, { root: f.root }),
    /EXPLICIT_TRANSCRIPT_ROOT/,
  );
});

test("Cursor transcript malformed and rich records are partial and literal", async (t) => {
  const f = await filesystemFixture(t);
  const root = path.join(f.base, "agent-transcripts");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "flat.jsonl"),
    "{bad}\n" +
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
  );
  const records = await list(cursorTranscriptReader, { root });
  assert.equal(records[0].summary.messageCount, null);
  const page = await cursorTranscriptReader.read({ root }, records[0], {
    limit: 20,
  });
  assert.equal(page.messages.length, 1);
  assert.equal(page.partial, true);
  assert.equal(page.nextCursor, null);
});

test("Cursor linked directory ancestors are rejected before transcript enumeration", async (t) => {
  const f = await filesystemFixture(t);
  const elsewhere = path.join(f.base, "elsewhere");
  await fs.mkdir(path.join(elsewhere, "agent-transcripts"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(elsewhere, "agent-transcripts/outside.jsonl"),
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "outside-selected-root" }] },
    }) + "\n",
  );
  const linked = path.join(f.base, "linked-parent");
  // A directory junction needs no Windows symlink privilege and is still an
  // unsafe linked ancestor that the transcript reader must reject.
  await fs.symlink(
    elsewhere,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    list(cursorTranscriptReader, {
      root: path.join(linked, "agent-transcripts"),
    }),
    /UNSAFE_DIRECTORY/,
  );
});

test(
  "Cursor linked directory ancestors are rejected before workspace enumeration",
  databaseTestOptions,
  async (t) => {
    const f = await databaseFixture(t);
    const elsewhere = path.join(f.base, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(f.root, "User/workspaceStorage"));
    const warnings: string[] = [];
    const records = await list(cursorConversationReader, {
      root: f.root,
      warn: (w) => warnings.push(w),
    });
    assert.equal(records.length, 1);
    assert.ok(warnings.some((w) => /directories.*safely/.test(w)));
  },
);

test("Cursor long transcript text and tool input remain reachable via stable continuation", async (t) => {
  const f = await filesystemFixture(t);
  const root = path.join(f.base, "agent-transcripts");
  await fs.mkdir(root);
  const body =
    "x".repeat(32767) + "🧪" + "z".repeat(70000) + "TAIL_SEARCH_SENTINEL";
  await fs.writeFile(
    path.join(root, "long.jsonl"),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: body },
          {
            type: "tool_use",
            name: "Shell",
            input: { command: "c".repeat(20000) + "TOOL_TAIL" },
          },
        ],
      },
    }) + "\n",
  );
  const record = (await list(cursorTranscriptReader, { root }))[0];
  let cursor: unknown = undefined,
    rebuilt = "",
    tool = "",
    pages = 0;
  do {
    const page = await cursorTranscriptReader.read({ root }, record, {
      limit: 1,
      cursor,
    });
    assert.equal(page.messages.length, 1);
    assert.ok(page.messages[0].continuation);
    rebuilt += page.messages[0].parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    tool += page.messages[0].parts
      .filter((p) => p.type === "tool-call")
      .map((p) => p.text)
      .join("");
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null && pages < 10);
  assert.equal(rebuilt, body);
  assert.match(tool, /TOOL_TAIL/);
  assert.ok(pages > 3);
});

test("Cursor deeply nested tool input degrades to an explicit partial notice", async (t) => {
  const f = await filesystemFixture(t);
  const root = path.join(f.base, "agent-transcripts");
  await fs.mkdir(root);
  const nested = "[".repeat(20000) + "0" + "]".repeat(20000);
  await fs.writeFile(
    path.join(root, "nested.jsonl"),
    '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"NeverExecute","input":' +
      nested +
      "}]}}\n",
  );
  const record = (await list(cursorTranscriptReader, { root }))[0];
  const page = await cursorTranscriptReader.read({ root }, record, {
    limit: 10,
  });
  assert.equal(page.partial, true);
  assert.ok(
    page.messages.some((m) =>
      m.parts.some((p) => p.type === "notice" && /nesting/.test(p.text)),
    ),
  );
});
