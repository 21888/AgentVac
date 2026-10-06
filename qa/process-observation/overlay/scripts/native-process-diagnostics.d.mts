import type { ProcessInspectionObservation } from "../electron/process-observations.js";
import type { ProviderId } from "../shared/types.js";

export type NativeProcessObservation = ProcessInspectionObservation & {
  call: number;
  provider: ProviderId;
  operation:
    | "preview"
    | "quarantine"
    | "restore"
    | "prepare-trash"
    | "trash"
    | "diagnose-storage"
    | "scan"
    | "startup"
    | "other";
};
export type NativeProcessObservationRead = {
  version: 1;
  observations: NativeProcessObservation[];
  dropped: number;
  calls: number;
} & (
  | { available: true }
  | { available: false; reason: "unavailable" | "read-failed" | "invalid-data" }
);
export interface NativeProcessObservationSummary {
  version: 1;
  sessions: number;
  reads: number;
  availableReads: number;
  unavailableReads: number;
  failedReads: number;
  invalidReads: number;
  calls: number;
  dropped: number;
  observations: (NativeProcessObservation & { session: number })[];
}
export function nativeProcessObservation(
  application: Pick<import("playwright").ElectronApplication, "evaluate">,
): Promise<NativeProcessObservationRead>;
export function createNativeProcessObservationCollector(capacity?: number): {
  drain(
    application: Pick<import("playwright").ElectronApplication, "evaluate">,
  ): Promise<NativeProcessObservationRead & { session: number }>;
  snapshot(): NativeProcessObservationSummary;
};
