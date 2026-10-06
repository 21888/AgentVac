import { trashFixture } from "./helpers/trash.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { clineAdapter } from "../electron/providers/cline.js";
import { cursorAdapter } from "../electron/providers/cursor.js";

const clear = async () => ({
  status: "clear" as const,
  details: "synthetic closed process",
});
async function base(t: TestContext) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-independent-review-"),
  );
  t.after(async () => {
    const visit = async (dir: string): Promise<void> => {
      await fs.chmod(dir, 0o700).catch(() => {});
      for (const entry of await fs.readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await visit(path.join(dir, entry.name));
    };
    await visit(root);
    await fs.rm(root, { force: true, recursive: true });
  });
  return root;
}
async function put(root: string, relative: string, days = 90) {
  const full = path.join(root, relative),
    old = new Date(Date.now() - days * 86400000);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "synthetic payload " + relative);
  await fs.utimes(full, old, old);
}
async function quarantine(engine: AgentVacEngine, relative: string) {
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const entry = scan.entries.find((entry) => entry.path === relative)!;
  assert.ok(entry?.selectable, JSON.stringify(entry));
  const preview = await engine.preview([entry.id]);
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 1, JSON.stringify(moved.failed));
  return moved;
}

test("Cline scratch interrupted unlink can resume despite its owned new directory mtime", async (t) => {
  const root = path.join(await base(t), ".cline", "data");
  await put(root, "globalState.json");
  await put(root, "db/sessions.db");
  await fs.mkdir(path.join(root, "sessions"));
  const selected = "checkpoint-scratch/" + "a".repeat(32);
  for (const [id, days] of [
    ["a", 90],
    ["b", 60],
  ] as const) {
    const relative = "checkpoint-scratch/" + id.repeat(32);
    await put(root, relative + "/index", days);
    await put(root, relative + "/pathspec", days);
    const old = new Date(Date.now() - days * 86400000);
    await fs.utimes(path.join(root, relative), old, old);
  }
  const key = randomBytes(32),
    engine = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await engine.initialize();
  const moved = await quarantine(engine, selected);
  const unlink = fs.unlink;
  let interrupted = false;
  fs.unlink = async (p) => {
    if (
      !interrupted &&
      String(p).endsWith(path.sep + path.join("0", "index"))
    ) {
      interrupted = true;
      throw new Error("synthetic ordinary interruption");
    }
    return unlink(p);
  };
  try {
    assert.equal((await engine.restore(moved.batchId, true)).completed, 0);
  } finally {
    fs.unlink = unlink;
  }
  assert.equal(interrupted, true);
  const fresh = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await fresh.initialize();
  const resumed = await fresh.restore(moved.batchId, true);
  assert.equal(resumed.completed, 1, JSON.stringify(resumed.failed));
  assert.equal((await fs.lstat(path.join(root, selected, "index"))).nlink, 1);
});

test(
  "Cursor nested read-only directory mode protects the whole unit before quarantine",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = path.join(await base(t), "Cursor");
    await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
    await fs.mkdir(path.join(root, "logs"));
    for (const file of [
      "index",
      "index-dir/the-real-index",
      "0123456789abcdef_0",
    ])
      await put(root, "Cache/" + file);
    const old = new Date(Date.now() - 90 * 86400000);
    await fs.utimes(path.join(root, "Cache/index-dir"), old, old);
    await fs.utimes(path.join(root, "Cache"), old, old);
    await fs.chmod(path.join(root, "Cache/index-dir"), 0o555);
    const engine = new AgentVacEngine(
      root,
      randomBytes(32),
      true,
      clear,
      [],
      cursorAdapter,
    );
    await engine.initialize();
    const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
    const entry = scan.entries.find((entry) => entry.path === "Cache")!;
    assert.equal(
      entry.selectable,
      false,
      "A directory whose source links cannot be safely removed must not be offered as reversible.",
    );
    assert.equal(entry.risk, "protected");
    assert.equal(
      await fs.readFile(
        path.join(root, "Cache/index-dir/the-real-index"),
        "utf8",
      ),
      "synthetic payload Cache/index-dir/the-real-index",
    );
    assert.equal(
      (await fs.lstat(path.join(root, "Cache/index-dir"))).mode & 0o777,
      0o555,
    );
  },
);

test("Cursor mixed restored/quarantined batch can dispose only its remaining verified payload", async (t) => {
  const root = path.join(await base(t), "Cursor");
  await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"));
  const old = new Date(Date.now() - 90 * 86400000);
  for (const anchor of ["Cache", "GPUCache"]) {
    for (const file of ["index", "data_0", "data_1", "data_2", "data_3"])
      await put(root, anchor + "/" + file);
    await fs.utimes(path.join(root, anchor), old, old);
  }
  const engine = new AgentVacEngine(
    root,
    randomBytes(32),
    true,
    clear,
    [],
    cursorAdapter,
  );
  await engine.initialize();
  const scan = await engine.scan({ minAgeDays: 30, includeSessions: true });
  const preview = await engine.preview(
    scan.entries.filter((e) => e.selectable).map((e) => e.id),
  );
  const moved = await engine.quarantine(preview.token, true);
  assert.equal(moved.completed, 2);
  // A rebuilt Cache conflicts, while the independently archived GPUCache restores.
  await put(root, "Cache/index", 0);
  const restored = await engine.restore(moved.batchId, true);
  assert.equal(restored.completed, 1);
  assert.equal(restored.failed.length, 1);
  let disposalInvoked = false;
  const trashed = await trashFixture(engine, moved.batchId, true, true, async (batchDir) => {
    disposalInvoked = true;
    // Synthetic fixture trash stand-in. Preserve the complete batch elsewhere.
    await fs.rename(batchDir, batchDir + "-simulated-trash");
  });
  assert.equal(disposalInvoked, true);
  assert.equal(trashed.completed, 1);
  assert.equal(
    await fs.readFile(path.join(root, "GPUCache/index"), "utf8"),
    "synthetic payload GPUCache/index",
  );
  assert.equal(
    await fs.readFile(path.join(root, "Cache/index"), "utf8"),
    "synthetic payload Cache/index",
  );
});

test("Cursor detects known runtime entrypoints after Node options and blocks unattributed inline runtimes", () => {
  const status = (commandLine: string) =>
    cursorAdapter.assessProcesses({
      platform: "linux",
      complete: true,
      processes: [{ name: "node", commandLine }],
    }).status;
  for (const command of [
    "node --inspect=0 /home/test/.cursor-server/main.js",
    "node --require /home/test/.cursor-server/main.js",
    "node --import /home/test/.cursor-server/main.js",
  ])
    assert.equal(status(command), "running", command);
  assert.equal(status('node -e "arbitrary inline code"'), "unknown");
});

test("Cline signed scratch resume does not bypass protection for new target data", async (t) => {
  const root = path.join(await base(t), ".cline", "data");
  await put(root, "globalState.json");
  await put(root, "db/sessions.db");
  await fs.mkdir(path.join(root, "sessions"));
  const selected = "checkpoint-scratch/" + "a".repeat(32);
  for (const [id, days] of [
    ["a", 90],
    ["b", 60],
  ] as const) {
    const relative = "checkpoint-scratch/" + id.repeat(32);
    await put(root, relative + "/index", days);
    await put(root, relative + "/pathspec", days);
    const old = new Date(Date.now() - days * 86400000);
    await fs.utimes(path.join(root, relative), old, old);
  }
  const key = randomBytes(32),
    engine = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await engine.initialize();
  const moved = await quarantine(engine, selected);
  const unlink = fs.unlink;
  let interrupted = false;
  fs.unlink = async (p) => {
    if (
      !interrupted &&
      String(p).endsWith(path.sep + path.join("0", "index"))
    ) {
      interrupted = true;
      throw new Error("synthetic ordinary interruption");
    }
    return unlink(p);
  };
  try {
    assert.equal((await engine.restore(moved.batchId, true)).completed, 0);
  } finally {
    fs.unlink = unlink;
  }
  const item = (await engine.history()).find(
    (batch) => batch.id === moved.batchId,
  )!.items[0];
  const stored = path.join(
    root,
    ".agentvac-quarantine",
    moved.batchId,
    item.id + ".unit",
    "0",
  );
  await put(root, selected + "/new-user-data", 0);
  const fresh = new AgentVacEngine(root, key, true, clear, [], clineAdapter);
  await fresh.initialize();
  let completed = 0;
  try {
    completed = (await fresh.restore(moved.batchId, true)).completed;
  } catch {
    /* safe rejection */
  }
  assert.equal(completed, 0);
  for (const filename of ["index", "pathspec"]) {
    assert.equal(
      await fs.readFile(path.join(stored, filename), "utf8"),
      "synthetic payload " + selected + "/" + filename,
    );
    assert.equal((await fs.lstat(path.join(stored, filename))).nlink, 2);
  }
  assert.equal(
    await fs.readFile(path.join(root, selected, "new-user-data"), "utf8"),
    "synthetic payload " + selected + "/new-user-data",
  );
});
