import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNativeFixtureRefusal,
  requireNativeFixtureRefusal,
  requireInvalidControlRefusal,
} from "../lease-oracles.mjs";
const refusal = (outcome, reason = "none") =>
  Object.freeze({
    code: "LEASE_NATIVE_REFUSED",
    verifiedTerminalRefusal: true,
    nativeOutcome: outcome,
    nativeReason: reason,
  });
test("generic unavailable capabilities cannot pass any intended native negative", () => {
  for (const kind of ["broad", "nonempty", "hardlink", "deleteAccess"])
    for (const outcome of [
      "metadata-unavailable",
      "context-rejected",
      "caller-rejected",
      "locality-rejected",
      "identity-unavailable",
    ]) {
      const e = refusal(outcome);
      assert.equal(classifyNativeFixtureRefusal(e, kind), "blocked");
      assert.throws(
        () => requireNativeFixtureRefusal(e, kind),
        (x) => x === e,
      );
    }
});
test("native shape and sharing negatives require exact successful-site reason", () => {
  for (const [kind, outcome, reason] of [
    ["broad", "acl-rejected", "none"],
    ["nonempty", "identity-unavailable", "initial-file-nonempty"],
    ["hardlink", "identity-unavailable", "initial-file-hardlink"],
    ["deleteAccess", "metadata-unavailable", "sharing-conflict"],
  ]) {
    const e = refusal(outcome, reason);
    assert.equal(classifyNativeFixtureRefusal(e, kind), "expected");
    assert.doesNotThrow(() => requireNativeFixtureRefusal(e, kind));
    assert.equal(
      classifyNativeFixtureRefusal(
        { ...e, verifiedTerminalRefusal: false },
        kind,
      ),
      "unverified",
    );
  }
});
test("control rejection requires actual nonce-bound terminal invalid-request witness", () => {
  const valid = {
      phase: "refused",
      outcome: "invalid-request",
      reason: "none",
      nonceBound: true,
      teardownConfirmed: true,
    },
    exit = { code: 0, signal: null };
  assert.doesNotThrow(() => requireInvalidControlRefusal(valid, exit));
  for (const patch of [
    { phase: "released" },
    { outcome: "verified-private" },
    { outcome: "metadata-unavailable" },
    { reason: "initial-file-hardlink" },
    { nonceBound: false },
    { teardownConfirmed: false },
  ])
    assert.throws(() =>
      requireInvalidControlRefusal({ ...valid, ...patch }, exit),
    );
  for (const e of [
    { code: 1, signal: null },
    { code: 0, signal: "SIGTERM" },
    undefined,
  ])
    assert.throws(() => requireInvalidControlRefusal(valid, e));
  assert.throws(() => requireInvalidControlRefusal(undefined, exit));
});
