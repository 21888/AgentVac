// Strict source-native provider acceptance. Uses real preload/IPC/process guards and synthetic roots only.
import { _electron as electron } from "playwright";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
import { nativeProcessObservation } from "./native-process-diagnostics.mjs";
import { providerMutationObservationHandlers } from "./native-mutation-observation.mjs";
// Pure bounded helpers. Tests load only this block, without executing the native harness.
const providerRecoveryLimits = Object.freeze({
  files: 64,
  nodes: 512,
  depth: 16,
  fileBytes: 1_048_576,
  totalBytes: 8_388_608,
});
const fixtureBatchId = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function mutationOutcomeSummary(provider, operation, outcome) {
  let receipt;
  const handlers = providerMutationObservationHandlers(
    provider,
    operation,
    (line) => {
      receipt = JSON.parse(line.slice("AGENTVAC_PROVIDER_MUTATION ".length));
    },
  );
  try {
    handlers[outcome.status === "fulfilled" ? 0 : 1](
      outcome.status === "fulfilled" ? outcome.value : outcome.reason,
    );
  } catch {
    /* The original exception remains in outcome; only the fixed receipt is used. */
  }
  return receipt;
}
function isProcessRefusal(provider, outcome, anchor) {
  const receipt = mutationOutcomeSummary(provider, "GUARD_QUARANTINE", outcome);
  const typed = (codes) =>
    Array.isArray(codes) &&
    codes.length === 1 &&
    [
      "INFERRED_ENGINE_PROCESS_UNKNOWN",
      "INFERRED_ENGINE_PROCESS_RUNNING",
    ].includes(codes[0]);
  if (outcome.status === "rejected") return typed(receipt?.inferredReasonCodes);
  const value = outcome.value;
  return (
    outcome.status === "fulfilled" &&
    fixtureBatchId(value?.batchId) &&
    value.completed === 0 &&
    value.bytes === 0 &&
    Array.isArray(value.failed) &&
    value.failed.length === 1 &&
    value.failed[0]?.path === anchor &&
    typed(receipt?.failedItems?.[0]?.inferredReasonCodes)
  );
}
function accountFixtureBytes(expected, inventory) {
  assert.ok(
    expected.length > 0 && expected.length <= providerRecoveryLimits.files,
    "FIXTURE_EXPECTATION_BOUNDS",
  );
  assert.ok(
    inventory.files.length <= providerRecoveryLimits.files,
    "FIXTURE_INVENTORY_BOUNDS",
  );
  const validBytes = (row) =>
    Number.isSafeInteger(row.bytes) &&
    row.bytes >= 0 &&
    row.bytes <= providerRecoveryLimits.fileBytes &&
    /^[0-9a-f]{64}$/.test(row.sha256);
  assert.ok(
    expected.every(validBytes) && inventory.files.every(validBytes),
    "FIXTURE_INVALID_FINGERPRINT",
  );
  // Each generated fixture has unique bytes; ambiguous matches cannot prove preservation.
  assert.equal(
    new Set(expected.map((row) => row.sha256)).size,
    expected.length,
    "FIXTURE_AMBIGUOUS_CONTENT",
  );
  assert.equal(
    new Set(expected.map((row) => row.relative)).size,
    expected.length,
    "FIXTURE_AMBIGUOUS_PATH",
  );
  const accounted = new Set();
  const files = expected.map((original, index) => {
    const source = inventory.files.filter(
      (row) => row.location === "source" && row.relative === original.relative,
    );
    const stored = inventory.files.filter(
      (row) =>
        row.location === "quarantine" &&
        row.sha256 === original.sha256 &&
        row.bytes === original.bytes,
    );
    for (const row of [...source, ...stored]) accounted.add(row);
    const sourceMatches = source.filter(
      (row) => row.sha256 === original.sha256 && row.bytes === original.bytes,
    ).length;
    return {
      ordinal: index + 1,
      bytes: original.bytes,
      sha256: original.sha256,
      protected: !original.mutable,
      source: source.map(({ bytes, sha256 }) => ({ bytes, sha256 })),
      quarantineCopies: stored.length,
      exactCopies: sourceMatches + stored.length,
      sourceExact: source.length === 1 && sourceMatches === 1,
    };
  });
  const unaccountedFiles = inventory.files.filter(
    (row) => !accounted.has(row),
  ).length;
  const exactBytes =
    inventory.complete === true &&
    inventory.irregularEntries === 0 &&
    unaccountedFiles === 0 &&
    files.every(
      (row) =>
        row.exactCopies >= 1 &&
        row.source.every(
          (source) =>
            source.bytes === row.bytes && source.sha256 === row.sha256,
        ),
    );
  return {
    complete: inventory.complete,
    irregularEntries: inventory.irregularEntries,
    unaccountedFiles,
    exactBytes,
    originalBytes: expected.reduce((sum, row) => sum + row.bytes, 0),
    sourceFiles: inventory.files.filter((row) => row.location === "source")
      .length,
    quarantineFiles: inventory.files.filter(
      (row) => row.location === "quarantine",
    ).length,
    quarantineBytes: inventory.files
      .filter((row) => row.location === "quarantine")
      .reduce((sum, row) => sum + row.bytes, 0),
    duplicateCopies: files.reduce(
      (sum, row) => sum + Math.max(0, row.exactCopies - 1),
      0,
    ),
    sourceUnchanged: exactBytes && files.every((row) => row.sourceExact),
    protectedFilesUnchanged:
      exactBytes &&
      files
        .filter((row) => row.protected)
        .every((row) => row.sourceExact && row.quarantineCopies === 0),
    files,
  };
}
function recoveryAdmission(
  accounting,
  inspection,
  history,
  provider,
  root,
  batchId,
  observation,
) {
  if (
    !accounting?.exactBytes ||
    !accounting.protectedFilesUnchanged ||
    accounting.duplicateCopies !== 0
  )
    return "PRESERVATION_UNVERIFIED";
  if (!fixtureBatchId(batchId)) return "BATCH_UNVERIFIED";
  if (
    inspection?.provider !== provider ||
    inspection.root !== root ||
    inspection.readOnly !== true ||
    inspection.truncated !== false
  )
    return "INSPECTION_UNVERIFIED";
  const batches = inspection.batches?.filter((item) => item.id === batchId);
  const items = history?.filter((item) => item.id === batchId);
  if (
    batches?.length !== 1 ||
    batches[0].verified !== true ||
    batches[0].irregularEntries !== 0 ||
    batches[0].storedFiles !== accounting.quarantineFiles ||
    batches[0].storedBytes !== accounting.quarantineBytes ||
    items?.length !== 1 ||
    items[0].provider !== provider ||
    items[0].root !== root ||
    items[0].items?.length !== 1
  )
    return "BATCH_UNVERIFIED";
  if (!accounting.quarantineFiles)
    return accounting.sourceUnchanged
      ? "NOT_REQUIRED_SOURCE_PRESENT"
      : "PRESERVATION_UNVERIFIED";
  if (items[0].items[0].status !== "quarantined")
    return "RECONCILIATION_UNVERIFIED";
  if (observation?.complete !== true || observation.status !== "clear")
    return "PROCESS_GUARD_BLOCKED";
  return "READY";
}
// End pure bounded helpers.

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
  originals.set(file, {
    sha256: await hash(file),
    bytes: (await fs.stat(file)).size,
  });
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
  for (const [file, expected] of originals) {
    if (!file.startsWith(roots[provider] + path.sep)) continue;
    let actual;
    try {
      actual = await hash(file);
    } catch {
      assert.fail("FIXTURE_SOURCE_UNREADABLE");
    }
    assert.equal(actual, expected.sha256, "FIXTURE_SOURCE_CHANGED");
  }
}
const providerEvidence = {};
const providerExpectations = new Map();
async function collectFixtureInventory(provider) {
  const root = roots[provider];
  assert.ok(
    root && path.dirname(root) === base && (await fs.realpath(root)) === root,
    "FIXTURE_ROOT_UNVERIFIED",
  );
  const inventory = { complete: true, irregularEntries: 0, files: [] };
  let visited = 0,
    totalBytes = 0;
  const walk = async (
    directory,
    relative = "",
    location = "source",
    layer = "source",
    depth = 0,
  ) => {
    if (depth > providerRecoveryLimits.depth) {
      inventory.complete = false;
      return;
    }
    assert.equal(
      await fs.realpath(directory),
      directory,
      "FIXTURE_DIRECTORY_UNVERIFIED",
    );
    for await (const entry of await fs.opendir(directory)) {
      if (++visited > providerRecoveryLimits.nodes) {
        inventory.complete = false;
        return;
      }
      const file = path.join(directory, entry.name);
      const child = relative ? relative + "/" + entry.name : entry.name;
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) {
          inventory.irregularEntries++;
          continue;
        }
        if (
          layer === "source" &&
          relative === "" &&
          entry.name === ".agentvac-quarantine"
        ) {
          if (!stat.isDirectory()) {
            inventory.irregularEntries++;
            continue;
          }
          await walk(file, "", "quarantine", "quarantine", depth + 1);
          continue;
        }
        if (layer === "quarantine") {
          if (!fixtureBatchId(entry.name) || !stat.isDirectory()) {
            inventory.irregularEntries++;
            continue;
          }
          await walk(file, child, location, "batch", depth + 1);
          continue;
        }
        if (layer === "batch") {
          if (entry.name === "manifest.json") {
            if (!stat.isFile() || stat.nlink !== 1)
              inventory.irregularEntries++;
            continue; // Authenticate using inspectRecovery; never read or emit journal/key bytes here.
          }
          const suffix = entry.name.endsWith(".unit") ? ".unit" : ".data";
          if (
            !fixtureBatchId(entry.name.slice(0, -suffix.length)) ||
            !entry.name.endsWith(suffix) ||
            (suffix === ".unit" ? !stat.isDirectory() : !stat.isFile())
          ) {
            inventory.irregularEntries++;
            continue;
          }
        }
        if (stat.isDirectory()) {
          await walk(
            file,
            child,
            location,
            layer === "source" ? "source" : "payload",
            depth + 1,
          );
        } else if (stat.isFile()) {
          if (
            inventory.files.length >= providerRecoveryLimits.files ||
            stat.size > providerRecoveryLimits.fileBytes ||
            totalBytes + stat.size > providerRecoveryLimits.totalBytes
          ) {
            inventory.complete = false;
            continue;
          }
          const handle = await fs.open(
            file,
            constants.O_RDONLY |
              (constants.O_NOFOLLOW ?? 0) |
              (constants.O_NONBLOCK ?? 0),
          );
          try {
            const before = await handle.stat();
            assert.ok(
              before.isFile() &&
                before.dev === stat.dev &&
                before.ino === stat.ino &&
                before.size === stat.size &&
                before.mtimeMs === stat.mtimeMs,
              "FIXTURE_FILE_CHANGED",
            );
            const bytes = Buffer.alloc(stat.size + 1);
            let read = 0;
            while (read < bytes.length) {
              const next = await handle.read(
                bytes,
                read,
                bytes.length - read,
                read,
              );
              if (!next.bytesRead) break;
              read += next.bytesRead;
            }
            const after = await handle.stat(),
              current = await fs.lstat(file);
            assert.ok(
              read === stat.size &&
                after.size === stat.size &&
                after.mtimeMs === stat.mtimeMs &&
                current.dev === stat.dev &&
                current.ino === stat.ino &&
                !current.isSymbolicLink(),
              "FIXTURE_FILE_CHANGED",
            );
            totalBytes += read;
            inventory.files.push({
              relative: child,
              location,
              bytes: read,
              sha256: createHash("sha256")
                .update(bytes.subarray(0, read))
                .digest("hex"),
            });
          } finally {
            await handle.close();
          }
        } else inventory.irregularEntries++;
      } catch {
        inventory.complete = false;
        inventory.irregularEntries++;
      }
    }
  };
  await walk(root);
  return inventory;
}
async function saveProviderEvidence(provider) {
  try {
    await fs.writeFile(
      path.join(
        out,
        `provider-preservation-${process.platform}-${process.arch}-${provider}.json`,
      ),
      JSON.stringify({ ...metadata, ...providerEvidence[provider] }, null, 2) +
        "\n",
    );
  } catch {
    throw new Error("PROVIDER_EVIDENCE_WRITE_FAILED");
  }
}

async function captureProviderState(provider, stage, batchId) {
  const accounting = accountFixtureBytes(
    providerExpectations.get(provider),
    await collectFixtureInventory(provider).catch(() => ({
      complete: false,
      irregularEntries: 1,
      files: [],
    })),
  );
  let inspection, history;
  try {
    inspection = await page.evaluate(() => window.agentvac.inspectRecovery());
  } catch {
    /* Explicitly unverified below. */
  }
  try {
    history = await page.evaluate(() => window.agentvac.history());
  } catch {
    /* Explicitly unverified below. */
  }
  const batch = inspection?.batches?.find((item) => item.id === batchId);
  const record = history?.find((item) => item.id === batchId);
  const checkpoint = {
    stage,
    ...accounting,
    inspectionAvailable: !!inspection,
    historyAvailable: !!history,
    batchAuthenticated: batch?.verified === true,
    batchStoredFiles: Number.isSafeInteger(batch?.storedFiles)
      ? batch.storedFiles
      : null,
    batchStoredBytes: Number.isSafeInteger(batch?.storedBytes)
      ? batch.storedBytes
      : null,
    batchIrregularEntries: Number.isSafeInteger(batch?.irregularEntries)
      ? batch.irregularEntries
      : null,
    itemStatuses:
      record?.items
        ?.slice(0, 8)
        .map((item) =>
          ["pending", "quarantined", "restored", "failed", "trashed"].includes(
            item.status,
          )
            ? item.status
            : "invalid",
        ) ?? [],
  };
  providerEvidence[provider].checkpoints.push(checkpoint);
  await saveProviderEvidence(provider);
  console.log(
    "AGENTVAC_PROVIDER_PRESERVATION " +
      JSON.stringify({
        provider,
        stage,
        complete: accounting.complete,
        exactBytes: accounting.exactBytes,
        sourceUnchanged: accounting.sourceUnchanged,
        protectedFilesUnchanged: accounting.protectedFilesUnchanged,
        sourceFiles: accounting.sourceFiles,
        quarantineFiles: accounting.quarantineFiles,
        duplicateCopies: accounting.duplicateCopies,
        batchAuthenticated: checkpoint.batchAuthenticated,
      }),
  );
  return { accounting, inspection, history };
}
async function recordProviderBaseline(provider, row) {
  const members = row.cleanupUnit.members;
  assert.ok(
    Array.isArray(members) && members.length > 0,
    "FIXTURE_MEMBERS_UNVERIFIED",
  );
  providerExpectations.set(
    provider,
    [...originals]
      .filter(([file]) => file.startsWith(roots[provider] + path.sep))
      .map(([file, expected]) => {
        const relative = path
          .relative(roots[provider], file)
          .split(path.sep)
          .join("/");
        return {
          relative,
          ...expected,
          mutable: members.some(
            (member) =>
              relative === member || relative.startsWith(member + "/"),
          ),
        };
      }),
  );
  providerEvidence[provider] = {
    provider,
    lifecyclePass: false,
    recovery: "NOT_ATTEMPTED",
    checkpoints: [],
  };
  const baseline = await captureProviderState(provider, "before-quarantine");
  assert.ok(
    baseline.accounting.sourceUnchanged &&
      baseline.accounting.quarantineFiles === 0,
    "FIXTURE_BASELINE_UNVERIFIED",
  );
}
async function diagnoseProviderFailure(provider, outcome, allowRecovery) {
  const evidence = providerEvidence[provider];
  evidence.mutation = mutationOutcomeSummary(
    provider,
    allowRecovery ? "QUARANTINE" : "GUARD_QUARANTINE",
    outcome,
  );
  const batchId =
    outcome.status === "fulfilled" ? outcome.value?.batchId : undefined;
  try {
    await captureProviderState(provider, "after-quarantine-failure", batchId);
    await close();
    await launch();
    const context = await page.evaluate(() => window.agentvac.getContext());
    assert.ok(
      context.provider === provider && context.root === roots[provider],
      "RESTART_CONTEXT_UNVERIFIED",
    );
    const restarted = await captureProviderState(
      provider,
      "after-failure-restart",
      batchId,
    );
    evidence.restartVerified = true;
    if (!allowRecovery) {
      evidence.recovery = "NOT_ATTEMPTED_NEGATIVE_GUARD";
      return;
    }
    if (
      restarted.accounting.sourceUnchanged &&
      restarted.accounting.quarantineFiles === 0
    ) {
      evidence.recovery = "NOT_REQUIRED_SOURCE_PRESENT";
      return;
    }
    // This observation never authorizes an override. The single restore below
    // performs all normal production admission and per-member guards again.
    const observation = await nativeProcessObservation(application, provider);
    evidence.recoveryObservation = {
      status: ["clear", "running", "unknown"].includes(observation.status)
        ? observation.status
        : "invalid",
      complete: observation.complete === true,
    };
    evidence.recovery = recoveryAdmission(
      restarted.accounting,
      restarted.inspection,
      restarted.history,
      provider,
      roots[provider],
      batchId,
      observation,
    );
    if (evidence.recovery !== "READY") return;
    let restored;
    try {
      restored = {
        status: "fulfilled",
        value: await page
          .evaluate((id) => window.agentvac.restore(id, true), batchId)
          .then(...providerMutationObservationHandlers(provider, "RESTORE")),
      };
    } catch (reason) {
      restored = { status: "rejected", reason };
    }
    evidence.recoveryMutation = mutationOutcomeSummary(
      provider,
      "RESTORE",
      restored,
    );
    const after = await captureProviderState(
      provider,
      "after-recovery-attempt",
      batchId,
    );
    const completed =
      restored.status === "fulfilled" &&
      restored.value.completed === 1 &&
      Array.isArray(restored.value.failed) &&
      restored.value.failed.length === 0;
    evidence.recovery =
      completed &&
      after.accounting.sourceUnchanged &&
      after.accounting.quarantineFiles === 0
        ? "RESTORED_PENDING_RESTART"
        : "BLOCKED_OR_UNVERIFIED";
    if (evidence.recovery !== "RESTORED_PENDING_RESTART") return;
    await close();
    await launch();
    const final = await captureProviderState(
      provider,
      "after-recovery-restart",
      batchId,
    );
    const finalContext = await page.evaluate(() =>
      window.agentvac.getContext(),
    );
    const finalBatch = final.history?.find((item) => item.id === batchId);
    evidence.recovery =
      finalContext.provider === provider &&
      finalContext.root === roots[provider] &&
      recoveryAdmission(
        final.accounting,
        final.inspection,
        final.history,
        provider,
        roots[provider],
        batchId,
      ) === "NOT_REQUIRED_SOURCE_PRESENT" &&
      finalBatch.items[0].status === "restored"
        ? "RESTORED_VERIFIED"
        : "RECOVERY_RESTART_UNVERIFIED";
  } catch {
    evidence.recovery = "DIAGNOSTIC_UNVERIFIED";
  } finally {
    await saveProviderEvidence(provider);
    console.log(
      "AGENTVAC_PROVIDER_RECOVERY " +
        JSON.stringify({
          provider,
          recovery: evidence.recovery,
          lifecyclePass: false,
        }),
    );
  }
}

async function runProvider(provider, anchor) {
  if (!application) await launch();
  const context = await page.evaluate(
    (id) => window.agentvac.activateWorkspace(id),
    ids[provider],
  );
  assert.equal(context.provider, provider);
  console.log(
    "AGENTVAC_PROCESS_PREFLIGHT " +
      JSON.stringify(await nativeProcessObservation(application, provider)),
  );
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
  await recordProviderBaseline(provider, row);
  if (preview.processStatus.status !== "clear") {
    console.log(
      "AGENTVAC_PROCESS_GUARD " +
        JSON.stringify({
          provider,
          previewStatus: preview.processStatus.status,
          details: preview.processStatus.details,
          observation: await nativeProcessObservation(application, provider),
        }),
    );
    let outcome;
    try {
      outcome = {
        status: "fulfilled",
        value: await page
          .evaluate(
            (token) => window.agentvac.quarantine(token, true),
            preview.token,
          )
          .then(
            ...providerMutationObservationHandlers(
              provider,
              "GUARD_QUARANTINE",
            ),
          ),
      };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
    await diagnoseProviderFailure(provider, outcome, false);
    await verifyOriginals(provider);
    const preservation = providerEvidence[provider].checkpoints.findLast(
      (item) =>
        item.stage === "after-quarantine-failure" ||
        item.stage === "after-failure-restart",
    );
    assert.ok(
      preservation?.sourceUnchanged &&
        preservation.quarantineFiles === 0 &&
        preservation.duplicateCopies === 0,
      "GUARD_PRESERVATION_UNVERIFIED",
    );
    assert.equal(
      isProcessRefusal(provider, outcome, anchor),
      true,
      "TYPED_PROCESS_REFUSAL_REQUIRED",
    );
    return {
      status: "FAIL",
      reason: "REQUIRED_MUTATION_GUARD_BLOCKED",
      guard: preview.processStatus.status,
      details: preview.processStatus.details,
      refusalVerified: true,
      mutationNotTested: true,
    };
  }
  let moved;
  try {
    moved = await page
      .evaluate(
        (token) => window.agentvac.quarantine(token, true),
        preview.token,
      )
      .then(...providerMutationObservationHandlers(provider, "QUARANTINE"));
  } catch (reason) {
    await diagnoseProviderFailure(
      provider,
      { status: "rejected", reason },
      true,
    );
    throw reason;
  }
  if (
    moved?.completed !== 1 ||
    !Array.isArray(moved.failed) ||
    moved.failed.length
  )
    await diagnoseProviderFailure(
      provider,
      { status: "fulfilled", value: moved },
      true,
    );
  assert.equal(moved.completed, 1);
  assert.deepEqual(moved.failed, []);
  await assert.rejects(
    page
      .evaluate(
        (token) => window.agentvac.quarantine(token, true),
        preview.token,
      )
      .then(
        ...providerMutationObservationHandlers(
          provider,
          "DUPLICATE_QUARANTINE",
        ),
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
    const result = await page
      .evaluate((id) => window.agentvac.restore(id, true), moved.batchId)
      .then(
        ...providerMutationObservationHandlers(provider, "RESTORE_CONFLICT"),
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
  const restored = await page
    .evaluate((id) => window.agentvac.restore(id, true), moved.batchId)
    .then(...providerMutationObservationHandlers(provider, "RESTORE"));
  assert.equal(restored.completed, 1);
  assert.deepEqual(restored.failed, []);
  await verifyOriginals(provider);
  assert.equal(
    (
      await page
        .evaluate((id) => window.agentvac.restore(id, true), moved.batchId)
        .then(
          ...providerMutationObservationHandlers(provider, "RESTORE_REPLAY"),
        )
    ).completed,
    0,
  );
  // Old IDs/tokens cannot be reused after switching provider/root context.
  await page.evaluate(() => window.agentvac.setProvider("codex"));
  await assert.rejects(
    page
      .evaluate(
        (token) => window.agentvac.quarantine(token, true),
        preview.token,
      )
      .then(
        ...providerMutationObservationHandlers(provider, "SWITCHED_QUARANTINE"),
      ),
  );
  await page.evaluate(
    (id) => window.agentvac.activateWorkspace(id),
    ids[provider],
  );
  await verifyOriginals(provider);
  const preserved = await captureProviderState(provider, "after-lifecycle");
  assert.ok(
    preserved.accounting.sourceUnchanged &&
      preserved.accounting.quarantineFiles === 0,
    "LIFECYCLE_PRESERVATION_UNVERIFIED",
  );
  providerEvidence[provider].lifecyclePass = true;
  providerEvidence[provider].recovery = "NOT_REQUIRED_LIFECYCLE_PASSED";
  await saveProviderEvidence(provider);
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
      if (application) {
        try {
          console.log(
            "AGENTVAC_PROCESS_GUARD " +
              JSON.stringify(
                await nativeProcessObservation(application, provider),
              ),
          );
        } catch {
          console.log("AGENTVAC_PROCESS_GUARD_UNAVAILABLE");
        }
      }
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
  const result = {
    ...metadata,
    status,
    security,
    checks,
    errors,
    preservation: providerEvidence,
  };
  await fs.writeFile(
    path.join(out, `providers-${process.platform}-${process.arch}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  // Failed synthetic fixtures stay local for diagnosis; they are never uploaded by this workflow.
  if (status === "PASS") await fs.rm(base, { recursive: true, force: true });
}
if (status !== "PASS") process.exitCode = 1;
