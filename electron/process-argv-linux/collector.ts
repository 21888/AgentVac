/** Worker-only collector. Host must never import this module; no raw-ps fallback. */
import type {
  ArgumentCollector,
  ArgumentRequest,
  ArgumentResult,
} from "./types.js";
import { collectWithSource } from "./collector-core.js";
import { linuxProcSource } from "./proc.js";

export class LinuxArgumentCollector implements ArgumentCollector {
  async collect(request: ArgumentRequest): Promise<ArgumentResult> {
    if (process.platform !== "linux")
      return {
        status: "unavailable",
        reason: "unsupported",
        pid: request?.pid ?? 0,
      };
    return collectWithSource(request, linuxProcSource);
  }
}

export const linuxArgumentCollector: ArgumentCollector = Object.freeze(
  new LinuxArgumentCollector(),
);
