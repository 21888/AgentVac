import { adapters, getAdapter, isProviderId } from "./providers/index.js";
import { checkProviderProcesses } from "./processes.js";
import type { ProviderId, CandidateView } from "../shared/types.js";
export type { CandidateView } from "../shared/types.js";
import { promises as fs, constants, type Stats } from "node:fs";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { AgentVacEngine } from "./engine.js";
import { createDemo, DEMO_FIXTURE_PATHS } from "./fixtures.js";
import {
  diagnoseStorage,
  discoverDiagnosticCandidates,
  type CandidateInputs,
  type DiagnosticCandidate,
  type DiagnosticRoot,
  type DeepCheckResult,
  type StorageDiagnostics,
} from "./diagnostics.js";
import {
  RecoveryKeyring,
  recoveryKeyId,
  type RecoveryKeyringDescription,
  type RecoveryImportResult,
  type RecoveryExportResult,
} from "./recovery-keys.js";
import {
  WorkspaceStore,
  type WorkspaceDescription,
  type WorkspaceListing,
  type WorkspaceKind,
} from "./workspaces.js";
import type { AppContext, ProcessStatus } from "../shared/types.js";

/** JSON-safe views. Secret buffers and native adapters never cross IPC. */
export interface DemoView {
  path: string;
  status: "absent" | "ready" | "preparing" | "blocked";
  canReset: boolean;
  message: string;
}
export interface AppDataView {
  providers?: {
    id: ProviderId;
    label: string;
    scope: string;
    supportsSessionCleanup?: boolean;
  }[];
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
export interface AppDataServiceOptions extends CandidateInputs {
  processCheck?: () => Promise<ProcessStatus>;
  providerProcessCheck?: (provider: ProviderId) => Promise<ProcessStatus>;
  platform?: NodeJS.Platform;
  /** Production injects OS Trash. No deletion or rename fallback exists here. */
  trashItem?: (directory: string) => Promise<void>;
}

const DEMO_MARKER = ".agentvac-demo-owner.json";
// Shared with the generator, so reset never guesses which source files it owns.
const DEMO_FILES = new Set([DEMO_MARKER, ...DEMO_FIXTURE_PATHS]);
const DEMO_DIRS = new Set<string>();
for (const file of DEMO_FILES) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++)
    DEMO_DIRS.add(parts.slice(0, i).join("/"));
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_DEMO =
  "演示目录含未知新增文件、链接或无法认证的隔离记录；未移动任何文件。请先移出或另存额外资料，再重试。";
const MARKER_LIMIT = 4096;
const DEMO_ERROR = "演示目录无法验证归属，或目录已改变；未覆盖或移动任何文件。";
const WORKSPACE_ERROR =
  "目录记录不可用；原记录和当前选择已保留。请检查应用配置目录。";
const ID = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.nlink === b.nlink;
function canonical(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(p) &&
    path.isAbsolute(p) &&
    path.normalize(p) === p &&
    path.resolve(p) === p &&
    (process.platform !== "win32" ||
      !p.slice(path.parse(p).root.length).includes(":"))
  );
}
async function plainDirectory(p: string, create = false): Promise<Stats> {
  if (!canonical(p))
    throw new Error("目录路径必须是规范绝对路径，且不能包含链接。");
  let current = path.parse(p).root;
  let st = await fs.lstat(current);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(DEMO_ERROR);
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(DEMO_ERROR);
  }
  return st;
}
function kindFor(kind: WorkspaceKind): DiagnosticRoot["kind"] {
  return kind === "codex"
    ? "codex-home"
    : kind === "sqlite"
      ? "sqlite-home"
      : "log-dir";
}
function workspaceName(
  root: string,
  demo: boolean,
  kind: WorkspaceKind,
): string {
  return demo
    ? "演示工作区"
    : (
        path.basename(root).trim() ||
        (kind === "codex" ? "Codex 数据目录" : "诊断目录")
      ).slice(0, 120);
}
interface DemoMarkerBody {
  format: "agentvac-demo-workspace";
  version: 1;
  phase: "preparing" | "ready";
  root: string;
  dev: string;
  ino: string;
  keyId: string;
}
interface DemoMarker extends DemoMarkerBody {
  signature: string;
}
interface OwnedDemo {
  marker: DemoMarker;
  stat: Stats;
  fileStat: Stats;
}
const markerBody = (m: DemoMarkerBody): DemoMarkerBody => ({
  format: m.format,
  version: m.version,
  phase: m.phase,
  root: m.root,
  dev: m.dev,
  ino: m.ino,
  keyId: m.keyId,
});
const signature = (m: DemoMarkerBody, key: Buffer) =>
  createHmac("sha256", key)
    .update(JSON.stringify(markerBody(m)))
    .digest("hex");

/** Node-only orchestration. Native dialogs and sender validation belong in main. */
export class AppDataServices {
  private readonly workspaces: WorkspaceStore;
  private readonly recovery: RecoveryKeyring;
  private readonly options: AppDataServiceOptions;
  private readonly demoPath: string;
  private readonly candidates = new Map<string, CandidateView>();
  private readonly defaultCandidates: DiagnosticCandidate[];
  private context: AppContext = {
    root: null,
    provider: "codex",
    demo: false,
    platform: process.platform,
  };
  private currentEngine: AgentVacEngine | undefined;
  private selectedId: string | undefined;
  private initialized = false;
  private initializing: Promise<AppDataView> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private issues: string[] = [];
  private diagnosisControllers = new Map<string, AbortController>();
  constructor(
    private readonly profileDir: string,
    options: AppDataServiceOptions,
  ) {
    this.options = { ...options, env: { ...options.env } };
    this.workspaces = new WorkspaceStore(profileDir);
    this.recovery = new RecoveryKeyring(path.join(profileDir, "recovery"));
    this.demoPath = path.join(profileDir, "demo-workspace");
    this.defaultCandidates = discoverDiagnosticCandidates(this.options);
    this.replaceCandidates([]);
  }
  async flush(): Promise<void> {
    await this.initializing;
    await this.writes;
    await Promise.all([this.workspaces.flush(), this.recovery.flush()]);
  }
  async initialize(): Promise<AppDataView> {
    if (this.initialized) return this.view();
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    try {
      return await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }
  private async initializeOnce(): Promise<AppDataView> {
    if (
      !canonical(this.profileDir) ||
      this.profileDir === path.parse(this.profileDir).root
    )
      throw new Error("应用配置目录必须是普通、规范的非磁盘根目录。");
    await plainDirectory(this.profileDir, true);
    await this.recovery.load();
    const listing = await this.workspaces.load();
    this.initialized = true;
    // Reopen only the latest Codex selection, using metadata only. No fallback scan.
    const latest = listing.entries.find((entry) => isProviderId(entry.kind));
    if (listing.issue) this.addIssue(WORKSPACE_ERROR);
    else if (latest) {
      if (latest.status !== "available") this.addIssue(latest.message);
      else
        try {
          if (latest.demo) await this.requireReadyDemo(latest.path);
          const candidate = await this.newEngine(
            latest.path,
            latest.demo,
            latest.kind as ProviderId,
          );
          await this.requireWorkspace(latest.id, latest.kind);
          this.setCurrent(candidate, latest.id);
        } catch {
          this.addIssue("上次选择的目录未能安全重新打开；请选择目录后继续。");
        }
    }
    return this.view();
  }
  getContext(): AppContext {
    return { ...this.context };
  }
  engine(): AgentVacEngine {
    if (!this.currentEngine)
      throw new Error("请先选择当前提供方的数据目录或载入 Codex 演示。");
    return this.currentEngine;
  }
  async getAppData(): Promise<AppDataView> {
    await this.initialize();
    await this.writes;
    return this.view();
  }
  private async view(): Promise<AppDataView> {
    return {
      providers: adapters.map(
        ({ id, label, scope, supportsSessionCleanup }) => ({
          id,
          label,
          scope,
          supportsSessionCleanup: supportsSessionCleanup === true,
        }),
      ),
      workspaces: await this.workspaces.list(),
      recovery: this.recovery.describe(),
      candidates: this.candidateViews(),
      demo: await this.demoView(),
      issues: [...this.issues],
    };
  }
  private addIssue(message: string): void {
    if (!this.issues.includes(message)) this.issues.push(message);
    this.issues = this.issues.slice(-12);
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    // Reserve the queue synchronously so flush also sees newly admitted work.
    const task = this.writes.then(async () => {
      await this.initialize();
      if (this.currentEngine?.isBusy)
        throw new Error(
          "文件扫描或操作正在进行，不能切换提供方、目录或恢复上下文。",
        );
      return action();
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private setCurrent(engine: AgentVacEngine, id: string): void {
    this.currentEngine?.invalidate();
    this.currentEngine = engine;
    this.selectedId = id;
    this.context = {
      root: engine.root,
      provider: engine.provider,
      demo: engine.demo,
      platform: process.platform,
    };
  }
  private clearCurrent(provider = this.context.provider): void {
    this.currentEngine?.invalidate();
    this.currentEngine = undefined;
    this.selectedId = undefined;
    this.context = {
      root: null,
      provider,
      demo: false,
      platform: process.platform,
    };
  }
  private async newEngine(
    root: string,
    demo: boolean,
    provider: ProviderId = "codex",
  ): Promise<AgentVacEngine> {
    const key = this.recovery.describe().canSign
      ? (this.recovery.primaryKey() ?? null)
      : null;
    const engine = new AgentVacEngine(
      root,
      key,
      demo,
      () =>
        this.options.providerProcessCheck?.(provider) ??
        (provider === "codex" && this.options.processCheck
          ? this.options.processCheck()
          : checkProviderProcesses(provider)),
      this.recovery.trustedKeys(),
      getAdapter(provider),
    );
    await engine.initialize();
    return engine;
  }
  private async healthyListing(): Promise<WorkspaceListing> {
    const listing = await this.workspaces.list();
    if (listing.issue) throw new Error(WORKSPACE_ERROR);
    return listing;
  }
  private async requireWorkspace(
    id: string,
    kind?: WorkspaceKind,
  ): Promise<WorkspaceDescription> {
    if (typeof id !== "string" || !ID.test(id))
      throw new Error("目录标识无效。");
    const entry = (await this.healthyListing()).entries.find(
      (item) => item.id === id,
    );
    if (!entry || (kind && entry.kind !== kind))
      throw new Error("目录标识未知或用途不符；请重新选择。");
    if (entry.status !== "available") throw new Error(entry.message);
    return entry;
  }
  async setProvider(provider: ProviderId): Promise<AppContext> {
    getAdapter(provider);
    return this.exclusive(async () => {
      if (this.context.provider !== provider) {
        this.cancelDiagnosis();
        this.clearCurrent(provider);
      }
      return this.getContext();
    });
  }
  async selectProviderRoot(
    root: string,
    provider = this.context.provider,
  ): Promise<AppContext> {
    getAdapter(provider);
    return this.exclusive(() => this.selectRoot(root, false, provider));
  }
  async selectCodexRoot(root: string, demo = false): Promise<AppContext> {
    return this.exclusive(() => this.selectRoot(root, demo, "codex"));
  }
  private async selectRoot(
    root: string,
    demo: boolean,
    provider: ProviderId = "codex",
  ): Promise<AppContext> {
    getAdapter(provider);
    if (demo && provider !== "codex")
      throw new Error("演示仅支持 Codex 合成数据。");
    if (typeof demo !== "boolean") throw new Error("演示标识无效。");
    if (demo) await this.requireReadyDemo(root);
    else if (root === this.demoPath)
      throw new Error("请使用载入演示打开演示工作区。");
    await this.healthyListing();
    const before = await plainDirectory(root);
    const candidate = await this.newEngine(root, demo, provider);
    const saved = await this.workspaces.remember({
      path: root,
      demo,
      kind: provider,
      name: workspaceName(root, demo, provider),
    });
    await this.requireWorkspace(saved.id, provider);
    if (!sameIdentity(before, await plainDirectory(root)))
      throw new Error("所选目录在验证过程中已改变；当前选择未改变。");
    this.setCurrent(candidate, saved.id);
    return this.getContext();
  }
  async activateWorkspace(id: string): Promise<AppContext> {
    return this.exclusive(async () => {
      const entry = await this.requireWorkspace(id);
      if (isProviderId(entry.kind))
        return this.selectRoot(entry.path, entry.demo, entry.kind);
      await this.workspaces.remember(entry);
      await this.healthyListing();
      return this.getContext();
    });
  }
  async rememberDiagnosticRoot(
    root: string,
    kind: "sqlite" | "logs",
  ): Promise<AppDataView> {
    return this.exclusive(async () => {
      await this.rememberDiagnostic(root, kind);
      return this.view();
    });
  }
  private async rememberDiagnostic(
    root: string,
    kind: "sqlite" | "logs",
  ): Promise<void> {
    if (kind !== "sqlite" && kind !== "logs")
      throw new Error("诊断目录类型无效。");
    await this.healthyListing();
    await this.workspaces.remember({
      path: root,
      kind,
      demo: false,
      name: workspaceName(root, false, kind),
    });
    await this.healthyListing();
  }
  async activateCandidate(id: string): Promise<AppContext> {
    return this.exclusive(async () => {
      if (typeof id !== "string") throw new Error("候选目录标识无效。");
      const candidate = this.candidates.get(id);
      if (!candidate) throw new Error("候选目录标识未知；不会访问提供的路径。");
      if (
        candidate.kind === "codex-home" ||
        candidate.kind === "provider-home"
      ) {
        const provider = candidate.provider ?? "codex";
        if (provider !== this.context.provider)
          throw new Error("建议目录属于其他提供方，请先切换提供方。");
        return this.selectRoot(candidate.path, false, provider);
      }
      await this.rememberDiagnostic(
        candidate.path,
        candidate.kind === "sqlite-home" ? "sqlite" : "logs",
      );
      return this.getContext();
    });
  }
  private replaceCandidates(hints: DiagnosticCandidate[]): void {
    this.candidates.clear();
    const providerCandidates: CandidateView[] = adapters
      .filter((a) => a.id !== "codex")
      .flatMap((adapter) =>
        adapter
          .discover({
            home: this.options.home,
            env: this.options.env,
            platform: this.options.platform ?? process.platform,
          })
          .map((candidate) => ({
            ...candidate,
            kind: "provider-home" as const,
            id: "",
            verified: false as const,
          })),
      );
    for (const candidate of [
      ...this.defaultCandidates.map((c) => ({
        ...c,
        provider: "codex" as const,
      })),
      ...hints.map((c) => ({ ...c, provider: "codex" as const })),
      ...providerCandidates,
    ].slice(0, 64)) {
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            candidate.kind,
            candidate.path,
            candidate.source,
            candidate.provider,
          ]),
        )
        .digest("hex");
      this.candidates.set(id, { ...candidate, id, verified: false });
    }
  }
  private candidateViews(): CandidateView[] {
    return [...this.candidates.values()]
      .filter((entry) => (entry.provider ?? "codex") === this.context.provider)
      .map((entry) => ({ ...entry }));
  }
  async forgetWorkspace(id: string): Promise<AppDataView> {
    return this.exclusive(async () => {
      if (
        typeof id !== "string" ||
        !ID.test(id) ||
        !(await this.healthyListing()).entries.some((entry) => entry.id === id)
      )
        throw new Error("目录标识未知。");
      await this.workspaces.forget(id);
      await this.healthyListing();
      if (this.selectedId === id) this.clearCurrent();
      return this.view();
    });
  }
  async importKeys(file: string): Promise<RecoveryImportResult> {
    return this.exclusive(async () => {
      const result = await this.recovery.importFile(file, {
        allowLegacyRaw: true,
      });
      // Rebuilding drops scans and preview tokens, even when an import is duplicate.
      const id = this.selectedId;
      this.clearCurrent();
      if (id)
        try {
          const current = await this.requireWorkspace(id);
          if (!isProviderId(current.kind)) throw new Error("目录提供方无效。");
          if (current.demo) await this.requireReadyDemo(current.path);
          this.setCurrent(
            await this.newEngine(current.path, current.demo, current.kind),
            id,
          );
        } catch {
          this.addIssue(
            "恢复钥匙已导入，但原目录已改变或不可用；请重新选择目录。",
          );
        }
      return result;
    });
  }
  async exportKeys(file: string): Promise<RecoveryExportResult> {
    return this.exclusive(() => this.recovery.exportFile(file));
  }
  private async processStatus(): Promise<ProcessStatus> {
    try {
      const status = await this.options.processCheck?.();
      if (status && ["clear", "running", "unknown"].includes(status.status))
        return status;
    } catch {
      /* Never treat an unavailable check as closed. */
    }
    return { status: "unknown", details: "无法确认 Codex 是否已退出。" };
  }
  async diagnose(request: DiagnoseRequest): Promise<AppDiagnosticsView> {
    const requestId = request?.requestId ?? randomUUID();
    if (
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      ) ||
      this.diagnosisControllers.has(requestId)
    )
      throw new Error("诊断请求标识无效或重复。");
    const controller = new AbortController();
    this.diagnosisControllers.set(requestId, controller);
    const checkCancelled = () => {
      if (controller.signal.aborted)
        throw new Error("诊断已取消；未修改源文件。");
    };
    try {
      return await this.exclusive(async () => {
        checkCancelled();
        if (
          !isRecord(request) ||
          !Array.isArray(request.workspaceIds) ||
          request.workspaceIds.length < 1 ||
          request.workspaceIds.length > 8 ||
          request.workspaceIds.some((id) => typeof id !== "string") ||
          typeof request.configOptIn !== "boolean"
        )
          throw new Error(
            "诊断需要 1–8 个已选择目录，配置读取必须明确开启或关闭。",
          );
        const deep = request.deepCheck;
        if (
          deep !== undefined &&
          (!isRecord(deep) ||
            typeof deep.enabled !== "boolean" ||
            typeof deep.databasePath !== "string" ||
            deep.databasePath.length > 4096 ||
            (deep.confirmedClosed !== undefined &&
              typeof deep.confirmedClosed !== "boolean"))
        )
          throw new Error("深入诊断选项无效，必须使用明确的布尔开关。");
        const ids = [...new Set(request.workspaceIds)];
        const selected = await Promise.all(
          ids.map((id) => this.requireWorkspace(id)),
        );
        if (
          selected.some(
            (entry) => !["codex", "sqlite", "logs"].includes(entry.kind),
          )
        )
          throw new Error(
            "深入空间诊断目前仅支持 Codex；其他提供方不会打开数据库。",
          );
        let gate: AppDeepCheckResult | undefined;
        if (deep?.enabled === true) {
          if (deep.confirmedClosed !== true)
            gate = { status: "blocked", reason: "CLOSE_CONFIRMATION_REQUIRED" };
          else {
            const process = await this.processStatus();
            if (process.status !== "clear")
              gate = {
                status: "blocked",
                reason:
                  process.status === "running"
                    ? "CODEX_RUNNING"
                    : "PROCESS_UNKNOWN",
              };
          }
        }
        checkCancelled();
        const result = await diagnoseStorage(
          {
            roots: selected.map((entry) => ({
              path: entry.path,
              kind: kindFor(entry.kind),
            })),
            configOptIn: request.configOptIn === true,
            ...(deep?.enabled === true && !gate
              ? {
                  deepCheck: { enabled: true, databasePath: deep.databasePath },
                }
              : {}),
          },
          { signal: controller.signal },
        );
        checkCancelled();
        if (deep?.enabled === true && !gate) {
          const process = await this.processStatus();
          if (process.status !== "clear")
            gate = {
              status: "blocked",
              reason:
                process.status === "running"
                  ? "CODEX_RUNNING"
                  : "PROCESS_UNKNOWN",
            };
        }
        // Reject observations of a replacement directory rather than return them.
        await Promise.all(ids.map((id) => this.requireWorkspace(id)));
        this.replaceCandidates(result.configHints);
        return {
          ...result,
          deepCheck: gate ?? result.deepCheck,
          sqliteTotalBytes:
            result.totals.sqlite +
            result.totals.wal +
            result.totals.shm +
            result.totals.journal,
          candidates: this.candidateViews(),
        };
      });
    } finally {
      this.diagnosisControllers.delete(requestId);
    }
  }
  cancelDiagnosis(requestId?: string): void {
    if (requestId === undefined) {
      for (const controller of this.diagnosisControllers.values())
        controller.abort();
      return;
    }
    if (typeof requestId !== "string") throw new Error("诊断请求标识无效。");
    this.diagnosisControllers.get(requestId)?.abort();
  }
  private async ownedDemo(markerName = DEMO_MARKER): Promise<OwnedDemo> {
    const stat = await plainDirectory(this.demoPath);
    const file = path.join(this.demoPath, markerName);
    const before = await fs.lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MARKER_LIMIT
    )
      throw new Error(DEMO_ERROR);
    const handle = await fs.open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    let value: unknown;
    let fileStat: Stats;
    try {
      const opened = await handle.stat();
      if (!unchanged(before, opened)) throw new Error(DEMO_ERROR);
      const bytes = Buffer.alloc(MARKER_LIMIT + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      fileStat = await handle.stat();
      if (
        read.bytesRead > MARKER_LIMIT ||
        read.bytesRead !== opened.size ||
        !unchanged(opened, fileStat) ||
        !unchanged(fileStat, await fs.lstat(file))
      )
        throw new Error(DEMO_ERROR);
      value = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !==
        [
          "format",
          "version",
          "phase",
          "root",
          "dev",
          "ino",
          "keyId",
          "signature",
        ]
          .sort()
          .join(",") ||
      value.format !== "agentvac-demo-workspace" ||
      value.version !== 1 ||
      !["preparing", "ready"].includes(value.phase as string) ||
      value.root !== this.demoPath ||
      value.dev !== String(stat.dev) ||
      value.ino !== String(stat.ino) ||
      typeof value.keyId !== "string" ||
      !ID.test(value.keyId) ||
      typeof value.signature !== "string" ||
      !ID.test(value.signature)
    )
      throw new Error(DEMO_ERROR);
    const marker = value as unknown as DemoMarker;
    const key = this.recovery
      .trustedKeys()
      .find((key) => recoveryKeyId(key) === marker.keyId);
    if (
      !key ||
      !timingSafeEqual(
        Buffer.from(marker.signature, "hex"),
        Buffer.from(signature(marker, key), "hex"),
      ) ||
      !sameIdentity(stat, await plainDirectory(this.demoPath))
    )
      throw new Error(DEMO_ERROR);
    return { marker, stat, fileStat };
  }
  private async demoView(): Promise<DemoView> {
    const base = { path: this.demoPath, canReset: false };
    try {
      await plainDirectory(this.profileDir);
      try {
        await fs.lstat(this.demoPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return {
            ...base,
            status: "absent",
            message: "演示尚未创建；首次载入后会保留操作和恢复记录。",
          };
        throw error;
      }
      const owned = await this.ownedDemo();
      return {
        ...base,
        status: owned.marker.phase,
        canReset: !!this.options.trashItem && this.recovery.describe().canSign,
        message:
          owned.marker.phase === "ready"
            ? "演示工作区会跨重启保留；载入不会重新生成文件。"
            : "上次演示创建未完成；已保留现有文件，请确认后重置。",
      };
    } catch {
      return { ...base, status: "blocked", message: DEMO_ERROR };
    }
  }
  private async requireReadyDemo(root: string): Promise<OwnedDemo> {
    if (root !== this.demoPath)
      throw new Error("仅允许打开应用拥有的演示工作区。");
    const owned = await this.ownedDemo();
    if (owned.marker.phase !== "ready")
      throw new Error("演示创建尚未完成；请确认后重置，现有文件不会自动覆盖。");
    return owned;
  }
  private async createOwnedDemo(): Promise<void> {
    if (!this.recovery.describe().canSign)
      throw new Error("恢复钥匙不可用，不能创建新的演示工作区。");
    const key = this.recovery.primaryKey()!;
    await plainDirectory(this.profileDir);
    await fs.mkdir(this.demoPath, { mode: 0o700 }); // Exclusive directory creation.
    const stat = await plainDirectory(this.demoPath);
    const body: DemoMarkerBody = {
      format: "agentvac-demo-workspace",
      version: 1,
      phase: "preparing",
      root: this.demoPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      keyId: recoveryKeyId(key),
    };
    const marker: DemoMarker = { ...body, signature: signature(body, key) };
    const file = path.join(this.demoPath, DEMO_MARKER);
    const handle = await fs.open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(marker));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.ownedDemo();
    await createDemo(this.demoPath);
    const owned = await this.ownedDemo();
    if (!sameIdentity(stat, owned.stat) || owned.marker.phase !== "preparing")
      throw new Error(DEMO_ERROR);
    const ready = { ...body, phase: "ready" as const };
    const temp = path.join(this.demoPath, `.demo-ready-${randomUUID()}.tmp`);
    const readyHandle = await fs.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await readyHandle.writeFile(
        JSON.stringify({ ...ready, signature: signature(ready, key) }),
      );
      await readyHandle.sync();
    } finally {
      await readyHandle.close();
    }
    const rechecked = await this.ownedDemo();
    if (
      !sameIdentity(stat, rechecked.stat) ||
      !unchanged(owned.fileStat, rechecked.fileStat)
    )
      throw new Error(DEMO_ERROR);
    // Only replace the authenticated marker we created, never source data.
    await fs.rename(temp, file);
    await this.requireReadyDemo(this.demoPath);
  }
  async loadDemo(): Promise<AppContext> {
    return this.exclusive(async () => {
      await this.healthyListing();
      const state = await this.demoView();
      if (state.status === "absent") await this.createOwnedDemo();
      else if (state.status !== "ready") throw new Error(state.message);
      return this.selectRoot(this.demoPath, true);
    });
  }
  /** Metadata-only inventory before reset; never opens unknown user files. */
  private async resetInventory(): Promise<{
    stamp: string;
    files: string[];
    batches: string[];
    receipts: string[];
    temporaryMarkers: string[];
  }> {
    const rootStat = await plainDirectory(this.demoPath);
    const rows: string[] = [];
    const files: string[] = [],
      batches: string[] = [],
      receipts: string[] = [],
      temporaryMarkers: string[] = [];
    let count = 0;
    const walk = async (dir: string, relative: string): Promise<void> => {
      const stat = await plainDirectory(dir);
      if (stat.dev !== rootStat.dev) throw new Error(UNKNOWN_DEMO);
      rows.push(
        JSON.stringify([
          relative,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
        ]),
      );
      for await (const entry of await fs.opendir(dir)) {
        if (++count > 5000) throw new Error(UNKNOWN_DEMO);
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        const st = await fs.lstat(full);
        if (
          st.isSymbolicLink() ||
          st.dev !== rootStat.dev ||
          (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))
        )
          throw new Error(UNKNOWN_DEMO);
        rows.push(
          JSON.stringify([
            rel,
            st.dev,
            st.ino,
            st.size,
            st.mtimeMs,
            st.ctimeMs,
            st.nlink,
          ]),
        );
        if (st.isDirectory()) {
          const isBatch =
            relative === ".agentvac-quarantine" && UUID.test(entry.name);
          if (!DEMO_DIRS.has(rel) && rel !== ".agentvac-quarantine" && !isBatch)
            throw new Error(UNKNOWN_DEMO);
          if (isBatch) {
            if (batches.length >= 200) throw new Error(UNKNOWN_DEMO);
            batches.push(entry.name);
          }
          await walk(full, rel);
        } else {
          if (DEMO_FILES.has(rel)) {
            files.push(rel);
            continue;
          }
          // A fully signed ready-marker temp can survive a crash before rename.
          // Merely matching .tmp or this name is insufficient: authenticate below.
          if (
            relative === "" &&
            entry.name.startsWith(".demo-ready-") &&
            entry.name.endsWith(".tmp") &&
            UUID.test(entry.name.slice(12, -4))
          ) {
            if (st.size > MARKER_LIMIT || temporaryMarkers.length >= 8)
              throw new Error(UNKNOWN_DEMO);
            temporaryMarkers.push(entry.name);
            files.push(rel);
            continue;
          }
          if (
            relative === ".agentvac-quarantine" &&
            entry.name.endsWith(".receipt.json") &&
            UUID.test(entry.name.slice(0, -13))
          ) {
            if (receipts.length >= 200 || st.size > 1024 * 1024)
              throw new Error(UNKNOWN_DEMO);
            receipts.push(entry.name.slice(0, -13));
            files.push(rel);
            continue;
          }
          const batchId = relative.slice(".agentvac-quarantine/".length);
          if (
            relative.startsWith(".agentvac-quarantine/") &&
            UUID.test(batchId) &&
            (entry.name === "manifest.json" ||
              (entry.name.endsWith(".data") &&
                UUID.test(entry.name.slice(0, -5))))
          ) {
            files.push(rel);
            continue;
          }
          throw new Error(UNKNOWN_DEMO);
        }
      }
    };
    await walk(this.demoPath, "");
    return {
      stamp: rows.sort().join("\n"),
      files,
      batches,
      receipts,
      temporaryMarkers,
    };
  }
  private async requireResetContents(): Promise<void> {
    const before = await this.resetInventory();
    for (const name of before.temporaryMarkers) {
      if ((await this.ownedDemo(name)).marker.phase !== "ready")
        throw new Error(UNKNOWN_DEMO);
    }
    if (before.batches.length || before.receipts.length) {
      if (before.receipts.some((id) => before.batches.includes(id)))
        throw new Error(UNKNOWN_DEMO);
      const engine = await this.newEngine(this.demoPath, true);
      const rescue = await engine.inspectRecovery();
      if (
        rescue.truncated ||
        before.batches.some(
          (id) =>
            !rescue.batches.some(
              (batch) =>
                batch.id === id &&
                batch.verified &&
                batch.irregularEntries === 0,
            ),
        )
      )
        throw new Error(UNKNOWN_DEMO);
      const history = await engine.history();
      for (const id of [...before.batches, ...before.receipts]) {
        const batch = history.find((item) => item.id === id);
        if (
          !batch ||
          batch.items.some(
            (item) => item.id === "invalid" || item.id === "receipt",
          )
        )
          throw new Error(UNKNOWN_DEMO);
        if (before.batches.includes(id)) {
          for (const file of before.files.filter(
            (name) =>
              name.startsWith(`.agentvac-quarantine/${id}/`) &&
              name.endsWith(".data"),
          )) {
            if (
              !batch.items.some(
                (item) => file === `.agentvac-quarantine/${id}/${item.id}.data`,
              )
            )
              throw new Error(UNKNOWN_DEMO);
          }
        }
      }
    }
    // Detect new entries, replaced directories and edits made during authentication.
    if (before.stamp !== (await this.resetInventory()).stamp)
      throw new Error(UNKNOWN_DEMO);
  }
  async resetDemo(confirmed: boolean): Promise<AppContext> {
    return this.exclusive(async () => {
      if (confirmed !== true)
        throw new Error("重置演示需要明确确认；现有文件未移动。");
      await this.healthyListing();
      if (!this.options.trashItem)
        throw new Error(
          "系统回收站不可用；未使用删除或改名替代。现有演示已保留。",
        );
      if (!this.recovery.describe().canSign)
        throw new Error("恢复钥匙不可用，无法安全重置演示。");
      const owned = await this.ownedDemo();
      await this.requireResetContents();
      if (!sameIdentity(owned.stat, await plainDirectory(this.demoPath)))
        throw new Error(DEMO_ERROR);
      let trashFailed = false;
      try {
        await this.options.trashItem(this.demoPath);
      } catch {
        trashFailed = true;
      }
      let missing = false;
      try {
        await fs.lstat(this.demoPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
        else
          throw new Error(
            "无法核验演示是否已移至回收站；未生成新文件，请检查原目录。",
          );
      }
      if (!missing)
        throw new Error(
          "演示未移离原位置；未覆盖或重建现有文件。请检查系统回收站后重试。",
        );
      if (this.context.root === this.demoPath) this.clearCurrent();
      if (trashFailed)
        throw new Error(
          "回收站操作报告失败，但演示已不在原位置；未生成新文件，请检查系统回收站。",
        );
      await this.createOwnedDemo();
      return this.selectRoot(this.demoPath, true);
    });
  }
}
