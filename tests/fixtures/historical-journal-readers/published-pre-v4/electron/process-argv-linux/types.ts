/** Metadata only. Never log arguments, native command text, or native errors. */
export const ARGUMENT_LIMITS = Object.freeze({
  maxBytes: 65536,
  maxArguments: 512,
  maxExecutableBytes: 4096,
  maxRequests: 64,
  deadlineMs: 5000,
});
export interface ArgumentRequest {
  pid: number;
  expectedParentPid?: number;
  expectedExecutablePath?: string;
  expectedStartId?: string;
  signal?: AbortSignal;
}
export type ArgumentUnavailableReason =
  | "unsupported"
  | "invalid-request"
  | "permission"
  | "exited"
  | "changed"
  | "truncated"
  | "invalid-data"
  | "cancelled"
  | "timeout"
  | "unavailable";
export type ArgumentResult =
  | {
      status: "verified";
      platform: "linux" | "win32" | "darwin";
      source:
        "linux-proc" | "windows-native-command-line" | "darwin-kern-procargs2";
      pid: number;
      parentPid: number;
      startId: string;
      executablePath: string;
      argv: string[];
    }
  | { status: "unavailable"; reason: ArgumentUnavailableReason; pid: number };
export interface ArgumentCollector {
  collect(request: ArgumentRequest): Promise<ArgumentResult>;
  collectMany?(
    requests: readonly Omit<ArgumentRequest, "signal">[],
    signal?: AbortSignal,
  ): Promise<ArgumentResult[]>;
}
