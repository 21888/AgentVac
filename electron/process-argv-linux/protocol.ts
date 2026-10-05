/** Bounded, reconstructive wire validation. No filesystem dependencies. */
import {
  ARGUMENT_LIMITS,
  type ArgumentRequest,
  type ArgumentResult,
  type ArgumentUnavailableReason,
} from "./types.js";
import { decodeStrictJson } from "./strict-json.js";

export type ObservationRequest = Omit<ArgumentRequest, "signal">;
export const HOST_LIMITS = Object.freeze({
  children: 2,
  deadlineMs: 5000,
  shutdownMs: 500,
  requestBytes: 640 * 1024,
  frameBytes: 144 * 1024,
  responseBytes: 64 * 144 * 1024 + 1024,
});
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const reasons = new Set<ArgumentUnavailableReason>([
  "unsupported",
  "invalid-request",
  "permission",
  "exited",
  "changed",
  "truncated",
  "invalid-data",
  "cancelled",
  "timeout",
  "unavailable",
]);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));
export const pidNumber = (v: unknown, zero = false): v is number =>
  typeof v === "number" &&
  Number.isSafeInteger(v) &&
  v >= (zero ? 0 : 1) &&
  v <= 2147483647;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length <= max &&
  !controls.test(v) &&
  Buffer.byteLength(v, "utf8") <= max &&
  Buffer.from(v, "utf8").toString("utf8") === v;
const path = (v: unknown): v is string =>
  text(v, ARGUMENT_LIMITS.maxExecutableBytes) &&
  v.startsWith("/") &&
  !v.endsWith(" (deleted)");
const start = (v: unknown): v is string =>
  typeof v === "string" &&
  /^(?:0|[1-9][0-9]{0,19})$/u.test(v) &&
  BigInt(v) <= 18446744073709551615n;

export function normalizeRequest(value: unknown): ObservationRequest | null {
  if (
    !object(value) ||
    !keys(value, [
      "pid",
      "expectedParentPid",
      "expectedExecutablePath",
      "expectedStartId",
    ]) ||
    !pidNumber(value.pid) ||
    (value.expectedParentPid !== undefined &&
      !pidNumber(value.expectedParentPid, true)) ||
    (value.expectedExecutablePath !== undefined &&
      !path(value.expectedExecutablePath)) ||
    (value.expectedStartId !== undefined && !start(value.expectedStartId))
  )
    return null;
  return {
    pid: value.pid,
    ...(value.expectedParentPid !== undefined
      ? { expectedParentPid: value.expectedParentPid as number }
      : {}),
    ...(value.expectedExecutablePath !== undefined
      ? { expectedExecutablePath: value.expectedExecutablePath as string }
      : {}),
    ...(value.expectedStartId !== undefined
      ? { expectedStartId: value.expectedStartId as string }
      : {}),
  };
}

export function normalizeRequests(value: unknown): ObservationRequest[] | null {
  if (!Array.isArray(value) || value.length > ARGUMENT_LIMITS.maxRequests)
    return null;
  const result: ObservationRequest[] = [];
  for (let i = 0; i < value.length; i++) {
    const request = normalizeRequest(value[i]);
    if (!request) return null;
    result.push(request);
  }
  return result;
}

export function refusals(
  value: unknown,
  reason: ArgumentUnavailableReason,
): ArgumentResult[] {
  if (!Array.isArray(value) || value.length > ARGUMENT_LIMITS.maxRequests)
    return [];
  const result: ArgumentResult[] = [];
  for (let i = 0; i < value.length; i++) {
    let pid = 0;
    try {
      if (object(value[i]) && pidNumber(value[i].pid)) pid = value[i].pid;
    } catch {
      /* Do not expose caller exceptions. */
    }
    result.push({ status: "unavailable", reason, pid });
  }
  return result;
}

export function validateResult(
  value: unknown,
  request: ObservationRequest,
): ArgumentResult | null {
  if (!object(value) || value.pid !== request.pid) return null;
  if (value.status === "unavailable") {
    if (
      !keys(value, ["status", "reason", "pid"]) ||
      typeof value.reason !== "string" ||
      !reasons.has(value.reason as ArgumentUnavailableReason)
    )
      return null;
    return {
      status: "unavailable",
      reason: value.reason as ArgumentUnavailableReason,
      pid: request.pid,
    };
  }
  if (
    !keys(value, [
      "status",
      "platform",
      "source",
      "pid",
      "parentPid",
      "startId",
      "executablePath",
      "argv",
    ]) ||
    value.status !== "verified" ||
    value.platform !== "linux" ||
    value.source !== "linux-proc" ||
    !pidNumber(value.parentPid, true) ||
    !start(value.startId) ||
    !path(value.executablePath) ||
    !Array.isArray(value.argv) ||
    value.argv.length < 1 ||
    value.argv.length > ARGUMENT_LIMITS.maxArguments ||
    (request.expectedParentPid !== undefined &&
      value.parentPid !== request.expectedParentPid) ||
    (request.expectedStartId !== undefined &&
      value.startId !== request.expectedStartId) ||
    (request.expectedExecutablePath !== undefined &&
      value.executablePath !== request.expectedExecutablePath)
  )
    return null;
  const argv: string[] = [];
  let bytes = 0;
  for (const argument of value.argv) {
    if (!text(argument, ARGUMENT_LIMITS.maxBytes)) return null;
    bytes += Buffer.byteLength(argument, "utf8") + 1;
    if (bytes > ARGUMENT_LIMITS.maxBytes) return null;
    argv.push(argument);
  }
  return {
    status: "verified",
    platform: "linux",
    source: "linux-proc",
    pid: request.pid,
    parentPid: value.parentPid,
    startId: value.startId,
    executablePath: value.executablePath,
    argv,
  };
}

export function parseRequestFrame(bytes: Buffer): ObservationRequest[] | null {
  try {
    if (bytes.length > HOST_LIMITS.requestBytes) return null;
    const value = decodeStrictJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!object(value) || !keys(value, ["v", "requests"]) || value.v !== 1)
      return null;
    return normalizeRequests(value.requests);
  } catch {
    return null;
  }
}

/** Retains one fixed-size frame, never an unbounded string or chunk array. */
export class ResultFrames {
  private readonly frame = Buffer.alloc(HOST_LIMITS.frameBytes);
  private used = 0;
  private total = 0;
  private lastIndex = -1;
  private done = false;
  private invalid = false;
  private results: ArgumentResult[];
  constructor(private readonly requests: readonly ObservationRequest[]) {
    this.results = refusals(requests, "unavailable");
  }
  push(chunk: Buffer): boolean {
    if (
      this.invalid ||
      !Buffer.isBuffer(chunk) ||
      this.total + chunk.length > HOST_LIMITS.responseBytes
    )
      return this.fail();
    this.total += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (this.done || this.used + length > this.frame.length)
        return this.fail();
      chunk.copy(this.frame, this.used, offset, end);
      this.used += length;
      if (newline >= 0) {
        if (!this.consume()) return this.fail();
        this.frame.fill(0, 0, this.used);
        this.used = 0;
      }
      offset = newline < 0 ? chunk.length : newline + 1;
    }
    return true;
  }
  private consume(): boolean {
    try {
      const value = decodeStrictJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          this.frame.subarray(0, this.used),
        ),
      );
      if (!object(value) || value.v !== 1) return false;
      if (value.done === true && keys(value, ["v", "done"])) {
        this.done = true;
        return true;
      }
      if (
        !keys(value, ["v", "index", "result"]) ||
        typeof value.index !== "number" ||
        !Number.isInteger(value.index) ||
        value.index <= this.lastIndex ||
        value.index >= this.requests.length
      )
        return false;
      const result = validateResult(value.result, this.requests[value.index]);
      if (!result) return false;
      this.lastIndex = value.index;
      this.results[value.index] = result;
      return true;
    } catch {
      return false;
    }
  }
  private fail(): false {
    this.invalid = true;
    this.frame.fill(0);
    this.results = [];
    return false;
  }
  finish(): ArgumentResult[] | null {
    return !this.invalid && this.done && this.used === 0 ? this.results : null;
  }
  clear() {
    this.frame.fill(0);
    this.results = [];
    this.used = 0;
  }
}
