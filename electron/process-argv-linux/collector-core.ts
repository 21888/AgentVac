/** Development-only implementation details. Do not expose test sources in an app API. */
import { performance } from "node:perf_hooks";
import {
  ARGUMENT_LIMITS,
  type ArgumentRequest,
  type ArgumentResult,
  type ArgumentUnavailableReason,
} from "./types.js";

export class Refusal extends Error {
  constructor(readonly reason: ArgumentUnavailableReason) {
    super(reason);
  }
}

export interface Identity {
  pid: number;
  parentPid: number;
  startId: string;
  executablePath: string;
  /** Kernel metadata only, not memory contents. Never returned to a caller. */
  mmIdentity: string;
  argumentBytes: number;
}

export interface ProcSession {
  identity(): Promise<Identity>;
  arguments(length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ProcSource {
  open(pid: number, budget: ReadBudget): Promise<ProcSession>;
}

/** A deadline for results and scheduling. Node cannot cancel a running fs syscall. */
export class ReadBudget {
  private reason: "cancelled" | "timeout" | undefined;
  private timer: ReturnType<typeof setTimeout>;
  private readonly end: number;
  readonly stopped: Promise<never>;
  private reject!: (error: Refusal) => void;
  private readonly onAbort = () => this.stop("cancelled");

  constructor(
    private readonly signal: AbortSignal | undefined,
    milliseconds: number,
  ) {
    this.end = performance.now() + milliseconds;
    this.stopped = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    // A pre-aborted signal is handled without an unobserved rejection.
    void this.stopped.catch(() => {});
    this.timer = setTimeout(() => this.stop("timeout"), milliseconds);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.stop("cancelled");
  }

  private stop(reason: "cancelled" | "timeout") {
    if (!this.reason) {
      this.reason = reason;
      this.reject(new Refusal(reason));
    }
  }

  check() {
    if (!this.reason && this.signal?.aborted) this.stop("cancelled");
    if (!this.reason && performance.now() >= this.end) this.stop("timeout");
    if (this.reason) throw new Refusal(this.reason);
  }

  dispose() {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const uint64 = /^(?:0|[1-9][0-9]{0,19})$/u;
const UINT64_MAX = 18446744073709551615n;

export function validUnsigned64(value: string): boolean {
  return uint64.test(value) && BigInt(value) <= UINT64_MAX;
}

export function decodeText(bytes: Uint8Array): string {
  let value: string;
  try {
    // ignoreBOM=true preserves U+FEFF instead of silently stripping argument bytes.
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Refusal("invalid-data");
  }
  if (controls.test(value)) throw new Refusal("invalid-data");
  return value;
}

export function decodeArguments(bytes: Buffer): string[] {
  if (bytes.byteLength > ARGUMENT_LIMITS.maxBytes)
    throw new Refusal("truncated");
  if (bytes.byteLength === 0) throw new Refusal("unavailable");
  if (bytes[bytes.length - 1] !== 0) throw new Refusal("truncated");
  const argv: string[] = [];
  let beginning = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (argv.length === ARGUMENT_LIMITS.maxArguments)
      throw new Refusal("truncated");
    argv.push(decodeText(bytes.subarray(beginning, i)));
    beginning = i + 1;
  }
  return argv;
}

function isPid(value: unknown, allowZero = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= 2147483647
  );
}

function validPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    controls.test(value)
  )
    return false;
  if (Buffer.byteLength(value, "utf8") > ARGUMENT_LIMITS.maxExecutableBytes)
    return false;
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

/** Copy at the boundary so caller mutation during awaits cannot change expectations. */
function snapshotRequest(value: ArgumentRequest): ArgumentRequest {
  if (!value || typeof value !== "object") throw new Refusal("invalid-request");
  const {
    pid,
    expectedParentPid,
    expectedExecutablePath,
    expectedStartId,
    signal,
  } = value;
  if (
    !isPid(pid) ||
    (expectedParentPid !== undefined && !isPid(expectedParentPid, true)) ||
    (expectedExecutablePath !== undefined &&
      !validPath(expectedExecutablePath)) ||
    (expectedStartId !== undefined &&
      (typeof expectedStartId !== "string" ||
        !validUnsigned64(expectedStartId))) ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  )
    throw new Refusal("invalid-request");
  return {
    pid,
    expectedParentPid,
    expectedExecutablePath,
    expectedStartId,
    signal,
  };
}

export function sameIdentity(left: Identity, right: Identity): boolean {
  return (
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.startId === right.startId &&
    left.executablePath === right.executablePath &&
    left.mmIdentity === right.mmIdentity &&
    left.argumentBytes === right.argumentBytes
  );
}

function matchesRequest(identity: Identity, request: ArgumentRequest) {
  if (
    identity.pid !== request.pid ||
    (request.expectedParentPid !== undefined &&
      identity.parentPid !== request.expectedParentPid) ||
    (request.expectedStartId !== undefined &&
      identity.startId !== request.expectedStartId) ||
    (request.expectedExecutablePath !== undefined &&
      identity.executablePath !== request.expectedExecutablePath)
  ) {
    throw new Refusal("changed");
  }
}

export function safeReason(error: unknown): ArgumentUnavailableReason {
  if (error instanceof Refusal) return error.reason;
  // Native messages, stacks and paths must never leave this module.
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOENT" || code === "ESRCH") return "exited";
  if (code === "ELOOP" || code === "ENOTDIR") return "invalid-data";
  if (code === "EINTR") return "unavailable";
  return "unavailable";
}

/** Internal injection seam: production entry point always supplies the fixed /proc source. */
export async function collectWithSource(
  input: ArgumentRequest,
  source: ProcSource,
  milliseconds: number = ARGUMENT_LIMITS.deadlineMs,
): Promise<ArgumentResult> {
  let request: ArgumentRequest;
  // Preserve a valid numeric PID, but do not stringify untrusted objects or errors.
  let resultPid = 0;
  try {
    if (
      input &&
      typeof input.pid === "number" &&
      Number.isSafeInteger(input.pid)
    )
      resultPid = input.pid;
    request = snapshotRequest(input);
  } catch {
    return { status: "unavailable", reason: "invalid-request", pid: resultPid };
  }
  const budget = new ReadBudget(request.signal, milliseconds);
  const work = (async (): Promise<ArgumentResult> => {
    let session: ProcSession | undefined;
    let first: Buffer | undefined;
    let second: Buffer | undefined;
    try {
      budget.check();
      session = await source.open(request.pid, budget);
      budget.check();
      const before = await session.identity();
      budget.check();
      matchesRequest(before, request);
      if (!Number.isInteger(before.argumentBytes) || before.argumentBytes <= 0)
        throw new Refusal("invalid-data");
      if (before.argumentBytes > ARGUMENT_LIMITS.maxBytes)
        throw new Refusal("truncated");
      first = await session.arguments(before.argumentBytes);
      budget.check();
      if (first.length !== before.argumentBytes) throw new Refusal("truncated");
      const middle = await session.identity();
      budget.check();
      if (!sameIdentity(before, middle)) throw new Refusal("changed");
      second = await session.arguments(before.argumentBytes);
      budget.check();
      if (second.length !== before.argumentBytes)
        throw new Refusal("truncated");
      const after = await session.identity();
      budget.check();
      if (!sameIdentity(before, after) || !first.equals(second))
        throw new Refusal("changed");
      const argv = decodeArguments(first);
      budget.check();
      return {
        status: "verified",
        platform: "linux",
        source: "linux-proc",
        pid: before.pid,
        parentPid: before.parentPid,
        startId: before.startId,
        executablePath: before.executablePath,
        argv,
      };
    } finally {
      first?.fill(0);
      second?.fill(0);
      await session?.close();
    }
  })();
  try {
    const result = await Promise.race([work, budget.stopped]);
    budget.check();
    return result;
  } catch (error) {
    return {
      status: "unavailable",
      reason: safeReason(error),
      pid: request.pid,
    };
  } finally {
    budget.dispose();
    // work retains ownership of buffers and handles until its one in-flight syscall settles.
    void work.catch(() => {});
  }
}
