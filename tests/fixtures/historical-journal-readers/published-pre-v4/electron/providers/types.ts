import type { CleanupUnitDefinition, UnitKind } from "../cleanup-units.js";
import type { Entry, ProcessStatus, ProviderId } from "../../shared/types.js";
import type { ArgumentResult } from "../process-argv-linux/types.js";

export interface ProviderDiscoveryInputs {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
}
export interface ProviderCandidate {
  provider: ProviderId;
  path: string;
  source: string;
  label: string;
}
export interface ProcessRecord {
  pid?: number;
  parentPid?: number;
  executablePath?: string;
  name: string;
  commandLine?: string;
  /** Main-process-only stable OS observation; never accepted from renderer input. */
  argumentObservation?: ArgumentResult;
}
export interface ProcessSnapshot {
  platform: NodeJS.Platform;
  processes: ProcessRecord[];
  /** False for failed, truncated, malformed or incomplete enumeration. */
  complete: boolean;
}
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  /** Honest, user-visible description of exactly what may be moved. */
  readonly scope: string;
  readonly supportsSessionCleanup?: boolean;
  /** Pure candidate generation only. Never reads the actual candidate. */
  discover(inputs: ProviderDiscoveryInputs): ProviderCandidate[];
  /** Metadata-only provider identity check. Reject wrong roots and symlinks. */
  validateRoot(root: string): Promise<void>;
  /** Recovery-only allowlist keyed by authenticated journal version; never authorizes new moves. */
  restoreFileAllowed?(relativePath: string, journalVersion: number): boolean;
  /** Paths are root-relative, slash-separated, validated before use. Default deny. */
  classify(
    relativePath: string,
    root?: string,
  ): Pick<Entry, "category" | "risk" | "reason">;
  /** Must be an explicit directory allowlist; unknown directories stay opaque. */
  canTraverse(relativeDirectory: string, root?: string): boolean;
  /** Metadata-only dynamic exclusions: exact files or slash-terminated directory prefixes. */
  protectedPaths?(root: string): Promise<string[]>;
  /** Explicit coherent cleanup units; absent hook means files only. */
  cleanupUnit?(
    relativePath: string,
    root: string,
  ): Promise<CleanupUnitDefinition | null>;
  unitEntryAllowed?(
    policy: string,
    relativePath: string,
    kind: UnitKind,
  ): boolean;
  unitLayoutAllowed?(
    definition: CleanupUnitDefinition,
    entries: ReadonlyArray<{ path: string; kind: UnitKind }>,
  ): boolean;
  /** Unknown or incomplete inspection must never return clear. */
  assessProcesses(snapshot: ProcessSnapshot): ProcessStatus;
}
