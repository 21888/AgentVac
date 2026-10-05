import type {
  ProcessSnapshot,
  ProviderAdapter,
} from "../electron/providers/types.js";
export interface ProcessDiagnosticSummary {
  complete: boolean;
  total: number;
  blockers: {
    name: string;
    status: string;
    pid: number | null;
    hasCommand: boolean;
    inlineRuntime: boolean;
    argumentObservation: string;
    argumentRefusal: string | null;
    observedClassification: string;
  }[];
}
export function summarizeProcessBlockers(
  snapshot: ProcessSnapshot,
  adapter: ProviderAdapter,
): ProcessDiagnosticSummary;
export function nativeProcessObservation(
  application: import("playwright").ElectronApplication,
  provider: import("../shared/types.js").ProviderId,
): Promise<ProcessDiagnosticSummary & { provider: string; status: string }>;
