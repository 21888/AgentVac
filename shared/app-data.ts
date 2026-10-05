// JSON-only renderer contracts. This file must not import Node or Electron implementations.
export type DiagnosticRootKind = "codex-home" | "sqlite-home" | "log-dir";
export interface DiagnosticRoot {
  path: string;
  kind: DiagnosticRootKind;
}
export interface DiagnosticCandidate extends DiagnosticRoot {
  source:
    | "default"
    | "CODEX_HOME"
    | "CODEX_SQLITE_HOME"
    | "config.sqlite_home"
    | "config.log_dir";
}
export interface CandidateInputs {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}
export type DiagnosticFileKind =
  "sqlite" | "wal" | "shm" | "journal" | "ordinary-log";
export interface DiagnosticFile {
  path: string;
  root: string;
  kind: DiagnosticFileKind;
  bytes: number;
  allocatedBytes: number | null;
  mtimeMs: number;
}
export interface VolumeObservation {
  root: string;
  sampledAt: string;
  observational: true;
  availableBytes: number | null;
  totalBytes: number | null;
  reason?: "VOLUME_SAMPLE_UNAVAILABLE";
}
export type DiagnosticWarning =
  | "INVALID_ROOT"
  | "ROOT_UNAVAILABLE"
  | "UNSAFE_PATH"
  | "ENTRY_UNAVAILABLE"
  | "FILE_LIMIT_REACHED"
  | "CONFIG_UNAVAILABLE"
  | "CONFIG_TOO_LARGE"
  | "CONFIG_CHANGED"
  | "CONFIG_PATH_UNSUPPORTED"
  | "CONFIG_FORMAT_UNSUPPORTED";
export type DeepCheckReason =
  | "TIMEOUT"
  | "CANCELLED"
  | "WORKER_FAILED"
  | "WORKER_PROTOCOL_INVALID"
  | "PROCESS_ISOLATION_UNAVAILABLE"
  | "NOT_ENABLED"
  | "OUTSIDE_SELECTED_ROOTS"
  | "NOT_LOGS_DATABASE"
  | "UNSAFE_PATH"
  | "DATABASE_UNAVAILABLE"
  | "SIDECARS_PRESENT"
  | "SOURCE_CHANGED"
  | "NOT_SQLITE"
  | "UNKNOWN_SCHEMA"
  | "SQLITE_UNAVAILABLE"
  | "IMMUTABLE_OPEN_UNAVAILABLE"
  | "READ_FAILED";
export interface SqliteMetrics {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  freePageBytes: number;
  occupiedPageBytes: number;
  autoVacuum: "none" | "full" | "incremental";
  journalMode: "delete" | "truncate" | "persist" | "memory" | "wal" | "off";
}
export interface DeepCheckResult {
  status: "disabled" | "blocked" | "ok";
  reason?: DeepCheckReason;
  schema?: "codex-logs-v2";
  metrics?: SqliteMetrics;
  /** Stable observations do not prove another process cannot start writing later. */
  consistency?: "stable-file-observations";
  /** Identity/size/time/sidecar comparison only; never a full source-content hash. */
  sourceUnchanged?: boolean;
}
export interface StorageDiagnosticOptions {
  roots: DiagnosticRoot[];
  configOptIn?: boolean;
  deepCheck?: { enabled: boolean; databasePath: string };
}
export interface StorageDiagnostics {
  sampledAt: string;
  roots: DiagnosticRoot[];
  files: DiagnosticFile[];
  totals: Record<DiagnosticFileKind, number>;
  volumes: VolumeObservation[];
  configHints: DiagnosticCandidate[];
  warnings: DiagnosticWarning[];
  deepCheck: DeepCheckResult;
  /** No mutation, cleanup approval, or guaranteed reclaim estimate is represented here. */
  observational: true;
}

export type WorkspaceKind = "codex" | "sqlite" | "logs";
export type WorkspaceStatus =
  "available" | "missing" | "moved" | "unsafe" | "error";
export interface WorkspaceSelection {
  kind: WorkspaceKind;
  demo: boolean;
  name: string;
  path: string;
}
export interface WorkspaceDescription extends WorkspaceSelection {
  id: string;
  lastUsed: string;
  status: WorkspaceStatus;
  message: string;
}
export interface WorkspaceListing {
  entries: WorkspaceDescription[];
  issue?: string;
}

export interface RecoveryKeyIssue {
  code:
    | "prior-primary-missing"
    | "prior-primary-changed"
    | "primary-unavailable"
    | "keyring-unavailable"
    | "durability-warning";
  message: string;
}
/** JSON-safe. This is the only keyring state that may cross an IPC boundary. */
export interface RecoveryKeyringDescription {
  version: 1;
  primaryId: string | null;
  expectedPrimaryId: string | null;
  trustedKeyIds: string[];
  canSign: boolean;
  issues: RecoveryKeyIssue[];
}
export interface RecoveryImportResult {
  addedKeyIds: string[];
  duplicateKeyIds: string[];
  keyring: RecoveryKeyringDescription;
}
export interface RecoveryExportResult {
  path: string;
  version: 1;
  keyIds: string[];
}

export interface CandidateView extends DiagnosticCandidate {
  id: string;
  verified: false;
}
export interface DemoView {
  path: string;
  status: "absent" | "ready" | "preparing" | "blocked";
  canReset: boolean;
  message: string;
}
export interface AppDataView {
  workspaces: WorkspaceListing;
  recovery: RecoveryKeyringDescription;
  candidates: CandidateView[];
  demo: DemoView;
  issues: string[];
}
export interface DiagnoseRequest {
  requestId?: string;
  workspaceIds: string[];
  configOptIn: boolean;
  deepCheck?: {
    enabled: boolean;
    databasePath: string;
    confirmedClosed: boolean;
  };
}
export type AppDeepCheckResult = Omit<DeepCheckResult, "reason"> & {
  reason?:
    | DeepCheckResult["reason"]
    | "CLOSE_CONFIRMATION_REQUIRED"
    | "CODEX_RUNNING"
    | "PROCESS_UNKNOWN";
};
export interface AppDiagnosticsView extends Omit<
  StorageDiagnostics,
  "deepCheck"
> {
  deepCheck: AppDeepCheckResult;
  /** Databases and sidecars, including protected state databases; excludes logs. */
  sqliteTotalBytes: number;
  candidates: CandidateView[];
}
