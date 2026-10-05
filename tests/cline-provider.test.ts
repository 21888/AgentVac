import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { clineAdapter } from "../electron/providers/cline.js";
import { AgentVacEngine } from "../electron/engine.js";
import type { ProcessStatus } from "../shared/types.js";

const DAY = 86_400_000;
const OLD = "1740000000000_abc12";
const LATEST = "1750000000000_def34";
const clear = async (): Promise<ProcessStatus> => ({
  status: "clear",
  details: "synthetic stopped process fixture",
});
async function put(
  root: string,
  rel: string,
  age = 90,
  bytes: string | Buffer = "synthetic invalid JSON; never parse me",
) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  const modified = new Date(Date.now() - age * DAY);
  await fs.utimes(file, modified, modified);
  return file;
}
async function session(root: string, id: string, age = 90) {
  await put(root, `sessions/${id}/${id}.json`, age);
  await put(root, `sessions/${id}/${id}.messages.json`, age);
  return put(
    root,
    `sessions/${id}/hooks.jsonl`,
    age,
    Buffer.from([0, 255, 1, 128, 10, 65]),
  );
}
async function fixture(t: any, demo = true, check = clear) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-cline-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, ".cline", "data");
  await put(root, "globalState.json");
  await put(root, "db/sessions.db");
  await session(root, OLD, 90);
  await session(root, LATEST, 60);
  const key = randomBytes(32);
  const engine = new AgentVacEngine(root, key, demo, check, [], clineAdapter);
  await engine.initialize();
  return { base, root, key, engine };
}
async function scan(engine: AgentVacEngine, minAgeDays = 30) {
  return engine.scan({ minAgeDays, includeSessions: true });
}
async function link(t: any, target: string, destination: string) {
  try {
    await fs.symlink(target, destination, "junction");
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

test("Cline discovers platform-specific shared and official VS Code roots without reading storage", () => {
  const cases: Array<
    [NodeJS.Platform, string, Record<string, string>, string]
  > = [
    [
      "darwin",
      "/Users/alice",
      {},
      "/Users/alice/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev",
    ],
    [
      "linux",
      "/home/alice",
      {},
      "/home/alice/.config/Code/User/globalStorage/saoudrizwan.claude-dev",
    ],
    [
      "linux",
      "/home/alice",
      { XDG_CONFIG_HOME: "/custom/config" },
      "/custom/config/Code/User/globalStorage/saoudrizwan.claude-dev",
    ],
    [
      "win32",
      "C:\\Users\\alice",
      { APPDATA: "D:\\Roaming" },
      "D:\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev",
    ],
  ];
  for (const [platform, home, env, expected] of cases) {
    const candidates = clineAdapter.discover({ platform, home, env });
    assert.ok(
      candidates.some((c) => c.path === expected),
      expected,
    );
    assert.ok(candidates.some((c) => c.source === "default"));
    assert.ok(
      candidates.every(
        (c) => c.provider === "cline" && !/roo-cline|kilo-code/.test(c.path),
      ),
    );
  }
});

test("Cline handles documented data and VS Code portable/appdata overrides, ignores relative roots", () => {
  const candidates = clineAdapter.discover({
    platform: "linux",
    home: "/home/a",
    env: {
      CLINE_DATA_DIR: " /storage/cline-data ",
      CLINE_DIR: "/ignored",
      VSCODE_PORTABLE: "/portable/data",
      VSCODE_APPDATA: "/apps",
    },
  });
  assert.ok(candidates.some((c) => c.path === "/storage/cline-data"));
  assert.ok(!candidates.some((c) => c.path.startsWith("/ignored")));
  assert.ok(
    candidates.some(
      (c) =>
        c.path ===
        "/portable/data/user-data/User/globalStorage/saoudrizwan.claude-dev",
    ),
  );
  assert.ok(
    candidates.some(
      (c) => c.path === "/apps/Code/User/globalStorage/saoudrizwan.claude-dev",
    ),
  );
  const relative = clineAdapter.discover({
    platform: "linux",
    home: "/home/a",
    env: { CLINE_DATA_DIR: "relative/path" },
  });
  assert.ok(relative.every((c) => c.source !== "CLINE_DATA_DIR"));
  assert.deepEqual(
    clineAdapter.discover({ platform: "freebsd", home: "/home/a", env: {} }),
    [],
  );
});

test("Cline metadata validator accepts explicit profiles, portable, remote and compatible-editor extension roots", async (t) => {
  const { base } = await fixture(t);
  for (const parent of [
    "Code/User",
    "Code/User/profiles/abc123",
    "portable/data/user-data/User",
    ".vscode-server/data/User",
    "Cursor/User",
  ]) {
    const root = path.join(
      base,
      parent,
      "globalStorage/saoudrizwan.claude-dev",
    );
    await fs.mkdir(path.join(root, "tasks"), { recursive: true });
    await put(root, "state/taskHistory.json");
    await clineAdapter.validateRoot(root);
    assert.equal(clineAdapter.canTraverse("tasks", root), false);
    assert.equal(
      clineAdapter.classify(`sessions/${OLD}/hooks.jsonl`, root).risk,
      "protected",
    );
  }
});

test("Cline rejects empty, broad, foreign, incomplete and unrecognized roots", async (t) => {
  const { base } = await fixture(t);
  for (const name of [
    "empty",
    ".codex",
    ".claude",
    ".cursor",
    "Cursor/User",
    "globalStorage/rooveterinaryinc.roo-cline",
    "globalStorage/other.extension",
  ]) {
    const root = path.join(base, name);
    await fs.mkdir(root, { recursive: true });
    if (name !== "empty" && name !== "Cursor/User") {
      await put(root, "globalState.json");
      await put(root, "db/sessions.db");
      await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    }
    await assert.rejects(
      clineAdapter.validateRoot(root),
      { name: "Error" },
      name,
    );
  }
  await assert.rejects(clineAdapter.validateRoot(base));
  await assert.rejects(clineAdapter.validateRoot(path.parse(base).root));
});

test("Cline permits relocated data only with complete independent ordinary-file markers", async (t) => {
  const { base } = await fixture(t);
  const root = path.join(base, "custom-data");
  await put(root, "globalState.json");
  await put(root, "db/sessions.db");
  await fs.mkdir(path.join(root, "sessions"));
  await clineAdapter.validateRoot(root);
  await fs.link(
    path.join(root, "globalState.json"),
    path.join(base, "same-state"),
  );
  await assert.rejects(clineAdapter.validateRoot(root));
});

test("Cline root, marker and ancestor links are refused without following contents", async (t) => {
  const { root, base, key } = await fixture(t);
  if (!(await link(t, root, path.join(base, "alias")))) return;
  await assert.rejects(clineAdapter.validateRoot(path.join(base, "alias")));
  const aliased = new AgentVacEngine(
    path.join(base, "alias"),
    key,
    true,
    clear,
    [],
    clineAdapter,
  );
  await assert.rejects(aliased.initialize());
  await fs.rename(path.join(root, "db"), path.join(base, "original-db"));
  if (!(await link(t, path.join(base, "original-db"), path.join(root, "db"))))
    return;
  await assert.rejects(clineAdapter.validateRoot(root));
});

test("Cline only classifies explicit archived per-session telemetry with a bound modern root", () => {
  const root = "/home/synthetic/.cline/data";
  assert.equal(
    clineAdapter.classify(`sessions/${OLD}/hooks.jsonl`, root).risk,
    "review",
  );
  assert.equal(
    clineAdapter.classify(`sessions/${OLD}/hooks.jsonl`).risk,
    "protected",
  );
  for (const rel of [
    `sessions/${OLD}/${OLD}.messages.json`,
    `sessions/${OLD}/${OLD}.json`,
    `sessions/${OLD}/${OLD}.compaction.json`,
    `tasks/${OLD}/api_conversation_history.json`,
    `tasks/${OLD}/ui_messages.json`,
    `tasks/${OLD}/task_metadata.json`,
    "state/taskHistory.json",
    "checkpoints/a/.git/HEAD",
    "settings/cline_mcp_settings.json",
    "globalState.json",
    "secrets.json",
    "db/sessions.db",
    "db/sessions.db-wal",
    "db/sessions.db-shm",
    "providers.json",
    "skills/example/SKILL.md",
    "memories/memory.md",
    "logs/hooks.jsonl",
    "logs/cline.log",
    "logs/code.log",
    "logs/cline.log.1",
    "sessions/custom/hooks.jsonl",
    `sessions/${OLD}/hooks.jsonl.gz`,
    `sessions/${OLD}/nested/hooks.jsonl`,
    "../hooks.jsonl",
    "/hooks.jsonl",
    "C:/hooks.jsonl",
    "sessions\\hooks.jsonl",
    "sessions//hooks.jsonl",
  ])
    assert.equal(clineAdapter.classify(rel, root).risk, "protected", rel);
  assert.equal(clineAdapter.canTraverse("sessions", root), true);
  assert.equal(clineAdapter.canTraverse(`sessions/${OLD}`, root), true);
  for (const rel of [
    "tasks",
    "logs",
    "settings",
    "workspaces",
    "sessions/custom",
    `sessions/${OLD}/nested`,
    "../sessions",
  ])
    assert.equal(clineAdapter.canTraverse(rel, root), false, rel);
});

test("Cline scan is metadata-only; old paired telemetry eligible, latest and recent sessions protected", async (t) => {
  const { root, engine } = await fixture(t);
  await put(root, "secrets.json", 90, "synthetic secret placeholder");
  await put(root, "logs/hooks.jsonl", 90);
  const readGuard = t.mock.method(fs, "readFile", async () => {
    throw new Error("scan attempted a content read");
  });
  const result = await scan(engine);
  readGuard.mock.restore();
  assert.deepEqual(
    result.entries.filter((e) => e.selectable).map((e) => e.path),
    [`sessions/${OLD}/hooks.jsonl`],
  );
  assert.ok(
    result.entries.some(
      (e) => e.path === `sessions/${LATEST}` && !e.selectable,
    ),
  );
  assert.ok(
    result.entries.some((e) => e.path === "db/sessions.db" && !e.selectable),
  );
  await put(root, `sessions/${OLD}/${OLD}.messages.json`, 2);
  assert.ok(
    (await scan(engine, 1)).entries
      .filter((e) => e.selectable)
      .every((e) => !e.path.startsWith(`sessions/${OLD}/`)),
  );
});

test("Cline missing canonical companions and unknown session IDs remain protected", async (t) => {
  const { root, engine } = await fixture(t);
  await fs.unlink(path.join(root, `sessions/${OLD}/${OLD}.json`));
  await put(root, "sessions/unknown/hooks.jsonl", 90);
  assert.equal(
    (await scan(engine)).entries.filter((e) => e.selectable).length,
    0,
  );
});

test("Cline retains every most-recent session when canonical modification timestamps tie", async (t) => {
  const { root, engine } = await fixture(t);
  const time = new Date(Date.now() - 90 * DAY);
  for (const id of [OLD, LATEST])
    for (const suffix of [".json", ".messages.json"])
      await fs.utimes(
        path.join(root, `sessions/${id}/${id}${suffix}`),
        time,
        time,
      );
  assert.equal(
    (await scan(engine)).entries.filter((e) => e.selectable).length,
    0,
  );
});

test("Cline old telemetry cannot bypass the selected age filter", async (t) => {
  const { engine } = await fixture(t);
  assert.equal(
    (await scan(engine, 365)).entries.filter((e) => e.selectable).length,
    0,
  );
});

test("Cline hard-linked telemetry and linked session directories are protected", async (t) => {
  const { root, base, engine } = await fixture(t);
  await fs.link(
    path.join(root, `sessions/${OLD}/hooks.jsonl`),
    path.join(base, "hook-copy"),
  );
  assert.equal(
    (await scan(engine)).entries.filter((e) => e.selectable).length,
    0,
  );
  const external = path.join(base, "external-session");
  await fs.rename(path.join(root, `sessions/${OLD}`), external);
  if (!(await link(t, external, path.join(root, `sessions/${OLD}`)))) return;
  assert.equal(
    (await scan(engine)).entries.filter((e) => e.selectable).length,
    0,
  );
});

test("Cline quarantine/restore preserves exact telemetry bytes and every canonical companion", async (t) => {
  const { root, engine } = await fixture(t);
  const hooks = path.join(root, `sessions/${OLD}/hooks.jsonl`);
  const manifest = path.join(root, `sessions/${OLD}/${OLD}.json`);
  const messages = path.join(root, `sessions/${OLD}/${OLD}.messages.json`);
  const before = await Promise.all(
    [
      hooks,
      manifest,
      messages,
      path.join(root, "db/sessions.db"),
      path.join(root, "globalState.json"),
    ].map((p) => fs.readFile(p)),
  );
  const preview = await engine.preview(
    (await scan(engine)).entries.filter((e) => e.selectable).map((e) => e.id),
  );
  assert.equal(preview.provider, "cline");
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1);
  await assert.rejects(fs.lstat(hooks));
  assert.deepEqual(await fs.readFile(manifest), before[1]);
  assert.deepEqual(await fs.readFile(messages), before[2]);
  const restored = await engine.restore(moved.batchId);
  assert.equal(restored.completed, 1);
  assert.deepEqual(
    await Promise.all(
      [
        hooks,
        manifest,
        messages,
        path.join(root, "db/sessions.db"),
        path.join(root, "globalState.json"),
      ].map((p) => fs.readFile(p)),
    ),
    before,
  );
});

test("Cline activity changed after preview blocks quarantine without mutating transcript or log", async (t) => {
  const { root, engine } = await fixture(t);
  const hooks = path.join(root, `sessions/${OLD}/hooks.jsonl`);
  const before = await fs.readFile(hooks);
  const preview = await engine.preview(
    (await scan(engine)).entries.filter((e) => e.selectable).map((e) => e.id),
  );
  await put(root, `sessions/${OLD}/${OLD}.messages.json`, 0);
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 0);
  assert.deepEqual(await fs.readFile(hooks), before);
});

test("Cline unknown process inspection blocks a real-mode synthetic mutation", async (t) => {
  const { root, engine } = await fixture(t, false, async () => ({
    status: "unknown",
    details: "synthetic incomplete enumeration",
  }));
  const preview = await engine.preview(
    (await scan(engine)).entries.filter((e) => e.selectable).map((e) => e.id),
  );
  await assert.rejects(engine.quarantine(preview.token, true), /进程状态/);
  assert.ok(await fs.lstat(path.join(root, `sessions/${OLD}/hooks.jsonl`)));
});

test("Cline fail-closed process detection recognizes editors, extension paths and generic SDK hosts", () => {
  for (const name of [
    "cline",
    "cline-code",
    "Code",
    "Code - Insiders.exe",
    "Code Helper (Plugin)",
    "Cursor.exe",
    "VSCodium",
    "idea64.exe",
    "WebStorm",
    "rustrover",
  ])
    assert.equal(
      clineAdapter.assessProcesses({
        platform: "win32",
        complete: true,
        processes: [{ name }],
      }).status,
      "running",
      name,
    );
  for (const name of [
    "node",
    "node.exe",
    "bun",
    "java",
    "javaw.exe",
    "electron",
    "deno",
  ])
    assert.equal(
      clineAdapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name }],
      }).status,
      "unknown",
      name,
    );
  assert.equal(
    clineAdapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [
        {
          name: "worker",
          commandLine: "node /extensions/saoudrizwan.claude-dev/extension.js",
        },
      ],
    }).status,
    "running",
  );
  assert.equal(
    clineAdapter.assessProcesses({
      platform: "linux",
      complete: false,
      processes: [{ name: "bash" }],
    }).status,
    "unknown",
  );
  assert.equal(
    clineAdapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [],
    }).status,
    "unknown",
  );
  assert.equal(
    clineAdapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "" }],
    }).status,
    "unknown",
  );
  assert.equal(
    clineAdapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "bash" }, { name: "AgentVac" }],
    }).status,
    "clear",
  );
});

test("Cline permits attributable unrelated development processes while rejecting eval-only ambiguity", () => {
  for (const record of [
    {
      name: "node",
      commandLine: "/usr/bin/node /workspace/project/dev-server.mjs --watch",
    },
    {
      name: "node.exe",
      commandLine:
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\site\\server.js"',
    },
    { name: "java", commandLine: "/usr/bin/java -jar /opt/company/server.jar" },
    {
      name: "AgentVac",
      commandLine: "/Applications/AgentVac.app/Contents/MacOS/AgentVac",
    },
  ])
    assert.equal(
      clineAdapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [record],
      }).status,
      "clear",
    );
  for (const commandLine of [
    "node -e 'require(\"@cline/core\")'",
    "node -e 'console.log(1)'",
    "node server.js",
    "bun run dev",
    "java",
  ]) {
    assert.notEqual(
      clineAdapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name: "node", commandLine }],
      }).status,
      "clear",
    );
  }
});

test("Cline source-backed legacy catalog units restore exactly and never admit config or unknown caches", async (t) => {
  const { base, key } = await fixture(t);
  const root = path.join(
    base,
    "Code/User/globalStorage/saoudrizwan.claude-dev",
  );
  await fs.mkdir(path.join(root, "tasks"), { recursive: true });
  await put(root, "state/taskHistory.json");
  const files = [
    "openrouter_models.json",
    "vercel_ai_gateway_models.json",
    "groq_models.json",
    "cline_recommended_models.json",
  ];
  for (const file of files)
    await put(root, `cache/${file}`, 90, `synthetic catalog ${file}`);
  for (const rel of [
    "cache/remote_config_org.json",
    "cache/cline_mcp_settings.json",
    "cache/auth.json",
    "cache/unknown.json",
    "cache/nested/openrouter_models.json",
  ])
    await put(root, rel);
  const engine = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await engine.initialize();
  const result = await scan(engine);
  const eligible = result.entries.filter((e) => e.selectable);
  assert.deepEqual(
    eligible.map((e) => e.path).sort(),
    files.map((f) => `cache/${f}`).sort(),
  );
  for (const entry of eligible) {
    assert.equal(entry.category, "cache");
    assert.equal(entry.risk, "review");
    assert.equal(entry.cleanupUnit?.fileCount, 1);
    assert.equal(entry.cleanupUnit?.directoryCount, 0);
  }
  const preview = await engine.preview(eligible.map((e) => e.id));
  const archived = await engine.quarantine(preview.token, true);
  assert.equal(archived.completed, 4);
  for (const file of files)
    await assert.rejects(fs.lstat(path.join(root, `cache/${file}`)));
  const restored = await engine.restore(archived.batchId);
  assert.equal(restored.completed, 4);
  for (const file of files)
    assert.equal(
      await fs.readFile(path.join(root, `cache/${file}`), "utf8"),
      `synthetic catalog ${file}`,
    );
  assert.equal(
    await fs.readFile(path.join(root, "cache/remote_config_org.json"), "utf8"),
    "synthetic invalid JSON; never parse me",
  );
  assert.equal(
    await clineAdapter.cleanupUnit?.(
      "cache/openrouter_models.json",
      path.join(base, ".cline/data"),
    ),
    null,
  );
  assert.equal(
    await clineAdapter.cleanupUnit?.("cache/unknown.json", root),
    null,
  );
});

test("Cline catalog restore never overwrites a newly regenerated cache", async (t) => {
  const { base, key } = await fixture(t);
  const root = path.join(
    base,
    "Code/User/globalStorage/saoudrizwan.claude-dev",
  );
  await fs.mkdir(path.join(root, "tasks"), { recursive: true });
  await put(root, "state/taskHistory.json");
  await put(root, "cache/openrouter_models.json", 90, "old synthetic catalog");
  const engine = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await engine.initialize();
  const preview = await engine.preview(
    (await scan(engine)).entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const archived = await engine.quarantine(preview.token, true);
  await put(root, "cache/openrouter_models.json", 0, "new synthetic catalog");
  const restored = await engine.restore(archived.batchId);
  assert.equal(restored.completed, 0);
  assert.equal(
    await fs.readFile(path.join(root, "cache/openrouter_models.json"), "utf8"),
    "new synthetic catalog",
  );
});

const SCRATCH_OLD = "a".repeat(32);
const SCRATCH_NEW = "b".repeat(32);
async function scratch(root: string, id: string, age: number) {
  await put(
    root,
    `checkpoint-scratch/${id}/index`,
    age,
    Buffer.from([68, 73, 82, 67, 0, 1, 2]),
  );
  await put(root, `checkpoint-scratch/${id}/pathspec`, age, "synthetic/path\0");
  const modified = new Date(Date.now() - age * DAY);
  await fs.utimes(
    path.join(root, `checkpoint-scratch/${id}`),
    modified,
    modified,
  );
}

test("Current Cline scratch cache is a complete exact unit; real checkpoints and Git indexes remain protected", async (t) => {
  const { root, engine } = await fixture(t);
  await scratch(root, SCRATCH_OLD, 90);
  await scratch(root, SCRATCH_NEW, 60);
  await put(
    root,
    "checkpoints/workspace/.git/index",
    90,
    "synthetic canonical checkpoint",
  );
  await put(root, ".git/index", 90, "synthetic workspace index");
  const result = await scan(engine);
  const entry = result.entries.find(
    (e) => e.path === `checkpoint-scratch/${SCRATCH_OLD}`,
  )!;
  assert.equal(entry.selectable, true);
  assert.equal(entry.category, "cache");
  assert.deepEqual(entry.cleanupUnit, {
    kind: "directory",
    members: [`checkpoint-scratch/${SCRATCH_OLD}`],
    fileCount: 2,
    directoryCount: 1,
  });
  assert.equal(
    result.entries.find((e) => e.path === `checkpoint-scratch/${SCRATCH_NEW}`)
      ?.selectable,
    false,
  );
  assert.ok(
    result.entries
      .filter((e) => e.path === "checkpoints" || e.path === ".git")
      .every((e) => !e.selectable),
  );
  assert.equal(
    clineAdapter.classify("checkpoints/workspace/.git/index", root).risk,
    "protected",
  );
});

test("Current Cline scratch caches reject locks, unknown descendants, incomplete or recent layouts", async (t) => {
  const { root, engine } = await fixture(t);
  await scratch(root, SCRATCH_NEW, 60);
  for (const [id, extra] of [
    ["c".repeat(32), "index.lock"],
    ["d".repeat(32), "unknown"],
    ["e".repeat(32), "nested/index"],
  ]) {
    await scratch(root, id, 90);
    await put(root, `checkpoint-scratch/${id}/${extra}`, 90);
  }
  await put(root, `checkpoint-scratch/${"f".repeat(32)}/index`, 90);
  await scratch(root, SCRATCH_OLD, 20);
  const result = await scan(engine, 1);
  assert.ok(
    result.entries
      .filter(
        (e) =>
          e.path.startsWith("checkpoint-scratch/") &&
          e.path !== `checkpoint-scratch/${SCRATCH_NEW}`,
      )
      .every((e) => !e.selectable),
  );
});

test("Current Cline scratch cache roundtrip survives a fresh engine and keeps recovery outside native reaper scope", async (t) => {
  const { root, key, engine } = await fixture(t);
  await scratch(root, SCRATCH_OLD, 90);
  await scratch(root, SCRATCH_NEW, 60);
  const entry = (await scan(engine)).entries.find(
    (e) => e.path === `checkpoint-scratch/${SCRATCH_OLD}`,
  )!;
  const before = await Promise.all(
    ["index", "pathspec"].map((n) =>
      fs.readFile(path.join(root, entry.path, n)),
    ),
  );
  const preview = await engine.preview([entry.id]);
  const archived = await engine.quarantine(preview.token, true);
  assert.equal(archived.completed, 1);
  await assert.rejects(fs.lstat(path.join(root, entry.path)));
  assert.ok(
    (await fs.readdir(path.join(root, ".agentvac-quarantine"))).length > 0,
  );
  assert.ok(
    !(await fs.readdir(path.join(root, "checkpoint-scratch"))).includes(
      ".agentvac-quarantine",
    ),
  );
  const reopened = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await reopened.initialize();
  assert.equal((await reopened.restore(archived.batchId)).completed, 1);
  assert.deepEqual(
    await Promise.all(
      ["index", "pathspec"].map((n) =>
        fs.readFile(path.join(root, entry.path, n)),
      ),
    ),
    before,
  );
});

test("Current Cline derived search cache bundles exact SQLite sidecars and preserves canonical data", async (t) => {
  const { root, key, engine } = await fixture(t);
  const names = [
    "session-search.db",
    "session-search.db-wal",
    "session-search.db-shm",
    "session-search.db-journal",
  ];
  for (const name of names)
    await put(root, `db/${name}`, 90, `synthetic opaque ${name}`);
  const canonicalBefore = await fs.readFile(path.join(root, "db/sessions.db"));
  const entry = (await scan(engine)).entries.find(
    (e) => e.path === "db/session-search.db",
  )!;
  assert.equal(entry.selectable, true);
  assert.equal(entry.cleanupUnit?.fileCount, 4);
  assert.ok(
    (await scan(engine)).entries
      .filter((e) => e.path !== entry.path && e.path.startsWith("db/"))
      .every((e) => !e.selectable),
  );
  const latestEntry = (await scan(engine)).entries.find(
    (e) => e.path === entry.path,
  )!;
  const archived = await engine.quarantine(
    (await engine.preview([latestEntry.id])).token,
    true,
  );
  assert.equal(archived.completed, 1);
  for (const name of names)
    await assert.rejects(fs.lstat(path.join(root, `db/${name}`)));
  assert.deepEqual(
    await fs.readFile(path.join(root, "db/sessions.db")),
    canonicalBefore,
  );
  const reopened = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await reopened.initialize();
  assert.equal((await reopened.restore(archived.batchId)).completed, 1);
  for (const name of names)
    assert.equal(
      await fs.readFile(path.join(root, `db/${name}`), "utf8"),
      `synthetic opaque ${name}`,
    );
});

test("Current Cline derived search cache fails closed for unknown sidecars and recently written companions", async (t) => {
  const { root, engine } = await fixture(t);
  await put(root, "db/session-search.db", 90);
  await put(root, "db/session-search.db-unknown", 90);
  assert.equal(
    (await scan(engine)).entries.find((e) => e.path === "db/session-search.db")
      ?.selectable,
    false,
  );
  await fs.unlink(path.join(root, "db/session-search.db-unknown"));
  await put(root, "db/session-search.db-wal", 2);
  assert.equal(
    (await scan(engine, 1)).entries.find(
      (e) => e.path === "db/session-search.db",
    )?.selectable,
    false,
  );
});

test("Current Cline derived search-cache restore conflicts preserve regenerated cache and the archive", async (t) => {
  const { root, engine } = await fixture(t);
  await put(root, "db/session-search.db", 90, "old synthetic search");
  await put(root, "db/session-search.db-wal", 90, "old synthetic wal");
  const entry = (await scan(engine)).entries.find(
    (e) => e.path === "db/session-search.db",
  )!;
  const archived = await engine.quarantine(
    (await engine.preview([entry.id])).token,
    true,
  );
  await put(
    root,
    "db/session-search.db",
    90,
    "new synthetic regenerated search",
  );
  const restored = await engine.restore(archived.batchId);
  assert.equal(restored.completed, 0);
  assert.equal(
    await fs.readFile(path.join(root, "db/session-search.db"), "utf8"),
    "new synthetic regenerated search",
  );
  await assert.rejects(fs.lstat(path.join(root, "db/session-search.db-wal")));
  assert.equal(
    (await engine.history()).find((batch) => batch.id === archived.batchId)
      ?.items[0].status,
    "quarantined",
  );
});
