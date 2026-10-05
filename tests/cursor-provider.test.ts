import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { unitFingerprint } from "../electron/cleanup-units.js";
import { AgentVacEngine } from "../electron/engine.js";
import type { ProcessStatus } from "../shared/types.js";
import { cursorAdapter as adapter } from "../electron/providers/cursor.js";

const OLD = "20240101T123456";
const NEXT = "20240202T123456";

async function fixture(t: TestContext, name = "Cursor") {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-cursor-fixture-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, name);
  await fs.mkdir(path.join(root, "User", "globalStorage"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  return { root, base };
}

async function symlink(
  t: TestContext,
  target: string,
  link: string,
  directory = false,
) {
  try {
    await fs.symlink(target, link, directory ? "junction" : "file");
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Windows symlink privilege unavailable; not verified");
      return false;
    }
    throw error;
  }
}

test("Cursor discovery uses platform path syntax and documented app-data roots", () => {
  assert.equal(
    adapter.discover({ home: "/Users/test", env: {}, platform: "darwin" })[0]
      .path,
    "/Users/test/Library/Application Support/Cursor",
  );
  assert.equal(
    adapter.discover({ home: "C:\\Users\\test", env: {}, platform: "win32" })[0]
      .path,
    "C:\\Users\\test\\AppData\\Roaming\\Cursor",
  );
  assert.equal(
    adapter.discover({
      home: "C:\\Users\\test",
      env: { APPDATA: "D:\\Roaming" },
      platform: "win32",
    })[0].path,
    "D:\\Roaming\\Cursor",
  );
  assert.equal(
    adapter.discover({
      home: "/home/test",
      env: {
        CURSOR_CONFIG_DIR: "/cli",
        XDG_CONFIG_HOME: "/cli-xdg",
        CURSOR_USER_DATA_DIR: "/unverified",
      },
      platform: "linux",
    })[0].path,
    "/home/test/.config/Cursor",
  );
  assert.equal(
    adapter.discover({ home: "relative", env: {}, platform: "linux" }).length,
    0,
  );
  assert.equal(
    adapter.discover({ home: "/home/test", env: {}, platform: "freebsd" })
      .length,
    0,
  );
  assert.equal(
    adapter.discover({
      home: "C:\\Users\\test",
      env: { APPDATA: "relative" },
      platform: "win32",
    })[0].path,
    "C:\\Users\\test\\AppData\\Roaming\\Cursor",
  );
});

test("Cursor allows only explicitly verified main and renderer diagnostic filenames", () => {
  for (const rel of [
    `logs/${OLD}/main.log`,
    `logs/${OLD}/renderer.log`,
    `logs/${OLD}/window1/renderer.log`,
    `logs/${OLD}/window2_wb0/renderer.log`,
  ]) {
    assert.equal(adapter.classify(rel).risk, "safe", rel);
    assert.equal(adapter.classify(rel).category, "log", rel);
  }
  for (const rel of [
    `logs/${OLD}/anything.log`,
    `logs/${OLD}/main.log.1`,
    `logs/${OLD}/main.log.gz`,
    `logs/${OLD}/main.log.sqlite`,
    `logs/${OLD}/main.LOG`,
    `logs/${OLD}/state.vscdb`,
    `logs/${OLD}/window1/not-renderer.log`,
    `logs/${OLD}/window0/renderer.log`,
    `logs/${OLD}/window1_wb0/exthost/exthost.log`,
    `logs/${OLD}/window1/output_logging_1/chat.log`,
    "logs/main.log",
    "logs/20240230T120000/main.log",
    "logs/20240101T250000/main.log",
    "logs/20240101/main.log",
    "logs/20240101T120000Z/main.log",
    "logs/2024-01-01/main.log",
  ])
    assert.equal(adapter.classify(rel).risk, "protected", rel);
});

test("Cursor protects current/future timestamp folders even with an old file mtime", () => {
  const now = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .slice(0, 15);
  assert.equal(adapter.classify(`logs/${now}/main.log`).risk, "protected");
  assert.equal(
    adapter.classify("logs/20991231T235959/main.log").risk,
    "protected",
  );
});

test("Cursor never traverses profiles, chat state, extensions, caches or unknown log subtrees", () => {
  for (const rel of [
    "logs",
    `logs/${OLD}`,
    `logs/${OLD}/window1`,
    `logs/${OLD}/window2_wb0`,
  ])
    assert.equal(adapter.canTraverse(rel), true, rel);
  for (const rel of [
    "User",
    "User/profiles",
    "User/globalStorage",
    "User/workspaceStorage",
    "User/History",
    ".cursor",
    "extensions",
    "Cache",
    "CachedData",
    "GPUCache",
    "Code Cache",
    "Local Storage",
    "IndexedDB",
    "logs/latest",
    `logs/${OLD}/exthost`,
    `logs/${OLD}/window1/exthost`,
    `logs/${OLD}/window1/output_logging_1`,
    `logs/${OLD}/workspaceStorage`,
    "logs/20240230T120000",
  ])
    assert.equal(adapter.canTraverse(rel), false, rel);
  for (const rel of [
    "User/globalStorage/state.vscdb",
    "User/globalStorage/state.vscdb-wal",
    "User/globalStorage/state.vscdb-shm",
    "User/workspaceStorage/hash/state.vscdb",
    "User/workspaceStorage/hash/state.vscdb.backup",
    "User/workspaceStorage/hash/workspace.json",
    "User/profiles/id/settings.json",
    "User/settings.json",
    "User/History/local.ts",
    "User/globalStorage/saoudrizwan.claude-dev/tasks/id/api_conversation_history.json",
    ".cursor/mcp.json",
    ".cursor/rules/test.mdc",
    ".cursor/projects/proj/agent-transcripts/chat.txt",
    ".cursor/cli-config.json",
    ".cursor/chats/id/store.db",
    "storage.json",
    "Cookies",
    "Network/Cookies",
    "CachedData/index.bin",
    "projects/index.db",
    ".agentvac-quarantine/any/main.log",
  ])
    assert.equal(adapter.classify(rel).risk, "protected", rel);
});

test("Cursor rejects invalid relative paths instead of normalizing them into the allowlist", () => {
  for (const rel of [
    `../logs/${OLD}/main.log`,
    `/logs/${OLD}/main.log`,
    `logs/${OLD}/../${OLD}/main.log`,
    `logs//${OLD}/main.log`,
    `logs/./${OLD}/main.log`,
    `logs\\${OLD}\\main.log`,
    `C:/logs/${OLD}/main.log`,
    `logs/${OLD}/main.log:stream`,
    `logs/${OLD}/main.log\0`,
    "",
  ]) {
    assert.equal(adapter.classify(rel).risk, "protected", rel);
    assert.equal(adapter.canTraverse(rel), false, rel);
  }
});

test("Cursor root validation requires application root metadata", async (t) => {
  const { root, base } = await fixture(t);
  await adapter.validateRoot(root);
  await assert.rejects(adapter.validateRoot(path.join(base, "Missing")));
  await assert.rejects(adapter.validateRoot(root + "/../Cursor"));
  await fs.rm(path.join(root, "User", "globalStorage"), { recursive: true });
  await assert.rejects(adapter.validateRoot(root));
});

test("Cursor rejects VS Code, .cursor, profile and Cline subtrees even with copied marker directories", async (t) => {
  const { root, base } = await fixture(t);
  for (const relative of [
    "Code",
    "Code - Insiders",
    ".cursor",
    "WorkProfile",
    "Cursor/User",
    "Cursor/logs",
    "Cursor/User/profiles/Cursor",
    "Cursor/User/globalStorage/saoudrizwan.claude-dev/Cursor",
    "Code/User/globalStorage/Cursor",
    "Cursor/User/workspaceStorage/Cursor",
    ".cursor/projects/Cursor",
  ]) {
    const candidate = path.join(base, relative);
    await fs.mkdir(path.join(candidate, "User", "globalStorage"), {
      recursive: true,
    });
    await fs.mkdir(path.join(candidate, "logs"), { recursive: true });
    await assert.rejects(
      adapter.validateRoot(candidate),
      { name: "Error" },
      relative,
    );
  }
  await adapter.validateRoot(root);
});

test("Cursor root and marker links are rejected", async (t) => {
  const { root, base } = await fixture(t);
  await fs.mkdir(path.join(base, "alias"));
  const alias = path.join(base, "alias", "Cursor");
  if (!(await symlink(t, root, alias, true))) return;
  await assert.rejects(adapter.validateRoot(alias));
  await fs.rename(path.join(root, "logs"), path.join(base, "logs-real"));
  if (
    !(await symlink(
      t,
      path.join(base, "logs-real"),
      path.join(root, "logs"),
      true,
    ))
  )
    return;
  await assert.rejects(adapter.validateRoot(root));
});

test("Cursor newest-session protection ignores unknown names and never follows date-named links", async (t) => {
  const { root, base } = await fixture(t);
  await fs.mkdir(path.join(root, "logs", OLD));
  assert.deepEqual(await adapter.protectedPaths!(root), [`logs/${OLD}/`]);
  await fs.mkdir(path.join(root, "logs", NEXT));
  await fs.mkdir(path.join(root, "logs", "20999999T999999"));
  await fs.writeFile(
    path.join(root, "logs", "20990101T120000"),
    "ordinary file",
  );
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  if (
    !(await symlink(
      t,
      outside,
      path.join(root, "logs", "20990202T120000"),
      true,
    ))
  )
    return;
  assert.deepEqual(await adapter.protectedPaths!(root), [`logs/${NEXT}/`]);
});

test("Cursor newest-session protection is root-specific and fails closed on a missing logs directory", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await fs.mkdir(path.join(first.root, "logs", OLD));
  await fs.mkdir(path.join(second.root, "logs", NEXT));
  assert.deepEqual(await adapter.protectedPaths!(first.root), [`logs/${OLD}/`]);
  assert.deepEqual(await adapter.protectedPaths!(second.root), [
    `logs/${NEXT}/`,
  ]);
  await fs.rm(path.join(second.root, "logs"), { recursive: true });
  await assert.rejects(adapter.protectedPaths!(second.root));
});

test("Cursor process guard recognizes desktop, helper, AppImage, server and CLI identities", () => {
  for (const name of [
    "Cursor",
    "Cursor.exe",
    "cursor.AppImage",
    "cursor-agent",
    "cursor-agent.exe",
    "cursor-server.exe",
    "Cursor Helper",
    "Cursor Helper (Renderer)",
    "Cursor Helper (GPU)",
    "Cursor Helper.exe",
    "/Applications/Cursor.app/Contents/MacOS/Cursor",
    "C:\\Programs\\Cursor\\Cursor.exe",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name }],
      }).status,
      "running",
      name,
    );
  for (const commandLine of [
    "node /usr/share/cursor/resources/app/out/cli.js .",
    "node /home/test/.cursor-server/bin/hash/server-main.js",
    "/home/test/.local/share/cursor-agent/versions/2026.10.01-e373342/node /home/test/.local/share/cursor-agent/versions/2026.10.01-e373342/index.js",
    "/home/test/.local/bin/agent",
    "/usr/share/cursor/chrome_crashpad_handler --monitor-self",
    '"C:\\Programs\\Cursor\\Cursor.exe" --user-data-dir C:\\Profiles\\Work',
    "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "darwin",
        complete: true,
        processes: [{ name: "node", commandLine }],
      }).status,
      "running",
      commandLine,
    );
});

test("Cursor process guard never clears incomplete, empty, malformed or unattributed runtime snapshots", () => {
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: false,
      processes: [{ name: "bash" }],
    }).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [],
    }).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "freebsd",
      complete: true,
      processes: [{ name: "bash" }],
    }).status,
    "unknown",
  );
  for (const name of [
    "",
    "node",
    "node.exe",
    "electron",
    "electron.exe",
    "nodejs",
    "agent",
    "agent.exe",
    "bad\0process",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name }],
      }).status,
      "unknown",
      name,
    );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "node", commandLine: "node\0 bad" }],
    }).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [
        { name: "bash" },
        { name: "node", commandLine: "node /test/server.js" },
      ],
    }).status,
    "clear",
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "win32",
      complete: true,
      processes: [{ name: "explorer.exe" }, { name: "Code.exe" }],
    }).status,
    "clear",
  );
  for (const commandLine of [
    `node -e "const provider = 'cursor';"`,
    `node /tests/test.js --description "cursor"`,
    `bash -c 'echo cursor'`,
    `node -e "console.log('/usr/share/cursor/resources/app/out/cli.js')"`,
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name: "node", commandLine }],
      }).status,
      "unknown",
      commandLine,
    );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "node", commandLine: "node" }],
    }).status,
    "unknown",
  );
});

async function file(
  root: string,
  relative: string,
  text = "Cursor fixture only",
  ageDays = 100,
) {
  const location = path.join(root, relative);
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(location, text);
  const old = new Date(Date.now() - ageDays * 86_400_000);
  await fs.utimes(location, old, old);
  return location;
}

async function engineFixture(
  t: TestContext,
  status: () => Promise<ProcessStatus> = async () => ({
    status: "clear",
    details: "Fixture process snapshot",
  }),
) {
  const { root, base } = await fixture(t);
  const key = randomBytes(32);
  await fs.mkdir(path.join(root, "logs", NEXT));
  const engine = new AgentVacEngine(root, key, false, status, [], adapter);
  await engine.initialize();
  return { root, base, key, engine };
}

const scan = (engine: AgentVacEngine) =>
  engine.scan({ minAgeDays: 30, includeSessions: true });

test("Cursor engine performs real fixture quarantine and non-overwriting restore, leaving DB/config intact", async (t) => {
  const { root, engine, key } = await engineFixture(t);
  const relative = `logs/${OLD}/main.log`;
  const location = await file(root, relative, "archived diagnostic bytes");
  const current = await file(
    root,
    `logs/${NEXT}/main.log`,
    "latest session bytes",
  );
  const db = await file(
    root,
    "User/globalStorage/state.vscdb",
    "immutable fake database",
  );
  const wal = await file(
    root,
    "User/globalStorage/state.vscdb-wal",
    "immutable fake WAL",
  );
  const config = await file(
    root,
    "User/settings.json",
    "immutable fake settings",
  );
  const unknown = await file(
    root,
    `logs/${OLD}/unknown.log`,
    "unknown means protected",
  );
  const before = await scan(engine);
  assert.equal(before.provider, "cursor");
  assert.deepEqual(
    before.entries
      .filter((entry) => entry.selectable)
      .map((entry) => entry.path),
    [relative],
  );
  assert.equal(
    before.entries.find((entry) => entry.path === "User")?.kind,
    "directory",
  );
  assert.ok(!before.entries.some((entry) => entry.path.startsWith("User/")));
  const preview = await engine.preview(
    before.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  assert.equal(preview.provider, "cursor");
  const result = await engine.quarantine(preview.token, true);
  assert.equal(result.completed, 1);
  assert.equal(result.failed.length, 0);
  await assert.rejects(fs.lstat(location), { code: "ENOENT" });
  for (const [target, expected] of [
    [current, "latest session bytes"],
    [db, "immutable fake database"],
    [wal, "immutable fake WAL"],
    [config, "immutable fake settings"],
    [unknown, "unknown means protected"],
  ])
    assert.equal(await fs.readFile(target, "utf8"), expected);
  const restarted = new AgentVacEngine(
    root,
    key,
    false,
    async () => ({ status: "clear", details: "Fixture" }),
    [],
    adapter,
  );
  assert.equal((await restarted.history())[0].provider, "cursor");
  await fs.writeFile(location, "new source must not be overwritten");
  const blocked = await restarted.restore(result.batchId, true);
  assert.equal(blocked.completed, 0);
  assert.equal(blocked.failed.length, 1);
  assert.equal(
    await fs.readFile(location, "utf8"),
    "new source must not be overwritten",
  );
  await fs.unlink(location);
  const restored = await restarted.restore(result.batchId, true);
  assert.equal(restored.completed, 1);
  assert.equal(
    await fs.readFile(location, "utf8"),
    "archived diagnostic bytes",
  );
});

test("Cursor ordinary scan reads metadata only, never diagnostic contents or opaque chat state", async (t) => {
  const { root, engine } = await engineFixture(t);
  await file(root, `logs/${OLD}/main.log`);
  await file(root, "User/globalStorage/state.vscdb", "private fixture content");
  await file(
    root,
    "User/workspaceStorage/hash/state.vscdb",
    "private workspace fixture content",
  );
  const reads = t.mock.method(fs, "readFile", async () => {
    throw new Error("Unexpected content read in metadata-only scan");
  });
  const opens = t.mock.method(fs, "open", async () => {
    throw new Error("Unexpected file open in metadata-only scan");
  });
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 1);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(opens.mock.callCount(), 0);
});

test("Cursor newest directory and age threshold both constrain selection", async (t) => {
  const { root, engine } = await engineFixture(t);
  await file(
    root,
    `logs/${OLD}/main.log`,
    "old timestamp, recently written",
    1,
  );
  await file(root, `logs/${NEXT}/main.log`, "latest timestamp, old mtime", 100);
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 0);
});

test("Cursor rechecks newest session before preview and quarantine", async (t) => {
  const { root, engine } = await engineFixture(t);
  const location = await file(root, `logs/${OLD}/main.log`);
  let result = await scan(engine);
  await fs.rm(path.join(root, "logs", NEXT), { recursive: true });
  await assert.rejects(
    engine.preview(
      result.entries
        .filter((entry) => entry.selectable)
        .map((entry) => entry.id),
    ),
  );
  await fs.mkdir(path.join(root, "logs", NEXT));
  result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  await fs.rm(path.join(root, "logs", NEXT), { recursive: true });
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 0);
  assert.equal(moved.failed.length, 1);
  assert.equal(await fs.readFile(location, "utf8"), "Cursor fixture only");
});

test("Cursor restoration fails closed if an archived log becomes newest", async (t) => {
  const { root, engine } = await engineFixture(t);
  const location = await file(root, `logs/${OLD}/main.log`);
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  await fs.rm(path.join(root, "logs", NEXT), { recursive: true });
  await assert.rejects(engine.restore(moved.batchId, true));
  await assert.rejects(fs.lstat(location), { code: "ENOENT" });
  await fs.mkdir(path.join(root, "logs", NEXT));
  assert.equal((await engine.restore(moved.batchId, true)).completed, 1);
  assert.equal(await fs.readFile(location, "utf8"), "Cursor fixture only");
});

test("Cursor linked diagnostic files and unknown directories never become selectable", async (t) => {
  const { root, base, engine } = await engineFixture(t);
  const original = await file(root, `logs/${OLD}/main.log`);
  await fs.link(original, path.join(base, "hardlink"));
  const outside = await file(base, "outside.log", "outside must be untouched");
  if (
    !(await symlink(t, outside, path.join(root, "logs", OLD, "renderer.log")))
  )
    return;
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 0);
  assert.equal(await fs.readFile(outside, "utf8"), "outside must be untouched");
});

test("Cursor process running, unknown and failed inspection block cleanup and restore", async (t) => {
  let status: "clear" | "running" | "unknown" | "throw" = "clear";
  const { root, engine } = await engineFixture(t, async () => {
    if (status === "throw")
      throw new Error("Fixture process inspection failed");
    return { status, details: "Fixture process status" };
  });
  const location = await file(root, `logs/${OLD}/main.log`);
  for (const blocked of ["running", "unknown", "throw"] as const) {
    status = "clear";
    const result = await scan(engine);
    const preview = await engine.preview(
      result.entries
        .filter((entry) => entry.selectable)
        .map((entry) => entry.id),
    );
    status = blocked;
    await assert.rejects(engine.quarantine(preview.token, true));
    assert.equal(await fs.readFile(location, "utf8"), "Cursor fixture only");
  }
  status = "clear";
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  for (const blocked of ["running", "unknown", "throw"] as const) {
    status = blocked;
    await assert.rejects(engine.restore(moved.batchId, true));
    await assert.rejects(fs.lstat(location), { code: "ENOENT" });
  }
  status = "clear";
  assert.equal((await engine.restore(moved.batchId, true)).completed, 1);
});

test("Cursor journals cannot be restored through the Codex compatibility path", async (t) => {
  const { root, engine, key } = await engineFixture(t);
  await file(root, `logs/${OLD}/main.log`);
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  const codex = new AgentVacEngine(root, key, true);
  await assert.rejects(codex.restore(moved.batchId, true));
});

type Node = { path: string; kind: "file" | "directory" };
const dir = (path: string): Node => ({ path, kind: "directory" });
const data = (path: string): Node => ({ path, kind: "file" });
function simpleLayout(prefix: string): Node[] {
  return [
    dir(prefix),
    data(prefix + "/index"),
    dir(prefix + "/index-dir"),
    data(prefix + "/index-dir/the-real-index"),
    data(prefix + "/0123456789abcdef_0"),
    data(prefix + "/0123456789abcdef_1"),
    data(prefix + "/0123456789abcdef_s"),
  ];
}
function blockLayout(prefix: string): Node[] {
  return [
    dir(prefix),
    data(prefix + "/index"),
    ...[0, 1, 2, 3].map((n) => data(`${prefix}/data_${n}`)),
    data(prefix + "/f_000001"),
  ];
}
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function cacheLayouts(): { anchor: string; nodes: Node[] }[] {
  return [
    {
      anchor: "Cache",
      nodes: [dir("Cache"), ...simpleLayout("Cache/Cache_Data")],
    },
    { anchor: "Cache", nodes: blockLayout("Cache") },
    { anchor: "GPUCache", nodes: blockLayout("GPUCache") },
    { anchor: "GPUCache", nodes: simpleLayout("GPUCache") },
    {
      anchor: "Code Cache",
      nodes: [
        dir("Code Cache"),
        ...simpleLayout("Code Cache/js"),
        ...simpleLayout("Code Cache/wasm"),
      ],
    },
    {
      anchor: "CachedData",
      nodes: [
        dir("CachedData"),
        dir(`CachedData/${COMMIT}`),
        dir(`CachedData/${COMMIT}/chrome`),
        ...simpleLayout(`CachedData/${COMMIT}/chrome/js`),
      ],
    },
  ];
}

test("Cursor cache policy defines exact whole directories, never individual cache files", async () => {
  for (const anchor of ["Cache", "GPUCache", "Code Cache", "CachedData"]) {
    const unit = await adapter.cleanupUnit!(
      anchor,
      "/nonexistent/fixture/Cursor",
    );
    assert.ok(unit);
    assert.equal(unit.kind, "directory");
    assert.deepEqual(unit.members, [{ path: anchor, kind: "directory" }]);
    assert.equal(adapter.classify(anchor).risk, "review");
    assert.equal(adapter.classify(anchor).category, "cache");
    assert.equal(adapter.classify(anchor + "/index").risk, "protected");
    assert.equal(adapter.canTraverse(anchor), false);
  }
  for (const path of [
    "Cache/index",
    "Code Cache/js",
    `CachedData/${COMMIT}`,
    "cache",
    "DawnCache",
    "DawnWebGPUCache",
    "ShaderCache",
    "Network",
    "Local Storage",
    "User/globalStorage",
    "Cache/../User",
  ])
    assert.equal(
      await adapter.cleanupUnit!(path, "/nonexistent/fixture/Cursor"),
      null,
      path,
    );
});

test("Cursor cache layouts accept only complete pinned simple or blockfile families", async () => {
  for (const { anchor, nodes } of cacheLayouts()) {
    const definition = (await adapter.cleanupUnit!(
      anchor,
      "/nonexistent/fixture/Cursor",
    ))!;
    assert.ok(
      nodes.every((node) =>
        adapter.unitEntryAllowed!(definition.policy, node.path, node.kind),
      ),
      anchor,
    );
    assert.equal(adapter.unitLayoutAllowed!(definition, nodes), true, anchor);
    assert.equal(
      adapter.unitLayoutAllowed!(
        definition,
        nodes.filter((node) => !node.path.endsWith("/index")),
      ),
      false,
      anchor,
    );
    assert.equal(
      adapter.unitLayoutAllowed!(definition, [
        ...nodes,
        data(anchor + "/unknown.bin"),
      ]),
      false,
      anchor,
    );
    assert.equal(
      adapter.unitLayoutAllowed!(definition, [...nodes, nodes[0]]),
      false,
      anchor,
    );
  }
});

test("Cursor cache unknown formats, SQL state, mixed backends and cross-unit members block the whole unit", async () => {
  const definition = (await adapter.cleanupUnit!(
    "GPUCache",
    "/nonexistent/fixture/Cursor",
  ))!;
  const original = blockLayout("GPUCache");
  for (const extra of [
    data("GPUCache/state.vscdb"),
    data("GPUCache/data_256"),
    data("GPUCache/data_00"),
    data("GPUCache/credentials.json"),
    data("GPUCache/index:stream"),
    dir("GPUCache/subdir"),
    data("Cache/index"),
    data("GPUCache/../User/settings.json"),
  ])
    assert.equal(
      adapter.unitLayoutAllowed!(definition, [...original, extra]),
      false,
      extra.path,
    );
  assert.equal(
    adapter.unitLayoutAllowed!(definition, [
      ...original,
      dir("GPUCache/index-dir"),
      data("GPUCache/index-dir/the-real-index"),
    ]),
    false,
  );
  assert.equal(
    adapter.unitLayoutAllowed!(
      definition,
      original.map((node) =>
        node.path.endsWith("data_0") ? dir(node.path) : node,
      ),
    ),
    false,
  );
  const codeDefinition = (await adapter.cleanupUnit!(
    "Code Cache",
    "/nonexistent/fixture/Cursor",
  ))!;
  assert.equal(
    adapter.unitLayoutAllowed!(codeDefinition, [
      dir("Code Cache"),
      ...simpleLayout("Code Cache/js"),
      dir("Code Cache/pc"),
      data("Code Cache/pc/cache.sqlite"),
    ]),
    false,
  );
  assert.equal(
    adapter.unitLayoutAllowed!(codeDefinition, [
      dir("Code Cache"),
      ...blockLayout("Code Cache/js"),
    ]),
    false,
  );
  assert.equal(
    adapter.unitLayoutAllowed!(
      { ...definition, policy: "unverified" },
      original,
    ),
    false,
  );
  assert.equal(
    adapter.unitLayoutAllowed!({ ...definition, kind: "bundle" }, original),
    false,
  );
  assert.equal(
    adapter.unitLayoutAllowed!(
      {
        ...definition,
        members: [...definition.members, { path: "User", kind: "directory" }],
      },
      original,
    ),
    false,
  );
});

test("Cursor CachedData rejects unknown commit trees and preserves SQLite/legacy layouts", async () => {
  const definition = (await adapter.cleanupUnit!(
    "CachedData",
    "/nonexistent/fixture/Cursor",
  ))!;
  const original = cacheLayouts().find(
    (layout) => layout.anchor === "CachedData",
  )!.nodes;
  for (const extra of [
    dir("CachedData/not-a-commit"),
    data(`CachedData/${COMMIT}/custom.cache`),
    dir(`CachedData/${COMMIT}/chrome/pc`),
    data(`CachedData/${COMMIT}/chrome/js/chat.json`),
  ])
    assert.equal(
      adapter.unitLayoutAllowed!(definition, [...original, extra]),
      false,
      extra.path,
    );
  assert.equal(
    adapter.unitLayoutAllowed!(definition, [dir("CachedData")]),
    false,
  );
});

test("Cursor cache entry filter independently rejects traversal, wrong policy and unexpected member types", async () => {
  const definition = (await adapter.cleanupUnit!(
    "Cache",
    "/nonexistent/fixture/Cursor",
  ))!;
  for (const path of [
    "Cache/../User",
    "Cache//index",
    "/Cache/index",
    "Cache\\index",
    "Cache/Cache_Data/state.vscdb-wal",
    "Cache/Cache_Data/unknown",
    "Code Cache/pc/cache.db",
  ])
    assert.equal(
      adapter.unitEntryAllowed!(definition.policy, path, "file"),
      false,
      path,
    );
  assert.equal(
    adapter.unitEntryAllowed!(definition.policy, "Cache", "file"),
    false,
  );
  assert.equal(
    adapter.unitEntryAllowed!(definition.policy, "Cache/index", "directory"),
    false,
  );
  assert.equal(
    adapter.unitEntryAllowed!("unverified", "Cache/index", "file"),
    false,
  );
});

async function writeLayout(root: string, nodes: Node[], ageDays = 100) {
  for (const node of nodes) {
    const location = path.join(root, node.path);
    if (node.kind === "directory")
      await fs.mkdir(location, { recursive: true });
    else
      await file(
        root,
        node.path,
        "Synthetic cache bytes: " + node.path,
        ageDays,
      );
  }
  const age = new Date(Date.now() - ageDays * 86_400_000);
  for (const node of [...nodes].reverse())
    await fs.utimes(path.join(root, node.path), age, age);
}

test("Cursor engine quarantines and restores all four complete cache kinds as units", async (t) => {
  for (const anchor of ["Cache", "GPUCache", "Code Cache", "CachedData"]) {
    const { root, engine, key } = await engineFixture(t);
    const nodes = cacheLayouts().find(
      (layout) => layout.anchor === anchor,
    )!.nodes;
    await writeLayout(root, nodes);
    const db = await file(
      root,
      "User/globalStorage/state.vscdb",
      "Never change durable state",
    );
    const result = await engine.scan({
      minAgeDays: 30,
      includeSessions: false,
    });
    const selected = result.entries.filter((entry) => entry.selectable);
    assert.equal(selected.length, 1, anchor);
    assert.equal(selected[0].path, anchor);
    assert.equal(selected[0].kind, "directory");
    assert.equal(selected[0].cleanupUnit?.kind, "directory");
    assert.equal(
      selected[0].cleanupUnit?.fileCount,
      nodes.filter((node) => node.kind === "file").length,
    );
    assert.ok(
      !result.entries.some((entry) => entry.path.startsWith(anchor + "/")),
    );
    const preview = await engine.preview([selected[0].id]);
    assert.equal(
      preview.totalFiles,
      nodes.filter((node) => node.kind === "file").length,
    );
    assert.equal(
      preview.totalDirectories,
      nodes.filter((node) => node.kind === "directory").length,
    );
    const moved = await engine.quarantine(preview.token, true);
    assert.equal(moved.completed, 1, JSON.stringify(moved.failed));
    await assert.rejects(fs.lstat(path.join(root, anchor)), { code: "ENOENT" });
    assert.equal(await fs.readFile(db, "utf8"), "Never change durable state");
    const restarted = new AgentVacEngine(
      root,
      key,
      false,
      async () => ({ status: "clear", details: "Fixture" }),
      [],
      adapter,
    );
    const restored = await restarted.restore(moved.batchId, true);
    assert.equal(restored.completed, 1, JSON.stringify(restored.failed));
    for (const node of nodes) {
      const stat = await fs.lstat(path.join(root, node.path));
      assert.equal(stat.isDirectory(), node.kind === "directory", node.path);
      if (node.kind === "file") {
        assert.equal(stat.nlink, 1);
        assert.equal(
          await fs.readFile(path.join(root, node.path), "utf8"),
          "Synthetic cache bytes: " + node.path,
        );
      }
    }
    assert.equal(await fs.readFile(db, "utf8"), "Never change durable state");
  }
});

test("Cursor simulated cache rebuild blocks restore instead of merging old and new generations", async (t) => {
  const { root, base, engine } = await engineFixture(t);
  const nodes = blockLayout("GPUCache");
  await writeLayout(root, nodes);
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1);
  // This intentionally simulates a vendor rebuild. It does not launch Cursor
  // or establish runtime compatibility with any native Cursor release.
  await writeLayout(root, nodes, 0);
  await fs.writeFile(
    path.join(root, "GPUCache/data_0"),
    "simulated regenerated shader cache",
  );
  const conflict = await engine.restore(moved.batchId, true);
  assert.equal(conflict.completed, 0);
  assert.equal(conflict.failed.length, 1);
  assert.equal(
    await fs.readFile(path.join(root, "GPUCache/data_0"), "utf8"),
    "simulated regenerated shader cache",
  );
  await fs.rename(
    path.join(root, "GPUCache"),
    path.join(base, "preserved-rebuilt-cache"),
  );
  const restored = await engine.restore(moved.batchId, true);
  assert.equal(restored.completed, 1, JSON.stringify(restored.failed));
  assert.equal(
    await fs.readFile(path.join(root, "GPUCache/data_0"), "utf8"),
    "Synthetic cache bytes: GPUCache/data_0",
  );
  assert.equal(
    await fs.readFile(
      path.join(base, "preserved-rebuilt-cache/data_0"),
      "utf8",
    ),
    "simulated regenerated shader cache",
  );
});

test("Cursor unknown cache member makes the entire directory protected without exposing partial selection", async (t) => {
  const { root, engine } = await engineFixture(t);
  const nodes = simpleLayout("Cache");
  await writeLayout(root, [...nodes, data("Cache/unknown.json")]);
  await writeLayout(root, [
    dir("Code Cache"),
    ...simpleLayout("Code Cache/js"),
    dir("Code Cache/pc"),
    data("Code Cache/pc/cache.sqlite"),
  ]);
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 0);
  for (const anchor of ["Cache", "Code Cache"]) {
    const entry = result.entries.find((item) => item.path === anchor);
    assert.equal(entry?.risk, "protected", anchor);
    assert.match(entry?.reason ?? "", /整组/);
    assert.ok(
      !result.entries.some((item) => item.path.startsWith(anchor + "/")),
    );
  }
  assert.equal(
    await fs.readFile(path.join(root, "Cache/unknown.json"), "utf8"),
    "Synthetic cache bytes: Cache/unknown.json",
  );
});

test("Cursor cache scans read metadata only, including complete cache members", async (t) => {
  const { root, engine } = await engineFixture(t);
  await writeLayout(root, blockLayout("GPUCache"));
  const reads = t.mock.method(fs, "readFile", async () => {
    throw new Error("Unexpected cache payload read");
  });
  const opens = t.mock.method(fs, "open", async () => {
    throw new Error("Unexpected cache payload open");
  });
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 1);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(opens.mock.callCount(), 0);
});

test("Cursor cache age floor applies to every component rather than the oldest file", async (t) => {
  const { root, engine } = await engineFixture(t);
  await writeLayout(root, blockLayout("GPUCache"));
  await fs.utimes(path.join(root, "GPUCache/data_3"), new Date(), new Date());
  const result = await scan(engine);
  const entry = result.entries.find((item) => item.path === "GPUCache")!;
  assert.equal(entry.risk, "protected");
  assert.equal(entry.selectable, false);
  assert.match(entry.reason, /最近/);
});

test("Cursor cache symlinks and hardlinks protect the entire coherent unit", async (t) => {
  const { root, base, engine } = await engineFixture(t);
  await writeLayout(root, blockLayout("GPUCache"));
  await fs.link(
    path.join(root, "GPUCache/data_0"),
    path.join(base, "linked-cache-payload"),
  );
  await writeLayout(root, simpleLayout("Cache"));
  const target = await file(base, "outside-cache.bin", "outside fixture bytes");
  await fs.unlink(path.join(root, "Cache/0123456789abcdef_0"));
  if (!(await symlink(t, target, path.join(root, "Cache/0123456789abcdef_0"))))
    return;
  const result = await scan(engine);
  assert.equal(result.entries.filter((entry) => entry.selectable).length, 0);
  assert.equal(await fs.readFile(target, "utf8"), "outside fixture bytes");
});

test("Cursor cache mutation after preview blocks moving any component", async (t) => {
  const { root, engine } = await engineFixture(t);
  await writeLayout(root, blockLayout("GPUCache"));
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  await fs.writeFile(
    path.join(root, "GPUCache/data_0"),
    "changed after preview",
  );
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 0);
  assert.equal(moved.failed.length, 1);
  assert.equal(
    await fs.readFile(path.join(root, "GPUCache/data_0"), "utf8"),
    "changed after preview",
  );
  assert.equal(
    await fs.readFile(path.join(root, "GPUCache/index"), "utf8"),
    "Synthetic cache bytes: GPUCache/index",
  );
});

test("Cursor restore detects a replaced destination parent before deleting quarantined cache payloads", async (t) => {
  const { root, base, engine } = await engineFixture(t);
  const nodes = blockLayout("GPUCache");
  await writeLayout(root, nodes);
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  const history = (await engine.history()).find(
    (batch) => batch.id === moved.batchId,
  )!;
  const saved = path.join(
    root,
    ".agentvac-quarantine",
    moved.batchId,
    history.items[0].id + ".unit",
    "0",
  );
  const originalLink = fs.link.bind(fs);
  let replaced = false;
  t.mock.method(
    fs,
    "link",
    async (
      source: Parameters<typeof fs.link>[0],
      destination: Parameters<typeof fs.link>[1],
    ) => {
      if (
        !replaced &&
        String(destination).startsWith(path.join(root, "GPUCache") + path.sep)
      ) {
        replaced = true;
        await fs.rename(
          path.join(root, "GPUCache"),
          path.join(base, "original-created-directory"),
        );
        await fs.mkdir(path.join(root, "GPUCache"), { mode: 0o700 });
      }
      return originalLink(source, destination);
    },
  );
  const restored = await engine.restore(moved.batchId, true);
  assert.equal(replaced, true);
  assert.equal(restored.completed, 0);
  assert.equal(restored.failed.length, 1);
  for (const node of nodes.filter((node) => node.kind === "file"))
    assert.equal(
      await fs.readFile(
        path.join(saved, path.posix.basename(node.path)),
        "utf8",
      ),
      "Synthetic cache bytes: " + node.path,
      "The quarantine must retain every payload when the destination parent identity changes.",
    );
});

test("Cursor oversized cache units stay wholly protected instead of producing a partial selection", async (t) => {
  const { root, engine } = await engineFixture(t);
  const nodes = simpleLayout("Cache");
  for (let i = 0; i < 4997; i++)
    nodes.push(data(`Cache/${i.toString(16).padStart(16, "0")}_0`));
  await writeLayout(root, nodes);
  const result = await scan(engine);
  const entry = result.entries.find((item) => item.path === "Cache")!;
  assert.equal(entry.selectable, false);
  assert.equal(entry.risk, "protected");
  assert.match(entry.reason, /5000/);
  assert.ok(!result.entries.some((item) => item.path.startsWith("Cache/")));
  assert.equal(
    await fs.readFile(path.join(root, "Cache/index"), "utf8"),
    "Synthetic cache bytes: Cache/index",
  );
});

test(
  "Cursor cache restoration preserves ordinary file and directory permissions",
  {
    skip:
      process.platform === "win32"
        ? "POSIX permission mode assertion only"
        : false,
  },
  async (t) => {
    const { root, engine } = await engineFixture(t);
    await writeLayout(root, blockLayout("GPUCache"));
    await fs.chmod(path.join(root, "GPUCache"), 0o750);
    await fs.chmod(path.join(root, "GPUCache/data_0"), 0o400);
    const result = await scan(engine);
    const preview = await engine.preview(
      result.entries
        .filter((entry) => entry.selectable)
        .map((entry) => entry.id),
    );
    const moved = await engine.quarantine(preview.token, true);
    assert.equal(moved.completed, 1);
    const restored = await engine.restore(moved.batchId, true);
    assert.equal(restored.completed, 1, JSON.stringify(restored.failed));
    assert.equal(
      (await fs.lstat(path.join(root, "GPUCache"))).mode & 0o777,
      0o750,
    );
    assert.equal(
      (await fs.lstat(path.join(root, "GPUCache/data_0"))).mode & 0o777,
      0o400,
    );
  },
);

test("Cursor signed recovery data cannot substitute an unknown stored cache layout", async (t) => {
  const { root, engine, key } = await engineFixture(t);
  await writeLayout(root, blockLayout("GPUCache"));
  const result = await scan(engine);
  const preview = await engine.preview(
    result.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  const manifestPath = path.join(
    root,
    ".agentvac-quarantine",
    moved.batchId,
    "manifest.json",
  );
  const saved = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const item = saved.journal.items[0];
  const location = path.join(
    root,
    ".agentvac-quarantine",
    moved.batchId,
    item.id + ".unit",
    "0",
  );
  await fs.rename(
    path.join(location, "data_0"),
    path.join(location, "unknown-private.json"),
  );
  item.unit.stored.nodes.find(
    (node: Node) => node.path === "GPUCache/data_0",
  ).path = "GPUCache/unknown-private.json";
  for (const node of item.unit.stored.nodes)
    node.fingerprint = unitFingerprint(
      await fs.lstat(
        path.join(location, path.posix.relative("GPUCache", node.path)),
        { bigint: true },
      ),
    );
  // Signing does not expand a provider's allowlist. This also models imported
  // recovery state written by a buggy previous version with a trusted key.
  item.unit.restore = { directories: [], completedMembers: [] };
  saved.signature = createHmac("sha256", key)
    .update(JSON.stringify(saved.journal))
    .digest("hex");
  await fs.writeFile(manifestPath, JSON.stringify(saved));
  let completed = 0;
  try {
    completed = (await engine.restore(moved.batchId, true)).completed;
  } catch {
    /* policy rejection is expected */
  }
  assert.equal(
    completed,
    0,
    "An authenticated journal may not bypass the stored-layout allowlist.",
  );
  await assert.rejects(
    fs.lstat(path.join(root, "GPUCache/unknown-private.json")),
    { code: "ENOENT" },
  );
  assert.equal(
    await fs.readFile(path.join(location, "unknown-private.json"), "utf8"),
    "Synthetic cache bytes: GPUCache/data_0",
  );
});
