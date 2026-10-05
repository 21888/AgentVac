import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  openConversationFile,
  checkConversationAbort,
  ConversationReadError,
  type SafeConversationFile,
} from "./safe-read.js";
import {
  createCursorSnapshotDirectory,
  removeCursorSnapshotDirectory,
  getCursorSnapshotStorageAvailability,
} from "./cursor-temp.js";
import { inspectCursorSnapshotWindowsAcl } from "./cursor-windows-acl.js";

export const CURSOR_SNAPSHOT_LIMIT = 512 * 1024 * 1024;
export class CursorReadError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CursorReadError";
  }
}
const allowed = (p: string) =>
  /^User\/(?:globalStorage|workspaceStorage\/[a-zA-Z0-9_-]{1,128})\/state\.vscdb$/.test(
    p,
  );
type Observation = { suffix: string; file: SafeConversationFile | null };

/**
 * Copy only an explicitly allowlisted database and its WAL, never open the source
 * with SQLite. SQLite may rebuild SHM on the private copy; the source is untouched.
 * This is a stable-file snapshot, not a transactional snapshot of an active writer.
 * Any source/sidecar/ancestor change discards the result. No immutable WAL shortcut.
 */
export interface CursorSnapshot {
  path: string;
  fingerprint: string;
  bytes: number;
  verify(): Promise<void>;
  close(): Promise<void>;
}
export async function openCursorSnapshot(
  root: string,
  relative: string,
  signal: AbortSignal | undefined,
  expectedFingerprint?: string,
  maxBytes = CURSOR_SNAPSHOT_LIMIT,
): Promise<CursorSnapshot> {
  const availability = getCursorSnapshotStorageAvailability();
  if (!availability.available)
    throw new CursorReadError(
      availability.reason === "windows-acl-unverified"
        ? "CURSOR_WINDOWS_PRIVACY_UNVERIFIED"
        : "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE",
    );
  if (!allowed(relative)) throw new CursorReadError("CURSOR_UNSAFE_DATABASE");
  checkConversationAbort(signal);
  const observations: Observation[] = [];
  let temp: string | undefined;
  let retained = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of observations) await entry.file?.close().catch(() => {});
    if (temp) await removeCursorSnapshotDirectory(temp);
  };
  const exists = async (suffix: string) => {
    try {
      await fs.lstat(path.join(root, relative + suffix));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CursorReadError("CURSOR_UNSAFE_DATABASE");
    }
  };
  const verify = async () => {
    for (const entry of observations) {
      if (entry.file) await entry.file.verifyUnchanged();
      else if (await exists(entry.suffix))
        throw new CursorReadError("CURSOR_SOURCE_CHANGED");
    }
    checkConversationAbort(signal);
  };
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const present = await exists(suffix);
      if (!present && suffix === "")
        throw new CursorReadError("CURSOR_DATABASE_MISSING");
      observations.push({
        suffix,
        file: present
          ? await openConversationFile(root, relative + suffix, signal)
          : null,
      });
    }
    if (observations.find((e) => e.suffix === "-journal")?.file?.stat.size)
      throw new CursorReadError("CURSOR_ROLLBACK_JOURNAL_PRESENT");
    const total = observations.reduce(
      (n, e) => n + (e.file?.stat.size ?? 0),
      0,
    );
    if (total > Math.min(CURSOR_SNAPSHOT_LIMIT, maxBytes))
      throw new CursorReadError("CURSOR_SNAPSHOT_SIZE_LIMIT");
    const fingerprint = createHash("sha256")
      .update(
        observations
          .map((e) => `${e.suffix}:${e.file?.fingerprint ?? "absent"}`)
          .join("\n"),
      )
      .digest("hex");
    if (expectedFingerprint && expectedFingerprint !== fingerprint)
      throw new CursorReadError("CURSOR_SOURCE_CHANGED");
    const header = Buffer.alloc(100);
    const db = observations[0].file!;
    const read = await db.handle.read(header, 0, header.length, 0);
    if (
      read.bytesRead < 100 ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
    )
      throw new CursorReadError("CURSOR_NOT_SQLITE");
    temp = await createCursorSnapshotDirectory();
    const disk = await fs.statfs(temp);
    if (disk.bavail * disk.bsize < total * 2 + 16 * 1024 * 1024)
      throw new CursorReadError("CURSOR_SNAPSHOT_NO_SPACE");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (const entry of observations.filter(
      (e) => e.suffix === "" || e.suffix === "-wal",
    )) {
      if (!entry.file) continue;
      const out = await fs.open(
        path.join(temp, "state.vscdb" + entry.suffix),
        "wx",
        0o600,
      );
      try {
        if (
          process.platform === "win32" &&
          !(await inspectCursorSnapshotWindowsAcl(
            path.join(temp, "state.vscdb" + entry.suffix),
            false,
            signal,
          ))
        )
          throw new CursorReadError(
            "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE",
          );
        let position = 0;
        while (position < entry.file.stat.size) {
          checkConversationAbort(signal);
          const { bytesRead } = await entry.file.handle.read(
            buffer,
            0,
            Math.min(buffer.length, entry.file.stat.size - position),
            position,
          );
          if (!bytesRead) throw new CursorReadError("CURSOR_SOURCE_CHANGED");
          let written = 0;
          while (written < bytesRead) {
            const result = await out.write(
              buffer,
              written,
              bytesRead - written,
              position + written,
            );
            if (!result.bytesWritten)
              throw new CursorReadError("CURSOR_SNAPSHOT_WRITE_FAILED");
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
      } finally {
        await out.close();
      }
    }
    await verify();
    retained = true;
    return {
      path: path.join(temp, "state.vscdb"),
      fingerprint,
      bytes: total,
      verify,
      close,
    };
  } catch (error) {
    if (
      error instanceof CursorReadError ||
      error instanceof ConversationReadError
    )
      throw error;
    throw new CursorReadError("CURSOR_SNAPSHOT_READ_FAILED");
  } finally {
    if (!retained) await close();
  }
}

export async function withCursorSnapshot<T>(
  root: string,
  relative: string,
  signal: AbortSignal | undefined,
  use: (snapshotPath: string, fingerprint: string) => Promise<T>,
  expectedFingerprint?: string,
): Promise<T> {
  const snapshot = await openCursorSnapshot(
    root,
    relative,
    signal,
    expectedFingerprint,
  );
  try {
    const result = await use(snapshot.path, snapshot.fingerprint);
    await snapshot.verify();
    return result;
  } finally {
    await snapshot.close();
  }
}
