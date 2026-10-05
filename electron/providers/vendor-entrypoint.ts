import type { ProviderId } from "../../shared/types.js";
/** Shared vendor families. Observed-argv callers supply only actual executable,
 * script, module or loader positions; never unrelated trailing application data. */
export function knownProviderEntrypoint(provider: ProviderId, value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? "";
  if (provider === "claude-code") return /^claude(?:-code)?(?:\.exe|\.cmd|\.js)?$/i.test(name) ||
    /^claude_agent_sdk(?:\.|$)/i.test(normalized) || /(?:^|\/)claude_agent_sdk(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)@anthropic-ai\/claude-(?:code|agent-sdk)(?:[-/]|$)/i.test(normalized) ||
    /(?:^|\/)anthropic\.claude-code[-/]/i.test(normalized) || /\/claude\/versions\/[^/]+$/.test(normalized);
  if (provider === "cline") return /(?:saoudrizwan\.claude-dev|(?:^|[\/\s])cline(?:[\/\s._-]|$)|@cline\/|\.vscode-server|\.vscode-server-insiders)/i.test(normalized);
  if (provider === "cursor") return /^cursor(?:(?:[-_](?:agent|server|helper))|(?: helper(?: \([^)]*\))?))?(?:\.exe|\.appimage)?$/i.test(name) ||
    /(?:^|\/)(?:Cursor\.app|cursor|cursor-agent|\.cursor-server)\//i.test(normalized) ||
    /(?:^|\/)\.local\/bin\/agent$/i.test(normalized);
  return false;
}
