import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { createObservationHost } from "../electron/process-argv-linux/host-internal.js";
import {
  HOST_LIMITS,
  normalizeRequests,
  parseRequestFrame,
  ResultFrames,
  validateResult,
} from "../electron/process-argv-linux/protocol.js";
import type { ArgumentResult } from "../electron/process-argv-linux/types.js";
import { decodeStrictJson } from "../electron/process-argv-linux/strict-json.js";
import { resolvePackagedWorker } from "../electron/process-argv-linux/host-path.js";

const requests = [{ pid: 4242, expectedParentPid: 21 }];
const observed: ArgumentResult = {
  status: "verified",
  platform: "linux",
  source: "linux-proc",
  pid: 4242,
  parentPid: 21,
  startId: "12345",
  executablePath: "/synthetic/node",
  argv: ["node", "/SDK spaces/--option/entry", "", "later.js", "later.py"],
};
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const valid = () =>
  Buffer.concat([
    line({ v: 1, index: 0, result: observed }),
    line({ v: 1, done: true }),
  ]);
function unavailable(value: ArgumentResult[], reason: string, length = 1) {
  assert.ok(
    value.length === length &&
      value.every(
        (result) => result.status === "unavailable" && result.reason === reason,
      ),
    `Expected only sanitized ${reason} refusals`,
  );
  assert.ok(
    value.every(
      (result) => Object.keys(result).sort().join(",") === "pid,reason,status",
    ),
    "No argument or native error fields escape",
  );
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  kills = 0;
  kill() {
    this.kills++;
    return true;
  }
  close(code = 0) {
    this.emit("close", code, null);
  }
  asChild() {
    return this as unknown as ChildProcess;
  }
}
function fakeHost(deadlineMs = 150) {
  const children: FakeChild[] = [];
  const host = createObservationHost({
    deadlineMs,
    spawn() {
      const child = new FakeChild();
      children.push(child);
      return child.asChild();
    },
  });
  return { host, children };
}

test("request schema is bounded, reconstructive and rejects path/options injection", () => {
  for (const invalid of [
    null,
    {},
    Array(65).fill({ pid: 1 }),
    [{ pid: -1 }],
    [{ pid: 1, signal: {} }],
    [{ pid: 1, helperPath: "/other" }],
    [{ pid: 1, expectedExecutablePath: "relative" }],
    [{ pid: 1, expectedStartId: "1e4" }],
    [{ pid: 1, expectedExecutablePath: "/bad\npath" }],
  ]) {
    assert.ok(normalizeRequests(invalid) === null);
  }
  assert.ok(normalizeRequests(Array(64).fill({ pid: 1 }))?.length === 64);
  assert.ok(parseRequestFrame(line({ v: 1, requests }))?.length === 1);
  assert.ok(
    parseRequestFrame(line({ v: 1, requests, raw: "private" })) === null,
  );
  assert.ok(parseRequestFrame(Buffer.from([0xff])) === null);
});

test("strict wire JSON refuses duplicate keys, escaped aliases and depth/key/item/node floods", () => {
  for (const value of [
    '{"v":1,"v":2}',
    '{"pid":1,"\\u0070id":2}',
    '{"nested":{"pid":1,"pid":2}}',
    "[".repeat(7) + "0" + "]".repeat(7),
    JSON.stringify(
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, i])),
    ),
    JSON.stringify(Array(513).fill(0)),
    JSON.stringify(Array.from({ length: 512 }, () => [1, 2, 3, 4])),
    '{"a":1,}',
    "[1,]",
    '{"a":1e999}',
  ]) {
    assert.throws(
      () => decodeStrictJson(value),
      "Ambiguous or unbounded wire JSON must fail",
    );
  }
  const bytes = Buffer.from(
    '{"v":1,"requests":[{"pid":4242,"\\u0070id":4243}]}',
  );
  assert.ok(parseRequestFrame(bytes) === null);
  const parser = new ResultFrames(requests);
  assert.ok(
    !parser.push(Buffer.from('{"v":1,"done":true,"\\u0064one":false}\n')),
  );
});

test("worker location is fixed for packaged main, source host and native harness layouts", () => {
  const expected = "/app/root/dist-electron/process-argv-worker.cjs";
  assert.ok(
    resolvePackagedWorker("/app/root/dist-electron", true) === expected,
  );
  assert.ok(
    resolvePackagedWorker("/app/root/electron/process-argv-linux", false) ===
      expected,
  );
  assert.ok(
    resolvePackagedWorker("/app/root/.qa/native-harness", true) === expected,
  );
  assert.ok(
    resolvePackagedWorker("/app/root/.qa/native-harness", false) === expected,
  );
  assert.ok(
    resolvePackagedWorker("/app/resources/app.asar/dist-electron", true) ===
      "/app/resources/app.asar.unpacked/dist-electron/process-argv-worker.cjs",
  );
  assert.throws(() => resolvePackagedWorker("/arbitrary/directory", true));
});

test("result protocol preserves precise vectors and reconstructs accepted fields", () => {
  const parser = new ResultFrames(requests);
  const bytes = valid();
  for (let offset = 0; offset < bytes.length; offset += 3)
    assert.ok(parser.push(bytes.subarray(offset, offset + 3)));
  const result = parser.finish();
  assert.ok(
    JSON.stringify(result?.[0]) === JSON.stringify(observed),
    "Synthetic vector and metadata round-trip",
  );
  parser.clear();
});

test("omitted result indices remain unavailable in the original input order", () => {
  const parser = new ResultFrames([...requests, { pid: 4243 }]);
  assert.ok(parser.push(line({ v: 1, done: true })));
  unavailable(parser.finish()!, "unavailable", 2);
});

test("malformed, duplicate, unbounded, trailing and mismatched protocol records are rejected", () => {
  const malformed: Buffer[] = [
    Buffer.from("{bad}\n"),
    Buffer.from([0xff, 10]),
    line({ v: 2, done: true }),
    line({ v: 1, index: 0, result: { ...observed, pid: 9999 } }),
    line({ v: 1, index: 0, result: { ...observed, parentPid: 9999 } }),
    line({ v: 1, index: 0, result: { ...observed, argv: ["private\nvalue"] } }),
    line({ v: 1, index: 0, result: { ...observed, nativeError: "private" } }),
    line({
      v: 1,
      index: 0,
      result: { status: "unavailable", pid: 4242, reason: "private failure" },
    }),
    Buffer.concat([
      line({ v: 1, index: 0, result: observed }),
      line({ v: 1, index: 0, result: observed }),
    ]),
    Buffer.concat([valid(), Buffer.from("extra\n")]),
    Buffer.alloc(HOST_LIMITS.frameBytes + 1, 65),
  ];
  for (const bytes of malformed) {
    const parser = new ResultFrames(requests);
    assert.ok(!parser.push(bytes), "Malformed synthetic frame is refused");
    assert.ok(parser.finish() === null);
  }
  const partial = new ResultFrames(requests);
  partial.push(Buffer.from('{"v":1'));
  assert.ok(partial.finish() === null);
});

test("wire validation enforces byte/count/identity boundaries and rejects lossy text", () => {
  for (const change of [
    { argv: ["x".repeat(65536)] },
    { argv: Array(513).fill("") },
    { argv: ["\ud800"] },
    { executablePath: "/deleted (deleted)" },
    { executablePath: "/" + "x".repeat(4096) },
    { startId: "18446744073709551616" },
  ]) {
    assert.ok(validateResult({ ...observed, ...change }, requests[0]) === null);
  }
  assert.ok(
    validateResult({ ...observed, argv: ["x".repeat(65535)] }, requests[0])
      ?.status === "verified",
  );
  assert.ok(
    validateResult(observed, { pid: 4242, expectedStartId: "other" }) === null,
  );
});

test("successful host responses wait for owned child close before becoming verified", async () => {
  const { host, children } = fakeHost();
  let resolved = false;
  const pending = host.collect(requests).then((result) => {
    resolved = true;
    return result;
  });
  const bytes = valid();
  children[0].stdout.write(bytes);
  assert.ok(
    bytes.every((byte) => byte === 0),
    "Consumed pipe bytes are wiped",
  );
  children[0].emit("exit", 0);
  await delay(5);
  assert.ok(!resolved && host.activeCount() === 1);
  children[0].close();
  assert.ok(
    (await pending)[0].status === "verified" && host.activeCount() === 0,
  );
});

test("invalid requests, empty requests and pre-cancellation never spawn", async () => {
  const { host, children } = fakeHost();
  assert.ok((await host.collect([])).length === 0);
  assert.ok((await host.collect(Array(65).fill({ pid: 1 }))).length === 0);
  unavailable(await host.collect([{ pid: -1 }]), "invalid-request");
  const controller = new AbortController();
  controller.abort();
  unavailable(await host.collect(requests, controller.signal), "cancelled");
  assert.ok(children.length === 0);
});

test("max two workers, timed-out admission retained until close, no exit-based early release", async () => {
  const { host, children } = fakeHost(20);
  const first = host.collect(requests),
    second = host.collect(requests);
  unavailable(await host.collect(requests), "unavailable");
  assert.ok(children.length === 2);
  unavailable(await first, "timeout");
  unavailable(await second, "timeout");
  assert.ok(
    children.every((child) => child.kills === 1) && host.activeCount() === 2,
  );
  children[0].emit("exit", 0);
  unavailable(await host.collect(requests), "unavailable");
  children[0].close();
  const replacement = host.collect(requests);
  assert.ok(Number(children.length) === 3 && host.activeCount() === 2);
  children[2].stdout.write(valid());
  children[2].close();
  assert.ok((await replacement)[0].status === "verified");
  children[1].close();
  assert.ok(host.activeCount() === 0);
});

test("spawn errors, malformed stdout and cancellation resolve promptly but retain ownership", async () => {
  for (const kind of ["error", "malformed", "cancel"] as const) {
    const { host, children } = fakeHost();
    const controller = new AbortController();
    const pending = host.collect(requests, controller.signal);
    if (kind === "error")
      children[0].emit("error", new Error("PRIVATE_NATIVE_ERROR"));
    else if (kind === "malformed")
      children[0].stdout.write(Buffer.from("invalid\n"));
    else controller.abort();
    unavailable(
      await pending,
      kind === "error"
        ? "unavailable"
        : kind === "malformed"
          ? "invalid-data"
          : "cancelled",
    );
    assert.ok(children[0].kills === 1 && host.activeCount() === 1);
    const late = valid();
    children[0].stdout.write(late);
    assert.ok(
      late.every((byte) => byte === 0),
      "Late discarded pipe bytes are wiped",
    );
    children[0].close();
    assert.ok(host.activeCount() === 0);
  }
});

test("synchronous spawn failure leaves no admission and no native error", async () => {
  const host = createObservationHost({
    spawn() {
      throw new Error("PRIVATE_SPAWN_FAILURE");
    },
  });
  unavailable(await host.collect(requests), "unavailable");
  assert.ok(host.activeCount() === 0);
});

test("shutdown cancels exact owned handles and waits for close without releasing blocked slots", async () => {
  const { host, children } = fakeHost();
  const pending = host.collect(requests);
  let closed = false;
  const shutdown = host.shutdown().then(() => {
    closed = true;
  });
  unavailable(await pending, "cancelled");
  await delay(5);
  assert.ok(!closed && host.activeCount() === 1 && children[0].kills === 1);
  children[0].close();
  await shutdown;
  assert.ok(closed && host.activeCount() === 0);
});

test("shutdown is bounded for a never-closing child and truthfully retains pending ownership", async () => {
  const { host, children } = fakeHost();
  const pending = host.collect(requests);
  const start = Date.now();
  const result = await host.shutdown();
  unavailable(await pending, "cancelled");
  assert.ok(
    Date.now() - start < 1000 && result.closed === 0 && result.pending === 1,
  );
  assert.ok(
    host.activeCount() === 1,
    "Shutdown timeout does not release admission",
  );
  host.killForExit();
  assert.ok(
    children[0].kills === 2,
    "Exit cleanup retries only its retained owned handle",
  );
  children[0].close();
  assert.ok(host.activeCount() === 0);
});

test("shutdown permanently closes admission before snapshotting active workers", async () => {
  const { host, children } = fakeHost();
  const pending = host.collect(requests);
  const closing = host.shutdown();
  unavailable(await host.collect(requests), "unavailable");
  assert.ok(children.length === 1, "Shutdown admits no concurrent worker");
  children[0].close();
  unavailable(await pending, "cancelled");
  const result = await closing;
  assert.ok(result.closed === 1 && result.pending === 0);
  unavailable(await host.collect(requests), "unavailable");
  assert.ok(
    children.length === 1,
    "Completed shutdown never reopens admission",
  );
});

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let scratch = "",
  worker = "";
before(async () => {
  scratch = await mkdtemp(
    path.join(root, "electron/process-argv-linux/test-fixtures-"),
  );
  worker = path.join(scratch, "process-argv-worker.cjs");
  await build({
    entryPoints: [path.join(root, "electron/process-argv-linux/worker.ts")],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  });
  await writeFile(path.join(scratch, "package.json"), '{"type":"commonjs"}');
});
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const activeChildren = new Set<ChildProcess>();
function launchOwned(file: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, [file, ...args], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "1" },
    shell: false,
  });
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
function actualHost(file = worker, deadlineMs = 2000) {
  const owned: ChildProcess[] = [];
  const host = createObservationHost({
    deadlineMs,
    spawn() {
      const child = launchOwned(file);
      owned.push(child);
      return child;
    },
  });
  return { host, owned };
}

async function withTarget(
  kind: "node" | "python",
  extension: string,
  action: (
    child: ChildProcessWithoutNullStreams,
    expected: string[],
  ) => Promise<void>,
) {
  const directory = path.join(scratch, "SDK spaced --root", "--option-looking");
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, `entry runner${extension}`);
  await writeFile(
    script,
    kind === "node"
      ? "process.stdin.resume(); process.stdout.write('ready\\n');"
      : "import sys\nprint('ready', flush=True)\nfor line in sys.stdin: pass\n",
  );
  const executable = kind === "node" ? process.execPath : "/usr/bin/python3";
  const args = [
    script,
    "--literal-after-entry",
    "",
    "later.js",
    "later.py",
    "space value",
    "café😀",
  ];
  const child = spawn(executable, args, {
    stdio: "pipe",
    env: {},
    shell: false,
  });
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  child.stderr.resume();
  try {
    const ready = await Promise.race([
      once(child.stdout, "data").then(() => true),
      once(child, "error").then(() => false),
      delay(3000).then(() => false),
    ]);
    assert.ok(ready && child.pid, "Owned synthetic target started");
    await action(child, [executable, ...args]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
}

for (const [kind, extension] of [
  ["node", ".js"],
  ["node", ""],
  ["python", ".py"],
  ["python", ""],
] as const) {
  test(
    `isolated worker captures actual ${kind} ${extension || "extensionless"} spaced entry paths exactly`,
    { skip: process.platform !== "linux" },
    async () => {
      await withTarget(kind, extension, async (child, expected) => {
        const { host, owned } = actualHost();
        const result = await host.collect([
          { pid: child.pid!, expectedParentPid: process.pid },
        ]);
        assert.ok(
          result.length === 1 && result[0].status === "verified",
          "Actual child observation is verified",
        );
        if (result[0].status === "verified") {
          assert.ok(
            JSON.stringify(result[0].argv) === JSON.stringify(expected),
            "No spaces, late literals or empty arguments are lost",
          );
          assert.ok(
            result[0].parentPid === process.pid &&
              result[0].startId.length > 0 &&
              result[0].executablePath.startsWith("/"),
          );
        }
        assert.ok(
          host.activeCount() === 0 &&
            owned.every((worker) => worker.exitCode !== null),
          "Workers are closed before success",
        );
        await host.shutdown();
      });
    },
  );
}

test(
  "real fixed worker is located by bundled CJS main and ESM native-harness driver",
  { skip: process.platform !== "linux" },
  async () => {
    const output = path.join(scratch, "dist-electron");
    const qa = path.join(scratch, ".qa/native-harness");
    await mkdir(output, { recursive: true });
    await mkdir(qa, { recursive: true });
    await copyFile(worker, path.join(output, "process-argv-worker.cjs"));
    for (const format of ["cjs", "esm"] as const) {
      const file = path.join(
        format === "cjs" ? output : qa,
        format === "cjs" ? "main.cjs" : "native-provider-driver.mjs",
      );
      await build({
        stdin: {
          resolveDir: root,
          contents: `import {collectLinuxArgumentObservations} from './electron/process-argv-linux/host.ts'; (async()=>{const r=await collectLinuxArgumentObservations([{pid:Number(process.argv[2])}]); process.stdout.write(JSON.stringify({observed:r.length===1&&r[0].status==='verified'}));})();`,
        },
        outfile: file,
        bundle: true,
        platform: "node",
        format,
        target: "node22",
        logLevel: "silent",
      });
      await withTarget("node", "", async (target) => {
        const driver = launchOwned(file, [String(target.pid)]);
        let bytes = Buffer.alloc(0);
        driver.stdout!.on("data", (chunk) => {
          if (bytes.length + chunk.length <= 100)
            bytes = Buffer.concat([bytes, chunk]);
        });
        await once(driver, "close");
        assert.ok(
          driver.exitCode === 0 && bytes.toString() === '{"observed":true}',
          "Fixed bundled worker path performs a real observation",
        );
      });
    }
  },
);

test(
  "actual blocked worker times out without blocking parent and closes with no orphan",
  { skip: process.platform !== "linux" },
  async () => {
    const blocked = path.join(scratch, "blocked-worker.cjs");
    await writeFile(
      blocked,
      "process.stdin.resume(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);",
    );
    const { host, owned } = actualHost(blocked, 80);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const begin = Date.now();
    unavailable(await host.collect(requests), "timeout");
    clearInterval(timer);
    assert.ok(
      Date.now() - begin < 500 && ticks >= 3,
      "Parent remains responsive while child blocks",
    );
    await host.shutdown();
    assert.ok(
      host.activeCount() === 0 &&
        owned.every((child) => child.signalCode === "SIGKILL"),
      "Every timed-out owned child closes",
    );
  },
);

test(
  "actual cancellation terminates its own worker and retains no orphan",
  { skip: process.platform !== "linux" },
  async () => {
    const blocked = path.join(scratch, "cancel-worker.cjs");
    await writeFile(
      blocked,
      "process.stdin.resume(); setInterval(()=>{},1000);",
    );
    const { host, owned } = actualHost(blocked);
    const controller = new AbortController();
    const pending = host.collect(requests, controller.signal);
    await delay(30);
    controller.abort();
    unavailable(await pending, "cancelled");
    await host.shutdown();
    assert.ok(
      host.activeCount() === 0 &&
        owned.every((child) => child.signalCode === "SIGKILL"),
    );
  },
);

test(
  "actual malformed/overflow worker output is refused and every worker closes",
  { skip: process.platform !== "linux" },
  async () => {
    for (const overflow of [false, true]) {
      const malformed = path.join(scratch, `malformed-${overflow}.cjs`);
      await writeFile(
        malformed,
        overflow
          ? `process.stdout.write(Buffer.alloc(${HOST_LIMITS.frameBytes + 1},65));setInterval(()=>{},1000);`
          : "process.stdout.write('invalid protocol\\n');setInterval(()=>{},1000);",
      );
      const { host, owned } = actualHost(malformed);
      unavailable(await host.collect(requests), "invalid-data");
      await host.shutdown();
      assert.ok(
        host.activeCount() === 0 &&
          owned.every((child) => child.signalCode === "SIGKILL"),
      );
    }
  },
);

test(
  "packaged worker exits on parent input EOF before any request",
  { skip: process.platform !== "linux" },
  async () => {
    const child = launchOwned(worker);
    const closed = once(child, "close");
    child.stdin!.end();
    await closed;
    assert.ok(child.exitCode === 0, "Worker observes parent EOF and exits");
  },
);

test("all directly spawned synthetic workers and targets have closed", () => {
  assert.ok(
    activeChildren.size === 0,
    "No owned worker/fixture remains after completed tests",
  );
});
