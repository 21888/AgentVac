import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TrashConsent } from "../src/trash-consent.js";
import type { AppContext, Batch, TrashConfirmation } from "../shared/types.js";
const context: AppContext = {
  root: "/generated-fixture",
  provider: "codex",
  demo: false,
  platform: "linux",
};
const batch: Batch = {
  id: randomUUID(),
  root: context.root!,
  provider: "codex",
  createdAt: new Date().toISOString(),
  items: [],
};
function prepared(
  state: TrashConsent,
  overrides: Partial<TrashConfirmation> = {},
) {
  const challenge: TrashConfirmation = {
    token: randomUUID(),
    batchId: batch.id,
    root: batch.root,
    provider: "codex",
    demo: false,
    expiresAt: Date.now() + 60000,
    ...overrides,
  };
  assert.equal(
    state.accept(state.generation(), challenge, batch, context),
    true,
  );
  return challenge;
}
function fill(state: TrashConsent) {
  state.impact = true;
  state.phrase = "回收站";
  state.confirmedClosed = true;
}

test("renderer requires separate closure plus impact and phrase, no truthy coercion", () => {
  const state = new TrashConsent();
  prepared(state);
  state.impact = true;
  state.phrase = "回收站";
  assert.equal(state.ready(batch, context, false, true, Date.now()), false);
  for (const value of [undefined, false, "true", 1, {}]) {
    state.confirmedClosed = value as boolean;
    assert.equal(
      state.consume(batch, context, false, true, Date.now()),
      undefined,
    );
  }
  state.confirmedClosed = true;
  assert.equal(state.ready(batch, context, false, true, Date.now()), true);
});
test("renderer consumes before awaiting and duplicate/busy clicks cannot submit", () => {
  const state = new TrashConsent(),
    challenge = prepared(state);
  fill(state);
  assert.equal(
    state.consume(batch, context, true, true, Date.now()),
    undefined,
  );
  assert.equal(
    state.consume(batch, context, false, false, Date.now()),
    undefined,
  );
  assert.deepEqual(state.consume(batch, context, false, true, Date.now()), [
    batch.id,
    true,
    true,
    challenge.token,
  ]);
  assert.equal(
    state.consume(batch, context, false, true, Date.now()),
    undefined,
  );
  assert.equal(state.impact, false);
  assert.equal(state.confirmedClosed, false);
  assert.equal(state.phrase, "");
  assert.equal(state.challenge, null);
});
test("cancel, retry and new-batch reset drop old or late preparation and every consent", () => {
  const state = new TrashConsent(),
    challenge = prepared(state),
    before = state.generation();
  fill(state);
  assert.equal(state.reset(), challenge.token);
  assert.equal(state.accept(before, challenge, batch, context), false);
  assert.equal(state.ready(batch, context, false, true, Date.now()), false);
  prepared(state);
  assert.equal(state.impact, false);
  assert.equal(state.confirmedClosed, false);
  assert.equal(state.phrase, "");
  fill(state);
  assert.equal(
    state.ready(
      { ...batch, id: randomUUID() },
      context,
      false,
      true,
      Date.now(),
    ),
    false,
  );
});
test("root, provider, demo context and expiry prevent stale renderer submission", () => {
  const state = new TrashConsent(),
    challenge = prepared(state);
  fill(state);
  for (const next of [
    { ...context, root: "/other" },
    { ...context, provider: "cursor" as const },
    { ...context, demo: true },
  ])
    assert.equal(
      state.consume(batch, next, false, true, Date.now()),
      undefined,
    );
  assert.equal(
    state.consume(batch, context, false, true, challenge.expiresAt),
    undefined,
  );
  const generation = state.generation();
  for (const change of [
    { batchId: randomUUID() },
    { provider: "cline" as const },
    { root: "/other" },
    { demo: true },
    { expiresAt: NaN },
    { expiresAt: Date.now() - 1 },
  ])
    assert.equal(
      state.accept(generation, { ...challenge, ...change }, batch, context),
      false,
    );
});
test("demo consent has no true-data bypass and still needs a new challenge", () => {
  const state = new TrashConsent(),
    demo = { ...context, demo: true };
  const challenge: TrashConfirmation = {
    token: randomUUID(),
    batchId: batch.id,
    root: batch.root,
    provider: "codex",
    demo: true,
    expiresAt: Date.now() + 60000,
  };
  assert.equal(state.accept(state.generation(), challenge, batch, demo), true);
  state.impact = true;
  state.phrase = "回收站";
  assert.equal(state.ready(batch, demo, false, true, Date.now()), false);
  state.confirmedClosed = true;
  assert.deepEqual(state.consume(batch, demo, false, true, Date.now()), [
    batch.id,
    true,
    true,
    challenge.token,
  ]);
});
