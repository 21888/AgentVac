import type { ConversationAPI } from "./conversations.js";
export type * from "./conversations.js";
export type ProviderId = "codex" | "claude-code" | "cline" | "cursor";
import type {
  AppDataView,
  AppDiagnosticsView,
  DiagnoseRequest,
  RecoveryImportResult,
  RecoveryExportResult,
} from "./app-data.js";
export type * from "./app-data.js";
export type ThemeMode = "system" | "light" | "dark";
export interface Preferences {
  theme: ThemeMode;
}
export type Risk = "safe" | "review" | "protected";
export interface AppContext {
  provider: ProviderId;
  root: string | null;
  demo: boolean;
  platform: string;
}
export interface CleanupUnitSummary {
  kind: "directory" | "bundle";
  members: string[];
  fileCount: number;
  directoryCount: number;
}
export interface Entry {
  cleanupUnit?: CleanupUnitSummary;
  id: string;
  path: string;
  category: "log" | "cache" | "session" | "protected";
  risk: Risk;
  size: number;
  mtimeMs: number;
  ageDays: number;
  reason: string;
  selectable: boolean;
  kind: "file" | "directory" | "symlink" | "other";
}
export interface ScanOptions {
  minAgeDays: number;
  includeSessions: boolean;
  maxEntries?: 50000 | 100000;
  requestId?: string;
}
export interface ScanCoverage {
  visitedEntries: number;
  returnedEntries: number;
  protectedDirectories: number;
  inaccessibleEntries: number;
  depthLimitedDirectories: number;
  maxEntries: number;
  limitReason: "entry-count" | "result-bytes" | null;
  resultBytes: number;
}
export interface ScanProgress {
  provider: ProviderId;
  requestId: string;
  root: string;
  phase: "scanning" | "complete" | "partial" | "cancelled" | "error";
  visitedEntries: number;
  discoveredFiles: number;
  discoveredBytes: number;
  elapsedMs: number;
  maxEntries: number;
  currentPath?: string;
}
export interface ScanResult extends ScanOptions {
  provider: ProviderId;
  id: string;
  root: string;
  demo: boolean;
  scannedAt: string;
  entries: Entry[];
  warnings: string[];
  status: "complete" | "partial";
  coverage: ScanCoverage;
  summary: {
    totalBytes: number;
    safeBytes: number;
    reviewBytes: number;
    protectedBytes: number;
    files: number;
    eligibleFiles: number;
  };
}
export interface ProcessStatus {
  status: "clear" | "running" | "unknown";
  details: string;
}
export interface Preview {
  totalFiles?: number;
  totalDirectories?: number;
  provider: ProviderId;
  root: string;
  token: string;
  items: Entry[];
  totalBytes: number;
  expiresAt: string;
  processStatus: ProcessStatus;
  scanStatus: "complete" | "partial";
}
export interface OperationResult {
  batchId: string;
  completed: number;
  failed: { path: string; error: string }[];
  bytes: number;
}
export interface Batch {
  provider: ProviderId;
  id: string;
  createdAt: string;
  root: string;
  items: {
    cleanupUnit?: CleanupUnitSummary;
    id: string;
    path: string;
    size: number;
    status: "pending" | "quarantined" | "restored" | "failed" | "trashed";
    error?: string;
  }[];
}
export interface RecoveryInspection {
  provider: ProviderId;
  root: string;
  readOnly: true;
  truncated: boolean;
  inspectedFiles: number;
  storedBytes: number;
  batches: {
    id: string;
    verified: boolean;
    explanation: string;
    declaredKeyId?: string;
    originalRootHint?: string;
    storedFiles: number;
    storedBytes: number;
    irregularEntries: number;
  }[];
}
/** Ephemeral, single-attempt consent challenge; never a filesystem authority. */
export interface TrashConfirmation {
  token: string;
  batchId: string;
  provider: ProviderId;
  root: string;
  demo: boolean;
  expiresAt: number;
}
export interface AgentVacAPI extends ConversationAPI {
  getContext(): Promise<AppContext>;
  setProvider(provider: ProviderId): Promise<AppContext>;
  getAppData(): Promise<AppDataView>;
  activateWorkspace(id: string): Promise<AppContext>;
  activateCandidate(id: string): Promise<AppContext>;
  forgetWorkspace(id: string): Promise<AppDataView>;
  chooseDiagnosticRoot(kind: "sqlite" | "logs"): Promise<AppDataView | null>;
  diagnoseStorage(request: DiagnoseRequest): Promise<AppDiagnosticsView>;
  cancelDiagnosis(requestId?: string): Promise<void>;
  importRecoveryKeys(
    confirmed: boolean,
  ): Promise<{ canceled: boolean; result?: RecoveryImportResult }>;
  exportRecoveryKeys(
    confirmed: boolean,
  ): Promise<{ canceled: boolean; result?: RecoveryExportResult }>;
  inspectRecovery(): Promise<RecoveryInspection>;
  resetDemo(confirmed: boolean): Promise<AppContext>;
  openSystemTrash(): Promise<void>;
  getPreferences(): Promise<Preferences>;
  setTheme(theme: ThemeMode): Promise<Preferences>;
  copyRootPath(): Promise<void>;
  chooseRoot(): Promise<AppContext | null>;
  loadDemo(): Promise<AppContext>;
  scan(options: ScanOptions): Promise<ScanResult>;
  onScanProgress(listener: (progress: ScanProgress) => void): () => void;
  cancelScan(requestId?: string): Promise<void>;
  preview(ids: string[]): Promise<Preview>;
  quarantine(token: string, confirmedClosed: boolean): Promise<OperationResult>;
  history(): Promise<Batch[]>;
  restore(batchId: string, confirmedClosed: boolean): Promise<OperationResult>;
  prepareTrash(batchId: string): Promise<TrashConfirmation>;
  cancelTrashConfirmation(token: string): Promise<void>;
  trash(
    batchId: string,
    confirmed: boolean,
    confirmedClosed: boolean,
    confirmationToken: string,
  ): Promise<OperationResult>;
  openQuarantine(): Promise<void>;
  openBatchQuarantine(batchId: string): Promise<void>;
}
