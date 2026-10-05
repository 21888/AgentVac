import { test } from "node:test";
import assert from "node:assert/strict";
import { assessObservedRuntime } from "../electron/providers/observed-runtime.js";
import { claudeCodeAdapter } from "../electron/providers/claude-code.js";
import { clineAdapter } from "../electron/providers/cline.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
import type { ProcessRecord } from "../electron/providers/types.js";

const adapters = [claudeCodeAdapter, clineAdapter, cursorAdapter];
function record(
  argv: string[],
  executablePath = "/usr/bin/node",
): ProcessRecord {
  return {
    pid: 123,
    parentPid: 100,
    name: "MainThread",
    executablePath,
    commandLine: argv.join(" "),
    argumentObservation: {
      status: "verified",
      platform: "linux",
      source: "linux-proc",
      pid: 123,
      parentPid: 100,
      startId: "456",
      executablePath,
      argv,
    },
  };
}
const known: Record<string, string> = {
  "claude-code": "/synthetic space/claude_agent_sdk/entry",
  cline: "/synthetic space/@cline/sdk/entry.js",
  cursor: "/synthetic space/.cursor-server/main.js",
};
for (const adapter of adapters) {
  test(`${adapter.id}: observed operand boundaries distinguish script from later names`, () => {
    for (const row of [
      record([
        "node",
        "/synthetic space/ordinary.mjs",
        known[adapter.id],
        "-e",
        "other.js",
      ]),
      record(
        [
          "python3",
          "/usr/bin/synthetic-extensionless",
          "--fixture",
          known[adapter.id],
        ],
        "/usr/bin/python3.11",
      ),
      record(
        ["python3", "-I", "-u", "--", "/synthetic space/ordinary", "later.py"],
        "/usr/bin/python3.11",
      ),
    ]) {
      assert.equal(assessObservedRuntime(row, adapter.id), "attributed");
      assert.equal(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [row],
        }).status,
        "clear",
      );
    }
  });
  test(`${adapter.id}: known source/loader keeps blocked even with spaced native operands`, () => {
    for (const argv of [
      ["node", known[adapter.id]],
      ["node", "--require", known[adapter.id]],
      ["node", "--inspect=0", known[adapter.id]],
    ]) {
      const row = record(argv);
      assert.equal(assessObservedRuntime(row, adapter.id), "running");
      assert.equal(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [row],
        }).status,
        "running",
      );
    }
  });
  test(`${adapter.id}: inline loaders unknown options and unsupported runtimes never clear`, () => {
    for (const row of [
      record(["node", "-e", "console.log('fixture')", "later.js"]),
      record(["node", "-econsole.log(1)", "later.js"]),
      record(["node", "--import", "tsx", "/ordinary.mjs"]),
      record(["node", "--env-file", "/synthetic.env", "/ordinary.mjs"]),
      record(["node", "--title", "ordinary.js", "/extensionless"]),
      record(["node", "-", "/ordinary.mjs"]),
      record(["python3", "-cprint(1)", "later.py"], "/usr/bin/python3.11"),
      record(
        ["python3", "-X", "presite=module", "/ordinary.py"],
        "/usr/bin/python3.11",
      ),
      record(
        ["python3", "-W", "ignore::module.Warning", "/ordinary.py"],
        "/usr/bin/python3.11",
      ),
      record(
        ["python3", "-m", "ordinary", "/ordinary.py"],
        "/usr/bin/python3.11",
      ),
      record(["bun", "/ordinary.js"], "/usr/bin/bun"),
      record(["custom-title", "/ordinary.js"]),
    ]) {
      assert.equal(assessObservedRuntime(row, adapter.id), "unknown");
      assert.notEqual(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [row],
        }).status,
        "clear",
      );
    }
  });
  test(`${adapter.id}: stale malformed or unavailable observations cannot fall back to raw clear`, () => {
    for (const patch of [
      { pid: 124 },
      { parentPid: 101 },
      { executablePath: "/other/node" },
      { startId: ["456"] },
      { startId: "18446744073709551616" },
      { argv: ["node", ["/ordinary.js"]] },
      { argv: ["node", "/ordinary.js\0"] },
      { argv: ["node", "/" + "x".repeat(65536) + ".js"] },
      { platform: "win32" },
      { source: "raw-ps" },
      { status: "unavailable", reason: "timeout" },
    ]) {
      const row = record(["node", "/ordinary.js"]);
      row.name = "node";
      row.argumentObservation = { ...row.argumentObservation, ...patch } as any;
      assert.equal(assessObservedRuntime(row, adapter.id), "unknown");
      assert.equal(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [row],
        }).status,
        "unknown",
      );
    }
  });
}
test("native Python SDK module identity is detected but ordinary module remains uncertain", () => {
  for (const argv of [
    ["python3", "-m", "claude_agent_sdk"],
    ["python3", "-mclaude_agent_sdk.tools"],
  ])
    assert.equal(
      assessObservedRuntime(record(argv, "/usr/bin/python3.11"), "claude-code"),
      "running",
    );
});
test("observed vendor families match existing remote hosts and nested installation layouts", () => {
  for (const [adapter, entry] of [
    [clineAdapter, "/opt/.vscode-server/server-main.js"],
    [clineAdapter, "/opt/.vscode-server-insiders/server-main.js"],
    [clineAdapter, "/synthetic space/cline/cli.js"],
    [cursorAdapter, "/synthetic space/cursor/resources/app/out/cli.js"],
    [cursorAdapter, "/synthetic space/cursor-agent/versions/1/entry.js"],
    [claudeCodeAdapter, "/synthetic space/@anthropic-ai/claude-code/cli.js"],
  ] as const) for (const argv of [["node", entry], ["node", "--import", entry]]) {
    const row = record(argv);
    assert.equal(assessObservedRuntime(row, adapter.id), "running");
    assert.equal(adapter.assessProcesses({platform:"linux",complete:true,processes:[row]}).status, "running");
  }
});
