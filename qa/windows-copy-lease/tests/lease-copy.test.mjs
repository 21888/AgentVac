import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyGeneratedFixtureUnderLease } from "../lease-copy.mjs";
import { LEASE_LIMITS } from "../lease-protocol.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t, data = Buffer.from("generated sentinel payload")) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-lease-copy-"));
  const source = await fs.open(path.join(root, "source"), "wx+");
  await source.write(data, 0, data.length, 0);
  const destination = await fs.open(path.join(root, "empty"), "wx+");
  t.after(async () => {
    await source.close().catch(() => {});
    await destination.close().catch(() => {});
    if (process.platform !== "win32")
      await fs.rm(root, { recursive: true, force: true });
  });
  const native = (s) => ({
    volume32: s.dev.toString(16).padStart(8, "0"),
    fileIndex64: s.ino.toString(16).padStart(16, "0"),
    size: String(s.size),
    links: Number(s.nlink),
  });
  let live = true,
    aborted = 0;
  const lease = {
    ready: {
      phase: "ready",
      outcome: "verified-private",
      identity: native(await destination.stat({ bigint: true })),
    },
    isLive: () => live,
    abort: async () => {
      aborted++;
      live = false;
    },
    release: async () => {
      const s = await destination.stat({ bigint: true });
      live = false;
      return {
        teardownConfirmed: true,
        phase: "released",
        outcome: "verified-private",
        identity: native(s),
      };
    },
  };
  return {
    root,
    source,
    destination,
    lease,
    data,
    args: {
      source,
      destination,
      lease,
      expectedBytes: data.length,
      expectedSha256: hash(data),
    },
    aborted: () => aborted,
    kill: () => {
      live = false;
    },
  };
}
test("generated fixture copy has exact bytes/hash and original source; not native ACL acceptance", async (t) => {
  const f = await fixture(t);
  const r = await copyGeneratedFixtureUnderLease(f.args);
  assert.equal(r.written, f.data.length);
  assert.equal(r.productionAccepted, false);
  assert.deepEqual(await fs.readFile(path.join(f.root, "empty")), f.data);
  assert.deepEqual(await fs.readFile(path.join(f.root, "source")), f.data);
});
test("hard total budget rejects before any destination write", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const original = f.destination.write.bind(f.destination);
  f.destination.write = async (...a) => {
    writes++;
    return original(...a);
  };
  await assert.rejects(
    copyGeneratedFixtureUnderLease({
      ...f.args,
      expectedBytes: LEASE_LIMITS.copyBytes + 1,
    }),
    /INVALID_BUDGET/,
  );
  assert.equal(writes, 0);
  assert.equal((await f.destination.stat()).size, 0);
});
test("partial writes are counted and next write stays inside remaining byte budget", async (t) => {
  const f = await fixture(t, Buffer.alloc(1025, 73));
  const original = f.destination.write.bind(f.destination);
  let called = 0,
    total = 0;
  f.destination.write = async (b, o, n, p) => {
    assert.ok(total + n <= f.data.length);
    called++;
    const r = await original(b, o, Math.min(n, 7), p);
    total += r.bytesWritten;
    return r;
  };
  const r = await copyGeneratedFixtureUnderLease(f.args);
  assert.equal(total, 1025);
  assert.equal(r.written, 1025);
  assert.ok(called > 100);
});
test("child exit between READY and first write preserves empty destination", async (t) => {
  const f = await fixture(t);
  const original = f.source.read.bind(f.source);
  f.source.read = async (...a) => {
    const r = await original(...a);
    f.kill();
    return r;
  };
  await assert.rejects(
    copyGeneratedFixtureUnderLease(f.args),
    /LEASE_COPY_LOST/,
  );
  assert.equal((await f.destination.stat()).size, 0);
});
test("wrong held identity refuses before copying", async (t) => {
  const f = await fixture(t);
  f.lease.ready.identity.fileIndex64 = "0000000000000001";
  await assert.rejects(
    copyGeneratedFixtureUnderLease(f.args),
    /DESTINATION_MISMATCH/,
  );
  assert.equal((await f.destination.stat()).size, 0);
});
test("destination handle closure/reopen cannot substitute another descriptor", async (t) => {
  const f = await fixture(t);
  const other = await fs.open(path.join(f.root, "other"), "wx+");
  t.after(() => other.close());
  const original = f.destination.stat.bind(f.destination);
  let calls = 0;
  f.destination.stat = async (...a) =>
    ++calls > 1 ? other.stat(...a) : original(...a);
  await assert.rejects(
    copyGeneratedFixtureUnderLease(f.args),
    /DESTINATION_CHANGED/,
  );
  assert.equal((await original()).size, 0);
  assert.equal((await other.stat()).size, 0);
});
test("cancellation while a write is pending aborts lease but retains write ownership until settlement", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = f.destination.write.bind(f.destination);
  let enter, finish;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (finish = r));
  let writes = 0,
    settled = false;
  f.destination.write = async (...a) => {
    writes++;
    enter();
    await gate;
    return original(...a);
  };
  const promise = copyGeneratedFixtureUnderLease({
    ...f.args,
    signal: controller.signal,
  }).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(
    promise,
    (error) =>
      error.code === "LEASE_COPY_CANCELLED" &&
      error.writtenKnown === f.data.length,
  );
  await entered;
  controller.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  assert.equal(f.aborted(), 1);
  finish();
  await rejected;
  assert.equal(writes, 1);
});
test("expected source hash mismatch preserves written fixture and never claims release success", async (t) => {
  const f = await fixture(t);
  let release = 0;
  f.lease.release = async () => {
    release++;
    throw Error("must not release successfully");
  };
  await assert.rejects(
    copyGeneratedFixtureUnderLease({
      ...f.args,
      expectedSha256: "0".repeat(64),
    }),
    /SOURCE_CHANGED/,
  );
  assert.equal(release, 0);
  assert.equal((await f.destination.stat()).size, f.data.length);
});
test("readback corruption is detected through original descriptor", async (t) => {
  const f = await fixture(t);
  const original = f.destination.read.bind(f.destination);
  f.destination.read = async (b, ...args) => {
    const r = await original(b, ...args);
    if (r.bytesRead) b[0] ^= 1;
    return r;
  };
  await assert.rejects(copyGeneratedFixtureUnderLease(f.args), /HASH_MISMATCH/);
});
test("released identity/size mismatch or still-live helper cannot be success", async (t) => {
  const f = await fixture(t);
  f.lease.release = async () => ({
    phase: "released",
    outcome: "verified-private",
    identity: { ...f.lease.ready.identity, size: String(f.data.length) },
  });
  await assert.rejects(
    copyGeneratedFixtureUnderLease(f.args),
    /RELEASE_UNVERIFIED/,
  );
});
