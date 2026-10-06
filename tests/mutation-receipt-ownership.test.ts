import { trashFixture } from "./helpers/trash.js";
import { installSyntheticSafeFileIds } from "./helpers/synthetic-safe-file-ids.js";
import { ReplacementInjection } from "./helpers/replacement-injection.js";
// Generated-fixture regressions preserved from the independent review.
// Replayed here by the implementation owner; this is not a completed independent review.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHmac, createHash } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
import { codexAdapter } from "../electron/providers/codex.js";

const clear = async () => ({
  status: "clear" as const,
  details: "independent synthetic stopped fixture",
});
const old = new Date("2024-01-01");
const signature = (j: any, key: Buffer) =>
  createHmac("sha256", key).update(JSON.stringify(j)).digest("hex");
const hash = (key: Buffer) => createHash("sha256").update(key).digest("hex");
const stop = (e: AgentVacEngine, action: string) =>
  action === "cancel" ? e.cancelScan() : e.invalidate();
const attempt = async (fn: () => Promise<any>) => {
  try {
    return { result: await fn() };
  } catch (error) {
    return { error };
  }
};
async function fixture(
  t: TestContext,
  unit = false,
  count = 1,
  safeIds = false,
) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-receipt-review-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  if (safeIds) installSyntheticSafeFileIds(t, base);
  const root = path.join(base, unit ? "Cursor" : "Codex");
  const key = randomBytes(32),
    adapter = unit ? cursorAdapter : codexAdapter;
  const files = unit
    ? ["index", "data_0", "data_1", "data_2", "data_3"].map(
        (n) => "GPUCache/" + n,
      )
    : Array.from({ length: count }, (_, i) => `log/codex-tui.log.${i + 1}`);
  if (unit) {
    await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
    await fs.mkdir(path.join(root, "logs/20250101T000000"), {
      recursive: true,
    });
  }
  for (const file of files) {
    const p = path.join(root, file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "independent " + file);
    await fs.utimes(p, old, old);
  }
  if (unit) await fs.utimes(path.join(root, "GPUCache"), old, old);
  const engine = (
    check = clear,
    primary: Buffer | null = key,
    recovery: Buffer[] = [],
  ) => new AgentVacEngine(root, primary, false, check, recovery, adapter);
  const writer = engine();
  const scan = await writer.scan({ minAgeDays: 30, includeSessions: false });
  const preview = await writer.preview(
    scan.entries.filter((x) => x.selectable).map((x) => x.id),
  );
  const moved = await writer.quarantine(preview.token, true);
  assert.equal(moved.completed, unit ? 1 : count);
  const q = path.join(root, ".agentvac-quarantine"),
    dir = path.join(q, moved.batchId),
    manifest = path.join(dir, "manifest.json");
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  const stored = path.join(
    dir,
    saved.journal.items[0].id + (unit ? ".unit" : ".data"),
  );
  return {
    base,
    root,
    key,
    files,
    engine,
    writer,
    id: moved.batchId,
    q,
    dir,
    manifest,
    saved,
    stored,
    original: path.join(root, files[0]),
  };
}
async function checkOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  for (const file of f.files) {
    assert.equal(
      await fs.readFile(path.join(f.root, file), "utf8"),
      "independent " + file,
    );
    assert.equal((await fs.lstat(path.join(f.root, file))).nlink, 1);
  }
}
async function authentic(manifest: string, key: Buffer, policy = 4) {
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal(saved.signature, signature(saved.journal, key));
  assert.equal(saved.keyId, hash(key));
  assert.equal(saved.journal.version, 4);
  assert.equal(saved.journal.recoveryPolicyVersion, policy);
  return saved;
}

function replacementCase(
  name: string,
  run: (t: TestContext, controlled: boolean) => Promise<void>,
  controls = true,
) {
  for (const controlled of controls ? [false, true] : [false]) {
    test(
      name + (controlled ? " [generated Windows refusal control]" : ""),
      (t) => run(t, controlled),
    );
  }
}

function refuseFixtureRename(
  t: TestContext,
  controlled: boolean,
  target: string,
  destination: string,
) {
  if (!controlled) return;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from: any, to: any) => {
    if (from === target && to === destination) {
      throw Object.assign(new Error("generated fixture rename refusal"), {
        code: "EPERM",
        errno: -4048,
      });
    }
    return rename(from, to);
  });
}

async function classifyRefusal(
  t: TestContext,
  injection: ReplacementInjection,
  controlled: boolean,
) {
  const reasons: string[] = [];
  const blocked = await injection.skipIfVerifiedWindowsRefusal(
    controlled
      ? {
          diagnostic: (message) => t.diagnostic(message),
          skip: (reason) => {
            reasons.push(String(reason));
          },
        }
      : t,
  );
  if (controlled) {
    assert.equal(
      blocked,
      true,
      "generated refusal control must classify only after preservation checks",
    );
    assert.equal(reasons.length, 1);
    assert.match(
      reasons[0],
      /BLOCKED.*installed-replacement branch not exercised/,
    );
    t.diagnostic(
      "generated refusal classifier control; not native Windows or installed-replacement coverage",
    );
  }
  return blocked;
}

for (const action of ["cancel", "invalidate"]) {
  test(`${action} during an unpublished initial journal write preserves prior manifest and payload`, async (t) => {
    const f = await fixture(t),
      e = f.engine(),
      before = await fs.readFile(f.manifest),
      open = fs.open;
    let hit = false;
    const mock = t.mock.method(fs, "open", async (...args: any[]) => {
      const h = await (open as any)(...args);
      if (
        String(args[0]).endsWith(".tmp") &&
        String(args[0]).startsWith(f.dir)
      ) {
        const write = h.writeFile.bind(h);
        h.writeFile = async (...writeArgs: any[]) => {
          await write(...writeArgs);
          if (!hit) {
            hit = true;
            stop(e, action);
          }
        };
      }
      return h;
    });
    let result;
    try {
      result = await attempt(() => e.restore(f.id, true));
    } finally {
      mock.mock.restore();
    }
    assert.equal(hit, true);
    assert.ok(result.error);
    assert.deepEqual(await fs.readFile(f.manifest), before);
    assert.equal((await fs.lstat(f.stored)).nlink, 1);
    await assert.rejects(fs.lstat(f.original), { code: "ENOENT" });
    assert.equal(
      (await (action === "cancel" ? e : f.engine()).restore(f.id, true))
        .completed,
      1,
    );
    await checkOriginal(f);
  });

  test(`${action} while an ordinary unlink is admitted completes its checkpoint and blocks next item`, async (t) => {
    const f = await fixture(t, false, 2),
      e = f.engine(),
      unlink = fs.unlink;
    let hits = 0;
    const mock = t.mock.method(fs, "unlink", async (p: any) => {
      if (String(p).endsWith(".data")) {
        hits++;
        stop(e, action);
      }
      return unlink(p);
    });
    let first;
    try {
      first = await e.restore(f.id, true);
    } finally {
      mock.mock.restore();
    }
    assert.equal(hits, 1);
    assert.equal(first.completed, 1);
    assert.equal(first.failed.length, 1);
    const saved = await authentic(f.manifest, f.key);
    assert.equal(
      saved.journal.items.filter((x: any) => x.status === "restored").length,
      1,
    );
    assert.equal(
      (await (action === "cancel" ? e : f.engine()).restore(f.id, true))
        .completed,
      1,
    );
    await checkOriginal(f);
  });

  for (const syscall of [
    "mkdir",
    "link",
    "unlink",
    "rmdir",
    "chmod",
    "utimes",
  ] as const) {
    test(`${action} after admitted unit ${syscall} fences every later payload syscall and fresh retry recovers`, async (t) => {
      const f = await fixture(t, true),
        e = f.engine();
      let hit = false,
        after = 0;
      const mocks = (
        ["mkdir", "link", "unlink", "rmdir", "chmod", "utimes"] as const
      ).map((name) => {
        const original = fs[name];
        return t.mock.method(fs, name, async (...args: any[]) => {
          const p = String(args[0]);
          const payload =
            p.startsWith(path.join(f.root, "GPUCache")) ||
            p.startsWith(f.stored + path.sep);
          if (payload && hit) after++;
          const result = await (original as any)(...args);
          if (payload && name === syscall && !hit) {
            hit = true;
            stop(e, action);
          }
          return result;
        });
      });
      try {
        await attempt(() => e.restore(f.id, true));
      } finally {
        mocks.forEach((m) => m.mock.restore());
      }
      assert.equal(hit, true);
      assert.equal(after, 0);
      await authentic(f.manifest, f.key);
      await (action === "cancel" ? e : f.engine()).restore(f.id, true);
      await checkOriginal(f);
    });
  }

  for (const version of [1, 2, 3, 4]) {
    test(`${action} after linking storage v${version}${version < 4 ? " with synthetic safe IDs" : ""} preserves original key under rotation and retry`, async (t) => {
      const f = await fixture(t, false, 1, version < 4),
        rotated = randomBytes(32),
        saved = f.saved;
      saved.journal.version = version;
      if (version < 4) delete saved.journal.recoveryPolicyVersion;
      if (version === 1) delete saved.journal.provider;
      if (version < 4)
        for (const item of saved.journal.items)
          for (const field of ["before", "stored"]) {
            item[field].dev = Number(item[field].dev);
            item[field].ino = Number(item[field].ino);
            assert.equal(Number.isSafeInteger(item[field].ino), true);
          }
      saved.signature = signature(saved.journal, f.key);
      await fs.writeFile(f.manifest, JSON.stringify(saved));
      const before = JSON.stringify(saved.journal.items[0].before);
      const e = f.engine(clear, rotated, [f.key]),
        link = fs.link;
      const mock = t.mock.method(fs, "link", async (...args: any[]) => {
        const r = await (link as any)(...args);
        stop(e, action);
        return r;
      });
      try {
        await attempt(() => e.restore(f.id, true));
      } finally {
        mock.mock.restore();
      }
      const interrupted = await authentic(f.manifest, f.key, version);
      assert.equal(JSON.stringify(interrupted.journal.items[0].before), before);
      assert.equal(
        (
          await (
            action === "cancel" ? e : f.engine(clear, null, [f.key])
          ).restore(f.id, true)
        ).completed,
        1,
      );
      await authentic(f.manifest, f.key, version);
      await checkOriginal(f);
    });
  }

  test(`${action} after admitted Trash preserves signed receipt with original recovery key`, async (t) => {
    const f = await fixture(t),
      e = f.engine(clear, randomBytes(32), [f.key]);
    const trashed = path.join(f.base, "fake-os-trash");
    const result = await trashFixture(e, f.id, true, true, async (dir) => {
      stop(e, action);
      await fs.rename(dir, trashed);
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 0);
    const saved = await authentic(
      path.join(f.q, f.id + ".receipt.json"),
      f.key,
    );
    assert.equal(saved.journal.items[0].status, "trashed");
    assert.equal(
      await fs.readFile(path.join(trashed, path.basename(f.stored)), "utf8"),
      "independent " + f.files[0],
    );
  });

  test(`${action} at Trash process-check completion refuses callback and preserves manifest`, async (t) => {
    const f = await fixture(t),
      before = await fs.readFile(f.manifest);
    const e = f.engine(async () => {
      stop(e, action);
      return clear();
    });
    let called = 0;
    await assert.rejects(
      trashFixture(e, f.id, true, true, async () => {
        called++;
      }),
    );
    assert.equal(called, 0);
    assert.deepEqual(await fs.readFile(f.manifest), before);
  });
}

test("checkpoint refuses a substituted temporary file before replacing the authenticated manifest", async (t) => {
  const f = await fixture(t),
    e = f.engine(),
    open = fs.open;
  let writes = 0,
    before = Buffer.alloc(0),
    hit = false;
  const mock = t.mock.method(fs, "open", async (...args: any[]) => {
    const h = await (open as any)(...args);
    if (String(args[0]).endsWith(".tmp") && String(args[0]).startsWith(f.dir)) {
      const write = h.writeFile.bind(h);
      h.writeFile = async (...writeArgs: any[]) => {
        await write(...writeArgs);
        if (++writes === 2) {
          hit = true;
          before = await fs.readFile(f.manifest);
          await fs.rename(String(args[0]), String(args[0]) + "-preserved");
          await fs.writeFile(String(args[0]), "replacement temporary sentinel");
          e.cancelScan();
        }
      };
    }
    return h;
  });
  let first;
  try {
    first = await attempt(() => e.restore(f.id, true));
  } finally {
    mock.mock.restore();
  }
  assert.equal(hit, true);
  assert.ok(first.error);
  assert.ok(
    (await fs.readFile(f.manifest)).equals(before),
    "authenticated manifest must not be replaced by substituted temporary bytes",
  );
});

replacementCase(
  "receipt cleanup preserves replacement temporary after pending write failure and invalidation",
  async (t, controlled) => {
    const f = await fixture(t),
      e = f.engine(),
      open = fs.open,
      injection = new ReplacementInjection(
        controlled ? "win32" : process.platform,
      );
    refuseFixtureRename(t, controlled, f.q, f.q + "-preserved");
    let replacementTemp = "";
    const mock = t.mock.method(fs, "open", async (...args: any[]) => {
      const h = await (open as any)(...args);
      if (String(args[0]).endsWith(".receipt.tmp")) {
        const write = h.writeFile.bind(h);
        h.writeFile = async (...writeArgs: any[]) => {
          await write(...writeArgs);
          replacementTemp = String(args[0]);
          await injection.run(
            () => fs.rename(f.q, f.q + "-preserved"),
            async () => {
              await fs.mkdir(f.q);
              await fs.writeFile(
                replacementTemp,
                "replacement temporary sentinel",
              );
            },
            {
              root: f.base,
              target: f.q,
              destination: f.q + "-preserved",
              ownedTemporary: replacementTemp,
            },
          );
          e.invalidate();
          throw new Error("synthetic failure of pending receipt write");
        };
      }
      return h;
    });
    let result;
    try {
      result = await trashFixture(e, f.id, true, true, async (dir) =>
        fs.rename(dir, path.join(f.base, "fake-os-trash")),
      );
    } finally {
      mock.mock.restore();
      injection.diagnose(t);
    }
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 1);
    if (await classifyRefusal(t, injection, controlled)) return;
    injection.assertInstalled();
    await injection.assertSentinel(
      replacementTemp,
      "replacement temporary sentinel",
      "temporary",
    );
  },
);

test("receipt publication preserves a preexisting unrelated receipt", async (t) => {
  const f = await fixture(t),
    e = f.engine(),
    receipt = path.join(f.q, f.id + ".receipt.json");
  const result = await trashFixture(e, f.id, true, true, async (dir) => {
    await fs.rename(dir, path.join(f.base, "fake-os-trash"));
    await fs.writeFile(receipt, "preexisting receipt sentinel");
    e.cancelScan();
  });
  assert.equal(result.completed, 1);
  assert.equal(
    await fs.readFile(receipt, "utf8"),
    "preexisting receipt sentinel",
  );
  assert.equal(result.failed.length, 1);
});

for (const replacement of ["quarantine", "batch"]) {
  test(`Trash refuses ${replacement} replacement during its final stopped-process check`, async (t) => {
    const f = await fixture(t),
      changed = replacement === "quarantine" ? f.q : f.dir;
    let hit = false,
      callbacks = 0;
    const e = f.engine(async () => {
      assert.equal(hit, false);
      hit = true;
      await fs.rename(changed, changed + "-preserved");
      await fs.mkdir(f.dir, { recursive: true });
      await fs.writeFile(
        path.join(f.dir, "unrelated-file"),
        "unrelated payload sentinel",
      );
      return clear();
    });
    const result = await attempt(() =>
      trashFixture(e, f.id, true, true, async (dir) => {
        callbacks++;
        await fs.rename(dir, path.join(f.base, "fake-os-trash"));
      }),
    );
    assert.equal(hit, true);
    assert.equal(
      callbacks,
      0,
      "replacement subtree is not the validated and authorized batch",
    );
    assert.ok(result.error);
  });
}

for (const replacement of ["root", "quarantine", "batch", "manifest"]) {
  replacementCase(
    `checkpoint pending write refuses replaced ${replacement} without overwriting replacement`,
    async (t, controlled) => {
      const f = await fixture(t),
        e = f.engine(),
        open = fs.open,
        injection = new ReplacementInjection(
          controlled ? "win32" : process.platform,
        );
      const target =
        replacement === "root"
          ? f.root
          : replacement === "quarantine"
            ? f.q
            : replacement === "batch"
              ? f.dir
              : f.manifest;
      const preserved = target + "-preserved";
      refuseFixtureRename(t, controlled, target, preserved);
      let writes = 0;
      const mock = t.mock.method(fs, "open", async (...args: any[]) => {
        const h = await (open as any)(...args);
        if (
          String(args[0]).endsWith(".tmp") &&
          String(args[0]).startsWith(f.dir)
        ) {
          const write = h.writeFile.bind(h);
          h.writeFile = async (...writeArgs: any[]) => {
            await write(...writeArgs);
            if (++writes === 2) {
              await injection.run(
                () => fs.rename(target, preserved),
                async () => {
                  if (replacement !== "manifest")
                    await fs.mkdir(path.dirname(f.manifest), {
                      recursive: true,
                    });
                  await fs.writeFile(f.manifest, "replacement sentinel");
                },
                replacement === "manifest"
                  ? undefined
                  : {
                      root: f.base,
                      target,
                      destination: preserved,
                      ownedTemporary: String(args[0]),
                    },
              );
              e.invalidate();
            }
          };
        }
        return h;
      });
      let first;
      try {
        first = await attempt(() => e.restore(f.id, true));
      } finally {
        mock.mock.restore();
        injection.diagnose(t);
      }
      assert.ok(first.error);
      if (
        replacement !== "manifest" &&
        (await classifyRefusal(t, injection, controlled))
      )
        return;
      injection.assertInstalled();
      await injection.assertSentinel(
        f.manifest,
        "replacement sentinel",
        "manifest",
      );
    },
    replacement !== "manifest",
  );
}

replacementCase(
  "receipt write refuses a quarantine parent replaced while the write is pending",
  async (t, controlled) => {
    const f = await fixture(t),
      e = f.engine(),
      open = fs.open,
      injection = new ReplacementInjection(
        controlled ? "win32" : process.platform,
      );
    const preserved = f.q + "-preserved",
      receipt = path.join(f.q, f.id + ".receipt.json");
    refuseFixtureRename(t, controlled, f.q, preserved);
    const mock = t.mock.method(fs, "open", async (...args: any[]) => {
      const h = await (open as any)(...args);
      if (String(args[0]).endsWith(".receipt.tmp")) {
        const write = h.writeFile.bind(h);
        h.writeFile = async (...writeArgs: any[]) => {
          await write(...writeArgs);
          await injection.run(
            () => fs.rename(f.q, preserved),
            async () => {
              await fs.mkdir(f.q);
              await fs.writeFile(receipt, "replacement receipt sentinel");
              await fs.writeFile(
                String(args[0]),
                "replacement temporary sentinel",
              );
            },
            {
              root: f.base,
              target: f.q,
              destination: preserved,
              ownedTemporary: String(args[0]),
            },
          );
          e.invalidate();
        };
      }
      return h;
    });
    let result;
    try {
      result = await trashFixture(e, f.id, true, true, async (dir) =>
        fs.rename(dir, path.join(f.base, "fake-os-trash")),
      );
    } finally {
      mock.mock.restore();
      injection.diagnose(t);
    }
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 1);
    if (await classifyRefusal(t, injection, controlled)) return;
    injection.assertInstalled();
    await injection.assertSentinel(
      receipt,
      "replacement receipt sentinel",
      "receipt",
    );
  },
);

for (const checkpoint of [false, true]) {
  replacementCase(
    `${checkpoint ? "checkpoint" : "initial"} journal cleanup preserves a replacement temporary file after invalidation`,
    async (t, controlled) => {
      const f = await fixture(t),
        e = f.engine(),
        open = fs.open,
        injection = new ReplacementInjection(
          controlled ? "win32" : process.platform,
        );
      refuseFixtureRename(t, controlled, f.dir, f.dir + "-preserved");
      let writes = 0,
        replacementTemp = "";
      const mock = t.mock.method(fs, "open", async (...args: any[]) => {
        const h = await (open as any)(...args);
        if (
          String(args[0]).endsWith(".tmp") &&
          String(args[0]).startsWith(f.dir)
        ) {
          const write = h.writeFile.bind(h);
          h.writeFile = async (...writeArgs: any[]) => {
            await write(...writeArgs);
            if (++writes === (checkpoint ? 2 : 1)) {
              replacementTemp = String(args[0]);
              await injection.run(
                () => fs.rename(f.dir, f.dir + "-preserved"),
                async () => {
                  await fs.mkdir(f.dir);
                  await fs.writeFile(
                    f.manifest,
                    "replacement manifest sentinel",
                  );
                  await fs.writeFile(
                    replacementTemp,
                    "replacement temporary sentinel",
                  );
                },
                {
                  root: f.base,
                  target: f.dir,
                  destination: f.dir + "-preserved",
                  ownedTemporary: replacementTemp,
                },
              );
              e.invalidate();
            }
          };
        }
        return h;
      });
      let first;
      try {
        first = await attempt(() => e.restore(f.id, true));
      } finally {
        mock.mock.restore();
        injection.diagnose(t);
      }
      assert.ok(first.error);
      if (await classifyRefusal(t, injection, controlled)) return;
      injection.assertInstalled();
      await injection.assertSentinel(
        f.manifest,
        "replacement manifest sentinel",
        "manifest",
      );
      await injection.assertSentinel(
        replacementTemp,
        "replacement temporary sentinel",
        "temporary",
      );
    },
  );
}

for (const action of ["cancel", "invalidate"]) {
  test(`${action} during quarantine directory absence observation creates no new metadata directory`, async (t) => {
    const f = await fixture(t);
    await f.engine().restore(f.id, true);
    await fs.rm(f.q, { recursive: true });
    const e = f.engine(),
      scan = await e.scan({ minAgeDays: 30, includeSessions: false });
    const preview = await e.preview(
      scan.entries.filter((x) => x.selectable).map((x) => x.id),
    );
    const lstat = fs.lstat,
      mkdir = fs.mkdir;
    let hit = false,
      createdAfter = 0;
    const a = t.mock.method(fs, "lstat", async (...args: any[]) => {
      try {
        return await (lstat as any)(...args);
      } catch (error) {
        if (String(args[0]) === f.q && !hit) {
          hit = true;
          stop(e, action);
        }
        throw error;
      }
    });
    const b = t.mock.method(fs, "mkdir", async (...args: any[]) => {
      if (hit && String(args[0]).startsWith(f.q)) createdAfter++;
      return (mkdir as any)(...args);
    });
    try {
      await assert.rejects(e.quarantine(preview.token, true));
    } finally {
      a.mock.restore();
      b.mock.restore();
    }
    assert.equal(hit, true);
    await checkOriginal(f);
    assert.equal(createdAfter, 0);
  });
}

for (const phase of ["before-native-link", "after-native-link"] as const) {
  test(`receipt detects a parent substitution ${phase} after publication admission and preserves existing names`, async (t) => {
    const f = await fixture(t),
      e = f.engine(),
      link = fs.link,
      receipt = path.join(f.q, f.id + ".receipt.json");
    let hit = false,
      replacementTemp = "";
    const mock = t.mock.method(fs, "link", async (a: any, b: any) => {
      if (String(b) !== receipt) return link(a, b);
      hit = true;
      if (phase === "after-native-link") await link(a, b);
      await fs.rename(f.q, f.q + "-displaced");
      await fs.mkdir(f.q);
      replacementTemp = String(a);
      await fs.writeFile(receipt, "existing replacement receipt");
      await fs.writeFile(replacementTemp, "existing replacement temporary");
      e.invalidate();
      if (phase === "before-native-link") return link(a, b);
    });
    let result;
    try {
      result = await trashFixture(e, f.id, true, true, (dir) =>
        fs.rename(dir, path.join(f.base, "generated-trash")),
      );
    } finally {
      mock.mock.restore();
    }
    assert.equal(hit, true);
    assert.equal(result.completed, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(
      await fs.readFile(receipt, "utf8"),
      "existing replacement receipt",
    );
    assert.equal(
      await fs.readFile(replacementTemp, "utf8"),
      "existing replacement temporary",
    );
    assert.equal(
      await fs.readFile(
        path.join(f.base, "generated-trash", path.basename(f.stored)),
        "utf8",
      ),
      "independent " + f.files[0],
    );
  });
}

test("a new temporary name created after owned cleanup completes is never removed by later cleanup", async (t) => {
  const f = await fixture(t),
    e = f.engine(),
    unlink = fs.unlink;
  let hit = false,
    replacement = "";
  const mock = t.mock.method(fs, "unlink", async (p: any) => {
    if (!String(p).endsWith(".receipt.tmp") || hit) return unlink(p);
    await unlink(p);
    hit = true;
    replacement = String(p);
    await fs.writeFile(
      replacement,
      "new unrelated temporary after completed unlink",
    );
    e.invalidate();
  });
  let result;
  try {
    result = await trashFixture(e, f.id, true, true, (dir) =>
      fs.rename(dir, path.join(f.base, "generated-trash")),
    );
  } finally {
    mock.mock.restore();
  }
  assert.equal(hit, true);
  assert.equal(result.completed, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(
    await fs.readFile(replacement, "utf8"),
    "new unrelated temporary after completed unlink",
  );
  await authentic(path.join(f.q, f.id + ".receipt.json"), f.key);
  assert.equal(
    (await fs.lstat(path.join(f.q, f.id + ".receipt.json"))).nlink,
    1,
  );
});
