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

const SCRIPT = `$ErrorActionPreference='Stop'; $p=$env:AGENTVAC_SNAPSHOT_ACL_TARGET; if ([string]::IsNullOrEmpty($p)) { exit 2 }; $a=Get-Acl -LiteralPath $p; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $o=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;type=if ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {'allow'} else {'deny'};inherited=$_.IsInherited;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} }); @{currentUserSid=$u;ownerSid=$o;canonical=$a.AreAccessRulesCanonical;entries=$rules} | ConvertTo-Json -Depth 5 -Compress`;

/** Read-only native validation seam for Windows QA; no permission changes. */
export async function inspectCursorSnapshotWindowsAcl(
  target: string,
  directory: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    process.platform !== "win32" ||
    !path.win32.isAbsolute(target) ||
    /[\x00-\x1f\x7f]/.test(target) ||
    signal?.aborted
  )
    return false;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-zA-Z]:\\Windows$/i.test(systemRoot)) return false;
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          AGENTVAC_SNAPSHOT_ACL_TARGET: target,
        },
      },
    );
    let output = "",
      ended = false;
    const finish = (safe: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (child.exitCode === null) child.kill();
      resolve(safe);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, 5000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 64 * 1024) finish(false);
    });
    child.once("error", cancel);
    child.once("close", (code) => {
      if (code !== 0 || signal?.aborted) return finish(false);
      try {
        finish(
          cursorSnapshotAclIsPrivate(
            JSON.parse(output.replace(/^\uFEFF/, "")),
            directory,
          ),
        );
      } catch {
        finish(false);
      }
    });
    if (signal?.aborted) cancel();
  });
}
