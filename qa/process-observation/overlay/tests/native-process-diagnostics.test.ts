import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createNativeProcessObservationCollector,
  nativeProcessObservation,
} from "../scripts/native-process-diagnostics.mjs";
import { createProcessObservationSink } from "../electron/process-observations.js";

type Application = Parameters<typeof nativeProcessObservation>[0];
function fakeMain(read?: unknown): Application {
  return {
    async evaluate(fn: () => unknown) {
      const context = {
        __agentvacReadProcessObservations: read,
        get process() {
          throw new Error(
            "Process enumeration is forbidden during observation reads",
          );
        },
        get window() {
          throw new Error(
            "Renderer access is forbidden during observation reads",
          );
        },
      };
      return runInNewContext(`(${fn.toString()})()`, context);
    },
  } as Application;
}
const event = {
  call: 1,
  provider: "claude-code",
  operation: "preview",
  stage: "provider-result",
  outcome: "unknown",
};
const batch = (observations: unknown[], overrides = {}) => ({
  version: 1,
  observations,
  dropped: 0,
  calls: 1,
  ...overrides,
});

test("native diagnostics drain actual guard observations without a later process snapshot or another guard call", async () => {
  const sink = createProcessObservationSink();
  const guard = sink.begin("claude-code", "preview");
  guard({
    stage: "stable-attempt",
    outcome: "incomplete",
    attempt: 1,
    rows: 4,
  });
  guard({ stage: "provider-result", outcome: "unknown" });
  const application = fakeMain(() => sink.read());
  const result = await nativeProcessObservation(application);
  assert.equal(result.available, true);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.observations, [
    {
      ...event,
      stage: "stable-attempt",
      outcome: "incomplete",
      attempt: 1,
      rows: 4,
    },
    event,
  ]);
  const repeated = await nativeProcessObservation(application);
  assert.equal(repeated.calls, 1);
  assert.deepEqual(repeated.observations, []);
  assert.equal(repeated.dropped, 0);
});

test("native process diagnostics retain only fixed codes and counts, never process identities or private arguments", async () => {
  const result = await nativeProcessObservation(
    fakeMain(() =>
      batch([
        {
          ...event,
          name: "/usr/bin/python3",
          pid: 42,
          commandLine:
            "/usr/bin/python3 /usr/bin/networkd-dispatcher --private-secret=DO_NOT_LOG",
          argv: ["SECRET_CODE"],
          env: { PRIVATE: "SECRET_ENV" },
          stderr: "SECRET_STDERR",
          dialogue: "SECRET_DIALOGUE",
          details: "SECRET_DETAILS",
          rows: 3.9,
          bytes: Number.POSITIVE_INFINITY,
          elapsedMs: -1,
          missingRows: "SECRET_COUNT",
          commandRows: 2_000_000_000,
          complete: false,
          timeout: "SECRET_FLAG",
        },
        { ...event, outcome: "SECRET_OUTCOME" },
        { ...event, stage: "SECRET_STAGE" },
        { ...event, operation: "SECRET_OPERATION" },
        { ...event, provider: "SECRET_PROVIDER" },
        { ...event, call: 42 },
        { ...event, call: 0 },
        { ...event, call: 1.5 },
        null,
      ]),
    ),
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.observations, [
    { ...event, rows: 3, commandRows: 1_000_000_000, complete: false },
  ]);
  assert.equal(result.dropped, 8);
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET_|DO_NOT_LOG|networkd-dispatcher|\/usr\/bin\/|"pid"|"name"/,
  );
});

test("the harness retains the main sink's diagnostic and mutation operation codes", async () => {
  const operations = [
    "preview",
    "quarantine",
    "restore",
    "prepare-trash",
    "trash",
    "diagnose-storage",
    "scan",
    "startup",
    "other",
  ];
  const sink = createProcessObservationSink();
  for (const operation of operations)
    sink.begin(
      "codex",
      operation,
    )({ stage: "provider-result", outcome: "clear" });
  const result = await nativeProcessObservation(fakeMain(() => sink.read()));
  assert.equal(result.dropped, 0);
  assert.deepEqual(
    result.observations.map((row) => row.operation),
    operations,
  );
});

test("signal termination remains distinct from proven timeout in main-to-harness observations", async () => {
  const sink = createProcessObservationSink();
  sink.begin(
    "cline",
    "quarantine",
  )({ stage: "posix-names", outcome: "command-terminated", timeout: false });
  const result = await nativeProcessObservation(fakeMain(() => sink.read()));
  assert.equal(result.dropped, 0);
  assert.equal(result.observations[0].outcome, "command-terminated");
  assert.equal(result.observations[0].timeout, false);
});

test("absent, failing, and invalid main observation readers remain explicitly unavailable without error disclosure", async () => {
  const cases: [Application, string][] = [
    [fakeMain(), "unavailable"],
    [fakeMain("SECRET_READER"), "unavailable"],
    [
      fakeMain(() => {
        throw new Error("SECRET_PROCESS_PATH");
      }),
      "read-failed",
    ],
    [
      {
        evaluate: async () => {
          throw new Error("SECRET_EVALUATION");
        },
      } as Application,
      "read-failed",
    ],
    [fakeMain(() => batch([], { version: 2 })), "invalid-data"],
    [fakeMain(() => batch([], { calls: -1 })), "invalid-data"],
    [fakeMain(() => batch([], { dropped: Infinity })), "invalid-data"],
    [
      fakeMain(() => batch([], { observations: "SECRET_EVENTS" })),
      "invalid-data",
    ],
  ];
  const collector = createNativeProcessObservationCollector();
  for (const [application, expected] of cases) {
    const result = await collector.drain(application);
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.reason, expected);
    assert.equal(result.calls, 0);
    assert.deepEqual(result.observations, []);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
  }
  assert.deepEqual(collector.snapshot(), {
    version: 1,
    sessions: 8,
    reads: 8,
    availableReads: 0,
    unavailableReads: 2,
    failedReads: 2,
    invalidReads: 4,
    calls: 0,
    dropped: 0,
    observations: [],
  });
});

test("retained harness evidence is bounded across drains and application restarts with explicit drops and cumulative calls", async () => {
  const collector = createNativeProcessObservationCollector(3);
  const first = createProcessObservationSink(2);
  const firstApplication = fakeMain(() => first.read());
  await collector.drain(firstApplication);
  const preview = first.begin("claude-code", "preview");
  for (const stage of ["snapshot", "stable-result", "provider-result"] as const)
    preview({ stage, outcome: "complete" });
  await collector.drain(firstApplication);
  await collector.drain(firstApplication);
  first.begin(
    "claude-code",
    "quarantine",
  )({ stage: "provider-result", outcome: "running" });
  await collector.drain(firstApplication);
  const restarted = createProcessObservationSink();
  restarted.begin(
    "cursor",
    "restore",
  )({ stage: "provider-result", outcome: "clear" });
  await collector.drain(fakeMain(() => restarted.read()));
  const result = collector.snapshot();
  assert.equal(result.sessions, 2);
  assert.equal(result.reads, 5);
  assert.equal(result.calls, 3);
  assert.equal(result.dropped, 2);
  assert.equal(result.observations.length, 3);
  assert.deepEqual(
    result.observations.map(({ session, call }) => [session, call]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
    ],
  );
  assert.deepEqual(
    result.observations.map(({ stage, outcome }) => [stage, outcome]),
    [
      ["provider-result", "complete"],
      ["provider-result", "running"],
      ["provider-result", "clear"],
    ],
  );
  result.observations[0].outcome = "timeout";
  result.observations.length = 0;
  assert.equal(collector.snapshot().observations.length, 3);
  assert.equal(collector.snapshot().observations[0].outcome, "complete");
});

test("both per-read and total retention keep the newest 512 events in order", async () => {
  const collector = createNativeProcessObservationCollector(10_000);
  const application = fakeMain(() =>
    batch(
      Array.from({ length: 600 }, (_, index) => ({
        ...event,
        rows: index + 1,
      })),
      { dropped: 7 },
    ),
  );
  const read = await collector.drain(application);
  assert.equal(read.observations.length, 512);
  assert.equal(read.dropped, 95);
  assert.deepEqual(
    read.observations.map(({ rows }) => rows),
    Array.from({ length: 512 }, (_, index) => index + 89),
  );
  await collector.drain(fakeMain(() => batch([{ ...event, rows: 601 }])));
  assert.equal(collector.snapshot().observations.length, 512);
  assert.equal(collector.snapshot().dropped, 96);
  assert.equal(collector.snapshot().calls, 2);
  assert.deepEqual(
    collector.snapshot().observations.map(({ rows }) => rows),
    Array.from({ length: 512 }, (_, index) => index + 90),
  );
});

test("session identity disambiguates restarted call IDs and rejects a counter rollback", async () => {
  const collector = createNativeProcessObservationCollector();
  let calls = 2;
  const application = fakeMain(() =>
    batch([{ ...event, call: calls }], { calls }),
  );
  await collector.drain(application);
  calls = 1;
  const stale = await collector.drain(application);
  assert.equal(stale.available, false);
  if (!stale.available) assert.equal(stale.reason, "invalid-data");
  await collector.drain(fakeMain(() => batch([event])));
  assert.deepEqual(
    collector
      .snapshot()
      .observations.map(({ session, call }) => [session, call]),
    [
      [1, 2],
      [2, 1],
    ],
  );
  assert.equal(collector.snapshot().calls, 3);
  assert.equal(collector.snapshot().invalidReads, 1);
  assert.equal(collector.snapshot().dropped, 1);
});

test("desktop diagnostics import under plain Node without a TypeScript loader or provider imports", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const helper = new URL(
    "../scripts/native-process-diagnostics.mjs",
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(helper.href)})`,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
