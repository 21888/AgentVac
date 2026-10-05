import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import {
  assertUnitPolicy,
  assertUnitRecord,
  captureUnit,
  inspectStoredUnit,
  moveUnit,
  unitFingerprint,
  type CleanupUnitDefinition,
  type UnitRecord,
} from "../electron/cleanup-units.js";
import { codexAdapter } from "../electron/providers/codex.js";
import type { ProviderAdapter } from "../electron/providers/types.js";

const definition: CleanupUnitDefinition = {
  policy: "windows-exact-identity-fixture-v1",
  kind: "directory",
  members: [{ path: "cache-unit", kind: "directory" }],
};
const provider: ProviderAdapter = {
  ...codexAdapter,
  id: "cursor",
  classify(relative) {
    return relative === "cache-unit"
      ? { category: "cache", risk: "review", reason: "Synthetic complete unit" }
      : codexAdapter.classify(relative);
  },
  async cleanupUnit(relative) {
    return relative === "cache-unit" ? definition : null;
  },
  unitEntryAllowed(_policy, relative, kind) {
    return kind === "directory"
      ? ["cache-unit", "cache-unit/nested"].includes(relative)
      : ["cache-unit/a.bin", "cache-unit/nested/b.bin"].includes(relative);
  },
};
const clear = async () => ({
  status: "clear" as const,
  details: "Synthetic closed process",
});

async function fixture(t: TestContext, largeIds = true) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-win-unit-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "cache-unit/nested"), { recursive: true });
  await fs.writeFile(path.join(root, "cache-unit/a.bin"), "first payload");
  await fs.writeFile(
    path.join(root, "cache-unit/nested/b.bin"),
    "second payload",
  );
  const old = new Date(Date.now() - 90 * 86400000);
  for (const relative of [
    "cache-unit/a.bin",
    "cache-unit/nested/b.bin",
    "cache-unit/nested",
    "cache-unit",
  ])
    await fs.utimes(path.join(root, relative), old, old);

  // Emulate NTFS IDs on every host without changing filesystem operations. IDs are
  // tied to the actual inode, so renames and owned hardlinks keep exact identity.
  const lstat = fs.lstat;
  const ids = new Map<string, bigint>();
  const overrides = new Map<string, bigint>();
  const observed = new Map<string, bigint>();
  let next = largeIds ? 1n << 54n : 100n;
  t.mock.method(fs, "lstat", async (file: PathLike, options?: any) => {
    const stat = await (lstat as any)(file, options);
    const location = String(file);
    if (location !== root && !location.startsWith(root + path.sep)) return stat;
    const original = `${stat.dev}:${stat.ino}`;
    if (!ids.has(original)) {
      ids.set(original, next);
      next += 4n; // adjacent +1 IDs deliberately collide when represented as Number.
    }
    const ino = overrides.get(location) ?? ids.get(original)!;
    observed.set(location, ino);
    const dev = largeIds ? (1n << 54n) + 100n : 1n;
    stat.ino = options?.bigint ? ino : Number(ino);
    stat.dev = options?.bigint ? dev : Number(dev);
    return stat;
  });
  const key = randomBytes(32);
  const engine = () => new AgentVacEngine(root, key, true, clear, [], provider);
  const quarantine = async () => {
    const active = engine();
    const scan = await active.scan({ minAgeDays: 30, includeSessions: false });
    const entry = scan.entries.find((item) => item.path === "cache-unit")!;
    assert.ok(entry?.selectable, JSON.stringify(entry));
    const result = await active.quarantine(
      (await active.preview([entry.id])).token,
      true,
    );
    assert.equal(result.completed, 1, JSON.stringify(result.failed));
    const manifest = path.join(
      root,
      ".agentvac-quarantine",
      result.batchId,
      "manifest.json",
    );
    const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
    const wrapper = path.join(
      path.dirname(manifest),
      saved.journal.items[0].id + ".unit",
    );
    return { active, result, manifest, saved, wrapper };
  };
  const replaceIdentity = (location: string) => {
    const before = observed.get(location)!;
    assert.ok(before);
    assert.equal(Number(before), Number(before + 1n));
    overrides.set(location, before + 1n);
  };
  return { root, key, engine, quarantine, overrides, replaceIdentity };
}

function legacyNumbers(value: any): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "dev" || key === "ino") {
      assert.ok(Number.isSafeInteger(Number(child)));
      value[key] = Number(child);
    } else legacyNumbers(child);
  }
}
async function saveSigned(manifest: string, saved: any, key: Buffer) {
  saved.signature = createHmac("sha256", key)
    .update(JSON.stringify(saved.journal))
    .digest("hex");
  await fs.writeFile(manifest, JSON.stringify(saved));
}

test("large Windows unit IDs survive signed quarantine, restart, interrupted restore and resume", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const record = q.saved.journal.items[0].unit as UnitRecord;
  assert.equal(q.saved.journal.version, 3);
  for (const node of record.snapshot.nodes) {
    assert.equal(typeof node.fingerprint.ino, "string");
    assert.ok(BigInt(node.fingerprint.ino) > BigInt(Number.MAX_SAFE_INTEGER));
  }
  assert.equal(typeof record.snapshot.parents[0].ino, "string");
  assert.equal(typeof record.container!.ino, "string");
  const unlink = fs.unlink;
  let interrupted = false;
  const mock = t.mock.method(fs, "unlink", async (file: PathLike) => {
    if (!interrupted && String(file) === path.join(q.wrapper, "0/a.bin")) {
      interrupted = true;
      throw new Error("Synthetic interrupted unlink");
    }
    return unlink(file);
  });
  assert.equal((await f.engine().restore(q.result.batchId, true)).completed, 0);
  mock.mock.restore();
  assert.equal(interrupted, true);
  const resumed = await f.engine().restore(q.result.batchId, true);
  assert.equal(resumed.completed, 1, JSON.stringify(resumed.failed));
  assert.equal(
    await fs.readFile(path.join(f.root, "cache-unit/a.bin"), "utf8"),
    "first payload",
  );
  assert.equal(
    (await fs.lstat(path.join(f.root, "cache-unit/a.bin"))).nlink,
    1,
  );
});

test("safe legacy numeric signed unit identities remain recoverable", async (t) => {
  const f = await fixture(t, false);
  const q = await f.quarantine();
  legacyNumbers(q.saved.journal.items[0].unit);
  await saveSigned(q.manifest, q.saved, f.key);
  const resumed = await f.engine().restore(q.result.batchId, true);
  assert.equal(resumed.completed, 1, JSON.stringify(resumed.failed));
  assert.equal(
    await fs.readFile(path.join(f.root, "cache-unit/nested/b.bin"), "utf8"),
    "second payload",
  );
});

test("unsafe legacy numeric signed unit identity fails closed without rewriting the journal", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  q.saved.journal.items[0].unit.snapshot.nodes[0].fingerprint.ino = Number(
    1n << 54n,
  );
  await saveSigned(q.manifest, q.saved, f.key);
  const before = await fs.readFile(q.manifest);
  await assert.rejects(
    f.engine().restore(q.result.batchId, true),
    /未知|不安全/,
  );
  assert.deepEqual(await fs.readFile(q.manifest), before);
  assert.equal(
    await fs.readFile(path.join(q.wrapper, "0/a.bin"), "utf8"),
    "first payload",
  );
});

test("adjacent large parent and source IDs cannot alias during unit quarantine", async (t) => {
  for (const target of ["parent", "source"] as const) {
    await t.test(target, async (t) => {
      const f = await fixture(t);
      const snapshot = await captureUnit(f.root, definition, provider);
      const dir = path.join(f.root, "quarantine");
      await fs.mkdir(dir);
      f.replaceIdentity(
        target === "parent" ? f.root : path.join(f.root, "cache-unit/a.bin"),
      );
      await assert.rejects(
        moveUnit(f.root, dir, "synthetic", { snapshot }, async () => {}),
        /替换|变化/,
      );
      assert.equal(
        await fs.readFile(path.join(f.root, "cache-unit/a.bin"), "utf8"),
        "first payload",
      );
    });
  }
});

test("adjacent large quarantine-container IDs cannot alias during stored verification", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  f.replaceIdentity(q.wrapper);
  await assert.rejects(
    inspectStoredUnit(
      path.dirname(q.wrapper),
      q.saved.journal.items[0].id,
      q.saved.journal.items[0].unit,
    ),
    /身份已变化/,
  );
  assert.equal(
    await fs.readFile(path.join(q.wrapper, "0/a.bin"), "utf8"),
    "first payload",
  );
});

test("adjacent large owned-restore directory IDs cannot authorize deletion of retained payloads", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const unlink = fs.unlink;
  const mock = t.mock.method(fs, "unlink", async (file: PathLike) => {
    if (String(file) === path.join(q.wrapper, "0/a.bin"))
      throw new Error("Synthetic interrupted unlink");
    return unlink(file);
  });
  assert.equal((await q.active.restore(q.result.batchId, true)).completed, 0);
  mock.mock.restore();
  f.replaceIdentity(path.join(f.root, "cache-unit"));
  const refused = await f.engine().restore(q.result.batchId, true);
  assert.equal(refused.completed, 0);
  assert.equal(refused.failed.length, 1);
  assert.match(JSON.stringify(refused.failed), /自有目录|替换/);
  assert.equal(
    await fs.readFile(path.join(q.wrapper, "0/a.bin"), "utf8"),
    "first payload",
  );
});

test("unit identity validation rejects noncanonical, missing, zero and rounded inode evidence", async (t) => {
  const f = await fixture(t);
  const original = await captureUnit(f.root, definition, provider);
  for (const invalid of [
    undefined,
    null,
    0,
    "0",
    -1,
    1.5,
    Number(1n << 54n),
    "01",
    "+1",
    "1e3",
    " 1",
    "18446744073709551616",
  ]) {
    for (const target of ["node", "parent", "container", "restore"] as const) {
      const record: UnitRecord = { snapshot: structuredClone(original) };
      if (target === "node")
        record.snapshot.nodes[0].fingerprint.ino = invalid as any;
      if (target === "parent") record.snapshot.parents[0].ino = invalid as any;
      if (target === "container" || target === "restore")
        record.container = {
          dev: original.parents[0].dev,
          ino: target === "container" ? (invalid as any) : "12345",
        };
      if (target === "restore")
        record.restore = {
          directories: [
            {
              path: "cache-unit",
              dev: original.parents[0].dev,
              ino: invalid as any,
            },
          ],
          completedMembers: [],
        };
      await assert.rejects(
        assertUnitRecord(f.root, record, provider),
        /未知|不安全|身份/,
        `${target}: ${invalid}`,
      );
    }
  }
  const extra = structuredClone(original);
  (extra.nodes[0].fingerprint as any).extra = true;
  await assert.rejects(
    assertUnitPolicy(f.root, extra, provider),
    /未知|不安全/,
  );
  const stat = await fs.lstat(path.join(f.root, "cache-unit/a.bin"));
  assert.throws(() => unitFingerprint(stat), /身份不可用/);
  f.overrides.set(path.join(f.root, "cache-unit/a.bin"), 0n);
  await assert.rejects(captureUnit(f.root, definition, provider), /身份不可用/);
});

test("single-sample bigint fingerprints preserve numeric Stats timestamps for legacy recovery", async (t) => {
  const f = await fixture(t, false);
  const file = path.join(f.root, "cache-unit/a.bin");
  const numeric = unitFingerprint(await fs.lstat(file));
  const exact = unitFingerprint(await fs.lstat(file, { bigint: true }));
  assert.deepEqual(exact, numeric);
});

test("nonjournaled ancestor IDs do not replace type checks or signed-root identity validation", async (t) => {
  const f = await fixture(t);
  const ancestor = path.dirname(f.root);
  const lstat = fs.lstat;
  let linkedAncestor = false;
  t.mock.method(fs, "lstat", async (file: PathLike, options?: any) => {
    const stat = await (lstat as any)(file, options);
    if (String(file) === ancestor) {
      // Some overlay mounts expose signed-negative inode metadata. This ancestor
      // is checked for links/types only and is not part of the signed unit.
      stat.ino = options?.bigint
        ? -9223372036854775296n
        : Number(-9223372036854775296n);
      stat.isSymbolicLink = () => linkedAncestor;
    }
    return stat;
  });
  const snapshot = await captureUnit(f.root, definition, provider);
  await assertUnitPolicy(f.root, snapshot, provider);
  assert.deepEqual(
    snapshot.parents.map((parent) => parent.path),
    [""],
  );
  assert.ok(BigInt(snapshot.parents[0].ino) > 0n);
  linkedAncestor = true;
  await assert.rejects(
    captureUnit(f.root, definition, provider),
    /链接|非目录/,
  );
  linkedAncestor = false;
  f.overrides.set(f.root, -9223372036854775296n);
  await assert.rejects(captureUnit(f.root, definition, provider), /身份不可用/);
});
