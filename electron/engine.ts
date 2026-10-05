import { promises as fs, constants } from "node:fs";
import path from "node:path";
import {
  randomUUID,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Stats } from "node:fs";
import type {
  Entry,
  ScanOptions,
  ScanResult,
  Preview,
  OperationResult,
  Batch,
  ProcessStatus,
  ScanProgress,
  ScanCoverage,
  RecoveryInspection,
} from "../shared/types.js";

const DAY = 86_400_000;
const Q = ".agentvac-quarantine";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
type Fingerprint = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  mode: number;
};
const fp = (s: Stats): Fingerprint => ({
  dev: s.dev,
  ino: s.ino,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
  nlink: s.nlink,
  mode: s.mode,
});
const same = (a: Fingerprint, b: Fingerprint) =>
  Object.keys(a).every(
    (k) => a[k as keyof Fingerprint] === b[k as keyof Fingerprint],
  );
interface RecordItem {
  id: string;
  path: string;
  size: number;
  status: "pending" | "quarantined" | "restored" | "failed" | "trashed";
  error?: string;
  before: Fingerprint;
  stored?: Fingerprint;
  restorePending?: boolean;
}
interface Journal {
  version: 1;
  id: string;
  root: string;
  createdAt: string;
  items: RecordItem[];
}
export function validRelative(p: string): boolean {
  return (
    !!p &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    !path.posix.isAbsolute(p) &&
    !/^[a-z]:/i.test(p) &&
    p.split("/").every((s) => s && s !== "." && s !== ".." && !s.includes(":"))
  );
}
export function classify(
  p: string,
): Pick<Entry, "category" | "risk" | "reason"> {
  if (!validRelative(p))
    return {
      category: "protected",
      risk: "protected",
      reason: "路径无效，拒绝访问。",
    };
  const parts = p.split("/");
  const name = parts.at(-1)!;
  if (p === "log/codex-tui.log")
    return {
      category: "log",
      risk: "protected",
      reason: "当前运行日志始终保护，即使修改时间较早。",
    };
  if (
    parts.length === 1 &&
    /^logs_\d+\.sqlite(?:-(wal|shm|journal))?$/.test(name)
  )
    return {
      category: "log",
      risk: "protected",
      reason:
        "Codex 实时日志数据库及旁路文件，仅统计大小。本版不执行 VACUUM、修改数据库或移走日志数据库。",
    };
  if (
    parts.some(
      (s) =>
        s === Q ||
        /^(auth|credentials?|config|state|history|session_index)([._-]|$)/i.test(
          s,
        ),
    ) ||
    /\.(sqlite|sqlite3|db)(-(wal|shm|journal))?$/i.test(name) ||
    ["AGENTS.md", "version.json"].includes(name)
  )
    return {
      category: "protected",
      risk: "protected",
      reason: "凭据、配置、状态数据库、历史索引和运行状态始终保留。",
    };
  if (/^(sessions|archived_sessions)\/(?:[^/]+\/)*[^/]+\.jsonl$/.test(p))
    return {
      category: "session",
      risk: "review",
      reason:
        "会话原文可能用于恢复对话；移走会影响 resume/历史。不会同步修改状态数据库或修复索引，需自行确认不再使用。",
    };
  if (/^log\/codex-tui\.log(?:\.\d+|\.\d{4}-\d{2}-\d{2})(?:\.gz)?$/.test(p))
    return {
      category: "log",
      risk: "safe",
      reason:
        "匹配旧轮转日志白名单；不涉及当前 codex-tui.log。请先退出 Codex 再隔离。",
    };
  if (/^(?:cache|\.cache)\/[^/]+\.cache$/.test(p))
    return {
      category: "cache",
      risk: "review",
      reason:
        "缓存候选，扩展名不能证明可重建。本版仅展示，未验证其用途前保持保护。",
    };
  return {
    category: "protected",
    risk: "protected",
    reason:
      p === "log/codex-tui.log"
        ? "当前运行日志始终保护，即使修改时间较早。"
        : "不在明确白名单内，默认保护；不递归检查项目、技能、MCP 或未知目录。",
  };
}
async function exists(p: string) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function syncDirectory(dir: string) {
  if (process.platform === "win32") return; // Directory fsync is not exposed consistently by Windows.
  try {
    const h = await fs.open(
      dir,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch (e) {
    if (
      !["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw e;
  }
}
async function plainParents(full: string, includeLeaf = true) {
  const parsed = path.parse(full);
  const segments = full
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (let i = 0; i < segments.length - (includeLeaf ? 0 : 1); i++) {
    current = path.join(current, segments[i]);
    const s = await fs.lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new Error("目录路径含链接或非目录，已拒绝：" + current);
  }
}
export class AgentVacEngine {
  private rootFingerprint?: Fingerprint;
  private entries = new Map<string, { entry: Entry; snapshot: Fingerprint }>();
  private latest?: ScanResult;
  private previews = new Map<string, { value: Preview; ids: string[] }>();
  private busy = false;
  private cancelRequested = false;
  private activeScanId?: string;
  private journalKeys = new Map<string, Buffer>();
  constructor(
    readonly root: string,
    private key: Buffer | null,
    readonly demo = false,
    private processCheck: () => Promise<ProcessStatus> = async () => ({
      status: "unknown",
      details: "无法自动确定 Codex 是否已退出。",
    }),
    private recoveryKeys: Buffer[] = [],
  ) {
    if (key !== null && (!Buffer.isBuffer(key) || key.length !== 32))
      throw new Error("恢复密钥无效。");
    if (
      recoveryKeys.length > 16 ||
      recoveryKeys.some((k) => !Buffer.isBuffer(k) || k.length !== 32)
    )
      throw new Error("可信恢复密钥集合无效。");
    this.key = key ? Buffer.from(key) : null;
    const unique = new Map<string, Buffer>();
    for (const k of [...(this.key ? [this.key] : []), ...recoveryKeys])
      unique.set(createHash("sha256").update(k).digest("hex"), Buffer.from(k));
    if (unique.size > 16) throw new Error("可信恢复密钥超过上限。");
    this.recoveryKeys = [...unique.values()];
  }
  async initialize() {
    if (
      !path.isAbsolute(this.root) ||
      path.resolve(this.root) !== this.root ||
      this.root === path.parse(this.root).root
    )
      throw new Error("请选择规范的 Codex 数据目录，不能选择磁盘根目录。");
    await plainParents(this.root);
    const s = await fs.lstat(this.root);
    const real = await fs.realpath(this.root);
    if (
      process.platform === "win32"
        ? real.toLowerCase() !== this.root.toLowerCase()
        : real !== this.root
    )
      throw new Error("所选目录不是规范真实路径。");
    this.rootFingerprint = fp(s);
  }
  private async rootOK() {
    if (!this.rootFingerprint) await this.initialize();
    await plainParents(this.root);
    const s = await fs.lstat(this.root);
    if (
      s.dev !== this.rootFingerprint!.dev ||
      s.ino !== this.rootFingerprint!.ino
    )
      throw new Error("根目录已被替换，请重新选择目录。");
  }
  private full(rel: string) {
    if (!validRelative(rel)) throw new Error("无效相对路径");
    const p = path.join(this.root, ...rel.split("/"));
    if (path.relative(this.root, p).startsWith("..") || p === this.root)
      throw new Error("路径越界");
    return p;
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("另一项操作正在进行，请稍候。");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  cancelScan(requestId?: string): void {
    if (requestId !== undefined && requestId !== this.activeScanId) return;
    this.cancelRequested = true;
  }
  async scan(
    options: ScanOptions,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanResult> {
    return this.exclusive(async () => {
      this.cancelRequested = false;
      this.entries.clear();
      this.previews.clear();
      this.latest = undefined;
      const requestId = options?.requestId ?? randomUUID();
      this.activeScanId = requestId;
      const maxEntries = options?.maxEntries ?? 50_000;
      const started = performance.now();
      const entries: Entry[] = [];
      const warnings: string[] = [];
      let warningCount = 0;
      let visited = 0;
      let discoveredFiles = 0;
      let discoveredBytes = 0;
      let protectedDirectories = 0;
      let inaccessibleEntries = 0;
      let depthLimitedDirectories = 0;
      let resultBytes = 2;
      let limitReason: ScanCoverage["limitReason"] = null;
      let currentPath = "";
      let lastProgress = -Infinity;
      const maxResultBytes = 24 * 1024 * 1024;
      const publish = (phase: ScanProgress["phase"], force = false) => {
        const elapsedMs = Math.max(0, Math.round(performance.now() - started));
        if (!force && elapsedMs - lastProgress < 100) return;
        lastProgress = elapsedMs;
        try {
          onProgress?.({
            requestId,
            root: this.root,
            phase,
            visitedEntries: visited,
            discoveredFiles,
            discoveredBytes,
            elapsedMs,
            maxEntries,
            currentPath,
          });
        } catch {
          /* An unavailable observer must never change filesystem behavior. */
        }
      };
      const warn = (message: string) => {
        warningCount++;
        if (warnings.length < 100) warnings.push(message);
      };
      const checkCancelled = () => {
        if (this.cancelRequested) throw new Error("扫描已取消；文件未改变。");
      };
      const hitLimit = (reason: ScanCoverage["limitReason"]) => {
        if (limitReason) return;
        limitReason = reason;
        warn(
          reason === "entry-count"
            ? `已达 ${maxEntries.toLocaleString("en-US")} 个访问条目上限（含目录）；结果不完整。`
            : "已达 24 MiB 可显示结果预算；结果不完整。请缩小范围，不要将小计当作全部占用。",
        );
      };
      publish("scanning", true);
      try {
        if (
          !options ||
          !Number.isInteger(options.minAgeDays) ||
          options.minAgeDays < 1 ||
          options.minAgeDays > 3650 ||
          typeof options.includeSessions !== "boolean" ||
          ![50_000, 100_000].includes(maxEntries) ||
          !UUID.test(requestId)
        )
          throw new Error(
            "扫描条件无效：天数需为 1–3650，上限仅支持 50,000 或 100,000 项。",
          );
        await this.rootOK();
        const now = Date.now();
        const walk = async (relative: string, depth: number): Promise<void> => {
          const directory = relative ? this.full(relative) : this.root;
          // opendir streams directory entries instead of materializing an unbounded name array.
          const handle = await fs.opendir(directory);
          for await (const dirent of handle) {
            checkCancelled();
            if (!relative && dirent.name === Q) {
              protectedDirectories++;
              continue;
            }
            if (limitReason) break;
            if (visited >= maxEntries) {
              hitLimit("entry-count");
              break;
            }
            await visit(
              relative ? relative + "/" + dirent.name : dirent.name,
              depth,
            );
          }
        };
        const visit = async (rel: string, depth: number): Promise<void> => {
          checkCancelled();
          visited++;
          currentPath = rel;
          publish("scanning");
          try {
            const full = this.full(rel);
            await plainParents(full, false);
            const s = await fs.lstat(full);
            const c = classify(rel);
            const kind: Entry["kind"] = s.isSymbolicLink()
              ? "symlink"
              : s.isDirectory()
                ? "directory"
                : s.isFile()
                  ? "file"
                  : "other";
            const allowedDirectory =
              kind === "directory" &&
              /^(log|sessions|archived_sessions|cache|\.cache)(\/|$)/.test(rel);
            if (allowedDirectory && depth < 12) {
              await walk(rel, depth + 1);
              return;
            }
            const ageDays = Math.max(0, Math.floor((now - s.mtimeMs) / DAY));
            let risk = c.risk;
            let reason = c.reason;
            if (kind !== "file" || s.nlink !== 1) {
              risk = "protected";
              reason =
                kind === "directory"
                  ? "受保护目录（不读取其中内容；占用未计入统计）。"
                  : kind === "symlink"
                    ? "符号链接始终保护，不跟随目标。"
                    : "非普通文件或多重硬链接始终保护。";
              if (kind === "directory") {
                if (allowedDirectory) {
                  depthLimitedDirectories++;
                  reason =
                    "已达 12 层扫描深度限制；目录内容未计入，结果不完整。";
                  warn(rel + "：" + reason);
                } else protectedDirectories++;
              }
            }
            if (
              kind === "file" &&
              ageDays < options.minAgeDays &&
              risk !== "protected"
            ) {
              risk = "protected";
              reason = `最近 ${options.minAgeDays} 天内修改，保护近期与可能活跃的数据。`;
            }
            if (c.category === "session" && !options.includeSessions) {
              risk = "protected";
              reason = "会话复核尚未开启；默认保留全部会话。";
            }
            if (c.category === "cache") {
              risk = "protected";
              reason = c.reason;
            }
            const entry: Entry = {
              id: randomUUID(),
              path: rel,
              category: c.category,
              risk,
              size: kind === "file" ? s.size : 0,
              mtimeMs: s.mtimeMs,
              ageDays,
              reason,
              selectable:
                kind === "file" && s.nlink === 1 && risk !== "protected",
              kind,
            };
            const entryBytes =
              Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
            if (resultBytes + entryBytes > maxResultBytes) {
              hitLimit("result-bytes");
              return;
            }
            resultBytes += entryBytes;
            entries.push(entry);
            this.entries.set(entry.id, { entry, snapshot: fp(s) });
            if (kind === "file") {
              discoveredFiles++;
              discoveredBytes += entry.size;
            }
            publish("scanning");
          } catch (e) {
            if (this.cancelRequested) throw e;
            inaccessibleEntries++;
            warn(rel + ": " + errorText(e));
          }
        };
        await walk("", 0);
        checkCancelled();
        if (warningCount > warnings.length)
          warnings.push(
            `另有 ${warningCount - warnings.length} 项读取警告未逐条展示。`,
          );
        entries.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
        const sum = (risk?: Entry["risk"]) =>
          entries.reduce(
            (n, e) => (!risk || e.risk === risk ? n + e.size : n),
            0,
          );
        const status =
          limitReason || inaccessibleEntries || depthLimitedDirectories
            ? "partial"
            : "complete";
        this.latest = {
          id: requestId,
          root: this.root,
          demo: this.demo,
          scannedAt: new Date().toISOString(),
          minAgeDays: options.minAgeDays,
          includeSessions: options.includeSessions,
          maxEntries,
          entries,
          warnings,
          status,
          coverage: {
            visitedEntries: visited,
            returnedEntries: entries.length,
            protectedDirectories,
            inaccessibleEntries,
            depthLimitedDirectories,
            maxEntries,
            limitReason,
            resultBytes,
          },
          summary: {
            totalBytes: sum(),
            safeBytes: sum("safe"),
            reviewBytes: sum("review"),
            protectedBytes: sum("protected"),
            files: entries.length,
            eligibleFiles: entries.filter((e) => e.selectable).length,
          },
        };
        publish(status, true);
        return this.latest;
      } catch (e) {
        this.entries.clear();
        this.latest = undefined;
        publish(this.cancelRequested ? "cancelled" : "error", true);
        throw e;
      } finally {
        this.activeScanId = undefined;
      }
    });
  }
  private async validateEntry(id: string) {
    const record = this.entries.get(id);
    if (!record || !record.entry.selectable)
      throw new Error("条目不可隔离或扫描已失效。");
    const p = this.full(record.entry.path);
    await this.rootOK();
    await plainParents(p, false);
    const s = await fs.lstat(p);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      !same(fp(s), record.snapshot)
    )
      throw new Error("文件自扫描后发生变化，已跳过；请重新扫描。");
    return record;
  }
  async preview(ids: string[]): Promise<Preview> {
    return this.exclusive(async () => {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 5000 ||
        new Set(ids).size !== ids.length
      )
        throw new Error("请选择 1–5000 个不重复条目。");
      const items: Entry[] = [];
      for (const id of ids) items.push((await this.validateEntry(id)).entry);
      const processStatus = this.demo
        ? {
            status: "clear" as const,
            details: "演示夹具，不涉及真实 Codex 进程。",
          }
        : await this.processCheck();
      const value: Preview = {
        token: randomUUID(),
        items,
        totalBytes: items.reduce((n, e) => n + e.size, 0),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        processStatus,
        scanStatus: this.latest?.status ?? "partial",
      };
      this.previews.set(value.token, { value, ids });
      return value;
    });
  }
  private async quarantineDir() {
    await this.rootOK();
    const dir = this.full(Q);
    const before = await exists(dir);
    if (!before) {
      await fs.mkdir(dir, { mode: 0o700 });
      await syncDirectory(this.root);
    }
    await plainParents(dir);
    return dir;
  }
  private async batchDir(id: string, create = false) {
    if (!UUID.test(id)) throw new Error("无效批次 ID。");
    const q = await this.quarantineDir();
    const dir = path.join(q, id);
    if (create && !(await exists(dir))) {
      await fs.mkdir(dir, { mode: 0o700 });
      await syncDirectory(q);
    }
    await plainParents(dir);
    return dir;
  }
  private requireSigningKey() {
    if (!this.key)
      throw new Error(
        "恢复密钥暂不可用；只能扫描和查看救援信息，请先恢复本机密钥。",
      );
  }
  private keyForSignature(j: Journal, signature: Buffer): Buffer | undefined {
    if (signature.length !== 32) return undefined;
    const text = JSON.stringify(j);
    return this.recoveryKeys.find((key) =>
      timingSafeEqual(
        signature,
        createHmac("sha256", key).update(text).digest(),
      ),
    );
  }
  private signatureMatches(j: Journal, signature: Buffer) {
    return !!this.keyForSignature(j, signature);
  }
  private sign(j: Journal, key: Buffer | null = this.key) {
    if (!key) throw new Error("恢复密钥暂不可用；请先导入你自己的恢复钥匙。");
    return createHmac("sha256", key).update(JSON.stringify(j)).digest("hex");
  }
  private async writeJournal(j: Journal, signingKey: Buffer | null = this.key) {
    const dir = await this.batchDir(j.id, true);
    const tmp = path.join(dir, randomUUID() + ".tmp");
    const h = await fs.open(tmp, "wx", 0o600);
    try {
      try {
        await h.writeFile(
          JSON.stringify(
            {
              journal: j,
              signature: this.sign(j, signingKey),
              keyId: createHash("sha256").update(signingKey!).digest("hex"),
            },
            null,
            2,
          ),
        );
        await h.sync();
      } finally {
        await h.close();
      }
      const target = path.join(dir, "manifest.json");
      const s = await exists(target);
      if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1))
        throw new Error("隔离清单已被替换。");
      await plainParents(dir);
      await fs.rename(tmp, target);
      await syncDirectory(dir);
    } finally {
      // Only remove this operation's own exclusive temporary journal, never source data.
      await fs.unlink(tmp).catch(() => {});
    }
  }
  private async readJournal(
    id: string,
    allowRootCreation = true,
    reconcile = true,
  ): Promise<Journal> {
    if (!UUID.test(id)) throw new Error("无效批次 ID。");
    const dir = allowRootCreation
      ? await this.batchDir(id)
      : path.join(this.full(Q), id);
    if (!allowRootCreation) await plainParents(dir);
    const f = path.join(dir, "manifest.json");
    const before = await fs.lstat(f);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 32_000_000
    )
      throw new Error("无效隔离清单。");
    const h = await fs.open(
      f,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    let raw: string;
    try {
      const s = await h.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 32_000_000)
        throw new Error("无效隔离清单。");
      raw = await h.readFile("utf8");
    } finally {
      await h.close();
    }
    const data = JSON.parse(raw!);
    const j = data.journal as Journal;
    const sig = Buffer.from(String(data.signature), "hex");
    if (
      !this.signatureMatches(j, sig) ||
      j.version !== 1 ||
      j.id !== id ||
      j.root !== this.root ||
      !Array.isArray(j.items)
    )
      throw new Error("隔离清单校验失败；拒绝使用被改动或来自其他设备的清单。");
    const ids = new Set<string>();
    for (const i of j.items) {
      if (
        !UUID.test(i.id) ||
        ids.has(i.id) ||
        !validRelative(i.path) ||
        classify(i.path).risk === "protected" ||
        classify(i.path).category === "cache"
      )
        throw new Error("隔离清单包含非法路径。");
      ids.add(i.id);
    }
    this.journalKeys.set(j.id, this.keyForSignature(j, sig)!);
    if (!reconcile) return j;
    // A pending move is recoverable even if the app stopped after rename and before journal update.
    for (const i of j.items.filter((i) => i.status === "pending")) {
      const stored = await exists(path.join(dir, i.id + ".data"));
      const original = await exists(this.full(i.path));
      if (
        stored &&
        stored.isFile() &&
        stored.nlink === 1 &&
        stored.dev === i.before.dev &&
        stored.ino === i.before.ino &&
        stored.size === i.before.size &&
        stored.mtimeMs === i.before.mtimeMs
      ) {
        i.status = "quarantined";
        i.stored = fp(stored);
      } else {
        i.status = "failed";
        i.error = "操作中断或文件状态不确定，请人工检查隔离目录。";
      }
    }
    for (const i of j.items.filter((i) => i.status === "quarantined")) {
      const stored = await exists(path.join(dir, i.id + ".data"));
      const original = await exists(this.full(i.path));
      if (
        !stored &&
        original &&
        original.isFile() &&
        original.nlink === 1 &&
        i.stored &&
        original.dev === i.stored.dev &&
        original.ino === i.stored.ino &&
        original.size === i.stored.size &&
        original.mtimeMs === i.stored.mtimeMs
      ) {
        i.status = "restored";
        delete i.error;
      }
    }
    return j;
  }
  async quarantine(
    token: string,
    confirmedClosed: boolean,
  ): Promise<OperationResult> {
    return this.exclusive(async () => {
      this.requireSigningKey();
      const saved = this.previews.get(token);
      this.previews.delete(token);
      if (!saved || Date.parse(saved.value.expiresAt) < Date.now())
        throw new Error("预览已失效，请重新预览。");
      if (!this.demo && confirmedClosed !== true)
        throw new Error("请先确认已退出全部 Codex CLI 和桌面进程。");
      if (!this.demo && (await this.processCheck()).status === "running")
        throw new Error("检测到 Codex 正在运行。请退出后重新预览。");
      const j: Journal = {
        version: 1,
        id: randomUUID(),
        root: this.root,
        createdAt: new Date().toISOString(),
        items: [],
      };
      const dir = await this.batchDir(j.id, true);
      const result: OperationResult = {
        batchId: j.id,
        completed: 0,
        failed: [],
        bytes: 0,
      };
      j.items = saved.ids.map((id) => {
        const record = this.entries.get(id)!;
        return {
          id: randomUUID(),
          path: record.entry.path,
          size: record.entry.size,
          status: "pending" as const,
          before: record.snapshot,
        };
      });
      await this.writeJournal(j); // One durable intent record for the whole batch; pending moves reconcile after interruption.
      for (let index = 0; index < saved.ids.length; index++) {
        const id = saved.ids[index];
        const item = j.items[index];
        let moved = false;
        try {
          const r = await this.validateEntry(id);
          const source = this.full(r.entry.path);
          const target = path.join(dir, item.id + ".data");
          const handle = await fs.open(
            source,
            constants.O_RDONLY |
              (constants.O_NOFOLLOW ?? 0) |
              (constants.O_NONBLOCK ?? 0),
          );
          try {
            if (!same(fp(await handle.stat()), r.snapshot))
              throw new Error("源文件已变化。");
            await plainParents(source, false);
            await plainParents(dir);
            if (await exists(target)) throw new Error("隔离目标已存在。");
            if (!same(fp(await fs.lstat(source)), r.snapshot))
              throw new Error("源文件已变化。");
            await fs.rename(source, target);
            moved = true;
          } finally {
            await handle.close();
          }
          const movedStat = await fs.lstat(target);
          if (
            movedStat.dev !== r.snapshot.dev ||
            movedStat.ino !== r.snapshot.ino ||
            !movedStat.isFile()
          )
            throw new Error("移动后文件标识不一致，请人工检查。");
          item.status = "quarantined";
          item.stored = fp(movedStat);
          result.completed++;
          result.bytes += item.size;
        } catch (e) {
          item.status = moved ? "pending" : "failed";
          item.error =
            (moved ? "移动已完成，记录待协调；请刷新隔离记录。" : "") +
            errorText(e);
          result.failed.push({ path: item.path, error: item.error });
        }
      }
      await syncDirectory(dir);
      for (const parent of new Set(
        j.items
          .filter((i) => i.status === "quarantined" || i.status === "pending")
          .map((i) => path.dirname(this.full(i.path))),
      ))
        await syncDirectory(parent);
      await this.writeJournal(j);
      this.previews.clear();
      this.entries.clear();
      this.latest = undefined;
      return result;
    });
  }
  async getQuarantinePath(): Promise<string> {
    await this.rootOK();
    const dir = this.full(Q);
    if (!(await exists(dir))) throw new Error("尚无隔离目录。");
    await plainParents(dir);
    return dir;
  }
  async inspectRecovery(): Promise<RecoveryInspection> {
    return this.exclusive(async () => {
      await this.rootOK();
      const result: RecoveryInspection = {
        root: this.root,
        readOnly: true,
        truncated: false,
        inspectedFiles: 0,
        storedBytes: 0,
        batches: [],
      };
      const q = this.full(Q);
      if (!(await exists(q))) return result;
      await plainParents(q);
      const directories = await fs.opendir(q);
      for await (const entry of directories) {
        if (!UUID.test(entry.name)) continue;
        if (result.batches.length >= 200 || result.inspectedFiles >= 50_000) {
          result.truncated = true;
          break;
        }
        const item: RecoveryInspection["batches"][number] = {
          id: entry.name,
          verified: false,
          explanation:
            "尚未通过恢复清单认证；此处只统计仍在隔离区的文件，不会恢复或删除。",
          storedFiles: 0,
          storedBytes: 0,
          irregularEntries: 0,
        };
        const dir = path.join(q, entry.name);
        try {
          await plainParents(dir);
          try {
            await this.readJournal(entry.name, false, false);
            item.verified = true;
            item.explanation =
              "恢复清单已通过可信钥匙认证；恢复前仍会重新检查文件及目标路径。";
          } catch {
            item.explanation =
              "清单无法认证：可能缺少原恢复钥匙、来自另一设备，或清单已改变。数据文件仍保留；请导入你自己的钥匙备份后重试。";
          }
          for await (const child of await fs.opendir(dir)) {
            if (child.name === "manifest.json" || child.name.endsWith(".tmp"))
              continue;
            if (result.inspectedFiles >= 50_000) {
              result.truncated = true;
              break;
            }
            result.inspectedFiles++;
            if (
              !child.name.endsWith(".data") ||
              !UUID.test(child.name.slice(0, -5))
            ) {
              item.irregularEntries++;
              continue;
            }
            const data = await fs.lstat(path.join(dir, child.name));
            if (!data.isFile() || data.isSymbolicLink() || data.nlink !== 1) {
              item.irregularEntries++;
              continue;
            }
            item.storedFiles++;
            item.storedBytes += data.size;
            result.storedBytes += data.size;
          }
        } catch {
          item.irregularEntries++;
          item.explanation =
            "隔离批次不可读取或含不安全路径；未跟随链接、未修改任何文件。";
        }
        result.batches.push(item);
        if (result.truncated) break;
      }
      return result;
    });
  }
  async history(): Promise<Batch[]> {
    return this.exclusive(async () => {
      await this.rootOK();
      if (!(await exists(this.full(Q)))) return [];
      const dir = await this.quarantineDir();
      const rows: Batch[] = [];
      for (const name of await fs.readdir(dir))
        if (UUID.test(name)) {
          try {
            const j = await this.readJournal(name);
            rows.push({
              id: j.id,
              root: j.root,
              createdAt: j.createdAt,
              items: j.items.map(({ id, path, size, status, error }) => ({
                id,
                path,
                size,
                status,
                error,
              })),
            });
          } catch (e) {
            rows.push({
              id: name,
              root: this.root,
              createdAt: new Date().toISOString(),
              items: [
                {
                  id: "invalid",
                  path: name + "/manifest.json",
                  size: 0,
                  status: "failed",
                  error: "清单不可用，未执行任何恢复：" + errorText(e),
                },
              ],
            });
          }
        }
      for (const name of await fs.readdir(dir))
        if (name.endsWith(".receipt.json") && UUID.test(name.slice(0, -13))) {
          const id = name.slice(0, -13);
          if (rows.some((r) => r.id === id)) continue;
          try {
            const p = path.join(dir, name);
            const s = await fs.lstat(p);
            if (!s.isFile() || s.nlink !== 1 || s.size > 32_000_000) continue;
            const h = await fs.open(
              p,
              constants.O_RDONLY |
                (constants.O_NOFOLLOW ?? 0) |
                (constants.O_NONBLOCK ?? 0),
            );
            let raw: string;
            try {
              const stat = await h.stat();
              if (!stat.isFile() || stat.nlink !== 1)
                throw new Error("无效记录");
              raw = await h.readFile("utf8");
            } finally {
              await h.close();
            }
            const data = JSON.parse(raw!);
            const j = data.journal as Journal;
            const sig = Buffer.from(String(data.signature), "hex");
            if (
              !this.signatureMatches(j, sig) ||
              j.id !== id ||
              j.root !== this.root ||
              j.version !== 1 ||
              !Array.isArray(j.items) ||
              j.items.some((i) => !validRelative(i.path))
            )
              throw new Error("记录验证失败");
            rows.push({
              id: j.id,
              root: j.root,
              createdAt: j.createdAt,
              items: j.items.map(({ id, path, size, status, error }) => ({
                id,
                path,
                size,
                status,
                error,
              })),
            });
          } catch {
            rows.push({
              id,
              root: this.root,
              createdAt: new Date().toISOString(),
              items: [
                {
                  id: "receipt",
                  path: name,
                  size: 0,
                  status: "failed",
                  error: "系统回收站记录无法验证。请直接检查系统回收站。",
                },
              ],
            });
          }
        }
      return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }
  async trash(
    batchId: string,
    confirmed: boolean,
    trashItem: (dir: string) => Promise<void>,
  ): Promise<OperationResult> {
    return this.exclusive(async () => {
      this.requireSigningKey();
      if (confirmed !== true) throw new Error("必须明确确认移入系统回收站。");
      await this.rootOK();
      const j = await this.readJournal(batchId);
      const dir = await this.batchDir(batchId);
      const candidates = j.items.filter((i) => i.status === "quarantined");
      if (!candidates.length)
        throw new Error("此批次没有可移入回收站的隔离文件。");
      const allowed = new Set([
        "manifest.json",
        ...candidates.map((i) => i.id + ".data"),
      ]);
      for (const name of await fs.readdir(dir))
        if (!allowed.has(name))
          throw new Error("批次目录含未知文件，已拒绝移入回收站：" + name);
      for (const i of candidates) {
        const f = path.join(dir, i.id + ".data");
        const s = await fs.lstat(f);
        if (!i.stored || !s.isFile() || s.nlink !== 1 || !same(fp(s), i.stored))
          throw new Error("隔离文件已变化，已拒绝移入回收站。");
      }
      await plainParents(dir);
      await trashItem(dir);
      if (await exists(dir))
        throw new Error("系统未确认移入回收站；请检查原隔离目录。");
      const failed: { path: string; error: string }[] = [];
      for (const i of candidates) i.status = "trashed";
      try {
        const q = await this.quarantineDir();
        const temp = path.join(q, randomUUID() + ".receipt.tmp");
        const h = await fs.open(temp, "wx", 0o600);
        try {
          await h.writeFile(
            JSON.stringify(
              {
                journal: j,
                signature: this.sign(j),
                keyId: createHash("sha256").update(this.key!).digest("hex"),
              },
              null,
              2,
            ),
          );
          await h.sync();
        } finally {
          await h.close();
        }
        await fs.rename(temp, path.join(q, batchId + ".receipt.json"));
        await syncDirectory(q);
      } catch (e) {
        failed.push({
          path: batchId,
          error: "文件已移入系统回收站，但操作记录未保存：" + errorText(e),
        });
      }
      return {
        batchId,
        completed: candidates.length,
        failed,
        bytes: candidates.reduce((n, i) => n + i.size, 0),
      };
    });
  }
  async restore(
    batchId: string,
    confirmedClosed = false,
  ): Promise<OperationResult> {
    return this.exclusive(async () => {
      await this.rootOK();
      if (!this.demo && confirmedClosed !== true)
        throw new Error("请先确认已退出全部 Codex CLI 和桌面进程。");
      if (!this.demo && (await this.processCheck()).status === "running")
        throw new Error("检测到 Codex 正在运行，请退出后恢复。");
      const j = await this.readJournal(batchId);
      const signingKey = this.journalKeys.get(batchId)!;
      const dir = await this.batchDir(batchId);
      const result: OperationResult = {
        batchId,
        completed: 0,
        failed: [],
        bytes: 0,
      };
      const restoring = j.items.filter((i) => i.status === "quarantined");
      const previouslyPending = new Set(
        restoring.filter((i) => i.restorePending).map((i) => i.id),
      );
      for (const i of restoring) i.restorePending = true;
      await this.writeJournal(j, signingKey);
      for (const i of restoring) {
        try {
          const source = path.join(dir, i.id + ".data"),
            target = this.full(i.path);
          await plainParents(source, false);
          await plainParents(target, false);
          const s = await fs.lstat(source);
          const original = await exists(target);
          const interruptedLink = !!(
            previouslyPending.has(i.id) &&
            i.stored &&
            original &&
            original.isFile() &&
            s.isFile() &&
            s.nlink === 2 &&
            original.nlink === 2 &&
            original.ino === s.ino &&
            original.dev === s.dev &&
            s.ino === i.stored.ino &&
            s.dev === i.stored.dev &&
            s.size === i.stored.size &&
            s.mtimeMs === i.stored.mtimeMs
          );
          if (!interruptedLink) {
            if (
              !i.stored ||
              !s.isFile() ||
              s.nlink !== 1 ||
              !same(fp(s), i.stored)
            )
              throw new Error("隔离文件已变化；拒绝恢复。");
            if (original) throw new Error("原路径已存在文件；不会覆盖。");
            // link is atomic and fails with EEXIST; unlike rename, it cannot overwrite a concurrent destination.
            await fs.link(source, target);
          }
          try {
            await fs.unlink(source);
          } catch (e) {
            i.error =
              "恢复已创建原文件，但隔离链接移除失败。可重试恢复：" +
              errorText(e);
            throw new Error(i.error);
          }
          i.status = "restored";
          delete i.error;
          delete i.restorePending;
          result.completed++;
          result.bytes += i.size;
        } catch (e) {
          i.error = errorText(e);
          result.failed.push({ path: i.path, error: i.error });
        }
      }
      await syncDirectory(dir);
      for (const parent of new Set(
        restoring
          .filter((i) => i.status === "restored")
          .map((i) => path.dirname(this.full(i.path))),
      ))
        await syncDirectory(parent);
      await this.writeJournal(j, signingKey);
      this.previews.clear();
      this.entries.clear();
      return result;
    });
  }
}
export async function loadKey(stateDir: string): Promise<Buffer> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await plainParents(stateDir);
  const p = path.join(stateDir, "journal-signing.key");
  const s = await exists(p);
  if (!s) {
    try {
      const h = await fs.open(p, "wx", 0o600);
      try {
        await h.writeFile(randomBytes(32));
        await h.sync();
      } finally {
        await h.close();
      }
      await syncDirectory(stateDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const check = await fs.lstat(p);
  if (
    !check.isFile() ||
    check.isSymbolicLink() ||
    check.nlink !== 1 ||
    check.size !== 32
  )
    throw new Error("本地恢复密钥异常。");
  return fs.readFile(p);
}

export { plainParents as assertPlainDirectoryPath };
