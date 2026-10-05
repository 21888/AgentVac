import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openConversationFile } from "./safe-read.js";
import {
  inspectCursorSnapshotWindowsAcl,
  inspectCursorSnapshotWindowsLocality,
  canonicalizeCursorSnapshotWindowsPath,
} from "./cursor-windows-acl.js";

const ROOT_MARKER = "owner.json";
const SESSION = /^session-([0-9a-f]{32})$/;
const SNAPSHOT = /^snapshot-([0-9a-f]{32})$/;
const ALLOWED = new Set([
  "meta.json",
  "state.vscdb",
  "state.vscdb-wal",
  "state.vscdb-shm",
  "state.vscdb-journal",
]);
const own = (s: Stats) =>
  (typeof process.getuid !== "function" || s.uid === process.getuid()) &&
  (process.platform === "win32" || (s.mode & 0o077) === 0);
let runtime: Promise<{ root: string; session: string }> | undefined;
let availabilityReason:
  | "not-initialized"
  | "windows-acl-unverified"
  | "windows-locality-unverified"
  | "storage-unavailable"
  | null = "not-initialized";
const fail = () => new Error("CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE");
export function getCursorSnapshotStorageAvailability() {
  return { available: !!runtime, reason: availabilityReason };
}

async function directory(p: string): Promise<Stats> {
  if (
    !path.isAbsolute(p) ||
    path.normalize(p) !== p ||
    /[\x00-\x1f\x7f]/.test(p)
  )
    throw fail();
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  }
  const s = await fs.lstat(p);
  if (!own(s)) throw fail();
  if (
    process.platform === "win32" &&
    !(await inspectCursorSnapshotWindowsAcl(p, true))
  ) {
    availabilityReason = "windows-acl-unverified";
    throw fail();
  }
  return s;
}
async function marker(p: string): Promise<Record<string, unknown>> {
  const file = await openConversationFile(path.dirname(p), path.basename(p));
  try {
    if (!own(file.stat) || file.stat.size > 4096) throw fail();
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await file.handle.readFile(),
      ),
    );
    await file.verifyUnchanged();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
    return raw as Record<string, unknown>;
  } finally {
    await file.close();
  }
}
async function entries(p: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const dir = await fs.opendir(p);
  for await (const entry of dir) {
    if (out.length >= max) throw fail();
    out.push(entry.name);
  }
  return out;
}
async function pin(p: string): Promise<() => Promise<void>> {
  const initial = await directory(p);
  return async () => {
    const current = await directory(p);
    if (current.dev !== initial.dev || current.ino !== initial.ino)
      throw fail();
  };
}

/** Only deletes files created inside one verified app-owned snapshot directory. */
async function removeCursorSnapshotDirectoryInner(p: string): Promise<void> {
  const match = SNAPSHOT.exec(path.basename(p));
  if (!match) throw fail();
  const verify = await pin(p);
  const meta = await marker(path.join(p, "meta.json"));
  if (
    meta.kind !== "agentvac-cursor-snapshot" ||
    meta.version !== 1 ||
    meta.id !== match[1]
  )
    throw fail();
  const names = await entries(p, 5);
  for (const name of names) {
    if (!ALLOWED.has(name)) throw fail();
    const s = await fs.lstat(path.join(p, name));
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !own(s))
      throw fail();
  }
  // No recursive removal and no wildcard deletion. A linked replacement is never followed.
  for (const name of names.filter((n) => n !== "meta.json")) {
    await verify();
    await fs.unlink(path.join(p, name));
  }
  await verify();
  await fs.unlink(path.join(p, "meta.json"));
  await fs.rmdir(p);
}

export interface CursorSnapshotStorageStatus {
  removedSessions: number;
  retainedSessions: number;
  scanLimited: boolean;
}
async function scavengeCursorSnapshotStorageInner(
  root: string,
): Promise<CursorSnapshotStorageStatus> {
  await directory(root);
  const owner = await marker(path.join(root, ROOT_MARKER));
  if (owner.kind !== "agentvac-cursor-snapshot-root" || owner.version !== 1)
    throw fail();
  const status = {
    removedSessions: 0,
    retainedSessions: 0,
    scanLimited: false,
  };
  let names: string[];
  try {
    names = await entries(root, 129);
  } catch {
    return { ...status, scanLimited: true };
  }
  for (const name of names) {
    if (name === ROOT_MARKER) continue;
    const match = SESSION.exec(name);
    if (!match) {
      status.retainedSessions++;
      continue;
    }
    const session = path.join(root, name);
    try {
      const verify = await pin(session);
      const lease = await marker(path.join(session, "lease.json"));
      if (
        lease.kind !== "agentvac-cursor-session" ||
        lease.version !== 1 ||
        lease.id !== match[1] ||
        !Number.isSafeInteger(lease.pid) ||
        Number(lease.pid) <= 0
      )
        throw fail();
      // Live/reused PIDs and permission failures are retained. Only ESRCH proves
      // the recorded process is no longer active; no process is ever stopped.
      try {
        process.kill(Number(lease.pid), 0);
        status.retainedSessions++;
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          status.retainedSessions++;
          continue;
        }
      }
      const children = await entries(session, 65);
      if (children.some((n) => n !== "lease.json" && !SNAPSHOT.test(n)))
        throw fail();
      for (const child of children.filter((n) => n !== "lease.json")) {
        await verify();
        await removeCursorSnapshotDirectory(path.join(session, child));
      }
      await verify();
      await fs.unlink(path.join(session, "lease.json"));
      await fs.rmdir(session);
      status.removedSessions++;
    } catch {
      status.retainedSessions++;
    }
  }
  return status;
}

/** Main-process startup only; path must come from app-owned storage, never IPC. */
async function initializeCursorSnapshotStorageInner(
  root: string,
): Promise<CursorSnapshotStorageStatus> {
  runtime = undefined;
  availabilityReason = "storage-unavailable";
  if (process.platform === "win32") {
    const canonical = canonicalizeCursorSnapshotWindowsPath(root);
    if (
      !canonical ||
      !(await inspectCursorSnapshotWindowsLocality(canonical, true))
    ) {
      availabilityReason = "windows-locality-unverified";
      throw fail();
    }
    root = canonical;
  }
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    /[\x00-\x1f\x7f]/.test(root)
  )
    throw fail();
  // Parent must already exist and be non-linked. Do not create through an
  // arbitrary linked parent or change permissions on existing user directories.
  let current = path.parse(root).root;
  for (const part of path
    .dirname(root)
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const s = await fs.lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw fail();
  }
  let created = false;
  try {
    await fs.mkdir(root, { mode: 0o700 });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw fail();
  }
  await directory(root);
  if (created)
    await fs.writeFile(
      path.join(root, ROOT_MARKER),
      JSON.stringify({ kind: "agentvac-cursor-snapshot-root", version: 1 }),
      { flag: "wx", mode: 0o600 },
    );
  const status = await scavengeCursorSnapshotStorage(root);
  const id = randomBytes(16).toString("hex");
  const session = path.join(root, `session-${id}`);
  await fs.mkdir(session, { mode: 0o700 });
  await fs.writeFile(
    path.join(session, "lease.json"),
    JSON.stringify({
      kind: "agentvac-cursor-session",
      version: 1,
      id,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  runtime = Promise.resolve({ root, session });
  availabilityReason = null;
  return status;
}

async function createCursorSnapshotDirectoryInner(): Promise<string> {
  if (!runtime) throw fail();
  const state = await runtime;
  await directory(state.root);
  await directory(state.session);
  const id = randomBytes(16).toString("hex");
  const target = path.join(state.session, `snapshot-${id}`);
  await fs.mkdir(target, { mode: 0o700 });
  try {
    await fs.writeFile(
      path.join(target, "meta.json"),
      JSON.stringify({ kind: "agentvac-cursor-snapshot", version: 1, id }),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    await fs.rmdir(target).catch(() => {});
    throw fail();
  }
  return target;
}

// Native filesystem error text may contain private profile paths. Only stable
// codes cross this module's public boundary, including startup/cleanup failures.
export async function removeCursorSnapshotDirectory(p: string): Promise<void> {
  try {
    await removeCursorSnapshotDirectoryInner(p);
  } catch {
    throw fail();
  }
}
export async function scavengeCursorSnapshotStorage(
  root: string,
): Promise<CursorSnapshotStorageStatus> {
  try {
    return await scavengeCursorSnapshotStorageInner(root);
  } catch {
    throw fail();
  }
}
export async function initializeCursorSnapshotStorage(
  root: string,
): Promise<CursorSnapshotStorageStatus> {
  try {
    return await initializeCursorSnapshotStorageInner(root);
  } catch {
    throw fail();
  }
}
export async function createCursorSnapshotDirectory(): Promise<string> {
  try {
    return await createCursorSnapshotDirectoryInner();
  } catch {
    throw fail();
  }
}
