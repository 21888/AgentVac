import { hasUnambiguousRawScript } from "./runtime-attribution.js";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type { Entry, ProcessStatus } from "../../shared/types.js";
import type { CleanupUnitDefinition } from "../cleanup-units.js";
import type {
  ProviderAdapter,
  ProviderCandidate,
  ProviderDiscoveryInputs,
  ProcessSnapshot,
} from "./types.js";

// Reviewed against Anthropic's public documentation on 2026-10-05.
// This is a file-layout policy, not a parser for Claude's unstable transcripts.
const DEBUG_LOG =
  /^debug\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/;
const BAD_ROOT =
  "无法确认这是独立的 Claude Code 数据目录；需要 projects 目录及 history.jsonl、settings.json 或 .credentials.json 中至少一项。目录内容未读取或修改。";
const CLASSIFICATION_PROTECTED = {
  category: "protected",
  risk: "protected",
  reason:
    "Claude Code 凭据、设置、记忆、插件、索引及未知格式均保留；会话仅可作为经过复核的完整存储单元归档。",
} as const;

function validRelative(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\\x00-\x1f\x7f:]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function discoveryPath(
  value: string | undefined,
  inputs: ProviderDiscoveryInputs,
): string | undefined {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  const p = inputs.platform === "win32" ? path.win32 : path.posix;
  if (value === "~") value = inputs.home;
  else if (/^~[\\/]/.test(value)) value = p.join(inputs.home, value.slice(2));
  if (!p.isAbsolute(value) || p.normalize(value) !== value) return undefined;
  // Discovery must not suggest drive roots, home directories or remote shares.
  if (value === p.parse(value).root || value === inputs.home) return undefined;
  if (
    inputs.platform === "win32" &&
    (!/^[a-z]:\\/i.test(value) || value.slice(2).includes(":"))
  )
    return undefined;
  return value;
}

function discover(inputs: ProviderDiscoveryInputs): ProviderCandidate[] {
  if (!["darwin", "linux", "win32"].includes(inputs.platform)) return [];
  const p = inputs.platform === "win32" ? path.win32 : path.posix;
  const possibilities = [
    {
      value: inputs.env.CLAUDE_CONFIG_DIR,
      source: "CLAUDE_CONFIG_DIR",
      label: "Claude Code 自定义配置目录",
    },
    {
      value: p.join(inputs.home, ".claude"),
      source: "default",
      label: "Claude Code 默认数据目录",
    },
  ];
  const seen = new Set<string>();
  const output: ProviderCandidate[] = [];
  for (const item of possibilities) {
    const candidate = discoveryPath(item.value, inputs);
    const key =
      inputs.platform === "win32" ? candidate?.toLowerCase() : candidate;
    if (!candidate || !key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      provider: "claude-code",
      path: candidate,
      source: item.source,
      label: item.label,
    });
  }
  return output;
}

async function optionalStat(file: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateRoot(root: string): Promise<void> {
  if (
    typeof root !== "string" ||
    root.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(root) ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    path.resolve(root) !== root ||
    root === path.parse(root).root
  )
    throw new Error(BAD_ROOT);
  let current = path.parse(root).root;
  for (const segment of root
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(BAD_ROOT);
  }
  // Multiple independent layout markers prevent a project-local .claude or an
  // arbitrary folder named .claude/debug from being treated as a user data root.
  const projects = await optionalStat(path.join(root, "projects"));
  if (!projects?.isDirectory() || projects.isSymbolicLink())
    throw new Error(BAD_ROOT);
  const debug = await optionalStat(path.join(root, "debug"));
  if (debug && (!debug.isDirectory() || debug.isSymbolicLink()))
    throw new Error(BAD_ROOT);
  let identityFiles = 0;
  for (const name of ["history.jsonl", "settings.json", ".credentials.json"]) {
    const stat = await optionalStat(path.join(root, name));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(BAD_ROOT);
    identityFiles++;
  }
  if (!identityFiles) throw new Error(BAD_ROOT);
  // Do not silently reinterpret a mixed-provider directory. No file is opened.
  for (const name of [
    "config.toml",
    "auth.json",
    "session_index.jsonl",
    "archived_sessions",
    "api_conversation_history.json",
    "ui_messages.json",
    "taskHistory.json",
    "state.vscdb",
    "globalStorage",
    "workspaceStorage",
  ]) {
    if (await optionalStat(path.join(root, name)))
      throw new Error(
        "所选目录包含其他助手的数据标记；请为 Claude Code 选择独立的数据根目录。",
      );
  }
}

function classify(
  relativePath: string,
): Pick<Entry, "category" | "risk" | "reason"> {
  if (!validRelative(relativePath))
    return { ...CLASSIFICATION_PROTECTED, reason: "路径无效，拒绝访问。" };
  if (DEBUG_LOG.test(relativePath)) {
    return {
      category: "log",
      risk: "safe",
      reason:
        "标准 Claude Code 会话调试日志。仅当超过所选保留天数且已退出 CLI、IDE、桌面及后台服务时可隔离；日志可能含敏感内容，扫描不读取正文。",
    };
  }
  if (SESSION_ANCHOR.test(relativePath))
    return {
      category: "session",
      risk: "review",
      reason:
        "完整会话存储单元：主记录与关联子代理、工具输出一起隔离，恢复时一并还原。隔离期间不能恢复此对话；全局提示历史、配置和项目记忆不改写。",
    };
  if (
    relativePath === "projects" ||
    relativePath.startsWith("projects/") ||
    relativePath === "history.jsonl" ||
    relativePath === "sessions" ||
    relativePath.startsWith("sessions/")
  ) {
    return {
      category: "session",
      risk: "protected",
      reason:
        "Claude Code 项目记忆、全局提示历史、运行记录及未知会话布局始终保护；不读取对话正文，不改写历史索引。",
    };
  }
  return CLASSIFICATION_PROTECTED;
}

async function logProtectedPaths(root: string): Promise<string[]> {
  await validateRoot(root);
  try {
    // A marker may represent a running session or a crash leftover. Without
    // reading its unstable contents, neither is safe to dismiss by age alone.
    if (await optionalStat(path.join(root, "daemon.lock"))) return ["debug/"];
    const sessions = await optionalStat(path.join(root, "sessions"));
    if (sessions) {
      if (!sessions.isDirectory() || sessions.isSymbolicLink())
        return ["debug/"];
      const handle = await fs.opendir(path.join(root, "sessions"));
      for await (const _entry of handle) return ["debug/"];
    }
    const debug = await optionalStat(path.join(root, "debug"));
    if (!debug) return [];
    if (!debug.isDirectory() || debug.isSymbolicLink()) return ["debug/"];
    let newest = -Infinity;
    let count = 0;
    let protectedFiles: string[] = [];
    const handle = await fs.opendir(path.join(root, "debug"));
    for await (const entry of handle) {
      // An incomplete dynamic view must not authorize a subset of a large tree.
      if (++count > 10000) return ["debug/"];
      const relative = "debug/" + entry.name;
      if (!DEBUG_LOG.test(relative)) continue;
      const stat = await fs.lstat(path.join(root, "debug", entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      if (!Number.isFinite(stat.mtimeMs)) return ["debug/"];
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
        protectedFiles = [relative];
      } else if (stat.mtimeMs === newest) protectedFiles.push(relative);
    }
    return protectedFiles;
  } catch {
    return ["debug/"];
  }
}

function assessProcesses(snapshot: ProcessSnapshot): ProcessStatus {
  if (!snapshot || !Array.isArray(snapshot.processes))
    return {
      status: "unknown",
      details: "无法可靠枚举 Claude Code 相关进程。",
    };
  let uncertain =
    snapshot.complete !== true ||
    snapshot.processes.length === 0 ||
    !["darwin", "linux", "win32"].includes(snapshot.platform);
  for (const process of snapshot.processes) {
    if (!process || typeof process.name !== "string" || !process.name.trim()) {
      uncertain = true;
      continue;
    }
    const name = process.name.replace(/\\/g, "/").split("/").at(-1)!.trim();
    const command =
      typeof process.commandLine === "string" ? process.commandLine : "";
    const tokens = (command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g) ?? []).map(
      (token) =>
        token.replace(
          /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
          (_match, double: string, single: string) => double ?? single,
        ),
    );
    const executable = tokens[0] ?? "";
    // Unsupported Python-family executable variants can still host SDK code.
    // Do not treat a name-grammar miss as proof of an unrelated process.
    if (
      /^python[a-z0-9_.-]*$/i.test(name) &&
      !/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name)
    )
      uncertain = true;
    const runtimeName =
      /^(?:node|nodejs|bun|python(?:\d+(?:\.\d+)*)?)(?:[ ._-]|$)/i.test(name);
    const entrypoints = [executable];
    let pythonModule = false;
    if (runtimeName) {
      // Only runtime entrypoints/loaders are evidence. Do not inspect inline
      // source strings or arguments passed to an unrelated application.
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (/^(?:-e|-p|-c|--eval|--print)(?:=|$)/.test(token)) break;
        if (/^python/i.test(name) && token === "-m") {
          pythonModule = true;
          if (tokens[i + 1]) entrypoints.push(tokens[i + 1]);
          break;
        }
        if (
          /^(?:--require|-r|--import|--loader|--experimental-loader)$/.test(
            token,
          )
        ) {
          if (tokens[i + 1]) entrypoints.push(tokens[++i]);
          continue;
        }
        if (
          /^(?:--require|--import|--loader|--experimental-loader)=/.test(token)
        ) {
          entrypoints.push(token.slice(token.indexOf("=") + 1));
          continue;
        }
        // Python warning/implementation options have a separate operand; it is
        // never the script entrypoint. Unsupported/module Python invocations
        // remain uncertain below unless a known SDK entrypoint is detected.
        if (
          /^python/i.test(name) &&
          (token === "-W" ||
            token === "-X" ||
            token === "--check-hash-based-pycs")
        ) {
          uncertain = true;
          if (tokens[i + 1]) i++;
          continue;
        }
        if (token.startsWith("-")) continue;
        if (token === "run" && /^bun/i.test(name)) continue;
        entrypoints.push(token);
        break;
      }
    }
    const knownEntrypoint = entrypoints.some((token) => {
      const normalized = token.replace(/\\/g, "/");
      const basename = normalized.split("/").at(-1) ?? "";
      return (
        /^claude(?:-code)?(?:\.exe|\.cmd|\.js)?$/i.test(basename) ||
        /^claude_agent_sdk(?:\.|$)/i.test(normalized) ||
        /(?:^|\/)claude_agent_sdk(?:\/|$)/i.test(normalized) ||
        /(?:^|\/)@anthropic-ai\/claude-(?:code|agent-sdk)(?:[-/]|$)/i.test(
          normalized,
        ) ||
        /(?:^|\/)anthropic\.claude-code[-/]/i.test(normalized) ||
        /\/claude\/versions\/[^/]+$/.test(normalized)
      );
    });
    if (/^claude(?:[ ._-]|$)/i.test(name) || knownEntrypoint)
      return {
        status: "running",
        details:
          "检测到 Claude Code、Claude 桌面或其后台/扩展进程；请先退出后重新扫描。",
      };
    // A complete, attributed unrelated script is not evidence of Claude.
    // Missing, inline or wrapper-only arguments remain uncertain. Custom SDK
    // embedding cannot be exhaustively identified by OS command lines.
    const runtime =
      /^(?:node|nodejs|bun|python(?:\d+(?:\.\d+)*)?)(?:[ ._-]|$)/i.test(name);
    const editor =
      /^(?:code(?:-insiders)?|cursor|windsurf|zed)(?:[ ._-]|$)/i.test(name);
    if (runtime) {
      const attributedScript = hasUnambiguousRawScript(
        command,
        snapshot.platform,
        name,
      );
      const inlineCode = /(?:^|\s)(?:-e|-p|-c|--eval|--print)(?:=|\s|$)/.test(
        command,
      );
      if (!attributedScript || pythonModule || inlineCode) uncertain = true;
    }
    if (editor && !command.trim()) uncertain = true;
    if (
      /[\x00-\x1f\x7f]/.test(process.name) ||
      /[\x00-\x1f\x7f]/.test(command) ||
      (process.commandLine !== undefined &&
        typeof process.commandLine !== "string")
    )
      uncertain = true;
  }
  return uncertain
    ? {
        status: "unknown",
        details:
          "进程检查不完整，或仍有可能承载 Claude Code 的运行时/编辑器进程；本版保守阻止操作。",
      }
    : {
        status: "clear",
        details:
          "未发现已知 Claude Code 或 Claude 桌面进程。自定义嵌入无法穷尽识别，仍须确认 CLI、扩展、SDK 与后台服务已退出。",
      };
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  label: "Claude Code",
  scope:
    "标准旧调试日志可隔离；开启会话复核后可归档已验证的完整本地会话记录与关联文件。保留最新与可能活跃数据，保护全局提示历史、记忆、凭据和插件。",
  discover,
  validateRoot,
  classify,
  protectedPaths: async (root: string) => {
    const [logs, sessions] = await Promise.all([
      logProtectedPaths(root),
      sessionProtectedPaths(root),
    ]);
    return logs.length + sessions.length > 10000
      ? ["debug/", "projects/"]
      : [...logs, ...sessions];
  },
  supportsSessionCleanup: true,
  cleanupUnit: async (relative: string, _root: string) => sessionUnit(relative),
  unitEntryAllowed: sessionUnitEntryAllowed,
  canTraverse: (relativeDirectory: string) =>
    relativeDirectory === "debug" ||
    relativeDirectory === "projects" ||
    PROJECT_DIRECTORY.test(relativeDirectory),
  assessProcesses,
};

// The metadata-only coherent unit follows the official SDK deletion boundary,
// pinned to v0.2.163 / 1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7.
const SESSION_POLICY = "claude-sdk-session-v1";
const SESSION_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PROJECT_COMPONENT = "[A-Za-z0-9_-]{1,240}";
const SESSION_ANCHOR = new RegExp(
  `^projects/(${PROJECT_COMPONENT})/(${SESSION_UUID})\\.jsonl$`,
);
const SESSION_TREE = new RegExp(
  `^projects/(${PROJECT_COMPONENT})/(${SESSION_UUID})(?:/(.*))?$`,
);
const PROJECT_DIRECTORY = new RegExp(`^projects/${PROJECT_COMPONENT}$`);
const SIMPLE_ID = "[A-Za-z0-9_-]{1,160}";

function sessionUnit(relative: string): CleanupUnitDefinition | null {
  if (!validRelative(relative) || !SESSION_ANCHOR.test(relative)) return null;
  return {
    policy: SESSION_POLICY,
    kind: "bundle",
    members: [
      { path: relative, kind: "file" },
      {
        path: relative.slice(0, -".jsonl".length),
        kind: "directory",
        optional: true,
      },
    ],
  };
}

function sessionUnitEntryAllowed(
  policy: string,
  relative: string,
  kind: "file" | "directory",
): boolean {
  if (policy !== SESSION_POLICY || !validRelative(relative)) return false;
  if (kind === "file" && SESSION_ANCHOR.test(relative)) return true;
  const match = SESSION_TREE.exec(relative);
  if (!match) return false;
  const suffix = match[3] ?? "";
  if (!suffix) return kind === "directory";
  if (
    suffix
      .split("/")
      .some((part) =>
        /^(?:\.|auth(?:[._-]|$)|credentials?(?:[._-]|$)|settings?(?:[._-]|$)|config(?:[._-]|$)|secrets?(?:[._-]|$)|tokens?(?:[._-]|$)|id_rsa(?:[._-]|$)|id_ed25519(?:[._-]|$)|CLAUDE\.md$|AGENTS\.md$|MEMORY\.md$)/i.test(
          part,
        ),
      )
  )
    return false;
  if (kind === "directory") {
    return (
      suffix === "subagents" ||
      suffix === "tool-results" ||
      suffix === "subagents/workflows" ||
      new RegExp(`^subagents/workflows/${SIMPLE_ID}$`).test(suffix)
    );
  }
  // The SDK's deletion test includes a legacy direct subagent UUID transcript.
  if (new RegExp(`^${SESSION_UUID}\\.jsonl$`).test(suffix)) return true;
  if (
    new RegExp(
      `^subagents/(?:workflows/${SIMPLE_ID}/)?agent-${SIMPLE_ID}(?:\\.jsonl|\\.meta\\.json)$`,
    ).test(suffix)
  )
    return true;
  // Tool results are opaque, documented text or image assets, never programs,
  // databases, arbitrary nested trees or files identified as credentials.
  return new RegExp(
    `^tool-results/${SIMPLE_ID}\\.(?:txt|png|jpg|jpeg|gif|webp)$`,
  ).test(suffix);
}

async function nonemptyOrUnsafeDirectory(
  root: string,
  relative: string,
): Promise<boolean> {
  const stat = await optionalStat(path.join(root, relative));
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  const handle = await fs.opendir(path.join(root, relative));
  for await (const _entry of handle) return true;
  return false;
}

async function sessionProtectedPaths(root: string): Promise<string[]> {
  await validateRoot(root);
  try {
    if (
      (await optionalStat(path.join(root, "daemon.lock"))) ||
      (await nonemptyOrUnsafeDirectory(root, "sessions")) ||
      (await nonemptyOrUnsafeDirectory(root, "jobs"))
    )
      return ["projects/"];
    const protectedPaths: string[] = [];
    const seenIds = new Map<string, string[]>();
    let visited = 0;
    const projects = await fs.opendir(path.join(root, "projects"));
    for await (const project of projects) {
      if (++visited > 10000) return ["projects/"];
      const prefix = `projects/${project.name}`;
      if (!PROJECT_DIRECTORY.test(prefix)) continue;
      const projectStat = await fs.lstat(path.join(root, prefix));
      if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
        protectedPaths.push(prefix);
        continue;
      }
      const entries = await fs.opendir(path.join(root, prefix));
      let newest = -Infinity;
      let latest: string[] = [];
      for await (const entry of entries) {
        if (++visited > 10000) return ["projects/"];
        const relative = `${prefix}/${entry.name}`;
        if (/^(?:sessions?[-_]index)(?:[._-]|$)/i.test(entry.name)) {
          protectedPaths.push(prefix + "/");
          continue;
        }
        const match = SESSION_ANCHOR.exec(relative);
        if (!match) {
          // Older flat subagent layouts do not encode their parent in the
          // filename. Never archive one side of such an unknown relationship.
          if (entry.name.endsWith(".jsonl")) protectedPaths.push(prefix + "/");
          // Superseded/orphaned/unknown sidecars correlated with an anchor make
          // that complete session unit unsupported; do not separate the copies.
          const sidecar = new RegExp(`^(${SESSION_UUID})[.-]`).exec(entry.name);
          if (sidecar)
            protectedPaths.push(
              `${prefix}/${sidecar[1]}.jsonl`,
              `${prefix}/${sidecar[1]}/`,
            );
          continue;
        }
        const stat = await fs.lstat(path.join(root, relative));
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          !Number.isFinite(stat.mtimeMs) ||
          stat.size === 0
        ) {
          protectedPaths.push(relative, relative.slice(0, -6) + "/");
          continue;
        }
        const seen = seenIds.get(match[2]) ?? [];
        seen.push(relative);
        seenIds.set(match[2], seen);
        if (stat.mtimeMs > newest) {
          newest = stat.mtimeMs;
          latest = [relative];
        } else if (stat.mtimeMs === newest) latest.push(relative);
      }
      for (const relative of latest)
        protectedPaths.push(relative, relative.slice(0, -6) + "/");
    }
    for (const duplicates of seenIds.values()) {
      if (duplicates.length > 1)
        for (const relative of duplicates)
          protectedPaths.push(relative, relative.slice(0, -6) + "/");
    }
    return protectedPaths.length > 9999
      ? ["projects/"]
      : [...new Set(protectedPaths)];
  } catch {
    return ["projects/"];
  }
}

export const claudeSessionUnitPolicy = {
  policy: SESSION_POLICY,
  cleanupUnit: async (relative: string, _root: string) => sessionUnit(relative),
  unitEntryAllowed: sessionUnitEntryAllowed,
  protectedPaths: sessionProtectedPaths,
  isAnchor: (relative: string) =>
    validRelative(relative) && SESSION_ANCHOR.test(relative),
  canTraverse: (relative: string) =>
    relative === "projects" || PROJECT_DIRECTORY.test(relative),
};
