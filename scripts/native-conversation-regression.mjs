import os from "node:os";
// Actual sandboxed Electron, shipped main/preload/worker paths, generated local fixtures only.
import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
import {
  bindRuntimePayload,
  validatePayloadManifest,
  isolatedEnv,
} from "../qa/packaged-acceptance/core.mjs";
import {
  readerLaunchTarget,
  readerFailureEvidence,
} from "./native-conversation-harness.mjs";
const project = await fs.realpath(path.resolve("."));
const packageExecutable = process.env.AGENTVAC_PACKAGE_EXECUTABLE;
const out = path.resolve(
  process.env.AGENTVAC_CONVERSATION_EVIDENCE ||
    process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ||
    path.join(project, ".qa", "native-conversation-evidence"),
);
await fs.mkdir(out, { recursive: true });
const results = {
  format: "agentvac-native-conversations-v1",
  sourceRevision: process.env.GITHUB_SHA ?? null,
  ciRunId: process.env.GITHUB_RUN_ID ?? null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  appVersion: null,
  packagedArtifactTested: !!packageExecutable,
  at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nativeLaunchAttempted: false,
  nativeElectron: false,
  realMainPreloadIPC: false,
  profileIsolationVerified: false,
  syntheticFixturesOnly: true,
  installedVendorRuntimeTested: false,
  built: {},
  checks: [],
  security: null,
  errors: [],
};
let app, page, profileBase;
let stage = "preflight",
  activeProvider,
  activeSource;
try {
  results.appVersion = JSON.parse(
    await fs.readFile(path.join(project, "package.json"), "utf8"),
  ).version;
  if (packageExecutable) {
    assert.ok(
      path.isAbsolute(packageExecutable),
      "Packaged reader target must be absolute",
    );
    assert.ok(
      process.env.AGENTVAC_PACKAGE_PAYLOAD_MANIFEST,
      "Packaged readers require the verified payload manifest",
    );
    const st = await fs.lstat(packageExecutable);
    assert.ok(
      st.isFile() && !st.isSymbolicLink(),
      "Packaged reader target must be a regular generated executable",
    );
  }
  stage = "fixture-setup";
  await fs.mkdir(path.join(project, ".qa"), { recursive: true });
  const base = await fs.mkdtemp(
    path.join(project, ".qa", "native-conversations-"),
  );
  // Native privacy gate is tested in a fresh directory under the OS user temp
  // parent, rather than assuming a CI checkout directory has user-private ACLs.
  profileBase = await fs.mkdtemp(
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
  stage = "profile-preparation";
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
  stage = "build-fingerprints";
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
  results.built = built;
  stage = "native-launch";
  const env = isolatedEnv(process.env, profile);
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  await fs.mkdir(env.CODEX_SQLITE_HOME, { recursive: true });
  if (!packageExecutable) env.AGENTVAC_TEST_USER_DATA = profile;
  results.nativeLaunchAttempted = true;
  app = await electron.launch({
    ...readerLaunchTarget({ packageExecutable, project, profile }),
    chromiumSandbox: true,
    env,
    timeout: 45000,
  });
  results.nativeElectron = true;
  stage = "window-ready";
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", () => {
    if (results.errors.length < 20) results.errors.push("RENDERER_PAGE_ERROR");
  });
  await page.waitForFunction(
    () =>
      window.agentvac &&
      document.querySelector(".primary-nav button")?.disabled === false,
  );
  results.realMainPreloadIPC = true;
  stage = "sandbox-verification";
  results.security = await app.evaluate(({ BrowserWindow, app }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      packaged: app.isPackaged,
      arch: process.arch,
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      contextIsolation: p.contextIsolation,
      webSecurity: p.webSecurity,
      noSandbox: app.commandLine.hasSwitch("no-sandbox"),
    };
  });
  assert.deepEqual(results.security, {
    packaged: !!packageExecutable,
    arch: process.arch,
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    noSandbox: false,
  });
  stage = "profile-isolation";
  assert.equal(
    path.resolve(await app.evaluate(({ app }) => app.getPath("userData"))),
    path.resolve(profile),
  );
  results.profileIsolationVerified = true;
  if (packageExecutable) {
    stage = "payload-manifest";
    const manifest = validatePayloadManifest(
      JSON.parse(
        await fs.readFile(
          process.env.AGENTVAC_PACKAGE_PAYLOAD_MANIFEST,
          "utf8",
        ),
      ),
    );
    assert.equal(manifest.sourceRevision, results.sourceRevision);
    stage = "payload-binding";
    const runtime = await app.evaluate(({ app }) => ({
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    }));
    const binding = await bindRuntimePayload(runtime, manifest);
    results.packagePayloadBinding = {
      status: binding.status,
      artifactSha256: binding.artifactSha256,
      fileCount: binding.fileCount,
      symlinkCount: binding.symlinkCount,
    };
  }
  let staleId;
  for (const provider of Object.keys(roots)) {
    activeProvider = provider;
    activeSource = undefined;
    stage = "reader-activate";
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
    stage = "reader-consent";
    const access = await page.evaluate(() =>
      window.agentvac.getConversationAccess(),
    );
    assert.equal(access.provider, provider);
    assert.equal(access.allowed, false);
    if (provider === "cursor" && process.platform === "win32") {
      assert.match(
        access.unavailableReason ?? "",
        /0\.2\.0.*Windows.*Cursor IDE/,
      );
      await assert.rejects(
        page.evaluate(() => window.agentvac.setConversationAccess(true)),
        /Cursor IDE/,
      );
      await assert.rejects(
        page.evaluate(
          (requestId) => window.agentvac.listConversations({ requestId }),
          randomUUID(),
        ),
      );
      assert.equal(
        (await page.evaluate(() => window.agentvac.getConversationAccess()))
          .allowed,
        false,
      );
      await assert.rejects(
        fs.lstat(path.join(profile, "conversation-snapshots")),
        { code: "ENOENT" },
      );
      assert.equal(await fileHash(cursorDb), originals.get(cursorDb));
      results.checks.push({
        provider,
        status: "UNSUPPORTED",
        reason: "WINDOWS_CURSOR_IDE_DISABLED_0_2",
        disabledGateVerified: true,
        consentRefused: true,
        listRefused: true,
        noSnapshotCreated: true,
        sourceUnchanged: true,
      });
      continue;
    }
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
    stage = "reader-list";
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
    stage = "reader-page";
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
    stage = "reader-revoke";
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
    activeProvider = provider;
    activeSource = "explicit-read-only";
    stage = "alternate-source";
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
  activeProvider = activeSource = undefined;
  stage = "source-integrity";
  for (const [file, hash] of originals)
    assert.equal(await fileHash(file), hash, "source modified");
  stage = "build-integrity";
  for (const [file, hash] of Object.entries(built))
    assert.equal(
      await fileHash(path.join(project, file)),
      hash,
      "build changed during native run",
    );
  stage = "renderer-health";
  assert.deepEqual(results.errors, []);
  results.sourcesUnchanged = true;
  results.builtUnchanged = true;
  if (process.platform === "win32")
    await assert.rejects(
      fs.lstat(path.join(profile, "conversation-snapshots")),
      { code: "ENOENT" },
    );
  results.status =
    process.platform === "win32" ? "PASS_WITH_LIMITATIONS" : "PASS";
} catch (error) {
  results.status = "FAIL";
  results.failure = readerFailureEvidence(stage, error, {
    provider: activeProvider,
    source: activeSource,
  });
  results.failedCheck = results.failure.failedCheck;
  process.exitCode = 1;
} finally {
  let appClosed = !app;
  try {
    if (app) await app.close();
    appClosed = true;
  } catch {
    results.status = "FAIL";
    results.cleanupFailure = "NATIVE_READER_APP_CLOSE_FAILED";
    results.failedCheck ??= "reader-cleanup";
    process.exitCode = 1;
  }
  results.cleanup = { appClosed, profileRemoved: false };
  if (appClosed && profileBase) {
    try {
      await fs.rm(profileBase, { recursive: true, force: true });
      results.cleanup.profileRemoved = true;
    } catch {
      results.status = "FAIL";
      results.cleanupFailure = "NATIVE_READER_PROFILE_CLEANUP_FAILED";
      results.failedCheck ??= "reader-cleanup";
      process.exitCode = 1;
    }
  }
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
        failedCheck: results.failedCheck,
        cleanupFailure: results.cleanupFailure,
      },
      null,
      2,
    ),
  );
}
