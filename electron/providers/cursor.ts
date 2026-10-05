import { promises as fs } from "node:fs";
import path from "node:path";
import type { Entry, ProcessStatus } from "../../shared/types.js";
import type { CleanupUnitDefinition } from "../cleanup-units.js";
import type {
  ProcessSnapshot,
  ProviderAdapter,
  ProviderCandidate,
  ProviderDiscoveryInputs,
} from "./types.js";

const DAY = 86_400_000;
const MAX_LOG_SESSIONS = 10_000;
const WINDOW = /^window[1-9]\d*(?:_wb\d+)?$/;
const CACHE_POLICY = "cursor-known-cache-layout-v1";
const CACHE_ROOTS = new Set(["Cache", "Code Cache", "GPUCache", "CachedData"]);
const CODE_CACHE_TYPES = new Set(["js", "wasm", "webui_js"]);
type CacheNode = { path: string; kind: "file" | "directory" };
const PROTECTED = {
  category: "protected",
  risk: "protected",
  reason:
    "Cursor 默认保护未知数据、聊天数据库、配置、凭据、扩展和索引；仅允许已验证的旧日志与完整缓存单元。",
} as const;

function validRelative(value: string): boolean {
  return (
    !!value &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    value
      .split("/")
      .every(
        (part) =>
          !!part && part !== "." && part !== ".." && !part.includes(":"),
      )
  );
}

/** A folder name is a syntactic boundary, never a blanket file allowlist. */
function timestamp(name: string): number | null {
  const match = /^(20\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(value);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
    ? value
    : null;
}

function classify(
  relativePath: string,
): Pick<Entry, "category" | "risk" | "reason"> {
  if (!validRelative(relativePath)) return PROTECTED;
  if (CACHE_ROOTS.has(relativePath))
    return {
      category: "cache",
      risk: "review",
      reason:
        "Cursor 可重建缓存整目录候选；仅完整已知格式可隔离，所有成员须达到保留天数且应用已退出。下次启动可能重新下载资源或编译，未知文件使整组受保护。",
    };
  const parts = relativePath.split("/");
  if (parts[0] !== "logs") return PROTECTED;
  const date = timestamp(parts[1] ?? "");
  if (date === null) return PROTECTED;
  const knownFile =
    (parts.length === 3 && ["main.log", "renderer.log"].includes(parts[2])) ||
    (parts.length === 4 &&
      WINDOW.test(parts[2]) &&
      parts[3] === "renderer.log");
  if (!knownFile) return PROTECTED;
  // Cursor session timestamps are local wall time. A two-day safety margin also
  // protects current/future sessions without guessing the writer's time zone.
  if (date >= Date.now() - 2 * DAY)
    return {
      category: "log",
      risk: "protected",
      reason: "Cursor 当前、最近两天及未来日期的诊断日志始终保护。",
    };
  return {
    category: "log",
    risk: "safe",
    reason:
      "Cursor 已知旧 main/renderer 诊断日志；仍须满足保留天数、非最新日志目录且 Cursor 完全退出。不是聊天数据库清理。",
  };
}

function canTraverse(relativeDirectory: string): boolean {
  if (!validRelative(relativeDirectory)) return false;
  if (relativeDirectory === "logs") return true;
  const parts = relativeDirectory.split("/");
  return (
    parts[0] === "logs" &&
    timestamp(parts[1] ?? "") !== null &&
    (parts.length === 2 || (parts.length === 3 && WINDOW.test(parts[2])))
  );
}

function discover({
  home,
  env,
  platform,
}: ProviderDiscoveryInputs): ProviderCandidate[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const absolute = (value: string | undefined): value is string =>
    !!value && !value.includes("\0") && paths.isAbsolute(value);
  if (!absolute(home)) return [];
  let root: string;
  switch (platform) {
    case "darwin":
      root = paths.join(home, "Library", "Application Support", "Cursor");
      break;
    case "win32":
      root = paths.join(
        absolute(env.APPDATA)
          ? env.APPDATA
          : paths.join(home, "AppData", "Roaming"),
        "Cursor",
      );
      break;
    case "linux":
      // The IDE's standard root is vendor-documented. CURSOR_CONFIG_DIR and
      // the lowercase XDG cursor directory are CLI settings, not this root.
      root = paths.join(home, ".config", "Cursor");
      break;
    default:
      return [];
  }
  return [
    {
      provider: "cursor",
      path: root,
      source: "Cursor standard application data",
      label: "Cursor · 旧日志与已验证整组缓存（聊天数据库保护）",
    },
  ];
}

async function directory(location: string): Promise<void> {
  const stat = await fs.lstat(location);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Cursor 根目录及必要目录不能是链接或普通文件。");
}

async function validateRoot(root: string): Promise<void> {
  const components = root.replaceAll("\\", "/").split("/");
  if (
    !path.isAbsolute(root) ||
    root.includes("\0") ||
    components.some((part) => part === "." || part === "..") ||
    path.basename(root) !== "Cursor" ||
    components
      .slice(0, -1)
      .some((part) =>
        /^(?:\.cursor|\.vscode|Code(?: - Insiders)?|User|profiles|workspaceStorage|globalStorage|saoudrizwan\.claude-dev)$/i.test(
          part,
        ),
      )
  )
    throw new Error(
      "请选择 Cursor 应用数据根目录；.cursor、VS Code、工作区、扩展和配置档子目录不受支持。",
    );
  // No configuration, SQLite, credentials or chat content is opened. The
  // engine separately checks every ancestor and pins the root's identity.
  await directory(root);
  await directory(path.join(root, "User"));
  await directory(path.join(root, "User", "globalStorage"));
  await directory(path.join(root, "logs"));
}

async function protectedPaths(root: string): Promise<string[]> {
  await validateRoot(root);
  const logRoot = path.join(root, "logs");
  let newest: string | undefined;
  let seen = 0;
  // Bounded metadata-only enumeration; any failure aborts rather than guessing.
  const entries = await fs.opendir(logRoot);
  for await (const entry of entries) {
    if (++seen > MAX_LOG_SESSIONS)
      throw new Error(
        "Cursor 日志目录过多，无法完整识别最新会话；清理已停止。",
      );
    if (
      timestamp(entry.name) === null ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    const stat = await fs.lstat(path.join(logRoot, entry.name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (!newest || entry.name > newest) newest = entry.name;
  }
  return newest ? [`logs/${newest}/`] : [];
}

function assessProcesses(snapshot: ProcessSnapshot): ProcessStatus {
  const unknown = (details: string): ProcessStatus => ({
    status: "unknown",
    details,
  });
  if (
    !["darwin", "win32", "linux"].includes(snapshot.platform) ||
    !snapshot.complete ||
    !Array.isArray(snapshot.processes) ||
    !snapshot.processes.length
  )
    return unknown("Cursor 进程检查不完整，无法确认已退出；清理已阻止。");
  let ambiguous = false;
  for (const record of snapshot.processes) {
    if (
      !record ||
      typeof record.name !== "string" ||
      !record.name.trim() ||
      record.name.includes("\0") ||
      (record.commandLine !== undefined &&
        (typeof record.commandLine !== "string" ||
          record.commandLine.includes("\0")))
    )
      return unknown("Cursor 进程检查包含无效记录；清理已阻止。");
    const normalizedName = record.name.trim().replaceAll("\\", "/");
    const name = normalizedName.split("/").at(-1)!;
    const command = record.commandLine?.trim() ?? "";
    const cursorName =
      /^cursor(?:(?:[-_](?:agent|server|helper))|(?: helper(?: \([^)]*\))?))?(?:\.exe|\.appimage)?$/i;
    const tokens: string[] = [];
    for (const token of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      tokens.push(token[1] ?? token[2] ?? token[3]);
      if (tokens.length > 256)
        return unknown("进程参数超出可归属范围；清理已阻止。");
    }
    const cursorExecutable = (token: string) => {
      const normalized = token.replaceAll("\\", "/");
      return (
        cursorName.test(normalized.split("/").at(-1) ?? "") ||
        /(?:^|\/)(?:Cursor\.app|cursor|cursor-agent|\.cursor-server)\//i.test(
          normalized,
        ) ||
        /(?:^|\/)\.local\/bin\/agent$/i.test(normalized)
      );
    };
    // Only executable/entrypoint positions may identify Cursor. Quoted prose,
    // source code passed to node -e, and arbitrary later arguments are not an
    // executable identity (and previously caused false positives).
    const executable = tokens[0] ?? "";
    const runtime = /^(?:node|nodejs|electron|bun)(?:\.exe)?$/i;
    const isRuntime =
      runtime.test(name) ||
      runtime.test(executable.replaceAll("\\", "/").split("/").at(-1) ?? "");
    const entrypoints: string[] = [];
    let inline = false;
    let attributed = false;
    if (isRuntime) {
      for (let index = 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (/^(?:-e|-p|-c|--eval|--print|--check)(?:=|$)/.test(token)) {
          inline = true;
          break;
        }
        if (
          /^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(
            token,
          )
        ) {
          if (tokens[index + 1]) entrypoints.push(tokens[++index]);
          else inline = true;
          continue;
        }
        if (
          /^(?:--require|--import|--loader|--experimental-loader)=/.test(token)
        ) {
          entrypoints.push(token.slice(token.indexOf("=") + 1));
          continue;
        }
        if (
          /^(?:--inspect-port|--debug-port|--conditions|-C|--icu-data-dir|--openssl-config|--env-file|--env-file-if-exists)$/.test(
            token,
          )
        ) {
          if (!tokens[++index]) inline = true;
          continue;
        }
        if (token === "--") {
          if (tokens[index + 1]) {
            entrypoints.push(tokens[++index]);
            attributed = true;
          }
          break;
        }
        if (token.startsWith("-")) continue;
        entrypoints.push(token);
        attributed = /\.(?:[cm]?[jt]s)$/i.test(token);
        break;
      }
    }
    const runtimeEntrypoint = isRuntime && entrypoints.some(cursorExecutable);
    if (
      cursorExecutable(normalizedName) ||
      cursorExecutable(executable) ||
      runtimeEntrypoint
    )
      return {
        status: "running",
        details: "检测到 Cursor 编辑器、辅助进程或 CLI；请完全退出后再清理。",
      };
    // Without arguments, generic Electron/Node processes cannot be attributed
    // safely. A truncated snapshot is handled above, not treated as empty.
    if (
      (isRuntime && (!command || inline || !attributed)) ||
      /^agent(?:\.exe)?$/i.test(name)
    )
      ambiguous = true;
  }
  if (ambiguous)
    return unknown(
      "存在无法归属的 Electron/Node/agent 进程，不能排除 Cursor；清理已阻止。",
    );
  return {
    status: "clear",
    details:
      "完整进程列表未检测到已知 Cursor 进程；执行前仍须确认退出全部 Cursor 窗口与 CLI。",
  };
}

function blockfileName(name: string): boolean {
  const data = /^data_(0|[1-9]\d{0,2})$/.exec(name);
  return (
    name === "index" ||
    (data !== null && Number(data[1]) < 256) ||
    /^f_[0-9a-f]{6,8}$/.test(name)
  );
}

function simpleFileName(name: string): boolean {
  return (
    name === "index" ||
    /^[0-9a-f]{16}_[01s]$/.test(name) ||
    /^todelete_[0-9a-f]{16}_[01s]_[1-9]\d*$/.test(name)
  );
}

function backendEntryAllowed(
  parts: string[],
  kind: CacheNode["kind"],
): boolean {
  if (parts.length === 0) return kind === "directory";
  if (parts.length === 1)
    return kind === "directory"
      ? parts[0] === "index-dir"
      : simpleFileName(parts[0]) || blockfileName(parts[0]);
  return (
    parts.length === 2 &&
    parts[0] === "index-dir" &&
    kind === "file" &&
    ["the-real-index", "temp-index"].includes(parts[1])
  );
}

function codeEntryAllowed(parts: string[], kind: CacheNode["kind"]): boolean {
  if (parts.length === 0) return kind === "directory";
  return (
    CODE_CACHE_TYPES.has(parts[0]) && backendEntryAllowed(parts.slice(1), kind)
  );
}

function unitEntryAllowed(
  policy: string,
  relativePath: string,
  kind: CacheNode["kind"],
): boolean {
  if (policy !== CACHE_POLICY || !validRelative(relativePath)) return false;
  const [anchor, ...parts] = relativePath.split("/");
  if (!CACHE_ROOTS.has(anchor)) return false;
  if (!parts.length) return kind === "directory";
  if (anchor === "Cache")
    return backendEntryAllowed(
      parts[0] === "Cache_Data" ? parts.slice(1) : parts,
      kind,
    );
  if (anchor === "GPUCache") return backendEntryAllowed(parts, kind);
  if (anchor === "Code Cache") return codeEntryAllowed(parts, kind);
  if (!/^[0-9a-f]{40}$/.test(parts[0])) return false;
  if (parts.length === 1) return kind === "directory";
  if (parts[1] !== "chrome") return false;
  return codeEntryAllowed(parts.slice(2), kind);
}

function directChildren(
  entries: ReadonlyMap<string, CacheNode["kind"]>,
  prefix: string,
): string[] {
  return [...entries.keys()].filter(
    (entry) =>
      entry.startsWith(prefix + "/") &&
      !entry.slice(prefix.length + 1).includes("/"),
  );
}

function backendLayout(
  entries: ReadonlyMap<string, CacheNode["kind"]>,
  prefix: string,
  simpleOnly = false,
): boolean {
  if (
    entries.get(prefix) !== "directory" ||
    entries.get(prefix + "/index") !== "file"
  )
    return false;
  const keys = [...entries.keys()].filter((entry) =>
    entry.startsWith(prefix + "/"),
  );
  if (entries.has(prefix + "/index-dir")) {
    if (
      entries.get(prefix + "/index-dir") !== "directory" ||
      entries.get(prefix + "/index-dir/the-real-index") !== "file"
    )
      return false;
    return keys.every((key) => {
      const member = key.slice(prefix.length + 1);
      return member === "index-dir"
        ? entries.get(key) === "directory"
        : entries.get(key) === "file" &&
            (simpleFileName(member) ||
              /^index-dir\/(?:the-real-index|temp-index)$/.test(member));
    });
  }
  if (
    simpleOnly ||
    ![0, 1, 2, 3].every((n) => entries.get(`${prefix}/data_${n}`) === "file")
  )
    return false;
  return keys.every(
    (key) =>
      entries.get(key) === "file" &&
      blockfileName(key.slice(prefix.length + 1)),
  );
}

function codeLayout(
  entries: ReadonlyMap<string, CacheNode["kind"]>,
  prefix: string,
): boolean {
  const children = directChildren(entries, prefix);
  return (
    entries.get(prefix) === "directory" &&
    children.length > 0 &&
    children.every(
      (child) =>
        CODE_CACHE_TYPES.has(child.slice(prefix.length + 1)) &&
        backendLayout(entries, child, true),
    )
  );
}

function unitLayoutAllowed(
  definition: CleanupUnitDefinition,
  nodes: ReadonlyArray<CacheNode>,
): boolean {
  if (
    definition.policy !== CACHE_POLICY ||
    definition.kind !== "directory" ||
    definition.members.length !== 1
  )
    return false;
  const [member] = definition.members;
  const anchor = member.path;
  if (
    !CACHE_ROOTS.has(anchor) ||
    member.kind !== "directory" ||
    member.optional
  )
    return false;
  const entries = new Map<string, CacheNode["kind"]>();
  for (const node of nodes) {
    if (
      entries.has(node.path) ||
      (node.path !== anchor && !node.path.startsWith(anchor + "/")) ||
      !unitEntryAllowed(CACHE_POLICY, node.path, node.kind)
    )
      return false;
    entries.set(node.path, node.kind);
  }
  if (anchor === "GPUCache") return backendLayout(entries, anchor);
  if (anchor === "Code Cache") return codeLayout(entries, anchor);
  if (anchor === "Cache") {
    if (entries.has("Cache/Cache_Data"))
      return (
        directChildren(entries, anchor).length === 1 &&
        backendLayout(entries, "Cache/Cache_Data")
      );
    return backendLayout(entries, anchor);
  }
  const commits = directChildren(entries, anchor);
  return (
    entries.get(anchor) === "directory" &&
    commits.length > 0 &&
    commits.every(
      (commit) =>
        /^[0-9a-f]{40}$/.test(commit.slice(anchor.length + 1)) &&
        entries.get(commit) === "directory" &&
        directChildren(entries, commit).length === 1 &&
        codeLayout(entries, commit + "/chrome"),
    )
  );
}

async function cleanupUnit(
  relativePath: string,
  _root: string,
): Promise<CleanupUnitDefinition | null> {
  // Deterministic even when absent: authenticated restore validates the same
  // policy and the complete stored layout. No partial cache file is selectable.
  return CACHE_ROOTS.has(relativePath)
    ? {
        policy: CACHE_POLICY,
        kind: "directory",
        members: [{ path: relativePath, kind: "directory" }],
      }
    : null;
}

export const cursorAdapter: ProviderAdapter = {
  id: "cursor",
  label: "Cursor",
  scope:
    "旧 main/renderer 日志及已验证完整 Cache/Code Cache/GPUCache/CachedData；聊天 SQLite、最新日志、配置档、扩展、索引和 .cursor 保护。",
  discover,
  validateRoot,
  classify,
  canTraverse,
  protectedPaths,
  assessProcesses,
  cleanupUnit,
  unitEntryAllowed,
  unitLayoutAllowed,
};
