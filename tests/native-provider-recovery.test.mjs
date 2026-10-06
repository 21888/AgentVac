import assert from "node:assert/strict";
import { readFileSync, promises as fs, constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { providerMutationObservationHandlers } from "../scripts/native-mutation-observation.mjs";

// Pure helper tests only: no Electron launch, real data, mocked native guard,
// manifest editing, file movement, or native acceptance claims.
const source = readFileSync(
  new URL("../scripts/native-provider-regression.mjs", import.meta.url),
  "utf8",
);
const helpers = source.slice(
  source.indexOf("// Pure bounded helpers."),
  source.indexOf("// End pure bounded helpers."),
);
const {
  accountFixtureBytes,
  isProcessRefusal,
  recoveryAdmission,
  mutationOutcomeSummary,
} = new Function(
  "assert",
  "providerMutationObservationHandlers",
  helpers +
    "\nreturn { accountFixtureBytes, isProcessRefusal, recoveryAdmission, mutationOutcomeSummary };",
)(assert, providerMutationObservationHandlers);
const batchId = "11111111-1111-4111-8111-111111111111";
const unknown = "无法确认进程状态，已阻止文件操作。";
const protectedFile = {
  relative: "protected",
  bytes: 12,
  sha256: "1".repeat(64),
  mutable: false,
};
const db = {
  relative: "search.db",
  bytes: 20,
  sha256: "2".repeat(64),
  mutable: true,
};
const wal = {
  relative: "search.db-wal",
  bytes: 8,
  sha256: "3".repeat(64),
  mutable: true,
};
const expected = [protectedFile, db, wal];
const asSource = (row) => ({ ...row, location: "source" });
const asStored = (row) => ({
  ...row,
  relative: "opaque-payload",
  location: "quarantine",
});
const inventory = (files) => ({ complete: true, irregularEntries: 0, files });
const original = () => inventory(expected.map(asSource));
const split = () =>
  inventory([asSource(protectedFile), asStored(db), asSource(wal)]);
const refused = (error = unknown) => ({
  status: "fulfilled",
  value: {
    batchId,
    completed: 0,
    bytes: 0,
    failed: [{ path: "search.db", error }],
  },
});
const inspect = () => ({
  provider: "cline",
  root: "/generated",
  readOnly: true,
  truncated: false,
  batches: [
    {
      id: batchId,
      verified: true,
      storedFiles: 1,
      storedBytes: 20,
      irregularEntries: 0,
    },
  ],
});
const history = () => [
  {
    id: batchId,
    provider: "cline",
    root: "/generated",
    items: [{ status: "quarantined" }],
  },
];
const clear = { status: "clear", complete: true };
const admit = (
  accounting = accountFixtureBytes(expected, split()),
  inspection = inspect(),
  records = history(),
  observation = clear,
) =>
  recoveryAdmission(
    accounting,
    inspection,
    records,
    "cline",
    "/generated",
    batchId,
    observation,
  );

test("typed process refusal accepts only exact thrown or zero-completion failed-batch forms", () => {
  for (const error of [unknown, "检测到 Cline 正在运行，请退出后重试。"])
    for (const outcome of [
      refused(error),
      {
        status: "rejected",
        reason: new Error(
          "page.evaluate: Error: Error invoking remote method 'agentvac:quarantine': Error: " +
            error,
        ),
      },
    ])
      assert.equal(isProcessRefusal("cline", outcome, "search.db"), true);
});

test("guard refuses successful, malformed, partial, unrelated and nested recovery outcomes", () => {
  for (const error of [
    "另一项操作正在进行，请稍候。",
    "源文件已变化。",
    "garbage " + unknown,
    "移动已完成或部分完成，记录待协调；请刷新隔离记录。" +
      unknown +
      " 回滚尚未完成；数据仍保留：" +
      unknown,
  ]) {
    assert.equal(isProcessRefusal("cline", refused(error), "search.db"), false);
    assert.equal(
      isProcessRefusal(
        "cline",
        { status: "rejected", reason: new Error(error) },
        "search.db",
      ),
      false,
    );
  }
  for (const patch of [
    { completed: 1 },
    { bytes: 1 },
    { batchId: "invalid" },
    { failed: [] },
    { failed: [{ path: "wrong", error: unknown }] },
    { failed: [...refused().value.failed, ...refused().value.failed] },
  ])
    assert.equal(
      isProcessRefusal(
        "cline",
        { status: "fulfilled", value: { ...refused().value, ...patch } },
        "search.db",
      ),
      false,
    );
});

test("original and split locations account for every original byte without source-path output", () => {
  const before = accountFixtureBytes(expected, original());
  assert.equal(before.sourceUnchanged, true);
  const partial = accountFixtureBytes(expected, split());
  assert.equal(partial.exactBytes, true);
  assert.equal(partial.sourceUnchanged, false);
  assert.equal(partial.protectedFilesUnchanged, true);
  assert.equal(partial.originalBytes, 40);
  assert.equal(partial.quarantineFiles, 1);
  assert.equal(partial.quarantineBytes, 20);
  assert.equal(partial.files[1].quarantineCopies, 1);
  assert.ok(!JSON.stringify(partial).includes("search.db"));
  assert.ok(!JSON.stringify(partial).includes("opaque-payload"));
});

test("missing, changed, unexpected, irregular and truncated data cannot prove preservation", () => {
  const variants = [
    inventory([asSource(protectedFile), asSource(wal)]),
    inventory([
      asSource(protectedFile),
      { ...asStored(db), sha256: "9".repeat(64) },
      asSource(wal),
    ]),
    inventory([
      asSource(protectedFile),
      { ...asSource(db), bytes: 19 },
      asSource(wal),
    ]),
    inventory([
      ...original().files,
      { ...asStored(db), sha256: "9".repeat(64) },
    ]),
    { ...original(), complete: false },
    { ...original(), irregularEntries: 1 },
  ];
  for (const value of variants)
    assert.equal(accountFixtureBytes(expected, value).exactBytes, false);
});

test("duplicate byte copies are visible and cannot authorize recovery", () => {
  const value = accountFixtureBytes(
    expected,
    inventory([...original().files, asStored(db)]),
  );
  assert.equal(value.exactBytes, true);
  assert.equal(value.duplicateCopies, 1);
  assert.equal(admit(value), "PRESERVATION_UNVERIFIED");
});

test("protected files must stay at their exact source location", () => {
  const value = accountFixtureBytes(
    expected,
    inventory([asStored(protectedFile), asStored(db), asSource(wal)]),
  );
  assert.equal(value.exactBytes, true);
  assert.equal(value.protectedFilesUnchanged, false);
  assert.equal(admit(value), "PRESERVATION_UNVERIFIED");
});

test("accounting rejects excessive or ambiguous inventories and invalid fingerprints", () => {
  assert.throws(
    () =>
      accountFixtureBytes(expected, inventory(Array(65).fill(asSource(db)))),
    /BOUNDS/,
  );
  assert.throws(
    () => accountFixtureBytes([db, db], inventory([])),
    /AMBIGUOUS/,
  );
  assert.throws(
    () => accountFixtureBytes([{ ...db, sha256: "secret" }], inventory([])),
    /FINGERPRINT/,
  );
  assert.throws(
    () => accountFixtureBytes([{ ...db, bytes: Infinity }], inventory([])),
    /FINGERPRINT/,
  );
});

test("recovery requires clear complete current observation and matching authenticated batch", () => {
  assert.equal(admit(), "READY");
  for (const observation of [
    { status: "unknown", complete: false },
    { status: "running", complete: true },
    { status: "clear", complete: false },
    null,
  ])
    assert.equal(
      admit(undefined, undefined, undefined, observation),
      "PROCESS_GUARD_BLOCKED",
    );
  for (const patch of [
    { provider: "cursor" },
    { root: "/other" },
    { readOnly: false },
    { truncated: true },
  ])
    assert.equal(
      admit(undefined, { ...inspect(), ...patch }),
      "INSPECTION_UNVERIFIED",
    );
  for (const patch of [
    { verified: false },
    { storedFiles: 0 },
    { storedBytes: 19 },
    { irregularEntries: 1 },
  ]) {
    const inspection = inspect();
    Object.assign(inspection.batches[0], patch);
    assert.equal(admit(undefined, inspection), "BATCH_UNVERIFIED");
  }
  for (const patch of [
    { provider: "cursor" },
    { root: "/other" },
    { items: [] },
  ])
    assert.equal(
      admit(undefined, undefined, [{ ...history()[0], ...patch }]),
      "BATCH_UNVERIFIED",
    );
  assert.equal(
    admit(undefined, undefined, [
      { ...history()[0], items: [{ status: "pending" }] },
    ]),
    "RECONCILIATION_UNVERIFIED",
  );
});

test("complete source restoration needs no additional mutation", () => {
  const inspection = inspect();
  inspection.batches[0].storedFiles = 0;
  inspection.batches[0].storedBytes = 0;
  assert.equal(
    admit(accountFixtureBytes(expected, original()), inspection, history(), {
      status: "unknown",
      complete: false,
    }),
    "NOT_REQUIRED_SOURCE_PRESENT",
  );
});

test("outcome summaries remain bounded, redact unknown errors, and preserve caller outcome", () => {
  const outcome = refused("PRIVATE_PATH_OR_CONTENT");
  outcome.value.failed[0].path = "PRIVATE_PATH_OR_CONTENT";
  const summary = mutationOutcomeSummary("cline", "QUARANTINE", outcome);
  assert.ok(!JSON.stringify(summary).includes("PRIVATE_PATH_OR_CONTENT"));
  assert.deepEqual(summary.failedItems[0].inferredReasonCodes, [
    "UNCLASSIFIED",
  ]);
  assert.equal(outcome.value.failed[0].path, "PRIVATE_PATH_OR_CONTENT");
  const huge = refused();
  huge.value.failed = Array(100).fill(huge.value.failed[0]);
  assert.equal(
    mutationOutcomeSummary("cline", "QUARANTINE", huge).failedItems.length,
    8,
  );
});

const runtime = source.slice(
  source.indexOf("const providerEvidence = {};"),
  source.indexOf("async function runProvider("),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function exerciseRecovery(
  observation,
  restoreOutcome = { completed: 1, failed: [] },
) {
  const checkpoints = [],
    calls = [],
    logs = [];
  const evidence = { cline: { lifecyclePass: false, checkpoints: [] } };
  const partial = {
    accounting: accountFixtureBytes(expected, split()),
    inspection: inspect(),
    history: history(),
  };
  const complete = {
    accounting: accountFixtureBytes(expected, original()),
    inspection: {
      ...inspect(),
      batches: [{ ...inspect().batches[0], storedFiles: 0, storedBytes: 0 }],
    },
    history: [{ ...history()[0], items: [{ status: "restored" }] }],
  };
  const context = {
    assert,
    providerMutationObservationHandlers,
    providerEvidence: evidence,
    roots: { cline: "/generated" },
    application: {},
    captureProviderState: async (_provider, stage) => {
      checkpoints.push(stage);
      return stage.startsWith("after-recovery") ? complete : partial;
    },
    close: async () => {
      calls.push("close");
    },
    launch: async () => {
      calls.push("launch");
    },
    saveProviderEvidence: async () => {},
    nativeProcessObservation: async () => {
      calls.push("observe");
      return observation;
    },
    page: {
      evaluate: async (callback) => {
        if (callback.toString().includes("getContext"))
          return { provider: "cline", root: "/generated" };
        calls.push("restore");
        if (restoreOutcome instanceof Error) throw restoreOutcome;
        return restoreOutcome;
      },
    },
    console: { log: (line) => logs.push(line) },
  };
  const body =
    helpers +
    "\n" +
    runtime.slice(runtime.indexOf("async function diagnoseProviderFailure(")) +
    "\nawait diagnoseProviderFailure('cline', {status: 'fulfilled', value: {batchId: '" +
    batchId +
    "', completed: 0, bytes: 0, failed: []}}, true);";
  await new AsyncFunction(...Object.keys(context), body)(
    ...Object.values(context),
  );
  return { evidence: evidence.cline, checkpoints, calls, logs };
}

test("recovery orchestration never restores on unknown, running or incomplete observation", async () => {
  for (const observation of [
    { status: "unknown", complete: false },
    { status: "running", complete: true },
    { status: "clear", complete: false },
  ]) {
    const result = await exerciseRecovery(observation);
    assert.equal(result.evidence.recovery, "PROCESS_GUARD_BLOCKED");
    assert.deepEqual(result.calls, ["close", "launch", "observe"]);
    assert.deepEqual(result.checkpoints, [
      "after-quarantine-failure",
      "after-failure-restart",
    ]);
    assert.equal(result.evidence.lifecyclePass, false);
  }
});

test("one guarded restore verifies bytes and a second restart without promoting lifecycle", async () => {
  const result = await exerciseRecovery(clear);
  assert.equal(result.evidence.recovery, "RESTORED_VERIFIED");
  assert.equal(result.evidence.lifecyclePass, false);
  assert.deepEqual(result.calls, [
    "close",
    "launch",
    "observe",
    "restore",
    "close",
    "launch",
  ]);
  assert.deepEqual(result.checkpoints, [
    "after-quarantine-failure",
    "after-failure-restart",
    "after-recovery-attempt",
    "after-recovery-restart",
  ]);
});

test("restore recheck refusal records preservation once and never retries", async () => {
  for (const outcome of [new Error(unknown), refused().value]) {
    const result = await exerciseRecovery(clear, outcome);
    assert.equal(result.evidence.recovery, "BLOCKED_OR_UNVERIFIED");
    assert.equal(result.evidence.lifecyclePass, false);
    assert.deepEqual(result.calls, ["close", "launch", "observe", "restore"]);
    assert.equal(result.checkpoints.at(-1), "after-recovery-attempt");
  }
});

test("generated filesystem inventory sees split bytes, skips journal contents, and rejects links", async () => {
  // Retain this tiny generated tree for diagnosis; no source or payload deletion.
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-provider-inventory-")),
  );
  const root = path.join(base, "cline"),
    roots = { cline: root };
  const container = path.join(
    root,
    ".agentvac-quarantine",
    batchId,
    batchId + ".unit",
  );
  await fs.mkdir(container, { recursive: true });
  await fs.writeFile(path.join(root, "protected"), "protected fixture");
  await fs.writeFile(path.join(root, "wal"), "wal fixture");
  await fs.writeFile(path.join(container, "0"), "generated db fixture");
  await fs.writeFile(
    path.join(path.dirname(container), "manifest.json"),
    "JOURNAL_CONTENT_NEVER_HASHED",
  );
  const context = {
    assert,
    fs,
    constants,
    path,
    createHash,
    base,
    roots,
    providerMutationObservationHandlers,
  };
  const collect = new AsyncFunction(
    ...Object.keys(context),
    helpers + "\n" + runtime + "\nreturn collectFixtureInventory('cline');",
  );
  const collected = await collect(...Object.values(context));
  assert.equal(collected.complete, true);
  assert.equal(collected.irregularEntries, 0);
  assert.equal(collected.files.length, 3);
  assert.equal(
    collected.files.filter((row) => row.location === "quarantine").length,
    1,
  );
  const journalHash = createHash("sha256")
    .update("JOURNAL_CONTENT_NEVER_HASHED")
    .digest("hex");
  assert.ok(collected.files.every((row) => row.sha256 !== journalHash));
  await fs.symlink(
    path.join(root, "protected"),
    path.join(root, "unexpected-link"),
  );
  const unsafe = await collect(...Object.values(context));
  assert.equal(unsafe.irregularEntries, 1);
  assert.equal(unsafe.files.length, 3);
});
