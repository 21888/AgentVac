import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  WorkspaceStore,
  MAX_RECENT_WORKSPACES,
  type WorkspaceSelection,
} from "../electron/workspaces.js";

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-workspaces-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  const root = path.join(base, "selected");
  await fs.mkdir(profile);
  await fs.mkdir(root);
  const input: WorkspaceSelection = {
    kind: "codex",
    demo: false,
    name: "Selected Codex",
    path: root,
  };
  return {
    base,
    profile,
    root,
    input,
    file: path.join(profile, "recent-workspaces.json"),
    store: new WorkspaceStore(profile),
  };
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

test("recent roots are metadata-only, private, durable and bounded across restarts", async (t) => {
  const { base, store, profile, file, root, input } = await fixture(t);
  const marker = "SOURCE_CONTENT_MUST_NOT_BE_STORED";
  await fs.writeFile(path.join(root, "auth-fixture.json"), marker);
  assert.deepEqual(await store.load(), { entries: [] });
  await assert.rejects(fs.stat(file));
  const first = await store.remember(input);
  assert.equal(first.status, "available");
  assert.deepEqual((await new WorkspaceStore(profile).load()).entries, [first]);
  assert.equal((await fs.readFile(file, "utf8")).includes(marker), false);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  for (let n = 0; n < MAX_RECENT_WORKSPACES + 2; n++) {
    const dir = path.join(base, "root-" + n);
    await fs.mkdir(dir);
    await store.remember({
      ...input,
      path: dir,
      kind: n % 2 ? "sqlite" : "logs",
      name: "Root " + n,
    });
  }
  assert.equal((await store.list()).entries.length, MAX_RECENT_WORKSPACES);
  assert.equal(
    (await new WorkspaceStore(profile).load()).entries.length,
    MAX_RECENT_WORKSPACES,
  );
  const reselected = await store.remember({
    ...input,
    name: "Renamed selection",
  });
  assert.equal(reselected.id, first.id);
  assert.equal((await store.list()).entries[0].name, "Renamed selection");
});

test("root listings never recurse or read source files and never relocate a moved root", async (t) => {
  const { store, root, base, input, profile } = await fixture(t);
  await store.remember(input);
  await fs.writeFile(path.join(root, "marker"), "do not inspect");
  const readdir = fs.readdir;
  fs.readdir = (async () => {
    throw new Error("Must not scan");
  }) as typeof fs.readdir;
  try {
    assert.equal(
      (await new WorkspaceStore(profile).load()).entries[0].status,
      "available",
    );
  } finally {
    fs.readdir = readdir;
  }
  await fs.rename(root, path.join(base, "moved"));
  const missing = (await store.list()).entries[0];
  assert.equal(missing.status, "missing");
  assert.equal(missing.path, root);
  await fs.mkdir(root);
  assert.equal((await store.list()).entries[0].status, "moved");
  assert.equal((await store.remember(input)).status, "available");
});

test("missing disks and permission errors are explicit and do not rewrite paths", async (t) => {
  const { store, root, input } = await fixture(t);
  await store.remember(input);
  const lstat = fs.lstat;
  fs.lstat = (async (p: any, ...args: any[]) => {
    if (p === root)
      throw Object.assign(new Error("private detail"), { code: "EACCES" });
    return (lstat as any)(p, ...args);
  }) as typeof fs.lstat;
  try {
    const info = (await store.list()).entries[0];
    assert.equal(info.status, "error");
    assert.equal(info.path, root);
    assert.equal(info.message.includes("private detail"), false);
  } finally {
    fs.lstat = lstat;
  }
});

test("workspace roots reject relative, traversal, symlink parents and symlink final roots", async (t) => {
  const { base, root, store, input } = await fixture(t);
  for (const p of [
    "relative",
    path.join(base, "x") + path.sep + ".." + path.sep + "selected",
    root + path.sep,
  ])
    await assert.rejects(store.remember({ ...input, path: p }));
  const alias = path.join(base, "alias");
  if (!(await symlink(t, root, alias, "dir"))) return;
  await assert.rejects(store.remember({ ...input, path: alias }));
  await fs.mkdir(path.join(root, "child"));
  await assert.rejects(
    store.remember({ ...input, path: path.join(alias, "child") }),
  );
  const saved = await store.remember(input);
  await fs.rename(root, path.join(base, "original"));
  await fs.symlink(path.join(base, "original"), root, "dir");
  assert.equal(
    (await store.list()).entries.find((e) => e.id === saved.id)?.status,
    "unsafe",
  );
});

test("corrupt, oversized, hardlinked and symlink metadata is preserved and blocks writes", async (t) => {
  const { store, profile, file, input, base } = await fixture(t);
  for (const raw of [
    "{broken",
    "null",
    '{"version":99,"entries":[]}',
    "x".repeat(65 * 1024),
  ]) {
    await fs.writeFile(file, raw);
    const load = await store.load();
    assert.ok(load.issue);
    assert.equal(load.entries.length, 0);
    await assert.rejects(store.remember(input));
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
  await fs.unlink(file);
  const outside = path.join(base, "outside");
  await fs.writeFile(outside, '{"version":1,"entries":[]}');
  await fs.link(outside, file);
  assert.ok((await new WorkspaceStore(profile).load()).issue);
  await fs.unlink(file);
  if (!(await symlink(t, outside, file))) return;
  const linked = new WorkspaceStore(profile);
  assert.ok((await linked.load()).issue);
  await assert.rejects(linked.remember(input));
  assert.equal(
    await fs.readFile(outside, "utf8"),
    '{"version":1,"entries":[]}',
  );
});

test("recent selection, reselect and forget serialize without losing roots", async (t) => {
  const { base, store, input, profile } = await fixture(t);
  await store.load();
  const a = path.join(base, "a"),
    b = path.join(base, "b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const results = await Promise.all([
    store.remember({ ...input, path: a }),
    store.remember({ ...input, path: b }),
    store.remember(input),
  ]);
  await store.flush();
  assert.deepEqual(
    (await store.list()).entries.map((e) => e.id),
    results.map((e) => e.id).reverse(),
  );
  await store.forget(results[1].id);
  assert.equal((await new WorkspaceStore(profile).load()).entries.length, 2);
  await assert.rejects(fs.stat(path.join(b, "unexpected")));
  assert.ok((await fs.stat(b)).isDirectory());
});

test("interrupted workspace commits leave old records and no temporary files", async (t) => {
  const { store, input, file, profile } = await fixture(t);
  await store.remember(input);
  const original = await fs.readFile(file, "utf8");
  const rename = fs.rename;
  fs.rename = async (src, dest) => {
    if (dest === file) throw new Error("injected");
    return rename(src, dest);
  };
  try {
    await assert.rejects(
      store.remember({ ...input, name: "Changed" }),
      /injected/,
    );
  } finally {
    fs.rename = rename;
  }
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal((await store.list()).entries[0].name, input.name);
  assert.equal(
    (await fs.readdir(profile)).filter((n) => n.endsWith(".tmp")).length,
    0,
  );
});

test("another instance's workspace record is not overwritten by a stale in-memory store", async (t) => {
  const { store, input, file } = await fixture(t);
  await store.remember(input);
  const changed = (await fs.readFile(file, "utf8")) + " ";
  await fs.writeFile(file, changed);
  await assert.rejects(store.remember({ ...input, name: "Stale overwrite" }));
  assert.equal(await fs.readFile(file, "utf8"), changed);
});

test("workspace directories with symbolic parents are never followed", async (t) => {
  const { profile, base, input } = await fixture(t);
  const alias = path.join(base, "profile-alias");
  if (!(await symlink(t, profile, alias, "dir"))) return;
  const store = new WorkspaceStore(alias);
  assert.ok((await store.load()).issue);
  await assert.rejects(store.remember(input));
  assert.deepEqual(await fs.readdir(profile), []);
});
