import type { ProviderId } from "../shared/types";

// Display copy only. Eligibility remains controlled by the backend's live checks.
export const cleanupScope: Record<ProviderId, string> = {
  codex: "仅旧轮转日志可隔离；新的会话隔离已关闭，已验证的旧批次仍可恢复。",
  "claude-code":
    "旧调试日志及符合保护规则的完整本地会话可复核隔离；最新、活动和未知数据保持保护。",
  cline:
    "仅已确认的可重建缓存和符合规则的旧遥测可隔离；正式任务库和真实检查点保持保护。",
  cursor:
    "仅已识别的旧日志和完整缓存可隔离；聊天数据库、配置和未知数据保持保护。",
};

export const conversationScope: Record<ProviderId, string> = {
  codex: "查看和筛选支持的对话；Codex 会话只读，不提供新的隔离或删除。",
  "claude-code":
    "查看和筛选支持的对话；仅完整且符合保护规则的本地会话可申请隔离预览。",
  cline:
    "查看和筛选支持的对话；Cline 会话只读，不提供正式任务库或真实检查点清理。",
  cursor: "查看和筛选支持的对话；Cursor 聊天记录只读，不提供会话隔离或删除。",
};

export function conversationPlatformLimit(
  provider: ProviderId,
  platform: string,
  alternateReadOnlySource: boolean,
): string {
  if (provider === "cursor" && platform === "win32" && !alternateReadOnlySource)
    return "本版在 Windows 上不读取 Cursor IDE 数据库；可选择 agent-transcripts 查看支持的对话文本。";
  if (platform === "linux")
    return "部分 Linux 环境无法确认后台进程；状态不明时会暂停清理和恢复，可继续查看支持的数据。";
  return "读取与文件操作分别检查；不支持的格式或未通过的检查会明确提示。";
}
