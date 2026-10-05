// Strict source-native provider acceptance. Uses real preload/IPC/process guards and synthetic roots only.
import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
const project = await fs.realpath(path.resolve("."));
const qa = path.join(project, ".qa");
await fs.mkdir(qa, { recursive: true });
const base = await fs.mkdtemp(path.join(qa, "native-providers-"));
const profile = path.join(base, "profile");
const roots = {
  "claude-code": path.join(base, "claude-data"),
  cursor: path.join(base, "Cursor"),
  cline: path.join(base, "cline-data"),
};
const out =
  process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ||
  path.join(project, ".qa", "native-provider-evidence");
await fs.mkdir(out, { recursive: true });
const version = JSON.parse(
  await fs.readFile(path.join(project, "package.json"), "utf8"),
).version;
const hash = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const originals = new Map();
async function write(provider, relative, age = 90) {
  const file = path.join(roots[provider], relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "native synthetic fixture: " + relative);
  const date = new Date(Date.now() - age * 86400000);
  await fs.utimes(file, date, date);
  originals.set(file, await hash(file));
  return file;
}
const session =
  "projects/-synthetic/11111111-1111-4111-8111-111111111111.jsonl";
await write("claude-code", "settings.json");
await write("claude-code", session);
await write(
  "claude-code",
  "projects/-synthetic/22222222-2222-4222-8222-222222222222.jsonl",
  2,
);
await write("claude-code", session.slice(0, -6) + "/subagents/agent-a.jsonl");
for (const relative of [
  session.slice(0, -6) + "/subagents",
  session.slice(0, -6),
]) {
  const date = new Date(Date.now() - 90 * 86400000);
  await fs.utimes(path.join(roots["claude-code"], relative), date, date);
}
await fs.mkdir(path.join(roots.cursor, "User/globalStorage"), {
  recursive: true,
});
await fs.mkdir(path.join(roots.cursor, "logs"), { recursive: true });
for (const file of [
  "index",
  "data_0",
  "data_1",
  "data_2",
  "data_3",
  "f_000001",
])
  await write("cursor", "GPUCache/" + file);
{
  const date = new Date(Date.now() - 90 * 86400000);
  await fs.utimes(path.join(roots.cursor, "GPUCache"), date, date);
}
await fs.mkdir(path.join(roots.cline, "sessions"), { recursive: true });
for (const file of [
  "db/sessions.db",
  "globalState.json",
  "db/session-search.db",
  "db/session-search.db-wal",
])
  await write("cline", file);
const services = new AppDataServices(profile, {
  home: path.join(base, "home"),
  env: {},
});
await services.initialize();
for (const provider of Object.keys(roots))
  await services.selectProviderRoot(roots[provider], provider);
const ids = Object.fromEntries(
  (await services.getAppData()).workspaces.entries.map((item) => [
    item.kind,
    item.id,
  ]),
);
await services.flush();
let application, page, security;
const checks = {},
  errors = [];
const metadata = {
  format: "agentvac-native-providers-v1",
  sourceRevision: process.env.GITHUB_SHA || null,
  ciRunId: process.env.GITHUB_RUN_ID || null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  platform: process.platform,
  arch: process.arch,
  appVersion: version,
  nativeExecution: true,
  packagedArtifactTested: false,
  vendorRuntimeTested: false,
  synthetic: true,
};
async function launch() {
  const env = { ...process.env, AGENTVAC_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    args: [project],
    chromiumSandbox: true,
    env,
    timeout: 45000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () =>
      window.agentvac &&
      document.querySelector(".primary-nav button")?.disabled === false,
  );
  security = await application.evaluate(({ BrowserWindow, app }) => {
    const preferences =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      webSecurity: preferences.webSecurity,
      disabledSandbox: app.commandLine.hasSwitch("no-sandbox"),
      appVersion: app.getVersion(),
      arch: process.arch,
    };
  });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.webSecurity, true);
  assert.equal(security.disabledSandbox, false);
  assert.equal(security.appVersion, version);
  assert.equal(
    security.arch,
    process.env.AGENTVAC_EXPECTED_ARCH || process.arch,
  );
}
async function close() {
  await application?.close().catch(() => {});
  application = null;
}
async function verifyOriginals(provider) {
  for (const [file, expected] of originals)
    if (file.startsWith(roots[provider] + path.sep))
      assert.equal(await hash(file), expected, file);
}
async function runProvider(provider, anchor) {
  if (!application) await launch();
  const context = await page.evaluate(
    (id) => window.agentvac.activateWorkspace(id),
    ids[provider],
  );
  assert.equal(context.provider, provider);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".primary-nav button")?.disabled === false,
  );
  const scan = await page.evaluate(
    (includeSessions) =>
      window.agentvac.scan({ minAgeDays: 30, includeSessions }),
    provider === "claude-code",
  );
  assert.equal(scan.provider, provider);
  assert.equal(scan.root, roots[provider]);
  const row = scan.entries.find((item) => item.path === anchor);
  assert.ok(row?.selectable, JSON.stringify(row));
  assert.ok(row.cleanupUnit);
  const preview = await page.evaluate(
    (id) => window.agentvac.preview([id]),
    row.id,
  );
  assert.equal(preview.provider, provider);
  assert.equal(preview.root, roots[provider]);
  assert.equal(preview.totalFiles, row.cleanupUnit.fileCount);
  if (preview.processStatus.status !== "clear") {
    await assert.rejects(
      page.evaluate(
        (token) => window.agentvac.quarantine(token, true),
        preview.token,
      ),
    );
    await verifyOriginals(provider);
    return {
      status: "FAIL",
      reason: "REQUIRED_MUTATION_GUARD_BLOCKED",
      guard: preview.processStatus.status,
      details: preview.processStatus.details,
      refusalVerified: true,
      mutationNotTested: true,
    };
  }
  const moved = await page.evaluate(
    (token) => window.agentvac.quarantine(token, true),
    preview.token,
  );
  assert.equal(moved.completed, 1);
  assert.deepEqual(moved.failed, []);
  await assert.rejects(
    page.evaluate(
      (token) => window.agentvac.quarantine(token, true),
      preview.token,
    ),
  );
  await close();
  await launch();
  assert.equal(
    (await page.evaluate(() => window.agentvac.getContext())).provider,
    provider,
  );
  const history = await page.evaluate(() => window.agentvac.history());
  const batch = history.find((item) => item.id === moved.batchId);
  assert.ok(batch);
  assert.equal(batch.provider, provider);
  assert.equal(batch.items[0].cleanupUnit.fileCount, row.cleanupUnit.fileCount);
  const rescue = await page.evaluate(() => window.agentvac.inspectRecovery());
  assert.equal(
    rescue.batches.find((item) => item.id === moved.batchId).storedFiles,
    row.cleanupUnit.fileCount,
  );
  // A newly generated destination is preserved and cannot be overwritten by a restore.
  const collision =
    provider === "cursor"
      ? path.join(roots[provider], anchor, "generated-destination")
      : path.join(roots[provider], anchor);
  await fs.mkdir(path.dirname(collision), { recursive: true });
  await fs.writeFile(collision, "newly generated destination");
  let conflicted = false;
  try {
    const result = await page.evaluate(
      (id) => window.agentvac.restore(id, true),
      moved.batchId,
    );
    conflicted = result.completed === 0 && result.failed.length > 0;
  } catch {
    conflicted = true;
  }
  assert.equal(conflicted, true);
  assert.equal(
    await fs.readFile(collision, "utf8"),
    "newly generated destination",
  );
  if (provider === "cursor")
    await fs.rm(path.join(roots[provider], anchor), { recursive: true });
  else await fs.unlink(collision);
  const restored = await page.evaluate(
    (id) => window.agentvac.restore(id, true),
    moved.batchId,
  );
  assert.equal(restored.completed, 1);
  assert.deepEqual(restored.failed, []);
  await verifyOriginals(provider);
  assert.equal(
    (
      await page.evaluate(
        (id) => window.agentvac.restore(id, true),
        moved.batchId,
      )
    ).completed,
    0,
  );
  // Old IDs/tokens cannot be reused after switching provider/root context.
  await page.evaluate(() => window.agentvac.setProvider("codex"));
  await assert.rejects(
    page.evaluate(
      (token) => window.agentvac.quarantine(token, true),
      preview.token,
    ),
  );
  await page.evaluate(
    (id) => window.agentvac.activateWorkspace(id),
    ids[provider],
  );
  await verifyOriginals(provider);
  return {
    status: "PASS",
    actualProcessGuard: "clear",
    quarantine: 1,
    restore: 1,
    restart: true,
    exactBytes: true,
    protectedFilesUnchanged: true,
    conflictRefused: true,
    duplicateRefused: true,
    providerSwitchInvalidates: true,
    retainedCounts: true,
    files: row.cleanupUnit.fileCount,
    directories: row.cleanupUnit.directoryCount,
  };
}
let status = "FAIL";
try {
  if (process.env.AGENTVAC_EXPECTED_ARCH)
    assert.equal(process.arch, process.env.AGENTVAC_EXPECTED_ARCH);
  for (const [provider, anchor] of [
    ["claude-code", session],
    ["cursor", "GPUCache"],
    ["cline", "db/session-search.db"],
  ]) {
    try {
      checks[provider] = await runProvider(provider, anchor);
    } catch (error) {
      checks[provider] = { status: "FAIL", reason: String(error) };
      await close();
    }
    console.log(
      `${checks[provider].status}: native-provider ${provider}${checks[provider].reason ? " " + checks[provider].reason : ""}`,
    );
  }
  status =
    Object.values(checks).every((row) => row.status === "PASS") &&
    !errors.length
      ? "PASS"
      : "FAIL";
} finally {
  await close();
  const result = { ...metadata, status, security, checks, errors };
  await fs.writeFile(
    path.join(out, `providers-${process.platform}-${process.arch}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  // Failed synthetic fixtures stay local for diagnosis; they are never uploaded by this workflow.
  if (status === "PASS") await fs.rm(base, { recursive: true, force: true });
}
if (status !== "PASS") process.exitCode = 1;
