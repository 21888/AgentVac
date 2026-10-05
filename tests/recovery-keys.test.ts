import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  RecoveryKeyring,
  recoveryKeyId,
  MAX_RECOVERY_KEYS,
} from "../electron/recovery-keys.js";
import { loadKey } from "../electron/engine.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-recovery-keys-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  await fs.mkdir(profile);
  const recovery = path.join(profile, "recovery");
  return {
    base,
    profile,
    recovery,
    primary: path.join(recovery, "journal-signing.key"),
    metadata: path.join(recovery, "trusted-recovery-keys.json"),
    ring: new RecoveryKeyring(recovery),
  };
}
function bundle(keys: Buffer[]) {
  return {
    format: "agentvac-recovery-keys",
    version: 1,
    keys: keys.map((key) => ({
      id: recoveryKeyId(key),
      keyBase64: key.toString("base64"),
    })),
  };
}
async function incoming(base: string, keys: Buffer[], name = "incoming.json") {
  const file = path.join(base, name);
  await fs.writeFile(file, JSON.stringify(bundle(keys)));
  return file;
}
async function symlink(
  t: TestContext,
  target: string,
  dest: string,
  type?: "dir",
) {
  try {
    await fs.symlink(target, dest, type);
    return true;
  } catch (e) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Symlink privileges unavailable");
      return false;
    }
    throw e;
  }
}

test("primary key is compatible with legacy loadKey and descriptions never contain secrets", async (t) => {
  const { ring, recovery, primary, metadata } = await fixture(t);
  const existing = await loadKey(recovery);
  const view = await ring.load();
  assert.equal(view.primaryId, recoveryKeyId(existing));
  assert.equal(view.canSign, true);
  assert.deepEqual(view.issues, []);
  assert.deepEqual(ring.primaryKey(), existing);
  assert.deepEqual(await fs.readFile(primary), existing);
  assert.equal(
    JSON.stringify(view).includes(existing.toString("base64")),
    false,
  );
  assert.equal(
    (await fs.readFile(metadata, "utf8")).includes(existing.toString("base64")),
    false,
  );
  const copy = ring.primaryKey()!;
  copy.fill(0);
  assert.deepEqual(ring.primaryKey(), existing);
  const trusted = ring.trustedKeys();
  trusted[0].fill(0);
  assert.deepEqual(ring.trustedKeys()[0], existing);
});

test("fresh profile creates private primary and durable public identity evidence", async (t) => {
  const { ring, recovery, primary, metadata } = await fixture(t);
  const view = await ring.load();
  assert.equal(view.canSign, true);
  assert.equal(view.trustedKeyIds.length, 1);
  assert.equal((await fs.readFile(primary)).length, 32);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(recovery)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(primary)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(metadata)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await new RecoveryKeyring(recovery).load(), view);
});

test("export is new-file-only, restrictive, versioned, and import merges without replacing primary", async (t) => {
  const { ring, recovery, base, primary } = await fixture(t);
  await ring.load();
  const original = await fs.readFile(primary);
  const extra = randomBytes(32);
  const imported = await ring.importFile(await incoming(base, [extra]));
  assert.deepEqual(imported.addedKeyIds, [recoveryKeyId(extra)]);
  assert.deepEqual(await fs.readFile(primary), original);
  const exported = path.join(base, "backup.json");
  const result = await ring.exportFile(exported);
  assert.equal(result.version, 1);
  assert.equal(result.keyIds.length, 2);
  assert.equal(
    JSON.stringify(result).includes(extra.toString("base64")),
    false,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(exported, "utf8")),
    bundle([original, extra]),
  );
  if (process.platform !== "win32")
    assert.equal((await fs.stat(exported)).mode & 0o777, 0o600);
  const bytes = await fs.readFile(exported);
  await assert.rejects(ring.exportFile(exported));
  assert.deepEqual(await fs.readFile(exported), bytes);
  const restarted = new RecoveryKeyring(recovery);
  await restarted.load();
  assert.equal(restarted.trustedKeys().length, 2);
  const duplicate = await restarted.importFile(exported);
  assert.deepEqual(duplicate.addedKeyIds, []);
  assert.equal(duplicate.duplicateKeyIds.length, 2);
  const again = await restarted.importFile(exported);
  assert.deepEqual(again.addedKeyIds, []);
  assert.deepEqual(await fs.readFile(primary), original);
});

test("missing and changed prior primary are distinguished from damaged batch data", async (t) => {
  const { ring, recovery, primary, base } = await fixture(t);
  await ring.load();
  const original = ring.primaryKey()!;
  const oldId = recoveryKeyId(original);
  await fs.unlink(primary);
  const missing = new RecoveryKeyring(recovery);
  const missingView = await missing.load();
  assert.equal(missingView.canSign, true);
  assert.notEqual(missingView.primaryId, oldId);
  assert.equal(missingView.expectedPrimaryId, oldId);
  assert.ok(missingView.issues.some((i) => i.code === "prior-primary-missing"));
  assert.equal(missingView.trustedKeyIds.includes(oldId), false);
  const newPrimary = await fs.readFile(primary);
  const recovered = await missing.importFile(await incoming(base, [original]));
  assert.equal(recovered.keyring.trustedKeyIds.includes(oldId), true);
  assert.deepEqual(await fs.readFile(primary), newPrimary);
  const restart = await new RecoveryKeyring(recovery).load();
  assert.ok(restart.issues.some((i) => i.code === "prior-primary-changed"));
  assert.equal(restart.trustedKeyIds.includes(oldId), true);
});

test("invalid primary stays untouched while authentic imported keys remain usable for recovery", async (t) => {
  const { ring, recovery, primary, base } = await fixture(t);
  await ring.load();
  const old = ring.primaryKey()!;
  await ring.importFile(await incoming(base, [old]));
  await fs.writeFile(primary, "invalid");
  const next = new RecoveryKeyring(recovery);
  const state = await next.load();
  assert.equal(state.canSign, false);
  assert.equal(next.primaryKey(), undefined);
  assert.equal(next.trustedKeys().length, 1);
  assert.ok(state.issues.some((i) => i.code === "primary-unavailable"));
  assert.equal(await fs.readFile(primary, "utf8"), "invalid");
  await next.exportFile(path.join(base, "still-recoverable.json"));
});

test("strict bundle validation and deliberately opted-in legacy import never leak bytes", async (t) => {
  const { ring, base, metadata } = await fixture(t);
  await ring.load();
  const key = randomBytes(32),
    good = bundle([key]);
  const cases: unknown[] = [
    null,
    {},
    { ...good, version: 99 },
    { ...good, surprise: "ignored" },
    { ...good, keys: [] },
    {
      ...good,
      keys: [
        { ...good.keys[0], keyBase64: key.toString("base64").slice(0, -1) },
      ],
    },
    { ...good, keys: [{ ...good.keys[0], id: "f".repeat(64) }] },
    {
      ...good,
      keys: [
        { ...good.keys[0], keyBase64: Buffer.alloc(31).toString("base64") },
      ],
    },
    { ...good, keys: [{ ...good.keys[0], extra: true }] },
  ];
  const before = await fs.readFile(metadata);
  for (const value of cases) {
    const file = path.join(base, "invalid.json");
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(ring.importFile(file), (e) => {
      assert.equal(
        (e as Error).message.includes(key.toString("base64")),
        false,
      );
      return true;
    });
    assert.deepEqual(await fs.readFile(metadata), before);
    assert.equal(ring.trustedKeys().length, 1);
  }
  const raw = path.join(base, "legacy.key");
  await fs.writeFile(raw, key);
  await assert.rejects(ring.importFile(raw));
  assert.deepEqual(
    (await ring.importFile(raw, { allowLegacyRaw: true })).addedKeyIds,
    [recoveryKeyId(key)],
  );
});

test("bounded key set, oversized files, malformed JSON and duplicate imports preserve existing keys", async (t) => {
  const { ring, base, metadata, recovery } = await fixture(t);
  await ring.load();
  const extras = Array.from({ length: MAX_RECOVERY_KEYS - 1 }, () =>
    randomBytes(32),
  );
  const file = await incoming(base, extras);
  await ring.importFile(file);
  const before = await fs.readFile(metadata);
  assert.equal(ring.trustedKeys().length, MAX_RECOVERY_KEYS);
  await assert.rejects(
    ring.importFile(await incoming(base, [randomBytes(32)], "overflow.json")),
  );
  assert.deepEqual(await fs.readFile(metadata), before);
  await assert.rejects(
    ring.importFile(
      await incoming(
        base,
        Array.from({ length: MAX_RECOVERY_KEYS + 1 }, () => randomBytes(32)),
        "many.json",
      ),
    ),
  );
  for (const content of ["{not-json", "x".repeat(17 * 1024)]) {
    const bad = path.join(base, "bad.json");
    await fs.writeFile(bad, content);
    await assert.rejects(ring.importFile(bad));
  }
  assert.deepEqual(await fs.readFile(metadata), before);
  assert.equal(
    (await new RecoveryKeyring(recovery).load()).trustedKeyIds.length,
    MAX_RECOVERY_KEYS,
  );
  assert.deepEqual((await ring.importFile(file)).addedKeyIds, []);
});

test("key import and export reject symlinks, parent links, hardlinks and traversal", async (t) => {
  const { ring, base } = await fixture(t);
  await ring.load();
  const source = await incoming(base, [randomBytes(32)]);
  const hard = path.join(base, "hard.json");
  await fs.link(source, hard);
  await assert.rejects(ring.importFile(hard));
  await fs.unlink(hard);
  const linked = path.join(base, "linked.json");
  if (!(await symlink(t, source, linked))) return;
  await assert.rejects(ring.importFile(linked));
  await assert.rejects(ring.exportFile(linked));
  const dir = path.join(base, "real");
  await fs.mkdir(dir);
  const alias = path.join(base, "alias");
  await fs.symlink(dir, alias, "dir");
  await assert.rejects(ring.exportFile(path.join(alias, "backup.json")));
  await fs.writeFile(
    path.join(dir, "input.json"),
    JSON.stringify(bundle([randomBytes(32)])),
  );
  await assert.rejects(ring.importFile(path.join(alias, "input.json")));
  await assert.rejects(
    ring.exportFile(
      path.join(dir, "x") + path.sep + ".." + path.sep + "backup.json",
    ),
  );
  await assert.rejects(ring.exportFile("relative.json"));
  assert.deepEqual((await fs.readdir(dir)).sort(), ["input.json"]);
});

test("corrupt or linked persisted keyring is preserved instead of losing older imported keys", async (t) => {
  const { ring, recovery, metadata, base } = await fixture(t);
  await ring.load();
  const file = await incoming(base, [randomBytes(32)]);
  await fs.writeFile(metadata, "{broken");
  const broken = new RecoveryKeyring(recovery);
  const view = await broken.load();
  assert.equal(view.canSign, false);
  assert.ok(view.issues.some((i) => i.code === "keyring-unavailable"));
  await assert.rejects(broken.importFile(file));
  await assert.rejects(broken.exportFile(path.join(base, "backup.json")));
  assert.equal(await fs.readFile(metadata, "utf8"), "{broken");
  await fs.unlink(metadata);
  await fs.link(file, metadata);
  assert.ok(
    (await new RecoveryKeyring(recovery).load()).issues.some(
      (i) => i.code === "keyring-unavailable",
    ),
  );
});

test("interrupted imports are atomic and preserve all prior keys; concurrent imports merge", async (t) => {
  const { ring, base, metadata, recovery } = await fixture(t);
  await ring.load();
  const a = randomBytes(32),
    b = randomBytes(32);
  const af = await incoming(base, [a], "a.json"),
    bf = await incoming(base, [b], "b.json");
  const before = await fs.readFile(metadata);
  const rename = fs.rename;
  fs.rename = async (src, dest) => {
    if (dest === metadata) throw new Error("injected");
    return rename(src, dest);
  };
  try {
    await assert.rejects(ring.importFile(af));
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await fs.readFile(metadata), before);
  assert.equal(ring.trustedKeys().length, 1);
  assert.equal(
    (await fs.readdir(recovery)).filter((n) => n.endsWith(".tmp")).length,
    0,
  );
  await Promise.all([ring.importFile(af), ring.importFile(bf)]);
  await ring.flush();
  assert.equal(ring.trustedKeys().length, 3);
  assert.equal(
    (await new RecoveryKeyring(recovery).load()).trustedKeyIds.length,
    3,
  );
});

test("externally changed primary or metadata refuses stale imports instead of overwriting", async (t) => {
  const { ring, base, primary, metadata, recovery } = await fixture(t);
  await ring.load();
  const file = await incoming(base, [randomBytes(32)]);
  await fs.writeFile(primary, randomBytes(32));
  await assert.rejects(ring.importFile(file));
  const restart = new RecoveryKeyring(recovery);
  await restart.load();
  const before = await fs.readFile(metadata, "utf8");
  await fs.writeFile(metadata, before + " ");
  await assert.rejects(restart.importFile(file));
  assert.equal(await fs.readFile(metadata, "utf8"), before + " ");
});

test("a fresh profile with an invalid primary can import an authentic recovery key without replacing it", async (t) => {
  const { ring, recovery, primary, base, metadata } = await fixture(t);
  await fs.mkdir(recovery);
  await fs.writeFile(primary, "broken-primary");
  const initial = await ring.load();
  assert.equal(initial.canSign, false);
  assert.equal(initial.expectedPrimaryId, null);
  const authentic = randomBytes(32);
  const result = await ring.importFile(await incoming(base, [authentic]));
  assert.equal(result.keyring.canSign, false);
  assert.equal(result.keyring.expectedPrimaryId, recoveryKeyId(authentic));
  assert.deepEqual(ring.trustedKeys(), [authentic]);
  assert.equal(await fs.readFile(primary, "utf8"), "broken-primary");
  assert.ok(
    (await fs.readFile(metadata, "utf8")).includes(recoveryKeyId(authentic)),
  );
  const restart = new RecoveryKeyring(recovery);
  await restart.load();
  assert.deepEqual(restart.trustedKeys(), [authentic]);
});

test("a replaced primary at capacity preserves all prior keys and disables new signing", async (t) => {
  const { ring, base, primary, recovery } = await fixture(t);
  await ring.load();
  const original = ring.primaryKey()!;
  const trusted = [
    original,
    ...Array.from({ length: MAX_RECOVERY_KEYS - 1 }, () => randomBytes(32)),
  ];
  await ring.importFile(await incoming(base, trusted));
  await fs.writeFile(primary, randomBytes(32));
  const restarted = new RecoveryKeyring(recovery);
  const view = await restarted.load();
  assert.equal(view.canSign, false);
  assert.equal(restarted.trustedKeys().length, MAX_RECOVERY_KEYS);
  assert.deepEqual(
    new Set(view.trustedKeyIds),
    new Set(trusted.map(recoveryKeyId)),
  );
  assert.ok(view.issues.some((i) => i.code === "keyring-unavailable"));
});

test("duplicate IDs within a valid bundle are idempotent", async (t) => {
  const { ring, base } = await fixture(t);
  await ring.load();
  const key = randomBytes(32);
  const result = await ring.importFile(await incoming(base, [key, key]));
  assert.deepEqual(result.addedKeyIds, [recoveryKeyId(key)]);
  assert.equal(ring.trustedKeys().length, 2);
});

test("keyring directories with symbolic parents never create files in the linked destination", async (t) => {
  const { base } = await fixture(t);
  const real = path.join(base, "real"),
    alias = path.join(base, "alias");
  await fs.mkdir(real);
  if (!(await symlink(t, real, alias, "dir"))) return;
  const ring = new RecoveryKeyring(path.join(alias, "recovery"));
  assert.equal((await ring.load()).canSign, false);
  assert.deepEqual(await fs.readdir(real), []);
});

test("post-commit directory sync errors report a warning without claiming import rolled back", async (t) => {
  const { ring, recovery, base } = await fixture(t);
  await ring.load();
  const key = randomBytes(32);
  const file = await incoming(base, [key]);
  const open = fs.open;
  fs.open = (async (p: any, ...args: any[]) => {
    const handle = await (open as any)(p, ...args);
    if (p === recovery)
      handle.sync = async () => {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      };
    return handle;
  }) as typeof fs.open;
  let result;
  try {
    result = await ring.importFile(file);
  } finally {
    fs.open = open;
  }
  assert.deepEqual(result.addedKeyIds, [recoveryKeyId(key)]);
  assert.ok(result.keyring.issues.some((i) => i.code === "durability-warning"));
  assert.ok(
    (await new RecoveryKeyring(recovery).load()).trustedKeyIds.includes(
      recoveryKeyId(key),
    ),
  );
});
