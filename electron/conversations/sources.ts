import { promises as fs } from "node:fs";
import path from "node:path";
import { validateClineReadRoot } from "./cline-read-root.js";
import { clineConversationReader } from "./cline.js";
import { cursorTranscriptReader } from "./cursor.js";
import type { ConversationReader } from "./types.js";
import type { ProviderId } from "../../shared/types.js";
export type ReadOnlySourceKind = "cline-sdk" | "cursor-transcripts";
export interface ReadOnlyConversationSource {
  kind: ReadOnlySourceKind;
  provider: ProviderId;
  root: string;
  label: string;
  reader: ConversationReader;
  verify(): Promise<void>;
}
/** Explicit user-selected read root. Metadata validation never grants mutation authority. */
export async function prepareReadOnlyConversationSource(
  kind: ReadOnlySourceKind,
  root: string,
): Promise<ReadOnlyConversationSource> {
  const fail = () =>
    Error("此目录不是受支持的只读会话来源，或目录身份已改变。");
  try {
    if (
      !["cline-sdk", "cursor-transcripts"].includes(kind) ||
      typeof root !== "string" ||
      root.length > 4096 ||
      !path.isAbsolute(root) ||
      path.normalize(root) !== root ||
      root === path.parse(root).root ||
      /[\x00-\x1f\x7f]/.test(root)
    )
      throw fail();
    const pins: { path: string; dev: number; ino: number }[] = [];
    let current = path.parse(root).root;
    for (const component of root
      .slice(current.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, component);
      const s = await fs.lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink()) throw fail();
      pins.push({ path: current, dev: s.dev, ino: s.ino });
    }
    const validate = async () => {
      if (kind === "cline-sdk") await validateClineReadRoot(root);
      else if (path.basename(root) !== "agent-transcripts") throw fail();
    };
    await validate();
    const verify = async () => {
      try {
        for (const pin of pins) {
          const s = await fs.lstat(pin.path);
          if (
            !s.isDirectory() ||
            s.isSymbolicLink() ||
            s.dev !== pin.dev ||
            s.ino !== pin.ino
          )
            throw fail();
        }
        await validate();
      } catch {
        throw fail();
      }
    };
    await verify();
    return {
      kind,
      root,
      provider: kind === "cline-sdk" ? "cline" : "cursor",
      label:
        kind === "cline-sdk"
          ? "Cline SDK 会话目录（只读）"
          : "Cursor agent-transcripts（只读）",
      reader:
        kind === "cline-sdk" ? clineConversationReader : cursorTranscriptReader,
      verify,
    };
  } catch {
    throw fail();
  }
}
