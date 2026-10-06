import {
  readFile,
  lstat,
  realpath,
  open,
  rename,
  link,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { exchangeChild } from "../research-transport.mjs";
import {
  encodeFixtureRequest,
  decodeFixtureResponse,
} from "../inherited-protocol.mjs";
import {
  acquireGeneratedLease,
  ownedGeneratedLeaseCount,
} from "../lease-transport.mjs";
import { copyGeneratedFixtureUnderLease } from "../lease-copy.mjs";
import { encodeLeaseControl } from "../lease-protocol.mjs";
import { acquireFixtureDeleteHolder } from "../fixture-delete-holder.mjs";
import {
  requireNativeFixtureRefusal,
  requireInvalidControlRefusal,
  requireHeldRenameRefusal,
  requireNoReadyUnderDeleteHolder,
} from "../lease-oracles.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  build = path.join(root, "build", "windows-x64"),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const files = {
  helper: path.join(build, "agentvac-copy-lease-research.exe"),
  fixture: path.join(build, "agentvac-initial-fixtures-research.exe"),
  holder: path.join(build, "agentvac-delete-holder-fixture.exe"),
};
const env = {
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  SystemDrive: "C:",
  USERPROFILE: "",
  APPDATA: "",
  LOCALAPPDATA: "",
  TEMP: "",
  TMP: "",
  HOMEDRIVE: "",
  HOMEPATH: "",
  PATH: "",
};
const cases = [];
let evidence = {},
  halted = false;
const unavailableNativeCases = [
  "preexisting-enabled-backup-or-restore-token",
  "different-user-or-impersonated-peer",
  "reparse-creation-without-privilege",
  "parent-exit-with-duplicated-pipe-endpoint",
  "ACL-change-race-not-authorized",
  "real-kernel-pending-write-stall",
  "SQLite-WAL-SHM-under-lease",
  "arbitrary-app-path-containment",
  "full-Electron-runtime-integration",
];
function emit(status, extra = {}) {
  console.log(
    JSON.stringify({
      schema: 1,
      profile: "generated-private-copy-lease-v2",
      status,
      productionAccepted: false,
      privateCopyActivated: false,
      nativeWindows: process.platform === "win32" ? "PARTIAL_ONLY" : "NOT_RUN",
      evidence,
      cases,
      unavailableNativeCases,
      generatedFixturesLeftForRunnerDisposal: true,
      ...extra,
    }),
  );
}
function safeCode(e) {
  return typeof e?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(e.code)
    ? e.code
    : "FIXTURE_ASSERTION_OR_IO";
}
async function checkBinary(kind) {
  const file = files[kind],
    s = await lstat(file, { bigint: true });
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.size < 1n ||
    s.size > 8n * 1024n * 1024n ||
    hash(await readFile(file)) !== evidence[kind + "Sha256"]
  )
    throw Error("binary-changed");
}
function spawnKnown(kind) {
  return spawn(files[kind], [], {
    shell: false,
    windowsHide: true,
    cwd: build,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function initialFixture() {
  if (halted) throw Error("teardown-unconfirmed");
  await checkBinary("fixture");
  const value = await exchangeChild(
    () => spawnKnown("fixture"),
    encodeFixtureRequest(),
    {
      decode: decodeFixtureResponse,
      bodyBytes: 44,
      successOutcomes: ["fixtures-created"],
      allowBlocked125: true,
    },
  );
  if (value.teardownConfirmed === false) {
    halted = true;
    throw Error("teardown-unconfirmed");
  }
  if (value.outcome !== "fixtures-created") throw Error("fixture-unavailable");
  return path.join(build, "inherited-fixture-" + value.suffix);
}
async function fixture(
  kind = "private",
  bytes = Buffer.from("Generated private-copy sentinel.\n".repeat(2048)),
) {
  const scope = await initialFixture(),
    directory = path.join(scope, kind),
    nonce = randomBytes(16),
    target = path.join(directory, "lease-" + nonce.toString("hex") + ".bin");
  const source = await open(
    path.join(directory, "source-" + nonce.toString("hex") + ".bin"),
    "wx+",
  );
  await source.writeFile(bytes);
  await source.sync();
  const destination = await open(target, "wx+");
  const request = {
    scope,
    path: target,
    nonce,
    mode: "acl",
    directory: false,
    allowMissingLeaf: false,
  };
  return {
    scope,
    directory,
    target,
    source,
    destination,
    request,
    bytes,
    args: {
      source,
      destination,
      expectedBytes: bytes.length,
      expectedSha256: hash(bytes),
    },
    close: async () => {
      await source.close().catch(() => {});
      await destination.close().catch(() => {});
    },
  };
}
async function launched(f, options = {}) {
  await checkBinary("helper");
  let child, exit;
  const ready = acquireGeneratedLease({
    request: f.request,
    ...options,
    spawnPinned: () => {
      child = spawnKnown("helper");
      exit = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          child.fixtureClosed = true;
          resolve({ code, signal });
        }),
      );
      return child;
    },
  });
  return {
    ready,
    get child() {
      return child;
    },
    exit: () => exit,
  };
}
async function launchedHolder(f) {
  await checkBinary("holder");
  let child, exit;
  const ready = acquireFixtureDeleteHolder({
    request: f.request,
    spawnPinned: () => {
      child = spawnKnown("holder");
      exit = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          child.fixtureClosed = true;
          resolve({ code, signal });
        }),
      );
      return child;
    },
  });
  return {
    ready,
    get child() {
      return child;
    },
    exit: () => exit,
  };
}
async function requireClosed(run, ms = 2000) {
  let timer;
  const value = await Promise.race([
    run.exit(),
    new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms))),
  ]);
  clearTimeout(timer);
  if (!value) {
    halted = true;
    throw Error("teardown-unconfirmed");
  }
  return value;
}
async function abortLease(lease, run) {
  await lease.abort();
  await requireClosed(run);
}
async function runCase(id, body) {
  if (halted) return;
  try {
    await body();
    cases.push({ id, status: "PASS" });
  } catch (e) {
    const blocked =
      [
        "metadata-unavailable",
        "identity-unavailable",
        "context-rejected",
        "caller-rejected",
        "locality-rejected",
      ].includes(e?.nativeOutcome) && e?.verifiedTerminalRefusal === true;
    cases.push({
      id,
      status: blocked ? "BLOCKED" : "FAIL",
      code: safeCode(e),
      ...(e?.nativeOutcome ? { nativeOutcome: e.nativeOutcome } : {}),
      ...([
        "none",
        "initial-file-nonempty",
        "initial-file-hardlink",
        "initial-file-not-regular",
        "filesystem-unsupported",
        "sharing-conflict",
      ].includes(e?.nativeReason)
        ? {
            nativeReason: e.nativeReason,
            verifiedTerminalRefusal: e.verifiedTerminalRefusal === true,
          }
        : {}),
    });
    if (ownedGeneratedLeaseCount()) halted = true;
  }
}
try {
  if (process.platform !== "win32") {
    emit("NOT_RUN", { blocker: "windows-required" });
    process.exitCode = 2;
  } else {
    const pin = process.argv[2],
      sdk = process.argv[3];
    if (
      process.arch !== "x64" ||
      process.argv.length !== 4 ||
      !/^[a-f0-9]{64}$/.test(pin ?? "") ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(sdk ?? "")
    )
      throw Error("unsupported-input");
    let current = path.parse(build).root;
    for (const p of build
      .slice(current.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, p);
      const s = await lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink()) throw Error("unsafe-tree");
    }
    if ((await realpath(build)).toLowerCase() !== build.toLowerCase())
      throw Error("unsafe-tree");
    const inputs = JSON.parse(
      await readFile(path.join(root, "SOURCE-INPUTS.json"), "utf8"),
    );
    if (
      !Array.isArray(inputs) ||
      inputs.length > 100 ||
      new Set(inputs).size !== inputs.length ||
      inputs.some(
        (p) =>
          typeof p !== "string" ||
          !/^[A-Za-z0-9_./-]+$/.test(p) ||
          p.startsWith("/") ||
          p.split("/").includes(".."),
      )
    )
      throw Error("invalid-source-list");
    inputs.sort();
    const digests = {};
    for (const p of inputs)
      digests[p] = hash(await readFile(path.join(root, p)));
    if (
      hash(Buffer.from(inputs.map((p) => `${p}\0${digests[p]}\n`).join(""))) !==
      pin
    )
      throw Error("source-pin-mismatch");
    const raw = await readFile(path.join(build, "lease-build-provenance.json"));
    if (raw.length > 65536) throw Error("provenance-limit");
    const receipt = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
    if (
      receipt.profile !== "generated-private-copy-lease-v2" ||
      receipt.sourceTreeSha256 !== pin ||
      receipt.sdkVersion !== sdk ||
      receipt.targetArchitecture !== "x64" ||
      receipt.sourcePrePostMatched !== true ||
      receipt.fixtureBuild !== "built" ||
      receipt.crt !== "static-MT" ||
      !/^[a-f0-9]{64}$/.test(receipt.helperSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(receipt.fixtureSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(receipt.holderSha256 ?? "")
    )
      throw Error("provenance-mismatch");
    evidence = {
      sourceTreeSha256: pin,
      helperSha256: receipt.helperSha256,
      fixtureSha256: receipt.fixtureSha256,
      holderSha256: receipt.holderSha256,
      compilerSha256: receipt.compilerSha256,
      sdkVersion: sdk,
      provenanceSha256: hash(raw),
      node: process.version,
      libuv: process.versions.uv,
      nodeSha256: hash(await readFile(process.execPath)),
      windowsRelease: os.release(),
      architecture: process.arch,
    };
    await runCase(
      "held-private-NTFS-file-copy-exact-size-hash-source",
      async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready;
          const result = await copyGeneratedFixtureUnderLease({
            ...f.args,
            lease,
          });
          assert.equal(result.written, f.bytes.length);
          assert.equal(result.helperClosed, true);
          assert.deepEqual(await readFile(f.target), f.bytes);
          const out = Buffer.alloc(f.bytes.length);
          const r = await f.source.read(out, 0, out.length, 0);
          assert.equal(r.bytesRead, out.length);
          assert.deepEqual(out, f.bytes);
          await requireClosed(run);
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      },
    );
    await runCase(
      "lease-does-not-block-generated-unrelated-sibling-write",
      async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready;
          const sibling = await open(
            path.join(f.scope, "unrelated-" + randomBytes(8).toString("hex")),
            "wx+",
          );
          try {
            await sibling.writeFile("generated unrelated sibling");
            await sibling.sync();
          } finally {
            await sibling.close();
          }
          assert.equal((await f.destination.stat()).size, 0);
          await abortLease(lease, run);
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      },
    );
    for (const target of ["leaf", "parent", "scope"])
      await runCase("held-" + target + "-rename-refused", async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready,
            p =
              target === "leaf"
                ? f.target
                : target === "parent"
                  ? f.directory
                  : f.scope;
          const original = await lstat(p, { bigint: true });
          const destinationBefore = await f.destination.stat({ bigint: true });
          assert.equal(destinationBefore.size, 0n);
          assert.equal(destinationBefore.nlink, 1n);
          assert.equal(
            destinationBefore.dev,
            BigInt("0x" + lease.ready.identity.volume32),
          );
          assert.equal(
            destinationBefore.ino,
            BigInt("0x" + lease.ready.identity.fileIndex64),
          );
          // Isolate helper-held namespace guards: Node's own descendant handles
          // must not be the cause of either directory refusal or post-close failure.
          await f.source.close();
          await f.destination.close();
          await requireHeldRenameRefusal(lease, () =>
            rename(p, p + ".renamed"),
          );
          const held = await lstat(p, { bigint: true });
          assert.equal(held.dev, original.dev);
          assert.equal(held.ino, original.ino);
          assert.equal((await lstat(f.target)).size, 0);
          await abortLease(lease, run);
          try {
            await rename(p, p + ".renamed");
          } catch {
            throw Object.assign(new Error("LEASE_RENAME_AFTER_CLOSE_FAILED"), {
              code: "LEASE_RENAME_AFTER_CLOSE_FAILED",
            });
          }
          const released = await lstat(p + ".renamed", { bigint: true });
          assert.equal(released.dev, original.dev);
          assert.equal(released.ino, original.ino);
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      });
    for (const kind of ["broad", "nonempty", "hardlink"])
      await runCase(kind + "-destination-refuses-before-copy", async () => {
        const f = await fixture(kind === "broad" ? "broad" : "private");
        let run;
        try {
          if (kind === "nonempty")
            await f.destination.write(Buffer.from([1]), 0, 1, 0);
          if (kind === "hardlink")
            await link(f.target, f.target + ".second-link");
          run = await launched(f);
          let rejected;
          try {
            const unexpected = await run.ready;
            await abortLease(unexpected, run);
          } catch (error) {
            rejected = error;
          }
          await requireClosed(run);
          requireNativeFixtureRefusal(rejected, kind);
          assert.equal(
            (await f.destination.stat()).size,
            kind === "nonempty" ? 1 : 0,
          );
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      });
    await runCase(
      "preexisting-DELETE-handle-causes-exact-sharing-refusal",
      async () => {
        const f = await fixture();
        let holderRun, holder, run, positive;
        try {
          holderRun = await launchedHolder(f);
          holder = await holderRun.ready;
          assert.equal(holder.isHolding(), true);
          run = await launched(f);
          let rejected,
            wasReady = false;
          try {
            const unexpected = await run.ready;
            wasReady = true;
            await abortLease(unexpected, run);
          } catch (e) {
            rejected = e;
          }
          await requireClosed(run);
          assert.equal(holder.isHolding(), true);
          requireNoReadyUnderDeleteHolder(wasReady);
          requireNativeFixtureRefusal(rejected, "deleteAccess");
          assert.equal((await f.destination.stat()).size, 0);
          const release = await holder.release();
          await requireClosed(holderRun);
          assert.equal(release.teardownConfirmed, true);
          positive = await launched(f);
          const lease = await positive.ready;
          await abortLease(lease, positive);
          assert.equal((await f.destination.stat()).size, 0);
        } finally {
          for (const pending of [run, positive, holderRun])
            if (pending?.child && !pending.child.fixtureClosed) {
              pending.child.kill();
              await requireClosed(pending);
            }
          await f.close();
        }
      },
    );
    await runCase(
      "helper-exit-after-ready-prevents-first-copy-write",
      async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready;
          run.child.kill();
          await requireClosed(run);
          await assert.rejects(
            copyGeneratedFixtureUnderLease({ ...f.args, lease }),
            /LEASE_COPY_LOST/,
          );
          assert.equal((await f.destination.stat()).size, 0);
        } finally {
          await f.close();
        }
      },
    );
    await runCase(
      "cancel-after-first-native-write-preserves-partial-fixture",
      async () => {
        const f = await fixture("private", Buffer.alloc(512 * 1024, 81)),
          controller = new AbortController();
        let run;
        try {
          run = await launched(f, { signal: controller.signal });
          const lease = await run.ready,
            write = f.destination.write.bind(f.destination);
          let writes = 0;
          f.destination.write = async (...args) => {
            const r = await write(...args);
            if (++writes === 1) controller.abort();
            return r;
          };
          await assert.rejects(
            copyGeneratedFixtureUnderLease({
              ...f.args,
              lease,
              signal: controller.signal,
            }),
            (e) => e.code === "LEASE_COPY_CANCELLED",
          );
          await requireClosed(run);
          assert.equal(writes, 1);
          assert.ok((await f.destination.stat()).size <= 256 * 1024);
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      },
    );
    for (const kind of ["duplicate", "stale"])
      await runCase(kind + "-native-control-refused", async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready;
          const control = encodeLeaseControl(
            "release",
            kind === "stale" ? randomBytes(16) : f.request.nonce,
          );
          run.child.stdin.end(
            kind === "duplicate" ? Buffer.concat([control, control]) : control,
          );
          const exit = await requireClosed(run);
          requireInvalidControlRefusal(lease.refusalEvidence(), exit);
          assert.equal(lease.isLive(), false);
          await assert.rejects(lease.release(), /LEASE_RELEASE_STATE/);
          assert.equal((await f.destination.stat()).size, 0);
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      });
    await runCase(
      "native-30s-watchdog-releases-empty-fixture-handles",
      async () => {
        const f = await fixture();
        let run;
        try {
          run = await launched(f);
          const lease = await run.ready;
          const value = await requireClosed(run, 31000);
          assert.equal(value.code, 124);
          assert.equal(lease.isLive(), false);
          assert.equal((await f.destination.stat()).size, 0);
          await rename(f.target, f.target + ".after-exit");
        } finally {
          if (run?.child && !run.child.fixtureClosed) {
            run.child.kill();
            await requireClosed(run);
          }
          await f.close();
        }
      },
    );
    assert.equal(ownedGeneratedLeaseCount(), 0);
    const failed = cases.some((c) => c.status === "FAIL");
    const blocked = cases.some((c) => c.status === "BLOCKED");
    emit(
      failed
        ? "PROBE_FAIL"
        : blocked
          ? "PARTIAL_BLOCKED"
          : "PARTIAL_GENERATED_LEASE_PASS",
    );
    process.exitCode = failed ? 1 : blocked ? 2 : 0;
  }
} catch (e) {
  emit("BLOCKED", {
    blocker: safeCode(e),
    retainedChildren: ownedGeneratedLeaseCount(),
  });
  process.exitCode = 2;
}
