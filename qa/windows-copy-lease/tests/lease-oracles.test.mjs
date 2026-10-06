import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNativeFixtureRefusal,
  requireNativeFixtureRefusal,
  requireInvalidControlRefusal,
  requireHeldRenameRefusal,
  requireNoReadyUnderDeleteHolder,
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

test("rename witness requires a live lease and actual intended refusal", async () => {
  let attempts = 0;
  await assert.rejects(
    requireHeldRenameRefusal({ isLive: () => false }, async () => {
      attempts++;
    }),
    { code: "LEASE_LOST_AT_RENAME_ATTEMPT" },
  );
  assert.equal(attempts, 0);
  await assert.rejects(
    requireHeldRenameRefusal({ isLive: () => true }, async () => {}),
    { code: "LEASE_RENAME_SUCCEEDED" },
  );
  for (const code of ["ENOENT", "EINVAL", "EXDEV", undefined])
    await assert.rejects(
      requireHeldRenameRefusal({ isLive: () => true }, async () => {
        throw { code };
      }),
      { code: "LEASE_RENAME_UNEXPECTED_ERROR" },
    );
  for (const code of ["EPERM", "EACCES", "EBUSY"])
    await requireHeldRenameRefusal({ isLive: () => true }, async () => {
      throw { code };
    });
});
test("rename refusal after lease loss cannot prove containment", async () => {
  let live = true;
  await assert.rejects(
    requireHeldRenameRefusal({ isLive: () => live }, async () => {
      live = false;
      throw { code: "EACCES" };
    }),
    { code: "LEASE_LOST_DURING_RENAME" },
  );
});
test("unexpected native READY is a distinct failure even after clean cleanup", () => {
  assert.doesNotThrow(() => requireNoReadyUnderDeleteHolder(false));
  for (const value of [true, undefined, null, 0])
    assert.throws(() => requireNoReadyUnderDeleteHolder(value), {
      code: "LEASE_UNEXPECTED_READY_UNDER_DELETE_HOLDER",
    });
});

test("post-attempt loss is diagnosed before success or unexpected-error attribution", async () => {
  for (const outcome of ["success", "unexpected", "undefined-throw"]) {
    let live = true;
    await assert.rejects(
      requireHeldRenameRefusal({ isLive: () => live }, async () => {
        live = false;
        if (outcome === "unexpected") throw { code: "ENOENT" };
        if (outcome === "undefined-throw") throw undefined;
      }),
      { code: "LEASE_LOST_DURING_RENAME" },
    );
  }
  await assert.rejects(
    requireHeldRenameRefusal({ isLive: () => true }, async () => {
      throw undefined;
    }),
    { code: "LEASE_RENAME_UNEXPECTED_ERROR" },
  );
});
