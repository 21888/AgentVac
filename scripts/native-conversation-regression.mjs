import os from "node:os";
// Actual sandboxed Electron, shipped main/preload/worker paths, generated local fixtures only.
import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
const project = await fs.realpath(path.resolve("."));
await fs.mkdir(path.join(project, ".qa"), { recursive: true });
const base = await fs.mkdtemp(
  path.join(project, ".qa", "native-conversations-"),
);
// Native privacy gate is tested in a fresh directory under the OS user temp
// parent, rather than assuming a CI checkout directory has user-private ACLs.
const profileBase = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "AgentVac-Native-Profile-"),
);
const profile = path.join(profileBase, "profile");
const roots = {
  codex: path.join(base, "codex"),
  "claude-code": path.join(base, "claude"),
  cline: path.join(base, "data"),
  cursor: path.join(base, "Cursor"),
};
const originals = new Map();
const digest = (b) => createHash("sha256").update(b).digest("hex");
const fileHash = async (f) => digest(await fs.readFile(f));
const sid = "550e8400-e29b-41d4-a716-446655440000";
const at = "2026-06-01T00:00:00.000Z";
const body =
  "Native sandboxed IPC body " + "中🙂".repeat(22000) + " LATE_NATIVE_SEARCH";
async function put(provider, rel, data) {
  const file = path.join(roots[provider], rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  originals.set(file, await fileHash(file));
  return file;
}
await put(
  "codex",
  `sessions/2026/06/01/rollout-2026-06-01T00-00-00-${sid}.jsonl`,
  [
    {
      type: "session_meta",
      timestamp: at,
      payload: {
        id: sid,
        timestamp: at,
        cwd: "/AgentVac-Demo/Project",
        source: "cli",
        cli_version: "0.1.0",
      },
    },
    {
      type: "response_item",
      timestamp: at,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: body }],
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n") + "\n",
);
await put("claude-code", "history.jsonl", "synthetic global history");
await put(
  "claude-code",
  `projects/-AgentVac-Demo/${sid}.jsonl`,
  JSON.stringify({
    type: "user",
    uuid: "native-message",
    parentUuid: null,
    sessionId: sid,
    cwd: "/AgentVac-Demo/Project",
    timestamp: at,
    message: { role: "user", content: body },
  }) + "\n",
);
const clineId = "1740000000000_abc12",
  rel = `sessions/${clineId}/${clineId}.messages.json`;
await put("cline", "globalState.json", "{}");
await put("cline", "db/sessions.db", "synthetic canonical marker");
await put(
  "cline",
  `sessions/${clineId}/${clineId}.json`,
  JSON.stringify({
    version: 1,
    session_id: clineId,
    source: "cli",
    pid: 0,
    started_at: at,
    ended_at: at,
    status: "completed",
    interactive: false,
    provider: "synthetic",
    model: "fixture",
    cwd: "/AgentVac-Demo",
    workspace_root: "/AgentVac-Demo/Project",
    enable_tools: true,
    enable_spawn: false,
    enable_teams: false,
    messages_path: path.join(roots.cline, rel),
    metadata: { title: "Native conversation" },
  }),
);
await put(
  "cline",
  rel,
  JSON.stringify({
    version: 1,
    updated_at: at,
    agent: "lead",
    sessionId: clineId,
    messages: [
      {
        id: "native-message",
        role: "user",
        content: [{ type: "text", text: body }],
      },
    ],
  }),
);
await fs.mkdir(path.join(roots.cursor, "logs"), { recursive: true });
await fs.mkdir(path.join(roots.cursor, "User/globalStorage"), {
  recursive: true,
});
const cursorDb = path.join(roots.cursor, "User/globalStorage/state.vscdb");
const db = new DatabaseSync(cursorDb);
db.exec(
  "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB);CREATE TABLE ItemTable (key TEXT,value BLOB)",
);
db.prepare("INSERT INTO ItemTable VALUES (?,?)").run(
  "synthetic-auth-sentinel",
  "NEVER_RENDER_AUTH",
);
const insert = db.prepare("INSERT INTO cursorDiskKV VALUES (?,?)");
insert.run(
  "composerData:native-chat",
  JSON.stringify({
    composerId: "native-chat",
    name: "Native conversation",
    createdAt: Date.parse(at),
    lastUpdatedAt: Date.parse(at),
    fullConversationHeadersOnly: [{ bubbleId: "native-message" }],
  }),
);
insert.run(
  "bubbleId:native-chat:native-message",
  JSON.stringify({
    bubbleId: "native-message",
    type: 1,
    createdAt: at,
    text: body,
  }),
);
db.close();
originals.set(cursorDb, await fileHash(cursorDb));
const alternateRoots = {
  cursor: path.join(base, "agent-transcripts"),
  cline: path.join(base, "sdk-only"),
};
await fs.mkdir(alternateRoots.cursor, { recursive: true });
const alternateTranscript = path.join(
  alternateRoots.cursor,
  "native-transcript.jsonl",
);
await fs.writeFile(
  alternateTranscript,
  JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: body }] },
  }) + "\n",
);
originals.set(alternateTranscript, await fileHash(alternateTranscript));
await fs.cp(
  path.join(roots.cline, "sessions"),
  path.join(alternateRoots.cline, "sessions"),
  { recursive: true },
);
const alternateManifest = path.join(
  alternateRoots.cline,
  "sessions",
  clineId,
  clineId + ".json",
);
const alternateManifestData = JSON.parse(
  await fs.readFile(alternateManifest, "utf8"),
);
alternateManifestData.messages_path = path.join(alternateRoots.cline, rel);
await fs.writeFile(alternateManifest, JSON.stringify(alternateManifestData));
await fs.writeFile(
  path.join(alternateRoots.cline, "sessions/sessions.index.json"),
  '{"version":1,"sessions":{}}',
);
for (const name of [
  alternateManifest,
  path.join(alternateRoots.cline, rel),
  path.join(alternateRoots.cline, "sessions/sessions.index.json"),
])
  originals.set(name, await fileHash(name));
const services = new AppDataServices(profile, {
  home: path.join(base, "home"),
  env: {},
});
await services.initialize();
for (const [provider, root] of Object.entries(roots))
  await services.selectProviderRoot(root, provider);
const ids = Object.fromEntries(
  (await services.getAppData()).workspaces.entries.map((w) => [w.kind, w.id]),
);
await services.flush();
const out = path.resolve(
  process.env.AGENTVAC_CONVERSATION_EVIDENCE ||
    process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ||
    path.join(project, ".qa", "native-conversation-evidence"),
);
await fs.mkdir(out, { recursive: true });
const builtFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/cursor-sql-worker.cjs",
];
const built = Object.fromEntries(
  await Promise.all(
    builtFiles.map(async (f) => [f, await fileHash(path.join(project, f))]),
  ),
);
const results = {
  format: "agentvac-native-conversations-v1",
  sourceRevision: process.env.GITHUB_SHA ?? null,
  ciRunId: process.env.GITHUB_RUN_ID ?? null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  appVersion: JSON.parse(
    await fs.readFile(path.join(project, "package.json"), "utf8"),
  ).version,
  packagedArtifactTested: false,
  at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nativeElectron: true,
  realMainPreloadIPC: true,
  syntheticFixturesOnly: true,
  installedVendorRuntimeTested: false,
  built,
  checks: [],
  security: null,
  errors: [],
};
let app, page;
try {
  const env = { ...process.env, AGENTVAC_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [project],
    chromiumSandbox: true,
    env,
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => results.errors.push(e.message));
  await page.waitForFunction(
    () =>
      window.agentvac &&
      document.querySelector(".primary-nav button")?.disabled === false,
  );
  results.security = await app.evaluate(({ BrowserWindow, app }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      contextIsolation: p.contextIsolation,
      webSecurity: p.webSecurity,
      noSandbox: app.commandLine.hasSwitch("no-sandbox"),
    };
  });
  assert.deepEqual(results.security, {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    noSandbox: false,
  });
  let staleId;
  for (const provider of Object.keys(roots)) {
    await page.evaluate(
      (id) => window.agentvac.activateWorkspace(id),
      ids[provider],
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        window.agentvac &&
        document.querySelector(".primary-nav button")?.disabled === false,
    );
    const access = await page.evaluate(() =>
      window.agentvac.getConversationAccess(),
    );
    assert.equal(access.provider, provider);
    assert.equal(access.allowed, false);
    assert.ok(!access.unavailableReason, access.unavailableReason);
    await assert.rejects(
      page.evaluate(
        (id) => window.agentvac.listConversations({ requestId: id }),
        randomUUID(),
      ),
    );
    await page.evaluate(() => window.agentvac.setConversationAccess(true));
    if (staleId)
      await assert.rejects(
        page.evaluate(
          ([requestId, conversationId]) =>
            window.agentvac.readConversation({ requestId, conversationId }),
          [randomUUID(), staleId],
        ),
      );
    const list = await page.evaluate(
      (requestId) =>
        window.agentvac.listConversations({
          requestId,
          keyword: "LATE_NATIVE_SEARCH",
          from: "2026-06-01T00:00:00Z",
          to: "2026-06-02T00:00:00Z",
        }),
      randomUUID(),
    );
    assert.equal(list.items.length, 1, provider);
    assert.equal(list.items[0].createdAt, at);
    assert.ok(!JSON.stringify(list).includes("NEVER_RENDER_AUTH"));
    const id = list.items[0].id;
    let cursor,
      actual = "",
      pages = 0;
    do {
      const p = await page.evaluate(
        (r) => window.agentvac.readConversation(r),
        {
          requestId: randomUUID(),
          conversationId: id,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        },
      );
      actual += p.messages
        .flatMap((m) =>
          m.parts.filter((p) => p.type === "text").map((p) => p.text),
        )
        .join("");
      cursor = p.nextCursor;
      assert.ok(++pages < 20);
    } while (cursor);
    assert.equal(digest(actual), digest(body));
    await page.evaluate(() => window.agentvac.setConversationAccess(false));
    await assert.rejects(
      page.evaluate((r) => window.agentvac.readConversation(r), {
        requestId: randomUUID(),
        conversationId: id,
      }),
    );
    staleId = id;
    results.checks.push({
      provider,
      status: "PASS",
      lateContentSearch: true,
      fullUnicodePaging: true,
      actualTimestamp: true,
      consentBeforeRead: true,
      revokeInvalidates: true,
      pages,
    });
  }
  for (const provider of ["cline", "cursor"]) {
    await page.evaluate(
      (id) => window.agentvac.activateWorkspace(id),
      ids[provider],
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        window.agentvac &&
        document.querySelector(".primary-nav button")?.disabled === false,
    );
    await page.getByRole("button", { name: "对话管理", exact: true }).click();
    await page.getByTestId("conversation-consent").waitFor();
    await app.evaluate(({ dialog }, root) => {
      globalThis.__savedAgentVacDialog ??= dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, alternateRoots[provider]);
    await page.getByTestId("conversation-choose-source").click();
    await page.waitForFunction(
      (root) =>
        document
          .querySelector('[data-testid="conversation-source-bar"]')
          ?.textContent?.includes(root),
      alternateRoots[provider],
    );
    assert.equal(
      (await page.evaluate(() => window.agentvac.getContext())).root,
      roots[provider],
    );
    const before = await page.evaluate(() =>
      window.agentvac.getConversationAccess(),
    );
    assert.equal(before.allowed, false);
    assert.equal(before.readOnlySource, true);
    assert.equal(before.root, alternateRoots[provider]);
    if (provider === "cursor")
      assert.equal(
        await page.getByTestId("cursor-database-consent").count(),
        0,
      );
    await page.getByTestId("conversation-consent-checkbox").check();
    await page.getByTestId("conversation-grant").click();
    await page.getByTestId("conversation-row").first().waitFor();
    assert.equal(
      await page
        .getByTestId("conversation-row")
        .first()
        .locator('input[type="checkbox"]')
        .isDisabled(),
      true,
    );
    const list = await page.evaluate(
      (requestId) =>
        window.agentvac.listConversations({
          requestId,
          keyword: "LATE_NATIVE_SEARCH",
        }),
      randomUUID(),
    );
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].canArchive, false);
    await assert.rejects(
      page.evaluate(
        (id) => window.agentvac.previewConversationArchive([id]),
        list.items[0].id,
      ),
    );
    await page.getByTestId("conversation-reset-source").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="conversation-consent"]') !== null,
    );
    assert.equal(
      (await page.evaluate(() => window.agentvac.getConversationAccess())).root,
      roots[provider],
    );
    await assert.rejects(
      page.evaluate((r) => window.agentvac.readConversation(r), {
        requestId: randomUUID(),
        conversationId: list.items[0].id,
      }),
    );
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__savedAgentVacDialog;
    });
    results.checks.push({
      provider,
      source: "explicit-read-only",
      status: "PASS",
      realDialogRoute: true,
      newConsent: true,
      cleanupRootUnchanged: true,
      archiveDisabled: true,
      resetRevokes: true,
    });
  }
  for (const [file, hash] of originals)
    assert.equal(await fileHash(file), hash, "source modified");
  for (const [file, hash] of Object.entries(built))
    assert.equal(
      await fileHash(path.join(project, file)),
      hash,
      "build changed during native run",
    );
  assert.deepEqual(results.errors, []);
  results.sourcesUnchanged = true;
  results.builtUnchanged = true;
  results.status = "PASS";
} catch (error) {
  results.status = "FAIL";
  results.failure = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(profileBase, { recursive: true, force: true });
  await fs.writeFile(
    path.join(out, `conversations-${process.platform}-${process.arch}.json`),
    JSON.stringify(results, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: results.status,
        checks: results.checks,
        security: results.security,
        failure: results.failure,
      },
      null,
      2,
    ),
  );
}
