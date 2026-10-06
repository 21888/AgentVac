import { promises as fs, constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import path from "node:path";
import { validRelative } from "./providers/paths.js";
import type { ProviderAdapter } from "./providers/types.js";

export type UnitKind = "file" | "directory";
export interface CleanupUnitDefinition {
  policy: string;
  kind: "directory" | "bundle";
  members: { path: string; kind: UnitKind; optional?: boolean }[];
}
type UnitFileId = string | number;
export interface UnitFingerprint {
  dev: UnitFileId;
  ino: UnitFileId;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  mode: number;
}
export interface UnitNode {
  path: string;
  kind: UnitKind;
  fingerprint: UnitFingerprint;
}
export interface UnitSnapshot {
  definition: CleanupUnitDefinition;
  nodes: UnitNode[];
  parents: { path: string; dev: UnitFileId; ino: UnitFileId }[];
  absent: string[];
  size: number;
  fileCount: number;
  directoryCount: number;
  mtimeMs: number;
}
export interface UnitRestoreState {
  directories: { path: string; dev: UnitFileId; ino: UnitFileId }[];
  completedMembers: string[];
  linked?: { path: string; fingerprint: UnitFingerprint }[];
}
export interface UnitRecord {
  snapshot: UnitSnapshot;
  stored?: UnitSnapshot;
  container?: { dev: UnitFileId; ino: UnitFileId };
  restore?: UnitRestoreState;
}
export const UNIT_MAX_NODES = 5000;
export const UNIT_MAX_DEPTH = 12;
// NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. New identities are exact
// canonical decimal strings; only already-safe numeric legacy journals are valid.
const MAX_FILE_ID = (1n << 64n) - 1n;
function validFileId(value: unknown, inode = false): value is UnitFileId {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= (inode ? 1 : 0);
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= MAX_FILE_ID &&
    (!inode || value !== "0")
  );
}
function exactFileId(value: bigint | UnitFileId, inode = false): string {
  if (typeof value === "bigint") {
    if (value < (inode ? 1n : 0n) || value > MAX_FILE_ID)
      throw new Error("清理单元文件身份不可用。");
    return value.toString();
  }
  if (!validFileId(value, inode)) throw new Error("清理单元文件身份不可用。");
  return String(value);
}
const sameFileId = (a: UnitFileId, b: UnitFileId) =>
  validFileId(a) && validFileId(b) && String(a) === String(b);
type UnitStat = UnitFingerprint &
  Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">;
// Match Node's floating millisecond Stats representation for safe legacy records,
// deriving timestamps and identity from one no-follow sample rather than two reads.
const milliseconds = (ns: bigint) =>
  Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1_000_000;
export const unitFingerprint = (
  s: Stats | BigIntStats | UnitStat,
): UnitFingerprint => ({
  dev: exactFileId(s.dev),
  ino: exactFileId(s.ino, true),
  size: Number(s.size),
  mtimeMs:
    typeof s.mtimeMs === "bigint"
      ? milliseconds((s as BigIntStats).mtimeNs)
      : s.mtimeMs,
  ctimeMs:
    typeof s.ctimeMs === "bigint"
      ? milliseconds((s as BigIntStats).ctimeNs)
      : s.ctimeMs,
  nlink: Number(s.nlink),
  mode: Number(s.mode),
});
async function unitLstat(p: string): Promise<UnitStat> {
  const stat = await fs.lstat(p, { bigint: true });
  return {
    ...unitFingerprint(stat),
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink(),
  };
}
const identical = (a: UnitFingerprint, b: UnitFingerprint) =>
  Object.keys(a).every((k) =>
    k === "dev" || k === "ino"
      ? sameFileId(a[k], b[k])
      : a[k as keyof UnitFingerprint] === b[k as keyof UnitFingerprint],
  );
const identity = (a: UnitFingerprint, b: UnitFingerprint) =>
  sameFileId(a.dev, b.dev) &&
  sameFileId(a.ino, b.ino) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.mode === b.mode;
export async function unitSyncDirectory(p: string) {
  if (process.platform === "win32") return;
  const h = await fs.open(
    p,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await h.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  } finally {
    await h.close();
  }
}
export async function unitExists(p: string) {
  try {
    return await unitLstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function unitPlainParents(p: string, leaf = false) {
  const root = path.parse(p).root;
  const parts = p.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, parts.length - (leaf ? 0 : 1))) {
    current = path.join(current, part);
    // This is a type/no-link check of ancestry outside the signed unit root.
    // Filesystem IDs here are not recorded or used as ownership evidence.
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("清理单元路径含链接或非目录。");
  }
}
function full(root: string, relative: string) {
  if (!validRelative(relative)) throw new Error("清理单元路径非法。");
  return path.join(root, ...relative.split("/"));
}
export function validateUnitDefinition(
  definition: CleanupUnitDefinition,
  anchor?: string,
) {
  if (
    !definition ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(definition.policy) ||
    !["directory", "bundle"].includes(definition.kind) ||
    !Array.isArray(definition.members) ||
    !definition.members.length ||
    definition.members.length > 8 ||
    (anchor !== undefined && definition.members[0]?.path !== anchor) ||
    (definition.kind === "directory" &&
      (definition.members.length !== 1 ||
        definition.members[0]?.kind !== "directory"))
  )
    throw new Error("清理单元定义无效。");
  for (const member of definition.members) {
    if (
      !validRelative(member.path) ||
      member.path.startsWith(".agentvac-quarantine") ||
      !["file", "directory"].includes(member.kind) ||
      (member.optional !== undefined && typeof member.optional !== "boolean")
    )
      throw new Error("清理单元成员无效。");
    if (
      definition.members.some(
        (other) =>
          other !== member &&
          (other.path === member.path ||
            other.path.startsWith(member.path + "/")),
      )
    )
      throw new Error("清理单元成员重叠。");
  }
  if (definition.members[0].optional)
    throw new Error("清理单元主成员不能是可选项。");
}
export async function assertUnitPolicy(
  root: string,
  snapshot: UnitSnapshot,
  adapter: ProviderAdapter,
) {
  validateUnitDefinition(snapshot.definition);
  const current = await adapter.cleanupUnit?.(
    snapshot.definition.members[0].path,
    root,
  );
  if (
    !current ||
    JSON.stringify(current) !== JSON.stringify(snapshot.definition)
  )
    throw new Error("清理单元策略已改变或不再受支持。");
  if (
    !Array.isArray(snapshot.nodes) ||
    !snapshot.nodes.length ||
    snapshot.nodes.length > UNIT_MAX_NODES
  )
    throw new Error("清理单元清单超出界限。");
  const paths = new Set<string>();
  const fpKeys = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink", "mode"];
  if (
    !Array.isArray(snapshot.absent) ||
    new Set(snapshot.absent).size !== snapshot.absent.length ||
    snapshot.absent.some(
      (p) => !current.members.some((m) => m.path === p && m.optional),
    )
  )
    throw new Error("清理单元缺失成员记录非法。");
  for (const node of snapshot.nodes) {
    if (
      !node ||
      !validRelative(node.path) ||
      paths.has(node.path) ||
      !["file", "directory"].includes(node.kind) ||
      !node.fingerprint ||
      Object.keys(node.fingerprint).sort().join() !==
        [...fpKeys].sort().join() ||
      !validFileId(node.fingerprint.dev) ||
      !validFileId(node.fingerprint.ino, true) ||
      !["size", "mtimeMs", "ctimeMs", "nlink", "mode"].every((k) =>
        Number.isFinite(node.fingerprint[k as keyof UnitFingerprint]),
      ) ||
      !(["size", "nlink", "mode"] as const).every(
        (k) =>
          Number.isSafeInteger(node.fingerprint[k]) && node.fingerprint[k] >= 0,
      ) ||
      (node.kind === "file" && node.fingerprint.nlink !== 1) ||
      !adapter.unitEntryAllowed?.(current.policy, node.path, node.kind)
    )
      throw new Error("清理单元包含未知或不安全成员。");
    paths.add(node.path);
    const member = current.members.find(
      (m) => node.path === m.path || node.path.startsWith(m.path + "/"),
    );
    if (
      !member ||
      snapshot.absent.includes(member.path) ||
      (node.path === member.path
        ? member.kind !== node.kind
        : member.kind !== "directory" ||
          node.path.slice(member.path.length + 1).split("/").length >
            UNIT_MAX_DEPTH)
    )
      throw new Error("清理单元清单路径越界。");
  }
  for (const member of current.members)
    if (!snapshot.absent.includes(member.path) && !paths.has(member.path))
      throw new Error("清理单元缺少必要成员。");
  for (const node of snapshot.nodes)
    if (
      !current.members.some((m) => m.path === node.path) &&
      !snapshot.nodes.some(
        (p) =>
          p.path === path.posix.dirname(node.path) && p.kind === "directory",
      )
    )
      throw new Error("清理单元目录拓扑不完整。");
  if (
    snapshot.fileCount !==
      snapshot.nodes.filter((n) => n.kind === "file").length ||
    snapshot.directoryCount !==
      snapshot.nodes.filter((n) => n.kind === "directory").length ||
    snapshot.size !==
      snapshot.nodes
        .filter((n) => n.kind === "file")
        .reduce((sum, n) => sum + n.fingerprint.size, 0) ||
    snapshot.mtimeMs !==
      Math.max(...snapshot.nodes.map((n) => n.fingerprint.mtimeMs))
  )
    throw new Error("清理单元数量或占用不一致。");
  const expectedParents = new Set<string>([""]);
  for (const member of current.members) {
    let parent = path.posix.dirname(member.path);
    while (parent !== ".") {
      expectedParents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if (
    !Array.isArray(snapshot.parents) ||
    snapshot.parents.length !== expectedParents.size ||
    new Set(snapshot.parents.map((p) => p.path)).size !==
      expectedParents.size ||
    snapshot.parents.some(
      (p) =>
        !expectedParents.has(p.path) ||
        !validFileId(p.dev) ||
        !validFileId(p.ino, true),
    )
  )
    throw new Error("清理单元父目录身份不完整。");
  if (
    adapter.unitLayoutAllowed &&
    !adapter.unitLayoutAllowed(current, snapshot.nodes)
  )
    throw new Error("清理单元目录布局无法验证。");
}
export async function assertUnitRecord(
  root: string,
  record: UnitRecord,
  adapter: ProviderAdapter,
) {
  if (!record || !record.snapshot) throw new Error("清理单元记录无效。");
  await assertUnitPolicy(root, record.snapshot, adapter);
  if (record.stored) {
    await assertUnitPolicy(root, record.stored, adapter);
    if (
      JSON.stringify(record.stored.definition) !==
        JSON.stringify(record.snapshot.definition) ||
      JSON.stringify(record.stored.absent) !==
        JSON.stringify(record.snapshot.absent) ||
      JSON.stringify(record.stored.parents) !==
        JSON.stringify(record.snapshot.parents) ||
      record.stored.nodes.length !== record.snapshot.nodes.length
    )
      throw new Error("隔离单元布局与原始签名不一致。");
    for (const node of record.stored.nodes) {
      const original = record.snapshot.nodes.find(
        (n) => n.path === node.path && n.kind === node.kind,
      );
      if (
        !original ||
        !identity(original.fingerprint, node.fingerprint) ||
        original.fingerprint.nlink !== node.fingerprint.nlink ||
        (!record.snapshot.definition.members.some(
          (m) => m.path === node.path,
        ) &&
          original.fingerprint.ctimeMs !== node.fingerprint.ctimeMs)
      )
        throw new Error("隔离单元成员身份与原始签名不一致。");
    }
  }
  if (
    record.container &&
    (!validFileId(record.container.dev) ||
      !validFileId(record.container.ino, true) ||
      !sameFileId(
        record.container.dev,
        record.snapshot.parents.find((p) => p.path === "")!.dev,
      ))
  )
    throw new Error("隔离容器身份无效。");
  const state = record.restore;
  if (!state) return;
  if (
    !record.container ||
    !Array.isArray(state.directories) ||
    !Array.isArray(state.completedMembers) ||
    state.directories.length > record.snapshot.directoryCount ||
    state.completedMembers.length > record.snapshot.definition.members.length ||
    new Set(state.directories.map((d) => d.path)).size !==
      state.directories.length ||
    new Set(state.completedMembers).size !== state.completedMembers.length ||
    state.completedMembers.some(
      (p) =>
        !record.snapshot.definition.members.some((m) => m.path === p) ||
        record.snapshot.absent.includes(p),
    )
  )
    throw new Error("恢复进度记录无效。");
  for (const directory of state.directories) {
    const original = record.snapshot.nodes.find(
      (n) => n.path === directory.path && n.kind === "directory",
    );
    if (
      !original ||
      !validFileId(directory.dev) ||
      !validFileId(directory.ino, true) ||
      !sameFileId(directory.dev, original.fingerprint.dev) ||
      sameFileId(directory.ino, original.fingerprint.ino)
    )
      throw new Error("恢复目录身份无效。");
  }
  if (state.linked !== undefined) {
    if (
      !Array.isArray(state.linked) ||
      state.linked.length > record.snapshot.fileCount ||
      new Set(state.linked.map((l) => l.path)).size !== state.linked.length
    )
      throw new Error("恢复链接记录无效。");
    for (const linked of state.linked) {
      const node = record.snapshot.nodes.find(
        (n) => n.path === linked.path && n.kind === "file",
      );
      if (
        !node ||
        !linked.fingerprint ||
        Object.keys(linked.fingerprint).sort().join() !==
          Object.keys(node.fingerprint).sort().join() ||
        !validFileId(linked.fingerprint.dev) ||
        !validFileId(linked.fingerprint.ino, true) ||
        !["size", "mtimeMs", "ctimeMs", "nlink", "mode"].every((k) =>
          Number.isFinite(linked.fingerprint[k as keyof UnitFingerprint]),
        ) ||
        linked.fingerprint.nlink !== 2 ||
        !identity(linked.fingerprint, node.fingerprint)
      )
        throw new Error("恢复链接不属于已签名单元。");
    }
  }
}
export async function captureUnit(
  root: string,
  definition: CleanupUnitDefinition,
  adapter: ProviderAdapter,
  check: (relative: string) => void = () => {},
): Promise<UnitSnapshot> {
  validateUnitDefinition(definition);
  const rootStat = await unitLstat(root);
  const nodes: UnitNode[] = [],
    absent: string[] = [];
  const parents: UnitSnapshot["parents"] = [];
  for (const member of definition.members) {
    let current = path.posix.dirname(member.path);
    while (true) {
      const relative = current === "." ? "" : current;
      if (!parents.some((p) => p.path === relative)) {
        const p = relative ? full(root, relative) : root;
        await unitPlainParents(p, true);
        const stat = await unitLstat(p);
        parents.push({ path: relative, dev: stat.dev, ino: stat.ino });
      }
      if (current === ".") break;
      current = path.posix.dirname(current);
    }
  }
  parents.sort((a, b) => a.path.localeCompare(b.path));
  const visit = async (
    relative: string,
    depth: number,
    expected?: UnitKind,
  ) => {
    check(relative);
    if (depth > UNIT_MAX_DEPTH || nodes.length >= UNIT_MAX_NODES)
      throw new Error("清理单元超出 5000 项或 12 层安全界限。");
    const p = full(root, relative);
    await unitPlainParents(p);
    const stat = await unitLstat(p);
    const kind: UnitKind = stat.isDirectory() ? "directory" : "file";
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1) ||
      !sameFileId(stat.dev, rootStat.dev) ||
      (expected && expected !== kind) ||
      !adapter.unitEntryAllowed?.(definition.policy, relative, kind)
    )
      throw new Error("清理单元含链接、未知成员、跨设备或不支持的类型。");
    if (kind === "directory") {
      if (process.platform !== "win32" && (stat.mode & 0o300) !== 0o300)
        throw new Error(
          "目录缺少所有者写入或执行权限；为确保可恢复，整组保持保护。",
        );
      await fs.access(p, constants.W_OK | constants.X_OK);
    }
    nodes.push({ path: relative, kind, fingerprint: unitFingerprint(stat) });
    if (kind === "directory") {
      for await (const child of await fs.opendir(p))
        await visit(relative + "/" + child.name, depth + 1);
      if (
        !identical(unitFingerprint(await unitLstat(p)), unitFingerprint(stat))
      )
        throw new Error("目录自扫描后发生变化。");
    }
  };
  for (const member of definition.members) {
    await unitPlainParents(full(root, member.path));
    if (!(await unitExists(full(root, member.path)))) {
      if (!member.optional) throw new Error("清理单元缺少必要成员。");
      absent.push(member.path);
    } else await visit(member.path, 0, member.kind);
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  if (
    adapter.unitLayoutAllowed &&
    !adapter.unitLayoutAllowed(definition, nodes)
  )
    throw new Error("清理单元目录布局无法验证。");
  return {
    definition,
    nodes,
    parents,
    absent,
    size: nodes
      .filter((n) => n.kind === "file")
      .reduce((sum, n) => sum + n.fingerprint.size, 0),
    fileCount: nodes.filter((n) => n.kind === "file").length,
    directoryCount: nodes.filter((n) => n.kind === "directory").length,
    mtimeMs: Math.max(...nodes.map((n) => n.fingerprint.mtimeMs)),
  };
}
export function sameUnit(a: UnitSnapshot, b: UnitSnapshot) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function unitMetadata(snapshot: UnitSnapshot) {
  return {
    kind: snapshot.definition.kind,
    members: snapshot.definition.members
      .filter((m) => !snapshot.absent.includes(m.path))
      .map((m) => m.path),
    fileCount: snapshot.fileCount,
    directoryCount: snapshot.directoryCount,
  };
}
export function unitStoragePath(dir: string, id: string, index?: number) {
  return path.join(
    dir,
    id + ".unit",
    ...(index === undefined ? [] : [String(index)]),
  );
}
async function verifyUnitParents(root: string, snapshot: UnitSnapshot) {
  if (
    !Array.isArray(snapshot.parents) ||
    !snapshot.parents.some((p) => p.path === "")
  )
    throw new Error("清理单元缺少根目录身份。");
  for (const parent of snapshot.parents) {
    if (parent.path !== "" && !validRelative(parent.path))
      throw new Error("单元父目录非法。");
    const p = parent.path ? full(root, parent.path) : root;
    await unitPlainParents(p, true);
    const stat = await unitLstat(p);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameFileId(stat.dev, parent.dev) ||
      !sameFileId(stat.ino, parent.ino)
    )
      throw new Error("清理单元父目录已被替换。");
  }
}
async function verifyContainer(dir: string, id: string, record: UnitRecord) {
  const p = unitStoragePath(dir, id);
  await unitPlainParents(p, true);
  const stat = await unitLstat(p);
  if (
    !record.container ||
    !sameFileId(stat.dev, record.container.dev) ||
    !sameFileId(stat.ino, record.container.ino)
  )
    throw new Error("隔离单元容器身份已变化。");
}
function memberNodes(snapshot: UnitSnapshot, member: string) {
  return snapshot.nodes.filter(
    (n) => n.path === member || n.path.startsWith(member + "/"),
  );
}
function relativeMember(member: string, node: string) {
  return node === member ? "" : node.slice(member.length + 1);
}
/** Inspect a moved tree without reading payloads. Roots may have rename-updated ctime. */
async function verifyTree(
  base: string,
  nodes: UnitNode[],
  member: string,
  afterMove: boolean,
): Promise<UnitNode[]> {
  const found: UnitNode[] = [];
  const expected = new Map(
    nodes.map((n) => [relativeMember(member, n.path), n]),
  );
  const walk = async (p: string, relative: string) => {
    if (found.length >= UNIT_MAX_NODES)
      throw new Error("隔离单元超出安全界限。");
    const node = expected.get(relative);
    if (!node) throw new Error("隔离单元含未知成员。");
    await unitPlainParents(p);
    const stat = await unitLstat(p),
      actual = unitFingerprint(stat);
    if (
      stat.isSymbolicLink() ||
      (node.kind === "file"
        ? !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory()) ||
      !(afterMove && relative === ""
        ? identity(actual, node.fingerprint)
        : identical(actual, node.fingerprint))
    )
      throw new Error("清理单元自扫描后发生变化。");
    found.push({ ...node, fingerprint: actual });
    if (node.kind === "directory")
      for await (const child of await fs.opendir(p))
        await walk(
          path.join(p, child.name),
          relative ? relative + "/" + child.name : child.name,
        );
  };
  await walk(base, "");
  if (found.length !== nodes.length) throw new Error("清理单元成员缺失。");
  return found;
}
export async function inspectUnitLocations(
  root: string,
  dir: string,
  id: string,
  record: UnitRecord,
) {
  const wrapper = unitStoragePath(dir, id);
  await verifyUnitParents(root, record.snapshot);
  await verifyContainer(dir, id, record);
  const names = new Set(await fs.readdir(wrapper));
  const expected = record.snapshot.definition.members.map((_, index) =>
    String(index),
  );
  if ([...names].some((name) => !expected.includes(name)))
    throw new Error("隔离单元含未知伴随文件。");
  const stored: UnitNode[] = [];
  let count = 0;
  for (const [index, member] of record.snapshot.definition.members.entries()) {
    const nodes = memberNodes(record.snapshot, member.path);
    const source = full(root, member.path),
      target = unitStoragePath(dir, id, index);
    await unitPlainParents(source);
    const atSource = await unitExists(source),
      atTarget = await unitExists(target);
    if (!nodes.length) {
      if (atSource || atTarget) throw new Error("可选伴随成员在预览后出现。");
    } else if (atTarget) {
      if (atSource) throw new Error("原路径已存在；不会覆盖。");
      const prior = record.stored
        ? memberNodes(record.stored, member.path)
        : nodes;
      stored.push(
        ...(await verifyTree(target, prior, member.path, !record.stored)),
      );
      count++;
    } else {
      if (!atSource) throw new Error("清理单元成员位置不确定。");
      await verifyTree(source, nodes, member.path, false);
    }
  }
  return {
    stored,
    count,
    complete:
      count ===
      record.snapshot.definition.members.length - record.snapshot.absent.length,
  };
}
/** Disposal validates only retained payloads; a rebuilt original path is unrelated. */
export async function inspectStoredUnit(
  dir: string,
  id: string,
  record: UnitRecord,
) {
  await verifyContainer(dir, id, record);
  if (!record.stored || record.restore)
    throw new Error("整组隔离或恢复尚未完成。");
  const names = (await fs.readdir(unitStoragePath(dir, id))).sort();
  const expected = record.snapshot.definition.members
    .flatMap((member, index) =>
      record.snapshot.absent.includes(member.path) ? [] : [String(index)],
    )
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("隔离单元成员缺失或包含未知文件。");
  for (const [index, member] of record.snapshot.definition.members.entries()) {
    if (record.snapshot.absent.includes(member.path)) continue;
    await verifyTree(
      unitStoragePath(dir, id, index),
      memberNodes(record.stored, member.path),
      member.path,
      false,
    );
  }
}
export async function verifyEmptyUnitContainer(
  dir: string,
  id: string,
  record: UnitRecord,
) {
  await verifyContainer(dir, id, record);
  if ((await fs.readdir(unitStoragePath(dir, id))).length)
    throw new Error("已恢复单元仍有未知保留内容；拒绝整批处置。");
}
/** Only already-created, authenticated restore targets can explain self-induced activity. */
export async function ownedRestorePaths(
  root: string,
  dir: string,
  id: string,
  record: UnitRecord,
): Promise<Set<string>> {
  const owned = new Set<string>(),
    state = record.restore;
  if (!state) return owned;
  await verifyUnitParents(root, record.snapshot);
  await verifyContainer(dir, id, record);
  let count = 0;
  const visit = async (relative: string): Promise<void> => {
    if (++count > UNIT_MAX_NODES) throw new Error("恢复目标超出安全界限。");
    const node = record.snapshot.nodes.find((n) => n.path === relative);
    if (!node) throw new Error("恢复目标含未知成员，不能解除活动保护。");
    const p = full(root, relative);
    await unitPlainParents(p);
    const stat = await unitLstat(p);
    if (node.kind === "directory") {
      const created = state.directories.find((d) => d.path === relative);
      if (
        !created ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !sameFileId(stat.dev, created.dev) ||
        !sameFileId(stat.ino, created.ino)
      )
        throw new Error("恢复目标目录不是已签名的自有目录。");
      owned.add(relative);
      for await (const child of await fs.opendir(p))
        await visit(relative + "/" + child.name);
    } else {
      const linked = state.linked?.find((l) => l.path === relative);
      if (
        !linked ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        !identity(unitFingerprint(stat), node.fingerprint) ||
        (stat.nlink !== 1 && stat.nlink !== 2) ||
        (stat.nlink === 2 &&
          !identical(unitFingerprint(stat), linked.fingerprint))
      )
        throw new Error("恢复目标文件不是已签名的自有恢复链接。");
      owned.add(relative);
    }
  };
  for (const member of record.snapshot.definition.members) {
    if (
      !state.directories.some((d) => d.path === member.path) &&
      !state.linked?.some((l) => l.path === member.path)
    )
      continue;
    if (await unitExists(full(root, member.path))) await visit(member.path);
  }
  return owned;
}
export async function moveUnit(
  root: string,
  dir: string,
  id: string,
  record: UnitRecord,
  checkpoint: () => Promise<void>,
  guard: () => Promise<void> = async () => {},
  fence: () => void = () => {},
) {
  const wrapper = unitStoragePath(dir, id);
  await guard();
  await verifyUnitParents(root, record.snapshot);
  fence();
  await fs.mkdir(wrapper, { mode: 0o700 });
  const container = await unitLstat(wrapper);
  record.container = { dev: container.dev, ino: container.ino };
  await unitSyncDirectory(dir);
  await checkpoint();
  for (const [index, member] of record.snapshot.definition.members.entries()) {
    await guard();
    if (record.snapshot.absent.includes(member.path)) continue;
    const source = full(root, member.path),
      target = unitStoragePath(dir, id, index);
    await verifyUnitParents(root, record.snapshot);
    await verifyContainer(dir, id, record);
    await unitPlainParents(source);
    await unitPlainParents(target);
    await verifyTree(
      source,
      memberNodes(record.snapshot, member.path),
      member.path,
      false,
    );
    if (await unitExists(target)) throw new Error("隔离目标已存在。");
    fence();
    await fs.rename(source, target);
    await unitSyncDirectory(wrapper);
    await unitSyncDirectory(path.dirname(source));
    await verifyTree(
      target,
      memberNodes(record.snapshot, member.path),
      member.path,
      true,
    );
  }
  const result = await inspectUnitLocations(root, dir, id, record);
  record.stored = {
    ...record.snapshot,
    nodes: result.stored.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await checkpoint();
}
/** Reconstruct using exclusive mkdir/link. No portable rename can provide directory NOREPLACE. */
export async function restoreUnit(
  root: string,
  dir: string,
  id: string,
  record: UnitRecord,
  checkpoint: () => Promise<void>,
  guard: () => Promise<void> = async () => {},
  fence: () => void = () => {},
) {
  await guard();
  await verifyUnitParents(root, record.snapshot);
  await verifyContainer(dir, id, record);
  if (!record.restore) {
    // Preflight every bundle destination before restoring any member.
    const locations = await inspectUnitLocations(root, dir, id, record);
    const moved = new Map(locations.stored.map((n) => [n.path, n]));
    record.stored = {
      ...record.snapshot,
      nodes: record.snapshot.nodes.map((n) => moved.get(n.path) ?? n),
    };
    record.restore = { directories: [], completedMembers: [] };
    await checkpoint();
  }
  const state = record.restore;
  const snapshot = record.stored ?? record.snapshot;
  const verifyRestoreParents = async (relative: string) => {
    await verifyUnitParents(root, record.snapshot);
    await verifyContainer(dir, id, record);
    for (const created of state.directories.filter(
      (d) => relative === d.path || relative.startsWith(d.path + "/"),
    )) {
      const p = full(root, created.path);
      await unitPlainParents(p, true);
      const stat = await unitLstat(p);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !sameFileId(stat.dev, created.dev) ||
        !sameFileId(stat.ino, created.ino)
      )
        throw new Error("恢复目标父目录被替换；源数据仍保留。");
    }
  };
  const verifyStoredParents = async (
    index: number,
    member: string,
    relative: string,
  ) => {
    await verifyContainer(dir, id, record);
    for (const node of memberNodes(snapshot, member)
      .filter(
        (n) =>
          n.kind === "directory" &&
          (relative === n.path || relative.startsWith(n.path + "/")),
      )
      .sort((a, b) => a.path.length - b.path.length)) {
      const p = path.join(
        unitStoragePath(dir, id, index),
        relativeMember(member, node.path),
      );
      const stat = await unitExists(p);
      // Missing source directories are expected after a durable link checkpoint and cleanup.
      if (!stat) return;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !sameFileId(stat.dev, node.fingerprint.dev) ||
        !sameFileId(stat.ino, node.fingerprint.ino)
      )
        throw new Error("隔离源父目录被替换；数据未删除。");
    }
  };
  // Reverse order restores a transcript/index anchor only after its companion payloads.
  for (const [index, member] of [
    ...record.snapshot.definition.members.entries(),
  ].reverse()) {
    await guard();
    if (
      record.snapshot.absent.includes(member.path) ||
      state.completedMembers.includes(member.path)
    )
      continue;
    const base = unitStoragePath(dir, id, index),
      target = full(root, member.path);
    const nodes = memberNodes(snapshot, member.path);
    const sourceExists = await unitExists(base);
    if (
      !sourceExists &&
      !state.directories.some((d) => d.path === member.path) &&
      !(await unitExists(target))
    )
      throw new Error("恢复源不存在。");
    // A file not moved by an interrupted bundle is still the exact original.
    if (
      !sourceExists &&
      member.kind === "file" &&
      !state.linked?.some((link) => link.path === member.path)
    ) {
      await verifyTree(
        target,
        memberNodes(record.snapshot, member.path),
        member.path,
        false,
      );
      state.completedMembers.push(member.path);
      await checkpoint();
      continue;
    }
    // A partial quarantine left this member in place; never remove or rewrite it.
    if (
      !sourceExists &&
      !state.directories.some((d) => d.path === member.path) &&
      member.kind === "directory"
    ) {
      await verifyTree(
        target,
        memberNodes(record.snapshot, member.path),
        member.path,
        false,
      );
      state.completedMembers.push(member.path);
      await checkpoint();
      continue;
    }
    for (const node of nodes
      .filter((n) => n.kind === "directory")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
      const p = full(root, node.path);
      await unitPlainParents(p);
      let created = state.directories.find((d) => d.path === node.path);
      if (!created) {
        try {
          fence();
          await fs.mkdir(p, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error("原路径已存在目录；不会覆盖。");
          throw error;
        }
        await unitSyncDirectory(path.dirname(p));
        const stat = await unitLstat(p);
        created = { path: node.path, dev: stat.dev, ino: stat.ino };
        state.directories.push(created);
        await checkpoint(); // A crash before this checkpoint leaves an explicit conflict, never adopts an unowned dir.
      }
      const stat = await unitLstat(p);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !sameFileId(stat.dev, created.dev) ||
        !sameFileId(stat.ino, created.ino)
      )
        throw new Error("恢复目标目录被替换；不会覆盖。");
    }
    await guard();
    for (const node of nodes.filter((n) => n.kind === "file")) {
      const source = path.join(base, relativeMember(member.path, node.path)),
        dest = full(root, node.path);
      await verifyRestoreParents(node.path);
      await verifyStoredParents(index, member.path, node.path);
      await unitPlainParents(dest);
      const a = await unitExists(source),
        b = await unitExists(dest);
      const matches = (stat: UnitStat | null) =>
        !!stat &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        identity(unitFingerprint(stat), node.fingerprint);
      if (!a) {
        if (!matches(b) || b!.nlink !== 1)
          throw new Error("已恢复文件标识不一致。");
      } else {
        if (!matches(a) || (a.nlink !== 1 && a.nlink !== 2))
          throw new Error("隔离文件已变化；拒绝恢复。");
        if (b) {
          const linked = state.linked?.find(
            (saved) => saved.path === node.path,
          );
          if (
            !matches(b) ||
            a.nlink !== 2 ||
            b.nlink !== 2 ||
            !linked ||
            !identical(unitFingerprint(a), linked.fingerprint)
          )
            throw new Error(
              "原路径存在未经签名确认或已变化的恢复链接；不会覆盖。",
            );
        } else {
          if (a.nlink !== 1 || !identical(unitFingerprint(a), node.fingerprint))
            throw new Error("隔离文件已变化或出现额外硬链接。");
          fence();
          await fs.link(source, dest);
          await verifyRestoreParents(node.path);
          state.linked ??= [];
          state.linked.push({
            path: node.path,
            fingerprint: unitFingerprint(await unitLstat(source)),
          });
        }
      }
    }
    // Commit link identities before source links are removed. An interruption before this
    // checkpoint preserves both links and fails closed instead of adopting an unowned link.
    for (const node of nodes.filter((n) => n.kind === "file")) {
      const source = path.join(base, relativeMember(member.path, node.path));
      await verifyStoredParents(index, member.path, node.path);
      const stat = await unitExists(source),
        linked = state.linked?.find((saved) => saved.path === node.path);
      if (
        stat &&
        (!linked || !identical(unitFingerprint(stat), linked.fingerprint))
      )
        throw new Error("恢复链接自建立后发生变化。");
      await unitSyncDirectory(path.dirname(full(root, node.path)));
    }
    await checkpoint();
    // Exact target names before unlinking any preserved source. Unknown files fail closed.
    for (const node of nodes.filter((n) => n.kind === "directory")) {
      const expected = nodes
        .filter((child) => path.posix.dirname(child.path) === node.path)
        .map((child) => path.posix.basename(child.path))
        .sort();
      await verifyRestoreParents(node.path);
      const actual = (await fs.readdir(full(root, node.path))).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error("恢复目标包含未知成员；源数据仍保留。");
    }
    await guard();
    for (const node of nodes.filter((n) => n.kind === "file")) {
      const source = path.join(base, relativeMember(member.path, node.path)),
        dest = full(root, node.path);
      await verifyRestoreParents(node.path);
      await verifyStoredParents(index, member.path, node.path);
      await unitPlainParents(dest);
      const a = await unitExists(source),
        b = await unitLstat(dest);
      if (
        !b.isFile() ||
        !identity(unitFingerprint(b), node.fingerprint) ||
        (a
          ? b.nlink !== 2 || !identity(unitFingerprint(a), node.fingerprint)
          : b.nlink !== 1)
      )
        throw new Error("恢复链接状态发生变化；源数据仍保留。");
      await verifyRestoreParents(node.path);
      await verifyStoredParents(index, member.path, node.path);
      if (a) {
        fence();
        await fs.unlink(source);
        await unitSyncDirectory(path.dirname(source));
      }
    }
    for (const node of nodes
      .filter((n) => n.kind === "directory")
      .sort((a, b) => b.path.length - a.path.length)) {
      const source = path.join(base, relativeMember(member.path, node.path));
      await verifyRestoreParents(node.path);
      await verifyStoredParents(index, member.path, node.path);
      const sourceStat = await unitExists(source);
      if (sourceStat) {
        await unitPlainParents(source);
        if (
          !sourceStat.isDirectory() ||
          sourceStat.isSymbolicLink() ||
          !sameFileId(sourceStat.dev, node.fingerprint.dev) ||
          !sameFileId(sourceStat.ino, node.fingerprint.ino)
        )
          throw new Error("隔离目录标识已变化。");
        fence();
        await fs.rmdir(source);
        await unitSyncDirectory(path.dirname(source));
      }
      const dest = full(root, node.path);
      // Preserve directory permissions and modification time after exact reconstruction.
      const created = state.directories.find((d) => d.path === node.path),
        destStat = await unitLstat(dest);
      if (
        !created ||
        !destStat.isDirectory() ||
        destStat.isSymbolicLink() ||
        !sameFileId(destStat.dev, created.dev) ||
        !sameFileId(destStat.ino, created.ino)
      )
        throw new Error("恢复目录标识已变化。");
      fence();
      await fs.chmod(dest, node.fingerprint.mode & 0o777);
      fence();
      await fs.utimes(
        dest,
        new Date(node.fingerprint.mtimeMs),
        new Date(node.fingerprint.mtimeMs),
      );
      await unitSyncDirectory(dest);
    }
    state.completedMembers.push(member.path);
    await checkpoint();
  }
}
