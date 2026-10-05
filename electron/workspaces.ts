import { promises as fs, constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type WorkspaceKind =
  import("../shared/types.js").ProviderId | "sqlite" | "logs";
export type WorkspaceStatus =
  "available" | "missing" | "moved" | "unsafe" | "error";
export interface WorkspaceSelection {
  kind: WorkspaceKind;
  demo: boolean;
  name: string;
  path: string;
}
export interface WorkspaceDescription extends WorkspaceSelection {
  id: string;
  lastUsed: string;
  status: WorkspaceStatus;
  message: string;
}
export interface WorkspaceListing {
  entries: WorkspaceDescription[];
  issue?: string;
}
interface SavedWorkspace extends WorkspaceSelection {
  id: string;
  lastUsed: string;
  identity: { dev: string; ino: string };
}
interface SavedWorkspaces {
  version: 1;
  entries: SavedWorkspace[];
}
export const MAX_RECENT_WORKSPACES = 12;
const MAX_BYTES = 64 * 1024;
const FILE = "recent-workspaces.json";
const BAD_PATH = "目录路径无效，或包含链接；未访问该目录。";
const BAD_STORE = "最近目录记录不可用；原记录已保留。请检查应用配置目录。";

function canonical(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.resolve(value) === value &&
    (process.platform !== "win32" ||
      !value.slice(path.parse(value).root.length).includes(":"))
  );
}
async function directory(p: string): Promise<Stats> {
  if (!canonical(p)) throw new Error(BAD_PATH);
  let current = path.parse(p).root;
  let result = await fs.lstat(current);
  if (!result.isDirectory() || result.isSymbolicLink())
    throw new Error(BAD_PATH);
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result = await fs.lstat(current);
    if (!result.isDirectory() || result.isSymbolicLink())
      throw new Error(BAD_PATH);
  }
  return result;
}
function idFor(s: WorkspaceSelection): string {
  return createHash("sha256")
    .update(JSON.stringify([s.kind, s.demo, s.path]))
    .digest("hex");
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
function selection(v: unknown): v is WorkspaceSelection {
  if (!isRecord(v)) return false;
  return (
    ["codex", "claude-code", "cline", "cursor", "sqlite", "logs"].includes(
      v.kind as string,
    ) &&
    typeof v.demo === "boolean" &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= 120 &&
    v.name.trim() === v.name &&
    !/[\x00-\x1f\x7f]/.test(v.name) &&
    canonical(v.path)
  );
}
function parse(raw: string): SavedWorkspace[] {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !exact(value, ["version", "entries"]) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_RECENT_WORKSPACES
  )
    throw new Error(BAD_STORE);
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (
      !selection(entry) ||
      !isRecord(entry) ||
      !exact(entry, [
        "kind",
        "demo",
        "name",
        "path",
        "id",
        "lastUsed",
        "identity",
      ]) ||
      typeof entry.id !== "string" ||
      entry.id !== idFor(entry) ||
      ids.has(entry.id) ||
      typeof entry.lastUsed !== "string" ||
      !Number.isFinite(Date.parse(entry.lastUsed)) ||
      new Date(entry.lastUsed).toISOString() !== entry.lastUsed ||
      !isRecord(entry.identity) ||
      !exact(entry.identity, ["dev", "ino"]) ||
      typeof entry.identity.dev !== "string" ||
      typeof entry.identity.ino !== "string" ||
      !/^\d{1,30}$/.test(entry.identity.dev) ||
      !/^\d{1,30}$/.test(entry.identity.ino)
    )
      throw new Error(BAD_STORE);
    ids.add(entry.id);
  }
  return value.entries as SavedWorkspace[];
}
async function plainFile(file: string): Promise<Stats | undefined> {
  try {
    const st = await fs.lstat(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size > MAX_BYTES
    )
      throw new Error(BAD_STORE);
    return st;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function read(
  file: string,
): Promise<{ raw: string; stat: Stats } | undefined> {
  const before = await plainFile(file);
  if (!before) return undefined;
  const h = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await h.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error(BAD_STORE);
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    const after = await h.stat();
    if (
      bytesRead > MAX_BYTES ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error(BAD_STORE);
    return { raw: buf.subarray(0, bytesRead).toString("utf8"), stat: after };
  } finally {
    await h.close();
  }
}
async function syncDirectory(dir: string): Promise<boolean> {
  // Windows does not generally permit directory handles; file data is still fsynced.
  let h;
  try {
    h = await fs.open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await h.sync();
    return true;
  } catch (e) {
    return ["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(
      (e as NodeJS.ErrnoException).code ?? "",
    );
  } finally {
    await h?.close().catch(() => {});
  }
}

/** Stores only explicitly selected roots. Listing stats their path components, never their contents. */
export class WorkspaceStore {
  private entries: SavedWorkspace[] = [];
  private issue: string | undefined;
  private loaded = false;
  private metadataStat: Stats | undefined;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly profileDir: string) {}
  async flush(): Promise<void> {
    await this.writes;
  }
  async load(): Promise<WorkspaceListing> {
    await this.writes;
    this.entries = [];
    this.metadataStat = undefined;
    this.issue = undefined;
    try {
      await directory(this.profileDir);
      const raw = await read(path.join(this.profileDir, FILE));
      if (raw !== undefined) {
        this.entries = parse(raw.raw);
        this.metadataStat = raw.stat;
      }
    } catch {
      this.issue = BAD_STORE;
    }
    this.loaded = true;
    return this.list();
  }
  async list(): Promise<WorkspaceListing> {
    if (!this.loaded) return this.load();
    const entries = await Promise.all(
      this.entries.map(async (saved) => {
        const { identity, ...publicValue } = saved;
        let status: WorkspaceStatus = "available";
        let message = "目录可用；尚未扫描。";
        try {
          const st = await directory(saved.path);
          if (
            String(st.dev) !== identity.dev ||
            String(st.ino) !== identity.ino
          ) {
            status = "moved";
            message =
              "原路径对应的目录已改变或磁盘已更换。请重新选择确认；不会自动定位或扫描。";
          }
        } catch (e) {
          if (
            ["ENOENT", "ENOTDIR", "ENODEV", "ENXIO"].includes(
              (e as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            status = "missing";
            message = "目录不在原位置或磁盘离线；不会自动查找。";
          } else if ((e as Error).message === BAD_PATH) {
            status = "unsafe";
            message = "路径包含链接或不再是普通目录；已拒绝访问。";
          } else {
            status = "error";
            message = "目录元数据无法读取；请检查访问权限。";
          }
        }
        return { ...publicValue, status, message };
      }),
    );
    return { entries, ...(this.issue ? { issue: this.issue } : {}) };
  }
  async remember(input: WorkspaceSelection): Promise<WorkspaceDescription> {
    if (!selection(input)) throw new Error("最近目录信息无效。");
    // Snapshot before entering the queue so callers cannot change a pending request.
    const selected: WorkspaceSelection = {
      kind: input.kind,
      demo: input.demo,
      name: input.name,
      path: input.path,
    };
    if (!this.loaded) await this.load();
    const task = this.writes.then(async () => {
      if (this.issue) throw new Error(BAD_STORE);
      const st = await directory(selected.path);
      const saved: SavedWorkspace = {
        ...selected,
        id: idFor(selected),
        lastUsed: new Date().toISOString(),
        identity: { dev: String(st.dev), ino: String(st.ino) },
      };
      const next = [
        saved,
        ...this.entries.filter((e) => e.id !== saved.id),
      ].slice(0, MAX_RECENT_WORKSPACES);
      await this.commit(next);
      this.entries = next;
      return {
        ...selected,
        id: saved.id,
        lastUsed: saved.lastUsed,
        status: "available" as const,
        message: "目录可用；尚未扫描。",
      };
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async forget(id: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("最近目录标识无效。");
    if (!this.loaded) await this.load();
    const task = this.writes.then(async () => {
      if (this.issue) throw new Error(BAD_STORE);
      const next = this.entries.filter((e) => e.id !== id);
      if (next.length === this.entries.length) return;
      await this.commit(next);
      this.entries = next;
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async commit(entries: SavedWorkspace[]): Promise<void> {
    await directory(this.profileDir);
    const file = path.join(this.profileDir, FILE);
    const before = await plainFile(file);
    const known = this.metadataStat;
    if (
      !!known !== !!before ||
      (known &&
        before &&
        (known.dev !== before.dev ||
          known.ino !== before.ino ||
          known.size !== before.size ||
          known.mtimeMs !== before.mtimeMs ||
          known.ctimeMs !== before.ctimeMs))
    )
      throw new Error(BAD_STORE);
    const temp = path.join(this.profileDir, `.workspaces-${randomUUID()}.tmp`);
    const h = await fs.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      try {
        await h.writeFile(
          JSON.stringify(
            { version: 1, entries } satisfies SavedWorkspaces,
            null,
            2,
          ),
        );
        await h.sync();
      } finally {
        await h.close();
      }
      await directory(this.profileDir);
      const now = await plainFile(file);
      if (
        !!now !== !!before ||
        (now &&
          before &&
          (now.dev !== before.dev ||
            now.ino !== before.ino ||
            now.mtimeMs !== before.mtimeMs ||
            now.ctimeMs !== before.ctimeMs))
      )
        throw new Error(BAD_STORE);
      await fs.rename(temp, file);
      try {
        this.metadataStat = await plainFile(file);
      } catch {
        this.issue = "最近目录已保存，但无法再次核验；请重新载入后继续。";
      }
      if (!(await syncDirectory(this.profileDir)))
        this.issue = "最近目录已保存，但目录同步失败；请安全退出后重新核验。";
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
}
