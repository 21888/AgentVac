import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { codexAdapter } from "../electron/providers/codex.js";
import type { ProviderAdapter } from "../electron/providers/types.js";
import { UNIT_MAX_DEPTH } from "../electron/cleanup-units.js";
const old = new Date(Date.now() - 120 * 86400000);
const clear = async () => ({
  status: "clear" as const,
  details: "synthetic closed process",
});
function adapter(bundle = false): ProviderAdapter {
  return {
    ...codexAdapter,
    id: "cursor",
    label: "Synthetic fixture",
    supportsSessionCleanup: true,
    classify(p) {
      if (p === "cache-unit" || p === "session.jsonl")
        return {
          category: bundle ? "session" : "cache",
          risk: "review",
          reason: "Synthetic whole unit",
        };
      return codexAdapter.classify(p);
    },
    async cleanupUnit(p) {
      if (p !== (bundle ? "session.jsonl" : "cache-unit")) return null;
      return bundle
        ? {
            policy: "fixture-bundle-v1",
            kind: "bundle",
            members: [
              { path: "session.jsonl", kind: "file" },
              { path: "payload", kind: "directory", optional: true },
            ],
          }
        : {
            policy: "fixture-directory-v1",
            kind: "directory",
            members: [{ path: "cache-unit", kind: "directory" }],
          };
    },
    unitEntryAllowed(_policy, p, kind) {
      return (
        ["cache-unit", "payload", "session.jsonl"].includes(p) ||
        /^(cache-unit|payload)\/(nested\/)*[ab]\.bin$/.test(p) ||
        (kind === "directory" &&
          /^(cache-unit|payload)\/(nested\/)*nested$/.test(p))
      );
    },
  };
}
async function fixture(t: any, bundle = false, demo = true) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-unit-fixture-"),
  );
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const key = randomBytes(32),
    provider = adapter(bundle);
  const engine = new AgentVacEngine(root, key, demo, clear, [], provider);
  const put = async (p: string, data = "synthetic fixture") => {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), data);
    await fs.utimes(path.join(root, p), old, old);
  };
  if (bundle) await put("session.jsonl", "synthetic transcript");
  const anchor = bundle ? "payload" : "cache-unit";
  await put(anchor + "/a.bin", "AA");
  await put(anchor + "/nested/b.bin", "BBBB");
  await fs.utimes(path.join(root, anchor + "/nested"), old, old);
  await fs.utimes(path.join(root, anchor), old, old);
  const scan = () => engine.scan({ minAgeDays: 30, includeSessions: true });
  const preview = async () => {
    const s = await scan();
    return engine.preview(
      s.entries.filter((e) => e.selectable).map((e) => e.id),
    );
  };
  const quarantine = async () =>
    engine.quarantine((await preview()).token, true);
  return {
    root,
    key,
    provider,
    engine,
    put,
    scan,
    preview,
    quarantine,
    anchor,
  };
}
test("directory unit has exact counts/bytes, signed v3 identity, and nonoverwriting restart roundtrip", async (t) => {
  const f = await fixture(t);
  const p = await f.preview();
  assert.equal(p.items.length, 1);
  assert.equal(p.totalBytes, 6);
  assert.equal(p.totalFiles, 2);
  assert.equal(p.totalDirectories, 2);
  assert.deepEqual(p.items[0].cleanupUnit, {
    kind: "directory",
    members: ["cache-unit"],
    fileCount: 2,
    directoryCount: 2,
  });
  const q = await f.engine.quarantine(p.token, true);
  assert.equal(q.completed, 1);
  await assert.rejects(fs.stat(path.join(f.root, f.anchor)), {
    code: "ENOENT",
  });
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".agentvac-quarantine", q.batchId, "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.journal.version, 3);
  assert.equal(manifest.journal.provider, "cursor");
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], f.provider);
  assert.equal((await fresh.history())[0].items[0].cleanupUnit?.fileCount, 2);
  const restored = await fresh.restore(q.batchId, true);
  assert.equal(restored.completed, 1);
  assert.deepEqual(restored.failed, []);
  assert.equal(
    await fs.readFile(path.join(f.root, f.anchor, "a.bin"), "utf8"),
    "AA",
  );
  assert.equal(
    await fs.readFile(path.join(f.root, f.anchor, "nested/b.bin"), "utf8"),
    "BBBB",
  );
  assert.equal((await fresh.history())[0].items[0].status, "restored");
});
test("bundle preview includes opaque companion and quarantine/restore preserves both", async (t) => {
  const f = await fixture(t, true);
  const p = await f.preview();
  assert.equal(p.items.length, 1);
  assert.equal(p.totalFiles, 3);
  assert.equal(p.totalBytes, 26);
  assert.deepEqual(p.items[0].cleanupUnit?.members, [
    "session.jsonl",
    "payload",
  ]);
  const q = await f.engine.quarantine(p.token, true);
  const r = await f.engine.restore(q.batchId, true);
  assert.equal(r.completed, 1);
  assert.equal(
    await fs.readFile(path.join(f.root, "session.jsonl"), "utf8"),
    "synthetic transcript",
  );
});
test("optional absent companion is recorded and later appearance invalidates preview", async (t) => {
  const f = await fixture(t, true);
  await fs.rm(path.join(f.root, "payload"), { recursive: true });
  const s = await f.scan();
  await f.put("payload/a.bin", "new");
  await assert.rejects(
    f.engine.preview(s.entries.filter((e) => e.selectable).map((e) => e.id)),
    /变化/,
  );
});
test("new, removed, or modified descendant blocks whole unit after preview", async (t) => {
  for (const change of ["added", "removed", "modified"]) {
    const f = await fixture(t);
    const p = await f.preview();
    if (change === "added") await f.put("cache-unit/b.bin", "new");
    if (change === "removed")
      await fs.unlink(path.join(f.root, "cache-unit/a.bin"));
    if (change === "modified")
      await fs.appendFile(path.join(f.root, "cache-unit/a.bin"), "!");
    const q = await f.engine.quarantine(p.token, true);
    assert.equal(q.completed, 0);
    assert.equal(q.failed.length, 1);
    assert.ok((await fs.stat(path.join(f.root, f.anchor))).isDirectory());
  }
});
test("all directory mtimes participate in age protection, including empty nested directories", async (t) => {
  const f = await fixture(t);
  await fs.utimes(
    path.join(f.root, "cache-unit/nested"),
    new Date(),
    new Date(),
  );
  const s = await f.scan();
  assert.equal(
    s.entries.find((e) => e.path === "cache-unit")?.selectable,
    false,
  );
});
test("unknown companion, hardlink and symlink each protect whole unit without following", async (t) => {
  for (const unsafe of ["unknown", "hardlink", "symlink"]) {
    const f = await fixture(t);
    if (unsafe === "unknown")
      await f.put("cache-unit/credentials.json", "protected");
    if (unsafe === "hardlink")
      await fs.link(
        path.join(f.root, "cache-unit/a.bin"),
        path.join(f.root, "outside"),
      );
    if (unsafe === "symlink") {
      await fs.unlink(path.join(f.root, "cache-unit/a.bin"));
      try {
        await fs.symlink(
          path.join(f.root, "cache-unit/nested/b.bin"),
          path.join(f.root, "cache-unit/a.bin"),
        );
      } catch (error) {
        if (
          process.platform === "win32" &&
          ["EPERM", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
    }
    const s = await f.scan();
    const entry = s.entries.find((e) => e.path === "cache-unit")!;
    assert.equal(entry.selectable, false);
    assert.match(entry.reason, /未通过验证/);
  }
});
test("bounded descendant depth fails closed", async (t) => {
  const f = await fixture(t);
  await f.put("cache-unit/" + "nested/".repeat(UNIT_MAX_DEPTH + 1) + "a.bin");
  const s = await f.scan();
  assert.equal(
    s.entries.find((e) => e.path === "cache-unit")?.selectable,
    false,
  );
});
test("new directory at original path blocks whole restoration and retains quarantine", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  await f.put("cache-unit/a.bin", "new user data");
  const r = await f.engine.restore(q.batchId, true);
  assert.equal(r.completed, 0);
  assert.match(r.failed[0].error, /不会覆盖/);
  assert.equal(
    await fs.readFile(path.join(f.root, "cache-unit/a.bin"), "utf8"),
    "new user data",
  );
  assert.equal((await f.engine.history())[0].items[0].status, "quarantined");
});
test("concurrent empty directory creation cannot be overwritten by restore", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const mkdir = fs.mkdir;
  let injected = false;
  fs.mkdir = (async (p: any, options: any) => {
    if (!injected && p === path.join(f.root, "cache-unit")) {
      injected = true;
      await mkdir(p, options);
    }
    return mkdir(p, options);
  }) as typeof fs.mkdir;
  try {
    const r = await f.engine.restore(q.batchId, true);
    assert.equal(r.completed, 0);
    assert.match(r.failed[0].error, /不会覆盖/);
  } finally {
    fs.mkdir = mkdir;
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, "cache-unit")), []);
});
test("interrupted bundle after first rename recovers via signed intent, restoring only moved members", async (t) => {
  const f = await fixture(t, true);
  const p = await f.preview(),
    rename = fs.rename,
    link = fs.link;
  fs.link = async () => {
    throw new Error("synthetic rollback interruption");
  };
  fs.rename = async (source, target) => {
    if (source === path.join(f.root, "payload"))
      throw new Error("synthetic move interruption");
    return rename(source, target);
  };
  let q;
  try {
    q = await f.engine.quarantine(p.token, true);
  } finally {
    fs.rename = rename;
    fs.link = link;
  }
  assert.equal(q.completed, 0);
  assert.equal(q.failed.length, 1);
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], f.provider);
  assert.equal((await fresh.history())[0].items[0].status, "quarantined");
  const r = await fresh.restore(q.batchId, true);
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(
    await fs.readFile(path.join(f.root, "session.jsonl"), "utf8"),
    "synthetic transcript",
  );
});
test("interrupted source unlink resumes from authenticated owned restore links", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine(),
    unlink = fs.unlink;
  let injected = false;
  fs.unlink = async (p) => {
    if (!injected && String(p).endsWith("/0/a.bin")) {
      injected = true;
      throw new Error("synthetic unlink interruption");
    }
    return unlink(p);
  };
  try {
    const r = await f.engine.restore(q.batchId, true);
    assert.equal(r.completed, 0);
    assert.equal(r.failed.length, 1);
  } finally {
    fs.unlink = unlink;
  }
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], f.provider);
  const resumed = await fresh.restore(q.batchId, true);
  assert.equal(resumed.completed, 1);
  assert.deepEqual(resumed.failed, []);
  assert.equal((await fs.stat(path.join(f.root, "cache-unit/a.bin"))).nlink, 1);
});
test("uncheckpointed interrupted hardlink is kept but not adopted or deleted", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine(),
    link = fs.link;
  let injected = false;
  fs.link = async (source, target) => {
    await link(source, target);
    if (!injected) {
      injected = true;
      throw new Error("synthetic crash after link before checkpoint");
    }
  };
  try {
    assert.equal((await f.engine.restore(q.batchId, true)).completed, 0);
  } finally {
    fs.link = link;
  }
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], f.provider);
  const r = await fresh.restore(q.batchId, true);
  assert.equal(r.completed, 0);
  assert.match(r.failed[0].error, /未经签名/);
  assert.equal(
    await fs.readFile(path.join(f.root, "cache-unit/a.bin"), "utf8"),
    "AA",
  );
});
test("changed stored file with restored size/mtime still fails ctime verification", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const batch = (await f.engine.history())[0];
  const file = path.join(
    f.root,
    ".agentvac-quarantine",
    q.batchId,
    batch.items[0].id + ".unit",
    "0",
    "a.bin",
  );
  const stat = await fs.stat(file);
  await fs.writeFile(file, "ZZ");
  await fs.utimes(file, stat.atime, stat.mtime);
  const r = await f.engine.restore(q.batchId, true);
  assert.equal(r.completed, 0);
  assert.match(r.failed[0].error, /变化/);
});
test("unknown quarantine companions or descendants prevent restore/trash", async (t) => {
  for (const descendant of [false, true]) {
    const f = await fixture(t);
    const q = await f.quarantine();
    const batch = (await f.engine.history())[0];
    const dir = path.join(
      f.root,
      ".agentvac-quarantine",
      q.batchId,
      batch.items[0].id + ".unit",
    );
    await fs.writeFile(
      path.join(dir, descendant ? "0/unknown" : "unknown"),
      "preserve",
    );
    assert.equal((await f.engine.restore(q.batchId, true)).completed, 0);
    let called = false;
    await assert.rejects(
      f.engine.trash(q.batchId, true, async () => {
        called = true;
      }),
    );
    assert.equal(called, false);
  }
});
test("unit quarantine and restore fail closed for unknown/running process state", async (t) => {
  const f = await fixture(t, false, false);
  let status: "clear" | "unknown" | "running" = "clear";
  const engine = new AgentVacEngine(
    f.root,
    f.key,
    false,
    async () => ({ status, details: "synthetic" }),
    [],
    f.provider,
  );
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const ids = scan.entries.filter((e) => e.selectable).map((e) => e.id);
  const p = await engine.preview(ids);
  status = "unknown";
  await assert.rejects(engine.quarantine(p.token, true), /阻止/);
  status = "clear";
  const q = await engine.quarantine((await engine.preview(ids)).token, true);
  status = "running";
  await assert.rejects(engine.restore(q.batchId, true), /正在运行/);
});
test("signed unit journal cannot be used under another provider or without trusted key", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  await assert.rejects(
    new AgentVacEngine(
      f.root,
      randomBytes(32),
      true,
      clear,
      [],
      f.provider,
    ).restore(q.batchId, true),
    /校验失败/,
  );
  await assert.rejects(
    new AgentVacEngine(f.root, f.key, true).restore(q.batchId, true),
    /校验失败/,
  );
});
test("keyless read-only rescue counts complete unit payloads exactly without changing data", async (t) => {
  const f = await fixture(t, true);
  const q = await f.quarantine();
  const manifest = path.join(
    f.root,
    ".agentvac-quarantine",
    q.batchId,
    "manifest.json",
  );
  const before = await fs.readFile(manifest);
  const lost = new AgentVacEngine(f.root, null, true, clear, [], f.provider);
  const rescue = await lost.inspectRecovery();
  assert.equal(rescue.batches[0].verified, false);
  assert.equal(rescue.batches[0].storedFiles, 3);
  assert.equal(rescue.batches[0].storedBytes, 26);
  assert.equal(rescue.storedBytes, 26);
  assert.equal(rescue.batches[0].irregularEntries, 0);
  assert.deepEqual(await fs.readFile(manifest), before);
  assert.equal((await f.engine.inspectRecovery()).batches[0].verified, true);
});
test("read-only unit rescue refuses links and bounds unknown deep trees", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const batch = (await f.engine.history())[0];
  const wrapper = path.join(
    f.root,
    ".agentvac-quarantine",
    q.batchId,
    batch.items[0].id + ".unit",
  );
  const target = path.join(
    wrapper,
    "0",
    ...Array.from({ length: 15 }, () => "nested"),
  );
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "opaque"), "not followed past limit");
  const lost = new AgentVacEngine(f.root, null, true, clear, [], f.provider);
  const rescue = await lost.inspectRecovery();
  assert.equal(rescue.truncated, true);
  assert.equal(rescue.storedBytes, 6);
  assert.ok(rescue.batches[0].irregularEntries > 0);
});
test("interruption after removing a stored directory resumes safely with target intact", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine(),
    rmdir = fs.rmdir;
  let injected = false;
  fs.rmdir = async (p) => {
    await rmdir(p);
    if (!injected && String(p).endsWith("/0/nested")) {
      injected = true;
      throw new Error("synthetic crash after rmdir");
    }
  };
  try {
    assert.equal((await f.engine.restore(q.batchId, true)).completed, 0);
  } finally {
    fs.rmdir = rmdir;
  }
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], f.provider);
  const r = await fresh.restore(q.batchId, true);
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
});
test("imported recovery key can restore unit without creating new signing identity", async (t) => {
  const f = await fixture(t);
  const q = await f.quarantine();
  const imported = new AgentVacEngine(
    f.root,
    null,
    true,
    clear,
    [f.key],
    f.provider,
  );
  const restored = await imported.restore(q.batchId, true);
  assert.equal(restored.completed, 1);
});
test("failure before unit container creation records no movement rather than ambiguous recovery", async (t) => {
  const f = await fixture(t),
    p = await f.preview(),
    mkdir = fs.mkdir;
  fs.mkdir = (async (p: any, options: any) => {
    if (String(p).endsWith(".unit"))
      throw new Error("synthetic permission failure");
    return mkdir(p, options);
  }) as typeof fs.mkdir;
  let q;
  try {
    q = await f.engine.quarantine(p.token, true);
  } finally {
    fs.mkdir = mkdir;
  }
  assert.equal(q.completed, 0);
  assert.equal(q.failed.length, 1);
  assert.equal((await f.engine.history())[0].items[0].status, "failed");
  assert.equal(
    await fs.readFile(path.join(f.root, "cache-unit/a.bin"), "utf8"),
    "AA",
  );
});
test("owned-restore activity exception rejects newly added target data and preserves retained sources", async (t) => {
  const f = await fixture(t);
  const provider: ProviderAdapter = {
    ...f.provider,
    async protectedPaths(root) {
      try {
        const stat = await fs.lstat(path.join(root, "cache-unit"));
        return stat.mtimeMs > Date.now() - 86400000 ? ["cache-unit/"] : [];
      } catch {
        return [];
      }
    },
  };
  const engine = new AgentVacEngine(f.root, f.key, true, clear, [], provider);
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const q = await engine.quarantine(
    (
      await engine.preview(
        scan.entries.filter((e) => e.selectable).map((e) => e.id),
      )
    ).token,
    true,
  );
  const unlink = fs.unlink;
  fs.unlink = async (p) => {
    if (String(p).endsWith("/0/a.bin"))
      throw new Error("synthetic source unlink failure");
    return unlink(p);
  };
  try {
    assert.equal((await engine.restore(q.batchId, true)).completed, 0);
  } finally {
    fs.unlink = unlink;
  }
  await fs.writeFile(
    path.join(f.root, "cache-unit", "unknown-private.json"),
    "new target data",
  );
  const fresh = new AgentVacEngine(f.root, f.key, true, clear, [], provider);
  await assert.rejects(fresh.restore(q.batchId, true), /未知/);
  assert.equal(
    await fs.readFile(
      path.join(f.root, "cache-unit/unknown-private.json"),
      "utf8",
    ),
    "new target data",
  );
  const batch = (await fresh.history())[0];
  assert.equal(
    await fs.readFile(
      path.join(
        f.root,
        ".agentvac-quarantine",
        q.batchId,
        batch.items[0].id + ".unit",
        "0/a.bin",
      ),
      "utf8",
    ),
    "AA",
  );
});
test("batch folder lookup is read-only, rejects traversal and does not create missing paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.engine.getBatchQuarantinePath("../escape"), /批次/);
  await assert.rejects(
    f.engine.getBatchQuarantinePath("12345678-1234-4234-8234-123456789abc"),
  );
  assert.equal(
    (await fs.readdir(f.root)).includes(".agentvac-quarantine"),
    false,
  );
  const q = await f.quarantine();
  assert.equal(
    await f.engine.getBatchQuarantinePath(q.batchId),
    path.join(f.root, ".agentvac-quarantine", q.batchId),
  );
});
