import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  installSyntheticSafeFileIds,
  SyntheticSafeFileIds,
} from "./helpers/synthetic-safe-file-ids.js";

test("synthetic safe-ID map keeps adjacent unsafe native identities distinct without rounding", async () => {
  const native = await fs.lstat(import.meta.filename, { bigint: true });
  const model = new SyntheticSafeFileIds(),
    large = 1n << 60n;
  const sample = (dev: bigint, ino: bigint, bigint: boolean) =>
    model.sample(
      Object.assign(Object.create(Object.getPrototypeOf(native)), native, {
        dev,
        ino,
      }),
      bigint,
    );
  const a = sample(large, large, false),
    b = sample(large, large + 1n, false),
    otherDevice = sample(large + 1n, large, false),
    exact = sample(large, large, true);
  assert.notEqual(a.ino, b.ino);
  assert.notEqual(a.dev, otherDevice.dev);
  assert.notEqual(a.ino, otherDevice.ino);
  assert.equal(BigInt(a.dev), exact.dev);
  assert.equal(BigInt(a.ino), exact.ino);
  assert.equal(sample(large, large + 1n, false).ino, b.ino);
  for (const s of [a, b, otherDevice]) {
    assert.equal(Number.isSafeInteger(s.dev), true);
    assert.equal(Number.isSafeInteger(s.ino), true);
    assert.equal(s.isFile(), true);
  }
});

test("synthetic safe-ID lstat and handle samples preserve native links, renames, metadata and scope", async (t) => {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-safe-id-control-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "modeled"),
    outside = path.join(base, "outside");
  await fs.mkdir(root);
  const a = path.join(root, "a"),
    b = path.join(root, "b"),
    link = path.join(root, "link"),
    renamed = path.join(root, "renamed");
  await fs.writeFile(a, "first fixture");
  await fs.writeFile(b, "second fixture");
  await fs.writeFile(outside, "unmodeled fixture");
  const native = await fs.lstat(a),
    nativeOutside = await fs.lstat(outside, { bigint: true });
  installSyntheticSafeFileIds(t, root);
  const first = await fs.lstat(a),
    second = await fs.lstat(b);
  assert.notEqual(first.ino, second.ino);
  for (const field of [
    "size",
    "mode",
    "nlink",
    "mtimeMs",
    "ctimeMs",
    "birthtimeMs",
    "atimeMs",
  ] as const)
    assert.equal(first[field], native[field], field);
  assert.equal(first.isFile(), native.isFile());
  assert.equal((await fs.lstat(root)).isDirectory(), true);
  assert.equal(first.mtime.getTime(), native.mtime.getTime());
  await fs.link(a, link);
  await fs.rename(a, renamed);
  const h = await fs.open(renamed, "r");
  try {
    const numeric = await h.stat(),
      exact = await h.stat({ bigint: true }),
      fromLink = await fs.lstat(link, { bigint: true });
    assert.equal(numeric.ino, first.ino);
    assert.equal(exact.ino, BigInt(first.ino));
    assert.equal(fromLink.ino, exact.ino);
    assert.equal(fromLink.dev, exact.dev);
    assert.equal(numeric.nlink, 2);
    assert.equal(exact.nlink, 2n);
    assert.equal(numeric.mtimeMs, first.mtimeMs);
  } finally {
    await h.close();
  }
  const unchanged = await fs.lstat(outside, { bigint: true });
  assert.equal(unchanged.dev, nativeOutside.dev);
  assert.equal(unchanged.ino, nativeOutside.ino);
  const outsideHandle = await fs.open(outside, "r");
  try {
    assert.equal(
      (await outsideHandle.stat({ bigint: true })).ino,
      nativeOutside.ino,
    );
  } finally {
    await outsideHandle.close();
  }
});
