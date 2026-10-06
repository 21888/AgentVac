import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { acquireFixtureDeleteHolder } from "../fixture-delete-holder.mjs";
import { ownedGeneratedLeaseCount } from "../lease-transport.mjs";
const request = {
  scope: "C:\\Research\\inherited-fixture-" + "1".repeat(32),
  path:
    "C:\\Research\\inherited-fixture-" +
    "1".repeat(32) +
    "\\private\\empty.bin",
  mode: "acl",
  directory: false,
  allowMissingLeaf: false,
  nonce: Buffer.alloc(16, 7),
};
function frame(phase = 1, code = 1) {
  const b = Buffer.alloc(28);
  b.writeUInt32LE(24);
  b.write("AVD2", 4);
  b[8] = phase;
  b[9] = code;
  request.nonce.copy(b, 12);
  return b;
}
function child() {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => true;
  c.exited = false;
  c.once("exit", () => (c.exited = true));
  c.finish = async () => {
    if (!c.exited) c.emit("exit", 0, null);
    c.stdout.end();
    await new Promise((r) => setImmediate(r));
    c.emit("close", 0, null);
  };
  return c;
}
async function acquire(c) {
  const p = acquireFixtureDeleteHolder({ spawnPinned: () => c, request });
  c.stdout.write(frame());
  return p;
}
test("DELETE actor exposes holding lifetime, never a copy-ready capability", async () => {
  const c = child(),
    holder = await acquire(c);
  assert.equal(holder.isHolding(), true);
  assert.equal(holder.ready, undefined);
  assert.equal(holder.isLive, undefined);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  const p = holder.release();
  c.stdout.write(frame(2));
  await c.finish();
  const r = await p;
  assert.equal(r.outcome, "verified-delete-holder");
  assert.equal(r.teardownConfirmed, true);
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("DELETE actor and containment helpers share the same bounded ownership pool", async () => {
  const a = child(),
    b = child(),
    one = await acquire(a),
    two = await acquire(b);
  let calls = 0;
  await assert.rejects(
    acquireFixtureDeleteHolder({
      spawnPinned: () => {
        calls++;
        return child();
      },
      request,
    }),
    /ADMISSION_BUSY/,
  );
  assert.equal(calls, 0);
  const p = one.abort(),
    q = two.abort();
  a.stdout.write(frame(4));
  b.stdout.write(frame(4));
  await a.finish();
  await b.finish();
  assert.equal((await p).teardownConfirmed, true);
  assert.equal((await q).teardownConfirmed, true);
});
test("DELETE actor observed exit revokes holding before close", async () => {
  const c = child(),
    h = await acquire(c);
  c.emit("exit", 0, null);
  assert.equal(h.isHolding(), false);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  await c.finish();
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("DELETE actor exact magic rejects high-bit aliases and wrong role", async () => {
  for (const magic of [Buffer.from([0xc1, 86, 68, 50]), Buffer.from("AVR2")]) {
    const c = child(),
      p = acquireFixtureDeleteHolder({ spawnPinned: () => c, request }),
      b = frame();
    magic.copy(b, 4);
    c.stdout.write(b);
    await assert.rejects(p, /INVALID_OUTPUT/);
    await c.finish();
  }
});
