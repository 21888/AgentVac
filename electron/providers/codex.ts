import { promises as fs } from "node:fs";
import path from "node:path";
import type { Entry } from "../../shared/types.js";
import type { ProviderAdapter } from "./types.js";
import { validRelative } from "./paths.js";
const Q = ".agentvac-quarantine";
function classifyCodexLegacy(
  p: string,
): Pick<Entry, "category" | "risk" | "reason"> {
  if (!validRelative(p))
    return {
      category: "protected",
      risk: "protected",
      reason: "路径无效，拒绝访问。",
    };
  const parts = p.split("/");
  const name = parts.at(-1)!;
  if (p === "log/codex-tui.log")
    return {
      category: "log",
      risk: "protected",
      reason: "当前运行日志始终保护，即使修改时间较早。",
    };
  if (
    parts.length === 1 &&
    /^logs_\d+\.sqlite(?:-(wal|shm|journal))?$/.test(name)
  )
    return {
      category: "log",
      risk: "protected",
      reason:
        "Codex 实时日志数据库及旁路文件，仅统计大小。本版不执行 VACUUM、修改数据库或移走日志数据库。",
    };
  if (
    parts.some(
      (s) =>
        s === Q ||
        /^(auth|credentials?|config|state|history|session_index)([._-]|$)/i.test(
          s,
        ),
    ) ||
    /\.(sqlite|sqlite3|db)(-(wal|shm|journal))?$/i.test(name) ||
    ["AGENTS.md", "version.json"].includes(name)
  )
    return {
      category: "protected",
      risk: "protected",
      reason: "凭据、配置、状态数据库、历史索引和运行状态始终保留。",
    };
  if (/^(sessions|archived_sessions)\/(?:[^/]+\/)*[^/]+\.jsonl$/.test(p))
    return {
      category: "session",
      risk: "review",
      reason:
        "会话原文可能用于恢复对话；移走会影响 resume/历史。不会同步修改状态数据库或修复索引，需自行确认不再使用。",
    };
  if (/^log\/codex-tui\.log(?:\.\d+|\.\d{4}-\d{2}-\d{2})(?:\.gz)?$/.test(p))
    return {
      category: "log",
      risk: "safe",
      reason:
        "匹配旧轮转日志白名单；不涉及当前 codex-tui.log。请先退出 Codex 再隔离。",
    };
  if (/^(?:cache|\.cache)\/[^/]+\.cache$/.test(p))
    return {
      category: "cache",
      risk: "review",
      reason:
        "缓存候选，扩展名不能证明可重建。本版仅展示，未验证其用途前保持保护。",
    };
  return {
    category: "protected",
    risk: "protected",
    reason:
      p === "log/codex-tui.log"
        ? "当前运行日志始终保护，即使修改时间较早。"
        : "不在明确白名单内，默认保护；不递归检查项目、技能、MCP 或未知目录。",
  };
}
/** Versioned recovery-only policy. This never authorizes a new source move. */
export function codexLegacyRestoreFileAllowed(
  relative: string,
  journalVersion: number,
): boolean {
  const prior = classifyCodexLegacy(relative);
  if (prior.category === "session")
    return (
      (journalVersion === 1 || journalVersion === 2) && prior.risk === "review"
    );
  return prior.risk !== "protected" && prior.category !== "cache";
}
export function classifyCodex(
  relative: string,
): Pick<Entry, "category" | "risk" | "reason"> {
  const prior = classifyCodexLegacy(relative);
  return prior.category === "session"
    ? {
        ...prior,
        risk: "protected",
        reason:
          "会话可能被其他对话或当前历史版本引用；完整依赖策略验证前，不允许新的会话文件隔离。已有签名隔离记录仍可恢复。",
      }
    : prior;
}
export const codexAdapter: ProviderAdapter = {
  id: "codex",
  label: "Codex",
  supportsSessionCleanup: false,
  restoreFileAllowed: codexLegacyRestoreFileAllowed,
  scope:
    "旧轮转日志可隔离；会话原文仅查看，完整依赖策略验证前不再移走。已有签名会话隔离记录仍可恢复。",
  discover({ home, env, platform }) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const root = env.CODEX_HOME || p.join(home, ".codex");
    return p.isAbsolute(root)
      ? [
          {
            provider: "codex",
            path: p.normalize(root),
            source: env.CODEX_HOME ? "CODEX_HOME" : "default",
            label: "Codex 数据目录",
          },
        ]
      : [];
  },
  // Legacy explicitly selected Codex roots remain usable, including old recovery roots.
  async validateRoot(root) {
    const components = root.replaceAll("\\", "/").split("/");
    if (
      components.some((part) =>
        /^(?:\.claude|\.cline|Cursor|saoudrizwan\.claude-dev)$/i.test(part),
      )
    )
      throw new Error("该目录属于其他提供方，请选择正确提供方后再打开。");
    for (const relative of ["db/sessions.db", "User/globalStorage"]) {
      try {
        await fs.lstat(path.join(root, ...relative.split("/")));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR"
        )
          continue;
        throw error;
      }
      throw new Error(
        "该目录包含其他提供方的数据布局，不能作为 Codex 根目录使用。",
      );
    }
  },
  classify: classifyCodex,
  canTraverse: (relative) =>
    /^(log|sessions|archived_sessions|cache|\.cache)(\/|$)/.test(relative),
  assessProcesses(snapshot) {
    if (!snapshot.complete)
      return {
        status: "unknown",
        details: "无法可靠检测 Codex 进程，已阻止文件操作。",
      };
    const found = snapshot.processes.filter(
      (item) =>
        /^codex(?:[ ._-]|$)/i.test(item.name.split(/[\\/]/).at(-1) ?? "") ||
        /(?:^|[\s/\\])codex(?:\.exe)?(?:\s|$)/i.test(item.commandLine ?? ""),
    );
    return found.length
      ? { status: "running", details: "检测到 Codex 相关进程，请先退出。" }
      : {
          status: "clear",
          details:
            "未检测到常见 Codex 进程；仍需确认全部 CLI 和桌面窗口已退出。",
        };
  },
};
