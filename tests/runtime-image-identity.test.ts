import test from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "../electron/providers/claude-code.js";
import { clineAdapter } from "../electron/providers/cline.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
import { posixInventoryArguments } from "../electron/processes.js";
for (const adapter of [claudeCodeAdapter, clineAdapter, cursorAdapter])
  test(`${adapter.id}: MainThread or renamed runtime cannot bypass uncertainty`, () => {
    for (const record of [
      {
        name: "MainThread",
        commandLine: "node --import tsx /synthetic/driver.mjs",
      },
      {
        name: "custom-title",
        executablePath: "/usr/bin/node",
        commandLine: "custom-title",
      },
      {
        name: "MainThread",
        executablePath: "/usr/bin/node",
        commandLine: "node /synthetic/driver.mjs",
      },
    ])
      assert.equal(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [record],
        }).status,
        "unknown",
      );
  });
test("kernel vendor executable identity stays running under a custom process name", () => {
  for (const [adapter, executablePath] of [
    [claudeCodeAdapter, "/opt/claude/versions/2.1.0"],
    [clineAdapter, "/opt/cline"],
    [cursorAdapter, "/usr/share/cursor/cursor"],
  ] as const)
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [
          { name: "custom-title", executablePath, commandLine: "custom-title" },
        ],
      }).status,
      "running",
    );
});
test("Darwin uses explicit all-process selection and never legacy -e environment semantics", () => {
  for (const field of ["comm", "args"] as const)
    for (const parents of [false, true])
      assert.deepEqual(posixInventoryArguments("darwin", parents, field), [
        "-A",
        "-o",
        (parents ? "pid=,ppid=,stat=," : "pid=,stat=,") + field + "=",
      ]);
  assert.deepEqual(posixInventoryArguments("linux", false, "args"), [
    "-eo",
    "pid=,stat=,args=",
  ]);
  assert.throws(() => posixInventoryArguments("win32", false, "args"));
});
