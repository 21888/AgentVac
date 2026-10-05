import { spawn } from "node:child_process";
import path from "node:path";

/** Every private target must pass actual read-only native ACL validation at runtime. */
export const CURSOR_WINDOWS_ACL_POLICY = "runtime-read-only-allowlist-v1";
const SID = /^S-1-(?:\d+-){1,14}\d+$/;
const SYSTEM = "S-1-5-18",
  ADMINISTRATORS = "S-1-5-32-544";

/** Pure conservative validator. Never return or log raw SIDs, paths, or ACL text. */
export function cursorSnapshotAclIsPrivate(
  value: unknown,
  requireInheritance: boolean,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.currentUserSid !== "string" ||
    !SID.test(v.currentUserSid) ||
    typeof v.ownerSid !== "string" ||
    !SID.test(v.ownerSid) ||
    v.canonical !== true ||
    !Array.isArray(v.entries) ||
    v.entries.length === 0 ||
    v.entries.length > 128
  )
    return false;
  const allowed = new Set([v.currentUserSid, SYSTEM, ADMINISTRATORS]);
  if (!allowed.has(v.ownerSid)) return false;
  let currentAccess = false,
    safeInheritance = !requireInheritance;
  for (const candidate of v.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const ace = candidate as Record<string, unknown>;
    if (
      typeof ace.sid !== "string" ||
      !SID.test(ace.sid) ||
      !Number.isSafeInteger(ace.rights) ||
      Number(ace.rights) <= 0 ||
      Number(ace.rights) > 0x1fffff ||
      (ace.type !== "allow" && ace.type !== "deny") ||
      typeof ace.inherited !== "boolean" ||
      !Number.isInteger(ace.inheritance) ||
      Number(ace.inheritance) < 0 ||
      Number(ace.inheritance) > 3 ||
      !Number.isInteger(ace.propagation) ||
      Number(ace.propagation) < 0 ||
      Number(ace.propagation) > 3
    )
      return false;
    // We do not attempt to prove arbitrary group memberships or deny/allow
    // interactions. An allow for any broader/unresolved principal blocks copying.
    if (ace.type === "allow" && !allowed.has(ace.sid)) return false;
    if (
      ace.type === "allow" &&
      ace.sid === v.currentUserSid &&
      (Number(ace.rights) & 3) === 3 &&
      (Number(ace.propagation) & 2) === 0
    )
      currentAccess = true;
    if (
      ace.type === "allow" &&
      ace.sid === v.currentUserSid &&
      ace.inheritance === 3 &&
      ace.propagation === 0
    )
      safeInheritance = true;
    if (ace.type === "deny" && allowed.has(ace.sid)) return false;
  }
  return currentAccess && safeInheritance;
}

/** Canonical local-drive spelling only; this does not prove native locality. */
export function canonicalizeCursorSnapshotWindowsPath(
  value: string,
): string | null {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  let candidate: string;
  if (value.startsWith("\\\\?\\")) {
    if (value.includes("/")) return null;
    candidate = value.slice(4);
  } else {
    // Classify namespaces before slash conversion, so //?/ cannot become a
    // synthesized extended namespace and bypass the original spelling check.
    if (!/^[a-zA-Z]:[\\/]/.test(value)) return null;
    candidate = value.replace(/\//g, "\\");
  }
  if (!/^[a-zA-Z]:\\/.test(candidate)) return null;
  const parts = candidate.slice(3).split("\\");
  if (parts.at(-1) === "") parts.pop();
  // Extended paths treat dot/trailing-space/device components differently.
  // Reject those ambiguous spellings rather than silently changing identity.
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(
          part,
        ),
    )
  )
    return null;
  return candidate[0].toUpperCase() + ":\\" + parts.join("\\");
}

// Read-only native locality precedes module imports, app-data initialization and
// ACL reads. Reflection.Emit binds only these fixed OS metadata APIs in memory.
const SCRIPT = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$PSModuleAutoLoadingPreference='None'
try {
  [Console]::Error.WriteLine('AGENTVAC_ACL:started')
  # Runtime-only P/Invoke: no Add-Type compiler, generated files or module lookup.
  $assemblyName=[Reflection.AssemblyName]::new('AgentVacReadOnlyLocality')
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('Native')
  $type=$module.DefineType('AgentVacReadOnlyLocality.Native',[Reflection.TypeAttributes]::Public)
  $dll=[Runtime.InteropServices.DllImportAttribute]
  $constructor=$dll.GetConstructor([type[]]@([string]))
  $fields=[Reflection.FieldInfo[]]@($dll.GetField('EntryPoint'),$dll.GetField('CharSet'),$dll.GetField('SetLastError'),$dll.GetField('ExactSpelling'))
  foreach ($spec in @(
    @{name='QueryDosDeviceW';parameters=[type[]]@([string],[IntPtr],[uint32])},
    @{name='GetFileAttributesW';parameters=[type[]]@([string])}
  )) {
    $method=$type.DefineMethod($spec.name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[uint32],$spec.parameters)
    $attribute=[Reflection.Emit.CustomAttributeBuilder]::new($constructor,[object[]]@('kernel32.dll'),$fields,[object[]]@($spec.name,[Runtime.InteropServices.CharSet]::Unicode,$true,$true))
    $method.SetCustomAttribute($attribute)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $native=$type.CreateType()
  $queryDevice=$native.GetMethod('QueryDosDeviceW')
  $getAttributes=$native.GetMethod('GetFileAttributesW')
  function Test-AgentVacLocalPath([string]$candidate,[bool]$allowMissingLeaf,[bool]$requireDirectory) {
    if ($candidate -notmatch '^[A-Za-z]:\\' -or $candidate -match '[\x00-\x1f\x7f]') { return $false }
    $root=$candidate.Substring(0,3)
    $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(65536)
    try {
      $count=[uint32]$queryDevice.Invoke($null,[object[]]@($root.Substring(0,2),$buffer,[uint32]32768))
      if ($count -eq 0 -or $count -ge 32768) { return $false }
      $mappingBlock=[Runtime.InteropServices.Marshal]::PtrToStringUni($buffer,[int]$count)
      $terminator=$mappingBlock.IndexOf([char]0)
      if ($terminator -le 0) { return $false }
      # QueryDosDevice defines the first string as current; later strings are
      # historical mappings, never alternate candidates for acceptance.
      $mapping=$mappingBlock.Substring(0,$terminator)
      if ($mapping -notmatch '^\\Device\\HarddiskVolume[0-9]+$') { return $false }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
    $drive=[IO.DriveInfo]::new($root)
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { return $false }
    $parts=@($candidate.Substring(3).Split([char[]]@('\'),[StringSplitOptions]::RemoveEmptyEntries))
    $current=$root
    for ($index=-1; $index -lt $parts.Length; $index++) {
      if ($index -ge 0) {
        if (-not $current.EndsWith('\')) { $current+='\' }
        $current+=$parts[$index]
      }
      $attributes=[uint32]$getAttributes.Invoke($null,[object[]]@('\\?\'+$current))
      $lastError=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($attributes -eq [uint32]::MaxValue) {
        return $allowMissingLeaf -and $index -eq ($parts.Length-1) -and $index -ge 0 -and ($lastError -eq 2 -or $lastError -eq 3)
      }
      # Inspect one component at a time. Never traverse a junction, symlink,
      # mounted folder or other reparse point to discover a later component.
      if (($attributes -band 0x400) -ne 0) { return $false }
      if (($index -lt ($parts.Length-1) -or $requireDirectory) -and ($attributes -band 0x10) -eq 0) { return $false }
    }
    return $true
  }
  $p=$env:AGENTVAC_SNAPSHOT_ACL_TARGET
  if (-not (Test-AgentVacLocalPath $p ($env:AGENTVAC_ACL_ALLOW_MISSING_LEAF -eq '1') ($env:AGENTVAC_ACL_DIRECTORY -eq '1'))) { exit 4 }
  # Bootstrap values arrive only in inert fields. Native verification precedes
  # assigning any of them to variables PowerShell/.NET can use for storage.
  foreach ($name in @('USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')) {
    $candidate=[Environment]::GetEnvironmentVariable('AGENTVAC_BOOTSTRAP_'+$name,'Process')
    if (-not [string]::IsNullOrEmpty($candidate)) {
      if (-not (Test-AgentVacLocalPath $candidate $false $true)) { exit 4 }
    }
  }
  foreach ($name in @('USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')) {
    $candidate=[Environment]::GetEnvironmentVariable('AGENTVAC_BOOTSTRAP_'+$name,'Process')
    if (-not [string]::IsNullOrEmpty($candidate)) { [Environment]::SetEnvironmentVariable($name,$candidate,'Process') }
  }
  [Console]::Error.WriteLine('AGENTVAC_ACL:locality-verified')
  if ($env:AGENTVAC_ACL_MODE -eq 'locality') {
    [Console]::Out.WriteLine('{"localityVerified":true}')
    exit 0
  }
  $env:PSModulePath=$PSHOME+'\Modules'
  Import-Module -Name ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  Import-Module -Name ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  [Console]::Error.WriteLine('AGENTVAC_ACL:modules-loaded')
  $a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $p
  $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $o=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules=@(foreach ($rule in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    @{sid=$rule.IdentityReference.Value;rights=[int64]$rule.FileSystemRights;type=if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {'allow'} else {'deny'};inherited=$rule.IsInherited;inheritance=[int]$rule.InheritanceFlags;propagation=[int]$rule.PropagationFlags}
  })
  [Console]::Error.WriteLine('AGENTVAC_ACL:acl-read')
  $json=@{localityVerified=$true;currentUserSid=$u;ownerSid=$o;canonical=$a.AreAccessRulesCanonical;entries=$rules} | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 5 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Error.WriteLine('AGENTVAC_ACL:serialized')
  exit 0
} catch {
  exit 3
}`;

export type CursorWindowsAclOutcome =
  | "verified-private"
  | "verified-local"
  | "locality-rejected"
  | "acl-rejected"
  | "not-windows"
  | "invalid-target"
  | "invalid-environment"
  | "cancelled"
  | "spawn-failed"
  | "timeout"
  | "output-limit"
  | "helper-failed"
  | "invalid-output";
type HelperPhase =
  | "not-started"
  | "started"
  | "locality-verified"
  | "modules-loaded"
  | "acl-read"
  | "serialized";
/** Only bounded codes/counts leave the helper. Never include paths, SIDs or stderr. */
export interface CursorWindowsAclInspection {
  outcome: CursorWindowsAclOutcome;
  elapsedMs: number;
  helperPhase: HelperPhase;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
}

// Shape validation is separate from policy rejection so native QA cannot mistake
// corrupt/missing helper output for successful rejection of a public directory.
function aclObservationIsComplete(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    v.localityVerified !== true ||
    typeof v.currentUserSid !== "string" ||
    !SID.test(v.currentUserSid) ||
    typeof v.ownerSid !== "string" ||
    !SID.test(v.ownerSid) ||
    typeof v.canonical !== "boolean" ||
    !Array.isArray(v.entries) ||
    v.entries.length > 128
  )
    return false;
  return v.entries.every((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const ace = candidate as Record<string, unknown>;
    return (
      typeof ace.sid === "string" &&
      SID.test(ace.sid) &&
      Number.isSafeInteger(ace.rights) &&
      // .NET exposes the native mask as Int32, including generic high bits.
      // Completeness is not acceptance: the unchanged policy rejects them.
      Number(ace.rights) >= -0x80000000 &&
      Number(ace.rights) <= 0x7fffffff &&
      (ace.type === "allow" || ace.type === "deny") &&
      typeof ace.inherited === "boolean" &&
      Number.isInteger(ace.inheritance) &&
      Number(ace.inheritance) >= 0 &&
      Number(ace.inheritance) <= 3 &&
      Number.isInteger(ace.propagation) &&
      Number(ace.propagation) >= 0 &&
      Number(ace.propagation) <= 3
    );
  });
}

/** Read-only native validation with sanitized diagnostics, for Windows QA. */
async function inspectCursorSnapshotWindowsHelper(
  inputTarget: string,
  directory: boolean,
  signal: AbortSignal | undefined,
  localityOnly: boolean,
  allowMissingLeaf: boolean,
): Promise<CursorWindowsAclInspection> {
  const started = performance.now();
  let helperPhase: HelperPhase = "not-started",
    stdoutBytes = 0,
    stderrBytes = 0;
  const result = (
    outcome: CursorWindowsAclOutcome,
    exitCode: number | null = null,
  ): CursorWindowsAclInspection => ({
    outcome,
    elapsedMs: Math.round(performance.now() - started),
    helperPhase,
    exitCode,
    stdoutBytes,
    stderrBytes,
  });
  if (signal?.aborted) return result("cancelled");
  if (process.platform !== "win32") return result("not-windows");
  const target = canonicalizeCursorSnapshotWindowsPath(inputTarget);
  if (!target) return result("invalid-target");
  const systemRoot = canonicalizeCursorSnapshotWindowsPath(
    process.env.SystemRoot ?? "",
  );
  if (!systemRoot || !/^[a-zA-Z]:\\Windows$/i.test(systemRoot))
    return result("invalid-environment");
  const powershellHome = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
  );
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemRoot.slice(0, 2),
    PATH: path.win32.join(systemRoot, "System32"),
    PSModulePath: path.win32.join(powershellHome, "Modules"),
    PSModuleAnalysisCachePath: "NUL",
    AGENTVAC_SNAPSHOT_ACL_TARGET: target,
    AGENTVAC_ACL_MODE: localityOnly ? "locality" : "acl",
    AGENTVAC_ACL_DIRECTORY: directory ? "1" : "0",
    AGENTVAC_ACL_ALLOW_MISSING_LEAF: allowMissingLeaf ? "1" : "0",
    // Empty entries suppress libuv's automatic inheritance of these locations.
    // No unverified directory is supplied to PowerShell bootstrap. There is no
    // fallback copy destination if this bounded bootstrap cannot start safely.
    USERPROFILE: "",
    APPDATA: "",
    LOCALAPPDATA: "",
    TEMP: "",
    TMP: "",
    HOMEDRIVE: "",
    HOMEPATH: "",
  };
  for (const name of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    if (value) {
      const canonical = canonicalizeCursorSnapshotWindowsPath(value);
      if (!canonical) return result("invalid-environment");
      env[`AGENTVAC_BOOTSTRAP_${name}`] = canonical;
    }
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        path.win32.join(powershellHome, "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-OutputFormat",
          "Text",
          "-EncodedCommand",
          Buffer.from(SCRIPT, "utf16le").toString("base64"),
        ],
        {
          cwd: powershellHome,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        },
      );
    } catch {
      resolve(result("spawn-failed"));
      return;
    }
    let output: Buffer[] = [],
      diagnosticTail = "",
      ended = false;
    const finish = (
      outcome: CursorWindowsAclOutcome,
      code: number | null = null,
    ) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      output = [];
      diagnosticTail = "";
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(result(outcome, code));
    };
    const cancel = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), 5000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ended) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) return finish("output-limit");
      output.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (ended) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 16 * 1024) return finish("output-limit");
      // Recognize only exact constant phase lines, including split chunks. The
      // full native error stream is neither retained in results nor logged.
      diagnosticTail += chunk.toString("utf8");
      const lines = diagnosticTail.split(/\r?\n/);
      diagnosticTail = lines.pop() ?? "";
      for (const line of lines) {
        const phase = line.slice("AGENTVAC_ACL:".length);
        if (
          line.startsWith("AGENTVAC_ACL:") &&
          [
            "started",
            "locality-verified",
            "modules-loaded",
            "acl-read",
            "serialized",
          ].includes(phase)
        )
          helperPhase = phase as HelperPhase;
      }
    });
    child.stdout?.once("error", () => finish("helper-failed"));
    child.stderr?.once("error", () => finish("helper-failed"));
    child.once("error", () => finish("spawn-failed"));
    child.once("close", (code) => {
      if (ended) return;
      if (signal?.aborted) return finish("cancelled", code);
      if (code === 4) return finish("locality-rejected", code);
      if (code !== 0) return finish("helper-failed", code);
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true })
            .decode(Buffer.concat(output))
            .replace(/^\uFEFF/, ""),
        );
        if (localityOnly) {
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            (parsed as Record<string, unknown>).localityVerified !== true
          )
            return finish("invalid-output", code);
          return finish("verified-local", code);
        }
        if (!aclObservationIsComplete(parsed))
          return finish("invalid-output", code);
        finish(
          cursorSnapshotAclIsPrivate(parsed, directory)
            ? "verified-private"
            : "acl-rejected",
          code,
        );
      } catch {
        finish("invalid-output", code);
      }
    });
    if (signal?.aborted) cancel();
  });
}

/** Sanitized native locality evidence, for the synthetic Windows probe. */
export async function inspectCursorSnapshotWindowsLocalityDetailed(
  target: string,
  allowMissingLeaf = false,
  signal?: AbortSignal,
): Promise<CursorWindowsAclInspection> {
  return inspectCursorSnapshotWindowsHelper(
    target,
    true,
    signal,
    true,
    allowMissingLeaf,
  );
}

/** Read-only Windows locality checkpoint; an absent final leaf may be allowed. */
export async function inspectCursorSnapshotWindowsLocality(
  target: string,
  allowMissingLeaf = false,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    (
      await inspectCursorSnapshotWindowsLocalityDetailed(
        target,
        allowMissingLeaf,
        signal,
      )
    ).outcome === "verified-local"
  );
}

/** Read-only native ACL validation; every successful observation is local-only. */
export async function inspectCursorSnapshotWindowsAclDetailed(
  target: string,
  directory: boolean,
  signal?: AbortSignal,
): Promise<CursorWindowsAclInspection> {
  return inspectCursorSnapshotWindowsHelper(
    target,
    directory,
    signal,
    false,
    false,
  );
}

/** Every runtime call still fails closed unless a complete native ACL is private. */
export async function inspectCursorSnapshotWindowsAcl(
  target: string,
  directory: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    (await inspectCursorSnapshotWindowsAclDetailed(target, directory, signal))
      .outcome === "verified-private"
  );
}
