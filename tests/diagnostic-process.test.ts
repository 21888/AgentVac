import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  runDiagnosticTransport,
  shutdownDiagnosticWorkers,
} from "../electron/diagnostic-process.js";
import {
  validateDiagnosticResult,
  diagnosticEnvironment,
} from "../electron/diagnostic-protocol.js";

const base = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const loaderArgs = ["--import", pathToFileURL(require.resolve("tsx/esm")).href];
const supervisor = path.resolve(base, "../electron/diagnostic-supervisor.ts");
const parser = pathToFileURL(
  path.resolve(base, "../electron/diagnostic-parser.ts"),
).href;
const runner = pathToFileURL(
  path.resolve(base, "../electron/diagnostic-process.ts"),
).href;
const SECRET = "synthetic-process-secret-not-for-output";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  fn: () => Promise<T | undefined>,
  timeout = 4000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(20);
  }
  throw new Error("synthetic condition timed out");
}
async function live(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      if (
        (await fs.readFile(`/proc/${pid}/stat`, "utf8")).match(/^\d+ \(.*\) Z /)
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
async function gone(pids: number[]) {
  await until(async () =>
    (await Promise.all(pids.map(live))).every((v) => !v) ? true : undefined,
  );
}
async function fixture(t: any) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-process-test-"),
  );
  t.after(async () => {
    await shutdownDiagnosticWorkers();
    // Electron virtualizes .asar paths as directories; cleanup must remove the
    // generated archive as a physical file, not recurse through virtual entries.
    const cleanupFs = process.versions.electron
      ? require("original-fs").promises
      : fs;
    await cleanupFs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const databasePath = path.join(source, "logs_2.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE logs(secret TEXT);`);
  db.prepare("INSERT INTO logs VALUES(?)").run(SECRET);
  db.close();
  const s = await fs.stat(databasePath, { bigint: true });
  const expected = [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink]
    .map(String)
    .join(":");
  const marker = path.join(root, "worker.json");
  return { root, source, databasePath, expected, marker };
}
async function snap(source: string) {
  const files: Record<string, unknown> = {};
  for (const name of await fs.readdir(source)) {
    const p = path.join(source, name),
      s = await fs.lstat(p, { bigint: true });
    files[name] = {
      size: String(s.size),
      mtime: String(s.mtimeNs),
      ctime: String(s.ctimeNs),
      hash: s.isFile()
        ? createHash("sha256")
            .update(await fs.readFile(p))
            .digest("hex")
        : "nonregular",
    };
  }
  return files;
}
async function workerFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  body: string,
) {
  const worker = path.join(f.root, "worker.mjs");
  await fs.writeFile(
    worker,
    `import {writeFileSync} from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(f.marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));${body}});`,
  );
  return { supervisor, worker, loaderArgs };
}
async function readMarker(p: string) {
  return until(async () => {
    try {
      return JSON.parse(await fs.readFile(p, "utf8")) as {
        pid: number;
        ppid: number;
      };
    } catch {
      return undefined;
    }
  });
}

test("strict process protocol drops unexpected keys, errors and impossible metrics", () => {
  assert.equal(
    validateDiagnosticResult({
      status: "blocked",
      reason: "READ_FAILED",
      body: SECRET,
    }),
    null,
  );
  assert.equal(
    validateDiagnosticResult({ status: "blocked", reason: SECRET }),
    null,
  );
  assert.equal(
    validateDiagnosticResult({
      status: "ok",
      schema: "codex-logs-v2",
      consistency: "stable-file-observations",
      sourceUnchanged: true,
      metrics: {
        pageSize: 4096,
        pageCount: 1,
        freelistCount: 2,
        freePageBytes: 8192,
        occupiedPageBytes: 0,
        autoVacuum: "incremental",
        journalMode: "wal",
      },
    }),
    null,
  );
});

test("blocked synchronous worker times out while caller event loop stays responsive", async (t) => {
  const f = await fixture(t),
    before = await snap(f.source);
  const launch = await workerFixture(
    f,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
  );
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  const result = await runDiagnosticTransport(f, { timeoutMs: 2500 }, launch);
  clearInterval(interval);
  const owned = await readMarker(f.marker);
  await gone([owned.pid, owned.ppid]);
  assert.equal(result.reason, "TIMEOUT");
  assert.ok(ticks >= 20);
  assert.deepEqual(await snap(f.source), before);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("explicit cancel and app shutdown await child exit; subsequent restart works", async (t) => {
  for (const mode of ["abort", "shutdown"] as const) {
    const f = await fixture(t),
      before = await snap(f.source);
    const launch = await workerFixture(
      f,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
    );
    const controller = new AbortController();
    const pending = runDiagnosticTransport(
      f,
      { signal: controller.signal, timeoutMs: 5000 },
      launch,
    );
    const owned = await readMarker(f.marker);
    if (mode === "abort") controller.abort();
    else await shutdownDiagnosticWorkers();
    assert.equal((await pending).reason, "CANCELLED");
    await gone([owned.pid, owned.ppid]);
    const normal = await workerFixture(
      f,
      `process.stdout.end(JSON.stringify({status:'blocked',reason:'UNKNOWN_SCHEMA',sourceUnchanged:true}));`,
    );
    const result = await runDiagnosticTransport(f, { timeoutMs: 2000 }, normal);
    assert.equal(result.reason, "UNKNOWN_SCHEMA");
    assert.deepEqual(await snap(f.source), before);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  }
});

test("malformed and oversized worker output is bounded, killed and never echoed", async (t) => {
  for (const body of [
    `process.stdout.write(JSON.stringify({status:'blocked',reason:'READ_FAILED',body:${JSON.stringify(SECRET)}}));`,
    `process.stdout.write(${JSON.stringify(SECRET)}.repeat(10000));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
  ]) {
    const f = await fixture(t),
      before = await snap(f.source),
      launch = await workerFixture(f, body);
    const result = await runDiagnosticTransport(f, { timeoutMs: 2000 }, launch);
    const owned = await readMarker(f.marker);
    await gone([owned.pid, owned.ppid]);
    assert.equal(result.reason, "WORKER_PROTOCOL_INVALID");
    assert.deepEqual(await snap(f.source), before);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  }
});

test("worker environment does not inherit parent credentials or NODE_OPTIONS", async (t) => {
  const f = await fixture(t),
    before = await snap(f.source);
  process.env.AGENTVAC_TEST_SECRET = SECRET;
  try {
    const launch = await workerFixture(
      f,
      `process.stdout.end(JSON.stringify({status:'blocked',reason:process.env.AGENTVAC_TEST_SECRET||process.env.NODE_OPTIONS?'READ_FAILED':'UNKNOWN_SCHEMA'}));`,
    );
    const result = await runDiagnosticTransport(f, { timeoutMs: 2000 }, launch);
    assert.equal(result.reason, "UNKNOWN_SCHEMA");
    assert.deepEqual(await snap(f.source), before);
  } finally {
    delete process.env.AGENTVAC_TEST_SECRET;
  }
});

test("parent crash closes pipe and supervisor reaps blocked worker before restart", async (t) => {
  const f = await fixture(t),
    before = await snap(f.source);
  const launch = await workerFixture(
    f,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
  );
  const harness = path.join(f.root, "parent.mjs");
  await fs.writeFile(
    harness,
    `import {runDiagnosticTransport} from ${JSON.stringify(runner)};await runDiagnosticTransport(${JSON.stringify(f)},{timeoutMs:10000},${JSON.stringify(launch)});`,
  );
  const parent = spawn(process.execPath, [...loaderArgs, harness], {
    stdio: "ignore",
    env: diagnosticEnvironment(),
  });
  t.after(() => {
    try {
      parent.kill("SIGKILL");
    } catch {}
  });
  const owned = await readMarker(f.marker);
  const closed = new Promise<void>((resolve) =>
    parent.once("close", () => resolve()),
  );
  parent.kill("SIGKILL");
  await closed;
  await gone([owned.pid, owned.ppid]);
  const result = await runDiagnosticTransport(
    f,
    { timeoutMs: 2000 },
    await workerFixture(
      f,
      `process.stdout.end(JSON.stringify({status:'blocked',reason:'UNKNOWN_SCHEMA'}));`,
    ),
  );
  assert.equal(result.reason, "UNKNOWN_SCHEMA");
  assert.deepEqual(await snap(f.source), before);
});

test(
  "SQLite final-open FIFO substitution is isolated, times out and preserves original DB",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      before = await snap(f.source);
    const worker = path.join(f.root, "race-worker.mjs");
    await fs.writeFile(
      worker,
      `import {promises as fs,renameSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {inspectSqliteInWorker} from ${JSON.stringify(parser)};
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{const req=JSON.parse(input);const stat=fs.lstat;let probes=0;fs.lstat=async(file,...args)=>{try{return await stat(file,...args);}catch(e){if(file===req.databasePath+'-journal'&&++probes===3){renameSync(req.databasePath,req.databasePath+'.saved');const r=spawnSync('mkfifo',[req.databasePath]);if(r.status!==0)throw new Error('fixture');writeFileSync(${JSON.stringify(f.marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));}throw e;}};const result=await inspectSqliteInWorker(req.databasePath,[{path:path.dirname(req.databasePath),kind:'sqlite-home'}],req.expected);process.stdout.end(JSON.stringify(result));});`,
    );
    const result = await runDiagnosticTransport(
      f,
      { timeoutMs: 2500 },
      { supervisor, worker, loaderArgs },
    );
    const owned = await readMarker(f.marker);
    await gone([owned.pid, owned.ppid]);
    assert.equal(result.reason, "TIMEOUT");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    const after = await snap(f.source);
    assert.equal(
      (after["logs_2.sqlite.saved"] as any).hash,
      (before["logs_2.sqlite"] as any).hash,
    );
    assert.equal(
      (after["logs_2.sqlite.saved"] as any).mtime,
      (before["logs_2.sqlite"] as any).mtime,
    );
    assert.deepEqual(Object.keys(after).sort(), [
      "logs_2.sqlite",
      "logs_2.sqlite.saved",
    ]);
  },
);

test("packaged ASAR API locates unpacked fixed helpers under Electron without source loaders", async (t) => {
  const f = await fixture(t),
    before = await snap(f.source);
  const stage = path.join(f.root, "stage"),
    outdir = path.join(stage, "dist-electron");
  const { build } = await import("esbuild");
  await build({
    entryPoints: [
      path.resolve(base, "../electron/diagnostics.ts"),
      path.resolve(base, "../electron/diagnostic-supervisor.ts"),
      path.resolve(base, "../electron/diagnostic-worker.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outdir,
    outExtension: { ".js": ".cjs" },
    logLevel: "silent",
  });
  const archive = path.join(f.root, "app.asar");
  await require("@electron/asar").createPackageWithOptions(stage, archive, {
    unpack: "**/diagnostic-*.cjs",
  });
  assert.ok(
    (
      await fs.stat(
        archive + ".unpacked/dist-electron/diagnostic-supervisor.cjs",
      )
    ).isFile(),
  );
  assert.ok(
    (
      await fs.stat(archive + ".unpacked/dist-electron/diagnostic-worker.cjs")
    ).isFile(),
  );
  const harness = path.join(f.root, "packaged-smoke.cjs");
  await fs.writeFile(
    harness,
    `const {diagnoseStorage}=require(${JSON.stringify(archive + "/dist-electron/diagnostics.cjs")});diagnoseStorage({roots:[{path:${JSON.stringify(f.source)},kind:'sqlite-home'}],deepCheck:{enabled:true,databasePath:${JSON.stringify(f.databasePath)}}}).then(result=>process.stdout.end(JSON.stringify(result.deepCheck)));`,
  );
  const executable = process.versions.electron
    ? process.execPath
    : (require("electron") as string);
  const child = spawn(executable, [harness], {
    stdio: ["ignore", "pipe", "ignore"],
    env: diagnosticEnvironment(),
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  assert.equal(code, 0);
  const result = JSON.parse(output);
  assert.equal(result.reason, "UNKNOWN_SCHEMA", output);
  assert.equal(result.sourceUnchanged, true);
  assert.deepEqual(await snap(f.source), before);
  assert.doesNotMatch(output, new RegExp(SECRET));
});
