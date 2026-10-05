/** Read-only root recognition. This deliberately grants no cleanup authority. */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  checkConversationAbort,
  ConversationReadError,
  openConversationFile,
} from "./safe-read.js";
export interface ClineReadRootIdentity {
  kind: "sdk" | "legacy";
  marker: "sqlite" | "file-index" | "legacy-index";
  readOnly: true;
}
const wrongNamespace =
  /(?:^|[\\/])(?:\.codex|\.claude|\.cursor|rooveterinaryinc\.roo-cline|rooveterinaryinc\.roo-code|kilocode\.kilo-code)(?:[\\/]|$)/i;
async function ordinaryDirectory(
  root: string,
  relative: string,
): Promise<void> {
  let current = path.parse(root).root;
  for (const component of path
    .join(root, relative)
    .slice(current.length)
    .split(path.sep)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  }
}
/** Metadata only. Actual manifest/envelope schema validation occurs after content consent. */
export async function validateClineReadRoot(
  root: string,
  signal?: AbortSignal,
): Promise<ClineReadRootIdentity> {
  try {
    checkConversationAbort(signal);
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      root === path.parse(root).root ||
      wrongNamespace.test(root)
    )
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    const normalized = root.replaceAll("\\", "/").toLowerCase();
    const legacy = normalized.endsWith("/globalstorage/saoudrizwan.claude-dev");
    if (!legacy && normalized.includes("/globalstorage/"))
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    await ordinaryDirectory(root, legacy ? "tasks" : "sessions");
    const candidates = legacy
      ? ["state/taskHistory.json"]
      : ["db/sessions.db", "sessions/sessions.index.json"];
    for (const relative of candidates) {
      checkConversationAbort(signal);
      try {
        const marker = await openConversationFile(root, relative, signal);
        try {
          await marker.verifyUnchanged();
        } finally {
          await marker.close();
        }
        return {
          kind: legacy ? "legacy" : "sdk",
          marker: legacy
            ? "legacy-index"
            : relative.endsWith(".db")
              ? "sqlite"
              : "file-index",
          readOnly: true,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  } catch (error) {
    if (error instanceof ConversationReadError) throw error;
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  }
}
