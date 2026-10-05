import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import type { ProcessStatus } from "../shared/types.js";
import {
  claudeCodeAdapter as adapter,
  claudeSessionUnitPolicy as sessionPolicy,
} from "../electron/providers/claude-code.js";
import { captureUnit, sameUnit } from "../electron/cleanup-units.js";
import type { ProcessSnapshot } from "../electron/providers/types.js";

const UUID = "2c7b4204-4880-4823-baff-9f8e03b8f3e6";
const LOG = `debug/${UUID}.txt`;
const DAY = 86_400_000;
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-claude-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, ".claude");
  await fs.mkdir(path.join(root, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(root, "history.jsonl"),
    "synthetic fixture; deliberately not valid JSON\n",
  );
  return { base, root };
}
async function put(
  root: string,
  rel: string,
  age = 60,
  content = "synthetic fixture only\n",
) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const time = new Date(Date.now() - age * DAY);
  await fs.utimes(file, time, time);
  return file;
}
async function symlink(
  t: TestContext,
  target: string,
  link: string,
  directory = false,
) {
  try {
    await fs.symlink(target, link, directory ? "dir" : "file");
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip(
        "Windows symlink permission unavailable; this case is not verified.",
      );
      return false;
    }
    throw error;
  }
}
function processes(
  names: { name: string; commandLine?: string }[],
  complete = true,
): ProcessSnapshot {
  return { platform: "linux", processes: names, complete };
}

test("Claude discovery is pure and covers macOS, Linux, Windows and custom config roots", () => {
  assert.deepEqual(
    adapter
      .discover({ platform: "darwin", home: "/Users/demo", env: {} })
      .map((c) => c.path),
    ["/Users/demo/.claude"],
  );
  assert.deepEqual(
    adapter
      .discover({ platform: "linux", home: "/home/demo", env: {} })
      .map((c) => c.path),
    ["/home/demo/.claude"],
  );
  assert.deepEqual(
    adapter
      .discover({ platform: "win32", home: "C:\\Users\\demo", env: {} })
      .map((c) => c.path),
    ["C:\\Users\\demo\\.claude"],
  );
  const candidates = adapter.discover({
    platform: "linux",
    home: "/home/demo",
    env: {
      CLAUDE_CONFIG_DIR: "/srv/claude-work",
      CLAUDE_CODE_DEBUG_LOGS_DIR: "/private/secret.txt",
      CLAUDE_CODE_TMPDIR: "/different/temp",
    },
  });
  assert.deepEqual(
    candidates.map((c) => c.path),
    ["/srv/claude-work", "/home/demo/.claude"],
  );
  assert.ok(candidates.every((c) => c.provider === "claude-code"));
  assert.equal(candidates[0].source, "CLAUDE_CONFIG_DIR");
  assert.deepEqual(
    adapter
      .discover({
        platform: "linux",
        home: "/home/demo",
        env: { CLAUDE_CONFIG_DIR: "~/.claude-work" },
      })
      .map((c) => c.path),
    ["/home/demo/.claude-work", "/home/demo/.claude"],
  );
});

test("Claude discovery deduplicates and excludes unsafe, ambiguous and remote overrides", () => {
  for (const value of [
    "relative",
    "/",
    "/home/demo",
    "/tmp/../other",
    "/tmp/a\0b",
    "$HOME/.claude",
  ]) {
    assert.deepEqual(
      adapter
        .discover({
          platform: "linux",
          home: "/home/demo",
          env: { CLAUDE_CONFIG_DIR: value },
        })
        .map((c) => c.path),
      ["/home/demo/.claude"],
      value,
    );
  }
  assert.equal(
    adapter.discover({
      platform: "linux",
      home: "/home/demo",
      env: { CLAUDE_CONFIG_DIR: "/home/demo/.claude" },
    }).length,
    1,
  );
  for (const value of [
    "C:\\",
    "C:relative",
    "\\\\server\\share\\claude",
    "C:\\Users\\demo\\.claude:stream",
  ]) {
    assert.equal(
      adapter.discover({
        platform: "win32",
        home: "C:\\Users\\demo",
        env: { CLAUDE_CONFIG_DIR: value },
      }).length,
      1,
      value,
    );
  }
  assert.equal(
    adapter.discover({
      platform: "win32",
      home: "C:\\Users\\demo",
      env: { CLAUDE_CONFIG_DIR: "C:\\USERS\\DEMO\\.CLAUDE" },
    }).length,
    1,
  );
});

test("Claude classifier only allows exact lowercase UUID-v4 debug text logs", () => {
  assert.deepEqual(
    {
      category: adapter.classify(LOG).category,
      risk: adapter.classify(LOG).risk,
    },
    { category: "log", risk: "safe" },
  );
  for (const rel of [
    "debug/latest",
    "debug/latest.txt",
    "debug/output.log",
    "debug/credentials.txt",
    `debug/${UUID}.txt.1`,
    `debug/${UUID}.txt.gz`,
    `debug/nested/${UUID}.txt`,
    `DEBUG/${UUID}.txt`,
    `debug/${UUID.toUpperCase()}.txt`,
    `debug/${UUID.replace("-4823-", "-7823-")}.txt`,
    `debug/${UUID}.jsonl`,
    `debug/${UUID}.txt:stream`,
    `../${LOG}`,
    `/${LOG}`,
    "debug\\anything",
    "debug//anything",
    "debug/./anything",
    `debug/${UUID}.txt\n`,
  ]) {
    assert.equal(adapter.classify(rel).risk, "protected", rel);
  }
  assert.equal(adapter.canTraverse("debug"), true);
  assert.equal(adapter.canTraverse("projects"), true);
  assert.equal(adapter.canTraverse("projects/-home-demo"), true);
  assert.equal(
    adapter.classify(`projects/-home-demo/${UUID}.jsonl`).risk,
    "review",
  );
  for (const rel of [
    "",
    "debug/nested",
    "DEBUG",
    "debug/..",
    "debug/",
    "sessions",
    "plugins",
    ".agentvac-quarantine",
  ])
    assert.equal(adapter.canTraverse(rel), false, rel);
});

test("Claude credentials, memory, plugins, histories, database sidecars and mixed-provider files are protected", () => {
  for (const rel of [
    ".credentials.json",
    ".claude.json",
    "settings.json",
    "settings.local.json",
    "remote-settings.json",
    "policy-limits.json",
    "CLAUDE.md",
    "AGENTS.md",
    "history.jsonl",
    "keybindings.json",
    "session-env/private.env",
    "projects/-home-demo/memory/MEMORY.md",
    `projects/-home-demo/unknown-session-format.jsonl`,
    `projects/-home-demo/${UUID}/subagents/agent-a.jsonl`,
    `projects/-home-demo/${UUID}/tool-results/a.txt`,
    "projects/-home-demo/sessions-index.json",
    `file-history/${UUID}/backup`,
    `sessions/${UUID}.json`,
    "jobs/job/state.json",
    "jobs/job/tmp/draft.txt",
    "daemon.log",
    "daemon.lock",
    "daemon/roster.json",
    "plugins/installed_plugins.json",
    "plugins/cache/plugin/config.json",
    "skills/.trash/SKILL.md",
    "agent-memory/reviewer/MEMORY.md",
    "plans/important.md",
    "backups/.claude.json.backup.1",
    "stats-cache.json",
    "unknown.sqlite",
    "unknown.sqlite-wal",
    "unknown.sqlite-shm",
    "log/codex-tui.log.1",
    "tasks/123/api_conversation_history.json",
    "User/globalStorage/state.vscdb",
  ]) {
    assert.equal(adapter.classify(rel).risk, "protected", rel);
  }
});

test("Claude root validation is metadata-only and permits a missing debug directory", async (t) => {
  const { root } = await fixture(t);
  // Invalid JSON is intentional: validation must never need prompt/config contents.
  await adapter.validateRoot(root);
  await put(root, LOG);
  await adapter.validateRoot(root);
  await fs.unlink(path.join(root, "history.jsonl"));
  await put(root, "settings.json", 60, "not JSON, must not be parsed");
  await adapter.validateRoot(root);
  await fs.unlink(path.join(root, "settings.json"));
  await put(
    root,
    ".credentials.json",
    60,
    "not a credential, synthetic fixture only",
  );
  await adapter.validateRoot(root);
});

test("Claude validation rejects missing, arbitrary, project-local and incomplete roots", async (t) => {
  const { base, root } = await fixture(t);
  await assert.rejects(adapter.validateRoot(path.join(base, "missing")));
  await assert.rejects(adapter.validateRoot(base));
  await assert.rejects(adapter.validateRoot(path.parse(base).root));
  await assert.rejects(adapter.validateRoot("relative"));
  await assert.rejects(adapter.validateRoot(root + path.sep + ".."));
  await fs.unlink(path.join(root, "history.jsonl"));
  await put(root, LOG);
  await assert.rejects(adapter.validateRoot(root));
  await fs.rm(path.join(root, "projects"), { recursive: true });
  await put(root, "settings.json");
  await assert.rejects(adapter.validateRoot(root));
});

test("Claude validation rejects mixed-provider identities without opening them", async (t) => {
  const { root } = await fixture(t);
  for (const marker of [
    "auth.json",
    "config.toml",
    "session_index.jsonl",
    "archived_sessions",
    "api_conversation_history.json",
    "ui_messages.json",
    "taskHistory.json",
    "state.vscdb",
    "globalStorage",
    "workspaceStorage",
  ]) {
    await put(root, marker);
    await assert.rejects(adapter.validateRoot(root), /其他助手/);
    await fs.unlink(path.join(root, marker));
  }
});

test("Claude root and ancestor symlinks are rejected", async (t) => {
  const { base, root } = await fixture(t);
  if (!(await symlink(t, root, path.join(base, "alias"), true))) return;
  await assert.rejects(adapter.validateRoot(path.join(base, "alias")));
  await fs.mkdir(path.join(base, "parent"));
  await fs.rename(root, path.join(base, "parent", ".claude"));
  if (
    !(await symlink(
      t,
      path.join(base, "parent"),
      path.join(base, "alias-parent"),
      true,
    ))
  )
    return;
  await assert.rejects(
    adapter.validateRoot(path.join(base, "alias-parent", ".claude")),
  );
});

test("Claude identity markers and debug directory cannot be symlinks or hardlinked marker files", async (t) => {
  const { base, root } = await fixture(t);
  const outside = await put(base, "outside.txt");
  await fs.unlink(path.join(root, "history.jsonl"));
  await fs.link(outside, path.join(root, "history.jsonl"));
  await assert.rejects(adapter.validateRoot(root));
  await fs.unlink(path.join(root, "history.jsonl"));
  if (!(await symlink(t, outside, path.join(root, "history.jsonl")))) return;
  await assert.rejects(adapter.validateRoot(root));
  await fs.unlink(path.join(root, "history.jsonl"));
  await put(root, "history.jsonl");
  await fs.mkdir(path.join(base, "outside-directory"));
  if (
    !(await symlink(
      t,
      path.join(base, "outside-directory"),
      path.join(root, "debug"),
      true,
    ))
  )
    return;
  await assert.rejects(adapter.validateRoot(root));
});

test("Claude native, desktop, npm, Agent SDK and IDE extension process signatures block mutations", () => {
  for (const process of [
    { name: "claude", commandLine: "claude --resume" },
    { name: "Claude.exe" },
    { name: "/Applications/Claude.app/Contents/MacOS/Claude" },
    { name: "Claude Helper (Renderer)" },
    { name: "claude-code" },
    {
      name: "2.1.289",
      commandLine: "/home/demo/.local/share/claude/versions/2.1.289 --resume",
    },
    {
      name: "node",
      commandLine: "/usr/bin/node /x/@anthropic-ai/claude-code/cli.js",
    },
    {
      name: "node",
      commandLine: "/usr/bin/node /x/@anthropic-ai/claude-agent-sdk/cli.js",
    },
    {
      name: "node.exe",
      commandLine: 'node.exe "C:\\pkg\\@anthropic-ai\\claude-code\\cli.js"',
    },
    {
      name: "node",
      commandLine:
        "node /x/.vscode/extensions/anthropic.claude-code-2.1.289/extension.js",
    },
    { name: "wrapper", commandLine: "/opt/claude --daemon" },
  ])
    assert.equal(
      adapter.assessProcesses(processes([process])).status,
      "running",
      JSON.stringify(process),
    );
});

test("Claude process inspection is fail-closed for incomplete, malformed and generic host snapshots", () => {
  assert.equal(
    adapter.assessProcesses(processes([{ name: "bash" }], false)).status,
    "unknown",
  );
  assert.equal(adapter.assessProcesses(processes([])).status, "unknown");
  assert.equal(
    adapter.assessProcesses(processes([{ name: "" }])).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses(processes([{ name: "bash\nclaude" }])).status,
    "unknown",
  );
  for (const name of ["node", "node.exe", "bun", "python3.12"]) {
    assert.equal(
      adapter.assessProcesses(processes([{ name }])).status,
      "unknown",
      name,
    );
    assert.equal(
      adapter.assessProcesses(
        processes([
          { name, commandLine: `${name} --unrecognized-sdk-wrapper` },
        ]),
      ).status,
      "unknown",
      name,
    );
  }
  assert.equal(
    adapter.assessProcesses(
      processes([
        { name: "bash", commandLine: "/bin/bash" },
        { name: "AgentVac" },
        { name: "launchd" },
      ]),
    ).status,
    "clear",
  );
  assert.equal(
    adapter.assessProcesses(processes([{ name: "claude" }], false)).status,
    "running",
  );
});

const RECENT = "debug/606fe658-aa9b-4739-af87-5c13469bb242.txt";
async function engineFixture(
  t: TestContext,
  check: () => Promise<ProcessStatus> = async () => ({
    status: "clear",
    details: "Synthetic process fixture.",
  }),
) {
  const { base, root } = await fixture(t);
  await put(root, LOG, 60);
  await put(root, RECENT, 1);
  const key = randomBytes(32);
  const engine = new AgentVacEngine(root, key, false, check, [], adapter);
  await engine.initialize();
  return { base, root, key, engine };
}

test("Claude dynamic exclusions preserve newest debug logs and all newest-mtime ties", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await adapter.protectedPaths!(root), []);
  const older = await put(root, LOG, 90);
  const newer = await put(root, RECENT, 60);
  assert.deepEqual(await adapter.protectedPaths!(root), [RECENT]);
  const newestTime = (await fs.stat(newer)).mtime;
  await fs.utimes(older, newestTime, newestTime);
  assert.deepEqual(
    (await adapter.protectedPaths!(root)).sort(),
    [LOG, RECENT].sort(),
  );
});

test("Claude dynamic exclusions block all debug data for session markers, daemon lock and unsafe markers", async (t) => {
  const { base, root } = await fixture(t);
  await put(root, LOG);
  await fs.mkdir(path.join(root, "sessions"));
  assert.deepEqual(await adapter.protectedPaths!(root), [LOG]);
  await put(
    root,
    `sessions/${UUID}.json`,
    900,
    "unknown marker; age does not prove inactive",
  );
  assert.deepEqual(
    (await adapter.protectedPaths!(root)).sort(),
    ["debug/", "projects/"].sort(),
  );
  await fs.rm(path.join(root, "sessions"), { recursive: true });
  await put(root, "daemon.lock", 900);
  assert.deepEqual(
    (await adapter.protectedPaths!(root)).sort(),
    ["debug/", "projects/"].sort(),
  );
  await fs.unlink(path.join(root, "daemon.lock"));
  await fs.mkdir(path.join(base, "external-sessions"));
  if (
    !(await symlink(
      t,
      path.join(base, "external-sessions"),
      path.join(root, "sessions"),
      true,
    ))
  )
    return;
  assert.deepEqual(
    (await adapter.protectedPaths!(root)).sort(),
    ["debug/", "projects/"].sort(),
  );
});

test("Claude scan keeps transcript contents unread, protects recent/latest logs and preserves unknown session formats", async (t) => {
  const { root, engine } = await engineFixture(t);
  await put(
    root,
    `projects/-home-demo/unknown-session-format.jsonl`,
    900,
    "do not inspect synthetic old prompt",
  );
  await put(
    root,
    "projects/-home-demo/recent.jsonl",
    1,
    "do not inspect synthetic recent prompt",
  );
  await put(root, "projects/-home-demo/memory/MEMORY.md", 900);
  await put(root, ".credentials.json", 900);
  await put(root, "plugins/cache/test/config.json", 900);
  await put(root, "debug/unknown.log", 900);
  for (const includeSessions of [false, true]) {
    const result = await engine.scan({ minAgeDays: 30, includeSessions });
    assert.equal(result.provider, "claude-code");
    assert.deepEqual(
      result.entries
        .filter((entry) => entry.selectable)
        .map((entry) => entry.path),
      [LOG],
    );
    assert.ok(
      result.entries.some(
        (entry) =>
          (entry.path === "projects/-home-demo" ||
            entry.path === "projects/-home-demo/memory") &&
          entry.kind === "directory" &&
          !entry.selectable,
      ),
    );
    assert.ok(
      !result.entries.some((entry) => entry.path.endsWith("MEMORY.md")),
    );
    assert.ok(
      result.entries
        .filter((entry) => entry.path !== LOG)
        .every((entry) => !entry.selectable),
    );
  }
});

test("Claude scan protects hardlinked logs and never follows log symlinks", async (t) => {
  const { root, engine } = await engineFixture(t);
  await fs.link(path.join(root, LOG), path.join(root, "external-alias"));
  let result = await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(
    result.entries.find((entry) => entry.path === LOG)!.selectable,
    false,
  );
  await fs.unlink(path.join(root, LOG));
  if (
    !(await symlink(t, path.join(root, "external-alias"), path.join(root, LOG)))
  )
    return;
  result = await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(
    result.entries.find((entry) => entry.path === LOG)!.kind,
    "symlink",
  );
  assert.equal(
    result.entries.find((entry) => entry.path === LOG)!.selectable,
    false,
  );
});

test("Claude quarantine and restore use the shared same-volume journal and preserve exact bytes", async (t) => {
  const { root, key, engine } = await engineFixture(t);
  const bytes = Buffer.from([0, 1, 2, 10, 255, 128, 42]);
  await fs.writeFile(path.join(root, LOG), bytes);
  const older = new Date(Date.now() - 60 * DAY);
  await fs.utimes(path.join(root, LOG), older, older);
  const result = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const selected = result.entries.filter((entry) => entry.selectable);
  const preview = await engine.preview(selected.map((entry) => entry.id));
  assert.equal(preview.provider, "claude-code");
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1);
  await assert.rejects(fs.lstat(path.join(root, LOG)), { code: "ENOENT" });
  assert.equal(
    (await fs.stat(path.join(root, ".agentvac-quarantine"))).dev,
    (await fs.stat(root)).dev,
  );
  const reloaded = new AgentVacEngine(
    root,
    key,
    false,
    async () => ({ status: "clear", details: "Synthetic." }),
    [],
    adapter,
  );
  await reloaded.initialize();
  assert.equal((await reloaded.history())[0].provider, "claude-code");
  const restored = await reloaded.restore(moved.batchId, true);
  assert.equal(restored.completed, 1);
  assert.deepEqual(await fs.readFile(path.join(root, LOG)), bytes);
  assert.equal((await fs.stat(path.join(root, LOG))).nlink, 1);
});

test("Claude restore cannot overwrite a replacement at the original path", async (t) => {
  const { root, engine } = await engineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  await put(root, LOG, 60, "replacement must survive");
  const restored = await engine.restore(moved.batchId, true);
  assert.equal(restored.completed, 0);
  assert.equal(restored.failed.length, 1);
  assert.match(restored.failed[0].error, /覆盖|保护|日志/);
  assert.equal(
    await fs.readFile(path.join(root, LOG), "utf8"),
    "replacement must survive",
  );
});

test("Claude process unknown/running cannot be bypassed by manual confirmation", async (t) => {
  let status: ProcessStatus["status"] = "clear";
  const { root, engine } = await engineFixture(t, async () => ({
    status,
    details: "Synthetic process state.",
  }));
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  for (const blocked of ["unknown", "running"] as const) {
    status = blocked;
    const preview = await engine.preview(
      scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
    );
    await assert.rejects(engine.quarantine(preview.token, true), /进程|运行/);
    assert.ok(await fs.lstat(path.join(root, LOG)));
  }
  status = "clear";
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  status = "unknown";
  await assert.rejects(engine.restore(moved.batchId, true), /进程/);
});

test("Claude activity markers introduced after preview prevent quarantine", async (t) => {
  const { root, engine } = await engineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  await put(root, "daemon.lock");
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 0);
  assert.equal(moved.failed.length, 1);
  assert.ok(await fs.lstat(path.join(root, LOG)));
});

test("Claude root marker changes after scan invalidate further preview", async (t) => {
  const { root, engine } = await engineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  await put(root, "auth.json");
  await assert.rejects(
    engine.preview(
      scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
    ),
    /其他助手/,
  );
});

test("Claude restore remains blocked when an activity marker appears after quarantine", async (t) => {
  const { root, engine } = await engineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  await put(root, "daemon.lock");
  await assert.rejects(engine.restore(moved.batchId, true), /保护|活动/);
  await assert.rejects(fs.lstat(path.join(root, LOG)), { code: "ENOENT" });
  await fs.unlink(path.join(root, "daemon.lock"));
  assert.equal((await engine.restore(moved.batchId, true)).completed, 1);
});

test("Claude ordinary scan performs no file-content reads", async (t) => {
  const { engine } = await engineFixture(t);
  const noRead = () => {
    throw new Error("Ordinary scan must not open file content.");
  };
  const readFile = t.mock.method(fs, "readFile", noRead);
  const open = t.mock.method(fs, "open", noRead);
  await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(readFile.mock.callCount(), 0);
  assert.equal(open.mock.callCount(), 0);
  readFile.mock.restore();
  open.mock.restore();
});

test("Claude process matching clears minimal attributed unrelated runtimes", () => {
  for (const record of [
    { name: "node", commandLine: "/usr/bin/node /work/server.js" },
    {
      name: "node.exe",
      commandLine:
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\server.js"',
    },
    { name: "python3", commandLine: "/usr/bin/python3 /work/unrelated.py" },
    { name: "bash", commandLine: "/bin/bash -c 'echo claude-code'" },
    {
      name: "AgentVac",
      commandLine: "/Applications/AgentVac.app/Contents/MacOS/AgentVac",
    },
  ])
    assert.equal(
      adapter.assessProcesses({
        ...processes([record]),
        platform: record.name.endsWith(".exe") ? "win32" : "linux",
      }).status,
      "clear",
      JSON.stringify(record),
    );
  assert.equal(
    adapter.assessProcesses(
      processes([
        { name: "node", commandLine: "node -e \"console.log('claude-code')\"" },
      ]),
    ).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses(
      processes([
        {
          name: "node",
          commandLine:
            "node --require @anthropic-ai/claude-agent-sdk /work/app.js",
        },
      ]),
    ).status,
    "running",
  );
  for (const name of ["Code", "Code Helper", "Cursor", "Windsurf", "zed"])
    assert.equal(
      adapter.assessProcesses(processes([{ name }])).status,
      "unknown",
    );
});

const SESSION = `projects/-home-demo-work/${UUID}.jsonl`;
const TREE = SESSION.slice(0, -6);
const SESSION_NEW =
  "projects/-home-demo-work/606fe658-aa9b-4739-af87-5c13469bb242.jsonl";
const sessionAdapter = {
  ...adapter,
  cleanupUnit: sessionPolicy.cleanupUnit,
  unitEntryAllowed: sessionPolicy.unitEntryAllowed,
};
async function sessionFixture(t: TestContext) {
  const value = await fixture(t);
  await put(value.root, SESSION, 60);
  await put(value.root, SESSION_NEW, 1);
  return value;
}

test("Claude SDK unit descriptor remains deterministic with absent optional directory and absent restore anchor", async () => {
  const definition = await sessionPolicy.cleanupUnit(
    SESSION,
    "/synthetic/not-accessed",
  );
  assert.deepEqual(definition, {
    policy: "claude-sdk-session-v1",
    kind: "bundle",
    members: [
      { path: SESSION, kind: "file" },
      { path: TREE, kind: "directory", optional: true },
    ],
  });
  for (const invalid of [
    "projects/proj/memory/MEMORY.md",
    "projects/proj/unknown.jsonl",
    "projects/proj/../file",
    `projects/proj/${UUID}.jsonl.superseded-123`,
    `projects/proj/${UUID}.orphaned-123-x.jsonl`,
  ])
    assert.equal(
      await sessionPolicy.cleanupUnit(invalid, "/not-accessed"),
      null,
      invalid,
    );
});

test("Claude session unit accepts documented subagent, metadata, workflow and tool-result members only", () => {
  for (const [relative, kind] of [
    [SESSION, "file"],
    [TREE, "directory"],
    [`${TREE}/subagents`, "directory"],
    [`${TREE}/tool-results`, "directory"],
    [`${TREE}/${UUID}.jsonl`, "file"],
    [`${TREE}/subagents/agent-abc123.jsonl`, "file"],
    [`${TREE}/subagents/agent-abc123.meta.json`, "file"],
    [`${TREE}/subagents/workflows`, "directory"],
    [`${TREE}/subagents/workflows/run-1`, "directory"],
    [`${TREE}/subagents/workflows/run-1/agent-abc123.jsonl`, "file"],
    [`${TREE}/tool-results/toolu_abc123.txt`, "file"],
    [`${TREE}/tool-results/toolu_abc123.png`, "file"],
  ] as const)
    assert.equal(
      sessionPolicy.unitEntryAllowed(sessionPolicy.policy, relative, kind),
      true,
      relative,
    );
  for (const [relative, kind] of [
    [`${TREE}/memory`, "directory"],
    [`${TREE}/config.json`, "file"],
    [`${TREE}/subagents/readme.md`, "file"],
    [`${TREE}/tool-results/credentials.txt`, "file"],
    [`${TREE}/tool-results/.env`, "file"],
    [`${TREE}/tool-results/script.js`, "file"],
    [`${TREE}/tool-results/database.sqlite`, "file"],
    [`${TREE}/tool-results/outside/file.txt`, "file"],
    [`${TREE}/tool-results/anything.pdf`, "file"],
    ["projects/-home-demo-work/memory/MEMORY.md", "file"],
    ["history.jsonl", "file"],
    [".credentials.json", "file"],
  ] as const)
    assert.equal(
      sessionPolicy.unitEntryAllowed(sessionPolicy.policy, relative, kind),
      false,
      relative,
    );
  assert.equal(
    sessionPolicy.unitEntryAllowed("unknown-policy", SESSION, "file"),
    false,
  );
});

test("Claude session metadata guards retain newest, duplicates and legacy-index projects", async (t) => {
  const { root } = await sessionFixture(t);
  let protectedPaths = await sessionPolicy.protectedPaths(root);
  assert.ok(protectedPaths.includes(SESSION_NEW));
  assert.ok(!protectedPaths.includes(SESSION));
  await put(root, `projects/-other/${UUID}.jsonl`, 90);
  protectedPaths = await sessionPolicy.protectedPaths(root);
  assert.ok(protectedPaths.includes(SESSION));
  assert.ok(protectedPaths.includes(`projects/-other/${UUID}.jsonl`));
  await put(root, "projects/-home-demo-work/sessions-index.json");
  protectedPaths = await sessionPolicy.protectedPaths(root);
  assert.ok(protectedPaths.includes("projects/-home-demo-work/"));
});

test("Claude session metadata guards retain uncertain jobs, active markers and unknown correlated sidecars", async (t) => {
  const { root } = await sessionFixture(t);
  await put(root, SESSION + ".superseded-123", 900);
  assert.ok((await sessionPolicy.protectedPaths(root)).includes(SESSION));
  await put(root, "jobs/job/state.json", 900, "state must not be read");
  assert.deepEqual(await sessionPolicy.protectedPaths(root), ["projects/"]);
  await fs.rm(path.join(root, "jobs"), { recursive: true });
  await put(root, "daemon.lock", 900);
  assert.deepEqual(await sessionPolicy.protectedPaths(root), ["projects/"]);
});

test("Claude coherent-unit capture includes transcript and all documented companion bytes without reading contents", async (t) => {
  const { root } = await sessionFixture(t);
  await put(
    root,
    `${TREE}/subagents/agent-a.jsonl`,
    60,
    "synthetic subagent bytes",
  );
  await put(
    root,
    `${TREE}/subagents/agent-a.meta.json`,
    60,
    "synthetic metadata bytes",
  );
  await put(
    root,
    `${TREE}/tool-results/toolu_a.txt`,
    60,
    "synthetic spilled output",
  );
  const definition = (await sessionPolicy.cleanupUnit(SESSION, root))!;
  const readFile = t.mock.method(fs, "readFile", () => {
    throw new Error("Must not read prompt content.");
  });
  const snapshot = await captureUnit(root, definition, sessionAdapter);
  assert.equal(snapshot.fileCount, 4);
  assert.equal(snapshot.directoryCount, 3);
  assert.equal(snapshot.absent.length, 0);
  assert.equal(readFile.mock.callCount(), 0);
  readFile.mock.restore();
  const before = await captureUnit(root, definition, sessionAdapter);
  await put(root, `${TREE}/tool-results/toolu_b.txt`, 60);
  const after = await captureUnit(root, definition, sessionAdapter);
  assert.equal(sameUnit(before, after), false);
});

test("Claude coherent-unit capture rejects entire units containing unknown, credential, linked or hardlinked members", async (t) => {
  const { root } = await sessionFixture(t);
  const definition = (await sessionPolicy.cleanupUnit(SESSION, root))!;
  for (const member of [
    `${TREE}/unknown.txt`,
    `${TREE}/tool-results/credentials.txt`,
  ]) {
    await put(root, member);
    await assert.rejects(
      captureUnit(root, definition, sessionAdapter),
      /未知|类型/,
    );
    await fs.unlink(path.join(root, member));
  }
  const member = await put(root, `${TREE}/tool-results/toolu_a.txt`);
  await fs.link(member, path.join(root, "other-link"));
  await assert.rejects(captureUnit(root, definition, sessionAdapter), /链接/);
  await fs.unlink(member);
  if (!(await symlink(t, path.join(root, "other-link"), member))) return;
  await assert.rejects(captureUnit(root, definition, sessionAdapter), /链接/);
});

async function sessionEngineFixture(t: TestContext, withCompanion = true) {
  const { base, root } = await sessionFixture(t);
  const contents: Record<string, string> = {
    [SESSION]: "main transcript bytes, opaque to scanner\n",
  };
  await put(root, SESSION, 60, contents[SESSION]);
  if (withCompanion) {
    contents[`${TREE}/subagents/agent-a.jsonl`] = "subagent transcript bytes\n";
    contents[`${TREE}/subagents/agent-a.meta.json`] = "metadata bytes\n";
    contents[`${TREE}/tool-results/toolu_a.txt`] = "tool result bytes\n";
    for (const [name, content] of Object.entries(contents))
      await put(root, name, 60, content);
    const old = new Date(Date.now() - 60 * DAY);
    for (const directory of [`${TREE}/subagents`, `${TREE}/tool-results`, TREE])
      await fs.utimes(path.join(root, directory), old, old);
  }
  await put(
    root,
    "projects/-home-demo-work/memory/MEMORY.md",
    900,
    "permanent memory must survive",
  );
  const key = randomBytes(32);
  const engine = new AgentVacEngine(
    root,
    key,
    false,
    async () => ({ status: "clear", details: "Synthetic fixture." }),
    [],
    adapter,
  );
  await engine.initialize();
  return { base, root, key, engine, contents };
}

test("Claude live adapter offers an old complete session unit only with explicit session review", async (t) => {
  const { engine } = await sessionEngineFixture(t);
  assert.equal(adapter.supportsSessionCleanup, true);
  let scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
  assert.equal(scan.entries.filter((entry) => entry.selectable).length, 0);
  scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.deepEqual(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.path),
    [SESSION],
  );
  const row = scan.entries.find((entry) => entry.path === SESSION)!;
  assert.equal(row.cleanupUnit?.kind, "bundle");
  assert.equal(row.cleanupUnit?.fileCount, 4);
  assert.equal(row.cleanupUnit?.directoryCount, 3);
  assert.ok(
    !scan.entries.some(
      (entry) => entry.path === TREE || entry.path.startsWith(TREE + "/"),
    ),
  );
  assert.equal(
    scan.entries.find((entry) => entry.path === SESSION_NEW)!.selectable,
    false,
  );
});

test("Claude complete session bundle quarantine and restart restore preserve all bytes and global history/memory", async (t) => {
  const { root, key, engine, contents } = await sessionEngineFixture(t);
  const historyBefore = await fs.readFile(path.join(root, "history.jsonl"));
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  assert.equal(preview.items.length, 1);
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1);
  await assert.rejects(fs.lstat(path.join(root, SESSION)), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(root, TREE)), { code: "ENOENT" });
  assert.deepEqual(
    await fs.readFile(path.join(root, "history.jsonl")),
    historyBefore,
  );
  assert.equal(
    await fs.readFile(
      path.join(root, "projects/-home-demo-work/memory/MEMORY.md"),
      "utf8",
    ),
    "permanent memory must survive",
  );
  const reloaded = new AgentVacEngine(
    root,
    key,
    false,
    async () => ({ status: "clear", details: "Synthetic fixture." }),
    [],
    adapter,
  );
  await reloaded.initialize();
  const restored = await reloaded.restore(moved.batchId, true);
  assert.equal(restored.completed, 1, JSON.stringify(restored));
  for (const [name, content] of Object.entries(contents)) {
    assert.equal(
      await fs.readFile(path.join(root, name), "utf8"),
      content,
      name,
    );
    assert.equal((await fs.stat(path.join(root, name))).nlink, 1, name);
  }
  assert.deepEqual(
    await fs.readFile(path.join(root, "history.jsonl")),
    historyBefore,
  );
});

test("Claude transcript-only unit snapshots optional sibling absence and refuses newly attached companions", async (t) => {
  const { root, engine } = await sessionEngineFixture(t, false);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const row = scan.entries.find((entry) => entry.path === SESSION)!;
  assert.equal(row.cleanupUnit?.fileCount, 1);
  assert.equal(row.cleanupUnit?.directoryCount, 0);
  await put(root, `${TREE}/subagents/agent-added.jsonl`, 60);
  await assert.rejects(engine.preview([row.id]), /变化|改变/);
  assert.ok(await fs.lstat(path.join(root, SESSION)));
});

test("Claude restore preflights companion conflicts before exposing any transcript", async (t) => {
  const { root, engine } = await sessionEngineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  await put(
    root,
    `${TREE}/replacement.txt`,
    60,
    "replacement sibling is not overwritten",
  );
  const restored = await engine.restore(moved.batchId, true);
  assert.equal(restored.completed, 0);
  assert.equal(restored.failed.length, 1);
  await assert.rejects(fs.lstat(path.join(root, SESSION)), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(root, `${TREE}/replacement.txt`), "utf8"),
    "replacement sibling is not overwritten",
  );
  await fs.rm(path.join(root, TREE), { recursive: true });
  assert.equal((await engine.restore(moved.batchId, true)).completed, 1);
});

test("Claude recent or unknown companion protects the whole session unit rather than a subset", async (t) => {
  const { root, engine } = await sessionEngineFixture(t);
  await put(root, `${TREE}/subagents/agent-a.meta.json`, 1);
  let scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(
    scan.entries.find((entry) => entry.path === SESSION)!.selectable,
    false,
  );
  await put(root, `${TREE}/tool-results/credentials.txt`, 60);
  scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  assert.equal(
    scan.entries.find((entry) => entry.path === SESSION)!.selectable,
    false,
  );
  assert.ok(
    !scan.entries.some(
      (entry) => entry.path.startsWith(TREE + "/") && entry.selectable,
    ),
  );
});

test("Claude legacy flat subagent transcripts block project units instead of guessing parent associations", async (t) => {
  const { root } = await sessionFixture(t);
  await put(root, "projects/-home-demo-work/agent-legacy.jsonl", 900);
  assert.ok(
    (await sessionPolicy.protectedPaths(root)).includes(
      "projects/-home-demo-work/",
    ),
  );
});

test("Claude bundle ordinary failure rolls back the transcript if moving companion fails", async (t) => {
  const { root, engine, contents } = await sessionEngineFixture(t);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const preview = await engine.preview(
    scan.entries.filter((entry) => entry.selectable).map((entry) => entry.id),
  );
  const original = fs.rename;
  const rename = t.mock.method(
    fs,
    "rename",
    async (source: PathLike, destination: PathLike) => {
      if (source === path.join(root, TREE))
        throw Object.assign(new Error("Synthetic companion move failure"), {
          code: "EIO",
        });
      return original(source, destination);
    },
  );
  const result = await engine.quarantine(preview.token, true);
  rename.mock.restore();
  assert.equal(result.completed, 0);
  assert.equal(result.failed.length, 1);
  for (const [name, content] of Object.entries(contents))
    assert.equal(
      await fs.readFile(path.join(root, name), "utf8"),
      content,
      name,
    );
});

test("Claude unsupported platforms and malformed command-line snapshots fail closed", () => {
  assert.deepEqual(
    adapter.discover({ home: "/home/demo", platform: "freebsd", env: {} }),
    [],
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "freebsd",
      complete: true,
      processes: [{ name: "bash" }],
    }).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses(
      processes([{ name: "bash", commandLine: "/bin/bash\0hidden" }]),
    ).status,
    "unknown",
  );
});

// POSIX ps cannot preserve argv boundaries; no new suffixless attribution may
// turn these ambiguous or platform-relative paths into proof of an unrelated host.
test("raw POSIX Python text cannot authorize suffixless or Windows-looking entrypoints", () => {
  for (const commandLine of [
    "/usr/bin/python3 /tmp/synthetic application/claude_agent_sdk/launch",
    "/usr/bin/python3 C:\\work\\application",
    "/usr/bin/python3 /tmp/synthetic --hidden/claude_agent_sdk/launch",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name: "python3", commandLine }],
      }).status,
      "unknown",
    );
});

test("unsupported Python-family names do not clear inline or unattributed code", () => {
  for (const name of ["python3t", "pythonw3.13", "pythonw3.exe"]) {
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name, commandLine: name + " -c arbitrary" }],
      }).status,
      "unknown",
    );
  }
});

test("known Python SDK direct/module operands remain running before unrelated attribution", () => {
  for (const commandLine of [
    "python3 -m claude_agent_sdk",
    "python3 -m claude_agent_sdk.cli",
    "python3 /opt/claude_agent_sdk/__main__.py",
    "python3 -W ignore /opt/claude_agent_sdk/__main__.py",
    "python3 -X utf8 /opt/claude_agent_sdk/__main__.py",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name: "python3", commandLine }],
      }).status,
      "running",
    );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [
        {
          name: "python3",
          commandLine:
            "python3 /work/unrelated.py /opt/claude_agent_sdk/__main__.py",
        },
      ],
    }).status,
    "unknown",
  );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "python3", commandLine: "python3 -m http.server" }],
    }).status,
    "unknown",
  );
});

test("Python-specific options never create new clear states and later -m stays a script literal", () => {
  for (const commandLine of [
    "python3 -W claude /opt/unrelated.py",
    "python3 -X claude /opt/unrelated.py",
  ])
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name: "python3", commandLine }],
      }).status,
      "unknown",
    );
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [
        {
          name: "python3",
          commandLine: "python3 /opt/unrelated.py -m claude_agent_sdk",
        },
      ],
    }).status,
    "unknown",
  );
});

test("raw POSIX later literals stay unknown rather than being attributed to a SDK or an unrelated script", () => {
  const commandLine =
    "/usr/bin/node /work/test.js 'claude-code' '/x/@anthropic-ai/claude-code/cli.js'";
  assert.equal(
    adapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "node", commandLine }],
    }).status,
    "unknown",
  );
});
