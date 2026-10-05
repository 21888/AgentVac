import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessStatus } from "../shared/types.js";
const run = promisify(execFile);
export async function checkCodexProcesses(): Promise<ProcessStatus> {
  try {
    const { stdout } =
      process.platform === "win32"
        ? await run("tasklist.exe", ["/FO", "CSV", "/NH"], {
            timeout: 5000,
            maxBuffer: 4_000_000,
            windowsHide: true,
          })
        : await run("/bin/ps", ["-eo", "comm="], {
            timeout: 5000,
            maxBuffer: 4_000_000,
          });
    const names = stdout
      .split(/\r?\n/)
      .map((line) =>
        process.platform === "win32"
          ? (line.match(/^"([^"]+)"/)?.[1] ?? "")
          : (line.trim().split("/").at(-1) ?? ""),
      );
    const running = names.filter((n) => /^codex(?:[ ._-]|$)/i.test(n));
    return running.length
      ? {
          status: "running",
          details: "检测到 Codex 相关进程：" + [...new Set(running)].join("、"),
        }
      : {
          status: "clear",
          details:
            "未检测到常见 Codex 进程名。检测并非完备，仍须确认已退出全部 CLI 和桌面窗口。",
        };
  } catch {
    return {
      status: "unknown",
      details: "无法可靠检测进程。请手动退出所有 Codex CLI / 桌面进程后继续。",
    };
  }
}
