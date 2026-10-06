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
    evidence: "rename-refused-unverified",
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
  test(`synthetic Windows ${code} at rename cannot classify without preservation evidence`, async () => {
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
      evidence: code === "EPERM" ? "rename-refused-unverified" : "incomplete",
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

async function generatedRefusalFixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentvac-refusal-proof-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target"),
    destination = path.join(root, "preserved"),
    ownedTemporary = path.join(target, "owned.tmp"),
    payload = path.join(target, "payload");
  await fs.mkdir(target);
  await fs.writeFile(payload, "original generated payload");
  await fs.writeFile(ownedTemporary, "generated unpublished journal");
  const fixture = { root, target, destination, ownedTemporary };
  const refusal = Object.assign(new Error("generated refusal"), {
    code: "EPERM",
    errno: -4048,
  });
  const injection = new ReplacementInjection("win32");
  const skips: string[] = [],
    diagnostics: string[] = [];
  const recorder = {
    skip: (reason?: string) => {
      skips.push(String(reason));
    },
    diagnostic: (message: string) => {
      diagnostics.push(message);
    },
  };
  return {
    ...fixture,
    fixture,
    payload,
    refusal,
    injection,
    skips,
    diagnostics,
    recorder,
  };
}

test("verified generated EPERM refusal reports BLOCKED only after unchanged original and absent destination checks", async (t) => {
  const f = await generatedRefusalFixture(t);
  await assert.rejects(
    f.injection.run(
      async () => {
        throw f.refusal;
      },
      async () => assert.fail("refused rename cannot install a replacement"),
      f.fixture,
    ),
    (error) => error === f.refusal,
  );
  await fs.unlink(f.ownedTemporary); // Emulate only the engine's legitimate cleanup.
  assert.equal(
    await f.injection.skipIfVerifiedWindowsRefusal(f.recorder),
    true,
  );
  assert.equal(f.skips.length, 1);
  assert.match(
    f.skips[0],
    /BLOCKED.*installed-replacement branch not exercised/,
  );
  assert.equal(f.diagnostics.length, 1);
  assert.match(
    f.diagnostics[0],
    /"originalUnchanged":true.*"destinationAbsent":true.*"protectedUnchanged":true/,
  );
  assert.doesNotMatch(
    f.diagnostics[0],
    /agentvac-refusal-proof-|original generated payload|owned.tmp/,
  );
  assert.throws(
    () => f.injection.assertInstalled(),
    /replacement injection incomplete/,
  );
});

for (const failure of [
  "removed root",
  "payload read denied",
  "absence check denied",
]) {
  test(`generated refusal ${failure} rejects without exposing paths or native error text`, async (t) => {
    const f = await generatedRefusalFixture(t);
    await assert.rejects(
      f.injection.run(
        async () => {
          throw f.refusal;
        },
        async () => assert.fail("refused rename cannot install a replacement"),
        f.fixture,
      ),
      (error) => error === f.refusal,
    );
    await fs.unlink(f.ownedTemporary);
    if (failure === "removed root") await fs.rm(f.root, { recursive: true });
    if (failure === "payload read denied") {
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: any[]) => {
        if (args[0] === f.payload)
          throw Object.assign(
            new Error("private exception contents " + f.payload),
            { code: "EACCES", path: f.payload },
          );
        return (open as any)(...args);
      });
    }
    if (failure === "absence check denied") {
      const lstat = fs.lstat;
      t.mock.method(fs, "lstat", async (...args: any[]) => {
        if (args[0] === f.destination)
          throw Object.assign(
            new Error("private exception contents " + f.destination),
            { code: "private-code", path: f.destination },
          );
        return (lstat as any)(...args);
      });
    }
    await assert.rejects(
      f.injection.skipIfVerifiedWindowsRefusal(f.recorder),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /fixture .*failed:.*"code":"(?:ENOENT|EACCES|OTHER)"/,
        );
        assert.equal(error.message.includes(f.root), false);
        assert.doesNotMatch(
          error.message,
          /private exception contents|private-code/,
        );
        assert.equal("path" in error, false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
    assert.equal(f.skips.length, 0);
    assert.equal(f.diagnostics.length, 0);
  });
}

for (const change of [
  "original bytes during refusal",
  "original bytes after refusal",
  "original identity",
  "original metadata",
  "created destination",
  "replaced temporary",
  "unrelated new file",
  "missing original",
]) {
  test(`generated EPERM refusal cannot hide ${change}`, async (t) => {
    const f = await generatedRefusalFixture(t);
    await assert.rejects(
      f.injection.run(
        async () => {
          if (change === "original bytes during refusal")
            await fs.writeFile(f.payload, "changed bytes");
          throw f.refusal;
        },
        async () => assert.fail("refused rename cannot install a replacement"),
        f.fixture,
      ),
      (error) => error === f.refusal,
    );
    await fs.unlink(f.ownedTemporary);
    if (change === "original bytes after refusal")
      await fs.writeFile(f.payload, "changed bytes");
    if (change === "original identity") {
      await fs.writeFile(f.ownedTemporary, "original generated payload");
      await fs.rename(f.ownedTemporary, f.payload);
    }
    if (change === "original metadata")
      await fs.utimes(
        f.payload,
        new Date("2020-01-01"),
        new Date("2020-01-01"),
      );
    if (change === "created destination") await fs.mkdir(f.destination);
    if (change === "replaced temporary")
      await fs.writeFile(f.ownedTemporary, "replacement sentinel");
    if (change === "unrelated new file")
      await fs.writeFile(path.join(f.target, "unexpected"), "extra bytes");
    if (change === "missing original") await fs.unlink(f.payload);
    await assert.rejects(f.injection.skipIfVerifiedWindowsRefusal(f.recorder));
    assert.equal(
      f.skips.length,
      0,
      "changed fixture must fail before any SKIP",
    );
  });
}

for (const [code, errno] of [
  ["EPERM", -1],
  ["EPERM", undefined],
  ["EACCES", -4048],
  ["EBUSY", -4048],
  ["EIO", -4048],
] as const) {
  test(`generated ${code}/${errno} rename error is ineligible for BLOCKED`, async (t) => {
    const f = await generatedRefusalFixture(t);
    await assert.rejects(
      f.injection.run(
        async () => {
          throw Object.assign(new Error("other refusal"), { code, errno });
        },
        async () => assert.fail("refused rename cannot install a replacement"),
        f.fixture,
      ),
    );
    await fs.unlink(f.ownedTemporary);
    assert.equal(
      await f.injection.skipIfVerifiedWindowsRefusal(f.recorder),
      false,
    );
    assert.equal(f.skips.length, 0);
    assert.throws(
      () => f.injection.assertInstalled(),
      /replacement injection incomplete/,
    );
  });
}

test("generated successful rename followed by partial installation EPERM remains a failure", async (t) => {
  const f = await generatedRefusalFixture(t);
  await assert.rejects(
    f.injection.run(
      () => fs.rename(f.target, f.destination),
      async () => {
        await fs.mkdir(f.target);
        await fs.writeFile(f.payload, "partially installed sentinel");
        throw f.refusal;
      },
      f.fixture,
    ),
    (error) => error === f.refusal,
  );
  assert.equal(f.injection.snapshot().phase, "rename-success");
  assert.equal(
    await f.injection.skipIfVerifiedWindowsRefusal(f.recorder),
    false,
  );
  assert.equal(f.skips.length, 0);
  assert.throws(
    () => f.injection.assertInstalled(),
    /replacement injection incomplete/,
  );
});

test("generated EPERM without recorded fixture evidence cannot authorize SKIP", async () => {
  const injection = new ReplacementInjection("win32");
  await assert.rejects(
    injection.run(
      async () => {
        throw Object.assign(new Error("generated refusal"), {
          code: "EPERM",
          errno: -4048,
        });
      },
      async () => assert.fail("must not install"),
    ),
  );
  await assert.rejects(
    injection.skipIfVerifiedWindowsRefusal({
      skip: () => assert.fail("missing evidence cannot skip"),
      diagnostic: () => {},
    }),
    /lacks complete generated fixture evidence/,
  );
});

for (const invalid of [
  "entry budget",
  "byte budget",
  "symbolic link",
  "hard link",
]) {
  test(`generated refusal evidence rejects ${invalid} before rename`, async (t) => {
    const f = await generatedRefusalFixture(t);
    if (invalid === "entry budget") {
      for (let index = 0; index < 64; index++)
        await fs.writeFile(path.join(f.target, `extra-${index}`), "");
    }
    if (invalid === "byte budget")
      await fs.writeFile(f.payload, Buffer.alloc(1_048_577));
    if (invalid === "symbolic link")
      await fs.symlink(f.target, path.join(f.root, "link"), "junction");
    if (invalid === "hard link")
      await fs.link(f.payload, path.join(f.target, "linked"));
    await assert.rejects(
      f.injection.run(
        async () => assert.fail("invalid evidence must stop before rename"),
        async () =>
          assert.fail("invalid evidence must stop before installation"),
        f.fixture,
      ),
      /budget|link/,
    );
    assert.equal(f.injection.snapshot().phase, "not-entered");
    assert.equal(
      await f.injection.skipIfVerifiedWindowsRefusal(f.recorder),
      false,
    );
    assert.equal(f.skips.length, 0);
  });
}

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
