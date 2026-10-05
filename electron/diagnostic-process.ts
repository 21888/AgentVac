import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { DeepCheckResult, DiagnosticRuntime } from "./diagnostics.js";
import {
  DEFAULT_DIAGNOSTIC_TIMEOUT,
  HEARTBEAT_INTERVAL,
  MAX_DIAGNOSTIC_OUTPUT,
  MAX_DIAGNOSTIC_REQUEST,
  parseDiagnosticResult,
  diagnosticEnvironment,
  type DiagnosticRequest,
} from "./diagnostic-protocol.js";

interface HelperLaunch {
  supervisor: string;
  worker: string;
  loaderArgs: string[];
}
const active = new Set<{
  cancel: () => void;
  done: Promise<DeepCheckResult>;
}>();
function stopOwnedGroup(child: ChildProcess) {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}
// Normal exit cleans synchronously. SIGKILL/crash closes the supervisor's stdin;
// its independent heartbeat/EOF watchdog kills the blocked parser and exits.
process.once("exit", () => {
  for (const job of active) job.cancel();
});

function helpers(): HelperLaunch {
  const built = typeof __dirname === "string";
  const base = built ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const unpacked = base.replace(/\.asar([\\/])/g, ".asar.unpacked$1");
  if (built)
    return {
      supervisor: path.join(unpacked, "diagnostic-supervisor.cjs"),
      worker: path.join(unpacked, "diagnostic-worker.cjs"),
      loaderArgs: [],
    };
  // Source tests only: resolve our installed loader, never inherit execArgv,
  // NODE_OPTIONS, arbitrary caller executable paths, or secret-heavy env.
  // libuv may supply its own required Windows OS bootstrap variables.
  const require = createRequire(path.join(base, "package.json"));
  return {
    supervisor: path.join(base, "diagnostic-supervisor.ts"),
    worker: path.join(base, "diagnostic-worker.ts"),
    loaderArgs: ["--import", pathToLoader(require.resolve("tsx/esm"))],
  };
}
function pathToLoader(p: string) {
  return pathToFileURL(p).href;
}
export function runDiagnosticProcess(
  request: DiagnosticRequest,
  runtime: DiagnosticRuntime = {},
): Promise<DeepCheckResult> {
  try {
    return runDiagnosticTransport(request, runtime, helpers());
  } catch {
    return Promise.resolve({
      status: "blocked",
      reason: "PROCESS_ISOLATION_UNAVAILABLE",
    });
  }
}

/** Internal trusted transport seam for synthetic process-lifetime tests only.
 * Never expose HelperLaunch, PIDs, or this function through a renderer bridge. */
export function runDiagnosticTransport(
  request: DiagnosticRequest,
  runtime: DiagnosticRuntime,
  launch: HelperLaunch,
  onSupervisor?: (pid: number) => void,
): Promise<DeepCheckResult> {
  if (runtime.signal?.aborted)
    return Promise.resolve({ status: "blocked", reason: "CANCELLED" });
  const timeout = Number.isFinite(runtime.timeoutMs)
    ? Math.max(100, Math.min(30000, Math.trunc(runtime.timeoutMs!)))
    : DEFAULT_DIAGNOSTIC_TIMEOUT;
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) + 1 > MAX_DIAGNOSTIC_REQUEST)
    return Promise.resolve({
      status: "blocked",
      reason: "WORKER_PROTOCOL_INVALID",
    });
  // Windows non-detached uv_spawn normally joins libuv's kill-on-job-close job.
  // EOF/heartbeat remains necessary: nested/restricted jobs may deny assignment.
  // This protocol covers parent exit/crash and blocked SQLite, not simultaneous
  // external force-kill of both guardian and parent on every Windows host.
  const child = spawn(
    process.execPath,
    [
      ...launch.loaderArgs,
      launch.supervisor,
      launch.worker,
      String(timeout),
      ...launch.loaderArgs,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      env: diagnosticEnvironment(),
      windowsHide: true,
    },
  );
  let output = "",
    settled = false,
    forced: DeepCheckResult | undefined;
  let complete!: (r: DeepCheckResult) => void;
  const done = new Promise<DeepCheckResult>((resolve) => {
    complete = resolve;
  });
  let cleanupFallback: NodeJS.Timeout | undefined;
  const cancelWith = (
    reason: "CANCELLED" | "TIMEOUT" | "WORKER_PROTOCOL_INVALID",
  ) => {
    if (forced) return;
    forced = { status: "blocked", reason };
    // Keep supervisor alive until it confirms its exact owned child has exited.
    // EOF also works when the parent is abruptly killed and cannot run JS.
    if (!child.stdin?.destroyed) child.stdin?.end("cancel\n");
    if (process.platform !== "win32")
      cleanupFallback = setTimeout(() => stopOwnedGroup(child), 750);
  };
  const cancel = () => cancelWith("CANCELLED");
  const job = { cancel, done };
  active.add(job);
  const heartbeat = setInterval(() => {
    if (!forced && !child.stdin?.destroyed) child.stdin?.write("ping\n");
  }, HEARTBEAT_INTERVAL);
  const timer = setTimeout(() => cancelWith("TIMEOUT"), timeout);
  const finish = (result: DeepCheckResult) => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeat);
    clearTimeout(timer);
    if (cleanupFallback) clearTimeout(cleanupFallback);
    runtime.signal?.removeEventListener("abort", cancel);
    active.delete(job);
    complete(forced ?? result);
  };
  runtime.signal?.addEventListener("abort", cancel, { once: true });
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > MAX_DIAGNOSTIC_OUTPUT)
      return cancelWith("WORKER_PROTOCOL_INVALID");
    output += chunk.toString("utf8");
  });
  child.on("error", () =>
    finish({ status: "blocked", reason: "WORKER_FAILED" }),
  );
  child.on("close", (code) => {
    if (code !== 0) stopOwnedGroup(child);
    finish(
      code === 0
        ? (parseDiagnosticResult(output) ?? {
            status: "blocked",
            reason: "WORKER_PROTOCOL_INVALID",
          })
        : { status: "blocked", reason: "WORKER_FAILED" },
    );
  });
  child.on("spawn", () => {
    if (child.pid) onSupervisor?.(child.pid);
  });
  child.stdin!.write(serialized + "\n");
  if (runtime.signal?.aborted) cancel();
  return done;
}

/** Resolves after owned supervisor groups have been terminated and pipes close. */
export async function shutdownDiagnosticWorkers(): Promise<void> {
  const jobs = [...active];
  for (const job of jobs) job.cancel();
  await Promise.all(jobs.map((job) => job.done));
}
