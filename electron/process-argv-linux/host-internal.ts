/** Internal process transport test seam. Never expose launch options to IPC/renderer. */
import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";
import {
  HOST_LIMITS,
  normalizeRequests,
  refusals,
  ResultFrames,
  type ObservationRequest,
} from "./protocol.js";
import type { ArgumentResult, ArgumentUnavailableReason } from "./types.js";

interface Launch {
  spawn(): ChildProcess;
  deadlineMs?: number;
}
interface OwnedJob {
  cancel(): void;
  killForExit(): void;
  closed: Promise<void>;
}
export interface ShutdownStatus {
  closed: number;
  pending: number;
}

export function createObservationHost(launch: Launch) {
  const active = new Set<OwnedJob>();
  let shuttingDown = false;
  async function collect(
    input: readonly ObservationRequest[],
    signal?: AbortSignal,
  ): Promise<ArgumentResult[]> {
    let requests: ObservationRequest[] | null;
    try {
      requests = normalizeRequests(input);
    } catch {
      requests = null;
    }
    if (!requests || (signal !== undefined && !(signal instanceof AbortSignal)))
      return refusals(input, "invalid-request");
    if (shuttingDown) return refusals(requests, "unavailable");
    if (!requests.length) return [];
    if (signal?.aborted) return refusals(requests, "cancelled");
    if (active.size >= HOST_LIMITS.children)
      return refusals(requests, "unavailable");
    const encoded = Buffer.from(JSON.stringify({ v: 1, requests }) + "\n");
    if (encoded.length > HOST_LIMITS.requestBytes) {
      encoded.fill(0);
      return refusals(requests, "invalid-request");
    }
    const start = performance.now();
    const deadline = Math.min(
      HOST_LIMITS.deadlineMs,
      Math.max(1, launch.deadlineMs ?? HOST_LIMITS.deadlineMs),
    );
    let child: ChildProcess;
    try {
      child = launch.spawn();
    } catch {
      encoded.fill(0);
      return refusals(requests, "unavailable");
    }
    const frames = new ResultFrames(requests);
    let settled = false,
      closed = false,
      killed = false;
    let resolve!: (result: ArgumentResult[]) => void;
    let closeResolve!: () => void;
    const response = new Promise<ArgumentResult[]>((done) => {
      resolve = done;
    });
    const closedPromise = new Promise<void>((done) => {
      closeResolve = done;
    });
    const stopOwned = (retryAtExit = false) => {
      if (closed || (killed && !retryAtExit)) return;
      killed = true;
      // ChildProcess.kill targets the retained owned handle. Never signal a PID from a result.
      try {
        child.kill("SIGKILL");
      } catch {
        /* Ownership remains until close even if kill fails. */
      }
      try {
        child.stdin?.end();
      } catch {
        /* No native errors leave the host. */
      }
    };
    const finish = (result: ArgumentResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", cancel);
      frames.clear();
      encoded.fill(0);
      resolve(result);
    };
    const refuse = (reason: ArgumentUnavailableReason) => {
      finish(refusals(requests, reason));
      stopOwned();
    };
    const cancel = () => refuse("cancelled");
    const job: OwnedJob = {
      cancel,
      killForExit: () => stopOwned(true),
      closed: closedPromise,
    };
    active.add(job);
    const timer = setTimeout(
      () => refuse("timeout"),
      Math.max(1, deadline - (performance.now() - start)),
    );
    const heartbeat = setInterval(() => {
      if (!settled && !child.stdin?.destroyed) {
        try {
          child.stdin?.write("ping\n");
        } catch {
          refuse("unavailable");
        }
      }
    }, 500);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdin?.on("error", () => refuse("unavailable"));
    child.stdout?.on("error", () => refuse("unavailable"));
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        if (settled) return;
        if (performance.now() - start >= deadline) return refuse("timeout");
        if (!frames.push(chunk)) refuse("invalid-data");
      } finally {
        // Incoming pipe chunks are transient argument data too, including late
        // output arriving after the caller has already received a refusal.
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    });
    child.on("error", () => refuse("unavailable"));
    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      active.delete(job);
      closeResolve();
      if (!settled) {
        const result = code === 0 ? frames.finish() : null;
        if (performance.now() - start >= deadline)
          finish(refusals(requests, "timeout"));
        else finish(result ?? refusals(requests, "unavailable"));
      }
      // exit and kill acceptance are not used to reclaim admission; only close is.
      frames.clear();
      encoded.fill(0);
    });
    if (!child.stdin || !child.stdout) refuse("unavailable");
    else {
      try {
        child.stdin.write(encoded, () => encoded.fill(0));
      } catch {
        refuse("unavailable");
      }
    }
    if (signal?.aborted) cancel();
    if (performance.now() - start >= deadline) refuse("timeout");
    return response;
  }
  return {
    collect,
    killForExit() {
      shuttingDown = true;
      for (const job of active) job.killForExit();
    },
    async shutdown(): Promise<ShutdownStatus> {
      // Terminal admission latch precedes the snapshot, so no concurrent or
      // later request can create an unaccounted worker while shutdown drains.
      shuttingDown = true;
      const jobs = [...active];
      for (const job of jobs) job.cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(jobs.map((job) => job.closed)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, HOST_LIMITS.shutdownMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const pending = jobs.filter((job) => active.has(job)).length;
      return { closed: jobs.length - pending, pending };
    },
    /** Metadata-only internal assertion seam. */
    activeCount() {
      return active.size;
    },
  };
}
