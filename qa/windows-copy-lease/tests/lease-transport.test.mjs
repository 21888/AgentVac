import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  acquireGeneratedLease,
  ownedGeneratedLeaseCount,
} from "../lease-transport.mjs";
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
function frame(phase = 1) {
  const b = Buffer.alloc(96);
  b.writeUInt32LE(92);
  b.write("AVR2", 4);
  b[8] = phase;
  request.nonce.copy(b, 12);
  b.writeUInt32LE(64, 28);
  b.write("AVM2", 32);
  b[36] = 1;
  b[37] = 5;
  b.writeBigUInt64LE(12n, 40);
  b.writeBigUInt64LE(34n, 48);
  b.writeUInt32LE(1, 64);
  b.writeUInt32LE(32, 68);
  return b;
}
function child() {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kills = 0;
  c.closed = false;
  c.exited = false;
  c.once("exit", () => {
    c.exited = true;
  });
  c.kill = () => {
    c.kills++;
    return true;
  };
  c.finish = async (code = 0) => {
    if (c.closed) return;
    c.closed = true;
    if (!c.exited) c.emit("exit", code, null);
    c.stdout.end();
    await new Promise((r) => setImmediate(r));
    c.emit("close", code, null);
  };
  return c;
}
async function ready(c) {
  const p = acquireGeneratedLease({
    spawnPinned: () => c,
    request,
    reapMs: 20,
  });
  c.stdout.write(frame());
  return p;
}
test("transport admits ready once and releases only after terminal EOF and child close", async () => {
  const c = child(),
    l = await ready(c);
  assert.equal(l.isLive(), true);
  const p = l.release();
  let done = false;
  p.then(() => (done = true));
  c.stdout.write(frame(2));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  await c.finish();
  const value = await p;
  assert.equal(value.teardownConfirmed, true);
  assert.equal(l.isLive(), false);
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("duplicate READY invalidates live lease and retains ownership until close", async () => {
  const c = child(),
    l = await ready(c);
  c.stdout.write(frame());
  assert.equal(l.isLive(), false);
  assert.ok(c.kills);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  await c.finish();
  assert.equal(ownedGeneratedLeaseCount(), 0);
  await assert.rejects(l.release(), /RELEASE_STATE/);
});
test("stale nonce refuses before usable ready", async () => {
  const c = child(),
    p = acquireGeneratedLease({ spawnPinned: () => c, request });
  const bad = frame();
  bad[12] ^= 1;
  c.stdout.write(bad);
  await assert.rejects(p, /INVALID_OUTPUT/);
  assert.ok(c.kills);
  await c.finish();
});
test("premature child exit after READY invalidates fence and cannot release", async () => {
  const c = child(),
    l = await ready(c);
  await c.finish(1);
  assert.equal(l.isLive(), false);
  await assert.rejects(l.release(), /RELEASE_STATE/);
});
test("duplicate release cannot send a second control", async () => {
  const c = child(),
    l = await ready(c);
  let controls = 0;
  c.stdin.on("data", (b) => {
    if (b.subarray(4, 8).toString() === "AVC2") controls++;
  });
  const p = l.release();
  await assert.rejects(l.release(), /RELEASE_STATE/);
  c.stdout.write(frame(2));
  await c.finish();
  await p;
  assert.equal(controls, 1);
});
test("deadline retains unreaped child admission and refuses a third helper", async () => {
  const a = child(),
    b = child();
  const p = acquireGeneratedLease({
      spawnPinned: () => a,
      request,
      deadlineMs: 5,
    }),
    q = acquireGeneratedLease({ spawnPinned: () => b, request, deadlineMs: 5 });
  await Promise.all([
    assert.rejects(p, /DEADLINE/),
    assert.rejects(q, /DEADLINE/),
  ]);
  assert.equal(ownedGeneratedLeaseCount(), 2);
  let spawned = 0;
  await assert.rejects(
    acquireGeneratedLease({
      spawnPinned: () => {
        spawned++;
        return child();
      },
      request,
    }),
    /ADMISSION_BUSY/,
  );
  assert.equal(spawned, 0);
  await a.finish();
  await b.finish();
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("cancel waits boundedly without falsely releasing admission", async () => {
  const c = child(),
    l = await ready(c);
  const result = await l.abort();
  assert.equal(result.teardownConfirmed, false);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  assert.equal(l.isLive(), false);
  await c.finish();
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("normal nonce-bound cancel can close cleanly", async () => {
  const c = child(),
    l = await ready(c);
  const p = l.abort();
  c.stdout.write(frame(4));
  await c.finish();
  assert.equal((await p).teardownConfirmed, true);
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("nonfinite/over-budget timeouts and pre-cancel never spawn", async () => {
  let calls = 0;
  for (const deadlineMs of [NaN, Infinity, 0, 31001])
    await assert.rejects(
      acquireGeneratedLease({
        spawnPinned: () => {
          calls++;
          return child();
        },
        request,
        deadlineMs,
      }),
      /INVALID_LIMITS/,
    );
  const x = new AbortController();
  x.abort();
  await assert.rejects(
    acquireGeneratedLease({
      spawnPinned: () => {
        calls++;
        return child();
      },
      request,
      signal: x.signal,
    }),
    /CANCELLED/,
  );
  assert.equal(calls, 0);
});

test("observed exit revokes liveness immediately while admission waits for close", async () => {
  const c = child(),
    l = await ready(c);
  c.emit("exit", 1, null);
  assert.equal(l.isLive(), false);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  await assert.rejects(l.release(), /RELEASE_STATE/);
  await c.finish(1);
  assert.equal(ownedGeneratedLeaseCount(), 0);
});
test("clean releasing exit can precede buffered terminal data without early success", async () => {
  const c = child(),
    l = await ready(c);
  const p = l.release();
  c.emit("exit", 0, null);
  assert.equal(l.isLive(), false);
  assert.equal(ownedGeneratedLeaseCount(), 1);
  c.stdout.write(frame(2));
  await c.finish();
  assert.equal((await p).teardownConfirmed, true);
});
