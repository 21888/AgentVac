import { spawn, type ChildProcess } from "node:child_process";
import {
  MAX_DIAGNOSTIC_OUTPUT,
  MAX_DIAGNOSTIC_REQUEST,
  HEARTBEAT_DEADLINE,
  parseDiagnosticResult,
  diagnosticEnvironment,
} from "./diagnostic-protocol.js";
import type { DeepCheckResult } from "./diagnostics.js";
// Fixed command line is supplied by the trusted main module, never renderer input.
// No SQLite, sync filesystem access or source parsing takes place in this supervisor.
const [workerFile, timeoutText, ...loaderArgs] = process.argv.slice(2);
const timeout = Number(timeoutText);
let worker: ChildProcess | undefined;
let input = "",
  output = "",
  started = false,
  finishing = false;
let lastHeartbeat = Date.now();
const startTime = Date.now();
let outcome: DeepCheckResult | undefined;
function finish(result: DeepCheckResult) {
  if (finishing) return;
  finishing = true;
  outcome = result;
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGKILL");
    // Supervisor is the POSIX group leader. Emergency fallback includes itself,
    // preventing an owned blocked descendant surviving an abnormal cleanup path.
    if (process.platform !== "win32")
      setTimeout(() => {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {
          process.exit(1);
        }
      }, 500).unref();
  } else emit();
}
function emit() {
  clearInterval(watchdog);
  process.stdin.destroy();
  process.stdout.end(
    JSON.stringify(outcome ?? { status: "blocked", reason: "WORKER_FAILED" }),
    () => process.exit(0),
  );
}
const watchdog = setInterval(() => {
  if (Date.now() - startTime >= timeout)
    finish({ status: "blocked", reason: "TIMEOUT" });
  else if (Date.now() - lastHeartbeat > HEARTBEAT_DEADLINE)
    finish({ status: "blocked", reason: "CANCELLED" });
}, 50);
// Worker has no descendants. ChildProcess.kill uses its owned process handle on
// Windows; no PID scan/taskkill and no arbitrary process-tree ownership guesses.
process.once("exit", () => {
  if (worker && worker.exitCode === null && worker.signalCode === null)
    worker.kill("SIGKILL");
});
process.on("uncaughtException", () =>
  finish({ status: "blocked", reason: "WORKER_FAILED" }),
);
process.on("unhandledRejection", () =>
  finish({ status: "blocked", reason: "WORKER_FAILED" }),
);
process.on("SIGTERM", () => finish({ status: "blocked", reason: "CANCELLED" }));
process.on("SIGINT", () => finish({ status: "blocked", reason: "CANCELLED" }));
process.stdout.on("error", () =>
  finish({ status: "blocked", reason: "CANCELLED" }),
);
process.stdin.on("error", () =>
  finish({ status: "blocked", reason: "CANCELLED" }),
);
process.stdin.on("end", () =>
  finish({ status: "blocked", reason: "CANCELLED" }),
);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (finishing) return;
  input += chunk;
  if (Buffer.byteLength(input) > MAX_DIAGNOSTIC_REQUEST)
    return finish({ status: "blocked", reason: "WORKER_PROTOCOL_INVALID" });
  let newline: number;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (started) {
      if (line === "ping") lastHeartbeat = Date.now();
      else return finish({ status: "blocked", reason: "CANCELLED" });
      continue;
    }
    started = true;
    if (
      !workerFile ||
      !Number.isFinite(timeout) ||
      timeout < 100 ||
      timeout > 30000
    )
      return finish({
        status: "blocked",
        reason: "PROCESS_ISOLATION_UNAVAILABLE",
      });
    worker = spawn(process.execPath, [...loaderArgs, workerFile], {
      stdio: ["pipe", "pipe", "ignore"],
      env: diagnosticEnvironment(),
      windowsHide: true,
    });
    worker.stdin!.on("error", () => {});
    worker.stdout!.on("data", (data: Buffer) => {
      if (finishing) return;
      if (Buffer.byteLength(output) + data.length > MAX_DIAGNOSTIC_OUTPUT)
        return finish({ status: "blocked", reason: "WORKER_PROTOCOL_INVALID" });
      output += data.toString("utf8");
    });
    worker.on("error", () =>
      finish({ status: "blocked", reason: "WORKER_FAILED" }),
    );
    worker.on("close", (code) => {
      if (finishing) return emit();
      finish(
        code === 0
          ? (parseDiagnosticResult(output) ?? {
              status: "blocked",
              reason: "WORKER_PROTOCOL_INVALID",
            })
          : { status: "blocked", reason: "WORKER_FAILED" },
      );
    });
    worker.stdin!.end(line);
  }
});
