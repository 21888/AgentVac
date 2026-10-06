// Native fixture QA only. Source-launched Electron; no real Codex homes or user data.
// Normal diagnostics use shipped unmodified helpers. Lifecycle fault tests separately
// inject a parser-start stall into real child processes managed by the shipped supervisor.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
const run = promisify(execFile);
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const selfTest = process.argv.includes("--self-test");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(fn, label, milliseconds = 15000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}
const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
async function diskObservation(directory) {
  const real = await fs.realpath(directory);
  const stat = await fs.stat(real, { bigint: true });
  const volume = await fs.statfs(real, { bigint: true });
  const filesystemType = `0x${volume.type.toString(16)}`;
  return {
    path: real,
    device: String(stat.dev),
    filesystemType,
    availableBytes: String(volume.bavail * volume.bsize),
    inMemoryFilesystem:
      process.platform === "linux" &&
      [0x01021994n, 0x858458f6n].includes(volume.type),
  };
}
// Avoid os.tmpdir(): a cloud desktop can map it to /dev/shm, which cannot use ordinary desktop Trash.
// Never redirect XDG_DATA_HOME, alter system Trash, or move fixtures to a different volume after a failure.
const candidateBase =
  process.env.AGENTVAC_NATIVE_FIXTURE_BASE ||
  process.env.RUNNER_TEMP ||
  project;
const storage = await diskObservation(candidateBase);
assert.equal(
  storage.inMemoryFilesystem,
  false,
  `Use an ordinary disk fixture base, not ${storage.filesystemType}: ${storage.path}`,
);
const ownedRoot = await fs.mkdtemp(
  path.join(storage.path, "agentvac-native-suite-"),
);
const userData = path.join(ownedRoot, "profile");
const fixtureRoot = path.join(ownedRoot, "agentvac-native-root");
const sqliteRoot = path.join(ownedRoot, "sqlite-fixture");
await Promise.all(
  [userData, fixtureRoot, sqliteRoot].map((directory) => fs.mkdir(directory)),
);
const evidenceFile = path.join(
  process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ||
    path.join(project, "docs", "native-ci"),
  `next-${process.platform}-${process.arch}${selfTest ? "-self-test" : ""}.json`,
);
const results = {
  at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  fixtureOnly: true,
  nativeExecution: !selfTest,
  fixtureStorage: storage,
  inheritedTemp: os.tmpdir(),
  inheritedXdgDataHome: process.env.XDG_DATA_HOME || null,
  trashConfigurationChanged: false,
  packagedArtifactTested: false,
  sourceRevision: process.env.GITHUB_SHA || null,
  ciRunId: process.env.GITHUB_RUN_ID || null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  checks: {},
};
const planned = [
  "fixture-disk-and-diagnostic-data",
  "native-window-preload-ipc-sandbox",
  "native-folder-picker-open-cancel",
  "demo-ui-scan-quarantine-history-restore",
  "preference-and-demo-persistence-restart",
  "single-instance-lock",
  "generated-root-adapter",
  "duplicate-quarantine-and-restore",
  "native-trash-generated-batch",
  "diagnostic-real-helper-ipc-readonly",
  "diagnostic-cancel-no-orphans",
  "diagnostic-window-close-no-orphans",
];
for (const name of planned)
  results.checks[name] = { status: "UNTESTED", detail: "Not reached" };
const record = (id, status, detail) => {
  results.checks[id] = { status, detail };
  console.log(`AGENTVAC_CHECK ${JSON.stringify({ id, status, detail })}`);
};
class CapabilitySkip extends Error {}
async function check(id, fn) {
  try {
    record(id, "PASS", await fn());
  } catch (error) {
    if (error instanceof CapabilitySkip) {
      record(id, "SKIP", error.message);
      return;
    }
    record(id, "FAIL", String(error.stack || error));
    // Preserve this failure and the final nonzero exit, while independent
    // diagnostic checks report their own capability or runtime outcomes.
    if (id === "native-trash-generated-batch") {
      primaryError ??= error;
      return;
    }
    throw error;
  }
}
const LOG_DDL = `
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT,
file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL,
checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);
CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_thread_id ON logs(thread_id);
CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;
`;
const syntheticBody = `synthetic-native-private-marker-${randomUUID()}`;
const databasePath = path.join(sqliteRoot, "logs_2.sqlite");
async function createDiagnosticFixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL;");
    db.exec(LOG_DDL);
    const insert = db.prepare(
      "INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body,estimated_bytes) VALUES(0,0,'INFO','fixture',?,?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 80; i++)
      insert.run(syntheticBody.repeat(128), syntheticBody.length * 128);
    db.exec("COMMIT");
    // A realistic freelist exists, but the application must never reclaim or delete it during diagnostics.
    db.exec("DELETE FROM logs WHERE id > 20");
    return {
      sqlite: process.versions.sqlite,
      pages: Number(db.prepare("PRAGMA page_count").get().page_count),
      freelist: Number(
        db.prepare("PRAGMA freelist_count").get().freelist_count,
      ),
    };
  } finally {
    db.close();
  }
}
async function sourceSnapshot() {
  // This directory was created by this test; never inventory a user-provided directory.
  const output = {};
  for (const name of (await fs.readdir(sqliteRoot)).sort()) {
    const file = path.join(sqliteRoot, name),
      stat = await fs.lstat(file, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n);
    output[name] = {
      bytes: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      sha256: await digest(file),
    };
  }
  return output;
}
const supervisorPath = path.join(
  project,
  "dist-electron",
  "diagnostic-supervisor.cjs",
);
const workerPath = path.join(project, "dist-electron", "diagnostic-worker.cjs");
const observerPath = path.join(ownedRoot, "diagnostic-observer.cjs");
const blockerPath = path.join(ownedRoot, "diagnostic-start-stall.cjs");
const markerPath = path.join(ownedRoot, "diagnostic-child.json");
function lifecycleFixtureSources() {
  const blocker = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({pid:process.pid,parentPid:process.ppid,fixture:'parser-start-stall'}),{flag:'wx'}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);`;
  const observer = `const cp=require('node:child_process'); const original=cp.spawn; cp.spawn=function(file,args,options){ if(Array.isArray(args)&&args.includes(${JSON.stringify(workerPath)})){return original.call(this,file,['--require',${JSON.stringify(blockerPath)},...args],options);}return original.call(this,file,args,options);};`;
  new Script(blocker);
  new Script(observer);
  return { blocker, observer };
}
let application, page, second, electronMainPid, primaryError;
const observedOwnedHelpers = new Set();
const env = { ...process.env, AGENTVAC_TEST_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  application = await electron.launch({
    args: [project],
    chromiumSandbox: true,
    timeout: 45000,
    env,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  electronMainPid = await application.evaluate(() => process.pid);
  // Readiness must survive restored workspaces: the onboarding demo CTA is absent
  // once the persistent demo workspace is active after restart.
  await page.getByRole("complementary", { name: "工作空间导航" }).waitFor();
  await page.waitForFunction(
    () =>
      typeof window.agentvac?.getContext === "function" &&
      typeof window.agentvac?.getPreferences === "function" &&
      typeof window.agentvac?.getAppData === "function",
  );
  const chooseRootControl = page.getByRole("button", {
    name: /^(选择 Codex 目录|切换目录)$/,
  });
  await chooseRootControl.waitFor();
  await until(
    () => chooseRootControl.isEnabled(),
    "renderer startup IPC settles and directory control is enabled",
    20000,
  );
  assert.equal(
    await application.evaluate(
      ({ app }) =>
        app.commandLine.hasSwitch("no-sandbox") ||
        process.argv.some((arg) => /^--no-sandbox(?:=|$)/.test(arg)),
    ),
    false,
    "Chromium sandbox must remain enabled; do not bypass runner restrictions.",
  );
}
async function chooseWithAdapter(root, diagnostic = false) {
  await application.evaluate(({ dialog }, selectedRoot) => {
    globalThis.__nativeOriginalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedRoot],
    });
  }, root);
  try {
    return await page.evaluate(
      (isDiagnostic) =>
        isDiagnostic
          ? window.agentvac.chooseDiagnosticRoot("sqlite")
          : window.agentvac.chooseRoot(),
      diagnostic,
    );
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__nativeOriginalDialog;
      delete globalThis.__nativeOriginalDialog;
    });
  }
}
async function safePreview(expectExactlyOne = true) {
  return page.evaluate(async (strict) => {
    const scan = await window.agentvac.scan({
      minAgeDays: 30,
      includeSessions: false,
    });
    const ids = scan.entries
      .filter((entry) => entry.selectable && entry.risk === "safe")
      .map((entry) => entry.id);
    if (!ids.length || (strict && ids.length !== 1))
      throw new Error("Expected exactly one generated safe file");
    return window.agentvac.preview(ids.slice(0, 1));
  }, expectExactlyOne);
}
async function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform === "linux") {
    try {
      if (/^\d+ \(.*\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, "utf8")))
        return false;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
async function helpersGone(pids) {
  await until(
    async () => (await Promise.all(pids.map(isAlive))).every((value) => !value),
    "owned diagnostic supervisor and worker exit",
    8000,
  );
}
async function diagnosticInstrumentation() {
  await application.evaluate(
    async (_electron, paths) => {
      const cp = process.getBuiltinModule("node:child_process");
      globalThis.__diagQA = { mode: "normal", rows: [] };
      globalThis.__diagOriginalSpawn = cp.spawn;
      cp.spawn = function (file, args, options) {
        if (!Array.isArray(args) || args[0] !== paths.supervisor)
          return globalThis.__diagOriginalSpawn.call(this, file, args, options);
        const stalled = globalThis.__diagQA.mode === "stall";
        const actualArgs = stalled
          ? ["--require", paths.observer, ...args]
          : args;
        const child = globalThis.__diagOriginalSpawn.call(
          this,
          file,
          actualArgs,
          options,
        );
        const row = {
          pid: child.pid,
          workerPath: args[1],
          mode: stalled ? "parser-start-stall" : "unmodified",
          exited: false,
        };
        globalThis.__diagQA.rows.push(row);
        child.on("exit", (code, signal) => {
          row.exited = true;
          row.code = code;
          row.signal = signal;
        });
        return child;
      };
    },
    { supervisor: supervisorPath, observer: observerPath },
  );
}
async function beginStalledDiagnosis(request) {
  await fs.rm(markerPath, { force: true });
  await application.evaluate(() => {
    globalThis.__diagQA.mode = "stall";
  });
  await page.evaluate((input) => {
    window.__nativeDiagnosis = null;
    window.agentvac.diagnoseStorage(input).then(
      (value) => {
        window.__nativeDiagnosis = { ok: true, value };
      },
      (error) => {
        window.__nativeDiagnosis = { ok: false, error: String(error) };
      },
    );
  }, request);
  const marker = await until(
    async () => {
      try {
        return JSON.parse(await fs.readFile(markerPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
          return false;
        throw error;
      }
    },
    "real diagnostic worker reaches controlled parser-start stall",
    4500,
  );
  const rows = await application.evaluate(() => globalThis.__diagQA.rows);
  const row = rows.at(-1);
  assert.equal(row.mode, "parser-start-stall");
  assert.equal(row.workerPath, workerPath);
  assert.equal(marker.parentPid, row.pid);
  assert.equal(marker.fixture, "parser-start-stall");
  assert.ok(await isAlive(row.pid));
  assert.ok(await isAlive(marker.pid));
  for (const pid of [row.pid, marker.pid]) observedOwnedHelpers.add(pid);
  return [row.pid, marker.pid];
}
async function forceStopOwnedApplication() {
  const child = application?.process();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32")
    await run(
      "taskkill.exe",
      ["/PID", String(electronMainPid || child.pid), "/T", "/F"],
      { timeout: 10000 },
    ).catch(() => {});
  else {
    const { stdout } = await run(
      "/bin/ps",
      ["-o", "pgid=", "-p", String(child.pid)],
      { timeout: 5000 },
    ).catch(() => ({ stdout: "" }));
    if (Number(stdout.trim()) === child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    } else child.kill("SIGKILL");
  }
}
const WINDOWS_PICKER =
  "param([Parameter(Mandatory=$true)][int]$OwnerPid)\n$ErrorActionPreference = 'Stop'\nAdd-Type @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic static class AgentVacPicker {\n  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);\n  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);\n  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);\n  [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr hwnd, StringBuilder cls, int size);\n  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hwnd);\n  [DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);\n}\n'@\n$script:target = [IntPtr]::Zero\n$deadline = (Get-Date).AddSeconds(15)\nwhile ((Get-Date) -lt $deadline -and $script:target -eq [IntPtr]::Zero) {\n  [AgentVacPicker]::EnumWindows({\n    param($hwnd, $unused)\n    [uint32]$windowPid = 0\n    [void][AgentVacPicker]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)\n    $class = New-Object System.Text.StringBuilder 256\n    [void][AgentVacPicker]::GetClassName($hwnd, $class, 256)\n    if ($windowPid -eq $OwnerPid -and [AgentVacPicker]::IsWindowVisible($hwnd) -and $class.ToString() -eq '#32770') {\n      $script:target = $hwnd\n      return $false\n    }\n    return $true\n  }, [IntPtr]::Zero) | Out-Null\n  if ($script:target -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }\n}\nif ($script:target -eq [IntPtr]::Zero) { throw 'No visible native Win32 dialog owned by the Electron fixture process was found.' }\n# WM_COMMAND / IDCANCEL uses the native dialog's Cancel action, targeting only the observed fixture dialog.\nif (-not [AgentVacPicker]::PostMessage($script:target, 0x0111, [IntPtr]2, [IntPtr]::Zero)) { throw 'Cancel message failed.' }\nWrite-Output ('Native Win32 folder dialog observed and cancelled; owner PID=' + $OwnerPid)\n";
const MACOS_PICKER =
  '// Never prompts for or changes Accessibility/TCC permissions.\nimport Cocoa\nimport ApplicationServices\nif !AXIsProcessTrusted() {\n    print("SKIP: Existing Accessibility permission is absent; no permission requested or changed.")\n    exit(77)\n}\nif CommandLine.arguments.count < 2 { print("Accessibility already authorized"); exit(0) }\nguard let pid = Int32(CommandLine.arguments[1]) else { exit(2) }\nlet app = AXUIElementCreateApplication(pid)\nfunc children(_ element: AXUIElement, _ key: String) -> [AXUIElement] {\n    var value: CFTypeRef?\n    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return [] }\n    return value as? [AXUIElement] ?? []\n}\nfunc attribute(_ element: AXUIElement, _ key: String) -> String {\n    var value: CFTypeRef?\n    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return "" }\n    return value as? String ?? ""\n}\nfunc cancelButton(_ element: AXUIElement, _ depth: Int = 0) -> AXUIElement? {\n    if depth > 10 { return nil }\n    let role = attribute(element, kAXRoleAttribute)\n    let title = attribute(element, kAXTitleAttribute)\n    if role == kAXButtonRole && ["Cancel", "\u53d6\u6d88"].contains(title) { return element }\n    for child in children(element, kAXChildrenAttribute) {\n        if let result = cancelButton(child, depth + 1) { return result }\n    }\n    return nil\n}\nlet deadline = Date().addingTimeInterval(15)\nwhile Date() < deadline {\n    for window in children(app, kAXWindowsAttribute) {\n        if let button = cancelButton(window) {\n            guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { exit(3) }\n            print("Native macOS folder dialog Cancel button pressed for fixture PID \\(pid)")\n            exit(0)\n        }\n    }\n    Thread.sleep(forTimeInterval: 0.1)\n}\nfputs("Native folder dialog Cancel button not found\\n", stderr)\nexit(4)\n';
async function nativePickerCancel() {
  let adapter;
  if (process.platform === "linux") {
    try {
      await run("xdotool", ["version"]);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new CapabilitySkip(
          "xdotool is absent; native picker was not opened. Install normal desktop test tools in the approved runner, without security changes.",
        );
      throw error;
    }
  } else if (process.platform === "win32") {
    adapter = path.join(ownedRoot, "picker-cancel.ps1");
    await fs.writeFile(adapter, WINDOWS_PICKER);
  } else if (process.platform === "darwin") {
    adapter = path.join(ownedRoot, "picker-cancel.swift");
    await fs.writeFile(adapter, MACOS_PICKER);
    try {
      await run("swift", [adapter], { timeout: 60000 });
    } catch (error) {
      if (error.code === 77)
        throw new CapabilitySkip(
          "macOS Accessibility was not already authorized; no permission prompt, TCC change or security bypass attempted.",
        );
      throw error;
    }
  } else
    throw new CapabilitySkip(
      "No native picker automation adapter for this platform.",
    );
  const before = await page.evaluate(() => window.agentvac.getContext());
  await application.evaluate(({ dialog }) => {
    globalThis.__nativePicker = { calls: 0, result: null };
    globalThis.__nativeOriginalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async (...args) => {
      globalThis.__nativePicker.calls++;
      const result = await globalThis.__nativeOriginalDialog(...args);
      globalThis.__nativePicker.result = result;
      return result;
    };
  });
  await page.evaluate(() => {
    window.__nativePickerPromise = null;
    window.agentvac.chooseRoot().then(
      (value) => {
        window.__nativePickerPromise = { ok: true, value };
      },
      (error) => {
        window.__nativePickerPromise = { ok: false, error: String(error) };
      },
    );
  });
  let mechanism;
  if (process.platform === "linux") {
    const windowId = await until(async () => {
      try {
        const { stdout } = await run("xdotool", [
          "search",
          "--all",
          "--onlyvisible",
          "--pid",
          String(electronMainPid),
          "--name",
          "选择 Codex",
        ]);
        const ids = stdout.trim().split(/\s+/).filter(Boolean);
        assert.equal(ids.length, 1);
        return ids[0];
      } catch (error) {
        if (error.code === 1) return false;
        throw error;
      }
    }, "native GTK picker owned by fixture Electron");
    assert.equal(
      Number((await run("xdotool", ["getwindowpid", windowId])).stdout.trim()),
      electronMainPid,
    );
    await run("xdotool", ["windowfocus", "--sync", windowId]);
    await run("xdotool", ["key", "--clearmodifiers", "Escape"]);
    mechanism = {
      gtkWindowId: windowId,
      exactOwnerPid: electronMainPid,
      action: "native Escape key",
    };
  } else {
    const executable =
      process.platform === "win32" ? "powershell.exe" : "swift";
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            adapter,
            "-OwnerPid",
            String(electronMainPid),
          ]
        : [adapter, String(electronMainPid)];
    mechanism = {
      output: (await run(executable, args, { timeout: 60000 })).stdout.trim(),
    };
  }
  await until(
    async () => page.evaluate(() => window.__nativePickerPromise !== null),
    "native chooser cancelled",
  );
  const observed = await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.__nativeOriginalDialog;
    return globalThis.__nativePicker;
  });
  assert.equal(observed.calls, 1);
  assert.equal(observed.result.canceled, true);
  assert.deepEqual(
    await page.evaluate(() => window.agentvac.getContext()),
    before,
  );
  assert.deepEqual(await page.evaluate(() => window.__nativePickerPromise), {
    ok: true,
    value: null,
  });
  return {
    ...mechanism,
    realShowOpenDialog: true,
    dialogResultCanceled: true,
    contextUnchanged: true,
  };
}
async function nodeHelperSmoke(stall = false) {
  const stat = await fs.lstat(databasePath, { bigint: true });
  const expected = [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
    stat.nlink,
  ]
    .map(String)
    .join(":");
  const childEnv =
    process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {};
  await fs.rm(markerPath, { force: true });
  const args = [
    ...(stall ? ["--require", observerPath] : []),
    supervisorPath,
    workerPath,
    "5000",
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const exited = once(child, "close");
  child.stdin.write(JSON.stringify({ databasePath, expected }) + "\n");
  const heartbeat = setInterval(() => {
    if (!child.stdin.destroyed) child.stdin.write("ping\n");
  }, 250);
  let workerPid;
  try {
    if (stall) {
      const marker = await until(
        async () => {
          try {
            return JSON.parse(await fs.readFile(markerPath, "utf8"));
          } catch (error) {
            if (error.code === "ENOENT" || error instanceof SyntaxError)
              return false;
            throw error;
          }
        },
        "non-GUI owned child stall",
        4000,
      );
      assert.equal(marker.parentPid, child.pid);
      workerPid = marker.pid;
      assert.ok(await isAlive(workerPid));
      child.stdin.end("cancel\n");
    }
    const [code] = await deadline(exited, 8000, "non-GUI helper completion");
    assert.equal(code, 0, stderr);
    const value = JSON.parse(stdout);
    if (stall) {
      assert.equal(value.status, "blocked");
      assert.equal(value.reason, "CANCELLED");
      await helpersGone([child.pid, workerPid]);
    } else {
      assert.equal(value.status, "ok", stdout);
      assert.equal(value.schema, "codex-logs-v2");
    }
    return {
      result: value,
      nodeOnly: true,
      electronOrPreloadTested: false,
      ...(stall
        ? { controlledParserStartStall: true, bothOwnedProcessesExited: true }
        : { shippedHelperArgumentsUnmodified: true }),
    };
  } finally {
    clearInterval(heartbeat);
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end("cancel\n");
      await deadline(exited, 2000, "non-GUI cleanup").catch(() => child.kill());
    }
  }
}
let sqliteBefore;
try {
  await check("fixture-disk-and-diagnostic-data", async () => {
    const generated = await createDiagnosticFixture();
    sqliteBefore = await sourceSnapshot();
    assert.deepEqual(Object.keys(sqliteBefore), ["logs_2.sqlite"]);
    const helpers = lifecycleFixtureSources();
    await fs.writeFile(observerPath, helpers.observer);
    await fs.writeFile(blockerPath, helpers.blocker);
    assert.ok(generated.freelist > 0);
    return {
      ...generated,
      fixtureDisk: storage,
      sourceSha256: sqliteBefore["logs_2.sqlite"].sha256,
      helperFixtureSyntaxChecked: true,
      trashConfigurationChanged: false,
    };
  });
  if (selfTest) {
    const { DatabaseSync } = await import("node:sqlite");
    const readonly = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(readonly.prepare("SELECT COUNT(*) AS n FROM logs").get().n),
        20,
      );
    } finally {
      readonly.close();
    }
    assert.deepEqual(await sourceSnapshot(), sqliteBefore);
    await check("non-gui-shipped-diagnostic-helper-smoke", async () => {
      const result = await nodeHelperSmoke();
      assert.deepEqual(await sourceSnapshot(), sqliteBefore);
      return result;
    });
    await check("non-gui-diagnostic-cancel-fixture-smoke", async () => {
      const result = await nodeHelperSmoke(true);
      assert.deepEqual(await sourceSnapshot(), sqliteBefore);
      return result;
    });
    record(
      "non-gui-self-test",
      "PASS",
      "Generated SQLite schema/freelist, source hash invariance, ordinary-disk guard and lifecycle fixture JavaScript syntax verified. Electron was not launched.",
    );
  } else {
    for (const file of [
      path.join(project, "dist", "index.html"),
      path.join(project, "dist-electron", "main.cjs"),
      supervisorPath,
      workerPath,
    ])
      await fs.access(file);
    await launch();
    await check("native-window-preload-ipc-sandbox", async () => {
      await page.getByTestId("signing-warning").waitFor({ state: "hidden" });
      assert.equal(
        await page.getByRole("alert").count(),
        0,
        "Cold launch must have no app-data/IPC/signing error",
      );
      const concurrent = await page.evaluate(async () => {
        const [context, preferences, appData] = await Promise.all([
          window.agentvac.getContext(),
          window.agentvac.getPreferences(),
          window.agentvac.getAppData(),
        ]);
        return {
          context,
          preferences,
          canSign: appData.recovery.canSign,
          issues: appData.issues,
          recoveryIssues: appData.recovery.issues,
          candidates: appData.candidates.map((candidate) => candidate.path),
          nodeRequire: typeof window.require,
        };
      });
      assert.equal(concurrent.canSign, true);
      assert.deepEqual(concurrent.issues, []);
      assert.deepEqual(concurrent.recoveryIssues, []);
      assert.equal(concurrent.nodeRequire, "undefined");
      assert.equal(concurrent.context.root, null);
      assert.ok(
        concurrent.candidates.every(
          (candidate) => candidate === path.join(userData, ".codex"),
        ),
        "Test-profile discovery must not probe real Codex homes",
      );
      const native = await application.evaluate(({ app, BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows(),
          prefs = windows[0].webContents.getLastWebPreferences();
        return {
          windows: windows.length,
          visible: windows[0].isVisible(),
          userData: app.getPath("userData"),
          electron: process.versions.electron,
          arch: process.arch,
          argv: process.argv,
          sandbox: prefs.sandbox,
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          disabledSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
        };
      });
      assert.equal(native.windows, 1);
      assert.equal(native.visible, true);
      assert.equal(native.userData, userData);
      assert.equal(native.sandbox, true);
      assert.equal(native.contextIsolation, true);
      assert.equal(native.nodeIntegration, false);
      assert.equal(native.disabledSandboxSwitch, false);
      assert.ok(!native.argv.some((arg) => /^--no-sandbox(?:=|$)/.test(arg)));
      if (process.env.AGENTVAC_EXPECTED_ARCH)
        assert.equal(native.arch, process.env.AGENTVAC_EXPECTED_ARCH);
      return {
        ...native,
        coldUiSigningReady: true,
        parallelStartupIpcSucceeded: true,
        canSign: true,
        noRealHomeDiscovery: true,
      };
    });
    await check("native-folder-picker-open-cancel", nativePickerCancel);
    let restoredDemoBatch;
    await check("demo-ui-scan-quarantine-history-restore", async () => {
      await page
        .getByRole("button", { name: "体验演示扫描", exact: true })
        .click();
      await page.getByRole("button", { name: "文件", exact: true }).click();
      assert.equal(
        (await page.evaluate(() => window.agentvac.getContext())).root,
        path.join(userData, "demo-workspace"),
      );
      await page
        .getByRole("checkbox", {
          name: "选择当前列表中的安全项目",
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "预览隔离操作", exact: true })
        .click();
      await page.getByRole("dialog").getByRole("checkbox").check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "确认演示隔离", exact: true })
        .click();
      await page
        .getByRole("button", { name: "查看隔离记录", exact: true })
        .click();
      await page
        .getByRole("button", { name: "恢复此批次", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "确认恢复", exact: true })
        .click();
      await page.getByRole("button", { name: "完成", exact: true }).click();
      const rows = await page.evaluate(() => window.agentvac.history());
      assert.equal(rows.length, 1);
      assert.ok(rows[0].items.length);
      assert.ok(rows[0].items.every((item) => item.status === "restored"));
      restoredDemoBatch = rows[0].id;
      return {
        batchId: restoredDemoBatch,
        restoredItems: rows[0].items.length,
        realUi: true,
        fixedDemoWorkspace: true,
      };
    });
    await check("preference-and-demo-persistence-restart", async () => {
      await page.getByRole("button", { name: "深色主题", exact: true }).click();
      await until(
        async () =>
          (await page.evaluate(() => window.agentvac.getPreferences()))
            .theme === "dark",
        "durable theme preference",
      );
      await deadline(application.close(), 15000, "restart shutdown");
      application = undefined;
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(userData, "preferences.json"), "utf8"),
        ).theme,
        "dark",
      );
      await launch();
      await page.getByTestId("signing-warning").waitFor({ state: "hidden" });
      await until(
        async () =>
          (await page
            .getByRole("button", { name: "深色主题", exact: true })
            .getAttribute("aria-pressed")) === "true",
        "theme after restart",
      );
      assert.equal(
        await application.evaluate(
          ({ nativeTheme }) => nativeTheme.themeSource,
        ),
        "dark",
      );
      const restored = await page.evaluate(async () => {
        const first = await window.agentvac.loadDemo();
        const second = await window.agentvac.loadDemo();
        return {
          first,
          second,
          rows: await window.agentvac.history(),
          appData: await window.agentvac.getAppData(),
        };
      });
      assert.equal(restored.first.root, path.join(userData, "demo-workspace"));
      assert.deepEqual(restored.first, restored.second);
      assert.equal(
        restored.rows
          .find((batch) => batch.id === restoredDemoBatch)
          ?.items.every((item) => item.status === "restored"),
        true,
      );
      assert.equal(
        restored.appData.workspaces.entries.filter((entry) => entry.demo)
          .length,
        1,
      );
      assert.equal(restored.appData.recovery.canSign, true);
      return {
        theme: "dark",
        actualProcessRestart: true,
        sameDemoPathReused: true,
        oneDemoWorkspace: true,
        signedHistorySurvivesRestart: true,
      };
    });
    await check("single-instance-lock", async () => {
      const executable = await application.evaluate(() => process.execPath);
      second = spawn(executable, [project], { env, stdio: "pipe" });
      let stderr = "";
      second.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      const [code, signal] = await deadline(
        once(second, "exit"),
        15000,
        "second instance exits",
      );
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
      assert.equal(
        await application.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
        1,
      );
      return { actualSecondElectronExit: 0, onePrimaryWindow: true };
    });
    const generatedFile = path.join(fixtureRoot, "log", "codex-tui.log.1");
    await fs.mkdir(path.dirname(generatedFile));
    await fs.writeFile(
      generatedFile,
      `Only AgentVac native fixture ${randomUUID()}\n`,
    );
    const old = new Date(Date.now() - 90 * 86400000);
    await fs.utimes(generatedFile, old, old);
    const sourceDigest = await digest(generatedFile);
    await check("generated-root-adapter", async () => {
      const result = await chooseWithAdapter(fixtureRoot);
      assert.equal(result.root, fixtureRoot);
      assert.equal(result.demo, false);
      return "One-shot folder-selection adapter targets only generated data; this separately covers application flow, not a native folder-dialog selection.";
    });
    const processPreview = await safePreview();
    const realProcessClear = processPreview.processStatus.status === "clear";
    await check("duplicate-quarantine-and-restore", async () => {
      if (!realProcessClear)
        throw new CapabilitySkip(
          `Actual process gate is ${processPreview.processStatus.status}: ${processPreview.processStatus.details}. No detector was mocked; non-demo mutation is not attempted.`,
        );
      const preview = await safePreview();
      const rows = await page.evaluate(
        async (token) =>
          Promise.allSettled([
            window.agentvac.quarantine(token, true),
            window.agentvac.quarantine(token, true),
          ]).then((results) =>
            results.map((row) =>
              row.status === "fulfilled"
                ? { status: row.status, value: row.value }
                : { status: row.status, error: String(row.reason) },
            ),
          ),
        preview.token,
      );
      assert.equal(rows.filter((row) => row.status === "fulfilled").length, 1);
      assert.equal(rows.filter((row) => row.status === "rejected").length, 1);
      const batch = rows.find((row) => row.status === "fulfilled").value;
      assert.equal(batch.completed, 1);
      assert.deepEqual(batch.failed, []);
      const first = await page.evaluate(
        (id) => window.agentvac.restore(id, true),
        batch.batchId,
      );
      const replay = await page.evaluate(
        (id) => window.agentvac.restore(id, true),
        batch.batchId,
      );
      assert.equal(first.completed, 1);
      assert.deepEqual(first.failed, []);
      assert.equal(replay.completed, 0);
      assert.deepEqual(replay.failed, []);
      assert.equal(await digest(generatedFile), sourceDigest);
      return {
        batchId: batch.batchId,
        duplicateRejected: true,
        firstRestore: 1,
        replayRestore: 0,
        originalHashRestored: true,
      };
    });
    await check("native-trash-generated-batch", async () => {
      if (!realProcessClear)
        await page.evaluate(() => window.agentvac.loadDemo());
      const trashRoot = (
        await page.evaluate(() => window.agentvac.getContext())
      ).root;
      assert.ok(
        trashRoot === fixtureRoot ||
          trashRoot === path.join(userData, "demo-workspace"),
      );
      const preview = await safePreview(realProcessClear);
      const quarantine = await page.evaluate(
        (token) => window.agentvac.quarantine(token, true),
        preview.token,
      );
      assert.equal(quarantine.completed, 1);
      assert.deepEqual(quarantine.failed, []);
      assert.match(quarantine.batchId, /^[0-9a-f-]{36}$/);
      const batchDirectory = path.join(
        trashRoot,
        ".agentvac-quarantine",
        quarantine.batchId,
      );
      const manifestHash = await digest(
        path.join(batchDirectory, "manifest.json"),
      );
      await application.evaluate(({ shell }, expected) => {
        globalThis.__originalNativeTrash = shell.trashItem;
        globalThis.__nativeTrashCalls = 0;
        shell.trashItem = async (directory) => {
          if (directory !== expected)
            throw new Error("Native fixture refused unexpected Trash target");
          globalThis.__nativeTrashCalls++;
          return globalThis.__originalNativeTrash(directory);
        };
      }, batchDirectory);
      let outcome;
      try {
        for (const refusal of ["false-closure", "cancelled-token"]) {
          await assert.rejects(
            page.evaluate(
              async ({ id, refusal }) => {
                const confirmation = await window.agentvac.prepareTrash(id);
                if (refusal === "cancelled-token")
                  await window.agentvac.cancelTrashConfirmation(
                    confirmation.token,
                  );
                return window.agentvac.trash(
                  id,
                  true,
                  refusal !== "false-closure",
                  confirmation.token,
                );
              },
              { id: quarantine.batchId, refusal },
            ),
          );
          assert.equal(
            await application.evaluate(() => globalThis.__nativeTrashCalls),
            0,
          );
          assert.equal(
            await digest(path.join(batchDirectory, "manifest.json")),
            manifestHash,
          );
        }
        outcome = await page.evaluate(async (id) => {
          const confirmation = await window.agentvac.prepareTrash(id);
          return window.agentvac.trash(id, true, true, confirmation.token);
        }, quarantine.batchId);
      } catch (error) {
        // Verify a reported OS failure never uses permanent deletion as a fallback.
        assert.equal(
          await digest(path.join(batchDirectory, "manifest.json")),
          manifestHash,
          "Failed native Trash must retain the generated batch",
        );
        throw error;
      } finally {
        await application.evaluate(({ shell }) => {
          shell.trashItem = globalThis.__originalNativeTrash;
        });
      }
      assert.equal(outcome.completed, 1);
      assert.deepEqual(outcome.failed, []);
      assert.equal(
        await application.evaluate(() => globalThis.__nativeTrashCalls),
        1,
      );
      await assert.rejects(fs.lstat(batchDirectory), { code: "ENOENT" });
      const rows = await page.evaluate(() => window.agentvac.history());
      assert.equal(
        rows
          .find((row) => row.id === quarantine.batchId)
          ?.items.every((item) => item.status === "trashed"),
        true,
      );
      record(
        "native-trash-recovery-ui",
        "UNTESTED",
        "No Recycle Bin/Trash enumeration, restore UI, or empty-trash operation is attempted. Only the exact generated batch was sent to the actual OS API.",
      );
      return {
        realShellTrashItem: true,
        usedDemoBecauseRealProcessGateBlocked: !realProcessClear,
        batchId: quarantine.batchId,
        sourceGone: true,
        signedReceiptVerified: true,
        trashConfigurationChanged: false,
        rmFallback: false,
      };
    });
    const appData = await chooseWithAdapter(sqliteRoot, true);
    const workspace = appData.workspaces.entries.find(
      (entry) => entry.path === sqliteRoot && entry.kind === "sqlite",
    );
    assert.ok(workspace);
    const request = {
      workspaceIds: [workspace.id],
      configOptIn: false,
      deepCheck: { enabled: true, databasePath, confirmedClosed: true },
    };
    await diagnosticInstrumentation();
    let diagnosticGate = null;
    await check("diagnostic-real-helper-ipc-readonly", async () => {
      const result = await page.evaluate(
        (input) => window.agentvac.diagnoseStorage(input),
        { ...request, requestId: randomUUID() },
      );
      assert.equal(result.observational, true);
      if (
        ["CODEX_RUNNING", "PROCESS_UNKNOWN"].includes(result.deepCheck.reason)
      ) {
        diagnosticGate = result.deepCheck.reason;
        assert.equal(result.deepCheck.status, "blocked");
        assert.deepEqual(await sourceSnapshot(), sqliteBefore);
        const gatedLaunches = await application.evaluate(
          () => globalThis.__diagQA.rows,
        );
        for (const row of gatedLaunches) {
          observedOwnedHelpers.add(row.pid);
          await helpersGone([row.pid]);
        }
        record("diagnostic-actual-process-gate", "PASS", {
          reason: diagnosticGate,
          helperLaunches: gatedLaunches.length,
          stoppedAtActualPreOrPostProcessGate: true,
          sourceUnchanged: true,
          detectorMocked: false,
        });
        throw new CapabilitySkip(
          `Actual process gate ${diagnosticGate}; full native parser IPC needs an authorized isolated runner without Codex processes. No process gate bypassed.`,
        );
      }
      assert.equal(
        result.deepCheck.status,
        "ok",
        JSON.stringify(result.deepCheck),
      );
      assert.equal(result.deepCheck.schema, "codex-logs-v2");
      assert.equal(result.deepCheck.sourceUnchanged, true);
      assert.equal(result.deepCheck.metrics.autoVacuum, "incremental");
      assert.ok(result.deepCheck.metrics.freelistCount > 0);
      assert.ok(
        !JSON.stringify(result).includes(syntheticBody),
        "Synthetic log contents must not cross IPC",
      );
      assert.deepEqual(
        await sourceSnapshot(),
        sqliteBefore,
        "Real diagnosis must leave bytes, timestamps and sidecar inventory unchanged",
      );
      const launches = await application.evaluate(
        () => globalThis.__diagQA.rows,
      );
      assert.equal(launches.length, 1);
      assert.equal(launches[0].mode, "unmodified");
      assert.equal(launches[0].workerPath, workerPath);
      assert.equal(launches[0].exited, true);
      assert.notEqual(launches[0].pid, electronMainPid);
      observedOwnedHelpers.add(launches[0].pid);
      await helpersGone([launches[0].pid]);
      return {
        deepCheck: result.deepCheck,
        actualIndependentSupervisorPid: launches[0].pid,
        shippedHelperArgumentsUnchanged: true,
        sourceHashAndMetadataIdentical: true,
        noSidecarsCreated: true,
        logContentNotReturned: true,
      };
    });
    await check("diagnostic-cancel-no-orphans", async () => {
      if (diagnosticGate)
        throw new CapabilitySkip(
          `Cannot start native diagnostic child because actual process gate is ${diagnosticGate}; no process detector mocked.`,
        );
      const requestId = randomUUID();
      const pids = await beginStalledDiagnosis({ ...request, requestId });
      await page.evaluate(
        (id) => window.agentvac.cancelDiagnosis(id),
        requestId,
      );
      const result = await until(
        async () => page.evaluate(() => window.__nativeDiagnosis),
        "IPC cancellation settles",
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /诊断已取消/);
      await helpersGone(pids);
      assert.deepEqual(await sourceSnapshot(), sqliteBefore);
      await application.evaluate(() => {
        globalThis.__diagQA.mode = "normal";
      });
      const retry = await page.evaluate(
        (input) => window.agentvac.diagnoseStorage(input),
        { ...request, requestId: randomUUID() },
      );
      assert.equal(
        retry.deepCheck.status,
        "ok",
        JSON.stringify(retry.deepCheck),
      );
      assert.deepEqual(await sourceSnapshot(), sqliteBefore);
      return {
        ownedPids: pids,
        cancelledThroughRealPreloadIpc: true,
        bothProcessesExited: true,
        subsequentUnmodifiedDiagnosisSucceeded: true,
        sourceUnchanged: true,
        faultInjection:
          "Test-only --require preload stalls parser start with Atomics.wait; shipped supervisor, real process ownership and application cancellation are exercised.",
      };
    });
    await check("diagnostic-window-close-no-orphans", async () => {
      if (diagnosticGate)
        throw new CapabilitySkip(
          `No active native diagnostic worker with actual gate ${diagnosticGate}; window-close-during-diagnosis is untested.`,
        );
      const pids = await beginStalledDiagnosis({
        ...request,
        requestId: randomUUID(),
      });
      const processHandle = application.process(),
        exited = once(processHandle, "exit");
      await application.evaluate(({ BrowserWindow }) => {
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 40);
      });
      const [code, signal] = await deadline(
        exited,
        15000,
        "native window close during diagnosis",
      );
      assert.equal(code, 0);
      assert.equal(signal, null);
      application = undefined;
      await helpersGone(pids);
      assert.deepEqual(await sourceSnapshot(), sqliteBefore);
      return {
        realBrowserWindowClose: true,
        applicationExitCode: code,
        ownedPids: pids,
        supervisorAndWorkerGone: true,
        sourceUnchanged: true,
        faultInjection:
          "Same separately labeled controlled parser-start stall; no production helper code or OS security policy modified.",
      };
    });
  }
} catch (error) {
  primaryError = error;
  console.error(error.stack || error);
} finally {
  if (second && second.exitCode === null && second.signalCode === null)
    second.kill();
  if (application) {
    if (page && !page.isClosed())
      await deadline(
        page.evaluate(() => window.agentvac.cancelDiagnosis()),
        2000,
        "cancel outstanding fixture diagnosis",
      ).catch(() => {});
    try {
      await deadline(application.close(), 10000, "graceful fixture app close");
    } catch (error) {
      primaryError ??= error;
      await forceStopOwnedApplication().catch((error) => console.error(error));
    }
  }
  // Fail evidence is still emitted on cleanup trouble. Never kill an unrelated process or clear any Trash.
  for (const pid of observedOwnedHelpers) {
    try {
      await helpersGone([pid]);
    } catch (error) {
      primaryError ??= error;
      console.error(
        `Observed fixture diagnostic process ${pid} did not exit; no broad process-name kill attempted.`,
      );
    }
  }
  assert.equal(path.dirname(ownedRoot), storage.path);
  assert.match(path.basename(ownedRoot), /^agentvac-native-suite-/);
  await fs
    .rm(ownedRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    })
    .catch((error) => {
      primaryError ??= error;
    });
  results.status = primaryError
    ? "FAIL"
    : selfTest
      ? "SELF_TEST_PASS_NATIVE_UNTESTED"
      : Object.values(results.checks).some((check) =>
            ["SKIP", "UNTESTED"].includes(check.status),
          )
        ? "PASS_WITH_LIMITATIONS"
        : "PASS";
  if (primaryError) results.error = String(primaryError.stack || primaryError);
  results.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(evidenceFile), { recursive: true });
  await fs.writeFile(evidenceFile, JSON.stringify(results, null, 2));
  console.log("AGENTVAC_NATIVE_EVIDENCE_BEGIN");
  console.log(JSON.stringify(results, null, 2));
  console.log("AGENTVAC_NATIVE_EVIDENCE_END");
}
if (primaryError) process.exitCode = 1;
