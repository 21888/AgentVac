import { promises as fs } from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";
import type {
  ProviderAdapter,
  ProviderDiscoveryInputs,
  ProviderCandidate,
  ProcessSnapshot,
} from "./types.js";

const EXTENSION_ID = "saoudrizwan.claude-dev";
const SESSION_ID = /^\d{13}_[a-z0-9]{5}$/;
const DAY = 86_400_000;
const MAX_SESSIONS = 50_000;
const MODEL_CATALOG_POLICY = "cline-legacy-model-catalog-v1";
const CHECKPOINT_SCRATCH_POLICY = "cline-checkpoint-scratch-v1";
const SEARCH_CACHE_POLICY = "cline-session-search-cache-v2";
const SCRATCH_DIRECTORY = /^checkpoint-scratch\/[a-f0-9]{32}$/;
const SEARCH_FILES = [
  "db/session-search.db",
  "db/session-search.db-wal",
  "db/session-search.db-shm",
  "db/session-search.db-journal",
];
const MODEL_CATALOGS = new Set([
  "cache/openrouter_models.json",
  "cache/vercel_ai_gateway_models.json",
  "cache/groq_models.json",
  "cache/cline_recommended_models.json",
]);
const protectedEntry = (reason: string) => ({
  category: "protected" as const,
  risk: "protected" as const,
  reason,
});
const slash = (value: string) => value.replaceAll("\\", "/");
const validRelative = (value: string) =>
  !!value &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every(
      (part) => !!part && part !== "." && part !== ".." && !part.includes(":"),
    );
const legacyRoot = (root: string) =>
  slash(root).toLowerCase().endsWith(`/globalstorage/${EXTENSION_ID}`);
const wrongNamespace = (root: string) =>
  slash(root)
    .split("/")
    .some((part) =>
      /^(?:\.codex|\.claude|\.cursor|rooveterinaryinc\.roo-cline|rooveterinaryinc\.roo-code|kilocode\.kilo-code)$/i.test(
        part,
      ),
    );
const modernContext = (root?: string) =>
  !!root && !legacyRoot(root) && !wrongNamespace(root);

async function metadata(file: string): Promise<Stats | null> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const ordinary = (stat: Stats | null) =>
  !!stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
const directory = (stat: Stats | null) =>
  !!stat && stat.isDirectory() && !stat.isSymbolicLink();

async function validateRoot(root: string): Promise<void> {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root === path.parse(root).root ||
    wrongNamespace(root)
  )
    throw new Error(
      "请选择 Cline 的独立数据目录；其他助手、磁盘根目录和非规范路径不受支持。",
    );
  if (!directory(await metadata(root)))
    throw new Error("Cline 数据目录必须是普通目录，不能是链接。");
  if (legacyRoot(root)) {
    const tasks = await metadata(path.join(root, "tasks"));
    const state = await metadata(path.join(root, "state"));
    if (
      !directory(tasks) ||
      !directory(state) ||
      !ordinary(await metadata(path.join(root, "state", "taskHistory.json")))
    )
      throw new Error(
        "未识别到完整的 Cline 扩展任务目录和历史索引；不读取内容，也不尝试修复。",
      );
    return;
  }
  // Explicitly relocated Cline data is accepted only with two independent storage markers.
  // lstat only: never parse globalState, credentials, transcripts, or the SQLite database.
  if (
    !directory(await metadata(path.join(root, "sessions"))) ||
    !directory(await metadata(path.join(root, "db"))) ||
    !ordinary(await metadata(path.join(root, "db", "sessions.db"))) ||
    !ordinary(await metadata(path.join(root, "globalState.json")))
  )
    throw new Error(
      "未识别到 Cline 共享数据结构（sessions、db/sessions.db、globalState.json）；未知格式保持保护。",
    );
  if (slash(root).toLowerCase().includes("/globalstorage/"))
    throw new Error("编辑器扩展存储与 Cline 共享数据目录不能混用。");
}

function discover({
  home,
  env,
  platform,
}: ProviderDiscoveryInputs): ProviderCandidate[] {
  if (!["darwin", "win32", "linux"].includes(platform)) return [];
  const p = platform === "win32" ? path.win32 : path.posix;
  const candidates: ProviderCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined, source: string, label: string) => {
    if (!value || !p.isAbsolute(value) || value.includes("\0")) return;
    const normalized = p.normalize(value);
    if (normalized === p.parse(normalized).root) return;
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ provider: "cline", path: normalized, source, label });
  };
  const clineData = env.CLINE_DATA_DIR?.trim();
  const clineHome = env.CLINE_DIR?.trim();
  if (clineData) add(clineData, "CLINE_DATA_DIR", "Cline 共享数据（环境变量）");
  else if (clineHome && p.isAbsolute(clineHome))
    add(p.join(clineHome, "data"), "CLINE_DIR", "Cline 共享数据（环境变量）");
  if (p.isAbsolute(home))
    add(p.join(home, ".cline", "data"), "default", "Cline 共享数据");
  const extensionAt = (base: string, source: string, label: string) =>
    add(p.join(base, "User", "globalStorage", EXTENSION_ID), source, label);
  const portable = env.VSCODE_PORTABLE;
  if (portable && p.isAbsolute(portable))
    extensionAt(
      p.join(portable, "user-data"),
      "VSCODE_PORTABLE",
      "Cline 扩展（VS Code 便携版）",
    );
  const appDataOverride = env.VSCODE_APPDATA;
  let appData =
    platform === "darwin"
      ? p.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || p.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || p.join(home, ".config");
  if (appDataOverride && p.isAbsolute(appDataOverride))
    appData = appDataOverride;
  if (p.isAbsolute(appData)) {
    for (const product of ["Code", "Code - Insiders"])
      extensionAt(
        p.join(appData, product),
        "editor-default",
        `Cline 扩展（${product}）`,
      );
  }
  // Profile IDs, custom --user-data-dir, other editors, WSL/SSH/container storage are explicit-selection only.
  // Do not crawl user profiles, editor databases, project directories, or network shares.
  return candidates;
}

function classify(relativePath: string, root?: string) {
  if (!validRelative(relativePath))
    return protectedEntry("路径无效，拒绝访问。");
  if (root && legacyRoot(root) && MODEL_CATALOGS.has(relativePath))
    return {
      category: "cache" as const,
      risk: "review" as const,
      reason:
        "已验证的旧版 Cline 公共模型目录缓存，可由成功的模型目录刷新重建；隔离后离线模型列表可能不可用，需联网刷新或恢复。",
    };
  if (modernContext(root) && SCRATCH_DIRECTORY.test(relativePath))
    return {
      category: "cache" as const,
      risk: "review" as const,
      reason:
        "Cline 可重建的检查点临时索引与路径清单，作为完整目录隔离；不会移走真实检查点或工作区 Git 索引。下次检查点可能需要重新计算，近期及最新缓存保留。",
    };
  if (modernContext(root) && relativePath === SEARCH_FILES[0])
    return {
      category: "cache" as const,
      risk: "review" as const,
      reason:
        "仅 Cline 可重建的全文搜索缓存及其精确旁路文件。不会修改会话数据库或对话；下次启动需重建搜索索引，搜索暂时可能不可用。",
    };
  if (
    modernContext(root) &&
    /^sessions\/\d{13}_[a-z0-9]{5}\/hooks\.jsonl$/.test(relativePath)
  )
    return {
      category: "log" as const,
      risk: "review" as const,
      reason:
        "旧版 Cline SDK 的会话调试遥测。隔离会移走调试记录，不移动对话、清单或索引；最新会话、近期活动及不完整会话保持保护。",
    };
  if (
    /^(?:logs\/|sessions\/)/.test(relativePath) &&
    /(?:\.log|\.jsonl)$/.test(relativePath)
  )
    return {
      category: "log" as const,
      risk: "protected" as const,
      reason: "当前共享日志、未知遥测格式及非白名单日志始终保护。",
    };
  return protectedEntry(
    "Cline 任务、对话、检查点、索引、设置、凭据、MCP、记忆和未知格式均保留；本版不拆分任务包。",
  );
}

function canTraverse(relativeDirectory: string, root?: string): boolean {
  if (root && legacyRoot(root) && relativeDirectory === "cache") return true;
  if (!modernContext(root) || !validRelative(relativeDirectory)) return false;
  return (
    ["sessions", "checkpoint-scratch", "db"].includes(relativeDirectory) ||
    /^sessions\/\d{13}_[a-z0-9]{5}$/.test(relativeDirectory)
  );
}

async function sessionProtectedPaths(root: string): Promise<string[]> {
  if (!modernContext(root)) return ["sessions/"];
  const sessions = path.join(root, "sessions");
  try {
    if (!directory(await metadata(sessions))) return ["sessions/"];
    const handle = await fs.opendir(sessions);
    const records: Array<{ prefix: string; modified: number }> = [];
    const exclusions: string[] = [];
    let visited = 0;
    for await (const entry of handle) {
      if (++visited > MAX_SESSIONS) return ["sessions/"];
      if (!SESSION_ID.test(entry.name)) continue;
      const prefix = `sessions/${entry.name}/`;
      const dir = path.join(sessions, entry.name);
      const dirStat = await metadata(dir);
      if (!directory(dirStat)) {
        exclusions.push(prefix);
        continue;
      }
      const manifest = await metadata(path.join(dir, `${entry.name}.json`));
      const messages = await metadata(
        path.join(dir, `${entry.name}.messages.json`),
      );
      if (!ordinary(manifest) || !ordinary(messages)) {
        exclusions.push(prefix);
        continue;
      }
      // Directory mtime changes during our own quarantine/restore. Derive activity
      // only from retained canonical companions so an isolated log remains restorable.
      const modified = Math.max(manifest!.mtimeMs, messages!.mtimeMs);
      if (!Number.isFinite(modified)) return ["sessions/"];
      records.push({ prefix, modified });
      // This floor is intentionally stricter than a user's smaller file-age filter.
      if (modified > Date.now() - 30 * DAY) exclusions.push(prefix);
    }
    const newest = records.reduce(
      (max, record) => Math.max(max, record.modified),
      -Infinity,
    );
    for (const record of records)
      if (record.modified === newest) exclusions.push(record.prefix);
    const unique = [...new Set(exclusions)];
    return unique.length > 9_999 ? ["sessions/"] : unique;
  } catch {
    // Unreadable/changing metadata cannot establish inactivity. No best-effort cleanup.
    return ["sessions/"];
  }
}

async function cacheProtectedPaths(root: string): Promise<string[]> {
  if (!modernContext(root)) return [];
  const exclusions: string[] = [];
  try {
    const scratchBase = path.join(root, "checkpoint-scratch");
    const baseStat = await metadata(scratchBase);
    if (baseStat && !directory(baseStat))
      exclusions.push("checkpoint-scratch/");
    else if (baseStat) {
      const records: Array<{ path: string; modified: number }> = [];
      const handle = await fs.opendir(scratchBase);
      let visited = 0;
      for await (const entry of handle) {
        if (++visited > 5_000) {
          exclusions.push("checkpoint-scratch/");
          break;
        }
        const relative = `checkpoint-scratch/${entry.name}`;
        if (!SCRATCH_DIRECTORY.test(relative)) continue;
        const full = path.join(scratchBase, entry.name);
        const stat = await metadata(full);
        if (!directory(stat)) {
          exclusions.push(relative + "/");
          continue;
        }
        const index = await metadata(path.join(full, "index"));
        const pathspec = await metadata(path.join(full, "pathspec"));
        if (!ordinary(index) || !ordinary(pathspec)) {
          exclusions.push(relative + "/");
          continue;
        }
        const modified = Math.max(
          stat!.mtimeMs,
          index!.mtimeMs,
          pathspec!.mtimeMs,
        );
        records.push({ path: relative, modified });
        if (!Number.isFinite(modified) || modified > Date.now() - 30 * DAY)
          exclusions.push(relative + "/");
      }
      const newest = records.reduce(
        (max, record) => Math.max(max, record.modified),
        -Infinity,
      );
      for (const record of records)
        if (record.modified === newest) exclusions.push(record.path + "/");
    }
  } catch {
    exclusions.push("checkpoint-scratch/");
  }
  try {
    const dbDirectory = path.join(root, "db");
    if (!directory(await metadata(dbDirectory)))
      exclusions.push(...SEARCH_FILES);
    else {
      const handle = await fs.opendir(dbDirectory);
      let visited = 0;
      for await (const entry of handle) {
        if (++visited > 5_000) {
          exclusions.push(...SEARCH_FILES);
          break;
        }
        if (
          entry.name.startsWith("session-search") &&
          !SEARCH_FILES.includes(`db/${entry.name}`)
        )
          exclusions.push(...SEARCH_FILES);
      }
      for (const relative of SEARCH_FILES) {
        const stat = await metadata(path.join(root, relative));
        if (stat && (!ordinary(stat) || stat.mtimeMs > Date.now() - 30 * DAY))
          exclusions.push(...SEARCH_FILES);
      }
    }
  } catch {
    exclusions.push(...SEARCH_FILES);
  }
  return [...new Set(exclusions)];
}

async function protectedPaths(root: string): Promise<string[]> {
  const exclusions = [
    ...(await sessionProtectedPaths(root)),
    ...(await cacheProtectedPaths(root)),
  ];
  return exclusions.length > 9_999
    ? ["sessions/", "checkpoint-scratch/", ...SEARCH_FILES]
    : [...new Set(exclusions)];
}

function assessProcesses(snapshot: ProcessSnapshot) {
  if (
    !snapshot.complete ||
    !["darwin", "linux", "win32"].includes(snapshot.platform) ||
    !snapshot.processes.length ||
    snapshot.processes.some((p) => !p.name?.trim() || /[\r\n\0]/.test(p.name))
  )
    return {
      status: "unknown" as const,
      details: "进程枚举不完整，无法确认 Cline 与所有宿主已退出。",
    };
  const names = snapshot.processes.map((p) =>
    slash(p.name).split("/").at(-1)!.toLowerCase(),
  );
  const hosts =
    /^(?:cline(?:[ ._-].*)?|code(?: - insiders| - oss)?(?: helper(?: \([^)]*\))?)?|visual studio code(?: - insiders)?|cursor(?: helper(?: \([^)]*\))?)?|windsurf(?: helper(?: \([^)]*\))?)?|codium(?: helper(?: \([^)]*\))?)?|vscodium|idea(?:64)?|pycharm(?:64)?|webstorm(?:64)?|rustrover(?:64)?|goland(?:64)?|rider(?:64)?|clion(?:64)?|phpstorm(?:64)?|datagrip(?:64)?)(?:\.exe)?$/i;
  if (
    names.some((name) => hosts.test(name)) ||
    snapshot.processes.some((p) =>
      /(?:saoudrizwan\.claude-dev|(?:^|[\\/\s])cline(?:[\\/\s._-]|$)|@cline[\\/]|\.vscode-server|\.vscode-server-insiders)/i.test(
        p.commandLine ?? "",
      ),
    )
  )
    return {
      status: "running" as const,
      details:
        "检测到 Cline 或可能承载 Cline 的编辑器/服务，请全部退出后再操作。",
    };
  // Missing/eval-only runtime arguments cannot identify the application. A fully
  // attributed unrelated script may proceed only with the engine's explicit
  // all-clients-closed confirmation; custom embedded SDK imports are undetectable.
  if (
    snapshot.processes.some((record, index) => {
      if (
        !/^(?:node|nodejs|bun|deno|electron|java|javaw)(?:[.\d-].*)?(?:\.exe)?$/i.test(
          names[index],
        )
      )
        return false;
      const args = record.commandLine?.trim();
      return (
        !args ||
        /[\r\n\0]/.test(args) ||
        /(?:^|\s)(?:-e|--eval|--print|-p|--require|-r)(?:\s|=|$)/.test(args) ||
        !/(?:^|\s)["']?(?:[a-z]:[\\/]|\/)[^\r\n]*?\.(?:[cm]?js|tsx?|jar)["']?(?=\s|$)/i.test(
          args,
        )
      );
    })
  )
    return {
      status: "unknown" as const,
      details:
        "通用宿主进程缺少可归属的完整参数，无法排除 Cline SDK 或后台服务，已阻止文件操作。",
    };
  return {
    status: "clear" as const,
    details:
      "完整进程快照中未发现 Cline 或已知宿主；自定义嵌入式 SDK 无法完全识别，仍须确认所有 Cline 客户端及后台服务已退出。",
  };
}

export const clineAdapter: ProviderAdapter = {
  id: "cline",
  label: "Cline",
  scope:
    "可复核隔离当前 Cline 的可重建检查点临时缓存、全文搜索缓存整组，以及旧版模型目录缓存和会话调试遥测。完整任务/历史归档尚未实现；对话、状态、凭据及真实检查点保留。",
  discover,
  validateRoot,
  classify,
  canTraverse,
  protectedPaths,
  async cleanupUnit(relativePath, root) {
    if (modernContext(root) && SCRATCH_DIRECTORY.test(relativePath))
      return {
        policy: CHECKPOINT_SCRATCH_POLICY,
        kind: "directory",
        members: [{ path: relativePath, kind: "directory" }],
      };
    if (modernContext(root) && relativePath === SEARCH_FILES[0])
      return {
        policy: SEARCH_CACHE_POLICY,
        kind: "bundle",
        members: SEARCH_FILES.map((file, index) => ({
          path: file,
          kind: "file" as const,
          ...(index ? { optional: true } : {}),
        })),
      };
    return legacyRoot(root) && MODEL_CATALOGS.has(relativePath)
      ? {
          policy: MODEL_CATALOG_POLICY,
          kind: "bundle",
          members: [{ path: relativePath, kind: "file" }],
        }
      : null;
  },
  unitEntryAllowed(policy, relativePath, kind) {
    if (policy === CHECKPOINT_SCRATCH_POLICY)
      return kind === "directory"
        ? SCRATCH_DIRECTORY.test(relativePath)
        : /^checkpoint-scratch\/[a-f0-9]{32}\/(?:index|pathspec)$/.test(
            relativePath,
          );
    if (policy === SEARCH_CACHE_POLICY)
      return kind === "file" && SEARCH_FILES.includes(relativePath);
    return (
      policy === MODEL_CATALOG_POLICY &&
      kind === "file" &&
      MODEL_CATALOGS.has(relativePath)
    );
  },
  unitLayoutAllowed(definition, entries) {
    if (definition.policy === CHECKPOINT_SCRATCH_POLICY) {
      const prefix = definition.members[0]?.path;
      return (
        definition.members.length === 1 &&
        SCRATCH_DIRECTORY.test(prefix) &&
        entries.length === 3 &&
        entries.some(
          (entry) => entry.path === prefix && entry.kind === "directory",
        ) &&
        ["index", "pathspec"].every((name) =>
          entries.some(
            (entry) =>
              entry.path === `${prefix}/${name}` && entry.kind === "file",
          ),
        )
      );
    }
    if (definition.policy === SEARCH_CACHE_POLICY)
      return (
        entries.some(
          (entry) => entry.path === SEARCH_FILES[0] && entry.kind === "file",
        ) &&
        entries.every(
          (entry) => entry.kind === "file" && SEARCH_FILES.includes(entry.path),
        )
      );
    return (
      definition.policy === MODEL_CATALOG_POLICY &&
      definition.members.length === 1 &&
      entries.length === 1 &&
      entries[0].kind === "file" &&
      entries[0].path === definition.members[0].path &&
      MODEL_CATALOGS.has(entries[0].path)
    );
  },
  assessProcesses,
};
