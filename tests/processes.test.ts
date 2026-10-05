import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePosixProcessSnapshot } from "../electron/processes.js";
test("process inventory excludes only proven zombies and verified own PIDs", () => {
  const snapshot = parsePosixProcessSnapshot(
    " 1 Ss init\n 2 Z electron\n 3 Sl AgentVac\n 4 R ps\n 5 Sl node\n",
    " 1 Ss /sbin/init\n 2 Z [electron] <defunct>\n 3 Sl /opt/AgentVac\n 6 R /bin/ps -eo pid=,stat=,args=\n 5 Sl node /work/server.js\n",
    "linux",
    [3],
  );
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.processes, [
    { pid: 1, name: "init", commandLine: "/sbin/init" },
    { pid: 5, name: "node", commandLine: "node /work/server.js" },
  ]);
});
test("changed inventory and zombie PID reuse cannot be called complete", () => {
  for (const [names, args] of [
    ["1 Ss init\n2 Sl node", "1 Ss /sbin/init"],
    ["1 Ss init", "1 Ss /sbin/init\n2 Sl node /x.js"],
    ["1 Ss init\n2 Z electron", "1 Ss /sbin/init\n2 Sl electron /x"],
  ])
    assert.equal(
      parsePosixProcessSnapshot(names, args, "linux").complete,
      false,
    );
});
test("a process that exited during enumeration is no longer a possible writer", () => {
  const result = parsePosixProcessSnapshot(
    "1 Ss init\n2 Sl electron",
    "1 Ss /sbin/init\n2 Z [electron] <defunct>",
    "linux",
  );
  assert.equal(result.complete, true);
  assert.equal(result.processes.length, 1);
});
test("malformed, empty, duplicate and truncated process rows fail closed", () => {
  for (const text of [
    "",
    "1",
    "1 Z",
    "oops",
    "1 Ss init\n1 R other",
    "1 Ss init\n2 Sl",
  ])
    assert.throws(() =>
      parsePosixProcessSnapshot(text, "1 Ss /sbin/init", "linux"),
    );
});
test("macOS process names and command paths with spaces remain intact", () => {
  const result = parsePosixProcessSnapshot(
    "10 S+ /Applications/Cursor.app/Contents/Frameworks/Cursor Helper",
    "10 S+ /Applications/Cursor.app/Contents/Frameworks/Cursor Helper --type=renderer",
    "darwin",
  );
  assert.equal(result.complete, true);
  assert.match(result.processes[0].name, /Cursor Helper$/);
});

import {
  applicationExecutablePaths,
  excludeOwnedApplicationProcesses,
} from "../electron/processes.js";
import type {
  ProcessRecord,
  ProcessSnapshot,
} from "../electron/providers/types.js";
const owned = { pid: 100, executablePaths: ["/opt/AgentVac/agentvac"] };
const helper = (
  pid: number,
  parentPid = 100,
  extra: Partial<ProcessRecord> = {},
): ProcessRecord => ({
  pid,
  parentPid,
  name: "agentvac",
  executablePath: owned.executablePaths[0],
  commandLine:
    "/opt/AgentVac/agentvac --type=utility --utility-sub-type=network.mojom.NetworkService",
  ...extra,
});
const remaining = (
  processes: ProcessRecord[],
  platform: NodeJS.Platform = "linux",
  application = owned,
) =>
  excludeOwnedApplicationProcesses(
    { platform, complete: true, processes },
    [100],
    application,
  ).processes;
test("verified own executable and helper-only parent ancestry excludes direct and nested helpers", () => {
  assert.deepEqual(
    remaining([helper(101), helper(102, 101), { pid: 100, name: "AgentVac" }]),
    [],
  );
});
test("foreign parent, spoofed trailing type flag, absent executable and nonhelper ancestors never clear", () => {
  const rows = [
    helper(101, 999),
    helper(102, 100, { executablePath: undefined }),
    helper(103, 100, {
      commandLine: "/opt/AgentVac/agentvac /unrelated.js --type=utility",
    }),
    helper(104, 105),
    helper(105, 100, { commandLine: "/opt/AgentVac/agentvac ordinary-script" }),
    helper(106, 100, { executablePath: "/opt/Other/agentvac" }),
  ];
  assert.deepEqual(remaining(rows), rows);
});
test("cyclic and absent ancestry cannot manufacture helper ownership", () => {
  const rows = [helper(101, 102), helper(102, 101), helper(103, 0)];
  assert.deepEqual(remaining(rows), rows);
});
test("Windows normalized case/extended local paths match only trusted executable", () => {
  const application = {
    pid: 100,
    executablePaths: ["C:\\Program Files\\AgentVac\\AgentVac.exe"],
  };
  const a = helper(101, 100, {
    executablePath: "\\\\?\\C:\\PROGRAM FILES\\AgentVac\\agentvac.EXE",
    commandLine: '"C:\\Program Files\\AgentVac\\AgentVac.exe" --type=utility',
  });
  assert.deepEqual(remaining([a], "win32", application), []);
  assert.equal(
    remaining([{ ...a, executablePath: undefined }], "win32", application)
      .length,
    1,
  );
});
test("macOS distinct bundle Helper executables with spaces are recognized using kernel identity", () => {
  const executable = "/Applications/AgentVac.app/Contents/MacOS/AgentVac";
  const paths = applicationExecutablePaths(executable, "darwin");
  assert.equal(paths.length, 5);
  const application = { pid: 100, executablePaths: paths };
  const exe = paths.find((p) => p.endsWith("Helper (Renderer)"))!;
  const a = helper(101, 100, {
    executablePath: exe,
    commandLine: exe + " --type=renderer --lang=en-US",
  });
  assert.deepEqual(remaining([a], "darwin", application), []);
  assert.equal(
    remaining([{ ...a, parentPid: 999 }], "darwin", application).length,
    1,
  );
});
test("parent-aware process snapshots expose kernel PPID and flag reparented ambiguity", () => {
  const a = parsePosixProcessSnapshot(
    "101 100 Sl electron",
    "101 100 Sl /opt/electron --type=utility",
    "linux",
    [],
    true,
  );
  assert.equal(a.processes[0].parentPid, 100);
  assert.equal(a.complete, true);
  assert.equal(
    parsePosixProcessSnapshot(
      "101 100 Sl electron",
      "101 999 Sl /opt/electron --type=utility",
      "linux",
      [],
      true,
    ).complete,
    false,
  );
});

test("macOS OS-derived helper executable is available before role parsing of unquoted spaces", () => {
  const exe = "/Applications/AgentVac Test.app/Contents/MacOS/AgentVac";
  const app = {
    pid: 100,
    executablePaths: applicationExecutablePaths(exe, "darwin"),
  };
  const helperExe = app.executablePaths[2];
  const parsed = parsePosixProcessSnapshot(
    `100 1 S ${exe}\n101 100 S ${helperExe}`,
    `100 1 S ${exe}\n101 100 S ${helperExe} --type=gpu-process`,
    "darwin",
    [],
    true,
  );
  assert.deepEqual(
    excludeOwnedApplicationProcesses(parsed, [100], app).processes,
    [],
  );
  const foreign = parsePosixProcessSnapshot(
    `101 999 S ${helperExe}`,
    `101 999 S ${helperExe} --type=gpu-process`,
    "darwin",
    [],
    true,
  );
  assert.equal(
    excludeOwnedApplicationProcesses(foreign, [100], app).processes.length,
    1,
  );
});

import { collectStableProcessSnapshot } from "../electron/processes.js";
import { claudeCodeAdapter } from "../electron/providers/claude-code.js";
test("fresh-inventory retry accepts only a newly complete snapshot and sees a newly started writer", async () => {
  let calls = 0;
  const snapshot = await collectStableProcessSnapshot(
    async () => ({
      platform: "linux",
      complete: ++calls > 1,
      processes: [{ name: "claude", commandLine: "/usr/bin/claude" }],
    }),
    { retryDelayMs: 0 },
  );
  assert.equal(calls, 2);
  assert.equal(snapshot.complete, true);
  assert.equal(claudeCodeAdapter.assessProcesses(snapshot).status, "running");
});
test("complete unknown/running inventories never get retried into a clear observation", async () => {
  for (const row of [
    { name: "claude", commandLine: "claude" },
    { name: "node", commandLine: "node -e unknown" },
  ]) {
    let calls = 0;
    const result = await collectStableProcessSnapshot(
      async () => {
        calls++;
        return { platform: "linux", complete: true, processes: [row] };
      },
      { retryDelayMs: 0 },
    );
    assert.equal(calls, 1);
    assert.notEqual(claudeCodeAdapter.assessProcesses(result).status, "clear");
  }
});
test("incomplete inventory retry has a three-attempt cap, cancellation and an OS-call deadline", async () => {
  let calls = 0;
  const bad = await collectStableProcessSnapshot(
    async () => {
      calls++;
      return { platform: "linux", complete: false, processes: [] };
    },
    { retryDelayMs: 0 },
  );
  assert.equal(calls, 3);
  assert.equal(bad.complete, false);
  const abort = new AbortController();
  abort.abort();
  calls = 0;
  const cancelled = await collectStableProcessSnapshot(
    async () => {
      calls++;
      return { platform: "linux", complete: true, processes: [] };
    },
    { signal: abort.signal },
  );
  assert.equal(calls, 0);
  assert.equal(cancelled.complete, false);
  let sawAbort = false;
  const timed = await collectStableProcessSnapshot(
    (signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve({ platform: "linux", complete: true, processes: [] });
          },
          { once: true },
        ),
      ),
    { deadlineMs: 20 },
  );
  assert.equal(sawAbort, true);
  assert.equal(timed.complete, false);
});
