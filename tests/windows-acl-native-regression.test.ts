import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import {
  inspectCursorSnapshotWindowsAcl,
  inspectCursorSnapshotWindowsAclDetailed,
  cursorSnapshotAclIsPrivate,
  canonicalizeCursorSnapshotWindowsPath,
  inspectCursorSnapshotWindowsLocality,
} from "../electron/conversations/cursor-windows-acl.js";

const target = String.raw`C:\Synthetic\literal [x]; $().txt`;
const current = "S-1-5-21-100-200-300-1001";
const ace = (sid = current) => ({
  sid,
  rights: 2032127,
  type: "allow",
  inherited: true,
  inheritance: 3,
  propagation: 0,
});
const observation = () => ({
  localityVerified: true,
  currentUserSid: current,
  ownerSid: current,
  canonical: true,
  entries: [ace(), ace("S-1-5-18"), ace("S-1-5-32-544")],
});
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills = 0;
  kill() {
    this.kills++;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
  close(code: number) {
    this.exitCode = code;
    this.emit("close", code);
  }
  complete(value: unknown = observation(), code = 0) {
    this.stdout.write(JSON.stringify(value));
    this.close(code);
  }
}
function harness(t: TestContext, run: (child: FakeChild) => void = () => {}) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalEnv = { ...process.env };
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  process.env.SystemRoot = String.raw`C:\Windows`;
  for (const name of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"])
    delete process.env[name];
  const child = new FakeChild();
  const calls: {
    executable: string;
    args: readonly string[];
    options: childProcess.SpawnOptions;
  }[] = [];
  t.mock.method(
    childProcess,
    "spawn",
    (
      executable: string,
      args: readonly string[],
      options: childProcess.SpawnOptions,
    ) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => run(child));
      return child as unknown as childProcess.ChildProcess;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    child.stdout.destroy();
    child.stderr.destroy();
  });
  return { child, calls };
}

test("Windows ACL helper pins native executable, module imports and bounded environment", async (t) => {
  const h = harness(t, (child) => child.complete());
  process.env.APPDATA = String.raw`C:\Users\Synthetic\AppData\Roaming`;
  process.env.LOCALAPPDATA = String.raw`C:\Users\Synthetic\AppData\Local`;
  process.env.USERPROFILE = String.raw`C:\Users\Synthetic`;
  process.env.TEMP = String.raw`C:\Synthetic\Temp`;
  process.env.TMP = String.raw`C:\Synthetic\Temp`;
  process.env.PSModulePath = String.raw`C:\Untrusted\Modules`;
  process.env.NODE_OPTIONS = "--require synthetic-do-not-inherit";
  process.env.SYNTHETIC_TOKEN = "do-not-inherit";
  const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
  assert.equal(detail.outcome, "verified-private");
  assert.equal(detail.exitCode, 0);
  assert.equal(h.child.kills, 0);
  assert.equal(h.calls.length, 1);
  const { executable, args, options } = h.calls[0];
  assert.equal(
    executable,
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  );
  assert.deepEqual(args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
  ]);
  const script = Buffer.from(args[6], "base64").toString("utf16le");
  assert.ok(!script.includes(target));
  assert.match(script, /\$p=\$env:AGENTVAC_SNAPSHOT_ACL_TARGET/);
  assert.match(script, /\$PSModuleAutoLoadingPreference='None'/);
  assert.match(
    script,
    /Import-Module -Name \(\$PSHOME\+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'\)/,
  );
  assert.match(
    script,
    /Microsoft.PowerShell.Security\\Get-Acl -LiteralPath \$p/,
  );
  assert.match(
    script,
    /GetAccessRules\(\$true,\$true,\[System.Security.Principal.SecurityIdentifier\]\)/,
  );
  assert.match(script, /Microsoft.PowerShell.Utility\\ConvertTo-Json/);
  assert.doesNotMatch(
    script,
    /Set-Acl|icacls|SetAccessRule|SetOwner|SetAccessControl|ExecutionPolicy/i,
  );
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, undefined);
  assert.equal(
    options.cwd,
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`,
  );
  assert.deepEqual(options.env, {
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    SystemDrive: "C:",
    PATH: String.raw`C:\Windows\System32`,
    PSModulePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
    PSModuleAnalysisCachePath: "NUL",
    AGENTVAC_SNAPSHOT_ACL_TARGET: target,
    AGENTVAC_ACL_MODE: "acl",
    AGENTVAC_ACL_DIRECTORY: "1",
    AGENTVAC_ACL_ALLOW_MISSING_LEAF: "0",
    USERPROFILE: "",
    APPDATA: "",
    LOCALAPPDATA: "",
    TEMP: "",
    TMP: "",
    HOMEDRIVE: "",
    HOMEPATH: "",
    AGENTVAC_BOOTSTRAP_USERPROFILE: process.env.USERPROFILE,
    AGENTVAC_BOOTSTRAP_APPDATA: process.env.APPDATA,
    AGENTVAC_BOOTSTRAP_LOCALAPPDATA: process.env.LOCALAPPDATA,
    AGENTVAC_BOOTSTRAP_TEMP: process.env.TEMP,
    AGENTVAC_BOOTSTRAP_TMP: process.env.TMP,
  });
});

test("Windows ACL evidence distinguishes valid broad ACL rejection from helper errors", async (t) => {
  const broad = {
    ...observation(),
    entries: [...observation().entries, ace("S-1-1-0")],
  };
  harness(t, (child) => child.complete(broad));
  const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
  assert.equal(detail.outcome, "acl-rejected");
  assert.equal(detail.exitCode, 0);
  assert.equal(cursorSnapshotAclIsPrivate(broad, true), false);
  assert.equal(await inspectCursorSnapshotWindowsAcl(target, true), false);
  assert.ok(!JSON.stringify(detail).includes(current));
  assert.ok(!JSON.stringify(detail).includes(target));
});

for (const [label, body] of [
  ["malformed JSON", "{invalid"],
  ["missing ACL schema", "{}"],
  ["non-array entries", JSON.stringify({ ...observation(), entries: ace() })],
  [
    "coerced canonical",
    JSON.stringify({ ...observation(), canonical: "true" }),
  ],
  ["invalid UTF-8", Buffer.from([0xff])],
] as const) {
  test(`Windows ACL ${label} is invalid output, never native public rejection`, async (t) => {
    harness(t, (child) => {
      child.stdout.write(body);
      child.close(0);
    });
    const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
    assert.equal(detail.outcome, "invalid-output");
  });
}

test("Windows ACL helper timeout reports its last phase and kills only the helper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t);
  const pending = inspectCursorSnapshotWindowsAclDetailed(target, true);
  h.child.stderr.write("AGENTVAC_ACL:star");
  h.child.stderr.write(
    "ted\r\nAGENTVAC_ACL:modules-loaded\nprivate-profile-name\n",
  );
  t.mock.timers.tick(5000);
  const detail = await pending;
  assert.equal(detail.outcome, "timeout");
  assert.equal(detail.helperPhase, "modules-loaded");
  assert.equal(h.child.kills, 1);
  assert.equal(detail.exitCode, null);
  assert.ok(!JSON.stringify(detail).includes("private-profile-name"));
  h.child.complete(); // Late output/close must not change a timed-out decision.
  assert.equal(detail.outcome, "timeout");
});

test("Windows ACL nonzero helper exit cannot accept otherwise private JSON", async (t) => {
  harness(t, (child) => child.complete(observation(), 3));
  const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
  assert.equal(detail.outcome, "helper-failed");
  assert.equal(detail.exitCode, 3);
});

test("Windows ACL spawn error is sanitized and cannot count as public rejection", async (t) => {
  harness(t, (child) => child.emit("error", new Error("private-profile-name")));
  const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
  assert.equal(detail.outcome, "spawn-failed");
  assert.ok(!JSON.stringify(detail).includes("private-profile-name"));
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`Windows ACL ${stream} output is bounded and fails closed`, async (t) => {
    const h = harness(t, (child) =>
      child[stream].write(Buffer.alloc(65 * 1024, 65)),
    );
    const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
    assert.equal(detail.outcome, "output-limit");
    assert.equal(h.child.kills, 1);
    assert.ok(!JSON.stringify(detail).includes("AAAA"));
  });
}

test("Windows ACL in-flight cancellation and pre-cancellation fail closed", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const pending = inspectCursorSnapshotWindowsAclDetailed(
    target,
    true,
    controller.signal,
  );
  controller.abort();
  assert.equal((await pending).outcome, "cancelled");
  assert.equal(h.child.kills, 1);
  const count = h.calls.length;
  assert.equal(
    (
      await inspectCursorSnapshotWindowsAclDetailed(
        target,
        true,
        controller.signal,
      )
    ).outcome,
    "cancelled",
  );
  assert.equal(h.calls.length, count);
});

test("Windows ACL invalid target/environment never starts a helper", async (t) => {
  const h = harness(t);
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed("relative", true)).outcome,
    "invalid-target",
  );
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed("C:\\synthetic\n", true))
      .outcome,
    "invalid-target",
  );
  process.env.SystemRoot = String.raw`C:\Untrusted`;
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
    "invalid-environment",
  );
  assert.equal(h.calls.length, 0);
});

test("Windows ACL native probe requires a measured policy rejection for the public boundary", async () => {
  const source = await fs.readFile(
    new URL("../scripts/native-conversation-acl.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /result\.checks\[name\] = detail\.outcome === expectedOutcome/,
  );
  assert.match(
    source,
    /await inspect\("publicDirectoryRejected", publicRoot, true, "acl-rejected"\)/,
  );
  assert.doesNotMatch(source, /!\(await inspectCursorSnapshotWindowsAcl/);
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`Windows ACL ${stream} stream error cannot escape or count as rejection`, async (t) => {
    const h = harness(t, (child) =>
      child[stream].emit("error", new Error("private-profile-name")),
    );
    const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
    assert.equal(detail.outcome, "helper-failed");
    assert.equal(h.child.kills, 1);
    assert.ok(!JSON.stringify(detail).includes("private-profile-name"));
  });
}

test("Windows ACL bootstrap rejects malformed application-data locations before spawn", async (t) => {
  const h = harness(t, (child) => child.complete());
  process.env.APPDATA = "relative-synthetic-location";
  process.env.LOCALAPPDATA = "C:\\Synthetic\n";
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
    "invalid-environment",
  );
  assert.equal(h.calls.length, 0);
});

for (const rights of [0, 0x10000000, -0x80000000]) {
  test(`Windows ACL native Int32 rights ${rights} are measured but never privately accepted`, async (t) => {
    const value = { ...observation(), entries: [{ ...ace(), rights }] };
    harness(t, (child) => child.complete(value));
    assert.equal(
      (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
      "acl-rejected",
    );
    assert.equal(await inspectCursorSnapshotWindowsAcl(target, true), false);
    assert.equal(cursorSnapshotAclIsPrivate(value, true), false);
  });
}

test("Windows ACL empty native DACL is measured but lacks required current access", async (t) => {
  harness(t, (child) => child.complete({ ...observation(), entries: [] }));
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
    "acl-rejected",
  );
  assert.equal(await inspectCursorSnapshotWindowsAcl(target, true), false);
});

test("Windows ACL impossible native mask remains invalid output", async (t) => {
  harness(t, (child) =>
    child.complete({
      ...observation(),
      entries: [{ ...ace(), rights: 0x100000000 }],
    }),
  );
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
    "invalid-output",
  );
});

for (const [input, expected] of [
  [String.raw`c:\Synthetic\Copy`, String.raw`C:\Synthetic\Copy`],
  [String.raw`\\?\c:\Synthetic\Copy`, String.raw`C:\Synthetic\Copy`],
  ["C:/Synthetic/Copy/", String.raw`C:\Synthetic\Copy`],
  ["c:\\", "C:\\"],
  ["\\\\?\\C:\\", "C:\\"],
] as const) {
  test(`Windows private-copy canonical local spelling ${JSON.stringify(input)}`, () => {
    assert.equal(canonicalizeCursorSnapshotWindowsPath(input), expected);
  });
}

for (const input of [
  String.raw`\\server\share\copy`,
  String.raw`\\?\UNC\server\share\copy`,
  String.raw`\\?\unc\server\share\copy`,
  String.raw`\\.\UNC\server\share\copy`,
  String.raw`\\.\C:\copy`,
  String.raw`\\?\Volume{synthetic}\copy`,
  String.raw`\??\C:\copy`,
  String.raw`C:relative`,
  String.raw`\rooted-without-drive`,
  String.raw`C:\safe\..\copy`,
  String.raw`\\?\C:\safe\..\copy`,
  String.raw`\\?\C:/safe/copy`,
  "//?/C:/safe/copy",
  String.raw`\\?/C:\safe\copy`,
  String.raw`C:\safe\copy.`,
  String.raw`C:\safe\copy `,
  String.raw`C:\safe\copy:stream`,
  String.raw`C:\safe\CON`,
  String.raw`C:\safe\COM¹.txt`,
  String.raw`C:\safe\CONOUT$`,
]) {
  test(`Windows private-copy rejects namespace or ambiguous path ${JSON.stringify(input)}`, async (t) => {
    const h = harness(t, (child) => child.complete());
    assert.equal(canonicalizeCursorSnapshotWindowsPath(input), null);
    assert.equal(
      (await inspectCursorSnapshotWindowsAclDetailed(input, true)).outcome,
      "invalid-target",
    );
    assert.equal(
      await inspectCursorSnapshotWindowsLocality(input, true),
      false,
    );
    assert.equal(h.calls.length, 0);
  });
}

for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP"]) {
  test(`Windows private-copy rejects UNC ${name} before launching any helper`, async (t) => {
    const h = harness(t, (child) => child.complete());
    process.env[name] = String.raw`\\synthetic-server\share\private-bootstrap`;
    const detail = await inspectCursorSnapshotWindowsAclDetailed(target, true);
    assert.equal(detail.outcome, "invalid-environment");
    assert.equal(
      await inspectCursorSnapshotWindowsLocality(target, true),
      false,
    );
    assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(detail).includes("synthetic-server"));
  });
}

test("Windows private-copy extended target and bootstrap are canonical before native proof", async (t) => {
  const h = harness(t, (child) => child.complete());
  process.env.APPDATA = String.raw`\\?\c:\Synthetic\Roaming`;
  process.env.LOCALAPPDATA = String.raw`c:\Synthetic\Local`;
  assert.equal(
    await inspectCursorSnapshotWindowsAcl(
      String.raw`\\?\c:\Synthetic\Copy`,
      true,
    ),
    true,
  );
  assert.equal(
    h.calls[0].options.env!.AGENTVAC_SNAPSHOT_ACL_TARGET,
    String.raw`C:\Synthetic\Copy`,
  );
  assert.equal(
    h.calls[0].options.env!.AGENTVAC_BOOTSTRAP_APPDATA,
    String.raw`C:\Synthetic\Roaming`,
  );
  assert.equal(h.calls[0].options.env!.APPDATA, "");
});

test("Windows private-copy locality preflight accepts only an explicit native locality result", async (t) => {
  const h = harness(t, (child) => child.complete({ localityVerified: true }));
  assert.equal(await inspectCursorSnapshotWindowsLocality(target, true), true);
  assert.equal(h.calls[0].options.env!.AGENTVAC_ACL_MODE, "locality");
  assert.equal(h.calls[0].options.env!.AGENTVAC_ACL_ALLOW_MISSING_LEAF, "1");
  assert.equal(h.calls[0].options.env!.AGENTVAC_ACL_DIRECTORY, "1");
  assert.equal(await inspectCursorSnapshotWindowsLocality(target), true);
  assert.equal(h.calls[1].options.env!.AGENTVAC_ACL_ALLOW_MISSING_LEAF, "0");
});

test("Windows private-copy mapped or ambiguous native locality rejection always blocks", async (t) => {
  harness(t, (child) => {
    child.stderr.write("AGENTVAC_ACL:started\n");
    child.complete(observation(), 4);
  });
  const detail = await inspectCursorSnapshotWindowsAclDetailed(
    String.raw`Z:\Synthetic\Copy`,
    true,
  );
  assert.equal(detail.outcome, "locality-rejected");
  assert.equal(detail.exitCode, 4);
  assert.equal(await inspectCursorSnapshotWindowsLocality(target, true), false);
  assert.equal(await inspectCursorSnapshotWindowsAcl(target, true), false);
});

test("Windows private-copy ACL cannot pass without native locality evidence", async (t) => {
  const { localityVerified: _ignored, ...unproved } = observation();
  harness(t, (child) => child.complete(unproved));
  assert.equal(
    (await inspectCursorSnapshotWindowsAclDetailed(target, true)).outcome,
    "invalid-output",
  );
  assert.equal(await inspectCursorSnapshotWindowsLocality(target, true), false);
});

test("Windows locality checks native DOS mapping and each ancestor before ACL or bootstrap activation", async (t) => {
  const h = harness(t, (child) => child.complete({ localityVerified: true }));
  await inspectCursorSnapshotWindowsLocality(target, true);
  const script = Buffer.from(h.calls[0].args[6], "base64").toString("utf16le");
  assert.match(
    script,
    /DefineDynamicAssembly\(\$assemblyName,\[Reflection.Emit.AssemblyBuilderAccess\]::Run\)/,
  );
  assert.match(script, /name='QueryDosDeviceW'/);
  assert.match(script, /name='GetFileAttributesW'/);
  assert.match(script, /GetField\('SetLastError'\)/);
  assert.match(script, /GetField\('ExactSpelling'\)/);
  assert.match(
    script,
    /SetImplementationFlags\(\[Reflection.MethodImplAttributes\]::PreserveSig\)/,
  );
  assert.match(script, /FreeHGlobal\(\$buffer\)/);
  assert.match(script, /\$mappingBlock.IndexOf\(\[char\]0\)/);
  assert.match(script, /\$mappingBlock.Substring\(0,\$terminator\)/);
  assert.match(script, /HarddiskVolume\[0-9\]\+\$/);
  assert.match(script, /\$drive.DriveType -ne \[IO.DriveType\]::Fixed/);
  assert.match(script, /\$attributes -band 0x400/);
  assert.match(
    script,
    /\$allowMissingLeaf -and \$index -eq \(\$parts.Length-1\)/,
  );
  assert.match(script, /\$lastError -eq 2 -or \$lastError -eq 3/);
  assert.ok(
    script.indexOf("Test-AgentVacLocalPath $p") <
      script.indexOf("Import-Module -Name"),
  );
  assert.ok(
    script.indexOf("Test-AgentVacLocalPath $candidate $false $true") <
      script.indexOf("[Environment]::SetEnvironmentVariable"),
  );
  assert.ok(
    script.indexOf("Test-AgentVacLocalPath $p") <
      script.indexOf("Security\\Get-Acl"),
  );
  assert.doesNotMatch(
    script,
    /Add-Type\s+-|DefineDosDevice|Set-Acl|icacls|New-PSDrive|net use|New-Item/,
  );
});

test("Windows ACL synthetic probe verifies local temporary parent before realpath or creation", async () => {
  const source = await fs.readFile(
    new URL("../scripts/native-conversation-acl.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.indexOf("await inspectCursorSnapshotWindowsLocalityDetailed(") <
      source.indexOf("fixture = await fs.mkdtemp("),
  );
  assert.ok(
    source.indexOf('"Local temporary parent could not be verified"') <
      source.indexOf("await fs.realpath(temporaryParent)"),
  );
});
