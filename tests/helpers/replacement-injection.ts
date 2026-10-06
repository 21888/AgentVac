import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";

type Phase =
  "not-entered" | "hook-entry" | "rename-success" | "replacement-installed";
type FailureStage = "none" | "rename" | "install";

// Fixed diagnostic values only. Never serialize an error, path, or fixture data.
const knownCodes = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOENT",
  "EEXIST",
  "ENOTEMPTY",
  "EXDEV",
  "EIO",
]);

type RenameFixture = {
  root: string;
  target: string;
  destination: string;
  ownedTemporary: string;
};
type Entry = {
  kind: "file" | "directory";
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  gid: string;
  nlink: string;
  size?: string;
  mtimeNs?: string;
  ctimeNs?: string;
  birthtimeNs: string;
  sha256?: string;
};
type FixtureSnapshot = Map<string, Entry>;

function relative(root: string, target: string) {
  const result = path.relative(root, target);
  assert.ok(
    !path.isAbsolute(result) &&
      result !== ".." &&
      !result.startsWith(".." + path.sep),
    "refusal evidence must stay within its generated fixture",
  );
  return result;
}

async function absent(target: string) {
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    const failure = nativeFailure(error);
    if (failure.code !== "ENOENT")
      assert.fail(`fixture absence check failed: ${JSON.stringify(failure)}`);
    return true;
  }
}

async function observe<T>(
  step: "stat" | "open" | "read" | "close" | "list",
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    assert.fail(
      `generated fixture ${step} failed: ${JSON.stringify(nativeFailure(error))}`,
    );
  }
}

async function snapshotFixture(root: string): Promise<FixtureSnapshot> {
  const entries: FixtureSnapshot = new Map();
  let bytes = 0n;
  async function visit(target: string) {
    assert.ok(
      entries.size < 64,
      "generated refusal fixture exceeds entry budget",
    );
    const stat = await observe("stat", () =>
      fs.lstat(target, { bigint: true }),
    );
    assert.ok(
      stat.isDirectory() || stat.isFile(),
      "generated refusal fixture contains a link or unknown type",
    );
    assert.ok(
      !stat.isFile() || stat.nlink === 1n,
      "generated refusal fixture contains a linked file",
    );
    // Access time is deliberately excluded: observing file bytes may update it.
    const entry: Entry = {
      kind: stat.isFile() ? "file" : "directory",
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      uid: String(stat.uid),
      gid: String(stat.gid),
      nlink: String(stat.nlink),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      birthtimeNs: String(stat.birthtimeNs),
    };
    entries.set(relative(root, target), entry);
    if (stat.isFile()) {
      bytes += stat.size;
      assert.ok(
        bytes <= 1_048_576n,
        "generated refusal fixture exceeds byte budget",
      );
      // Read at most the observed size plus one byte, so a growing file cannot
      // bypass the fixture budget between lstat and the content observation.
      const content = Buffer.alloc(Number(stat.size) + 1);
      const handle = await observe("open", () => fs.open(target, "r"));
      let read = 0;
      try {
        while (read < content.length) {
          const { bytesRead } = await observe("read", () =>
            handle.read(content, read, content.length - read, read),
          );
          if (!bytesRead) break;
          read += bytesRead;
        }
      } finally {
        await observe("close", () => handle.close());
      }
      assert.equal(
        BigInt(read),
        stat.size,
        "generated refusal fixture changed while reading",
      );
      entry.sha256 = createHash("sha256")
        .update(content.subarray(0, read))
        .digest("hex");
    } else {
      for (const name of (
        await observe("list", () => fs.readdir(target))
      ).sort())
        await visit(path.join(target, name));
    }
  }
  await visit(root);
  return entries;
}

function digest(snapshot: FixtureSnapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify([...snapshot].sort(([a], [b]) => a.localeCompare(b))),
    )
    .digest("hex");
}

function afterOwnedCleanup(snapshot: FixtureSnapshot, temporary: string) {
  const result: FixtureSnapshot = new Map(
    [...snapshot].map(([name, entry]) => [name, { ...entry }]),
  );
  result.delete(temporary);
  const parent = result.get(
    path.dirname(temporary) === "." ? "" : path.dirname(temporary),
  );
  assert.ok(
    parent?.kind === "directory",
    "owned temporary parent must remain a directory",
  );
  // Unlinking this one owned temporary may change only its direct parent's
  // size and write/change timestamps. Keep exact identity, owner, mode and links.
  delete parent.size;
  delete parent.mtimeNs;
  delete parent.ctimeNs;
  return result;
}

function nativeFailure(error: unknown) {
  const native = error as NodeJS.ErrnoException | null;
  return {
    code:
      typeof native?.code === "string" && knownCodes.has(native.code)
        ? native.code
        : "OTHER",
    errno:
      typeof native?.errno === "number" && Number.isSafeInteger(native.errno)
        ? native.errno
        : null,
  };
}

/** Records injection completion separately from the engine's response to it. */
export class ReplacementInjection {
  private phase: Phase = "not-entered";
  private failureStage: FailureStage = "none";
  private code = "NONE";
  private errno: number | null = null;
  private refusal?: {
    fixture: RenameFixture;
    before: FixtureSnapshot;
    after?: FixtureSnapshot;
    destinationAbsentAfter: boolean;
  };

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async run(
    rename: () => Promise<unknown>,
    install: () => Promise<unknown>,
    fixture?: RenameFixture,
  ) {
    assert.equal(
      this.phase,
      "not-entered",
      "replacement hook ran more than once",
    );
    if (fixture) {
      for (const target of [
        fixture.target,
        fixture.destination,
        fixture.ownedTemporary,
      ])
        relative(fixture.root, target);
      assert.equal(
        await absent(fixture.destination),
        true,
        "preserved destination must start absent",
      );
      const before = await snapshotFixture(fixture.root);
      assert.equal(
        before.get(relative(fixture.root, fixture.target))?.kind,
        "directory",
        "refusal target must start as an existing directory",
      );
      assert.equal(
        before.get(relative(fixture.root, fixture.ownedTemporary))?.kind,
        "file",
        "owned temporary must start as an existing file",
      );
      this.refusal = { fixture, before, destinationAbsentAfter: false };
    }
    this.phase = "hook-entry";
    let stage: FailureStage = "rename";
    try {
      await rename();
      this.phase = "rename-success";
      stage = "install";
      await install();
      this.phase = "replacement-installed";
    } catch (error) {
      this.failureStage = stage;
      const native = nativeFailure(error);
      this.code = native.code;
      this.errno = native.errno;
      if (this.isWindowsRenameRefusal() && this.refusal) {
        try {
          this.refusal.after = await snapshotFixture(this.refusal.fixture.root);
          this.refusal.destinationAbsentAfter = await absent(
            this.refusal.fixture.destination,
          );
        } catch {
          // Missing evidence cannot authorize SKIP. Preserve the native exception.
        }
      }
      // Preserve the original exception for the engine's existing failure path.
      throw error;
    }
  }

  private isWindowsRenameRefusal() {
    return (
      this.platform === "win32" &&
      this.phase === "hook-entry" &&
      this.failureStage === "rename" &&
      this.code === "EPERM" &&
      this.errno === -4048
    );
  }

  snapshot() {
    return {
      phase: this.phase,
      failureStage: this.failureStage,
      code: this.code,
      errno: this.errno,
      evidence: this.isWindowsRenameRefusal()
        ? "rename-refused-unverified"
        : this.phase === "replacement-installed"
          ? "replacement-installed"
          : "incomplete",
    };
  }

  async skipIfVerifiedWindowsRefusal(
    t: Pick<TestContext, "skip" | "diagnostic">,
  ) {
    if (!this.isWindowsRenameRefusal()) return false;
    const proof = this.refusal;
    assert.ok(
      proof?.after,
      "Windows rename refusal lacks complete generated fixture evidence",
    );
    const originalUnchanged = digest(proof.before) === digest(proof.after);
    assert.ok(
      originalUnchanged,
      "refused rename changed original generated fixture bytes or metadata",
    );
    assert.ok(
      proof.destinationAbsentAfter,
      "refused rename created its preserved destination",
    );
    const { root, destination, ownedTemporary } = proof.fixture;
    const settled = await snapshotFixture(root);
    assert.equal(
      await absent(destination),
      true,
      "preserved destination must remain absent after unwind",
    );
    const temporary = relative(root, ownedTemporary);
    assert.equal(
      settled.has(temporary),
      false,
      "only the app-owned temporary must be cleaned up after refused rename",
    );
    assert.equal(
      digest(afterOwnedCleanup(settled, temporary)),
      digest(afterOwnedCleanup(proof.before, temporary)),
      "refused rename unwind changed protected generated payloads, metadata or identities",
    );
    t.diagnostic(
      `replacement-refusal ${JSON.stringify({
        status: "BLOCKED",
        reason: "WIN32_RENAME_EPERM_4048",
        originalUnchanged,
        destinationAbsent: true,
        protectedUnchanged: true,
        ownedTemporaryRemoved: true,
        entriesBefore: proof.before.size,
        entriesAfter: settled.size,
        replacementInstalled: false,
      })}`,
    );
    t.skip(
      "BLOCKED: Windows EPERM/-4048 refused fixture rename; original payload/metadata unchanged, owned temporary cleaned; installed-replacement branch not exercised",
    );
    return true;
  }

  diagnose(t: Pick<TestContext, "diagnostic">) {
    t.diagnostic(`replacement-injection ${JSON.stringify(this.snapshot())}`);
  }

  assertInstalled() {
    // Refusal evidence never satisfies installed-replacement assertions.
    assert.equal(
      this.phase,
      "replacement-installed",
      `replacement injection incomplete: ${JSON.stringify(this.snapshot())}`,
    );
  }

  async assertSentinel(
    target: string,
    expected: string,
    role: "temporary" | "manifest" | "receipt",
  ) {
    this.assertInstalled();
    let content: Buffer;
    try {
      content = await fs.readFile(target);
    } catch (error) {
      assert.fail(
        `replacement ${role} read failed: ${JSON.stringify(nativeFailure(error))}`,
      );
    }
    assert.ok(
      content.equals(Buffer.from(expected)),
      `installed replacement ${role} sentinel must remain intact`,
    );
  }
}
