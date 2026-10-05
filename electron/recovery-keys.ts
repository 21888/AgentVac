import { promises as fs, constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const MAX_RECOVERY_KEYS = 16;
export interface RecoveryKeyIssue {
  code:
    | "prior-primary-missing"
    | "prior-primary-changed"
    | "primary-unavailable"
    | "keyring-unavailable"
    | "durability-warning";
  message: string;
}
/** JSON-safe. This is the only keyring state that may cross an IPC boundary. */
export interface RecoveryKeyringDescription {
  version: 1;
  primaryId: string | null;
  expectedPrimaryId: string | null;
  trustedKeyIds: string[];
  canSign: boolean;
  issues: RecoveryKeyIssue[];
}
export interface RecoveryImportResult {
  addedKeyIds: string[];
  duplicateKeyIds: string[];
  keyring: RecoveryKeyringDescription;
}
export interface RecoveryExportResult {
  path: string;
  version: 1;
  keyIds: string[];
}
interface SerializedKey {
  id: string;
  keyBase64: string;
}
interface SavedKeyring {
  format: "agentvac-keyring";
  version: 1;
  primaryId: string;
  keys: SerializedKey[];
}
interface KeyBundle {
  format: "agentvac-recovery-keys";
  version: 1;
  keys: SerializedKey[];
}
const PRIMARY = "journal-signing.key";
const KEYRING = "trusted-recovery-keys.json";
const MAX_BYTES = 16 * 1024;
const BAD_PATH = "恢复密钥路径无效或包含链接；未读取或写入。";
const BAD_FILE = "恢复密钥文件必须是单链接、大小受限的普通文件。";
const BAD_IMPORT =
  "恢复密钥导入失败：文件格式、版本、密钥长度或标识不匹配。现有密钥未改变。";
const ID = /^[0-9a-f]{64}$/;

export function recoveryKeyId(key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new Error("恢复密钥长度无效。");
  return createHash("sha256").update(key).digest("hex");
}
function canonical(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(p) &&
    path.isAbsolute(p) &&
    path.normalize(p) === p &&
    path.resolve(p) === p &&
    (process.platform !== "win32" ||
      !p.slice(path.parse(p).root.length).includes(":"))
  );
}
async function directory(p: string, create = false): Promise<void> {
  if (!canonical(p)) throw new Error(BAD_PATH);
  let current = path.parse(p).root;
  const root = await fs.lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(BAD_PATH);
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(BAD_PATH);
  }
}
function same(a: Stats | undefined, b: Stats | undefined): boolean {
  return (
    (!a && !b) ||
    (!!a &&
      !!b &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs &&
      a.nlink === b.nlink)
  );
}
async function plain(
  file: string,
  limit = MAX_BYTES,
): Promise<Stats | undefined> {
  try {
    const st = await fs.lstat(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size > limit
    )
      throw new Error(BAD_FILE);
    return st;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function read(
  file: string,
  limit = MAX_BYTES,
): Promise<{ bytes: Buffer; stat: Stats } | undefined> {
  if (!canonical(file)) throw new Error(BAD_PATH);
  await directory(path.dirname(file));
  const before = await plain(file, limit);
  if (!before) return undefined;
  const h = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await h.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !same(before, opened))
      throw new Error(BAD_FILE);
    const buf = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await h.read(
        buf,
        offset,
        buf.length - offset,
        offset,
      );
      offset += bytesRead;
      if (bytesRead === 0) break;
    }
    const after = await h.stat();
    if (
      offset > limit ||
      !same(opened, after) ||
      !same(after, await plain(file, limit))
    )
      throw new Error(BAD_FILE);
    await directory(path.dirname(file));
    return { bytes: buf.subarray(0, offset), stat: after };
  } finally {
    await h.close();
  }
}
async function syncDirectory(dir: string): Promise<boolean> {
  let h;
  try {
    h = await fs.open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await h.sync();
    return true;
  } catch (e) {
    // A successful atomic commit is not reported as a failed import if its directory
    // fsync is unsupported or fails: the caller gets an explicit durability warning.
    return ["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(
      (e as NodeJS.ErrnoException).code ?? "",
    );
  } finally {
    await h?.close().catch(() => {});
  }
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
function decodeKeys(input: unknown): Map<string, Buffer> {
  if (!Array.isArray(input) || input.length > MAX_RECOVERY_KEYS)
    throw new Error(BAD_IMPORT);
  const keys = new Map<string, Buffer>();
  for (const value of input) {
    if (
      !record(value) ||
      !exact(value, ["id", "keyBase64"]) ||
      typeof value.id !== "string" ||
      !ID.test(value.id) ||
      typeof value.keyBase64 !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value.keyBase64)
    )
      throw new Error(BAD_IMPORT);
    const key = Buffer.from(value.keyBase64, "base64");
    if (
      key.length !== 32 ||
      key.toString("base64") !== value.keyBase64 ||
      recoveryKeyId(key) !== value.id
    )
      throw new Error(BAD_IMPORT);
    keys.set(value.id, key);
  }
  return keys;
}
function encodeKeys(keys: Map<string, Buffer>): SerializedKey[] {
  return [...keys].map(([id, key]) => ({
    id,
    keyBase64: key.toString("base64"),
  }));
}

/** Node-only owner of secret buffers. Do not send this object or its nodeKeys to the renderer. */
export class RecoveryKeyring {
  private primary: Buffer | undefined;
  private expectedPrimaryId: string | undefined;
  private imported = new Map<string, Buffer>();
  private metadataStat: Stats | undefined;
  private primaryStat: Stats | undefined;
  private loaded = false;
  private blocked = false;
  private primaryWasMissing = false;
  private issues: RecoveryKeyIssue[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly recoveryDir: string) {}
  async flush(): Promise<void> {
    await this.writes;
  }
  primaryKey(): Buffer | undefined {
    return this.primary ? Buffer.from(this.primary) : undefined;
  }
  trustedKeys(): Buffer[] {
    return [...this.verificationKeys().values()].map((key) => Buffer.from(key));
  }
  nodeKeys(): { primary: Buffer | undefined; trusted: Buffer[] } {
    return { primary: this.primaryKey(), trusted: this.trustedKeys() };
  }
  describe(): RecoveryKeyringDescription {
    const primaryId = this.primary ? recoveryKeyId(this.primary) : null;
    const keys = this.verificationKeys();
    const issues = this.issues.map((issue) => ({ ...issue }));
    if (
      this.expectedPrimaryId &&
      primaryId &&
      this.expectedPrimaryId !== primaryId
    ) {
      const recovered = keys.has(this.expectedPrimaryId);
      issues.push({
        code: this.primaryWasMissing
          ? "prior-primary-missing"
          : "prior-primary-changed",
        message: recovered
          ? "原主密钥文件缺失或已更换；已导入先前密钥，旧批次仍须通过身份验证。新批次使用当前主密钥。"
          : "原主密钥文件缺失或已更换；当前新密钥只能签署新批次，不能恢复旧批次。请导入原密钥备份；缺少匹配密钥不表示批次已损坏。",
      });
    }
    return {
      version: 1,
      primaryId,
      expectedPrimaryId: this.expectedPrimaryId ?? null,
      trustedKeyIds: [...keys.keys()],
      canSign: !!this.primary && !this.blocked,
      issues,
    };
  }
  async load(): Promise<RecoveryKeyringDescription> {
    await this.writes;
    this.primary = undefined;
    this.expectedPrimaryId = undefined;
    this.imported = new Map();
    this.metadataStat = undefined;
    this.primaryStat = undefined;
    this.blocked = false;
    this.primaryWasMissing = false;
    this.issues = [];
    try {
      await directory(this.recoveryDir, true);
    } catch {
      this.blocked = true;
      this.issues.push({
        code: "keyring-unavailable",
        message: "恢复密钥目录不可安全访问；未读取或创建密钥。",
      });
      this.loaded = true;
      return this.describe();
    }
    try {
      const raw = await read(path.join(this.recoveryDir, KEYRING));
      if (raw) {
        const value: unknown = JSON.parse(raw.bytes.toString("utf8"));
        if (
          !record(value) ||
          !exact(value, ["format", "version", "primaryId", "keys"]) ||
          value.format !== "agentvac-keyring" ||
          value.version !== 1 ||
          typeof value.primaryId !== "string" ||
          !ID.test(value.primaryId)
        )
          throw new Error(BAD_IMPORT);
        this.imported = decodeKeys(value.keys);
        this.expectedPrimaryId = value.primaryId;
        this.metadataStat = raw.stat;
      }
    } catch {
      this.blocked = true;
      this.issues.push({
        code: "keyring-unavailable",
        message:
          "可信恢复密钥记录无法验证；原文件已保留，导入已禁用，避免丢失已有密钥。",
      });
    }
    try {
      const file = path.join(this.recoveryDir, PRIMARY);
      let raw = await read(file, 32);
      if (!raw) {
        this.primaryWasMissing = !!this.expectedPrimaryId;
        // Same on-disk format as engine.loadKey; creation is exclusive and reads use NOFOLLOW.
        await directory(this.recoveryDir);
        let handle;
        try {
          handle = await fs.open(
            file,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        if (handle) {
          try {
            await handle.writeFile(randomBytes(32));
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (!(await syncDirectory(this.recoveryDir))) this.warnDurability();
        }
        raw = await read(file, 32);
      }
      if (!raw || raw.bytes.length !== 32) throw new Error(BAD_FILE);
      this.primary = Buffer.from(raw.bytes);
      this.primaryStat = raw.stat;
      if (this.allKeys().size > MAX_RECOVERY_KEYS) {
        this.blocked = true;
        this.issues.push({
          code: "keyring-unavailable",
          message:
            "当前主密钥与已有密钥合计超出安全上限；所有文件已保留，请使用原配置。",
        });
      }
    } catch {
      this.primary = undefined;
      this.issues.push({
        code: "primary-unavailable",
        message:
          "本地主恢复密钥缺失、格式异常或不可安全访问。不会签署新批次；已导入的原密钥仍可用于验证恢复。",
      });
    }
    if (this.primary && !this.expectedPrimaryId && !this.blocked) {
      this.expectedPrimaryId = recoveryKeyId(this.primary);
      try {
        await this.commit(this.imported);
      } catch {
        this.blocked = true;
        this.issues.push({
          code: "keyring-unavailable",
          message:
            "主密钥可读取，但无法保存其身份记录；请检查应用配置目录后重新载入。",
        });
      }
    }
    this.loaded = true;
    return this.describe();
  }
  async importFile(
    file: string,
    options: { allowLegacyRaw?: boolean } = {},
  ): Promise<RecoveryImportResult> {
    if (!this.loaded) await this.load();
    const allowLegacyRaw = options.allowLegacyRaw === true;
    const task = this.writes.then(async () => {
      if (this.blocked)
        throw new Error(
          "密钥记录不可用，无法安全合并。请先检查应用配置；现有文件未改变。",
        );
      let incoming: Map<string, Buffer>;
      try {
        const raw = await read(file);
        if (!raw) throw new Error(BAD_IMPORT);
        if (allowLegacyRaw && raw.bytes.length === 32)
          incoming = new Map([
            [recoveryKeyId(raw.bytes), Buffer.from(raw.bytes)],
          ]);
        else {
          const value: unknown = JSON.parse(raw.bytes.toString("utf8"));
          if (
            !record(value) ||
            !exact(value, ["format", "version", "keys"]) ||
            value.format !== "agentvac-recovery-keys" ||
            value.version !== 1
          )
            throw new Error(BAD_IMPORT);
          incoming = decodeKeys(value.keys);
          if (incoming.size === 0) throw new Error(BAD_IMPORT);
        }
      } catch {
        throw new Error(BAD_IMPORT);
      }
      await this.checkUnchanged();
      const all = this.allKeys();
      const duplicateKeyIds = [...incoming.keys()].filter((id) => all.has(id));
      const addedKeyIds = [...incoming.keys()].filter((id) => !all.has(id));
      const next = new Map(this.imported);
      for (const [id, key] of incoming) next.set(id, key);
      const union = new Set([...all.keys(), ...incoming.keys()]);
      if (union.size > MAX_RECOVERY_KEYS)
        throw new Error(
          `可信恢复密钥总数不能超过 ${MAX_RECOVERY_KEYS}；现有密钥未改变。`,
        );
      // Duplicates are idempotent, but an explicitly imported current primary can
      // also be retained in the imported set as protection against later key loss.
      if ([...incoming.keys()].some((id) => !this.imported.has(id))) {
        const expected =
          this.expectedPrimaryId ?? incoming.keys().next().value!;
        await this.commit(next, expected);
        this.expectedPrimaryId = expected;
        this.imported = next;
      }
      return { addedKeyIds, duplicateKeyIds, keyring: this.describe() };
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  /** Caller must collect explicit export confirmation and a NEW destination first. */
  async exportFile(file: string): Promise<RecoveryExportResult> {
    if (!this.loaded) await this.load();
    const task = this.writes.then(async () => {
      if (this.blocked || this.allKeys().size === 0)
        throw new Error("没有可安全导出的完整恢复密钥集。");
      await this.checkUnchanged();
      if (!canonical(file)) throw new Error(BAD_PATH);
      await directory(path.dirname(file));
      const keys = this.allKeys();
      let h;
      try {
        h = await fs.open(
          file,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch {
        throw new Error(
          "导出目标必须是新文件，且父目录不含链接；未覆盖任何现有文件。",
        );
      }
      let owned: Stats | undefined;
      let complete = false;
      try {
        owned = await h.stat();
        if (!owned.isFile() || owned.nlink !== 1) throw new Error(BAD_FILE);
        await h.writeFile(
          JSON.stringify(
            {
              format: "agentvac-recovery-keys",
              version: 1,
              keys: encodeKeys(keys),
            } satisfies KeyBundle,
            null,
            2,
          ),
        );
        await h.sync();
        const after = await h.stat();
        if (after.nlink !== 1 || !same(after, await plain(file)))
          throw new Error(BAD_FILE);
        await directory(path.dirname(file));
        complete = true;
      } catch {
        throw new Error(
          "密钥导出未完成；未覆盖任何现有文件，请重新选择新文件。",
        );
      } finally {
        await h.close();
        if (!complete && owned) {
          const remaining = await fs.lstat(file).catch(() => undefined);
          if (remaining?.dev === owned.dev && remaining?.ino === owned.ino)
            await fs.unlink(file).catch(() => {});
        }
      }
      if (!(await syncDirectory(path.dirname(file)))) this.warnDurability();
      return { path: file, version: 1 as const, keyIds: [...keys.keys()] };
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private allKeys(): Map<string, Buffer> {
    const all = new Map<string, Buffer>();
    if (this.primary) all.set(recoveryKeyId(this.primary), this.primary);
    for (const [id, key] of this.imported) all.set(id, key);
    return all;
  }
  private verificationKeys(): Map<string, Buffer> {
    const all = this.allKeys();
    // If an out-of-band primary replacement would exceed the cap, retain all
    // previously imported keys for read-only recovery; signing/export is blocked.
    return all.size > MAX_RECOVERY_KEYS ? new Map(this.imported) : all;
  }
  private warnDurability(): void {
    if (!this.issues.some((i) => i.code === "durability-warning"))
      this.issues.push({
        code: "durability-warning",
        message:
          "密钥已写入并同步文件，但目录同步失败；请安全退出后核验备份文件。",
      });
  }
  private async checkUnchanged(): Promise<void> {
    try {
      await directory(this.recoveryDir);
      if (
        !same(
          this.metadataStat,
          await plain(path.join(this.recoveryDir, KEYRING)),
        )
      )
        throw new Error(BAD_FILE);
      if (
        this.primary &&
        !same(
          this.primaryStat,
          await plain(path.join(this.recoveryDir, PRIMARY), 32),
        )
      )
        throw new Error(BAD_FILE);
    } catch {
      throw new Error(
        "密钥文件在载入后已变化；请重新载入后再操作，现有文件未改变。",
      );
    }
  }
  private async commit(
    keys: Map<string, Buffer>,
    expected = this.expectedPrimaryId,
  ): Promise<void> {
    if (!expected) throw new Error("缺少原主密钥标识。");
    await this.checkUnchanged();
    const file = path.join(this.recoveryDir, KEYRING);
    const temp = path.join(
      this.recoveryDir,
      `.recovery-keys-${randomUUID()}.tmp`,
    );
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
            {
              format: "agentvac-keyring",
              version: 1,
              primaryId: expected,
              keys: encodeKeys(keys),
            } satisfies SavedKeyring,
            null,
            2,
          ),
        );
        await h.sync();
      } finally {
        await h.close();
      }
      await this.checkUnchanged();
      await fs.rename(temp, file);
      try {
        this.metadataStat = await plain(file);
      } catch {
        this.blocked = true;
        this.issues.push({
          code: "keyring-unavailable",
          message: "密钥合并已保存，但无法再次核验记录；请重新载入后继续。",
        });
      }
      if (!(await syncDirectory(this.recoveryDir))) this.warnDurability();
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
}
