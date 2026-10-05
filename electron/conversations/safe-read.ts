import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export type ConversationReadErrorCode =
  | "CONVERSATION_UNSAFE_FILE"
  | "CONVERSATION_CHANGED"
  | "CONVERSATION_CANCELLED";

/** Deliberately never carries a native error, filename, or transcript fragment. */
export class ConversationReadError extends Error {
  constructor(public readonly code: ConversationReadErrorCode) {
    super(
      code === "CONVERSATION_CANCELLED"
        ? "Conversation reading cancelled."
        : code === "CONVERSATION_CHANGED"
          ? "Conversation storage changed. Refresh before continuing."
          : "Conversation file is unavailable or unsafe to read.",
    );
    this.name = "ConversationReadError";
  }
}

export function checkConversationAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ConversationReadError("CONVERSATION_CANCELLED");
}

function safeRelative(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f:]/.test(value) &&
    value
      .split("/")
      .every(
        (v) => v && v !== "." && v !== ".." && v !== ".agentvac-quarantine",
      )
  );
}

function fileSignature(s: Stats): string {
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.nlink].join(
    ":",
  );
}

export interface SafeConversationFile {
  handle: FileHandle;
  stat: Stats;
  fingerprint: string;
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Read-only opener. Root/provider allowlists and opt-in belong to the service.
 * This additionally rejects links and snapshots all ancestors before opening.
 * Call verifyUnchanged before publishing any parsed result, even an empty page.
 */
export async function openConversationFile(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<SafeConversationFile> {
  let handle: FileHandle | undefined;
  try {
    checkConversationAbort(signal);
    if (
      typeof root !== "string" ||
      root.length > 4096 ||
      !path.isAbsolute(root) ||
      path.normalize(root) !== root ||
      /[\x00-\x1f\x7f]/.test(root) ||
      root === path.parse(root).root ||
      !safeRelative(relativePath)
    ) {
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    }
    const target = path.join(root, ...relativePath.split("/"));
    const ancestors: { path: string; dev: number; ino: number }[] = [];
    let current = path.parse(target).root;
    for (const component of target
      .slice(current.length)
      .split(path.sep)
      .slice(0, -1)) {
      current = path.join(current, component);
      const s = await fs.lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
      ancestors.push({ path: current, dev: s.dev, ino: s.ino });
      checkConversationAbort(signal);
    }
    const before = await fs.lstat(target);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0
    )
      throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
    handle = await fs.open(
      target,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    const initial = fileSignature(before);
    if (!stat.isFile() || fileSignature(stat) !== initial)
      throw new ConversationReadError("CONVERSATION_CHANGED");
    const opened = handle;
    const verifyUnchanged = async () => {
      try {
        checkConversationAbort(signal);
        if (
          fileSignature(await opened.stat()) !== initial ||
          fileSignature(await fs.lstat(target)) !== initial
        )
          throw new ConversationReadError("CONVERSATION_CHANGED");
        for (const ancestor of ancestors) {
          const s = await fs.lstat(ancestor.path);
          if (
            !s.isDirectory() ||
            s.isSymbolicLink() ||
            s.dev !== ancestor.dev ||
            s.ino !== ancestor.ino
          )
            throw new ConversationReadError("CONVERSATION_CHANGED");
        }
        checkConversationAbort(signal);
      } catch (error) {
        if (error instanceof ConversationReadError) throw error;
        throw new ConversationReadError("CONVERSATION_CHANGED");
      }
    };
    await verifyUnchanged();
    return {
      handle: opened,
      stat,
      fingerprint: createHash("sha256")
        .update(root)
        .update("\0")
        .update(relativePath)
        .update("\0")
        .update(initial)
        .digest("hex"),
      verifyUnchanged,
      close: async () => {
        await opened.close();
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof ConversationReadError) throw error;
    throw new ConversationReadError("CONVERSATION_UNSAFE_FILE");
  }
}
