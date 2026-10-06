import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessStatus, ProviderId } from "../shared/types.js";
import type { ProcessSnapshot, ProcessRecord } from "./providers/types.js";
import { getAdapter } from "./providers/index.js";
import { isGenericRuntimeCandidate } from "./providers/runtime-evidence.js";
import { collectLinuxArgumentObservations } from "./process-argv-linux/host.js";
const run = promisify(execFile);
const limits = { timeout: 5000, maxBuffer: 4_000_000, windowsHide: true };
export interface OwnedApplication {
  pid: number;
  executablePaths: readonly string[];
}
export function applicationExecutablePaths(
  executable: string,
  platform: NodeJS.Platform,
): string[] {
  const output = [executable];
  if (platform === "darwin") {
    const match = executable.match(/^(.*\.app\/Contents)\/MacOS\/([^/]+)$/);
    if (match)
      for (const suffix of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
        const name = match[2] + " Helper" + suffix;
        output.push(
          `${match[1]}/Frameworks/${name}.app/Contents/MacOS/${name}`,
        );
      }
  }
  return output;
}
function normalizedExecutable(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    const local = /^\\\\\?\\[a-z]:\\/i.test(value) ? value.slice(4) : value;
    return path.win32.normalize(local).toLowerCase();
  }
  return path.posix.normalize(value);
}
function helperRole(record: ProcessRecord): boolean {
  const command = record.commandLine ?? "";
  const executable = record.executablePath;
  // POSIX ps prints argv[0] with literal spaces rather than shell quotes. The
  // executable value is OS-derived; remove only its exact leading boundary.
  const unquoted = !!executable && command.startsWith(executable + " ");
  const argumentsText = unquoted
    ? command.slice(executable!.length).trimStart()
    : command;
  const tokens = [
    ...argumentsText.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|(\S+)/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  return /^(?:--type=)(?:zygote|gpu-process|renderer|utility|broker|crashpad-handler)$/.test(
    tokens[unquoted ? 0 : 1] ?? "",
  );
}
/** Name/arguments alone never grant ownership: require exact executable and a verified helper-only parent chain. */
export function excludeOwnedApplicationProcesses(
  snapshot: ProcessSnapshot,
  ownedPids: readonly number[],
  application?: OwnedApplication,
): ProcessSnapshot {
  const records = new Map(
    snapshot.processes
      .filter((record) => Number.isSafeInteger(record.pid))
      .map((record) => [record.pid!, record]),
  );
  const paths = new Set(
    (application?.executablePaths ?? []).map((value) =>
      normalizedExecutable(value, snapshot.platform),
    ),
  );
  const helper = (record: ProcessRecord) =>
    !!record.executablePath &&
    paths.has(normalizedExecutable(record.executablePath, snapshot.platform)) &&
    helperRole(record);
  const ownedHelper = (record: ProcessRecord) => {
    if (!application || !helper(record)) return false;
    let parent = record.parentPid;
    const visited = new Set<number>();
    for (
      let depth = 0;
      depth < 64 && Number.isSafeInteger(parent) && parent! > 0;
      depth++
    ) {
      if (parent === application.pid) return true;
      if (visited.has(parent!)) return false;
      visited.add(parent!);
      const ancestor = records.get(parent!);
      if (!ancestor || !helper(ancestor)) return false;
      parent = ancestor.parentPid;
    }
    return false;
  };
  return {
    ...snapshot,
    processes: snapshot.processes.filter(
      (record) => !ownedPids.includes(record.pid ?? -1) && !ownedHelper(record),
    ),
  };
}
/** Pure bounded-output parser: only OS-proven exited zombies are ignored. */
export function parsePosixProcessSnapshot(
  namesText: string,
  commandsText: string,
  platform: NodeJS.Platform,
  ownedPids: readonly number[] = [],
  withParents = false,
): ProcessSnapshot {
  const parse = (stdout: string) => {
    const result = new Map<
      number,
      { state: string; value: string; parentPid?: number }
    >();
    for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
      const match = line.match(
        withParents
          ? /^\s*(\d+)\s+(\d+)\s+([A-Za-z][A-Za-z<+NlsLEW-]*)\s+(\S.*)$/
          : /^\s*(\d+)\s+([A-Za-z][A-Za-z<+NlsLEW-]*)\s+(\S.*)$/,
      );
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        result.has(Number(match[1]))
      )
        throw new Error("Malformed process row");
      result.set(Number(match[1]), {
        state: match[withParents ? 3 : 2],
        value: match[withParents ? 4 : 3].trim(),
        ...(withParents ? { parentPid: Number(match[2]) } : {}),
      });
    }
    if (!result.size) throw new Error("Empty process inventory");
    return result;
  };
  const names = parse(namesText),
    commands = parse(commandsText);
  let complete = true;
  const processes: ProcessRecord[] = [];
  for (const [pid, first] of names) {
    if (ownedPids.includes(pid) || /(?:^|\/)ps$/.test(first.value)) continue;
    const second = commands.get(pid);
    if (first.state.startsWith("Z")) {
      if (second && !second.state.startsWith("Z")) complete = false;
      continue;
    }
    if (!second) {
      complete = false;
      continue;
    }
    if (second.state.startsWith("Z")) continue;
    if (withParents && first.parentPid !== second.parentPid) complete = false;
    processes.push({
      pid,
      name: first.value,
      commandLine: second.value,
      // macOS comm is OS-derived. Populate it before helper-role parsing because
      // ps renders executable paths containing spaces without shell quoting.
      ...(platform === "darwin" && path.posix.isAbsolute(first.value)
        ? { executablePath: first.value }
        : {}),
      ...(withParents ? { parentPid: second.parentPid } : {}),
    });
  }
  if (
    [...commands].some(
      ([pid, row]) =>
        !ownedPids.includes(pid) &&
        !names.has(pid) &&
        !row.state.startsWith("Z") &&
        !/^\/bin\/ps\s/.test(row.value),
    )
  )
    complete = false;
  return { platform, complete, processes };
}
/** Darwin -e has legacy environment-output semantics. -A is explicit all-process selection. */
export function posixInventoryArguments(
  platform: NodeJS.Platform,
  withParents: boolean,
  field: "comm" | "args",
): string[] {
  if (platform !== "linux" && platform !== "darwin")
    throw new Error("Unsupported process enumeration");
  const fields =
    (withParents ? "pid=,ppid=,stat=," : "pid=,stat=,") + field + "=";
  return platform === "darwin" ? ["-A", "-o", fields] : ["-eo", fields];
}
/** Failed, malformed or changing enumeration never becomes an empty clear result. */
export async function collectProcessSnapshot(
  ownedPids: readonly number[] = [process.pid],
  application?: OwnedApplication,
  signal?: AbortSignal,
): Promise<ProcessSnapshot> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        { ...limits, signal },
      );
      const parsed: unknown = JSON.parse(stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (
        !rows.length ||
        rows.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            typeof row.Name !== "string" ||
            !row.Name ||
            !Number.isSafeInteger(row.ProcessId),
        )
      )
        throw Error("Invalid process inventory");
      const snapshot: ProcessSnapshot = {
        platform,
        complete: true,
        processes: rows.map((row) => ({
          pid: row.ProcessId,
          parentPid: Number.isSafeInteger(row.ParentProcessId)
            ? row.ParentProcessId
            : undefined,
          executablePath:
            typeof row.ExecutablePath === "string"
              ? row.ExecutablePath
              : undefined,
          name: row.Name,
          ...(typeof row.CommandLine === "string" && row.CommandLine
            ? { commandLine: row.CommandLine }
            : {}),
        })),
      };
      return excludeOwnedApplicationProcesses(snapshot, ownedPids, application);
    }
    if (platform !== "linux" && platform !== "darwin")
      throw Error("Unsupported process enumeration");
    const withParents = !!application;
    const snapshot = parsePosixProcessSnapshot(
      (
        await run(
          "/bin/ps",
          posixInventoryArguments(platform, withParents, "comm"),
          { ...limits, signal },
        )
      ).stdout,
      (
        await run(
          "/bin/ps",
          posixInventoryArguments(platform, withParents, "args"),
          { ...limits, signal },
        )
      ).stdout,
      platform,
      application ? [] : ownedPids,
      withParents,
    );
    if (platform === "linux") {
      // MainThread is Node 24's observed Linux comm name. It is a candidate for
      // conservative inspection, never an ownership exception or clear result.
      const candidates = snapshot.processes.filter(
        (record) =>
          !!record.pid &&
          !ownedPids.includes(record.pid) &&
          (isGenericRuntimeCandidate(record) ||
            record.name === "MainThread" ||
            helperRole(record)),
      );
      const selected = candidates.slice(0, 64);
      const results = await collectLinuxArgumentObservations(
        selected.map((record) => ({
          pid: record.pid!,
          ...(record.parentPid !== undefined
            ? { expectedParentPid: record.parentPid }
            : {}),
          ...(record.executablePath
            ? { expectedExecutablePath: record.executablePath }
            : {}),
        })),
        signal,
      );
      for (let index = 0; index < candidates.length; index++) {
        const record = candidates[index];
        const observed = results[index];
        record.argumentObservation =
          observed?.pid === record.pid
            ? observed
            : {
                status: "unavailable",
                reason: index >= 64 ? "truncated" : "unavailable",
                pid: record.pid!,
              };
        if (record.argumentObservation.status === "verified")
          record.executablePath = record.argumentObservation.executablePath;
      }
      if (signal?.aborted) return { ...snapshot, complete: false };
    }
    if (application)
      return excludeOwnedApplicationProcesses(snapshot, ownedPids, application);
    return snapshot;
  } catch {
    return { platform, complete: false, processes: [] };
  }
}
/** Retry only incomplete observations, never a complete running/unknown result.
 * Allow up to eight fresh inventories within one shared OS-command deadline. */
export async function collectStableProcessSnapshot(
  collect: (signal: AbortSignal) => Promise<ProcessSnapshot>,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    retryDelayMs?: number;
  } = {},
): Promise<ProcessSnapshot> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const maxAttempts = 8;
  const budget = Math.max(1, Math.min(options.deadlineMs ?? 5500, 5500));
  const timer = setTimeout(cancel, budget);
  timer.unref();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let last: ProcessSnapshot = {
    platform: process.platform,
    complete: false,
    processes: [],
  };
  try {
    for (
      let attempt = 0;
      attempt < maxAttempts && !controller.signal.aborted;
      attempt++
    ) {
      try {
        last = await collect(controller.signal);
      } catch {
        last = { ...last, complete: false };
      }
      if (controller.signal.aborted) return { ...last, complete: false };
      if (last.complete) return last;
      if (attempt + 1 < maxAttempts)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(wait);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const wait = setTimeout(
            finish,
            Math.max(0, Math.min(options.retryDelayMs ?? 75, 75)),
          );
          controller.signal.addEventListener("abort", finish, { once: true });
          if (controller.signal.aborted) finish();
        });
    }
    return { ...last, complete: false };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
export async function checkProviderProcesses(
  provider: ProviderId,
  ownedPids?: readonly number[],
  application?: OwnedApplication,
): Promise<ProcessStatus> {
  const adapter = getAdapter(provider);
  const snapshot = await collectStableProcessSnapshot((signal) =>
    collectProcessSnapshot(ownedPids, application, signal),
  );
  if (!snapshot.complete)
    return {
      status: "unknown",
      details:
        "进程列表读取不完整或正在变化，已阻止操作；请等待程序启动/退出完成后重新检查。",
    };
  const result = adapter.assessProcesses(snapshot);
  if (result.status === "unknown") {
    const blockers = snapshot.processes
      .filter(
        (record) =>
          adapter.assessProcesses({
            platform: snapshot.platform,
            complete: true,
            processes: [record],
          }).status === "unknown",
      )
      .slice(0, 8)
      .map(
        (record) =>
          `${record.name.replaceAll("\\", "/").split("/").at(-1)}${record.pid ? " (PID " + record.pid + ")" : ""}`,
      );
    if (blockers.length)
      return {
        status: "unknown",
        details:
          result.details +
          " 无法归属：" +
          blockers.join("、") +
          "。请确认相关宿主及后台服务已退出后重试。",
      };
  }
  return result;
}
export async function checkCodexProcesses(): Promise<ProcessStatus> {
  return checkProviderProcesses("codex");
}
