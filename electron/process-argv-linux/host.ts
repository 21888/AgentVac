import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createObservationHost, type ShutdownStatus } from "./host-internal.js";
import { refusals, type ObservationRequest } from "./protocol.js";
import type { ArgumentResult } from "./types.js";
import { resolvePackagedWorker } from "./host-path.js";

function packagedWorker(): string {
  // The bundled host is in dist-electron/main.cjs. Source tests must build the
  // same fixed output; no caller-supplied path, PATH lookup or loader fallback.
  const bundled = typeof __dirname === "string";
  return resolvePackagedWorker(
    bundled ? __dirname : path.dirname(fileURLToPath(import.meta.url)),
    bundled,
  );
}
const host = createObservationHost({
  spawn() {
    return spawn(
      process.execPath,
      ["--max-old-space-size=64", packagedWorker()],
      {
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "1" },
      },
    );
  },
});
process.once("exit", () => host.killForExit());

export async function collectLinuxArgumentObservations(
  requests: readonly ObservationRequest[],
  signal?: AbortSignal,
): Promise<ArgumentResult[]> {
  if (process.platform !== "linux") return refusals(requests, "unsupported");
  return host.collect(requests, signal);
}
export function shutdownLinuxArgumentObservationWorkers(): Promise<ShutdownStatus> {
  return host.shutdown();
}
export type { ArgumentRequest, ArgumentResult } from "./types.js";
