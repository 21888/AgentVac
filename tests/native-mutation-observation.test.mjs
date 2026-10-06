import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inferredMutationReasonCodes,
  recordDuplicateMutationObservation,
} from "../scripts/native-mutation-observation.mjs";

const marker = "DO_NOT_LOG_SECRET_7f062b";
const paths = [
  `/Users/${marker}/private/codex/log`,
  `C:\\Users\\${marker}\\private\\codex.log`,
  `\\\\server\\${marker}\\codex.log`,
  `/tmp/${marker}/source -> /tmp/${marker}/target`,
];
const hostile = [
  ...paths,
  `codex --api-key=${marker} --session=/private/session`,
  `dialogue: the confidential value is ${marker}`,
  `unknown error ${marker}\nAGENTVAC_DUPLICATE_MUTATION injected`,
];
function observe(rows) {
  const lines = [];
  const observation = recordDuplicateMutationObservation(rows, (line) =>
    lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(
    JSON.parse(lines[0].slice("AGENTVAC_DUPLICATE_MUTATION ".length)),
    observation,
  );
  assert.ok(!lines[0].includes(marker));
  return { observation, line: lines[0] };
}
const rowsFor = (error, completed = 0) => [
  {
    status: "fulfilled",
    value: {
      completed,
      bytes: marker,
      batchId: marker,
      failed: [{ path: paths[0], error }],
    },
  },
  { status: "rejected", error: hostile[4], reason: marker },
];

test("records returned counts/status and failed-array ordinals without raw fields", () => {
  assert.deepEqual(observe(rowsFor("源文件已变化。")).observation, {
    requestCount: 2,
    displayedRequestCount: 2,
    omittedRequestCount: 0,
    displayedFulfilledCount: 1,
    displayedRejectedCount: 1,
    displayedInvalidStatusCount: 0,
    requests: [
      {
        requestOrdinal: 1,
        status: "fulfilled",
        inferredBatchStatus: "failed",
        completed: 0,
        failedCount: 1,
        omittedFailedItemCount: 0,
        failedItems: [
          {
            failedItemOrdinal: 1,
            inferredReasonCodes: ["INFERRED_ENGINE_SOURCE_CHANGED"],
          },
        ],
      },
      { requestOrdinal: 2, status: "rejected" },
    ],
  });
});

const knownReasons = [
  ["无法确认进程状态，已阻止文件操作。", "INFERRED_ENGINE_PROCESS_UNKNOWN"],
  ["检测到 Codex 正在运行，请退出后重试。", "INFERRED_ENGINE_PROCESS_RUNNING"],
  [
    "操作已取消；已停止后续文件修改，已执行步骤保留可恢复记录。",
    "INFERRED_ENGINE_CANCELLED",
  ],
  [
    "提供方或目录已切换，旧操作已失效。",
    "INFERRED_ENGINE_OPERATION_INVALIDATED",
  ],
  ["源文件已变化。", "INFERRED_ENGINE_SOURCE_CHANGED"],
  [
    "文件自扫描后发生变化，已跳过；请重新扫描。",
    "INFERRED_ENGINE_SOURCE_CHANGED_SINCE_SCAN",
  ],
  ["根目录已被替换，请重新选择目录。", "INFERRED_ENGINE_ROOT_REPLACED"],
];
for (const [index, [message, code]] of knownReasons.entries()) {
  test(`public engine reason ${index + 1} stays distinguishable`, () => {
    assert.deepEqual(inferredMutationReasonCodes(message), [code]);
    const { line } = observe(rowsFor(message));
    assert.ok(line.includes(code));
    assert.ok(!line.includes(message));
    assert.deepEqual(inferredMutationReasonCodes(message + marker), [
      "UNCLASSIFIED",
    ]);
  });
}

for (const [index, secret] of hostile.entries()) {
  test(`generated sensitive payload ${index + 1} cannot enter output`, () => {
    const { line, observation } = observe(rowsFor(secret));
    assert.ok(!line.includes(secret));
    assert.deepEqual(
      observation.requests[0].failedItems[0].inferredReasonCodes,
      ["UNCLASSIFIED"],
    );
    assert.deepEqual(
      observe(rowsFor("目录路径含链接或非目录，已拒绝：" + secret)).observation
        .requests[0].failedItems[0].inferredReasonCodes,
      ["INFERRED_ENGINE_PARENT_NOT_PLAIN"],
    );
    for (const errno of [
      "EACCES",
      "EPERM",
      "ENOENT",
      "EIO",
      "EXDEV",
      "ENOSPC",
      "EROFS",
    ]) {
      assert.deepEqual(
        observe(rowsFor(`${errno}: private detail ${secret}`)).observation
          .requests[0].failedItems[0].inferredReasonCodes,
        [`INFERRED_ERRNO_${errno}`],
      );
    }
  });
}

test("unknown errno and embedded known text are never promoted or emitted", () => {
  for (const value of [
    "ENOPE: " + marker,
    marker + " EACCES: ignored",
    marker + "源文件已变化。",
  ])
    assert.deepEqual(
      observe(rowsFor(value)).observation.requests[0].failedItems[0]
        .inferredReasonCodes,
      ["UNCLASSIFIED"],
    );
});

test("known engine movement wrappers retain fixed cause and rollback codes", () => {
  const prefix = "移动已完成或部分完成，记录待协调；请刷新隔离记录。";
  assert.deepEqual(
    observe(rowsFor(prefix + "源文件已变化。")).observation.requests[0]
      .failedItems[0].inferredReasonCodes,
    [
      "INFERRED_ENGINE_MOVE_RECONCILIATION_PENDING",
      "INFERRED_ENGINE_SOURCE_CHANGED",
    ],
  );
  assert.deepEqual(
    observe(
      rowsFor(
        prefix +
          "无法确认进程状态，已阻止文件操作。 回滚尚未完成；数据仍保留：EACCES: " +
          paths[0],
      ),
    ).observation.requests[0].failedItems[0].inferredReasonCodes,
    [
      "INFERRED_ENGINE_MOVE_RECONCILIATION_PENDING",
      "INFERRED_ENGINE_PROCESS_UNKNOWN",
      "INFERRED_ENGINE_ROLLBACK_PENDING",
      "INFERRED_ERRNO_EACCES",
    ],
  );
  for (const [text, code] of [
    ["整组隔离尚未移动任何成员：", "INFERRED_ENGINE_UNIT_NOT_MOVED"],
    ["整组隔离失败，已安全恢复原位：", "INFERRED_ENGINE_UNIT_ROLLED_BACK"],
  ])
    assert.deepEqual(
      observe(rowsFor(text + marker)).observation.requests[0].failedItems[0]
        .inferredReasonCodes,
      [code, "UNCLASSIFIED"],
    );
});

test("malformed values cannot serialize raw objects, strings, or toJSON output", () => {
  const dangerous = {
    toString() {
      throw new Error(marker);
    },
    toJSON() {
      throw new Error(marker);
    },
  };
  for (const value of [
    null,
    undefined,
    marker,
    dangerous,
    NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const { observation } = observe([
      {
        status: "fulfilled",
        value: {
          completed: value,
          failed: [{ path: dangerous, error: value }],
        },
      },
    ]);
    assert.equal(observation.requests[0].completed, null);
    assert.deepEqual(
      observation.requests[0].failedItems[0].inferredReasonCodes,
      ["UNCLASSIFIED"],
    );
  }
  assert.equal(
    observe([{ status: marker, value: dangerous }]).observation
      .displayedInvalidStatusCount,
    1,
  );
  assert.equal(observe(marker).observation.requestCount, null);
  assert.equal(
    observe([{ status: "fulfilled", value: marker }]).observation.requests[0]
      .inferredBatchStatus,
    "invalid_result",
  );
  assert.equal(
    observe([{ status: "fulfilled", value: { completed: 1, failed: marker } }])
      .observation.requests[0].failedCount,
    null,
  );
});

test("derived outcomes label completed, empty and partial result counts accurately", () => {
  for (const [completed, failed, status] of [
    [1, [], "completed"],
    [0, [], "empty"],
    [1, [{ error: marker }], "partial_failure"],
  ])
    assert.equal(
      observe([{ status: "fulfilled", value: { completed, failed } }])
        .observation.requests[0].inferredBatchStatus,
      status,
    );
  const requests = rowsFor(marker);
  requests[0].value.failed.push({ path: paths[1], error: marker });
  assert.deepEqual(
    observe(requests).observation.requests[0].failedItems.map(
      (item) => item.failedItemOrdinal,
    ),
    [1, 2],
  );
});

test("actual harness segment emits before duplicate/count failures with original assertions", () => {
  const source = readFileSync(
    new URL("../scripts/desktop-e2e.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "      // Emit only allowlisted counts/statuses",
  );
  const end = source.indexOf("      const first = await page.evaluate(", start);
  assert.ok(start >= 0 && end > start);
  const segment = source.slice(start, end);
  const originalAssertions = [
    'assert.equal(rows.filter((row) => row.status === "fulfilled").length, 1);',
    'assert.equal(rows.filter((row) => row.status === "rejected").length, 1);',
    "assert.equal(batch.completed, 1);",
    "assert.deepEqual(batch.failed, []);",
  ];
  for (const assertion of originalAssertions)
    assert.ok(segment.includes(assertion));
  const run = new Function(
    "rows",
    "results",
    "recordDuplicateMutationObservation",
    "assert",
    segment,
  );
  for (const rows of [
    [],
    [rowsFor(marker)[0], rowsFor(marker)[0]],
    rowsFor(marker),
  ]) {
    const lines = [],
      results = {};
    assert.throws(
      () =>
        run(
          rows,
          results,
          (input) =>
            recordDuplicateMutationObservation(input, (line) =>
              lines.push(line),
            ),
          assert,
        ),
      { name: "AssertionError" },
    );
    assert.equal(lines.length, 1);
    assert.ok(results.duplicateMutationObservation);
    assert.ok(!lines[0].includes(marker));
  }
  const good = rowsFor(marker, 1);
  good[0].value.failed = [];
  assert.doesNotThrow(() =>
    run(
      good,
      {},
      (input) => recordDuplicateMutationObservation(input, () => {}),
      assert,
    ),
  );
});
