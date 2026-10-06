import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeLeaseRequest,
  encodeLeaseControl,
  decodeLeaseResponse,
  LEASE_LIMITS,
} from "../lease-protocol.mjs";
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
function reply(phase = 1, size = 0n) {
  const b = Buffer.alloc(92);
  b.write("AVR2");
  b[4] = phase;
  request.nonce.copy(b, 8);
  b.writeUInt32LE(64, 24);
  b.write("AVM2", 28);
  b[32] = 1;
  b[33] = 5;
  b.writeBigUInt64LE(12n, 36);
  b.writeBigUInt64LE(34n, 44);
  b.writeBigUInt64LE(size, 52);
  b.writeUInt32LE(1, 60);
  b.writeUInt32LE(32, 64);
  return b;
}
test("lease wire has separate version and nonce with fixed ACL/file-only mode", () => {
  const f = encodeLeaseRequest(request, 123);
  assert.equal(f.readUInt32LE(0), f.length - 4);
  assert.equal(f.subarray(4, 8).toString(), "AVL2");
  assert.deepEqual(f.subarray(8, 24), request.nonce);
  assert.equal(f.subarray(24, 28).toString(), "AVM2");
  for (const patch of [
    { mode: "locality" },
    { directory: true },
    { allowMissingLeaf: true },
    { nonce: Buffer.alloc(16) },
    { nonce: Buffer.alloc(15) },
  ])
    assert.throws(() => encodeLeaseRequest({ ...request, ...patch }, 123));
});
test("controls bind exact nonce and distinguish release/cancel", () => {
  for (const kind of ["release", "cancel"]) {
    const b = encodeLeaseControl(kind, request.nonce);
    assert.equal(b.readUInt32LE(), 24);
    assert.equal(b.subarray(4, 8).toString(), "AVC2");
    assert.equal(b[8], kind === "release" ? 1 : 2);
    assert.deepEqual(b.subarray(12), request.nonce);
  }
  assert.throws(() => encodeLeaseControl("renew", request.nonce));
});
test("ready requires empty single-link ordinary private file", () => {
  assert.equal(decodeLeaseResponse(reply(), request).phase, "ready");
  assert.throws(() => decodeLeaseResponse(reply(1, 1n), request));
  for (const change of [
    (b) => (b[33] = 7),
    (b) => b.writeUInt32LE(2, 60),
    (b) => b.writeUInt32LE(0x400, 64),
    (b) => (b[32] = 0),
  ]) {
    const b = reply();
    change(b);
    assert.throws(() => decodeLeaseResponse(b, request));
  }
});
test("released uses final bounded size rather than initial-empty predicate", () => {
  assert.equal(decodeLeaseResponse(reply(2, 16n), request).identity.size, "16");
  assert.throws(() =>
    decodeLeaseResponse(reply(2, BigInt(LEASE_LIMITS.copyBytes) + 1n), request),
  );
});
test("stale nonce, unknown phase, reserved bytes, lengths and old magic refuse", () => {
  for (const change of [
    (b) => (b[8] ^= 1),
    (b) => (b[4] = 5),
    (b) => (b[5] = 1),
    (b) => (b[6] = 1),
    (b) => (b[7] = 1),
    (b) => (b[0] ^= 1),
    (b) => b.writeUInt32LE(63, 24),
  ]) {
    const b = reply();
    change(b);
    assert.throws(() => decodeLeaseResponse(b, request));
  }
  assert.throws(() => decodeLeaseResponse(reply().subarray(0, 91), request));
  assert.throws(() =>
    decodeLeaseResponse(Buffer.concat([reply(), Buffer.from([0])]), request),
  );
});
test("refusal cannot carry private success while cancelled metadata remains bounded", () => {
  assert.throws(() => decodeLeaseResponse(reply(3), request));
  assert.equal(decodeLeaseResponse(reply(4, 17n), request).phase, "cancelled");
  assert.throws(() =>
    decodeLeaseResponse(reply(4, BigInt(LEASE_LIMITS.copyBytes) + 1n), request),
  );
  const b = reply(3);
  b.fill(0, 32);
  b[32] = 2;
  assert.equal(decodeLeaseResponse(b, request).outcome, "invalid-request");
});

test("outer magic compares all8 bits rather than ASCII-masking high bits", () => {
  for (let i = 0; i < 4; i++) {
    const b = reply();
    b[i] |= 0x80;
    assert.throws(() => decodeLeaseResponse(b, request));
  }
});
