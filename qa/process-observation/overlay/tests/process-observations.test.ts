import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createProcessObservationSink,
  observeProcessInspection,
  processObservationProfileEnabled,
  sanitizeProcessObservation,
  type ProcessInspectionObservation,
} from "../electron/process-observations.js";
import {
  parsePosixProcessSnapshot,
  collectStableProcessSnapshot,
} from "../electron/processes.js";

test("observation boundary accepts only fixed enums, booleans and bounded finite counts", () => {
  const dirty = {
    stage: "posix-reconcile",
    outcome: "incomplete",
    missingRows: 2.9,
    rows: Infinity,
    bytes: 1e20,
    elapsedMs: -1,
    complete: false,
    timeout: "SECRET",
    commandLine: "SECRET_ARG",
    pid: 872341,
    name: "SECRET_NAME",
    path: "/SECRET",
    stderr: "SECRET",
    env: { SECRET: "VALUE" },
  };
  assert.deepEqual(
    sanitizeProcessObservation(
      dirty as unknown as ProcessInspectionObservation,
    ),
    {
      stage: "posix-reconcile",
      outcome: "incomplete",
      missingRows: 2,
      bytes: 1_000_000_000,
      complete: false,
    },
  );
  assert.equal(
    sanitizeProcessObservation({
      stage: "SECRET",
      outcome: "complete",
    } as unknown as ProcessInspectionObservation),
    undefined,
  );
  assert.equal(
    sanitizeProcessObservation({
      stage: "snapshot",
      outcome: "SECRET",
    } as unknown as ProcessInspectionObservation),
    undefined,
  );
});

test("bounded sink reports drops, detaches read results, drains records and preserves call correlation", () => {
  const sink = createProcessObservationSink(2);
  const first = sink.begin("cline", "/SECRET_OPERATION");
  for (let i = 0; i < 3; i++)
    first({ stage: "snapshot", outcome: "incomplete", rows: i });
  const initial = sink.read();
  assert.equal(initial.dropped, 1);
  assert.equal(initial.observations.length, 2);
  assert.deepEqual(
    initial.observations.map((row) => row.rows),
    [1, 2],
  );
  assert.ok(
    initial.observations.every(
      (event) => event.call === 1 && event.operation === "other",
    ),
  );
  const second = sink.begin("cursor", "quarantine");
  second({ stage: "provider-result", outcome: "unknown" });
  assert.deepEqual(sink.read(), {
    version: 1,
    calls: 2,
    dropped: 0,
    observations: [
      {
        stage: "provider-result",
        outcome: "unknown",
        call: 2,
        provider: "cursor",
        operation: "quarantine",
      },
    ],
  });
  assert.deepEqual(sink.read(), {
    version: 1,
    calls: 2,
    dropped: 0,
    observations: [],
  });
  const capped = createProcessObservationSink(100000);
  const observe = capped.begin("codex", "preview");
  for (let i = 0; i < 600; i++)
    observe({ stage: "snapshot", outcome: "complete" });
  const result = capped.read();
  assert.equal(result.observations.length, 512);
  assert.equal(result.dropped, 88);
});

test("observer exceptions, rejected promises, invalid getters and event mutation have no authority", async () => {
  const event: ProcessInspectionObservation = {
    stage: "snapshot",
    outcome: "complete",
  };
  observeProcessInspection(() => {
    throw Error("SECRET");
  }, event);
  observeProcessInspection(async () => {
    throw Error("SECRET");
  }, event);
  observeProcessInspection((row) => {
    row.outcome = "incomplete";
  }, event);
  observeProcessInspection(
    () => assert.fail(),
    Object.defineProperty({}, "stage", {
      get() {
        throw Error("SECRET");
      },
    }) as ProcessInspectionObservation,
  );
  assert.equal(event.outcome, "complete");
  await new Promise((resolve) => setImmediate(resolve));
});

test("reconciliation reports missing rows without treating absence as proof of exit", () => {
  const events: ProcessInspectionObservation[] = [];
  const names = "101 1 S /SECRET/init\n872341 101 S /SECRET/process";
  const commands = "101 1 R /SECRET/init\n872342 101 S /SECRET/extra";
  const plain = parsePosixProcessSnapshot(names, commands, "darwin", [], true);
  const observed = parsePosixProcessSnapshot(
    names,
    commands,
    "darwin",
    [],
    true,
    (event) => events.push(event),
  );
  assert.deepEqual(observed, plain);
  assert.equal(observed.complete, false);
  assert.equal(events.at(-1)?.missingRows, 1);
  assert.equal(events.at(-1)?.extraRows, 1);
  assert.equal(events.at(-1)?.stateChanges, 1);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|872341|872342/);
});

test("complete snapshots retain identity and are never retried into clear with observations", async () => {
  for (const record of [
    { name: "claude", commandLine: "claude" },
    { name: "node", commandLine: "node -e unknown" },
  ]) {
    let calls = 0;
    const snapshot = {
      platform: "darwin" as const,
      complete: true,
      processes: [record],
    };
    const result = await collectStableProcessSnapshot(
      async () => {
        calls++;
        return snapshot;
      },
      {
        observer() {
          throw Error("SECRET");
        },
      },
    );
    assert.equal(result, snapshot);
    assert.equal(calls, 1);
  }
  const abort = new AbortController();
  abort.abort();
  const events: ProcessInspectionObservation[] = [];
  const result = await collectStableProcessSnapshot(
    async () => {
      throw Error("must not collect");
    },
    { signal: abort.signal, observer: (event) => events.push(event) },
  );
  assert.equal(result.complete, false);
  assert.equal(events.at(-1)?.outcome, "cancelled");
  assert.equal(events.at(-1)?.attempts, 0);
  assert.equal(events.at(-1)?.timeout, false);
});

test("main sink requires explicit opt-in, unpackaged app and nonsymlink generated profile marker", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-native-suite-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  await fs.mkdir(profile);
  const options = {
    packaged: false,
    optIn: "1",
    testUserData: profile,
    profile,
  };
  assert.equal(await processObservationProfileEnabled(options), false);
  const marker = path.join(profile, ".agentvac-process-observations");
  await fs.writeFile(marker, "agentvac-generated-process-observation-v1\n", {
    flag: "wx",
    mode: 0o600,
  });
  assert.equal(await processObservationProfileEnabled(options), true);
  for (const change of [
    { packaged: true },
    { optIn: undefined },
    { optIn: "true" },
    { testUserData: undefined },
    { profile: path.join(base, "real-user-profile") },
  ])
    assert.equal(
      await processObservationProfileEnabled({ ...options, ...change }),
      false,
    );
  const otherProfile = path.join(base, "other");
  await fs.mkdir(otherProfile);
  assert.equal(
    await processObservationProfileEnabled({
      ...options,
      testUserData: otherProfile,
      profile: otherProfile,
    }),
    false,
  );
  await fs.writeFile(marker, "wrong marker");
  assert.equal(await processObservationProfileEnabled(options), false);
  await fs.rm(marker);
  const outsideMarker = path.join(base, "marker");
  await fs.writeFile(
    outsideMarker,
    "agentvac-generated-process-observation-v1\n",
  );
  await fs.link(outsideMarker, marker);
  assert.equal(await processObservationProfileEnabled(options), false);
  await fs.rm(marker);
  if (process.platform !== "win32") {
    await fs.symlink(outsideMarker, marker);
    assert.equal(await processObservationProfileEnabled(options), false);
  }
});

test("QA marker replacement between lstat and open fails handle identity verification", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "native-providers-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  await fs.mkdir(profile);
  const marker = path.join(profile, ".agentvac-process-observations");
  const payload = "agentvac-generated-process-observation-v1\n";
  await fs.writeFile(marker, payload);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === marker) {
      await fs.rename(marker, path.join(base, "old-marker"));
      await fs.writeFile(marker, payload);
    }
    return open(...args);
  });
  assert.equal(
    await processObservationProfileEnabled({
      packaged: false,
      optIn: "1",
      testUserData: profile,
      profile,
    }),
    false,
  );
});

test("QA marker content is read once with a 43-byte cap and rejects concurrent growth", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "native-providers-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  await fs.mkdir(profile);
  const marker = path.join(profile, ".agentvac-process-observations");
  await fs.writeFile(marker, "agentvac-generated-process-observation-v1\n");
  const open = fs.open;
  let readCalls = 0,
    requestedBytes = 0;
  t.mock.method(fs, "readFile", () => {
    throw Error("unbounded marker read forbidden");
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === marker) {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          readCalls++;
          requestedBytes = length;
          await fs.appendFile(marker, Buffer.alloc(262144));
          return read(buffer, offset, length, position);
        },
      });
    }
    return handle;
  });
  assert.equal(
    await processObservationProfileEnabled({
      packaged: false,
      optIn: "1",
      testUserData: profile,
      profile,
    }),
    false,
  );
  assert.equal(readCalls, 1);
  assert.equal(requestedBytes, 43);
});

test("actual mocked guard calls report enumeration mismatches, refusals and shared deadline without changing outputs", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "tests/helpers/process-observation-child.ts"],
    { timeout: 30000, maxBuffer: 1_000_000 },
  );
  const report = JSON.parse(stdout) as Record<
    string,
    {
      status?: string;
      commands: number;
      events: ProcessInspectionObservation[];
    }
  >;
  assert.equal(report.clear.status, "clear");
  assert.equal(report.unknown.status, "unknown");
  assert.equal(report.running.status, "running");
  assert.equal(report.unknown.commands, 2);
  assert.equal(report.running.commands, 2);
  assert.equal(report.missing.status, "unknown");
  assert.equal(report.missing.commands, 6);
  assert.equal(
    report.missing.events.find((event) => event.stage === "posix-reconcile")
      ?.missingRows,
    1,
  );
  assert.equal(
    report.changed.events.find((event) => event.stage === "posix-reconcile")
      ?.parentChanges,
    1,
  );
  assert.equal(
    report.changed.events.find((event) => event.stage === "posix-reconcile")
      ?.stateChanges,
    1,
  );
  assert.equal(
    report.changed.events.find((event) => event.stage === "posix-reconcile")
      ?.extraRows,
    1,
  );
  assert.ok(
    report.malformed.events.some(
      (event) =>
        event.stage === "posix-parse-commands" &&
        event.outcome === "invalid-data",
    ),
  );
  for (const outcome of ["timeout", "truncated", "command-failed"])
    assert.ok(
      report[outcome].events.some(
        (event) => event.stage === "posix-names" && event.outcome === outcome,
      ),
    );
  assert.ok(
    report.terminated.events.some(
      (event) =>
        event.stage === "posix-names" &&
        event.outcome === "command-terminated" &&
        event.timeout === false,
    ),
  );
  assert.ok(
    report.deadline.events.some(
      (event) => event.stage === "posix-names" && event.outcome === "cancelled",
    ),
  );
  assert.ok(
    report.deadline.events.some(
      (event) =>
        event.stage === "stable-result" &&
        event.outcome === "timeout" &&
        event.timeout,
    ),
  );
  assert.equal(report.deadline.commands, 1);
  assert.equal(report["windows-clear"].status, "clear");
  assert.equal(report["windows-clear"].commands, 1);
  assert.ok(
    report["windows-clear"].events.some(
      (event) => event.stage === "windows-parse" && event.rows === 1,
    ),
  );
  assert.equal(report["windows-malformed"].status, "unknown");
  assert.equal(report["windows-malformed"].commands, 3);
  assert.ok(
    report["windows-malformed"].events.some(
      (event) =>
        event.stage === "windows-parse" && event.outcome === "invalid-data",
    ),
  );
  assert.doesNotMatch(
    stdout,
    /SECRET_|872341|872342|900001|commandLine|executablePath|parentPid|stderr/,
  );
});
