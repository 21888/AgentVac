import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NATIVE_MUTATION_OBSERVATION_LIMITS as limits,
  inferredMutationReasonCodes,
  recordDuplicateMutationObservation,
  providerMutationObservationHandlers,
} from "../scripts/native-mutation-observation.mjs";

const secret = "BOUNDS_SECRET_DO_NOT_LOG_624c";
const sourceChanged = "源文件已变化。";
const batch = (completed = 1, failed = []) => ({
  completed,
  failed,
  bytes: secret,
  batchId: secret,
});
const failure = (error = sourceChanged) => ({
  path: `/private/${secret}`,
  error,
});

function guardedTail(prefix, length) {
  const rows = [...prefix];
  rows.length = length;
  Object.defineProperty(rows, prefix.length, {
    get() {
      throw new Error("The diagnostic inspected an omitted tail");
    },
  });
  for (const method of ["map", "filter", "slice"])
    Object.defineProperty(rows, method, {
      get() {
        throw new Error("The diagnostic called an input array method");
      },
    });
  return rows;
}

function observe(rows, write) {
  const lines = [];
  const value = recordDuplicateMutationObservation(
    rows,
    write ?? ((line) => lines.push(line)),
  );
  for (const line of lines) {
    assert.ok(!line.includes(secret));
    assert.ok(line.length < 65536);
  }
  return { value, lines };
}

test("limits are fixed, small and immutable", () => {
  assert.deepEqual(limits, {
    requests: 8,
    failedItems: 8,
    messageCharacters: 2048,
  });
  assert.ok(Object.isFrozen(limits));
});

test("failed-item cap reads only its prefix and reports the exact omitted count", async () => {
  const failures = guardedTail(
    Array.from({ length: limits.failedItems }, () => failure()),
    100003,
  );
  const input = batch(7, failures);
  const lines = [];
  const returned = await Promise.resolve(input).then(
    ...providerMutationObservationHandlers("cursor", "RESTORE", (line) =>
      lines.push(line),
    ),
  );
  assert.equal(returned, input);
  assert.equal(input.failed, failures);
  assert.equal(input.completed, 7);
  const output = JSON.parse(
    lines[0].slice("AGENTVAC_PROVIDER_MUTATION ".length),
  );
  assert.equal(output.failedCount, 100003);
  assert.equal(output.omittedFailedItemCount, 100003 - limits.failedItems);
  assert.equal(output.failedItems.length, limits.failedItems);
  assert.equal(output.failedItems.at(-1).failedItemOrdinal, limits.failedItems);
  assert.ok(!lines[0].includes(secret));
});

test("duplicate request cap bounds both mapping and status counting", () => {
  const prefix = Array.from({ length: limits.requests }, (_, index) =>
    index < 4
      ? { status: "fulfilled", value: batch() }
      : { status: index < 7 ? "rejected" : secret },
  );
  const input = guardedTail(prefix, 100009);
  const { value } = observe(input);
  assert.equal(value.requestCount, 100009);
  assert.equal(value.displayedRequestCount, limits.requests);
  assert.equal(value.omittedRequestCount, 100009 - limits.requests);
  assert.equal(value.requests.length, limits.requests);
  assert.equal(value.displayedFulfilledCount, 4);
  assert.equal(value.displayedRejectedCount, 3);
  assert.equal(value.displayedInvalidStatusCount, 1);
  assert.ok(!Object.hasOwn(value, "fulfilledCount"));
  assert.ok(!Object.hasOwn(value, "rejectedCount"));
});

test("nested request and failure caps combine without traversing either tail", () => {
  const error =
    "移动已完成或部分完成，记录待协调；请刷新隔离记录。无法确认进程状态，已阻止文件操作。 回滚尚未完成；数据仍保留：EACCES: " +
    secret;
  const failures = guardedTail(
    Array.from({ length: limits.failedItems }, () => failure(error)),
    200003,
  );
  const rows = guardedTail(
    Array.from({ length: limits.requests }, () => ({
      status: "fulfilled",
      value: batch(0, failures),
    })),
    300007,
  );
  const { value, lines } = observe(rows);
  assert.equal(lines.length, 1);
  assert.equal(value.requests.length, limits.requests);
  for (const request of value.requests) {
    assert.equal(request.failedItems.length, limits.failedItems);
    assert.equal(request.omittedFailedItemCount, 200003 - limits.failedItems);
    assert.deepEqual(request.failedItems[0].inferredReasonCodes, [
      "INFERRED_ENGINE_MOVE_RECONCILIATION_PENDING",
      "INFERRED_ENGINE_PROCESS_UNKNOWN",
      "INFERRED_ENGINE_ROLLBACK_PENDING",
      "INFERRED_ERRNO_EACCES",
    ]);
  }
});

test("omitted counts are zero at the limits and unknown for malformed arrays", () => {
  const failures = Array.from({ length: limits.failedItems }, () => failure());
  const rows = Array.from({ length: limits.requests }, () => ({
    status: "fulfilled",
    value: batch(0, failures),
  }));
  const { value } = observe(rows);
  assert.equal(value.omittedRequestCount, 0);
  assert.ok(
    value.requests.every((request) => request.omittedFailedItemCount === 0),
  );
  const invalid = observe(secret).value;
  assert.equal(invalid.requestCount, null);
  assert.equal(invalid.omittedRequestCount, null);
  assert.equal(invalid.displayedRequestCount, 0);
  const malformed = observe([{ status: "fulfilled", value: batch(0, secret) }])
    .value.requests[0];
  assert.equal(malformed.failedCount, null);
  assert.equal(malformed.omittedFailedItemCount, null);
});

test("message input is capped before matching, splitting, hashing or regex work", () => {
  const stringMethods = ["startsWith", "indexOf", "split", "slice"];
  const originals = Object.fromEntries(
    stringMethods.map((name) => [name, String.prototype[name]]),
  );
  const originalGet = Map.prototype.get;
  const originalExec = RegExp.prototype.exec;
  let initialTruncations = 0;
  try {
    for (const name of stringMethods)
      String.prototype[name] = function (...args) {
        if (this.length > limits.messageCharacters) {
          if (
            name !== "slice" ||
            args[0] !== 0 ||
            args[1] !== limits.messageCharacters
          )
            throw new Error("Unbounded message inspection");
          initialTruncations++;
        }
        return originals[name].apply(this, args);
      };
    Map.prototype.get = function (key) {
      if (typeof key === "string" && key.length > limits.messageCharacters)
        throw new Error("Unbounded message map lookup");
      return originalGet.call(this, key);
    };
    RegExp.prototype.exec = function (input) {
      if (typeof input === "string" && input.length > limits.messageCharacters)
        throw new Error("Unbounded message regex");
      return originalExec.call(this, input);
    };
    const long = secret.repeat(10000);
    assert.deepEqual(inferredMutationReasonCodes(long), ["UNCLASSIFIED"]);
    assert.deepEqual(inferredMutationReasonCodes("EACCES: " + long), [
      "INFERRED_ERRNO_EACCES",
    ]);
    const error = new Error(
      "page.evaluate: Error: Error invoking remote method 'agentvac:restore': Error: EIO: " +
        long,
    );
    const lines = [];
    const handlers = providerMutationObservationHandlers(
      "cline",
      "RESTORE",
      (line) => lines.push(line),
    );
    assert.throws(
      () => handlers[1](error),
      (caught) => caught === error,
    );
    assert.ok(!lines[0].includes(secret));
    assert.deepEqual(
      JSON.parse(lines[0].slice("AGENTVAC_PROVIDER_MUTATION ".length))
        .inferredReasonCodes,
      ["INFERRED_ERRNO_EIO"],
    );
  } finally {
    for (const name of stringMethods) String.prototype[name] = originals[name];
    Map.prototype.get = originalGet;
    RegExp.prototype.exec = originalExec;
  }
  assert.equal(initialTruncations, 3);
});

test("message content beyond the cap cannot introduce a recognized reason", () => {
  for (const suffix of [
    sourceChanged,
    "EACCES: " + secret,
    " 回滚尚未完成；数据仍保留：EIO: " + secret,
  ])
    assert.deepEqual(
      inferredMutationReasonCodes(
        "x".repeat(limits.messageCharacters) + suffix,
      ),
      ["UNCLASSIFIED"],
    );
});

test("ordinary single-unit results and promise identities remain unchanged", async () => {
  const input = batch(0, [failure()]);
  const { value } = observe([
    { status: "fulfilled", value: input },
    { status: "rejected", error: secret },
  ]);
  assert.equal(value.requestCount, 2);
  assert.equal(value.displayedFulfilledCount, 1);
  assert.equal(value.displayedRejectedCount, 1);
  assert.equal(value.omittedRequestCount, 0);
  assert.equal(value.requests[0].failedCount, 1);
  assert.equal(value.requests[0].omittedFailedItemCount, 0);
  assert.deepEqual(value.requests[0].failedItems[0].inferredReasonCodes, [
    "INFERRED_ENGINE_SOURCE_CHANGED",
  ]);
  assert.equal(
    await Promise.resolve(input).then(
      ...providerMutationObservationHandlers("cline", "QUARANTINE", () => {}),
    ),
    input,
  );
  const error = new Error(secret.repeat(10000));
  await assert.rejects(
    Promise.reject(error).then(
      ...providerMutationObservationHandlers("cline", "QUARANTINE", () => {}),
    ),
    (caught) => caught === error,
  );
});

test("desktop sink exceptions cannot replace the original assertion failures", () => {
  const source = readFileSync(
    new URL("../scripts/desktop-e2e.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "      // Emit only allowlisted counts/statuses",
  );
  const end = source.indexOf("      const first = await page.evaluate(", start);
  const run = new Function(
    "rows",
    "results",
    "recordDuplicateMutationObservation",
    "assert",
    source.slice(start, end),
  );
  const write = () => {
    throw new Error(secret);
  };
  const recorder = (rows) => recordDuplicateMutationObservation(rows, write);
  for (const rows of [
    [],
    [
      { status: "fulfilled", value: batch(0, [failure()]) },
      { status: "rejected" },
    ],
  ]) {
    const results = {};
    assert.throws(() => run(rows, results, recorder, assert), {
      name: "AssertionError",
    });
    assert.ok(results.duplicateMutationObservation);
  }
  assert.doesNotThrow(() =>
    run(
      [{ status: "fulfilled", value: batch() }, { status: "rejected" }],
      {},
      recorder,
      assert,
    ),
  );
});
