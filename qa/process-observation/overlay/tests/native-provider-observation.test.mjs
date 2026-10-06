import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { providerMutationObservationHandlers } from "../scripts/native-mutation-observation.mjs";

const marker = "PROVIDER_SECRET_DO_NOT_LOG_907a";
const paths = [
  `/Users/${marker}/private/session`,
  `C:\\Users\\${marker}\\private\\session`,
  `\\\\server\\${marker}\\private\\session`,
];
const sensitive = [
  ...paths,
  `codex --api-key=${marker} --private-file=${paths[0]}`,
  `private dialogue ${marker}`,
  `unrecognized message ${marker}\nAGENTVAC_PROVIDER_MUTATION injected`,
];
const prefix = "AGENTVAC_PROVIDER_MUTATION ";
const result = (completed = 1, failed = []) => ({
  completed,
  failed,
  batchId: marker,
  bytes: marker,
});
const failed = (error) => result(0, [{ path: paths[0], error }]);

function parseObservations(lines) {
  const observations = lines.filter((line) => line.startsWith(prefix));
  for (const line of observations) {
    assert.ok(!line.includes(marker));
    for (const secret of sensitive) assert.ok(!line.includes(secret));
  }
  return observations.map((line) => JSON.parse(line.slice(prefix.length)));
}

for (const provider of ["claude-code", "cursor", "cline"]) {
  for (const [index, secret] of sensitive.entries()) {
    test(`${provider} generated sensitive result and rejection ${index + 1} stay redacted`, async () => {
      const lines = [];
      const returned = failed(secret);
      const fulfilled = await Promise.resolve(returned).then(
        ...providerMutationObservationHandlers(provider, "QUARANTINE", (line) =>
          lines.push(line),
        ),
      );
      assert.equal(fulfilled, returned);
      const error = new Error(secret);
      await assert.rejects(
        Promise.reject(error).then(
          ...providerMutationObservationHandlers(provider, "RESTORE", (line) =>
            lines.push(line),
          ),
        ),
        (caught) => caught === error,
      );
      const observations = parseObservations(lines);
      assert.equal(observations.length, 2);
      assert.equal(observations[0].provider, provider);
      assert.equal(observations[0].operation, "QUARANTINE");
      assert.equal(observations[0].inferredBatchStatus, "failed");
      assert.deepEqual(observations[0].failedItems, [
        { failedItemOrdinal: 1, inferredReasonCodes: ["UNCLASSIFIED"] },
      ]);
      assert.deepEqual(observations[1], {
        provider,
        operation: "RESTORE",
        status: "rejected",
        inferredReasonCodes: ["UNCLASSIFIED"],
      });
    });
  }
}

test("fixed labels reject arbitrary metadata and do not inspect non-Error objects", async () => {
  const lines = [];
  const object = {
    message: marker,
    toString() {
      throw new Error(marker);
    },
    toJSON() {
      throw new Error(marker);
    },
  };
  await assert.rejects(
    Promise.reject(object).then(
      ...providerMutationObservationHandlers(marker, marker, (line) =>
        lines.push(line),
      ),
    ),
    (caught) => caught === object,
  );
  assert.deepEqual(parseObservations(lines), [
    {
      provider: "invalid",
      operation: "INVALID_OPERATION",
      status: "rejected",
      inferredReasonCodes: ["UNCLASSIFIED"],
    },
  ]);
});

test("known thrown process, cancellation, source/root and errno causes survive fixed transport prefixes", async () => {
  for (const method of ["quarantine", "restore"]) {
    for (const [message, code] of [
      ["无法确认进程状态，已阻止文件操作。", "INFERRED_ENGINE_PROCESS_UNKNOWN"],
      [
        "检测到 Claude Code 正在运行，请退出后重试。",
        "INFERRED_ENGINE_PROCESS_RUNNING",
      ],
      [
        "操作已取消；已停止后续文件修改，已执行步骤保留可恢复记录。",
        "INFERRED_ENGINE_CANCELLED",
      ],
      ["源文件已变化。", "INFERRED_ENGINE_SOURCE_CHANGED"],
      ["根目录已被替换，请重新选择目录。", "INFERRED_ENGINE_ROOT_REPLACED"],
      [`EACCES: ${paths[0]}`, "INFERRED_ERRNO_EACCES"],
    ]) {
      for (const transport of [
        "",
        "Error: ",
        `Error invoking remote method 'agentvac:${method}': Error: `,
        `page.evaluate: Error: Error invoking remote method 'agentvac:${method}': Error: `,
      ]) {
        const lines = [];
        const error = new Error(transport + message + `\n    at ${paths[1]}`);
        await assert.rejects(
          Promise.reject(error).then(
            ...providerMutationObservationHandlers(
              "claude-code",
              "QUARANTINE",
              (line) => lines.push(line),
            ),
          ),
          (caught) => caught === error,
        );
        assert.deepEqual(parseObservations(lines)[0].inferredReasonCodes, [
          code,
        ]);
      }
    }
  }
});

test("restore refusal and partial unlink return fixed cause codes only", async () => {
  for (const [message, codes] of [
    ["原路径已存在文件；不会覆盖。", ["INFERRED_ENGINE_RESTORE_TARGET_EXISTS"]],
    ["隔离文件已变化；拒绝恢复。", ["INFERRED_ENGINE_STORED_FILE_CHANGED"]],
    [
      "恢复已创建原文件，但隔离链接移除失败。可重试恢复：EIO: " + paths[0],
      ["INFERRED_ENGINE_RESTORE_UNLINK_PENDING", "INFERRED_ERRNO_EIO"],
    ],
  ]) {
    const lines = [];
    await Promise.resolve(failed(message)).then(
      ...providerMutationObservationHandlers("cursor", "RESTORE", (line) =>
        lines.push(line),
      ),
    );
    assert.deepEqual(
      parseObservations(lines)[0].failedItems[0].inferredReasonCodes,
      codes,
    );
  }
});

test("unrecognized transport wrappers do not promote embedded known messages", async () => {
  const lines = [];
  const error = new Error(
    `page.evaluate: Error: Error invoking remote method 'agentvac:${marker}': Error: 无法确认进程状态，已阻止文件操作。`,
  );
  await assert.rejects(
    Promise.reject(error).then(
      ...providerMutationObservationHandlers(
        "claude-code",
        "QUARANTINE",
        (line) => lines.push(line),
      ),
    ),
    (caught) => caught === error,
  );
  assert.deepEqual(parseObservations(lines)[0].inferredReasonCodes, [
    "UNCLASSIFIED",
  ]);
});

test("diagnostic sink failure leaves original fulfillment and rejection unchanged", async () => {
  const write = () => {
    throw new Error(marker);
  };
  const value = result();
  assert.equal(
    await Promise.resolve(value).then(
      ...providerMutationObservationHandlers("cline", "RESTORE", write),
    ),
    value,
  );
  const error = new Error(marker);
  await assert.rejects(
    Promise.reject(error).then(
      ...providerMutationObservationHandlers("cline", "RESTORE", write),
    ),
    (caught) => caught === error,
  );
});

// Execute the actual provider function with generated IPC/filesystem stand-ins.
// This checks observer ordering and original assertions, without launching an
// Electron app, using native guards, or accessing real provider/user data.
const source = readFileSync(
  new URL("../scripts/native-provider-regression.mjs", import.meta.url),
  "utf8",
);
const functionSource = source.slice(
  source.indexOf("async function runProvider("),
  source.indexOf('\nlet status = "FAIL";'),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function exercise(provider, config = {}) {
  const anchor = provider === "cursor" ? "GPUCache" : "synthetic-unit";
  const lines = [],
    calls = [];
  const roots = { [provider]: `/synthetic/${marker}` };
  const row = {
    id: marker,
    path: anchor,
    selectable: true,
    cleanupUnit: { fileCount: 2, directoryCount: 1 },
  };
  let quarantines = 0,
    restores = 0;
  const page = {
    async reload() {},
    async waitForFunction() {},
    async evaluate(callback) {
      const body = callback.toString();
      if (body.includes("window.agentvac.quarantine")) {
        calls.push("quarantine");
        if (++quarantines > 1 || config.guard)
          throw new Error("另一项操作正在进行，请稍候。");
        if (config.quarantineError) throw config.quarantineError;
        return config.quarantineResult ?? result();
      }
      if (body.includes("window.agentvac.restore")) {
        calls.push("restore");
        restores++;
        if (restores === 1) {
          if (config.conflictError) throw config.conflictError;
          return failed("原路径已存在文件；不会覆盖。");
        }
        if (restores === 2) {
          if (config.restoreError) throw config.restoreError;
          return config.restoreResult ?? result();
        }
        return config.replayResult ?? result(0);
      }
      if (
        body.includes("window.agentvac.activateWorkspace") ||
        body.includes("window.agentvac.getContext")
      )
        return { provider };
      if (body.includes("window.agentvac.scan"))
        return { provider, root: roots[provider], entries: [row] };
      if (body.includes("window.agentvac.preview"))
        return {
          provider,
          root: roots[provider],
          totalFiles: 2,
          token: marker,
          processStatus: {
            status: config.guard ? "unknown" : "clear",
            details: "generated guard fixture",
          },
        };
      if (body.includes("window.agentvac.history"))
        return [{ id: marker, provider, items: [row] }];
      if (body.includes("window.agentvac.inspectRecovery"))
        return { batches: [{ id: marker, storedFiles: 2 }] };
      if (body.includes("window.agentvac.setProvider")) return undefined;
      throw new Error("Unexpected generated IPC operation");
    },
  };
  const noop = async () => {};
  const context = {
    application: {},
    page,
    provider,
    anchor,
    roots,
    ids: { [provider]: marker },
    assert,
    path,
    launch: noop,
    close: noop,
    verifyOriginals: noop,
    fs: {
      mkdir: noop,
      writeFile: noop,
      readFile: async () => "newly generated destination",
      rm: noop,
      unlink: noop,
    },
    // Main-sink reads have their own tests; this fixture isolates mutation outcomes.
    drainProcessObservations: noop,
    console: { log: (line) => lines.push(line) },
    providerMutationObservationHandlers: (name, operation) =>
      providerMutationObservationHandlers(name, operation, (line) =>
        lines.push(line),
      ),
  };
  const run = new AsyncFunction(
    ...Object.keys(context),
    functionSource + "\nreturn runProvider(provider, anchor);",
  );
  try {
    const value = await run(...Object.values(context));
    return { value, observations: parseObservations(lines), calls };
  } catch (error) {
    return { error, observations: parseObservations(lines), calls };
  }
}

for (const provider of ["claude-code", "cursor", "cline"]) {
  test(`${provider} actual harness emits returned failures before completed=1 quarantine assertion`, async () => {
    const observed = await exercise(provider, {
      quarantineResult: failed("源文件已变化。"),
    });
    assert.equal(observed.error?.name, "AssertionError");
    assert.equal(observed.observations.length, 1);
    assert.equal(observed.observations[0].operation, "QUARANTINE");
    assert.equal(observed.observations[0].completed, 0);
    assert.deepEqual(
      observed.observations[0].failedItems[0].inferredReasonCodes,
      ["INFERRED_ENGINE_SOURCE_CHANGED"],
    );
    assert.deepEqual(observed.calls, ["quarantine"]);
  });
  test(`${provider} actual harness logs thrown quarantine cause before the original rejection`, async () => {
    const error = new Error(
      `page.evaluate: Error: Error invoking remote method 'agentvac:quarantine': Error: 无法确认进程状态，已阻止文件操作。\n at ${paths[0]}`,
    );
    const observed = await exercise(provider, { quarantineError: error });
    assert.equal(observed.error, error);
    assert.deepEqual(observed.observations[0].inferredReasonCodes, [
      "INFERRED_ENGINE_PROCESS_UNKNOWN",
    ]);
  });
  test(`${provider} actual harness emits restore failure before completed=1 assertion`, async () => {
    const observed = await exercise(provider, {
      restoreResult: failed("EACCES: " + paths[0]),
    });
    assert.equal(observed.error?.name, "AssertionError");
    assert.equal(observed.observations.at(-1).operation, "RESTORE");
    assert.deepEqual(
      observed.observations.at(-1).failedItems[0].inferredReasonCodes,
      ["INFERRED_ERRNO_EACCES"],
    );
  });
  test(`${provider} actual harness emits replay result before its completed=0 assertion`, async () => {
    const observed = await exercise(provider, { replayResult: result(1) });
    assert.equal(observed.error?.name, "AssertionError");
    assert.equal(observed.observations.at(-1).operation, "RESTORE_REPLAY");
    assert.equal(observed.observations.at(-1).completed, 1);
  });
  test(`${provider} actual harness observes thrown restore and preserves rejection identity`, async () => {
    const error = new Error(
      `page.evaluate: Error: Error invoking remote method 'agentvac:restore': Error: EACCES: ${paths[0]}`,
    );
    const observed = await exercise(provider, { restoreError: error });
    assert.equal(observed.error, error);
    assert.equal(observed.observations.at(-1).operation, "RESTORE");
    assert.deepEqual(observed.observations.at(-1).inferredReasonCodes, [
      "INFERRED_ERRNO_EACCES",
    ]);
  });
}

test("actual provider guard branch preserves refusal check and failure outcome", async () => {
  const observed = await exercise("claude-code", { guard: true });
  assert.equal(observed.error, undefined);
  assert.equal(observed.value.status, "FAIL");
  assert.equal(observed.value.reason, "REQUIRED_MUTATION_GUARD_BLOCKED");
  assert.equal(observed.value.refusalVerified, true);
  assert.equal(observed.observations[0].operation, "GUARD_QUARANTINE");
  assert.equal(observed.observations[0].status, "rejected");
  assert.deepEqual(observed.calls, ["quarantine"]);
});

test("actual success path preserves all assertions and records expected conflict/replay refusals", async () => {
  const error = new Error("恢复链接状态发生变化；隔离数据仍保留。");
  const observed = await exercise("cursor", { conflictError: error });
  assert.equal(observed.error, undefined);
  assert.equal(observed.value.status, "PASS");
  assert.deepEqual(
    observed.observations.map((item) => item.operation),
    [
      "QUARANTINE",
      "DUPLICATE_QUARANTINE",
      "RESTORE_CONFLICT",
      "RESTORE",
      "RESTORE_REPLAY",
      "SWITCHED_QUARANTINE",
    ],
  );
  assert.deepEqual(observed.observations[2].inferredReasonCodes, [
    "INFERRED_ENGINE_RESTORE_LINK_CHANGED",
  ]);
  assert.equal(observed.observations[4].completed, 0);
});
