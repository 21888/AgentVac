<script setup lang="ts">
import ConversationWorkspace from "./ConversationWorkspace.vue";
import { cleanupScope } from "./release-support";
import { TrashConsent } from "./trash-consent";
import type {
  ConversationAPI,
  ConversationArchivePreview,
} from "../shared/conversations";
import { version as appVersion } from "../package.json";
import {
  computed,
  reactive,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  watch,
  nextTick,
} from "vue";
import type {
  AppContext,
  ProviderId,
  Entry,
  ScanResult,
  ScanProgress,
  AppDataView,
  AppDiagnosticsView,
  DiagnoseRequest,
  WorkspaceDescription,
  RecoveryInspection,
  Preview,
  OperationResult,
  Batch,
  ThemeMode,
} from "../shared/types";

const iconPaths: Record<string, string> = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
  monitor:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M3 12h18"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
  archive:
    '<rect x="3" y="3" width="18" height="5" rx="1.5"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
  shield:
    '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-5"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  arrowUp: '<path d="m7 17 10-10M7 7h10v10"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.1 2M4.8 16A8 8 0 0 0 18 18"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 12h8m-8 4h6"/>',
  log: '<path d="M5 3h14v18H5zM8 7h1m3 0h4m-8 5h1m3 0h4m-8 5h1m3 0h4"/>',
  cache:
    '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/>',
  session:
    '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V7a5 5 0 0 1 5-5h6a8 8 0 0 1 8 8Z"/><path d="M7 8h9M7 12h6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  restore: '<path d="M3 10h6M3 10V4m0 6a9 9 0 1 1 1 8M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  storage:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 11h18M8 16h.1M12 16h5M8 7h8"/>',
  terminal:
    '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3m6 0h5"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const Icon = defineComponent({
  props: {
    name: { type: String, required: true },
    size: { type: Number, default: 20 },
  },
  setup: (props) => () =>
    h("svg", {
      width: props.size,
      height: props.size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.7,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      innerHTML: iconPaths[props.name] || iconPaths.file,
    }),
});

const themeOptions = [
  { value: "light", label: "浅色", icon: "sun", accessible: "浅色主题" },
  { value: "dark", label: "深色", icon: "moon", accessible: "深色主题" },
  {
    value: "system",
    label: "系统",
    icon: "monitor",
    accessible: "跟随系统主题",
  },
] as const;
function readTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("agentvac.theme");
    return saved === "light" || saved === "dark" || saved === "system"
      ? saved
      : "system";
  } catch {
    return "system";
  }
}
const themeMode = ref<ThemeMode>(readTheme());
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(colorSchemeQuery.matches);
const resolvedTheme = computed(() =>
  themeMode.value === "system"
    ? systemDark.value
      ? "dark"
      : "light"
    : themeMode.value,
);
watch(
  resolvedTheme,
  (theme) => {
    document.documentElement.dataset.theme = theme;
  },
  { immediate: true },
);
watch(themeMode, (mode) => {
  try {
    localStorage.setItem("agentvac.theme", mode);
  } catch {
    /* The choice still works when preference storage is unavailable. */
  }
});
function updateSystemTheme(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
let themeChoiceRevision = 0;
async function chooseTheme(mode: ThemeMode) {
  const revision = ++themeChoiceRevision;
  themeMode.value = mode;
  if (!window.agentvac) return;
  try {
    await window.agentvac.setTheme(mode);
  } catch {
    if (revision === themeChoiceRevision)
      notice.value =
        "外观已切换，但偏好暂时无法保存；下次启动可能恢复之前的设置。";
  }
}
async function loadThemePreference() {
  const revision = themeChoiceRevision;
  try {
    const preferences = await window.agentvac.getPreferences();
    if (revision === themeChoiceRevision) themeMode.value = preferences.theme;
  } catch {
    // Appearance is optional; an unavailable preferences store must not block file work.
    notice.value = "无法读取已保存的外观偏好，本次使用本地外观设置。";
  }
}

const page = ref<
  "scan" | "conversations" | "diagnostics" | "history" | "manage" | "rules"
>("scan");
const conversationRevision = ref(0);
const conversationArchiveIds = ref<string[]>([]);
const conversationArchiveTitles = ref<string[]>([]);
const context = ref<AppContext>({
  root: null,
  provider: "codex",
  demo: false,
  platform: "",
});
const providerOptions = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cline", label: "Cline" },
  { id: "cursor", label: "Cursor" },
] as const;
const selectedProvider = computed(() => context.value.provider ?? "codex");
const providerName = (id: ProviderId | undefined) =>
  providerOptions.find((item) => item.id === (id ?? "codex"))?.label ??
  "未知提供方";
const providerLabel = computed(
  () =>
    providerOptions.find((item) => item.id === selectedProvider.value)?.label ??
    "Codex",
);
const supportsSessionCleanup = computed(
  () =>
    appData.value?.providers?.find((item) => item.id === selectedProvider.value)
      ?.supportsSessionCleanup ?? false,
);
const providerScope = computed(
  () =>
    appData.value?.providers?.find((item) => item.id === selectedProvider.value)
      ?.scope ?? cleanupScope[selectedProvider.value],
);
const isCleanupWorkspace = (kind: string) =>
  providerOptions.some((item) => item.id === kind);
const isCleanupCandidate = (kind: string) =>
  kind === "codex-home" || kind === "provider-home";
async function chooseProvider(event: Event) {
  const requested = (event.target as HTMLSelectElement).value as ProviderId;
  if (busy.value || requested === selectedProvider.value) return;
  const stayInConversations = page.value === "conversations";
  await run("切换提供方", async () => {
    resetRoot(await window.agentvac.setProvider(requested));
    page.value = stayInConversations ? "conversations" : "scan";
    await refreshAppData();
    notice.value = `已切换到 ${providerLabel.value}；请选择对应数据目录。`;
  });
}
const scanResult = ref<ScanResult | null>(null);
const scanState = ref<
  "idle" | "scanning" | "complete" | "partial" | "cancelled" | "error"
>("idle");
const activeScanRequestId = ref<string | null>(null);
const scanProgress = ref<ScanProgress | null>(null);
const scanStartedAt = ref(0);
const scanLimit = ref<50000 | 100000>(50000);
let unsubscribeScanProgress: (() => void) | undefined;
const isScanning = computed(() => scanState.value === "scanning");
const partialScan = computed(() => scanResult.value?.status === "partial");
const coverage = computed(() => scanResult.value?.coverage);
const scanStateLabels = {
  idle: "尚未扫描",
  scanning: "正在扫描",
  complete: "本次范围扫描完整",
  partial: "扫描不完整",
  cancelled: "扫描已取消",
  error: "扫描失败",
} as const;
const partialReason = computed(() => {
  const details = coverage.value;
  const reasons: string[] = [];
  if (details?.limitReason === "entry-count")
    reasons.push(
      `达到 ${details.maxEntries.toLocaleString("zh-CN")} 项扫描上限`,
    );
  if (details?.limitReason === "result-bytes")
    reasons.push("扫描结果大小达到传输上限");
  if (details?.inaccessibleEntries)
    reasons.push(`${details.inaccessibleEntries} 项无法访问`);
  if (details?.depthLimitedDirectories)
    reasons.push(`${details.depthLimitedDirectories} 个目录达到扫描深度上限`);
  return reasons.length ? reasons.join("；") : "部分文件或目录尚未检查";
});
const canRescanWithHigherLimit = computed(
  () =>
    partialScan.value &&
    coverage.value?.limitReason === "entry-count" &&
    coverage.value.maxEntries === 50000,
);
const appData = ref<AppDataView | null>(null);
const appDataError = ref("");
const managementAvailable = typeof window.agentvac?.getAppData === "function";
const canSign = computed(
  () => !managementAvailable || appData.value?.recovery.canSign === true,
);
const diagnosticWorkspaceIds = ref(new Set<string>());
const diagnosticConfigOptIn = ref(false);
const diagnosticResult = ref<AppDiagnosticsView | null>(null);
const diagnosticQuery = ref("");
const diagnosticPage = ref(1);
const activeDiagnosisRequestId = ref<string | null>(null);
const diagnosisCancelPending = ref(false);
const diagnosisCancellationAvailable =
  typeof window.agentvac?.cancelDiagnosis === "function";
const deepEnabled = ref(false);
const deepConfirmedClosed = ref(false);
const deepDatabasePath = ref("");
const recoveryInspection = ref<RecoveryInspection | null>(null);
const recoveryStoredFiles = computed(
  () =>
    recoveryInspection.value?.batches.reduce(
      (sum, batch) => sum + batch.storedFiles,
      0,
    ) ?? 0,
);
const recoveryPage = ref(1);
const recoveryPages = computed(() =>
  Math.max(1, Math.ceil((recoveryInspection.value?.batches.length ?? 0) / 50)),
);
const shownRecoveryBatches = computed(
  () =>
    recoveryInspection.value?.batches.slice(
      (recoveryPage.value - 1) * 50,
      recoveryPage.value * 50,
    ) ?? [],
);
watch(recoveryInspection, () => {
  recoveryPage.value = 1;
});
const canOpenBatch = typeof window.agentvac?.openBatchQuarantine === "function";
const systemTrashAvailable =
  typeof window.agentvac?.openSystemTrash === "function";
const adminAction = ref<"import-keys" | "export-keys" | "reset-demo" | null>(
  null,
);
const adminAcknowledged = ref(false);
const keyTransferReceipt = ref<{
  kind: "import" | "export";
  message: string;
  path?: string;
  keyIds: string[];
} | null>(null);
const availableWorkspaces = computed(
  () => appData.value?.workspaces.entries ?? [],
);
const suggestedCandidates = computed(() => {
  const unique = new Map<string, AppDataView["candidates"][number]>();
  for (const item of [
    ...(appData.value?.candidates ?? []),
    ...(diagnosticResult.value?.candidates ?? []),
  ])
    unique.set(item.id, item);
  return [...unique.values()].filter(
    (candidate) =>
      !availableWorkspaces.value.some(
        (workspace) =>
          workspace.status === "available" &&
          workspace.path === candidate.path &&
          (!candidate.provider ||
            workspace.kind === candidate.provider ||
            ["sqlite", "logs"].includes(workspace.kind)) &&
          {
            codex: "codex-home",
            "claude-code": "provider-home",
            cline: "provider-home",
            cursor: "provider-home",
            sqlite: "sqlite-home",
            logs: "log-dir",
          }[workspace.kind] === candidate.kind,
      ),
  );
});
const diagnosticFiles = computed(() =>
  (diagnosticResult.value?.files ?? []).filter(
    (file) =>
      !diagnosticQuery.value ||
      file.path.toLowerCase().includes(diagnosticQuery.value.toLowerCase()),
  ),
);
const diagnosticPages = computed(() =>
  Math.max(1, Math.ceil(diagnosticFiles.value.length / 100)),
);
const shownDiagnosticFiles = computed(() =>
  diagnosticFiles.value.slice(
    (diagnosticPage.value - 1) * 100,
    diagnosticPage.value * 100,
  ),
);
const deepDatabaseOptions = computed(() =>
  (diagnosticResult.value?.files ?? []).filter(
    (file) => file.kind === "sqlite" && fileName(file.path) === "logs_2.sqlite",
  ),
);
const configCandidates = computed(() =>
  suggestedCandidates.value.filter(
    (item) =>
      item.source === "config.sqlite_home" || item.source === "config.log_dir",
  ),
);
const workspaceKindLabels = {
  codex: "Codex 数据",
  "claude-code": "Claude Code 数据",
  cline: "Cline 数据",
  cursor: "Cursor 数据",
  sqlite: "SQLite 位置",
  logs: "日志位置",
};
const workspaceStatusLabels = {
  available: "可用",
  missing: "目录缺失",
  moved: "目录已变化",
  unsafe: "路径不安全",
  error: "无法读取",
};
const candidateKindLabels = {
  "codex-home": "Codex 数据目录",
  "provider-home": "助手数据目录",
  "sqlite-home": "SQLite 目录",
  "log-dir": "日志目录",
};
const diagnosticKindLabels = {
  sqlite: "数据库主体",
  wal: "WAL",
  shm: "SHM",
  journal: "Journal",
  "ordinary-log": "普通日志",
};
const diagnosticWarningText: Record<string, string> = {
  INVALID_ROOT: "所选目录无效，未读取。",
  ROOT_UNAVAILABLE: "部分目录无法读取，统计不完整。",
  UNSAFE_PATH: "发现不安全路径，已跳过。",
  ENTRY_UNAVAILABLE: "部分文件不可访问，未计入。",
  FILE_LIMIT_REACHED: "达到文件数量上限，统计仅含已发现项目。",
  CONFIG_UNAVAILABLE: "配置不可读取，未提供配置路径建议。",
  CONFIG_TOO_LARGE: "配置超过安全读取上限，未继续读取。",
  CONFIG_CHANGED: "配置在读取期间变化，已丢弃该次配置结果。",
  CONFIG_PATH_UNSUPPORTED: "配置含不支持的路径写法，请手动选择。",
  CONFIG_FORMAT_UNSUPPORTED: "配置含不支持的格式，请手动选择路径。",
};
const deepReasonText: Record<string, string> = {
  NOT_ENABLED: "尚未开启只读深查。",
  OUTSIDE_SELECTED_ROOTS: "数据库不在此次已选位置内。",
  NOT_LOGS_DATABASE: "仅支持已发现的 logs_2.sqlite；其他数据库保持保护。",
  UNSAFE_PATH: "数据库路径包含链接或身份不安全。",
  DATABASE_UNAVAILABLE: "数据库不可读取。",
  SIDECARS_PRESENT:
    "检测到 WAL、SHM 或 Journal 旁路文件，不能安全进行此项深查。",
  SOURCE_CHANGED: "文件在检查期间变化，已停止并丢弃指标。",
  NOT_SQLITE: "文件不是可识别的 SQLite 数据库。",
  UNKNOWN_SCHEMA: "数据库结构不属于已识别的 Codex 日志结构，未继续深查。",
  SQLITE_UNAVAILABLE: "当前运行环境不支持只读 SQLite 检查。",
  IMMUTABLE_OPEN_UNAVAILABLE: "无法以要求的只读方式打开，已停止。",
  READ_FAILED: "只读检查失败，未修改数据库。",
  TIMEOUT: "只读检查超过时限，已终止检查进程。请核实数据库状态后重试。",
  CANCELLED: "已取消只读检查，没有提供本次页指标。",
  WORKER_FAILED: "独立检查进程未能完成，未提供数据库页指标。",
  PROCESS_ISOLATION_UNAVAILABLE:
    "无法启动隔离的只读检查进程，未检查数据库页信息。",
  WORKER_PROTOCOL_INVALID: "检查进程返回结果无效，已丢弃本次页指标。",
  CLOSE_CONFIRMATION_REQUIRED: "请先明确确认已退出所有 Codex 进程。",
  CODEX_RUNNING: "检测到 Codex 仍在运行，请退出后重试。",
  PROCESS_UNKNOWN: "无法确认 Codex 进程状态，已阻止深入检查。",
};
watch([diagnosticQuery, diagnosticResult], () => {
  diagnosticPage.value = 1;
});
watch([diagnosticWorkspaceIds, diagnosticConfigOptIn], () => {
  diagnosticResult.value = null;
  deepDatabasePath.value = "";
  deepEnabled.value = false;
  deepConfirmedClosed.value = false;
});
watch(deepDatabasePath, () => {
  deepConfirmedClosed.value = false;
});
const batches = ref<Batch[]>([]);
const selected = ref(new Set<string>());
const minAgeDays = ref(30);
const includeSessions = ref(false);
const query = ref("");
const category = ref("all");
const ageFilter = ref("all");
const sortBy = ref<"size" | "oldest" | "path">("size");
const currentPage = ref(1);
const pageSize = 100;
const maxSelection = 5000;
const busy = ref("");
const cancelPending = ref(false);
const error = ref("");
const operationInterrupted = ref(false);
const notice = ref("");
const preview = ref<Preview | null>(null);
const acknowledged = ref(false);
const confirmedClosed = ref(false);
const restoreTarget = ref<Batch | null>(null);
const trashTarget = ref<Batch | null>(null);
const sessionBulkReview = ref<{
  entries: Entry[];
  scanId: string;
  query: string;
  age: string;
} | null>(null);
const sessionBulkAcknowledged = ref(false);
const trashConsent = reactive(new TrashConsent());
const operation = ref<
  (OperationResult & { type: "quarantine" | "restore" | "trash" }) | null
>(null);
const focusedEntry = ref<Entry | null>(null);
const inspectedId = ref<string | null>(null);
const inspectedEntry = computed(
  () =>
    scanResult.value?.entries.find((entry) => entry.id === inspectedId.value) ??
    null,
);
const categoryCounts = computed(() => {
  const counts: Record<string, number> = {
    log: 0,
    session: 0,
    cache: 0,
    protected: 0,
  };
  for (const entry of scanResult.value?.entries ?? []) counts[entry.category]++;
  return counts;
});
const hoveredSpace = ref<string | null>(null);
const hoveredFile = ref<Entry | null>(null);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const apiAvailable = ref(typeof window !== "undefined" && !!window.agentvac);
const navigation = [
  { id: "scan", icon: "file", label: "文件", accessible: "文件" },
  {
    id: "conversations",
    icon: "session",
    label: "对话管理",
    accessible: "对话管理",
  },
  {
    id: "diagnostics",
    icon: "storage",
    label: "空间诊断",
    accessible: "空间诊断",
  },
  { id: "history", icon: "archive", label: "隔离记录", accessible: "隔离记录" },
  {
    id: "manage",
    icon: "folder",
    label: "目录与恢复",
    accessible: "目录与恢复",
  },
  { id: "rules", icon: "shield", label: "保护规则", accessible: "保护规则" },
] as const;
const labels: Record<string, string> = {
  log: "运行日志",
  cache: "临时缓存",
  session: "会话记录",
  protected: "受保护",
};
const riskLabels: Record<string, string> = {
  safe: "可安全隔离",
  review: "需要审阅",
  protected: "已保护",
};
const categoryIcons: Record<string, string> = {
  log: "log",
  cache: "cache",
  session: "session",
  protected: "lock",
};
const summary = computed(() => scanResult.value?.summary);
const eligible = computed(
  () => scanResult.value?.entries.filter((e) => e.selectable) ?? [],
);
const safeEntries = computed(
  () =>
    scanResult.value?.entries.filter(
      (e) => e.selectable && e.risk === "safe",
    ) ?? [],
);
const selectedEntries = computed(() =>
  (scanResult.value?.entries ?? []).filter((e) => selected.value.has(e.id)),
);
const selectedBytes = computed(() =>
  selectedEntries.value.reduce((n, e) => n + e.size, 0),
);
const filteredEntries = computed(() =>
  (scanResult.value?.entries ?? [])
    .filter(
      (e) =>
        (category.value === "all" || e.category === category.value) &&
        (!query.value ||
          e.path.toLowerCase().includes(query.value.toLowerCase())) &&
        (ageFilter.value === "all" || e.ageDays >= Number(ageFilter.value)),
    )
    .sort((a, b) =>
      sortBy.value === "oldest"
        ? a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)
        : sortBy.value === "path"
          ? a.path.localeCompare(b.path)
          : b.size - a.size || a.path.localeCompare(b.path),
    ),
);
const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredEntries.value.length / pageSize)),
);
const activeRowId = ref<string | null>(null);
const shownEntries = computed(() =>
  filteredEntries.value.slice(
    (currentPage.value - 1) * pageSize,
    currentPage.value * pageSize,
  ),
);
const tabStopEntryId = computed(() =>
  shownEntries.value.some((entry) => entry.id === activeRowId.value)
    ? activeRowId.value
    : shownEntries.value[0]?.id,
);
const visibleSafe = computed(() =>
  shownEntries.value.filter(
    (entry) => entry.selectable && entry.risk === "safe",
  ),
);
const filteredSafeEntries = computed(() =>
  filteredEntries.value.filter(
    (entry) => entry.selectable && entry.risk === "safe",
  ),
);
const sessionBulkAvailable = computed(
  () => includeSessions.value && category.value === "session",
);
const filteredSessionEntries = computed(() =>
  sessionBulkAvailable.value
    ? filteredEntries.value.filter(
        (entry) => entry.selectable && entry.category === "session",
      )
    : [],
);
const bulkScopeEntries = computed(() =>
  sessionBulkAvailable.value
    ? filteredSessionEntries.value
    : filteredSafeEntries.value,
);
const bulkScopeBytes = computed(() =>
  bulkScopeEntries.value.reduce((sum, entry) => sum + entry.size, 0),
);
const bulkScopeOverLimit = computed(
  () => bulkScopeEntries.value.length > maxSelection,
);
const hiddenSelectedEntries = computed(() => {
  const visibleIds = new Set(shownEntries.value.map((entry) => entry.id));
  return selectedEntries.value.filter((entry) => !visibleIds.has(entry.id));
});
const selectedOutsideFilter = computed(() => {
  const filteredIds = new Set(filteredEntries.value.map((entry) => entry.id));
  return selectedEntries.value.filter((entry) => !filteredIds.has(entry.id))
    .length;
});
const someSafeSelected = computed(() =>
  visibleSafe.value.some((entry) => selected.value.has(entry.id)),
);
const allSafeSelected = computed(
  () =>
    visibleSafe.value.length > 0 &&
    visibleSafe.value.every((entry) => selected.value.has(entry.id)),
);
watch(
  [query, category, ageFilter, sortBy, scanResult],
  () => {
    currentPage.value = 1;
  },
  { flush: "sync" },
);
const totalBytes = computed(() => summary.value?.totalBytes ?? 0);
const categoryBreakdown = computed(() =>
  ["log", "session", "cache", "protected"].map((key) => {
    const bytes = (scanResult.value?.entries ?? [])
      .filter((entry) => entry.category === key)
      .reduce((sum, entry) => sum + entry.size, 0);
    return {
      key,
      label:
        key === "protected"
          ? "其他受保护"
          : key === "log"
            ? "日志"
            : key === "session"
              ? "会话"
              : "缓存",
      bytes,
      percent: totalBytes.value > 0 ? (bytes / totalBytes.value) * 100 : 0,
    };
  }),
);
const ringGroups = computed(() => {
  let angle = -90;
  return categoryBreakdown.value
    .filter((item) => item.bytes > 0)
    .map((item) => {
      const start = angle;
      const sweep = item.percent * 3.6;
      angle += sweep;
      let fileAngle = start;
      const entries = (scanResult.value?.entries ?? [])
        .filter((entry) => entry.category === item.key && entry.size > 0)
        .sort((a, b) => b.size - a.size);
      // Bound SVG complexity independently of the file table's pagination.
      // Aggregate the smallest files without losing any bytes from the chart.
      const chartItems: { entry: Entry | null; size: number; count: number }[] =
        entries
          .slice(0, 32)
          .map((entry) => ({ entry, size: entry.size, count: 1 }));
      if (entries.length > 32)
        chartItems.push({
          entry: null,
          size: entries.slice(32).reduce((sum, entry) => sum + entry.size, 0),
          count: entries.length - 32,
        });
      const files = chartItems.map((item, index) => {
        const fileStart = fileAngle;
        fileAngle +=
          totalBytes.value > 0 ? (item.size / totalBytes.value) * 360 : 0;
        return {
          ...item,
          index,
          path: arcPath(fileStart, fileAngle, 111, 136),
        };
      });
      return { ...item, path: arcPath(start, angle, 82, 106), files };
    });
});
const focusedChartKey = ref<string | null>(null);
const chartSegments = computed(() =>
  ringGroups.value.flatMap((group) =>
    group.files.map((file) => ({
      ...file,
      category: group.key,
      key: file.entry?.id ?? `${group.key}-remainder`,
    })),
  ),
);
const activeChartKey = computed(() =>
  chartSegments.value.some((segment) => segment.key === focusedChartKey.value)
    ? focusedChartKey.value
    : chartSegments.value[0]?.key,
);
function focusChartSegment(key: string, entry: Entry | null, group: string) {
  focusedChartKey.value = key;
  hoveredFile.value = entry;
  hoveredSpace.value = group;
}
function handleChartKey(event: KeyboardEvent, key: string) {
  const segments = chartSegments.value;
  const index = segments.findIndex((segment) => segment.key === key);
  let nextIndex = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown")
    nextIndex = (index + 1) % segments.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
    nextIndex = (index - 1 + segments.length) % segments.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = segments.length - 1;
  else return;
  event.preventDefault();
  const target = segments[nextIndex];
  if (!target) return;
  focusedChartKey.value = target.key;
  nextTick(() =>
    document
      .querySelector<SVGElement>(`[data-chart-key="${CSS.escape(target.key)}"]`)
      ?.focus(),
  );
}
const chartHasAggregates = computed(() =>
  ringGroups.value.some((group) => group.files.some((file) => !file.entry)),
);
const highlightedSpace = computed(() =>
  categoryBreakdown.value.find(
    (item) => item.key === (hoveredSpace.value || category.value),
  ),
);
const chartBytes = computed(
  () =>
    hoveredFile.value?.size ??
    highlightedSpace.value?.bytes ??
    totalBytes.value,
);
const chartLabel = computed(() =>
  hoveredFile.value
    ? fileName(hoveredFile.value.path)
    : highlightedSpace.value
      ? labels[highlightedSpace.value.key]
      : "已发现逻辑大小",
);
function arcPath(start: number, end: number, inner: number, outer: number) {
  const sweep = Math.min(end - start, 359.9999);
  const point = (radius: number, degrees: number) => {
    const rad = (degrees * Math.PI) / 180;
    return `${150 + radius * Math.cos(rad)},${150 + radius * Math.sin(rad)}`;
  };
  return `M${point(outer, start)} A${outer},${outer} 0 ${sweep > 180 ? 1 : 0},1 ${point(outer, start + sweep)} L${point(inner, start + sweep)} A${inner},${inner} 0 ${sweep > 180 ? 1 : 0},0 ${point(inner, start)} Z`;
}
watch(scanResult, () => {
  inspectedId.value = null;
  hoveredSpace.value = null;
  hoveredFile.value = null;
  focusedChartKey.value = null;
});
const quarantinedCount = computed(() =>
  batches.value.reduce(
    (sum, batch) =>
      sum + batch.items.filter((item) => item.status === "quarantined").length,
    0,
  ),
);
const processRunning = computed(
  () => !!preview.value && preview.value.processStatus?.status !== "clear",
);
const previewExpired = computed(
  () => !!preview.value && now.value > Date.parse(preview.value.expiresAt),
);
const canQuarantine = computed(
  () =>
    !!preview.value &&
    canSign.value &&
    acknowledged.value &&
    (context.value.demo || confirmedClosed.value) &&
    !processRunning.value &&
    !previewExpired.value &&
    !error.value &&
    !busy.value,
);
const canTrash = computed(() =>
  trashConsent.ready(
    trashTarget.value,
    context.value,
    !!busy.value,
    canSign.value,
    now.value,
  ),
);
const modalOpen = computed(
  () =>
    !!preview.value ||
    !!restoreTarget.value ||
    !!trashTarget.value ||
    !!operation.value ||
    !!focusedEntry.value ||
    !!sessionBulkReview.value ||
    !!adminAction.value,
);
const modalKind = computed(() =>
  preview.value
    ? `preview-${preview.value.token}`
    : restoreTarget.value
      ? "restore"
      : trashTarget.value
        ? "trash"
        : operation.value
          ? `result-${operation.value.type}`
          : focusedEntry.value
            ? "file-detail"
            : sessionBulkReview.value
              ? "session-bulk-review"
              : (adminAction.value ?? ""),
);
let focusBeforeModal: HTMLElement | null = null;
let bodyOverflowBeforeModal = "";
function rememberModalTrigger() {
  if (
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body &&
    !document.activeElement.closest(".modal")
  )
    focusBeforeModal = document.activeElement;
}
async function reviewInterruptedOperation() {
  if (busy.value) return;
  closeModal();
  await navigate("history");
}
watch(
  [minAgeDays, includeSessions],
  () => {
    scanResult.value = null;
    resetScanFeedback();
    selected.value = new Set();
    preview.value = null;
    if (context.value.root)
      notice.value = "扫描条件已更新，请重新扫描后选择项目。";
  },
  { flush: "sync" },
);
watch(modalOpen, async (open) => {
  if (open) {
    bodyOverflowBeforeModal = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!focusBeforeModal) rememberModalTrigger();
    await nextTick();
    (document.querySelector(".modal") as HTMLElement | null)?.focus();
  } else {
    document.body.style.overflow = bodyOverflowBeforeModal;
    await nextTick();
    if (
      focusBeforeModal?.isConnected &&
      !focusBeforeModal.matches(":disabled") &&
      !focusBeforeModal.closest("[inert]")
    )
      focusBeforeModal.focus();
    else
      document
        .querySelector<HTMLElement>(".scan-heading h1, .page-title h1")
        ?.focus();
    focusBeforeModal = null;
  }
});

watch(modalKind, async (kind, previousKind) => {
  if (kind && previousKind && kind !== previousKind) {
    await nextTick();
    document.querySelector<HTMLElement>(".modal")?.focus();
  }
});

watch(error, async (message) => {
  if (!message || !modalOpen.value) return;
  await nextTick();
  document.querySelector<HTMLElement>(".modal-error")?.focus();
});

function sizeParts(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return {
    value: value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1),
    unit: units[i],
  };
}
function formatSize(bytes: number) {
  const s = sizeParts(bytes);
  return `${s.value} ${s.unit}`;
}
function date(value: number | string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
function parentPath(path: string) {
  const bits = path.split(/[\\/]/);
  bits.pop();
  return bits.join("/") || "/";
}
function percentLabel(value: number) {
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}
function ageLabel(days: number) {
  return days < 1 ? "今天" : `${Math.floor(days)} 天前`;
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function dismissError() {
  error.value = "";
}
async function run(label: string, action: () => Promise<void>) {
  if (busy.value) return;
  if (!apiAvailable.value) {
    error.value =
      "桌面接口未连接。请通过 Electron 启动 AgentVac，以使用真实的本地扫描与隔离功能。";
    return;
  }
  busy.value = label;
  error.value = "";
  operationInterrupted.value = false;
  notice.value = "";
  try {
    await action();
  } catch (e) {
    const message = errorText(e);
    if (message.includes("诊断已取消")) {
      diagnosticResult.value = null;
      deepConfirmedClosed.value = false;
      notice.value = "诊断已取消，未修改源文件。本次结果已清空，可重新读取。";
    } else if (message.includes("扫描已取消")) {
      notice.value = "扫描已取消，未修改任何文件。可以随时重新扫描。";
      scanResult.value = null;
      selected.value = new Set();
    } else {
      error.value = message;
      const knownBeforeWrite =
        /回收站确认已失效|检测到 .+ 正在运行|无法确认进程状态|预览已失效|请先确认已退出全部|当前或活动数据保护范围/.test(
          message,
        );
      operationInterrupted.value =
        ["正在隔离", "正在恢复", "移入系统回收站"].includes(label) &&
        !knownBeforeWrite;
      if (operationInterrupted.value) {
        scanResult.value = null;
        resetScanFeedback();
        selected.value = new Set();
      }
    }
  } finally {
    busy.value = "";
    cancelPending.value = false;
  }
}
function retainedBatchPath(batch: Batch) {
  const separator = batch.root.includes("\\") ? "\\" : "/";
  return (
    batch.root.replace(/[\\/]$/, "") +
    separator +
    ".agentvac-quarantine" +
    separator +
    batch.id
  );
}
async function openBatch(batch: Batch) {
  await run("打开留存批次", async () => {
    await window.agentvac.openBatchQuarantine(batch.id);
    notice.value =
      "已打开此批次的留存文件夹；请保留全部文件，不要编辑签名清单。";
  });
}
async function refreshHistory() {
  batches.value = await window.agentvac.history();
}
function resetRoot(next: AppContext) {
  resetTrashConsent();
  conversationArchiveIds.value = [];
  conversationArchiveTitles.value = [];
  conversationRevision.value++;
  resetScanFeedback();
  scanLimit.value = 50000;
  context.value = next;
  diagnosticResult.value = null;
  diagnosticWorkspaceIds.value = new Set();
  restoreTarget.value = null;
  trashTarget.value = null;
  confirmedClosed.value = false;
  acknowledged.value = false;
  scanResult.value = null;
  selected.value = new Set();
  query.value = "";
  category.value = "all";
  ageFilter.value = "all";
  sortBy.value = "size";
  preview.value = null;
  operation.value = null;
  includeSessions.value = false;
  batches.value = [];
  recoveryInspection.value = null;
}
async function chooseRoot() {
  await run("选择目录", async () => {
    const result = await window.agentvac.chooseRoot();
    if (result) {
      resetRoot(result);
      await refreshAppData();
      await refreshHistory();
      notice.value = "目录已连接。扫描仅查看文件元数据，不会修改文件。";
    }
  });
}
async function loadDemo() {
  await run("准备演示", async () => {
    resetRoot(await window.agentvac.loadDemo());
    page.value = "scan";
    await refreshAppData();
    await performScan();
    await refreshHistory();
    notice.value = "演示扫描完成。所有操作只影响独立演示目录。";
  });
}
async function cancelScan() {
  const requestId = activeScanRequestId.value;
  if (!isScanning.value || !requestId || cancelPending.value) return;
  cancelPending.value = true;
  try {
    await window.agentvac.cancelScan(requestId);
  } catch (e) {
    if (activeScanRequestId.value === requestId) {
      error.value = errorText(e);
      cancelPending.value = false;
    }
  }
}
function resetScanFeedback() {
  activeScanRequestId.value = null;
  scanProgress.value = null;
  scanState.value = "idle";
  scanStartedAt.value = 0;
}
function receiveScanProgress(progress: ScanProgress) {
  if (
    !activeScanRequestId.value ||
    progress.requestId !== activeScanRequestId.value ||
    progress.root !== context.value.root ||
    (progress.provider !== undefined &&
      progress.provider !== selectedProvider.value) ||
    (scanProgress.value && progress.elapsedMs < scanProgress.value.elapsedMs)
  )
    return;
  if (
    scanProgress.value?.phase !== undefined &&
    scanProgress.value.phase !== "scanning" &&
    progress.phase === "scanning"
  )
    return;
  scanProgress.value = progress;
}
function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${seconds} 秒`;
}
async function performScan(limit: 50000 | 100000 = scanLimit.value) {
  const requestId = crypto.randomUUID();
  const root = context.value.root;
  const provider = selectedProvider.value;
  activeScanRequestId.value = requestId;
  scanLimit.value = limit;
  scanProgress.value = null;
  scanState.value = "scanning";
  scanStartedAt.value = Date.now();
  now.value = scanStartedAt.value;
  scanResult.value = null;
  selected.value = new Set();
  try {
    const result = await window.agentvac.scan({
      minAgeDays: minAgeDays.value,
      includeSessions: includeSessions.value,
      maxEntries: limit,
      requestId,
    });
    if (
      activeScanRequestId.value !== requestId ||
      context.value.root !== root ||
      selectedProvider.value !== provider
    )
      throw new Error("扫描范围已变化，请重新扫描。");
    scanResult.value = result;
    scanState.value = result.status ?? "complete";
    return result;
  } catch (cause) {
    if (activeScanRequestId.value === requestId) {
      scanState.value = errorText(cause).includes("扫描已取消")
        ? "cancelled"
        : "error";
      scanResult.value = null;
      selected.value = new Set();
    }
    throw cause;
  } finally {
    if (activeScanRequestId.value === requestId)
      activeScanRequestId.value = null;
  }
}
async function scan(limit: 50000 | 100000 = scanLimit.value) {
  if (!context.value.root) return;
  await run("正在扫描", async () => {
    await performScan(limit);
    await refreshHistory();
  });
}
async function navigate(next: typeof page.value) {
  if (busy.value) return;
  page.value = next;
  if (next === "history" && context.value.root)
    await run("读取隔离记录", refreshHistory);
  if ((next === "manage" || next === "diagnostics") && managementAvailable)
    await run("读取目录状态", refreshAppData);
}
function selectCategory(key: string) {
  if (busy.value) return;
  page.value = "scan";
  category.value = key;
}
function inspectEntry(entry: Entry) {
  inspectedId.value = entry.id;
  activeRowId.value = entry.id;
}
function tableDate(value: number) {
  return new Date(value)
    .toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replaceAll("/", "-");
}
async function copyRoot() {
  if (!context.value.root) return;
  try {
    await window.agentvac.copyRootPath();
    notice.value = "目录路径已复制。";
  } catch {
    error.value = "无法访问剪贴板。可在顶部路径栏选择并复制路径。";
  }
}
function handleRowKey(event: KeyboardEvent, entry: Entry, index: number) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter") {
    event.preventDefault();
    inspectEntry(entry);
  }
  if (event.key === " ") {
    event.preventDefault();
    toggleEntry(entry);
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const targetIndex = Math.max(
      0,
      Math.min(
        shownEntries.value.length - 1,
        index + (event.key === "ArrowDown" ? 1 : -1),
      ),
    );
    const targetEntry = shownEntries.value[targetIndex];
    if (targetEntry) inspectEntry(targetEntry);
    (
      document.querySelector(
        `[data-row-index="${targetIndex}"]`,
      ) as HTMLElement | null
    )?.focus();
  }
}
function selectionLimitNotice() {
  notice.value =
    "每批最多选择 5,000 个项目。请先完成当前批次，再处理其他项目。";
}
function toggleEntry(entry: Entry) {
  if (!entry.selectable || busy.value) return;
  const next = new Set(selected.value);
  if (next.has(entry.id)) next.delete(entry.id);
  else {
    if (next.size >= maxSelection) {
      selectionLimitNotice();
      return;
    }
    next.add(entry.id);
  }
  selected.value = next;
}
function selectSafe() {
  if (busy.value || partialScan.value) return;
  const next = new Set(selected.value);
  if (allSafeSelected.value)
    visibleSafe.value.forEach((entry) => next.delete(entry.id));
  else {
    const newEntries = visibleSafe.value.filter((entry) => !next.has(entry.id));
    if (next.size + newEntries.length > maxSelection) {
      selectionLimitNotice();
      return;
    }
    newEntries.forEach((entry) => next.add(entry.id));
  }
  selected.value = next;
}
function bulkSelectionLimitNotice() {
  notice.value =
    "当前筛选超过每批 5,000 项的上限。请缩小筛选范围或分批选择；当前选择未改变。";
}
function replaceSelection(entries: Entry[]) {
  if (busy.value || partialScan.value || !entries.length) return false;
  if (entries.length > maxSelection) {
    bulkSelectionLimitNotice();
    return false;
  }
  selected.value = new Set(entries.map((entry) => entry.id));
  notice.value = "";
  return true;
}
function selectFilteredSafe() {
  if (modalOpen.value) return;
  replaceSelection(filteredSafeEntries.value);
}
function requestSessionBulkSelection() {
  if (
    busy.value ||
    modalOpen.value ||
    !sessionBulkAvailable.value ||
    partialScan.value ||
    !scanResult.value
  )
    return;
  const entries = filteredSessionEntries.value;
  if (!entries.length) return;
  if (entries.length > maxSelection) {
    bulkSelectionLimitNotice();
    return;
  }
  rememberModalTrigger();
  sessionBulkAcknowledged.value = false;
  sessionBulkReview.value = {
    entries: [...entries],
    scanId: scanResult.value.id,
    query: query.value,
    age: ageFilter.value,
  };
}
function confirmSessionBulkSelection() {
  const review = sessionBulkReview.value;
  if (busy.value || !review || !sessionBulkAcknowledged.value) return;
  const currentIds = new Set(
    filteredSessionEntries.value.map((entry) => entry.id),
  );
  if (
    !sessionBulkAvailable.value ||
    partialScan.value ||
    scanResult.value?.id !== review.scanId ||
    currentIds.size !== review.entries.length ||
    review.entries.some((entry) => !currentIds.has(entry.id))
  ) {
    closeModal();
    notice.value = "筛选或扫描结果已变化。当前选择未改变，请重新审阅会话范围。";
    return;
  }
  if (replaceSelection(review.entries)) closeModal();
}
function clearHiddenSelection() {
  if (busy.value) return;
  notice.value = "";
  const visibleIds = new Set(shownEntries.value.map((entry) => entry.id));
  selected.value = new Set(
    [...selected.value].filter((id) => visibleIds.has(id)),
  );
  nextTick(() => {
    if (selected.value.size)
      document
        .querySelector<HTMLElement>('[data-testid="preview-selection"]')
        ?.focus();
    else document.querySelector<HTMLElement>(".scan-heading h1")?.focus();
  });
}
function goToPage(nextPage: number) {
  if (busy.value || nextPage < 1 || nextPage > totalPages.value) return;
  currentPage.value = nextPage;
  nextTick(() => {
    const scrollArea = document.querySelector(".table-scroll");
    if (scrollArea) scrollArea.scrollTop = 0;
  });
}
function showConversationPreview(result: ConversationArchivePreview) {
  rememberModalTrigger();
  error.value = "";
  operationInterrupted.value = false;
  conversationArchiveIds.value = result.conversations.map((item) => item.id);
  conversationArchiveTitles.value = result.conversations.map(
    (item) => item.title,
  );
  preview.value = result.preview;
  acknowledged.value = false;
  confirmedClosed.value = false;
  now.value = Date.now();
}
let conversationBusyLabel = "";
function setConversationBusy(label: string) {
  if (label) {
    if (busy.value && busy.value !== conversationBusyLabel) return;
    conversationBusyLabel = label;
    busy.value = label;
  } else {
    if (busy.value === conversationBusyLabel) busy.value = "";
    conversationBusyLabel = "";
  }
}
async function showPreview() {
  if (conversationArchiveIds.value.length) {
    await run("重新检查所选对话", async () => {
      showConversationPreview(
        await (
          window.agentvac as typeof window.agentvac & ConversationAPI
        ).previewConversationArchive(conversationArchiveIds.value),
      );
    });
    return;
  }
  if (!selected.value.size) return;
  if (!modalOpen.value) rememberModalTrigger();
  await run("检查所选项目", async () => {
    preview.value = await window.agentvac.preview([...selected.value]);
    acknowledged.value = false;
    confirmedClosed.value = false;
    now.value = Date.now();
  });
}
async function quarantine() {
  if (!canQuarantine.value || !preview.value) return;
  const token = preview.value.token;
  const conversationOperation = conversationArchiveIds.value.length > 0;
  await run("正在隔离", async () => {
    const result = await window.agentvac.quarantine(
      token,
      confirmedClosed.value,
    );
    preview.value = null;
    selected.value = new Set();
    operation.value = { ...result, type: "quarantine" };
    await refreshHistory();
    if (conversationOperation) conversationRevision.value++;
    else await performScan();
  });
  if (conversationOperation && operationInterrupted.value)
    conversationRevision.value++;
}
let trashCancellation: Promise<void> = Promise.resolve();
function resetTrashConsent() {
  const token = trashConsent.reset();
  if (token) {
    trashCancellation = trashCancellation
      .then(() => window.agentvac.cancelTrashConfirmation(token))
      .catch(() => {
        notice.value = "旧的回收站确认未能撤销；请重新打开批次后再确认。";
      });
  }
}
async function requestTrash(batch: Batch) {
  if (busy.value || !canSign.value) return;
  rememberModalTrigger();
  resetTrashConsent();
  error.value = "";
  operationInterrupted.value = false;
  trashTarget.value = batch;
  const generation = trashConsent.generation();
  await run("检查回收站批次", async () => {
    // Preserve main's single-operation gate when a dialog is reopened quickly.
    await trashCancellation;
    const challenge = await window.agentvac.prepareTrash(batch.id);
    if (
      !trashTarget.value ||
      !trashConsent.accept(
        generation,
        challenge,
        trashTarget.value,
        context.value,
      )
    ) {
      await window.agentvac.cancelTrashConfirmation(challenge.token);
      throw new Error("回收站确认已失效；请重新打开此批次并重新确认。");
    }
    now.value = Date.now();
  });
}
async function trash() {
  const args = trashConsent.consume(
    trashTarget.value,
    context.value,
    !!busy.value,
    canSign.value,
    Date.now(),
  );
  if (!args) return;
  // Consume all renderer consent before the first await. Failures and duplicate
  // clicks can never reuse it; retry requires reopening the batch.
  await run("移入系统回收站", async () => {
    const result = await window.agentvac.trash(...args);
    trashTarget.value = null;
    operation.value = { ...result, type: "trash" };
    await refreshHistory();
  });
}
function requestRestore(batch: Batch) {
  if (busy.value) return;
  rememberModalTrigger();
  error.value = "";
  operationInterrupted.value = false;
  confirmedClosed.value = false;
  restoreTarget.value = batch;
}
async function restore() {
  if (!restoreTarget.value || (!context.value.demo && !confirmedClosed.value))
    return;
  const id = restoreTarget.value.id;
  await run("正在恢复", async () => {
    const result = await window.agentvac.restore(id, confirmedClosed.value);
    restoreTarget.value = null;
    operation.value = { ...result, type: "restore" };
    await refreshHistory();
    if (scanResult.value) {
      await performScan();
      selected.value = new Set();
    }
  });
}
async function openQuarantine() {
  await run("打开隔离目录", () => window.agentvac.openQuarantine());
}
function closeModal() {
  if (busy.value) return;
  resetTrashConsent();
  conversationArchiveIds.value = [];
  conversationArchiveTitles.value = [];
  preview.value = null;
  restoreTarget.value = null;
  trashTarget.value = null;
  operation.value = null;
  focusedEntry.value = null;
  sessionBulkReview.value = null;
  sessionBulkAcknowledged.value = false;
  adminAction.value = null;
  adminAcknowledged.value = false;
}
async function refreshAppData() {
  if (!managementAvailable) return;
  try {
    appData.value = await window.agentvac.getAppData();
    appDataError.value = "";
    const validIds = new Set(
      appData.value.workspaces.entries
        .filter((item) => item.status === "available")
        .map((item) => item.id),
    );
    const retained = [...diagnosticWorkspaceIds.value].filter((id) =>
      validIds.has(id),
    );
    if (retained.length !== diagnosticWorkspaceIds.value.size)
      diagnosticWorkspaceIds.value = new Set(retained);
  } catch (cause) {
    appData.value = null;
    appDataError.value = errorText(cause);
  }
}
async function restoreUtilityFocus(trigger: Element | null) {
  await nextTick();
  if (
    trigger instanceof HTMLElement &&
    trigger.isConnected &&
    !trigger.matches(":disabled") &&
    !trigger.closest("[inert]")
  )
    trigger.focus();
  else
    document
      .querySelector<HTMLElement>(".scan-heading h1, .page-title h1")
      ?.focus();
}
async function activateWorkspace(workspace: WorkspaceDescription) {
  if (
    busy.value ||
    workspace.status !== "available" ||
    !window.agentvac.activateWorkspace
  )
    return;
  const trigger = document.activeElement;
  await run("切换已选目录", async () => {
    const next = await window.agentvac.activateWorkspace(workspace.id);
    if (isCleanupWorkspace(workspace.kind)) {
      resetRoot(next);
      await refreshHistory();
      page.value = "scan";
    } else {
      diagnosticWorkspaceIds.value = new Set([workspace.id]);
      page.value = "diagnostics";
    }
    await refreshAppData();
    notice.value = isCleanupWorkspace(workspace.kind)
      ? "目录已连接，点击开始扫描后读取文件元数据。"
      : "诊断位置已确认；请在空间诊断中勾选并读取。";
  });
  await restoreUtilityFocus(trigger);
}
async function activateCandidate(candidate: AppDataView["candidates"][number]) {
  if (busy.value || !window.agentvac.activateCandidate) return;
  const trigger = document.activeElement;
  await run("确认建议位置", async () => {
    const next = await window.agentvac.activateCandidate(candidate.id);
    if (isCleanupCandidate(candidate.kind)) {
      resetRoot(next);
      await refreshHistory();
      page.value = "scan";
    }
    await refreshAppData();
    notice.value = isCleanupCandidate(candidate.kind)
      ? "已连接你选择的建议目录，尚未扫描文件。"
      : "已添加诊断位置，尚未读取其中内容。";
  });
  await restoreUtilityFocus(trigger);
}
async function forgetWorkspace(workspace: WorkspaceDescription) {
  if (busy.value || !window.agentvac.forgetWorkspace) return;
  const trigger = document.activeElement;
  await run("移除目录记录", async () => {
    appData.value = await window.agentvac.forgetWorkspace(workspace.id);
    const next = new Set(diagnosticWorkspaceIds.value);
    next.delete(workspace.id);
    diagnosticWorkspaceIds.value = next;
    notice.value = "已移除这条最近目录记录，目录与文件未删除。";
    const current = await window.agentvac.getContext();
    if (
      current.root !== context.value.root ||
      current.provider !== context.value.provider
    )
      resetRoot(current);
  });
  await restoreUtilityFocus(trigger);
}
async function chooseDiagnosticRoot(kind: "sqlite" | "logs") {
  if (!window.agentvac.chooseDiagnosticRoot) return;
  await run("选择诊断位置", async () => {
    const result = await window.agentvac.chooseDiagnosticRoot(kind);
    if (result) {
      appData.value = result;
      notice.value = "已保存你选择的诊断位置。勾选范围后，点击只读统计。";
    }
  });
}
function toggleDiagnosticWorkspace(workspace: WorkspaceDescription) {
  if (busy.value || workspace.status !== "available") return;
  const next = new Set(diagnosticWorkspaceIds.value);
  if (next.has(workspace.id)) next.delete(workspace.id);
  else {
    if (next.size >= 8) {
      notice.value = "一次最多诊断 8 个已选位置，请分批读取。";
      return;
    }
    next.add(workspace.id);
  }
  diagnosticWorkspaceIds.value = next;
}
async function readDiagnostics(withDeepCheck = false) {
  if (
    !window.agentvac.diagnoseStorage ||
    !diagnosticWorkspaceIds.value.size ||
    busy.value
  )
    return;
  if (
    withDeepCheck &&
    (!deepEnabled.value ||
      !deepConfirmedClosed.value ||
      !deepDatabaseOptions.value.some(
        (file) => file.path === deepDatabasePath.value,
      ))
  )
    return;
  const requestId = crypto.randomUUID();
  const request: DiagnoseRequest = {
    requestId,
    workspaceIds: [...diagnosticWorkspaceIds.value],
    configOptIn: diagnosticConfigOptIn.value,
  };
  if (withDeepCheck)
    request.deepCheck = {
      enabled: true,
      databasePath: deepDatabasePath.value,
      confirmedClosed: deepConfirmedClosed.value,
    };
  await run(withDeepCheck ? "只读深入检查" : "读取空间诊断", async () => {
    activeDiagnosisRequestId.value = requestId;
    diagnosisCancelPending.value = false;
    diagnosticResult.value = null;
    nextTick(() => {
      if (activeDiagnosisRequestId.value === requestId)
        document
          .querySelector<HTMLElement>('[data-testid="cancel-diagnosis"]')
          ?.focus();
    });
    try {
      const result = await window.agentvac.diagnoseStorage(request);
      if (activeDiagnosisRequestId.value !== requestId) return;
      diagnosticResult.value = result;
      if (
        !deepDatabaseOptions.value.some(
          (file) => file.path === deepDatabasePath.value,
        )
      )
        deepDatabasePath.value = deepDatabaseOptions.value[0]?.path ?? "";
      await refreshAppData();
    } finally {
      if (activeDiagnosisRequestId.value === requestId) {
        activeDiagnosisRequestId.value = null;
        diagnosisCancelPending.value = false;
      }
    }
  });
  await nextTick();
  if (page.value === "diagnostics" && !activeDiagnosisRequestId.value) {
    const target = diagnosticResult.value
      ? withDeepCheck
        ? "#deep-check-title"
        : "#diagnostic-sample-title"
      : '[data-testid="run-diagnostics"]';
    document.querySelector<HTMLElement>(target)?.focus();
  }
}
async function cancelDiagnosis() {
  const requestId = activeDiagnosisRequestId.value;
  if (
    !requestId ||
    diagnosisCancelPending.value ||
    !diagnosisCancellationAvailable
  )
    return;
  diagnosisCancelPending.value = true;
  try {
    await window.agentvac.cancelDiagnosis(requestId);
  } catch (cause) {
    if (activeDiagnosisRequestId.value === requestId) {
      error.value = errorText(cause);
      diagnosisCancelPending.value = false;
    }
  }
}
function diagnosticRole(path: string) {
  const name = fileName(path);
  if (/^logs_\d+\.sqlite(?:-(?:wal|shm|journal))?$/.test(name))
    return "Codex 日志库 · 保留";
  if (/^state.*\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/.test(name))
    return "状态数据库 · 始终保护";
  return /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/.test(name)
    ? "其他数据库 · 始终保护"
    : "普通日志 · 仅统计";
}
function nullableSize(bytes: number | null) {
  return bytes === null ? "未知" : formatSize(bytes);
}
function requestAdminAction(action: NonNullable<typeof adminAction.value>) {
  if (busy.value || !managementAvailable) return;
  if (
    action === "reset-demo" &&
    (!appData.value?.demo.canReset || !canSign.value)
  )
    return;
  rememberModalTrigger();
  error.value = "";
  adminAcknowledged.value = false;
  adminAction.value = action;
}
async function confirmAdminAction() {
  const action = adminAction.value;
  if (!action || !adminAcknowledged.value || busy.value) return;
  if (
    action === "reset-demo" &&
    (!appData.value?.demo.canReset || !canSign.value)
  )
    return;
  let finished = false;
  await run(
    action === "import-keys"
      ? "导入恢复密钥"
      : action === "export-keys"
        ? "导出恢复密钥"
        : "重置演示目录",
    async () => {
      if (action === "import-keys") {
        const reply = await window.agentvac.importRecoveryKeys(true);
        if (reply.canceled) {
          notice.value = "已取消导入，未选择恢复备份。";
          finished = true;
          return;
        }
        if (!reply.result)
          throw new Error("未收到导入结果，请刷新恢复状态后核实。");
        keyTransferReceipt.value = {
          kind: "import",
          message: `新增 ${reply.result.addedKeyIds.length} 个恢复密钥，${reply.result.duplicateKeyIds.length} 个已存在。导入不代表隔离批次已经认证。`,
          keyIds: reply.result.addedKeyIds,
        };
        resetRoot(await window.agentvac.getContext());
        await refreshAppData();
        if (context.value.root) await refreshHistory();
        notice.value =
          "恢复密钥已导入，旧扫描和选择已清空。请重新核实隔离记录。";
      } else if (action === "export-keys") {
        const reply = await window.agentvac.exportRecoveryKeys(true);
        if (reply.canceled) {
          notice.value = "已取消导出，未保存恢复备份。";
          finished = true;
          return;
        }
        if (!reply.result)
          throw new Error("未收到保存结果，请核实你选择的备份位置。");
        keyTransferReceipt.value = {
          kind: "export",
          message: `已导出 ${reply.result.keyIds.length} 个恢复密钥。请离线妥善保存，不要分享备份文件。`,
          path: reply.result.path,
          keyIds: reply.result.keyIds,
        };
        notice.value = "恢复备份已保存。请妥善保管其中的敏感恢复材料。";
      } else {
        if (context.value.demo) {
          scanResult.value = null;
          selected.value = new Set();
          resetScanFeedback();
        }
        try {
          resetRoot(await window.agentvac.resetDemo(true));
          page.value = "scan";
          await refreshAppData();
          await refreshHistory();
          notice.value = "演示目录已重置，可以开始扫描。";
        } catch (cause) {
          const latest = await window.agentvac.getContext().catch(() => null);
          if (latest) resetRoot(latest);
          await refreshAppData();
          throw cause;
        }
      }
      finished = true;
    },
  );
  if (finished) closeModal();
}
async function inspectRecovery() {
  if (!context.value.root || !window.agentvac.inspectRecovery) return;
  await run("只读检查隔离区", async () => {
    recoveryInspection.value = await window.agentvac.inspectRecovery();
  });
}
async function openSystemTrash() {
  if (!window.agentvac.openSystemTrash) return;
  await run("打开系统回收站", () => window.agentvac.openSystemTrash());
}
function handleKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeModal();
  if (e.key !== "Tab" || !modalOpen.value) return;
  const modal = document.querySelector(".modal") as HTMLElement | null;
  const controls = modal
    ? Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      )
    : [];
  const first = controls[0],
    last = controls[controls.length - 1];
  if (!first) {
    e.preventDefault();
    modal?.focus();
    return;
  }
  if (!modal?.contains(document.activeElement)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (
    e.shiftKey &&
    (document.activeElement === first || document.activeElement === modal)
  ) {
    e.preventDefault();
    last.focus();
  } else if (
    !e.shiftKey &&
    (document.activeElement === last || document.activeElement === modal)
  ) {
    e.preventDefault();
    first.focus();
  }
}
onMounted(async () => {
  if (apiAvailable.value) {
    const unsubscribe = window.agentvac.onScanProgress?.(receiveScanProgress);
    if (typeof unsubscribe === "function")
      unsubscribeScanProgress = unsubscribe;
  }
  colorSchemeQuery.addEventListener("change", updateSystemTheme);
  document.addEventListener("keydown", handleKey);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  if (apiAvailable.value)
    await run("连接本地工作空间", async () => {
      const [appContext] = await Promise.all([
        window.agentvac.getContext(),
        loadThemePreference(),
        refreshAppData(),
      ]);
      context.value = appContext;
      if (context.value.root) await refreshHistory();
    });
});
onUnmounted(() => {
  unsubscribeScanProgress?.();
  activeScanRequestId.value = null;
  colorSchemeQuery.removeEventListener("change", updateSystemTheme);
  document.body.style.overflow = bodyOverflowBeforeModal;
  document.removeEventListener("keydown", handleKey);
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" aria-label="工作空间导航" :inert="modalOpen">
      <div class="app-brand">
        <span class="brand-mark"
          ><svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <path
              d="M6 21 12 7h4l6 14M9 16h10"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M12 21h4"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            /></svg></span
        ><strong>AgentVac</strong>
      </div>
      <div class="nav-eyebrow">工作空间</div>
      <nav class="primary-nav" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :aria-label="item.accessible"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :disabled="!!busy"
          @click="navigate(item.id)"
        >
          <Icon :name="item.icon" :size="17" /><span>{{
            item.id === "scan" ? "空间分析" : item.label
          }}</span
          ><span
            v-if="item.id === 'history' && quarantinedCount"
            class="nav-count"
            >{{ quarantinedCount }}</span
          >
        </button>
      </nav>
      <div class="sidebar-section">
        <h2>文件分类</h2>
        <button
          class="category-nav"
          aria-label="全部文件"
          :class="{ active: page === 'scan' && category === 'all' }"
          :aria-pressed="page === 'scan' && category === 'all'"
          :disabled="!!busy"
          @click="selectCategory('all')"
        >
          <Icon name="folder" :size="16" /><span>全部文件</span
          ><span class="category-count">{{
            scanResult?.entries.length ?? "—"
          }}</span></button
        ><button
          v-for="item in categoryBreakdown"
          :key="item.key"
          :class="[
            'category-nav',
            { active: page === 'scan' && category === item.key },
          ]"
          :disabled="!!busy"
          :aria-pressed="page === 'scan' && category === item.key"
          @click="selectCategory(item.key)"
        >
          <span :class="['category-square', item.key]" /><span>{{
            item.key === "protected" ? "其他受保护" : labels[item.key]
          }}</span
          ><span class="category-count">{{
            scanResult ? categoryCounts[item.key] : "—"
          }}</span>
        </button>
      </div>
      <div class="sidebar-section sidebar-source">
        <h2>当前目录</h2>
        <div class="source-name">
          <Icon name="terminal" :size="16" /><span>{{
            context.demo
              ? "演示目录"
              : context.root
                ? fileName(context.root)
                : "未选择目录"
          }}</span>
        </div>
        <p v-if="context.demo">独立测试数据</p>
        <p v-else>
          {{ context.root ? providerLabel + " 本地数据" : "等待连接本地目录" }}
        </p>
        <span v-if="context.demo" class="demo-pill">演示模式</span>
      </div>
      <div class="theme-switcher" role="group" aria-label="外观主题">
        <button
          v-for="theme in themeOptions"
          :key="theme.value"
          :aria-label="theme.accessible"
          :aria-pressed="themeMode === theme.value"
          :title="
            theme.value === 'system'
              ? '跟随系统外观，当前为' +
                (resolvedTheme === 'dark' ? '深色' : '浅色')
              : theme.label + '主题'
          "
          :class="{ active: themeMode === theme.value }"
          @click="chooseTheme(theme.value)"
        >
          <Icon :name="theme.icon" :size="12" /><span>{{ theme.label }}</span>
        </button>
      </div>
      <div class="sidebar-footer">
        <span><Icon name="lock" :size="12" />仅本地运行</span
        ><small>v{{ appVersion }}</small>
      </div>
    </aside>
    <main class="main-area" :inert="modalOpen">
      <header class="toolbar">
        <label class="provider-control">
          <span class="visually-hidden">数据提供方</span>
          <select
            aria-label="数据提供方"
            :value="selectedProvider"
            :disabled="!!busy || !apiAvailable || modalOpen"
            @change="chooseProvider"
          >
            <option
              v-for="provider in providerOptions"
              :key="provider.id"
              :value="provider.id"
            >
              {{ provider.label }}
            </option>
          </select>
        </label>
        <div class="path-control">
          <Icon name="folder" :size="17" /><input
            :value="context.root || ''"
            readonly
            aria-label="当前目录路径"
            :placeholder="`选择 ${providerLabel} 数据目录`"
          /><button
            class="icon-button"
            title="复制目录路径"
            aria-label="复制目录路径"
            :disabled="!context.root || !!busy"
            @click="copyRoot"
          >
            <Icon name="file" :size="14" />
          </button>
        </div>
        <button
          class="button secondary"
          :disabled="!!busy || !apiAvailable"
          @click="chooseRoot"
        >
          {{
            context.root ? "切换目录" : "选择 " + providerLabel + " 目录"
          }}</button
        ><template v-if="page === 'scan'"
          ><button
            v-if="isScanning"
            class="button secondary"
            :disabled="cancelPending"
            @click="cancelScan"
          >
            {{ cancelPending ? "正在取消…" : "取消扫描" }}</button
          ><button
            v-else
            class="button primary"
            :disabled="!!busy || !context.root"
            @click="scan()"
          >
            <Icon :name="scanResult ? 'refresh' : 'scan'" :size="15" />开始扫描
          </button></template
        ><button
          v-else-if="page === 'history'"
          class="button secondary"
          :disabled="!!busy || !context.root"
          @click="openQuarantine"
        >
          <Icon name="folder" :size="15" />打开隔离目录
        </button>
        <button
          v-if="page === 'history' && systemTrashAvailable"
          class="button secondary"
          :disabled="!!busy"
          @click="openSystemTrash"
          data-testid="open-system-trash"
        >
          <Icon name="trash" :size="15" />打开系统回收站
        </button>
        <button
          v-if="
            (page === 'manage' || page === 'diagnostics') && managementAvailable
          "
          class="button secondary"
          :disabled="!!busy"
          @click="run('读取目录状态', refreshAppData)"
        >
          <Icon name="refresh" :size="15" />刷新状态
        </button>
      </header>
      <p class="provider-scope" role="note">
        <span class="provider-badge">{{ providerLabel }}</span
        >{{ providerScope }}
      </p>
      <div v-if="!apiAvailable" class="message-banner warning">
        <Icon name="info" :size="16" /><span
          >界面预览模式。请通过 Electron 启动应用以操作本地文件。</span
        >
      </div>
      <div
        v-if="managementAvailable && !canSign"
        class="message-banner warning signing-warning"
        data-testid="signing-warning"
      >
        <Icon name="shield" :size="16" /><span>{{
          appData
            ? "恢复签名不可用：新隔离和移入回收站已暂停；已认证的旧批次仍可恢复。"
            : "恢复能力尚未验证：新隔离和移入回收站暂不可用。"
        }}</span>
        <button
          class="text-button"
          :disabled="!!busy"
          @click="navigate('manage')"
        >
          查看恢复状态
        </button>
      </div>
      <div v-if="error" class="message-banner error" role="alert">
        <Icon name="alert" :size="16" /><span>{{ error }}</span
        ><button
          class="icon-button"
          aria-label="关闭错误提示"
          @click="dismissError"
        >
          <Icon name="x" :size="15" />
        </button>
      </div>
      <div v-if="notice" class="notice-line" role="status">
        <Icon name="info" :size="14" /><span>{{ notice }}</span
        ><button class="icon-button" aria-label="关闭提示" @click="notice = ''">
          <Icon name="x" :size="14" />
        </button>
      </div>
      <ConversationWorkspace
        v-if="page === 'conversations'"
        :key="`${selectedProvider}:${context.root}`"
        :context="context"
        :busy="!!busy"
        :can-sign="canSign"
        :revision="conversationRevision"
        @choose-root="chooseRoot"
        @history="navigate('history')"
        @archive-preview="showConversationPreview"
        @busy-change="setConversationBusy"
      />
      <div v-else-if="page === 'scan'" class="scan-content">
        <section class="scan-heading">
          <div class="heading-copy">
            <span class="page-eyebrow">{{ providerLabel }} · 本地数据</span>
            <h1 tabindex="-1">空间分析</h1>
          </div>
          <div
            class="scan-timestamp"
            data-testid="scan-state"
            :data-state="scanState"
            role="status"
          >
            <span
              :class="[
                'status-dot',
                {
                  working: isScanning,
                  incomplete: partialScan || scanState === 'error',
                },
              ]"
            />{{ busy && !isScanning ? busy : scanStateLabels[scanState]
            }}<small v-if="scanResult">{{ date(scanResult.scannedAt) }}</small>
          </div>
        </section>
        <section
          v-if="scanResult"
          :class="['scan-coverage', { 'is-partial': partialScan }]"
          data-testid="scan-coverage"
          :data-status="scanResult.status ?? 'complete'"
          aria-labelledby="scan-coverage-title"
        >
          <Icon :name="partialScan ? 'alert' : 'shield'" :size="16" />
          <div>
            <strong id="scan-coverage-title">{{
              partialScan
                ? "扫描不完整 · 还有文件未计入"
                : "本次可扫描范围已检查"
            }}</strong>
            <span v-if="coverage" class="coverage-counts"
              >已访问 {{ coverage.visitedEntries.toLocaleString("zh-CN") }} 项 ·
              返回
              {{ coverage.returnedEntries.toLocaleString("zh-CN") }} 项</span
            >
            <p v-if="partialScan" id="scan-completeness-note">
              {{
                partialReason
              }}。大小与数量仅代表已发现的部分；只能逐项选择，批量选择已停用。
            </p>
            <p>
              {{
                coverage?.protectedDirectories
                  ? `${coverage.protectedDirectories} 个受保护目录未展开，内容未计入。`
                  : "受保护目录不会展开，其内容不计入。"
              }}逻辑大小不等于磁盘实际占用。
            </p>
          </div>
          <button
            v-if="canRescanWithHigherLimit"
            class="button secondary"
            data-testid="rescan-100k"
            :disabled="!!busy"
            @click="scan(100000)"
          >
            以 100,000 项上限重新扫描
          </button>
        </section>
        <section
          v-if="isScanning"
          class="scan-progress-panel"
          data-testid="scan-progress"
          :data-request-id="activeScanRequestId"
          aria-label="扫描进度"
        >
          <div class="scan-progress-heading">
            <Icon name="scan" :size="22" />
            <div>
              <h2>正在读取文件元数据</h2>
              <p>保护目录不会展开。扫描期间不修改文件，可随时取消。</p>
            </div>
          </div>
          <dl class="scan-progress-metrics">
            <div>
              <dt>已访问项目</dt>
              <dd data-testid="progress-visited">
                {{
                  scanProgress
                    ? scanProgress.visitedEntries.toLocaleString("zh-CN")
                    : "—"
                }}
              </dd>
            </div>
            <div>
              <dt>已发现文件</dt>
              <dd data-testid="progress-files">
                {{
                  scanProgress
                    ? scanProgress.discoveredFiles.toLocaleString("zh-CN")
                    : "—"
                }}
              </dd>
            </div>
            <div>
              <dt>已发现逻辑大小</dt>
              <dd data-testid="progress-bytes">
                {{
                  scanProgress ? formatSize(scanProgress.discoveredBytes) : "—"
                }}
              </dd>
            </div>
            <div>
              <dt>已用时间</dt>
              <dd data-testid="progress-elapsed">
                {{
                  elapsedLabel(
                    Math.max(scanProgress?.elapsedMs ?? 0, now - scanStartedAt),
                  )
                }}
              </dd>
            </div>
          </dl>
          <p
            v-if="scanProgress?.currentPath"
            class="scan-progress-path"
            :title="scanProgress.currentPath"
          >
            {{ scanProgress.currentPath }}
          </p>
          <p v-else class="scan-progress-path">
            {{
              scanProgress
                ? "正在遍历当前目录…"
                : "正在等待扫描数据，完成后显示结果。"
            }}
          </p>
        </section>
        <section
          v-else
          class="space-analysis"
          :class="{ 'with-coverage': scanResult }"
          aria-label="已发现文件的逻辑大小分类占比"
        >
          <div class="disk-visual" :class="{ 'is-empty': !totalBytes }">
            <svg
              viewBox="0 0 300 300"
              class="disk-chart"
              role="group"
              aria-label="文件空间分布图"
              aria-describedby="chart-keyboard-help"
            >
              <circle cx="150" cy="150" r="137" class="chart-outline" />
              <circle
                v-if="!totalBytes"
                cx="150"
                cy="150"
                r="109"
                class="chart-empty-ring"
              />
              <g
                v-for="group in ringGroups"
                :key="group.key"
                :class="[
                  'chart-group',
                  group.key,
                  {
                    muted: hoveredSpace && hoveredSpace !== group.key,
                    active: category === group.key,
                  },
                ]"
              >
                <path
                  :d="group.path"
                  class="category-arc"
                  role="button"
                  tabindex="-1"
                  :aria-label="`图中筛选${group.label}，${formatSize(group.bytes)}`"
                  @mouseenter="hoveredSpace = group.key"
                  @mouseleave="hoveredSpace = null"
                  @focus="hoveredSpace = group.key"
                  @blur="hoveredSpace = null"
                  @click="
                    selectCategory(category === group.key ? 'all' : group.key)
                  "
                  @keydown.enter.prevent="
                    selectCategory(category === group.key ? 'all' : group.key)
                  "
                  @keydown.space.prevent="
                    selectCategory(category === group.key ? 'all' : group.key)
                  "
                >
                  <title>
                    {{ labels[group.key] }} · {{ formatSize(group.bytes) }}
                  </title>
                </path>
                <path
                  v-for="file in group.files"
                  :key="file.entry?.id ?? `${group.key}-remainder`"
                  :d="file.path"
                  class="file-arc"
                  role="button"
                  :data-chart-key="file.entry?.id ?? `${group.key}-remainder`"
                  :tabindex="
                    activeChartKey ===
                    (file.entry?.id ?? `${group.key}-remainder`)
                      ? 0
                      : -1
                  "
                  @focus="
                    focusChartSegment(
                      file.entry?.id ?? `${group.key}-remainder`,
                      file.entry,
                      group.key,
                    )
                  "
                  @blur="
                    hoveredFile = null;
                    hoveredSpace = null;
                  "
                  @keydown="
                    handleChartKey(
                      $event,
                      file.entry?.id ?? `${group.key}-remainder`,
                    )
                  "
                  :aria-label="
                    file.entry
                      ? `检查文件 ${file.entry.path}，${formatSize(file.size)}`
                      : `筛选${group.label}中其余${file.count}个文件，${formatSize(file.size)}`
                  "
                  @keydown.enter.prevent="
                    file.entry
                      ? inspectEntry(file.entry)
                      : selectCategory(group.key)
                  "
                  @keydown.space.prevent="
                    file.entry
                      ? inspectEntry(file.entry)
                      : selectCategory(group.key)
                  "
                  :style="{ opacity: 0.72 + (file.index % 4) * 0.08 }"
                  @mouseenter="
                    hoveredFile = file.entry;
                    hoveredSpace = group.key;
                  "
                  @mouseleave="
                    hoveredFile = null;
                    hoveredSpace = null;
                  "
                  @click="
                    file.entry
                      ? inspectEntry(file.entry)
                      : selectCategory(group.key)
                  "
                >
                  <title>
                    {{ file.entry?.path ?? `其余 ${file.count} 个文件` }} ·
                    {{ formatSize(file.size) }}
                  </title>
                </path>
              </g>
            </svg>
            <span id="chart-keyboard-help" class="visually-hidden"
              >使用方向键浏览文件，Home 或 End 跳至首尾，Enter
              查看详情；也可通过分类图例和文件列表操作。</span
            >
            <div class="disk-center">
              <span
                >{{ scanResult ? sizeParts(chartBytes).value : "—"
                }}<small v-if="scanResult">{{
                  sizeParts(chartBytes).unit
                }}</small></span
              >
              <p :title="chartLabel">
                {{ scanResult ? chartLabel : scanStateLabels[scanState] }}
              </p>
            </div>
          </div>
          <div class="distribution-details">
            <div class="section-title">
              <h2>已发现文件分布</h2>
              <span>点击分类查看</span>
            </div>
            <div class="space-legend">
              <button
                v-for="item in categoryBreakdown"
                :key="item.key"
                :aria-label="`筛选${item.label}，${formatSize(item.bytes)}`"
                :class="{ active: category === item.key }"
                :aria-pressed="category === item.key"
                :disabled="!!busy"
                @mouseenter="hoveredSpace = item.key"
                @mouseleave="hoveredSpace = null"
                @click="
                  selectCategory(category === item.key ? 'all' : item.key)
                "
              >
                <span :class="['category-square', item.key]" /><span>{{
                  item.key === "protected" ? "其他受保护" : labels[item.key]
                }}</span
                ><strong>{{ scanResult ? formatSize(item.bytes) : "—" }}</strong
                ><small>{{
                  scanResult ? percentLabel(item.percent) : "—"
                }}</small
                ><Icon name="chevron" :size="13" />
              </button>
            </div>
            <p class="chart-hint">
              内环：数据分类<span>·</span>外环：{{
                chartHasAggregates ? "文件（小项合并）" : "单个文件"
              }}
            </p>
          </div>
          <div class="scan-overview">
            <div class="candidate-label">
              <span class="candidate-dot" />低风险候选
            </div>
            <div class="candidate-size">
              {{ scanResult ? sizeParts(summary?.safeBytes ?? 0).value : "—"
              }}<small v-if="scanResult">{{
                sizeParts(summary?.safeBytes ?? 0).unit
              }}</small>
            </div>
            <p>
              {{
                scanResult
                  ? `${safeEntries.length} 个旧日志文件可审阅隔离`
                  : "扫描后识别可隔离的旧日志"
              }}
            </p>
            <div class="overview-safety">
              <Icon name="shield" :size="15" /><span
                >默认保护会话与关键数据</span
              >
            </div>
            <p v-if="!scanResult" class="measure-note">
              只统计已发现项目的逻辑大小。受保护目录不会展开，不代表全部磁盘占用。
            </p>
            <p v-else-if="context.demo" class="measure-note">
              当前为独立稀疏测试文件。
            </p>
          </div>
        </section>
        <div
          class="workspace-grid"
          :class="{ 'has-inspector': inspectedEntry }"
        >
          <div class="files-workspace">
            <section class="scan-options">
              <span class="options-label"
                ><Icon name="scan" :size="14" />扫描条件</span
              >
              <label
                >候选文件修改于<select
                  v-model.number="minAgeDays"
                  aria-label="候选文件最短年龄"
                  :disabled="!!busy"
                >
                  <option :value="7">7 天前</option>
                  <option :value="30">30 天前</option>
                  <option :value="90">90 天前</option>
                  <option :value="180">180 天前</option>
                </select></label
              ><label class="checkbox-label"
                ><input
                  v-model="includeSessions"
                  type="checkbox"
                  :disabled="!supportsSessionCleanup || !!busy"
                />包括历史会话 <span class="review-note">需审阅</span></label
              ><button
                v-if="context.root"
                class="text-button"
                :disabled="!!busy"
                @click="loadDemo"
              >
                体验演示
              </button>
            </section>
            <div v-if="includeSessions" class="inline-warning">
              <Icon name="alert" :size="15" />会话隔离可能影响 resume
              和索引。文件修改时间不代表会话已停止使用。
            </div>
            <div class="filter-bar">
              <div class="list-title">
                <h2>
                  {{ category === "all" ? "全部文件" : labels[category] }}
                </h2>
                <span>{{ scanResult ? filteredEntries.length : "—" }}</span>
              </div>
              <label class="search-field"
                ><Icon name="search" :size="15" /><input
                  v-model="query"
                  aria-label="搜索文件路径"
                  placeholder="搜索文件路径" /></label
              ><select v-model="ageFilter" aria-label="按文件年龄筛选">
                <option value="all">所有时间</option>
                <option value="30">30 天以上</option>
                <option value="90">90 天以上</option>
                <option value="180">180 天以上</option></select
              ><select v-model="sortBy" aria-label="排序方式">
                <option value="size">大小：从大到小</option>
                <option value="oldest">修改：从旧到新</option>
                <option value="path">路径：字母顺序</option></select
              ><span class="filter-count">{{
                scanResult ? `${filteredEntries.length} 项` : "—"
              }}</span>
            </div>
            <div class="file-panel">
              <div v-if="scanResult" class="table-scroll">
                <span id="file-keyboard-help" class="visually-hidden"
                  >使用上下方向键浏览当前页，空格选择可隔离项目，Enter
                  查看详情。</span
                >
                <table class="file-table" aria-describedby="file-keyboard-help">
                  <thead>
                    <tr>
                      <th class="check-cell">
                        <input
                          type="checkbox"
                          :checked="allSafeSelected"
                          :indeterminate="someSafeSelected && !allSafeSelected"
                          :disabled="
                            !visibleSafe.length || !!busy || partialScan
                          "
                          aria-label="选择当前列表中的安全项目"
                          :aria-describedby="
                            partialScan ? 'scan-completeness-note' : undefined
                          "
                          :title="
                            partialScan
                              ? '扫描不完整，请逐项选择'
                              : '仅选择当前页中的安全项目'
                          "
                          @change="selectSafe"
                        />
                      </th>
                      <th class="path-column">名称 / 路径</th>
                      <th class="size-cell">大小</th>
                      <th class="date-column">修改日期</th>
                      <th class="risk-column">风险</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(entry, index) in shownEntries"
                      :key="entry.id"
                      :data-row-index="index"
                      :class="{
                        inspected: inspectedId === entry.id,
                        selected: selected.has(entry.id),
                        protected: entry.risk === 'protected',
                      }"
                      :tabindex="entry.id === tabStopEntryId ? 0 : -1"
                      @focus="activeRowId = entry.id"
                      @click="inspectEntry(entry)"
                      @keydown="handleRowKey($event, entry, index)"
                    >
                      <td class="check-cell">
                        <input
                          type="checkbox"
                          :checked="selected.has(entry.id)"
                          :disabled="!entry.selectable || !!busy"
                          :aria-label="`选择 ${entry.path}`"
                          tabindex="-1"
                          @click.stop
                          @change="toggleEntry(entry)"
                        />
                      </td>
                      <td class="path-cell">
                        <span class="table-file-icon"
                          ><Icon
                            :name="categoryIcons[entry.category]"
                            :size="18" /></span
                        ><span class="file-label"
                          ><strong :title="fileName(entry.path)"
                            >{{ fileName(entry.path)
                            }}<span v-if="entry.cleanupUnit" class="unit-tag"
                              >整组</span
                            ></strong
                          ><small :title="entry.path">{{
                            parentPath(entry.path)
                          }}</small></span
                        >
                      </td>
                      <td class="size-cell">{{ formatSize(entry.size) }}</td>
                      <td
                        class="date-column"
                        :title="new Date(entry.mtimeMs).toLocaleString('zh-CN')"
                      >
                        {{ tableDate(entry.mtimeMs) }}
                      </td>
                      <td class="risk-column">
                        <span :class="['risk-badge', entry.risk]"
                          ><Icon
                            :name="
                              entry.risk === 'protected'
                                ? 'lock'
                                : entry.risk === 'review'
                                  ? 'alert'
                                  : 'check'
                            "
                            :size="11"
                          />{{
                            entry.risk === "safe"
                              ? "低风险"
                              : entry.risk === "review"
                                ? "需审阅"
                                : "保护"
                          }}</span
                        >
                      </td>
                    </tr>
                    <tr v-if="!shownEntries.length">
                      <td colspan="5" class="table-empty">
                        <strong>没有符合条件的项目</strong
                        ><span>调整搜索或筛选条件。</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="tool-empty">
                <Icon name="folder" :size="38" />
                <h2>
                  {{
                    isScanning
                      ? "扫描进行中"
                      : scanState === "cancelled"
                        ? "扫描已取消"
                        : scanState === "error"
                          ? "扫描未完成"
                          : context.root
                            ? "等待扫描"
                            : "尚未选择目录"
                  }}
                </h2>
                <p>
                  {{
                    isScanning
                      ? "完成后显示可审阅结果。"
                      : scanState === "cancelled" || scanState === "error"
                        ? "本次结果已丢弃，没有保留可选旧条目。可点击顶部重新扫描。"
                        : context.root
                          ? "选择扫描条件后，点击顶部「开始扫描」。"
                          : `选择 ${providerLabel} 数据目录，或先用独立 Codex 测试目录体验。`
                  }}
                </p>
                <div v-if="!context.root" class="onboarding-actions">
                  <button
                    class="button primary"
                    :disabled="!!busy || !apiAvailable"
                    @click="chooseRoot"
                  >
                    <Icon name="folder" :size="15" />连接真实
                    {{ providerLabel }} 目录
                  </button>
                  <button
                    class="button secondary"
                    :disabled="!!busy || !apiAvailable"
                    @click="loadDemo"
                  >
                    体验演示扫描
                  </button>
                </div>
                <div
                  v-if="
                    !context.root &&
                    suggestedCandidates.some((item) =>
                      isCleanupCandidate(item.kind),
                    )
                  "
                  class="onboarding-candidates"
                >
                  <span>建议位置，尚未读取：</span>
                  <button
                    v-for="candidate in suggestedCandidates
                      .filter((item) => isCleanupCandidate(item.kind))
                      .slice(0, 2)"
                    :key="candidate.id"
                    class="text-button"
                    :disabled="!!busy"
                    @click="activateCandidate(candidate)"
                    :title="candidate.path"
                  >
                    {{ candidate.path }}
                  </button>
                </div>
                <span v-if="!context.root" class="empty-safety"
                  >只读扫描 · 不上传文件内容</span
                >
              </div>
            </div>
            <div class="table-footer">
              <div
                v-if="
                  scanResult &&
                  (bulkScopeEntries.length || sessionBulkAvailable)
                "
                class="bulk-selection-scope"
                data-testid="bulk-selection-scope"
                :data-count="bulkScopeEntries.length"
                :data-bytes="bulkScopeBytes"
              >
                <div class="bulk-scope-copy">
                  <strong
                    >{{ bulkScopeEntries.length.toLocaleString("zh-CN") }} 项{{
                      sessionBulkAvailable ? "会话" : "低风险"
                    }}<span>·</span>{{ formatSize(bulkScopeBytes) }}
                    <small>逻辑大小</small></strong
                  >
                  <span
                    v-if="partialScan"
                    id="bulk-scope-help"
                    class="bulk-limit-warning"
                    >扫描不完整，仅可逐项选择；批量操作已停用。</span
                  >
                  <span
                    v-else-if="bulkScopeOverLimit"
                    id="bulk-scope-help"
                    class="bulk-limit-warning"
                    >超过 5,000
                    项上限，请缩小筛选或分批选择；当前选择未改变。</span
                  >
                  <span v-else id="bulk-scope-help"
                    >当前筛选的全部分页 · 将替换当前选择</span
                  >
                </div>
                <button
                  v-if="sessionBulkAvailable"
                  class="button secondary bulk-selection-button"
                  data-testid="bulk-review-sessions"
                  aria-label="批量审阅筛选内会话"
                  aria-describedby="bulk-scope-help"
                  :disabled="
                    !!busy ||
                    !bulkScopeEntries.length ||
                    bulkScopeOverLimit ||
                    partialScan
                  "
                  @click="requestSessionBulkSelection"
                >
                  <Icon name="alert" :size="13" />批量审阅会话
                </button>
                <button
                  v-else
                  class="button secondary bulk-selection-button"
                  data-testid="bulk-select-safe"
                  aria-label="跨页选择筛选内低风险项目"
                  aria-describedby="bulk-scope-help"
                  :disabled="
                    !!busy ||
                    !bulkScopeEntries.length ||
                    bulkScopeOverLimit ||
                    partialScan
                  "
                  @click="selectFilteredSafe"
                >
                  <Icon name="check" :size="13" />跨页选择低风险
                </button>
              </div>
              <span
                v-if="
                  !scanResult ||
                  (!bulkScopeEntries.length && !sessionBulkAvailable)
                "
                >{{
                  partialScan
                    ? "扫描不完整，仅支持逐项选择"
                    : "表头勾选仅包含当前页低风险项目"
                }}</span
              >
              <div class="pagination" role="group" aria-label="扫描结果分页">
                <span>{{ currentPage }} / {{ totalPages }} 页</span
                ><button
                  class="icon-button"
                  :disabled="currentPage <= 1 || !!busy"
                  @click="goToPage(currentPage - 1)"
                  aria-label="上一页"
                >
                  <Icon
                    name="chevron"
                    class="previous-chevron"
                    :size="16"
                  /></button
                ><button
                  class="icon-button"
                  :disabled="currentPage >= totalPages || !!busy"
                  @click="goToPage(currentPage + 1)"
                  aria-label="下一页"
                >
                  <Icon name="chevron" :size="16" />
                </button>
              </div>
            </div>
            <details v-if="scanResult?.warnings.length" class="scan-warnings">
              <summary>
                查看 {{ scanResult.warnings.length }} 条扫描提示
              </summary>
              <div v-for="warning in scanResult.warnings" :key="warning">
                <Icon name="alert" :size="13" />{{ warning }}
              </div>
            </details>
          </div>
          <aside
            v-if="inspectedEntry"
            class="inspector"
            aria-label="文件检查器"
          >
            <div class="inspector-title">
              <h2>检查器</h2>
              <button
                v-if="inspectedEntry"
                class="icon-button"
                aria-label="清除检查项"
                @click="inspectedId = null"
              >
                <Icon name="x" :size="14" />
              </button>
            </div>
            <template v-if="inspectedEntry"
              ><div class="inspected-file">
                <Icon
                  :name="categoryIcons[inspectedEntry.category]"
                  :size="29"
                />
                <h3 :title="fileName(inspectedEntry.path)">
                  {{ fileName(inspectedEntry.path) }}
                </h3>
                <span>{{ labels[inspectedEntry.category] }}</span>
              </div>
              <dl class="inspector-details">
                <div>
                  <dt>逻辑大小</dt>
                  <dd>{{ formatSize(inspectedEntry.size) }}</dd>
                </div>
                <div>
                  <dt>最后修改</dt>
                  <dd>{{ tableDate(inspectedEntry.mtimeMs) }}</dd>
                </div>
                <div>
                  <dt>距今</dt>
                  <dd>{{ ageLabel(inspectedEntry.ageDays) }}</dd>
                </div>
                <div>
                  <dt>项目类型</dt>
                  <dd>
                    {{
                      {
                        file: "文件",
                        directory: "目录",
                        symlink: "符号链接",
                        other: "其他",
                      }[inspectedEntry.kind]
                    }}
                  </dd>
                </div>
              </dl>
              <section class="inspector-section">
                <h3>相对路径</h3>
                <p class="inspector-path">{{ inspectedEntry.path }}</p>
              </section>
              <section class="inspector-section">
                <h3>
                  <Icon
                    :name="
                      inspectedEntry.risk === 'protected'
                        ? 'lock'
                        : inspectedEntry.risk === 'review'
                          ? 'alert'
                          : 'check'
                    "
                    :size="14"
                  />{{ riskLabels[inspectedEntry.risk] }}
                </h3>
                <p>{{ inspectedEntry.reason }}</p>
                <p v-if="inspectedEntry.cleanupUnit" class="unit-note">
                  完整整理组：{{
                    inspectedEntry.cleanupUnit.fileCount
                  }}
                  个文件、{{
                    inspectedEntry.cleanupUnit.directoryCount
                  }}
                  个目录。成员：{{
                    inspectedEntry.cleanupUnit.members.join(" + ")
                  }}
                </p>
                <p
                  v-if="inspectedEntry.category === 'session'"
                  class="inspector-warning"
                >
                  可能影响 resume 和会话索引。AgentVac 不修改状态数据库。
                </p>
              </section>
              <div class="inspector-actions">
                <button
                  class="button secondary"
                  :disabled="!inspectedEntry.selectable || !!busy"
                  @click="toggleEntry(inspectedEntry)"
                >
                  {{
                    !inspectedEntry.selectable
                      ? "此项不可隔离"
                      : selected.has(inspectedEntry.id)
                        ? "取消选择此项"
                        : "选择此项"
                  }}</button
                ><button
                  class="text-button"
                  @click="focusedEntry = inspectedEntry"
                >
                  查看完整信息
                </button>
              </div></template
            ><template v-else
              ><div class="inspector-placeholder">
                <Icon name="info" :size="24" />
                <h3>未选中文件</h3>
                <p>单击一行，查看路径、修改日期和识别依据。</p>
                <p>勾选文件会将其加入待处理列表，不会立即修改文件。</p>
              </div>
              <div v-if="scanResult" class="inspector-summary">
                <h3>当前扫描</h3>
                <dl>
                  <div>
                    <dt>低风险候选</dt>
                    <dd>{{ safeEntries.length }} 项</dd>
                  </div>
                  <div>
                    <dt>可隔离项目</dt>
                    <dd>{{ eligible.length }} 项</dd>
                  </div>
                  <div>
                    <dt>受保护项</dt>
                    <dd>
                      {{
                        scanResult.entries.filter((e) => !e.selectable).length
                      }}
                      项
                    </dd>
                  </div>
                </dl>
              </div></template
            >
            <div class="inspector-footnote">
              <Icon name="shield" :size="15" />
              <p>
                认证、配置、主数据库与未知文件保持保护。仅明确识别的会话或缓存组可复核；隔离不会释放磁盘空间。
              </p>
            </div>
          </aside>
        </div>
      </div>
      <section
        v-else-if="page === 'diagnostics'"
        class="utility-workspace"
        aria-labelledby="diagnostics-title"
      >
        <div class="page-title">
          <div>
            <h1 id="diagnostics-title" tabindex="-1">空间诊断</h1>
            <p>分开查看数据库、旁路文件与普通日志。所有诊断均为只读。</p>
          </div>
          <span class="utility-readonly"
            ><Icon name="lock" :size="13" />只读</span
          >
        </div>
        <div v-if="!managementAvailable" class="utility-empty">
          <Icon name="info" :size="24" />
          <h2>当前运行环境不支持空间诊断</h2>
          <p>现有扫描与隔离功能仍可使用。</p>
        </div>
        <template v-else>
          <div v-if="appDataError" class="utility-alert" role="alert">
            {{ appDataError }}
          </div>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>诊断范围</h2>
                <p>仅检查你勾选的位置，最多 8 个；添加位置不会自动读取内容。</p>
              </div>
              <div class="compact-actions">
                <button
                  class="button secondary"
                  :disabled="!!busy"
                  @click="chooseDiagnosticRoot('sqlite')"
                >
                  添加 SQLite 位置</button
                ><button
                  class="button secondary"
                  :disabled="!!busy"
                  @click="chooseDiagnosticRoot('logs')"
                >
                  添加日志位置
                </button>
              </div>
            </div>
            <div
              v-if="!availableWorkspaces.length"
              class="utility-inline-empty"
            >
              尚无已确认位置。<button
                class="text-button"
                :disabled="!!busy"
                @click="chooseRoot"
              >
                选择 {{ providerLabel }} 数据目录
              </button>
            </div>
            <fieldset v-else class="diagnostic-roots" tabindex="0">
              <legend class="visually-hidden">选择诊断目录</legend>
              <label
                v-for="workspace in availableWorkspaces.filter((item) =>
                  ['codex', 'sqlite', 'logs'].includes(item.kind),
                )"
                :key="workspace.id"
                :class="{ unavailable: workspace.status !== 'available' }"
                ><input
                  type="checkbox"
                  :checked="diagnosticWorkspaceIds.has(workspace.id)"
                  :disabled="!!busy || workspace.status !== 'available'"
                  :aria-label="`诊断 ${workspace.path}`"
                  @change="toggleDiagnosticWorkspace(workspace)"
                /><span
                  ><strong
                    >{{ workspace.name }}
                    <small
                      >{{ workspaceKindLabels[workspace.kind]
                      }}{{ workspace.demo ? " · 演示" : "" }}</small
                    ></strong
                  ><span class="utility-path">{{ workspace.path }}</span
                  ><small v-if="workspace.status !== 'available'">{{
                    workspace.message
                  }}</small></span
                ><span :class="['workspace-state', workspace.status]">{{
                  workspaceStatusLabels[workspace.status]
                }}</span></label
              >
            </fieldset>
            <div class="diagnostic-options">
              <label class="checkbox-label"
                ><input
                  v-model="diagnosticConfigOptIn"
                  type="checkbox"
                  :disabled="!!busy"
                  data-testid="diagnostic-config-opt-in"
                />允许只读解析所选 Codex 目录的路径配置（sqlite_home /
                log_dir）</label
              ><button
                class="button primary"
                :disabled="!!busy || !diagnosticWorkspaceIds.size"
                @click="readDiagnostics(false)"
                v-if="!activeDiagnosisRequestId"
                data-testid="run-diagnostics"
              >
                {{ busy === "读取空间诊断" ? "正在读取…" : "只读统计" }}
              </button>
              <button
                v-else-if="diagnosisCancellationAvailable"
                class="button secondary"
                :disabled="diagnosisCancelPending"
                @click="cancelDiagnosis"
                data-testid="cancel-diagnosis"
              >
                {{ diagnosisCancelPending ? "正在取消…" : "取消诊断" }}
              </button>
            </div>
            <p class="utility-note">
              配置发现的位置仅作为未验证建议；不会自动跟随、添加或扫描。
            </p>
          </section>
          <template v-if="diagnosticResult">
            <section class="utility-section">
              <div class="utility-section-heading">
                <div>
                  <h2 id="diagnostic-sample-title" tabindex="-1">此次采样</h2>
                  <p>
                    {{ date(diagnosticResult.sampledAt) }} ·
                    {{ diagnosticResult.files.length }} 个已发现文件
                  </p>
                </div>
              </div>
              <dl class="diagnostic-totals">
                <div>
                  <dt>SQLite 相关文件</dt>
                  <dd>
                    {{ formatSize(diagnosticResult.sqliteTotalBytes)
                    }}<small
                      >含数据库主体及 WAL / SHM /
                      Journal，也包含受保护的状态库</small
                    >
                  </dd>
                </div>
                <div>
                  <dt>普通日志</dt>
                  <dd>
                    {{ formatSize(diagnosticResult.totals["ordinary-log"])
                    }}<small>与数据库分别统计；此页不提供删除操作</small>
                  </dd>
                </div>
              </dl>
              <div
                v-if="diagnosticResult.warnings.length"
                class="utility-alert"
                data-testid="diagnostic-warnings"
              >
                <strong>此次诊断有未检查项目或配置限制</strong>
                <ul>
                  <li
                    v-for="(warning, index) in diagnosticResult.warnings"
                    :key="index"
                  >
                    {{ diagnosticWarningText[warning] ?? warning }}
                  </li>
                </ul>
              </div>
              <div class="diagnostic-table-tools">
                <label class="search-field"
                  ><Icon name="search" :size="15" /><input
                    v-model="diagnosticQuery"
                    placeholder="筛选已发现文件"
                    aria-label="筛选诊断文件" /></label
                ><span>{{ diagnosticFiles.length }} 项 · 按文件名标注角色</span>
              </div>
              <div
                class="utility-table-scroll"
                tabindex="0"
                aria-label="诊断文件列表"
              >
                <table class="diagnostic-table">
                  <thead>
                    <tr>
                      <th>文件 / 路径</th>
                      <th>类型</th>
                      <th>逻辑大小</th>
                      <th>已分配大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="file in shownDiagnosticFiles" :key="file.path">
                      <td>
                        <strong>{{ fileName(file.path) }}</strong
                        ><span class="diagnostic-file-role">{{
                          diagnosticRole(file.path)
                        }}</span
                        ><span class="utility-path" :title="file.path">{{
                          file.path
                        }}</span>
                      </td>
                      <td>{{ diagnosticKindLabels[file.kind] }}</td>
                      <td>{{ formatSize(file.bytes) }}</td>
                      <td>{{ nullableSize(file.allocatedBytes) }}</td>
                    </tr>
                    <tr v-if="!shownDiagnosticFiles.length">
                      <td colspan="4" class="utility-table-empty">
                        没有符合条件的文件；不会据此推断目录为空。
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="utility-pagination">
                <span>逻辑大小与实际分配量可能不同；未知值不按零处理。</span>
                <div class="pagination" role="group" aria-label="诊断文件分页">
                  <span>{{ diagnosticPage }} / {{ diagnosticPages }}</span
                  ><button
                    class="icon-button"
                    aria-label="诊断上一页"
                    :disabled="diagnosticPage <= 1"
                    @click="diagnosticPage--"
                  >
                    <Icon
                      name="chevron"
                      class="previous-chevron"
                      :size="16"
                    /></button
                  ><button
                    class="icon-button"
                    aria-label="诊断下一页"
                    :disabled="diagnosticPage >= diagnosticPages"
                    @click="diagnosticPage++"
                  >
                    <Icon name="chevron" :size="16" />
                  </button>
                </div>
              </div>
            </section>
            <section class="utility-section">
              <div class="utility-section-heading">
                <div>
                  <h2 id="deep-check-title" tabindex="-1">日志库只读深查</h2>
                  <p>
                    仅支持此次已发现的
                    logs_2.sqlite。状态库及其他版本日志库保持保护。
                  </p>
                </div>
              </div>
              <p
                v-if="!deepDatabaseOptions.length"
                class="utility-inline-empty"
              >
                此次范围未发现可支持的 logs_2.sqlite；可在上方添加并统计正确的
                SQLite 位置。
              </p>
              <template v-else
                ><label class="utility-field"
                  >日志数据库<select
                    v-model="deepDatabasePath"
                    :disabled="!!busy"
                    aria-label="只读深查数据库"
                  >
                    <option
                      v-for="file in deepDatabaseOptions"
                      :key="file.path"
                      :value="file.path"
                    >
                      {{ file.path }}
                    </option>
                  </select></label
                >
                <div class="deep-check-options">
                  <label class="checkbox-label"
                    ><input
                      v-model="deepEnabled"
                      type="checkbox"
                      :disabled="!!busy"
                      data-testid="deep-check-opt-in"
                    />允许以只读方式检查这份日志库的结构与页信息</label
                  ><label class="checkbox-label"
                    ><input
                      v-model="deepConfirmedClosed"
                      type="checkbox"
                      :disabled="!!busy"
                      data-testid="deep-check-closed"
                    />我已退出全部 Codex CLI / 桌面进程</label
                  ><button
                    class="button secondary"
                    :disabled="
                      !!busy ||
                      !deepEnabled ||
                      !deepConfirmedClosed ||
                      !deepDatabasePath
                    "
                    @click="readDiagnostics(true)"
                    data-testid="run-deep-check"
                  >
                    {{ busy === "只读深入检查" ? "正在检查…" : "开始只读深查" }}
                  </button>
                </div></template
              >
              <div
                v-if="diagnosticResult.deepCheck.status === 'blocked'"
                class="utility-alert"
                data-testid="deep-check-blocked"
              >
                <strong>已阻止深入检查</strong>
                <p>
                  {{
                    deepReasonText[
                      diagnosticResult.deepCheck.reason ?? "READ_FAILED"
                    ] ?? "当前条件不满足只读深查要求。"
                  }}
                </p>
              </div>
              <template
                v-if="
                  diagnosticResult.deepCheck.status === 'ok' &&
                  diagnosticResult.deepCheck.metrics
                "
                ><dl class="deep-metrics" data-testid="deep-check-metrics">
                  <div>
                    <dt>auto_vacuum</dt>
                    <dd>
                      {{
                        diagnosticResult.deepCheck.metrics.autoVacuum.toUpperCase()
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>journal_mode</dt>
                    <dd>
                      {{
                        diagnosticResult.deepCheck.metrics.journalMode.toUpperCase()
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>页大小</dt>
                    <dd>
                      {{
                        formatSize(diagnosticResult.deepCheck.metrics.pageSize)
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>数据库页数</dt>
                    <dd>
                      {{
                        diagnosticResult.deepCheck.metrics.pageCount.toLocaleString(
                          "zh-CN",
                        )
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>空闲页数</dt>
                    <dd>
                      {{
                        diagnosticResult.deepCheck.metrics.freelistCount.toLocaleString(
                          "zh-CN",
                        )
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>空闲页逻辑大小</dt>
                    <dd>
                      {{
                        formatSize(
                          diagnosticResult.deepCheck.metrics.freePageBytes,
                        )
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>非空闲页逻辑大小</dt>
                    <dd>
                      {{
                        formatSize(
                          diagnosticResult.deepCheck.metrics.occupiedPageBytes,
                        )
                      }}
                    </dd>
                  </div>
                </dl>
                <p class="utility-note">
                  这是数据库内部页状态观察，不能承诺等量可回收空间。观察期间文件属性稳定，不保证其他程序稍后不会写入。
                </p></template
              >
              <p class="utility-note">
                旁路文件、进程运行或无法确认、结构未知及源文件变化都会阻止深查。此功能不执行
                VACUUM，不压缩或改写数据库。
              </p>
              <details class="utility-disclosure">
                <summary>Codex 版本与日志维护说明</summary>
                <p>
                  Codex 0.160.0 已包含后台日志数据库维护；已有数据库会保留原来的
                  auto_vacuum 模式，旧 NONE
                  模式不会自动转换。先核对所有使用该目录的 Codex
                  客户端版本，按官方方式更新并正常使用，再退出相关客户端后重新诊断。维护效果取决于模式、空闲页和运行状态，不能保证立即释放空间。
                </p>
                <p>
                  本页只提供文件与页状态观察。空闲页不等于立即可释放空间，AgentVac
                  不提供数据库写入或 VACUUM 操作。
                </p>
              </details>
            </section>
            <section v-if="configCandidates.length" class="utility-section">
              <div class="utility-section-heading">
                <div>
                  <h2>配置中的建议位置</h2>
                  <p>这些新增路径尚未验证，也没有读取其中内容。</p>
                </div>
              </div>
              <div
                v-for="candidate in configCandidates"
                :key="candidate.id"
                class="workspace-row"
              >
                <div class="workspace-row-copy">
                  <strong>{{
                    candidate.label || candidateKindLabels[candidate.kind]
                  }}</strong>
                  <p class="utility-path">{{ candidate.path }}</p>
                  <small>{{ candidate.source }} · 未验证建议</small>
                </div>
                <button
                  class="button secondary"
                  :disabled="!!busy"
                  @click="activateCandidate(candidate)"
                >
                  添加这个位置
                </button>
              </div>
            </section>
            <section class="utility-section">
              <div class="utility-section-heading">
                <div>
                  <h2>磁盘可用空间采样</h2>
                  <p>
                    其他程序会同时写入或释放空间；此值不等同于本次隔离字节。同一磁盘可能按多个位置重复出现，请勿相加。
                  </p>
                </div>
              </div>
              <div
                v-for="volume in diagnosticResult.volumes"
                :key="volume.root"
                class="volume-row"
              >
                <div>
                  <strong
                    >{{ nullableSize(volume.availableBytes) }}
                    <small>可用</small></strong
                  >
                  <p class="utility-path">{{ volume.root }}</p>
                </div>
                <div>
                  <span>总量 {{ nullableSize(volume.totalBytes) }}</span
                  ><small
                    >{{ date(volume.sampledAt) }} 采样{{
                      volume.reason ? " · 无法取得完整卷信息" : ""
                    }}</small
                  >
                </div>
              </div>
            </section>
          </template>
          <div
            v-else
            class="utility-empty"
            :data-testid="
              activeDiagnosisRequestId
                ? 'diagnosis-progress'
                : 'diagnosis-empty'
            "
            role="status"
          >
            <Icon name="storage" :size="29" />
            <h2>
              {{
                activeDiagnosisRequestId
                  ? "正在进行只读诊断"
                  : "选择范围后开始只读统计"
              }}
            </h2>
            <p>
              {{
                activeDiagnosisRequestId
                  ? "只读取你选定的位置。检查完成后显示此次结果。"
                  : "不会自动扫描建议位置，也不会修改数据库。"
              }}
            </p>
          </div>
        </template>
      </section>
      <section
        v-else-if="page === 'manage'"
        class="utility-workspace"
        aria-labelledby="manage-title"
      >
        <div class="page-title">
          <div>
            <h1 id="manage-title" tabindex="-1">目录与恢复</h1>
            <p>明确选择本地位置，保管恢复能力，核实留存文件。</p>
          </div>
        </div>
        <div v-if="!managementAvailable" class="utility-empty">
          <Icon name="info" :size="24" />
          <h2>当前运行环境不支持目录管理</h2>
          <p>仍可通过顶部目录按钮连接和扫描。</p>
        </div>
        <template v-else>
          <div v-if="appDataError" class="utility-alert" role="alert">
            {{ appDataError }}
          </div>
          <div
            v-if="appData?.issues.length || appData?.workspaces.issue"
            class="utility-alert"
          >
            <p v-if="appData.workspaces.issue">
              {{ appData.workspaces.issue }}
            </p>
            <p v-for="issue in appData.issues" :key="issue">{{ issue }}</p>
          </div>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>已选与最近目录</h2>
                <p>
                  移除记录不会删除文件。缺失或已变化的目录需手动重新选择，不自动寻找替代位置。
                </p>
              </div>
              <button
                class="button secondary"
                :disabled="!!busy"
                @click="chooseRoot"
              >
                <Icon name="folder" :size="14" />选择真实目录
              </button>
            </div>
            <p v-if="!availableWorkspaces.length" class="utility-inline-empty">
              尚未连接真实目录。
            </p>
            <div
              v-for="workspace in availableWorkspaces"
              :key="workspace.id"
              class="workspace-row"
            >
              <Icon
                :name="
                  isCleanupWorkspace(workspace.kind) ? 'folder' : 'storage'
                "
                :size="19"
              />
              <div class="workspace-row-copy">
                <strong
                  >{{ workspace.name }}
                  <span class="workspace-kind"
                    >{{ workspaceKindLabels[workspace.kind]
                    }}{{ workspace.demo ? " · 演示" : "" }}</span
                  ></strong
                >
                <p class="utility-path" tabindex="0">{{ workspace.path }}</p>
                <small
                  :class="{
                    'status-warning': workspace.status !== 'available',
                  }"
                  >{{ workspaceStatusLabels[workspace.status] }} ·
                  {{
                    workspace.message || `上次使用 ${date(workspace.lastUsed)}`
                  }}</small
                >
              </div>
              <div class="workspace-actions">
                <button
                  class="button secondary"
                  :aria-label="`连接目录 ${workspace.path}`"
                  :disabled="
                    !!busy ||
                    workspace.status !== 'available' ||
                    (isCleanupWorkspace(workspace.kind) &&
                      workspace.path === context.root)
                  "
                  @click="activateWorkspace(workspace)"
                >
                  {{
                    !isCleanupWorkspace(workspace.kind)
                      ? "用于诊断"
                      : workspace.path === context.root
                        ? "当前目录"
                        : "连接"
                  }}</button
                ><button
                  class="text-button"
                  :disabled="!!busy"
                  :aria-label="`只移除目录记录 ${workspace.path}`"
                  @click="forgetWorkspace(workspace)"
                >
                  移除记录
                </button>
              </div>
            </div>
          </section>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>建议位置</h2>
                <p>
                  来自默认路径、环境变量或你允许读取的配置；只是路径建议，尚未验证或扫描。
                </p>
              </div>
            </div>
            <p v-if="!suggestedCandidates.length" class="utility-inline-empty">
              没有可用的路径建议，可手动选择目录。
            </p>
            <div
              v-for="candidate in suggestedCandidates"
              :key="candidate.id"
              class="workspace-row"
            >
              <Icon name="folder" :size="18" />
              <div class="workspace-row-copy">
                <strong
                  >{{ candidate.label || candidateKindLabels[candidate.kind] }}
                  <span class="workspace-state suggested">未验证</span></strong
                >
                <p class="utility-path" tabindex="0">{{ candidate.path }}</p>
                <small>来源：{{ candidate.source }}</small>
              </div>
              <button
                class="button secondary"
                :disabled="!!busy"
                :aria-label="`选择建议位置 ${candidate.path}`"
                @click="activateCandidate(candidate)"
              >
                {{
                  isCleanupCandidate(candidate.kind)
                    ? "选择此目录"
                    : "添加到诊断"
                }}
              </button>
            </div>
          </section>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>恢复密钥</h2>
                <p>用于认证隔离清单。这里只显示公开标识，不显示密钥内容。</p>
              </div>
              <span
                :class="['workspace-state', canSign ? 'available' : 'missing']"
                >{{ canSign ? "可以创建新隔离记录" : "新隔离已暂停" }}</span
              >
            </div>
            <div v-if="appData?.recovery.issues.length" class="utility-alert">
              <p v-for="issue in appData.recovery.issues" :key="issue.code">
                {{ issue.message }}
              </p>
            </div>
            <dl class="key-status">
              <div>
                <dt>当前主密钥公开 ID</dt>
                <dd>
                  <code>{{
                    appData?.recovery.primaryId ?? "不可用或尚未验证"
                  }}</code>
                </dd>
              </div>
              <div>
                <dt>可用于验证的密钥</dt>
                <dd>{{ appData?.recovery.trustedKeyIds.length ?? "—" }} 个</dd>
              </div>
            </dl>
            <details
              v-if="appData?.recovery.trustedKeyIds.length"
              class="utility-disclosure"
            >
              <summary>查看已信任的公开 ID</summary>
              <code
                v-for="id in appData.recovery.trustedKeyIds"
                :key="id"
                class="key-id"
                >{{ id }}</code
              >
            </details>
            <div class="compact-actions">
              <button
                class="button secondary"
                :disabled="!!busy"
                @click="requestAdminAction('import-keys')"
                data-testid="import-recovery-keys"
              >
                导入我的恢复备份</button
              ><button
                class="button secondary"
                :disabled="!!busy || !appData?.recovery.trustedKeyIds.length"
                @click="requestAdminAction('export-keys')"
                data-testid="export-recovery-keys"
              >
                导出恢复备份
              </button>
            </div>
            <div
              v-if="keyTransferReceipt"
              class="key-transfer-receipt"
              role="status"
            >
              <p>{{ keyTransferReceipt.message }}</p>
              <p v-if="keyTransferReceipt.path" class="utility-path">
                保存位置：{{ keyTransferReceipt.path }}
              </p>
              <details
                v-if="keyTransferReceipt.keyIds.length"
                class="utility-disclosure"
              >
                <summary>本次涉及的公开 ID</summary>
                <code
                  v-for="id in keyTransferReceipt.keyIds"
                  :key="id"
                  class="key-id"
                  >{{ id }}</code
                >
              </details>
            </div>
          </section>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>只读核实隔离区</h2>
                <p>
                  即使清单未通过认证，也能查看实际保留的 .data
                  文件数量和逻辑大小；不据此提供恢复或删除。
                </p>
              </div>
              <button
                class="button secondary"
                :disabled="!!busy || !context.root"
                @click="inspectRecovery"
                data-testid="inspect-recovery"
              >
                读取留存情况
              </button>
            </div>
            <p class="utility-path">
              当前根目录：{{ context.root ?? "尚未选择" }}
            </p>
            <template v-if="recoveryInspection"
              ><div class="recovery-total">
                <strong>{{ recoveryStoredFiles }} 个实际留存文件</strong
                ><span
                  >{{
                    formatSize(recoveryInspection.storedBytes)
                  }}
                  逻辑大小</span
                ><small
                  >已检查 {{ recoveryInspection.inspectedFiles }} 个条目</small
                >
              </div>
              <p v-if="recoveryInspection.truncated" class="utility-alert">
                只读检查达到上限，仅显示已检查部分；不能据此判断全部留存量。
              </p>
              <p
                v-if="!recoveryInspection.batches.length"
                class="utility-inline-empty"
              >
                未发现可展示的隔离批次。
              </p>
              <div
                v-for="batch in shownRecoveryBatches"
                :key="batch.id"
                class="recovery-batch"
              >
                <div>
                  <strong>{{ batch.id }}</strong
                  ><span
                    :class="[
                      'workspace-state',
                      batch.verified ? 'available' : 'missing',
                    ]"
                    >{{ batch.verified ? "清单已认证" : "未认证" }}</span
                  >
                </div>
                <p>{{ batch.explanation }}</p>
                <p>
                  {{ batch.storedFiles }} 个实际文件 ·
                  {{ formatSize(batch.storedBytes)
                  }}<span v-if="batch.irregularEntries">
                    · {{ batch.irregularEntries }} 个非标准条目</span
                  >
                </p>
                <p v-if="batch.originalRootHint" class="utility-path">
                  清单中的原目录（仅提示）：{{ batch.originalRootHint }}
                </p>
                <code v-if="batch.declaredKeyId" class="key-id"
                  >清单声明的公开 ID：{{ batch.declaredKeyId }}</code
                >
              </div>
              <div class="utility-pagination">
                <button
                  class="text-button"
                  :disabled="!!busy"
                  @click="navigate('history')"
                >
                  查看已认证隔离记录
                </button>
                <div
                  class="pagination"
                  role="group"
                  aria-label="只读留存批次分页"
                >
                  <span>{{ recoveryPage }} / {{ recoveryPages }}</span
                  ><button
                    class="icon-button"
                    aria-label="留存上一页"
                    :disabled="recoveryPage <= 1"
                    @click="recoveryPage--"
                  >
                    <Icon
                      name="chevron"
                      class="previous-chevron"
                      :size="16"
                    /></button
                  ><button
                    class="icon-button"
                    aria-label="留存下一页"
                    :disabled="recoveryPage >= recoveryPages"
                    @click="recoveryPage++"
                  >
                    <Icon name="chevron" :size="16" />
                  </button>
                </div></div
            ></template>
          </section>
          <section class="utility-section">
            <div class="utility-section-heading">
              <div>
                <h2>独立演示目录</h2>
                <p>应用内固定位置复用，不反复创建散落的演示目录。</p>
              </div>
              <span class="workspace-state">{{
                appData
                  ? {
                      absent: "尚未创建",
                      ready: "可使用",
                      preparing: "准备中",
                      blocked: "需要检查",
                    }[appData.demo.status]
                  : "未读取"
              }}</span>
            </div>
            <p class="utility-path" tabindex="0">{{ appData?.demo.path }}</p>
            <p class="utility-note">{{ appData?.demo.message }}</p>
            <div class="compact-actions">
              <button
                class="button secondary"
                :disabled="
                  !!busy ||
                  appData?.demo.status === 'blocked' ||
                  appData?.demo.status === 'preparing'
                "
                @click="loadDemo"
              >
                打开演示并扫描</button
              ><button
                class="text-button"
                :disabled="!!busy || !appData?.demo.canReset || !canSign"
                @click="requestAdminAction('reset-demo')"
                data-testid="reset-demo"
              >
                重置演示目录
              </button>
            </div>
            <p class="utility-note">
              重置前会再次确认；存在的旧演示整目录移入系统回收站，不永久删除。
            </p>
          </section>
        </template>
      </section>
      <section v-else-if="page === 'history'" class="history-workspace">
        <div class="page-title">
          <div>
            <h1 tabindex="-1">隔离记录</h1>
            <p>{{ batches.length }} 个批次 · {{ quarantinedCount }} 项待恢复</p>
          </div>
          <span>隔离文件仍占用磁盘空间</span>
        </div>
        <div class="history-explanation">
          <Icon name="info" :size="16" />
          <p>
            恢复会将文件放回原路径，不覆盖同名文件。目录组不保证原
            ACL、扩展属性和创建时间。回收站中的批次需先还原整个文件夹，再经
            AgentVac
            校验恢复。其他提供方的记录可在「目录与恢复」中重新连接原目录查看。
          </p>
        </div>
        <div v-if="!batches.length" class="tool-empty">
          <Icon name="archive" :size="34" />
          <h2>没有隔离记录</h2>
          <p>隔离文件后，批次清单与恢复入口会出现在这里。</p>
          <button class="button secondary" @click="navigate('scan')">
            查看文件
          </button>
        </div>
        <div class="history-list">
          <section v-for="batch in batches" :key="batch.id" class="batch-card">
            <div class="batch-heading">
              <Icon name="archive" :size="18" />
              <div>
                <h2>
                  <span class="provider-badge">{{
                    providerName(batch.provider)
                  }}</span>
                  · {{ date(batch.createdAt) }}
                </h2>
                <p>{{ batch.id }}</p>
              </div>
              <span class="batch-count"
                >{{
                  batch.items.filter((item) => item.status === "quarantined")
                    .length
                }}
                项待恢复 / {{ batch.items.length }} 项</span
              >
              <div class="batch-actions">
                <button
                  class="button secondary"
                  :disabled="
                    !!busy ||
                    !batch.items.some((item) => item.status === 'quarantined')
                  "
                  @click="requestRestore(batch)"
                >
                  <Icon name="restore" :size="14" />恢复此批次</button
                ><button
                  class="button danger-outline"
                  :disabled="
                    !!busy ||
                    !canSign ||
                    !batch.items.some((item) => item.status === 'quarantined')
                  "
                  @click="requestTrash(batch)"
                >
                  <Icon name="trash" :size="14" />移入系统回收站
                </button>
              </div>
            </div>
            <div class="batch-root">{{ batch.root }}</div>
            <div
              v-if="
                batch.items.some(
                  (item) => item.status === 'pending' || item.error,
                )
              "
              class="batch-recovery-guidance"
            >
              <strong>请先保留原目录和隔离区中的全部副本</strong>
              <p>留存位置：{{ retainedBatchPath(batch) }}</p>
              <p>
                在「目录与恢复」读取留存信息。若原路径出现新的同名数据，先另存新数据再重试；未认证或恢复仍受阻时不要强行覆盖，不要编辑
                manifest.json。当前没有自动导出不确定副本的功能。
              </p>
              <button
                v-if="canOpenBatch"
                class="button secondary"
                :disabled="!!busy"
                @click="openBatch(batch)"
              >
                查看此批次留存文件夹
              </button>
            </div>
            <div v-for="item in batch.items" :key="item.id" class="batch-item">
              <Icon
                :name="item.cleanupUnit ? 'folder' : 'file'"
                :size="15"
              /><span class="batch-path"
                >{{ item.path
                }}<small v-if="item.cleanupUnit"
                  >整组 · {{ item.cleanupUnit.fileCount }} 个文件 /
                  {{ item.cleanupUnit.directoryCount }} 个目录</small
                ><small v-if="item.error" class="failure-text">{{
                  item.error
                }}</small></span
              ><span>{{ formatSize(item.size) }}</span
              ><span :class="['batch-status', item.status]">{{
                {
                  pending: "待处理",
                  quarantined: "已隔离",
                  restored: "已恢复",
                  failed: "失败",
                  trashed: "已移入回收站",
                }[item.status]
              }}</span>
            </div>
          </section>
        </div>
      </section>
      <section
        v-else-if="page === 'rules'"
        class="rules-workspace"
        tabindex="0"
        aria-labelledby="rules-title"
      >
        <div class="page-title">
          <div>
            <h1 id="rules-title" tabindex="-1">保护规则</h1>
            <p>默认保留不确定的数据，只处理已识别并经你确认的文件。</p>
          </div>
        </div>
        <table class="rules-table">
          <thead>
            <tr>
              <th>数据类型</th>
              <th>默认策略</th>
              <th>识别与处理范围</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><Icon name="log" :size="18" />旧日志</td>
              <td>低风险候选</td>
              <td>
                {{ providerScope }} 文件或完整组需满足保留天数，执行前再次验证。
              </td>
            </tr>
            <tr>
              <td><Icon name="session" :size="18" />历史会话</td>
              <td>默认保护</td>
              <td>
                需手动开启并逐项选择；隔离可能影响 resume
                和会话索引。修改时间不能证明会话已停止。
              </td>
            </tr>
            <tr>
              <td><Icon name="cache" :size="18" />可重建缓存</td>
              <td>需审阅完整组</td>
              <td>
                仅开放当前提供方已验证的缓存布局；不拆分相关成员。可能需要重新编译、下载或重建派生索引，离线时部分功能暂不可用。主数据库不受影响。
              </td>
            </tr>
            <tr>
              <td><Icon name="lock" :size="18" />关键数据与未知文件</td>
              <td>始终保护</td>
              <td>
                认证、配置、history.jsonl、主状态数据库、符号链接及未识别文件不可隔离。未知缓存格式也保留。受保护目录不会展开。
              </td>
            </tr>
          </tbody>
        </table>
        <div class="rule-details">
          <section>
            <h2>扫描与进程检查</h2>
            <p>
              扫描只读取文件元数据，不上传内容。隔离或恢复前需退出全部
              {{ providerLabel }}
              相关进程。检测到正在运行或无法确认进程状态时，操作会被阻止。
            </p>
          </section>
          <section>
            <h2>隔离与恢复</h2>
            <p>
              文件先移入当前根目录的隔离区，因此不释放磁盘空间。每批保存清单；恢复时不覆盖已有文件，失败项目保留供你检查。AgentVac
              不修改状态数据库。
            </p>
          </section>
          <section>
            <h2>系统回收站</h2>
            <p>
              只有主动选择并二次确认后，才将隔离批次移入系统回收站。批次在回收站期间无法直接恢复；需先还原整个批次文件夹到原隔离目录，再由
              AgentVac
              校验并恢复原路径。清空系统回收站才释放磁盘空间，清空后不可恢复。
            </p>
          </section>
        </div>
      </section>
      <div
        v-if="page === 'scan' && hiddenSelectedEntries.length"
        class="hidden-selection-notice"
        data-testid="hidden-selection-notice"
        :data-hidden-count="hiddenSelectedEntries.length"
        :data-outside-filter-count="selectedOutsideFilter"
        role="status"
      >
        <Icon name="info" :size="14" />
        <span
          >已选 {{ hiddenSelectedEntries.length }} 项不在当前页<span
            v-if="selectedOutsideFilter"
            >，其中 {{ selectedOutsideFilter }} 项在筛选外</span
          >。</span
        >
        <button
          class="text-button"
          data-testid="clear-hidden-selection"
          aria-label="清除当前页外的选择"
          :disabled="!!busy"
          @click="clearHiddenSelection"
        >
          清除隐藏选择
        </button>
      </div>
      <footer v-if="page !== 'conversations'" class="action-bar">
        <template v-if="page === 'scan'"
          ><div class="selection-summary" role="status" aria-live="polite">
            <strong>{{
              selected.size ? `已选择 ${selected.size} 项` : "未选择项目"
            }}</strong
            ><span>{{
              selected.size ? formatSize(selectedBytes) : "勾选文件以准备隔离"
            }}</span>
          </div>
          <button
            v-if="selected.size"
            class="text-button"
            :disabled="!!busy"
            @click="selected = new Set()"
          >
            取消选择</button
          ><span class="action-note">隔离不会释放磁盘空间</span
          ><button
            class="button primary"
            :disabled="!!busy || !selected.size"
            data-testid="preview-selection"
            @click="showPreview"
          >
            <Icon name="archive" :size="15" />预览隔离操作
          </button></template
        ><template v-else
          ><span
            ><Icon name="lock" :size="13" />{{
              page === "diagnostics" || page === "manage"
                ? "仅访问你明确选择的本地位置"
                : "所有操作仅作用于当前目录"
            }}</span
          ><span class="footer-platform">{{
            context.platform === "darwin"
              ? "macOS"
              : context.platform === "win32"
                ? "Windows"
                : context.platform === "linux"
                  ? "Linux"
                  : "桌面客户端"
          }}</span></template
        >
      </footer>
    </main>
    <div v-if="modalOpen" class="modal-backdrop" @click.self="closeModal">
      <section
        class="modal"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        :class="{ 'wide-modal': preview || operation }"
      >
        <button
          class="modal-close icon-button"
          :disabled="!!busy"
          aria-label="关闭弹窗"
          @click="closeModal"
        >
          <Icon name="x" :size="21" />
        </button>
        <template v-if="preview"
          ><div class="modal-symbol"><Icon name="archive" :size="26" /></div>

          <h2 id="modal-title">
            {{
              conversationArchiveIds.length
                ? "确认这一次对话隔离"
                : "确认这一次整理"
            }}
          </h2>
          <p v-if="conversationArchiveTitles.length" class="modal-subtitle">
            已选择
            {{ conversationArchiveTitles.length }}
            条完整对话；以下显示后台核实的全部关联文件。
          </p>
          <details
            v-if="conversationArchiveTitles.length"
            class="conversation-preview-titles"
          >
            <summary>核对所选对话标题</summary>
            <p v-for="(title, index) in conversationArchiveTitles" :key="index">
              {{ index + 1 }}. {{ title }}
            </p>
          </details>
          <p class="modal-subtitle">
            {{ providerName(preview.provider) }} ·
            {{ preview.items.length }} 个项目 ·
            {{ formatSize(preview.totalBytes)
            }}<span v-if="context.demo" class="demo-pill">演示目录</span>
          </p>
          <p class="preview-root">{{ preview.root || context.root }}</p>
          <p v-if="preview.totalFiles !== undefined" class="unit-note">
            合计 {{ preview.totalFiles }} 个文件、{{
              preview.totalDirectories ?? 0
            }}
            个目录；整组项目不可拆分选择。
          </p>
          <div
            v-if="preview.scanStatus === 'partial'"
            class="modal-notice amber-notice"
            data-testid="partial-preview-warning"
          >
            <Icon name="alert" :size="19" />
            <div>
              <strong>这些项目来自不完整扫描</strong>
              <p>
                仅检查了已发现并由你逐项选择的文件；仍有未检查或未计入的项目。此预览不代表其余目录已全部检查。
              </p>
            </div>
          </div>
          <div v-if="!canSign" class="modal-notice amber-notice">
            <Icon name="shield" :size="19" />
            <div>
              <strong>恢复签名不可用，暂不能新建隔离记录</strong>
              <p>请先到「目录与恢复」核实恢复能力。已认证的旧批次仍可恢复。</p>
            </div>
          </div>
          <div class="preview-list">
            <div v-for="item in preview.items" :key="item.id">
              <Icon :name="categoryIcons[item.category]" :size="17" /><span
                :title="item.path"
                >{{ item.path
                }}<small v-if="item.cleanupUnit" class="unit-note"
                  >整组 · {{ item.cleanupUnit.fileCount }} 个文件 /
                  {{ item.cleanupUnit.directoryCount }} 个目录<br />{{
                    item.cleanupUnit.members.join(" + ")
                  }}</small
                ></span
              ><span :class="['risk-badge', item.risk]">{{
                item.risk === "review" ? "需审阅" : "低风险"
              }}</span
              ><strong>{{ formatSize(item.size) }}</strong>
            </div>
          </div>
          <div class="modal-notice">
            <Icon name="info" :size="19" />
            <div>
              <strong>这是可恢复的隔离，不是永久删除</strong>
              <p>
                文件将移入同一根目录下的隔离区，仍占用磁盘空间。你可以在「隔离记录」中恢复。
              </p>
            </div>
          </div>
          <div
            v-if="preview.items.some((item) => item.category === 'cache')"
            class="modal-notice amber-notice"
          >
            <Icon name="cache" :size="19" />
            <div>
              <strong>这些缓存可能需要重新生成</strong>
              <p>
                隔离后可能重新编译、下载模型目录或重建派生搜索索引；离线时部分信息可能暂不可用。恢复不会覆盖已经重新生成的同名数据。
              </p>
            </div>
          </div>
          <div
            v-if="preview.items.some((item) => item.category === 'session')"
            class="modal-notice amber-notice"
          >
            <Icon name="alert" :size="19" />
            <div>
              <strong>你选择了历史会话</strong>
              <p>
                隔离可能影响 resume
                与会话索引。修改时间不能证明会话已停止使用；AgentVac
                不修改状态数据库。
              </p>
            </div>
          </div>
          <div
            v-if="!context.demo"
            :class="['process-status', { blocked: processRunning }]"
          >
            <Icon
              :name="processRunning ? 'alert' : 'terminal'"
              :size="17"
            /><span>{{
              preview.processStatus?.details ||
              "无法确认进程状态，本次文件操作已阻止。"
            }}</span>
          </div>
          <label class="acknowledgement"
            ><input
              v-model="acknowledged"
              type="checkbox"
              :disabled="!!busy"
            /><span
              >我已审阅所选项目，理解隔离的影响及其仍占用磁盘空间。</span
            ></label
          ><label v-if="!context.demo" class="acknowledgement"
            ><input
              v-model="confirmedClosed"
              type="checkbox"
              :disabled="!!busy"
            /><span
              >我已退出所有
              {{ providerLabel }}
              相关程序与后台服务，包括以管理员权限或其他用户身份运行的实例。</span
            ></label
          >
          <div v-if="previewExpired" class="failure-text expiry-message">
            预览已过期。请关闭弹窗并重新预览。
          </div>
          <div v-if="error" class="modal-error" role="alert" tabindex="-1">
            {{ error }}
            <p v-if="operationInterrupted">
              部分文件可能已完成操作。请先检查隔离记录核实状态，再重新扫描；不要假定文件均未改变。
            </p>
          </div>
          <div class="modal-actions">
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              返回检查</button
            ><button
              v-if="operationInterrupted"
              class="button primary"
              :disabled="!!busy"
              @click="reviewInterruptedOperation"
            >
              检查隔离记录</button
            ><button
              v-else-if="error || previewExpired || processRunning"
              class="button primary"
              :disabled="!!busy"
              @click="showPreview"
            >
              <Icon name="refresh" :size="16" />{{
                busy ? "正在检查…" : "重新检查所选项目"
              }}</button
            ><button
              v-else
              class="button primary"
              :disabled="!canQuarantine"
              @click="quarantine"
            >
              <Icon name="archive" :size="17" />{{
                busy === "正在隔离"
                  ? "正在隔离…"
                  : context.demo
                    ? "确认演示隔离"
                    : "确认移入隔离区"
              }}
            </button>
          </div></template
        >
        <template v-else-if="adminAction">
          <div class="modal-symbol amber">
            <Icon
              :name="adminAction === 'reset-demo' ? 'refresh' : 'shield'"
              :size="26"
            />
          </div>
          <h2 id="modal-title">
            {{
              adminAction === "import-keys"
                ? "导入你的恢复备份？"
                : adminAction === "export-keys"
                  ? "导出敏感恢复材料？"
                  : "重置独立演示目录？"
            }}
          </h2>
          <p class="modal-subtitle">
            {{
              adminAction === "reset-demo"
                ? "仅作用于应用的固定演示目录"
                : "恢复密钥用于认证隔离清单，请谨慎保管"
            }}
          </p>
          <div class="modal-notice amber-notice">
            <Icon name="alert" :size="19" />
            <div>
              <strong>{{
                adminAction === "import-keys"
                  ? "只导入你自己可信的备份"
                  : adminAction === "export-keys"
                    ? "备份文件包含敏感密钥内容"
                    : "旧演示目录将整体移入系统回收站"
              }}</strong>
              <p v-if="adminAction === 'import-keys'">
                来自他人的密钥可能影响清单信任。导入成功不等于某个批次已认证，仍需核实清单和原目录。导入后会清空旧扫描及勾选。
              </p>
              <p v-else-if="adminAction === 'export-keys'">
                任何获得该备份的人都可能拥有对应的恢复认证材料。请只保存到你控制的安全位置，不要公开或发送给他人。
              </p>
              <p v-else>
                存在的旧演示数据及其隔离记录将进入系统回收站，随后创建新演示。此操作不永久删除；如果重建失败，会明确报告，并保留可核实的实际状态。
              </p>
            </div>
          </div>
          <p
            v-if="adminAction === 'reset-demo'"
            class="detail-path"
            tabindex="0"
            aria-label="演示目录完整路径"
          >
            {{ appData?.demo.path }}
          </p>
          <label class="acknowledgement"
            ><input
              v-model="adminAcknowledged"
              type="checkbox"
              :disabled="!!busy"
              data-testid="admin-risk-ack"
            /><span>{{
              adminAction === "import-keys"
                ? "这是我自己的可信恢复备份，我了解导入会改变信任范围。"
                : adminAction === "export-keys"
                  ? "我了解备份包含敏感恢复材料，会在安全位置妥善保存。"
                  : "我了解旧演示目录将移入系统回收站，同意重新创建演示。"
            }}</span></label
          >
          <div v-if="error" class="modal-error" role="alert" tabindex="-1">
            {{ error }}
            <p v-if="adminAction === 'reset-demo'">
              旧演示可能已移入系统回收站，而新建尚未完成。请核实当前状态，不要假定旧演示仍在原位置。
            </p>
          </div>
          <div class="modal-actions">
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              取消</button
            ><button
              class="button primary"
              :disabled="
                !!busy ||
                !adminAcknowledged ||
                (adminAction === 'reset-demo' &&
                  (!appData?.demo.canReset || !canSign))
              "
              @click="confirmAdminAction"
              data-testid="admin-confirm"
            >
              {{
                busy
                  ? "正在处理…"
                  : adminAction === "import-keys"
                    ? "选择我的备份文件"
                    : adminAction === "export-keys"
                      ? "选择安全保存位置"
                      : "确认重置演示目录"
              }}
            </button>
          </div>
        </template>
        <template v-else-if="sessionBulkReview">
          <div class="modal-symbol amber">
            <Icon name="session" :size="26" />
          </div>
          <h2 id="modal-title">批量选择这些会话？</h2>
          <p class="modal-subtitle">
            {{ sessionBulkReview.entries.length }} 个会话 ·
            {{
              formatSize(
                sessionBulkReview.entries.reduce(
                  (sum, entry) => sum + entry.size,
                  0,
                ),
              )
            }}
            逻辑大小
          </p>
          <div class="bulk-review-scope">
            <strong>将替换当前 {{ selected.size }} 项选择</strong>
            <p>仅选择「会话记录」中符合当前筛选的可隔离项目，包含全部分页。</p>
            <dl>
              <div>
                <dt>路径搜索</dt>
                <dd>{{ sessionBulkReview.query || "不限" }}</dd>
              </div>
              <div>
                <dt>时间筛选</dt>
                <dd>
                  {{
                    sessionBulkReview.age === "all"
                      ? "所有时间"
                      : sessionBulkReview.age + " 天以上"
                  }}
                </dd>
              </div>
            </dl>
          </div>
          <div class="modal-notice amber-notice">
            <Icon name="alert" :size="19" />
            <div>
              <strong>历史会话需要单独审阅</strong>
              <p>
                隔离会话可能影响 resume
                与会话索引。修改时间不能证明会话已停止使用；AgentVac
                不修改状态数据库。
              </p>
            </div>
          </div>
          <label class="acknowledgement">
            <input
              v-model="sessionBulkAcknowledged"
              type="checkbox"
              data-testid="bulk-session-ack"
              :disabled="!!busy"
            />
            <span>我已了解会话风险，同意用上述范围替换当前选择。</span>
          </label>
          <p class="bulk-review-note">
            此步骤只改变勾选，不移动文件。隔离前仍需逐项预览并完成最终确认。
          </p>
          <div class="modal-actions">
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              保留当前选择
            </button>
            <button
              class="button primary"
              data-testid="bulk-session-confirm"
              :disabled="!!busy || !sessionBulkAcknowledged"
              @click="confirmSessionBulkSelection"
            >
              替换为这 {{ sessionBulkReview.entries.length }} 个会话
            </button>
          </div>
        </template>
        <template v-else-if="restoreTarget"
          ><div class="modal-symbol"><Icon name="restore" :size="26" /></div>
          <h2 id="modal-title">恢复这个批次？</h2>
          <p class="modal-subtitle">
            {{ date(restoreTarget.createdAt) }} ·
            {{
              restoreTarget.items.filter(
                (item) => item.status === "quarantined",
              ).length
            }}
            个文件
          </p>
          <div class="modal-notice">
            <Icon name="info" :size="19" />
            <div>
              <strong>文件将回到原来的位置</strong>
              <p>
                已有同名文件不会被覆盖。无法恢复的项目会保留在隔离区，并单独显示原因。
              </p>
            </div>
          </div>
          <p class="restore-safety">
            恢复前请退出
            {{ providerLabel }}，避免正在运行的会话读取到变化中的文件。
          </p>
          <label v-if="!context.demo" class="acknowledgement"
            ><input
              v-model="confirmedClosed"
              type="checkbox"
              :disabled="!!busy"
            /><span
              >我已退出所有
              {{ providerLabel }}
              相关程序与后台服务，包括以管理员权限或其他用户身份运行的实例。</span
            ></label
          >
          <div v-if="error" class="modal-error" role="alert" tabindex="-1">
            {{ error }}
            <p v-if="operationInterrupted">
              部分文件可能已完成操作。请先检查隔离记录核实状态，再重新扫描；不要假定文件均未改变。
            </p>
          </div>
          <div class="modal-actions">
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              取消</button
            ><button
              v-if="operationInterrupted"
              class="button primary"
              :disabled="!!busy"
              @click="reviewInterruptedOperation"
            >
              检查隔离记录</button
            ><button
              v-else
              class="button primary"
              :disabled="!!busy || (!context.demo && !confirmedClosed)"
              @click="restore"
            >
              <Icon name="restore" :size="17" />{{
                busy === "正在恢复" ? "正在恢复…" : "确认恢复"
              }}
            </button>
          </div></template
        >
        <template v-else-if="trashTarget"
          ><div class="modal-symbol danger">
            <Icon name="trash" :size="26" />
          </div>

          <h2 id="modal-title">移入系统回收站？</h2>
          <p class="modal-subtitle">
            {{
              trashTarget.items.filter((item) => item.status === "quarantined")
                .length
            }}
            个隔离项目 ·
            {{
              formatSize(
                trashTarget.items
                  .filter((item) => item.status === "quarantined")
                  .reduce((sum, item) => sum + item.size, 0),
              )
            }}
          </p>
          <div class="modal-notice danger-notice">
            <Icon name="alert" :size="20" />
            <div>
              <strong>批次在回收站期间，不能直接恢复</strong>
              <p>
                批次在系统回收站期间，无法从 AgentVac
                直接恢复。需先通过系统回收站将整个批次文件夹还原到原隔离目录，再由
                AgentVac
                校验并恢复原路径。清空回收站才释放空间，清空后不可恢复。
              </p>
            </div>
          </div>
          <p
            v-if="context.demo"
            class="restore-safety"
            data-testid="trash-demo-boundary"
          >
            演示模式：本次只处理生成的演示文件，不代表已检查或关闭真实工具程序。
          </p>
          <label class="acknowledgement"
            ><input
              v-model="trashConsent.confirmedClosed"
              data-testid="trash-closed"
              type="checkbox"
              :disabled="!!busy || !trashConsent.challenge"
            /><span v-if="!context.demo"
              >我已退出所有
              {{ providerLabel }}
              相关程序与后台服务，包括以管理员权限或其他用户身份运行的实例。</span
            >
            <span v-else
              >我确认本次只操作演示数据；处理真实数据前，仍需退出相关程序与后台服务，包括管理员及其他用户的实例。</span
            >
          </label>
          <label class="acknowledgement"
            ><input
              v-model="trashConsent.impact"
              data-testid="trash-impact"
              type="checkbox"
              :disabled="!!busy || !trashConsent.challenge"
            /><span>我了解上述影响，并会自行管理系统回收站。</span></label
          ><label class="trash-confirm-label"
            >输入「回收站」以确认此操作<input
              v-model="trashConsent.phrase"
              type="text"
              placeholder="回收站"
              autocomplete="off"
              :disabled="!!busy || !trashConsent.challenge"
          /></label>
          <p
            v-if="
              trashConsent.challenge && now >= trashConsent.challenge.expiresAt
            "
            class="restore-safety"
          >
            本次确认已过期，请保留在隔离区并重新打开此批次，再次确认。
          </p>
          <p
            v-if="!busy && !trashConsent.challenge && !operationInterrupted"
            class="restore-safety"
          >
            请保留在隔离区并重新打开此批次，重新完成确认后再试。
          </p>
          <div v-if="error" class="modal-error" role="alert" tabindex="-1">
            {{ error }}
            <p v-if="operationInterrupted">
              部分文件可能已完成操作。请先检查隔离记录核实状态，再重新扫描；不要假定文件均未改变。
            </p>
          </div>
          <div class="modal-actions">
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              保留在隔离区</button
            ><button
              v-if="operationInterrupted"
              class="button primary"
              :disabled="!!busy"
              @click="reviewInterruptedOperation"
            >
              检查隔离记录</button
            ><button
              v-else
              class="button danger-button"
              data-testid="trash-submit"
              :disabled="!canTrash"
              @click="trash"
            >
              <Icon name="trash" :size="17" />{{
                busy === "移入系统回收站" ? "正在移入…" : "确认移入系统回收站"
              }}
            </button>
          </div></template
        >
        <template v-else-if="operation"
          ><div :class="['modal-symbol', { amber: operation.failed.length }]">
            <Icon
              :name="operation.failed.length ? 'alert' : 'check'"
              :size="28"
            />
          </div>

          <h2 id="modal-title">
            {{
              operation.failed.length
                ? "操作完成，部分项目需留意"
                : operation.type === "quarantine"
                  ? "整理完成，随时可以恢复"
                  : operation.type === "trash"
                    ? "隔离批次已移入系统回收站"
                    : "文件已回到原来的位置"
            }}
          </h2>
          <p class="modal-subtitle">
            成功{{
              operation.type === "quarantine"
                ? "隔离"
                : operation.type === "trash"
                  ? "移入回收站"
                  : "恢复"
            }}
            {{ operation.completed }} 项 · {{ formatSize(operation.bytes) }}
          </p>
          <div class="modal-notice">
            <Icon name="info" :size="19" />
            <div>
              <strong>{{
                operation.type === "quarantine"
                  ? "隔离不会释放磁盘空间"
                  : operation.type === "trash"
                    ? "需先还原整个批次文件夹"
                    : "恢复结果已记录"
              }}</strong>
              <p>
                {{
                  operation.type === "quarantine"
                    ? "文件仍保存在本地隔离区。可以前往「隔离记录」查看批次或恢复文件。"
                    : operation.type === "trash"
                      ? "需先通过系统回收站将整个批次文件夹还原到原隔离目录，再由 AgentVac 校验并恢复原路径。清空系统回收站才释放空间，清空后不可恢复。"
                      : "已成功恢复的文件将从隔离区移回原路径。查看下方是否存在单独报告的失败项目。"
                }}
              </p>
            </div>
          </div>
          <div v-if="operation.failed.length" class="failure-list">
            <div v-for="(item, index) in operation.failed" :key="index">
              <strong>{{ item.path }}</strong
              ><span>{{ item.error }}</span>
            </div>
          </div>
          <div v-if="error" class="modal-error" role="alert" tabindex="-1">
            {{ error }}
            <p v-if="operationInterrupted">
              部分文件可能已完成操作。请先检查隔离记录核实状态，再重新扫描；不要假定文件均未改变。
            </p>
          </div>
          <div class="modal-actions">
            <button
              v-if="operation.type === 'trash' && systemTrashAvailable"
              class="button secondary"
              :disabled="!!busy"
              @click="openSystemTrash"
            >
              打开系统回收站
            </button>
            <button
              class="button secondary"
              :disabled="!!busy"
              @click="closeModal"
            >
              完成</button
            ><button
              class="button primary"
              :disabled="!!busy"
              @click="
                closeModal();
                navigate('history');
              "
            >
              查看隔离记录<Icon name="arrow" :size="16" />
            </button></div
        ></template>
        <template v-else-if="focusedEntry"
          ><div
            :class="[
              'modal-symbol',
              focusedEntry.risk === 'review' ? 'amber' : '',
            ]"
          >
            <Icon :name="categoryIcons[focusedEntry.category]" :size="26" />
          </div>
          <h2
            id="modal-title"
            class="detail-title"
            :title="fileName(focusedEntry.path)"
          >
            {{ fileName(focusedEntry.path) }}
          </h2>
          <p class="detail-path" tabindex="0" aria-label="完整相对路径">
            {{ focusedEntry.path }}
          </p>
          <div class="detail-grid">
            <div>
              <span>数据类型</span
              ><strong>{{ labels[focusedEntry.category] }}</strong>
            </div>
            <div>
              <span>文件大小</span
              ><strong>{{ formatSize(focusedEntry.size) }}</strong>
            </div>
            <div>
              <span>最后修改</span
              ><strong>{{ date(focusedEntry.mtimeMs) }}</strong>
            </div>
            <div>
              <span>安全状态</span
              ><strong>{{ riskLabels[focusedEntry.risk] }}</strong>
            </div>
          </div>
          <div class="modal-notice">
            <Icon name="info" :size="19" />
            <div>
              <strong>识别依据</strong>
              <p>{{ focusedEntry.reason }}</p>
            </div>
          </div>
          <div
            v-if="focusedEntry.category === 'session'"
            class="modal-notice amber-notice"
          >
            <Icon name="alert" :size="19" />
            <div>
              <strong>会话数据需要审慎选择</strong>
              <p>
                可能影响 resume 和会话索引；修改时间不能证明会话不活跃。AgentVac
                不修改状态数据库。
              </p>
            </div>
          </div>
          <div class="modal-actions">
            <button class="button secondary" @click="closeModal">关闭</button
            ><button
              v-if="focusedEntry.selectable"
              class="button primary"
              :disabled="!!busy"
              @click="
                toggleEntry(focusedEntry);
                closeModal();
              "
            >
              {{ selected.has(focusedEntry.id) ? "取消选择此项" : "选择此项"
              }}<Icon name="check" :size="17" />
            </button></div
        ></template>
      </section>
    </div>
  </div>
</template>
