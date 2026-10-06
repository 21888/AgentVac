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
  root: string | null;
  demo: boolean;
  platform: string;
}
export interface Entry {
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
  id: string;
  createdAt: string;
  root: string;
  items: {
    id: string;
    path: string;
    size: number;
    status: "pending" | "quarantined" | "restored" | "failed" | "trashed";
    error?: string;
  }[];
}
export interface RecoveryInspection {
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
export interface AgentVacAPI {
  getContext(): Promise<AppContext>;
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
  trash(batchId: string, confirmed: boolean): Promise<OperationResult>;
  openQuarantine(): Promise<void>;
}
