import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PreferenceStore } from "../electron/preferences.js";
import type { ThemeMode } from "../shared/types.js";
async function fixture(t: any) {
  const dir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-prefs-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    file: path.join(dir, "preferences.json"),
    store: new PreferenceStore(dir),
  };
}
async function linkOrSkip(t: any, target: string, link: string) {
  try {
    await fs.symlink(target, link);
    return true;
  } catch (e) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Windows symlink privilege unavailable");
      return false;
    }
    throw e;
  }
}
test("theme defaults to system without creating a config file", async (t) => {
  const { store, file } = await fixture(t);
  assert.deepEqual(await store.load(), { theme: "system" });
  await assert.rejects(fs.stat(file));
});
test("each theme persists across a fresh store instance", async (t) => {
  const { dir, store } = await fixture(t);
  for (const theme of ["light", "dark", "system"] as const) {
    assert.deepEqual(await store.setTheme(theme), { theme });
    assert.deepEqual(await new PreferenceStore(dir).load(), { theme });
  }
});
test("concurrent theme changes are serialized in requested order", async (t) => {
  const { file, store } = await fixture(t);
  const pending = [
    store.setTheme("light"),
    store.setTheme("dark"),
    store.setTheme("system"),
  ];
  await store.flush();
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).theme, "system");
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((r) => r.theme),
    ["light", "dark", "system"],
  );
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).theme, "system");
});
test("invalid theme requests cannot write app preferences", async (t) => {
  const { file, store } = await fixture(t);
  await assert.rejects(store.setTheme("neon" as ThemeMode), /无效主题/);
  await assert.rejects(fs.stat(file));
});
test("corrupt and unrecognized saved themes fall back to system without modifying data", async (t) => {
  const { file, dir } = await fixture(t);
  for (const raw of ["{broken", '{"theme":"neon"}', "null"]) {
    await fs.writeFile(file, raw);
    assert.equal((await new PreferenceStore(dir).load()).theme, "system");
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
});
test("theme file symlink is not read or overwritten", async (t) => {
  const { file, dir, store } = await fixture(t);
  const other = path.join(dir, "unrelated-fixture");
  await fs.writeFile(other, '{"theme":"dark"}');
  if (!(await linkOrSkip(t, other, file))) return;
  assert.equal((await store.load()).theme, "system");
  await assert.rejects(store.setTheme("light"), /文件异常/);
  assert.equal(await fs.readFile(other, "utf8"), '{"theme":"dark"}');
});
test("interrupted preference commit preserves previous mode and permits retry", async (t) => {
  const { store, file, dir } = await fixture(t);
  await store.setTheme("light");
  const rename = fs.rename;
  fs.rename = async (src: any, dest: any) => {
    if (dest === file) throw new Error("injected write failure");
    return rename(src, dest);
  };
  try {
    await assert.rejects(store.setTheme("dark"), /injected/);
  } finally {
    fs.rename = rename;
  }
  assert.equal(store.current().theme, "light");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).theme, "light");
  assert.equal(
    (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp")).length,
    0,
  );
  assert.equal((await store.setTheme("dark")).theme, "dark");
});
test("theme directory symlink is refused before any write", async (t) => {
  const { dir } = await fixture(t);
  const real = path.join(dir, "real"),
    alias = path.join(dir, "alias");
  await fs.mkdir(real);
  if (!(await linkOrSkip(t, real, alias))) return;
  const store = new PreferenceStore(alias);
  await assert.rejects(store.load(), /链接/);
  await assert.rejects(store.setTheme("dark"), /链接/);
  assert.deepEqual(await fs.readdir(real), []);
});
