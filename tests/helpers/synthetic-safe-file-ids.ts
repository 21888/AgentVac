import assert from "node:assert/strict";
import {
  promises as fs,
  Stats,
  type BigIntStats,
  type PathLike,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/** A test-only identity model, never a repair for real legacy journals.
 * The map keys come exclusively from exact native bigint samples. Distinct
 * (device,inode) pairs receive distinct small IDs; links and renamed handles
 * retain the same ID. No unsafe native identity is converted to a Number.
 */
export class SyntheticSafeFileIds {
  private devices = new Map<bigint, bigint>();
  private inodes = new Map<bigint, Map<bigint, bigint>>();
  private nextInode = 1n;

  sample(s: BigIntStats, bigint: boolean): BigIntStats | Stats {
    assert.equal(typeof s.dev, "bigint");
    assert.equal(typeof s.ino, "bigint");
    assert.ok(
      s.dev >= 0n && s.ino > 0n,
      "native fixture identity must be valid",
    );
    if (!this.devices.has(s.dev))
      this.devices.set(s.dev, BigInt(this.devices.size) + 1n);
    let deviceInodes = this.inodes.get(s.dev);
    if (!deviceInodes) {
      deviceInodes = new Map();
      this.inodes.set(s.dev, deviceInodes);
    }
    if (!deviceInodes.has(s.ino)) deviceInodes.set(s.ino, this.nextInode++);
    const dev = this.devices.get(s.dev)!,
      ino = deviceInodes.get(s.ino)!;
    assert.ok(dev <= BigInt(Number.MAX_SAFE_INTEGER));
    assert.ok(ino <= BigInt(Number.MAX_SAFE_INTEGER));
    if (bigint) return Object.assign(s, { dev, ino });

    // Build numeric Stats from that same exact sample, preserving Node's
    // submillisecond timestamps and Stats predicates. Only assigned IDs become
    // Numbers; native dev/ino never pass through numeric Stats or rounding.
    const numeric = Object.create(Stats.prototype) as Stats;
    for (const field of [
      "mode",
      "nlink",
      "uid",
      "gid",
      "rdev",
      "blksize",
      "size",
      "blocks",
    ] as const)
      numeric[field] = Number(s[field]);
    Object.assign(numeric, { dev: Number(dev), ino: Number(ino) });
    for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
      const ns = s[`${field}Ns`];
      let seconds = ns / 1_000_000_000n,
        remainder = ns % 1_000_000_000n;
      if (remainder < 0n) {
        seconds--;
        remainder += 1_000_000_000n;
      }
      numeric[`${field}Ms`] =
        Number(seconds) * 1000 + Number(remainder) / 1_000_000;
    }
    return numeric;
  }
}

/** Scope the model to one freshly generated fixture tree. Positive evidence
 * from this helper is synthetic safe-ID compatibility, not native NTFS legacy
 * compatibility. Use separate unmocked tests for unsupported native IDs.
 */
export function installSyntheticSafeFileIds(t: TestContext, root: string) {
  const model = new SyntheticSafeFileIds(),
    lstat = fs.lstat,
    open = fs.open;
  const inFixture = (p: PathLike) => {
    const absolute = path.resolve(
      p instanceof URL ? fileURLToPath(p) : String(p),
    );
    return absolute === root || absolute.startsWith(root + path.sep);
  };
  t.diagnostic(
    "identity-control=synthetic-safe-bijection; native-legacy-compatibility=not-established",
  );
  t.mock.method(fs, "lstat", async (p: PathLike, options?: any) => {
    if (!inFixture(p)) return (lstat as any)(p, options);
    return model.sample(await lstat(p, { bigint: true }), !!options?.bigint);
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const h = await open(...args);
    if (inFixture(args[0])) {
      const stat = h.stat.bind(h);
      t.mock.method(h, "stat", async (options?: any) =>
        model.sample(await stat({ bigint: true }), !!options?.bigint),
      );
    }
    return h;
  });
  return model;
}
