import { promises as fs } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";

/** New journals use canonical unsigned decimal strings (at most 64 bits).
 * Numeric identities are accepted only for authenticated legacy records whose
 * original JSON numbers are safe integers. Never normalize a signed journal.
 */
export type FileIdentity =
  { dev: string; ino: string } | { dev: number; ino: number };
export type FileFingerprint = FileIdentity & {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  mode: number;
};
export type ExactFileFingerprint = FileFingerprint & {
  dev: string;
  ino: string;
};
export type ExactFileStat = ExactFileFingerprint &
  Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">;
const MAX_FILE_ID = (1n << 64n) - 1n;
const FINGERPRINT_FIELDS = [
  "dev",
  "ino",
  "size",
  "mtimeMs",
  "ctimeMs",
  "nlink",
  "mode",
] as const;
export class FileIdentityError extends Error {
  readonly code = "ERR_AGENTVAC_FILE_IDENTITY";
  constructor() {
    super(
      "文件身份无效或旧清单中的数字标识已超出精确范围；已拒绝自动恢复和移入回收站，隔离数据仍保留。请打开隔离批次目录，将完整目录（含 manifest.json 和数据文件）复制导出以供人工核对；不要改写标识或删除原件。重新导入钥匙不能修复已舍入的标识。",
    );
    this.name = "FileIdentityError";
  }
}
export function validFileId(
  value: unknown,
  inode = false,
): value is string | number {
  if (typeof value === "number")
    return (
      Number.isSafeInteger(value) &&
      !Object.is(value, -0) &&
      value >= (inode ? 1 : 0)
    );
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 20 &&
    !/[^0-9]/.test(value) &&
    (value === "0" || value[0] !== "0") &&
    BigInt(value) <= MAX_FILE_ID &&
    (!inode || value !== "0")
  );
}
export function exactFileId(
  value: bigint | string | number,
  inode = false,
): string {
  if (typeof value === "bigint") {
    if (value < (inode ? 1n : 0n) || value > MAX_FILE_ID)
      throw new FileIdentityError();
    return value.toString();
  }
  if (!validFileId(value, inode)) throw new FileIdentityError();
  return String(value);
}
export const sameFileId = (a: unknown, b: unknown, inode = false): boolean =>
  validFileId(a, inode) && validFileId(b, inode) && String(a) === String(b);
export const sameFileIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  sameFileId(a.dev, b.dev) && sameFileId(a.ino, b.ino, true);

/** Node's numeric Stats uses seconds * 1000 + nanoseconds / 1e6. Avoid
 * Number(ns) / 1e6 (precision loss) and bigint mtimeMs (fraction truncation).
 * POSIX negative epochs retain a nonnegative nanosecond fraction.
 */
export function statMilliseconds(ns: bigint): number {
  let seconds = ns / 1_000_000_000n;
  let nanos = ns % 1_000_000_000n;
  if (nanos < 0n) {
    seconds--;
    nanos += 1_000_000_000n;
  }
  return Number(seconds) * 1000 + Number(nanos) / 1_000_000;
}
export function assertFileFingerprint(
  value: unknown,
): asserts value is FileFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FileIdentityError();
  const f = value as Record<string, unknown>;
  if (
    Object.keys(f).length !== FINGERPRINT_FIELDS.length ||
    FINGERPRINT_FIELDS.some((k) => !Object.hasOwn(f, k)) ||
    typeof f.dev !== typeof f.ino ||
    !validFileId(f.dev) ||
    !validFileId(f.ino, true) ||
    !Number.isSafeInteger(f.size) ||
    (f.size as number) < 0 ||
    typeof f.mtimeMs !== "number" ||
    !Number.isFinite(f.mtimeMs) ||
    typeof f.ctimeMs !== "number" ||
    !Number.isFinite(f.ctimeMs) ||
    !Number.isSafeInteger(f.nlink) ||
    (f.nlink as number) < 1 ||
    !Number.isSafeInteger(f.mode) ||
    (f.mode as number) < 0 ||
    (f.mode as number) > 0xffffffff
  )
    throw new FileIdentityError();
}
export function fileFingerprint(
  s: BigIntStats | Stats | ExactFileStat,
): ExactFileFingerprint {
  const value = {
    dev: exactFileId(s.dev),
    ino: exactFileId(s.ino, true),
    size: Number(s.size),
    mtimeMs:
      typeof s.mtimeMs === "bigint"
        ? statMilliseconds((s as BigIntStats).mtimeNs)
        : s.mtimeMs,
    ctimeMs:
      typeof s.ctimeMs === "bigint"
        ? statMilliseconds((s as BigIntStats).ctimeNs)
        : s.ctimeMs,
    nlink: Number(s.nlink),
    mode: Number(s.mode),
  };
  assertFileFingerprint(value);
  return value;
}
export const sameFileFingerprint = (
  a: FileFingerprint,
  b: FileFingerprint,
): boolean =>
  sameFileIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.nlink === b.nlink &&
  a.mode === b.mode;
export function exactStat(s: BigIntStats): ExactFileStat {
  return {
    ...fileFingerprint(s),
    isFile: () => s.isFile(),
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
  };
}
export async function exactLstat(p: string): Promise<ExactFileStat> {
  return exactStat(await fs.lstat(p, { bigint: true }));
}
export async function exactHandleStat(
  h: fs.FileHandle,
): Promise<ExactFileStat> {
  return exactStat(await h.stat({ bigint: true }));
}
