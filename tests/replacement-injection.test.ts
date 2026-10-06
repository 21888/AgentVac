import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReplacementInjection } from "./helpers/replacement-injection.js";

test("replacement diagnostics require an installed generated sentinel", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-injection-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const target = path.join(base, "target"),
    preserved = path.join(base, "preserved"),
    injection = new ReplacementInjection();
  await fs.mkdir(target);
  await fs.writeFile(
    path.join(target, "payload"),
    "original generated payload",
  );
  await injection.run(
    () => fs.rename(target, preserved),
    async () => {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "payload"), "replacement sentinel");
    },
  );
  injection.assertInstalled();
  await injection.assertSentinel(
    path.join(target, "payload"),
    "replacement sentinel",
    "temporary",
  );
  assert.equal(
    await fs.readFile(path.join(preserved, "payload"), "utf8"),
    "original generated payload",
  );
  assert.deepEqual(injection.snapshot(), {
    phase: "replacement-installed",
    failureStage: "none",
    code: "NONE",
    errno: null,
    evidence: "replacement-installed",
  });
});

test("replacement sentinel corruption and read failures are strict and redact fixture data", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-injection-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const target = path.join(base, "private-generated-name"),
    privateContent = "private generated altered payload",
    injection = new ReplacementInjection();
  await injection.run(
    async () => {},
    () => fs.writeFile(target, privateContent),
  );
  await assert.rejects(
    injection.assertSentinel(target, "replacement sentinel", "manifest"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /sentinel must remain intact/);
      assert.equal(error.message.includes(target), false);
      assert.equal(error.message.includes(privateContent), false);
      return true;
    },
  );
  await fs.unlink(target);
  await assert.rejects(
    injection.assertSentinel(target, "replacement sentinel", "manifest"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /replacement manifest read failed/);
      assert.match(error.message, /ENOENT/);
      assert.equal(error.message.includes(target), false);
      assert.equal(error.message.includes(privateContent), false);
      return true;
    },
  );
  assert.equal(injection.snapshot().phase, "replacement-installed");
});

test("generated rename EPERM control leaves the fixture intact and cannot pass replacement coverage", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-injection-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const target = path.join(base, "target"),
    preserved = path.join(base, "preserved"),
    injection = new ReplacementInjection("win32"),
    rename = fs.rename,
    refusal = Object.assign(new Error("synthetic generated rename refusal"), {
      code: "EPERM",
      errno: -4048,
    });
  await fs.mkdir(target);
  await fs.writeFile(
    path.join(target, "payload"),
    "original generated payload",
  );
  // A generated mock exercises the refusal path; it is not native Windows data.
  const mock = t.mock.method(
    fs,
    "rename",
    async (from: PathLike, to: PathLike) => {
      if (from === target && to === preserved) throw refusal;
      return rename(from, to);
    },
  );
  try {
    await assert.rejects(
      injection.run(
        () => fs.rename(target, preserved),
        async () =>
          assert.fail("a refused rename cannot install a replacement"),
      ),
      (error) => error === refusal,
    );
  } finally {
    mock.mock.restore();
  }
  assert.equal(
    await fs.readFile(path.join(target, "payload"), "utf8"),
    "original generated payload",
  );
  await assert.rejects(fs.lstat(preserved), { code: "ENOENT" });
  assert.deepEqual(injection.snapshot(), {
    phase: "hook-entry",
    failureStage: "rename",
    code: "EPERM",
    errno: -4048,
    evidence: "platform-limited",
  });
  assert.throws(
    () => injection.assertInstalled(),
    /replacement injection incomplete/,
  );
});

test("replacement diagnostics distinguish pending rename from pending install", async () => {
  const injection = new ReplacementInjection();
  let releaseRename!: () => void, releaseInstall!: () => void;
  const renamePending = new Promise<void>(
    (resolve) => (releaseRename = resolve),
  );
  const installPending = new Promise<void>(
    (resolve) => (releaseInstall = resolve),
  );
  let enteredInstall!: () => void;
  const installEntered = new Promise<void>(
    (resolve) => (enteredInstall = resolve),
  );
  const pending = injection.run(
    () => renamePending,
    async () => {
      enteredInstall();
      await installPending;
    },
  );
  assert.equal(injection.snapshot().phase, "hook-entry");
  assert.throws(
    () => injection.assertInstalled(),
    /replacement injection incomplete/,
  );
  releaseRename();
  await installEntered;
  assert.equal(injection.snapshot().phase, "rename-success");
  assert.throws(
    () => injection.assertInstalled(),
    /replacement injection incomplete/,
  );
  releaseInstall();
  await pending;
  injection.assertInstalled();
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`synthetic Windows ${code} at rename is platform-limited and still fails installation`, async () => {
    // This is a classifier control, not an observation of native Windows I/O.
    const injection = new ReplacementInjection("win32"),
      refusal = Object.assign(
        new Error("generated private path and contents"),
        {
          code,
          errno: -4048,
          path: "generated/private/fixture",
        },
      );
    let installed = false;
    await assert.rejects(
      injection.run(
        async () => {
          throw refusal;
        },
        async () => {
          installed = true;
        },
      ),
      (error) => error === refusal,
    );
    assert.equal(installed, false);
    assert.deepEqual(injection.snapshot(), {
      phase: "hook-entry",
      failureStage: "rename",
      code,
      errno: -4048,
      evidence: "platform-limited",
    });
    assert.throws(
      () => injection.assertInstalled(),
      /replacement injection incomplete/,
    );
    const diagnostics: string[] = [];
    injection.diagnose({ diagnostic: (message) => diagnostics.push(message) });
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(diagnostics[0], /private|fixture|contents|path/);
  });

  test(`synthetic Windows ${code} after rename remains an incomplete injection failure`, async () => {
    const injection = new ReplacementInjection("win32");
    await assert.rejects(
      injection.run(
        async () => {},
        async () => {
          throw Object.assign(new Error("synthetic installation failure"), {
            code,
          });
        },
      ),
    );
    assert.deepEqual(injection.snapshot(), {
      phase: "rename-success",
      failureStage: "install",
      code,
      errno: null,
      evidence: "incomplete",
    });
    assert.throws(
      () => injection.assertInstalled(),
      /replacement injection incomplete/,
    );
  });
}

test("synthetic Linux rename EPERM does not claim native Windows refusal evidence", async () => {
  const injection = new ReplacementInjection("linux");
  await assert.rejects(
    injection.run(
      async () => {
        throw Object.assign(new Error("synthetic refusal"), { code: "EPERM" });
      },
      async () => assert.fail("refused rename must not attempt installation"),
    ),
  );
  assert.equal(injection.snapshot().evidence, "incomplete");
  assert.throws(
    () => injection.assertInstalled(),
    /replacement injection incomplete/,
  );
});

test("unexpected error properties are redacted and cannot authorize a skip", async () => {
  const injection = new ReplacementInjection("win32");
  await assert.rejects(
    injection.run(
      async () => {
        throw Object.assign(new Error("private content"), {
          code: "private/path",
          errno: "private contents",
        });
      },
      async () => assert.fail("failed rename must not attempt installation"),
    ),
  );
  assert.deepEqual(injection.snapshot(), {
    phase: "hook-entry",
    failureStage: "rename",
    code: "OTHER",
    errno: null,
    evidence: "incomplete",
  });
  assert.throws(
    () => injection.assertInstalled(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private/);
      return true;
    },
  );
});

test("an unentered replacement hook cannot satisfy installation", () => {
  const injection = new ReplacementInjection();
  assert.equal(injection.snapshot().phase, "not-entered");
  assert.throws(
    () => injection.assertInstalled(),
    /replacement injection incomplete/,
  );
});

test("post-injection errors do not erase installed-replacement evidence", async () => {
  const injection = new ReplacementInjection("win32"),
    downstream = Object.assign(new Error("synthetic post-injection failure"), {
      code: "EPERM",
    });
  await assert.rejects(
    async () => {
      await injection.run(
        async () => {},
        async () => {},
      );
      throw downstream;
    },
    (error) => error === downstream,
  );
  injection.assertInstalled();
  assert.equal(injection.snapshot().failureStage, "none");
  assert.equal(injection.snapshot().evidence, "replacement-installed");
});
