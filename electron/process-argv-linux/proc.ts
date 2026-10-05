import { constants } from "node:fs";
import {
  lstat,
  open,
  readlink,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { ARGUMENT_LIMITS } from "./types.js";
import {
  decodeText,
  ReadBudget,
  Refusal,
  sameIdentity,
  validUnsigned64,
  type Identity,
  type ProcSession,
  type ProcSource,
} from "./collector-core.js";

const STAT_MAX_BYTES = 8192;
const PROC_SUPER_MAGIC = 0x9fa0;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY = READ | constants.O_DIRECTORY;

export function parseStat(
  buffer: Buffer,
  expectedPid: number,
): Omit<Identity, "executablePath"> {
  if (
    !buffer.length ||
    buffer.length > STAT_MAX_BYTES ||
    buffer[buffer.length - 1] !== 10
  )
    throw new Refusal("invalid-data");
  // comm is kernel-delimited, may contain spaces, ')' and newlines, and is not an argument.
  // Never decode/return it. The fields after the final ')' are numeric apart from state.
  const end = buffer.lastIndexOf(Buffer.from(") "));
  const start = buffer.indexOf(Buffer.from(" ("));
  if (start < 1 || end <= start + 1) throw new Refusal("invalid-data");
  const pidText = buffer.subarray(0, start).toString("latin1");
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText) || Number(pidText) !== expectedPid)
    throw new Refusal("changed");
  const suffix = buffer.subarray(end + 2).toString("latin1");
  if (!/^[A-Za-z] (?:-?[0-9]+ )*-?[0-9]+\n$/u.test(suffix))
    throw new Refusal("invalid-data");
  const fields = suffix.slice(0, -1).split(" ");
  if (fields.length < 47 || fields.length > 128)
    throw new Refusal("invalid-data");
  if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x")
    throw new Refusal("exited");
  const selected = [1, 19, 23, 24, 25, 42, 43, 44, 45, 46];
  if (selected.some((index) => !validUnsigned64(fields[index])))
    throw new Refusal("invalid-data");
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid > 2147483647)
    throw new Refusal("invalid-data");
  const mmFields = [23, 24, 25, 42, 43, 44, 45, 46].map(
    (index) => fields[index],
  );
  const [startCode, endCode, startStack, , , , argStart, argEnd] =
    mmFields.map(BigInt);
  // These ptrace-gated fields are zero/redacted if the kernel does not permit inspection.
  if (
    startCode <= 1n ||
    endCode <= 1n ||
    startStack === 0n ||
    argStart === 0n ||
    argEnd === 0n
  )
    throw new Refusal("permission");
  if (endCode < startCode || argEnd <= argStart)
    throw new Refusal("invalid-data");
  const length = argEnd - argStart;
  if (length > BigInt(ARGUMENT_LIMITS.maxBytes)) throw new Refusal("truncated");
  return {
    pid: expectedPid,
    parentPid,
    startId: fields[19],
    argumentBytes: Number(length),
    mmIdentity: mmFields.join(":"),
  };
}

class LinuxProcSession implements ProcSession {
  private closed = false;
  private readonly handles = new Set<FileHandle>();
  private root!: FileHandle;
  private directory!: FileHandle;
  private device!: number;

  constructor(
    private readonly pid: number,
    private readonly budget: ReadBudget,
    private readonly onClosed: () => void,
  ) {}

  private async acquire(path: string, flags: number): Promise<FileHandle> {
    this.budget.check();
    const handle = await open(path, flags);
    this.handles.add(handle); // Track before checking for a timeout that raced open().
    this.budget.check();
    return handle;
  }

  private async release(handle: FileHandle) {
    try {
      await handle.close();
    } finally {
      this.handles.delete(handle);
    }
  }

  async initialize(): Promise<this> {
    try {
      this.root = await this.acquire("/proc", DIRECTORY);
      const rootPath = `/proc/self/fd/${this.root.fd}`;
      this.budget.check();
      const fs = await statfs(rootPath);
      this.budget.check();
      if (fs.type !== PROC_SUPER_MAGIC) throw new Refusal("unsupported");
      const rootMetadata = await this.root.stat();
      this.budget.check();
      this.directory = await this.acquire(`${rootPath}/${this.pid}`, DIRECTORY);
      const metadata = await this.directory.stat();
      this.budget.check();
      if (!metadata.isDirectory() || metadata.dev !== rootMetadata.dev)
        throw new Refusal("invalid-data");
      this.device = metadata.dev;
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private path(name: "stat" | "cmdline" | "exe"): string {
    if (this.closed) throw new Refusal("unavailable");
    return `/proc/self/fd/${this.directory.fd}/${name}`;
  }

  /** One positional read: short reads are never stitched into a possibly mixed snapshot. */
  private async boundedFile(
    name: "stat" | "cmdline",
    length: number,
  ): Promise<Buffer> {
    let handle: FileHandle | undefined;
    let buffer: Buffer | undefined;
    try {
      handle = await this.acquire(this.path(name), READ);
      const metadata = await handle.stat();
      this.budget.check();
      if (!metadata.isFile() || metadata.dev !== this.device)
        throw new Refusal("invalid-data");
      buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      this.budget.check();
      // A separate copy lets the full read allocation be scrubbed on all paths.
      return Buffer.from(buffer.subarray(0, bytesRead));
    } finally {
      buffer?.fill(0);
      if (handle) await this.release(handle);
    }
  }

  private async stat(): Promise<Omit<Identity, "executablePath">> {
    const bytes = await this.boundedFile("stat", STAT_MAX_BYTES + 1);
    try {
      return parseStat(bytes, this.pid);
    } finally {
      bytes.fill(0);
    }
  }

  async identity(): Promise<Identity> {
    const first = await this.stat();
    this.budget.check();
    const linkMetadata = await lstat(this.path("exe"));
    this.budget.check();
    if (!linkMetadata.isSymbolicLink() || linkMetadata.dev !== this.device)
      throw new Refusal("invalid-data");
    const link = await readlink(this.path("exe"), { encoding: "buffer" });
    let executablePath: string;
    try {
      this.budget.check();
      if (!link.length || link.length > ARGUMENT_LIMITS.maxExecutableBytes)
        throw new Refusal("invalid-data");
      executablePath = decodeText(link);
      if (
        !executablePath.startsWith("/") ||
        executablePath.endsWith(" (deleted)")
      )
        throw new Refusal("unavailable");
    } finally {
      link.fill(0);
    }
    const last = await this.stat();
    if (
      !sameIdentity({ ...first, executablePath }, { ...last, executablePath })
    )
      throw new Refusal("changed");
    return {
      ...first,
      executablePath,
      mmIdentity: `${first.mmIdentity}:${linkMetadata.dev}:${linkMetadata.ino}`,
    };
  }

  arguments(length: number): Promise<Buffer> {
    if (
      !Number.isInteger(length) ||
      length < 1 ||
      length > ARGUMENT_LIMITS.maxBytes
    )
      throw new Refusal("invalid-data");
    // No overrun/EOF probe: the kernel may expose setproctitle data beyond arg_end.
    return this.boundedFile("cmdline", length);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Cleanup errors carry no identity/arguments and must not override a refusal.
    try {
      await Promise.all(
        [...this.handles].map((handle) => this.release(handle).catch(() => {})),
      );
    } finally {
      this.onClosed();
    }
  }
}

let activeSessions = 0;
export const linuxProcSource: ProcSource = Object.freeze({
  async open(pid: number, budget: ReadBudget) {
    budget.check();
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
      throw new Refusal("invalid-request");
    if (activeSessions >= ARGUMENT_LIMITS.maxRequests)
      throw new Refusal("unavailable");
    activeSessions++;
    return new LinuxProcSession(pid, budget, () => {
      activeSessions--;
    }).initialize();
  },
});
