import { codexConversationReader } from "./codex.js";
import { claudeCodeConversationReader } from "./claude-code.js";
import { clineConversationReader } from "./cline.js";
import { cursorConversationReader } from "./cursor.js";
export const conversationReaders = [
  codexConversationReader,
  claudeCodeConversationReader,
  clineConversationReader,
  cursorConversationReader,
] as const;
