// Mock the OS boundary before importing the collector. No native process is enumerated.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import type {
  ProcessInspectionObservation,
  ProcessInspectionObserver,
} from "../../electron/process-observations.js";

let scenario = "clear",
  commands = 0;
const names = "101 1 S /sbin/init\n872341 101 S /private/SECRET_NAME";
const args =
  "101 1 S /sbin/init\n872341 101 S /private/SECRET_NAME --SECRET_ARG";
const fakeExec = Object.assign(
  () => {
    throw new Error("Callback API not expected");
  },
  {
    [promisify.custom]: async (
      file: string,
      parameters: string[],
      options: { timeout: number; maxBuffer: number; signal: AbortSignal },
    ) => {
      commands++;
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 4_000_000);
      assert.ok(options.signal);
      if (process.platform === "win32") {
        assert.equal(file, "powershell.exe");
        assert.equal(parameters[0], "-NoLogo");
        return {
          stdout:
            scenario === "malformed"
              ? "SECRET_INVALID_JSON"
              : JSON.stringify([
                  {
                    ProcessId: 872341,
                    ParentProcessId: 1,
                    Name: "explorer.exe",
                    ExecutablePath: "C:\\SECRET\\explorer.exe",
                    CommandLine: "C:\\SECRET\\explorer.exe SECRET_ARG",
                  },
                ]),
          stderr: "SECRET_STDERR",
        };
      }
      assert.equal(file, "/bin/ps");
      assert.deepEqual(parameters.slice(0, 2), ["-A", "-o"]);
      const namePass = parameters[2].endsWith("comm=");
      if (
        scenario === "timeout" ||
        scenario === "terminated" ||
        scenario === "truncated" ||
        scenario === "command-failed"
      )
        throw Object.assign(new Error("SECRET_ERROR /private/SECRET_PATH"), {
          code:
            scenario === "timeout"
              ? "ETIMEDOUT"
              : scenario === "terminated"
                ? null
                : scenario === "truncated"
                  ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  : "ENOENT",
          stdout: "SECRET_STDOUT",
          stderr: "SECRET_STDERR",
          ...(scenario === "terminated"
            ? { signal: "SIGTERM", killed: true }
            : {}),
        });
      if (scenario === "pending")
        return await new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("SECRET_ABORT"), { code: "ABORT_ERR" }),
              ),
            { once: true },
          );
        });
      if (scenario === "malformed")
        return {
          stdout: namePass ? names : "872341 SECRET_MALFORMED",
          stderr: "SECRET_STDERR",
        };
      if (scenario === "missing")
        return {
          stdout: namePass ? names : "101 1 S /sbin/init",
          stderr: "SECRET_STDERR",
        };
      if (scenario === "changed")
        return {
          stdout: namePass
            ? names
            : "101 1 S /sbin/init\n872341 999 R /private/SECRET_NAME --SECRET_ARG\n872342 101 S /private/SECRET_EXTRA",
          stderr: "",
        };
      if (scenario === "unknown")
        return {
          stdout: namePass ? "101 1 S node" : "101 1 S node -e SECRET_INLINE",
          stderr: "",
        };
      if (scenario === "running")
        return {
          stdout: namePass ? "101 1 S claude" : "101 1 S claude",
          stderr: "",
        };
      return { stdout: namePass ? names : args, stderr: "SECRET_STDERR" };
    },
  },
);
childProcess.execFile = fakeExec as unknown as typeof childProcess.execFile;
syncBuiltinESMExports();
Object.defineProperty(process, "platform", { value: "darwin" });
const {
  checkProviderProcesses,
  collectStableProcessSnapshot,
  collectProcessSnapshot,
} = await import("../../electron/processes.js");
const application = {
  pid: 900001,
  executablePaths: ["/private/SECRET_APPLICATION"],
};
const report: Record<string, unknown> = {};
for (const current of [
  "clear",
  "missing",
  "changed",
  "malformed",
  "timeout",
  "terminated",
  "truncated",
  "command-failed",
  "unknown",
  "running",
]) {
  scenario = current;
  commands = 0;
  const plain = await checkProviderProcesses("claude-code", [], application);
  const plainCommands = commands;
  for (const mode of ["record", "throw", "reject"]) {
    commands = 0;
    const events: ProcessInspectionObservation[] = [];
    const observer: ProcessInspectionObserver =
      mode === "throw"
        ? () => {
            throw Error("SECRET_OBSERVER");
          }
        : mode === "reject"
          ? async () => {
              throw Error("SECRET_OBSERVER");
            }
          : (event) => {
              events.push(event);
            };
    const observed = await checkProviderProcesses(
      "claude-code",
      [],
      application,
      observer,
    );
    assert.deepEqual(observed, plain);
    assert.equal(commands, plainCommands);
    if (mode === "record")
      report[current] = { status: observed.status, commands, events };
  }
}
scenario = "pending";
commands = 0;
const events: ProcessInspectionObservation[] = [];
const observer = (event: ProcessInspectionObservation) => {
  events.push(event);
};
const keepAlive = setTimeout(() => {}, 1000);
try {
  const result = await collectStableProcessSnapshot(
    (signal) => collectProcessSnapshot([], application, signal, observer),
    { deadlineMs: 20, observer },
  );
  assert.equal(result.complete, false);
  report.deadline = { complete: result.complete, commands, events };
} finally {
  clearTimeout(keepAlive);
}
Object.defineProperty(process, "platform", { value: "win32" });
for (const current of ["clear", "malformed"]) {
  scenario = current;
  const plain = await checkProviderProcesses("claude-code", [], application);
  const events: ProcessInspectionObservation[] = [];
  commands = 0;
  const observed = await checkProviderProcesses(
    "claude-code",
    [],
    application,
    (event) => events.push(event),
  );
  assert.deepEqual(observed, plain);
  report[`windows-${current}`] = { status: observed.status, commands, events };
}
assert.doesNotMatch(
  JSON.stringify(report),
  /SECRET_|872341|872342|900001|private|\/sbin|stderr|stdout|commandLine|executablePath|parentPid/,
);
process.stdout.write(JSON.stringify(report));
