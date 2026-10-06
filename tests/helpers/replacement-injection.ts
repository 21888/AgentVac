import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
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
const sharingRefusalCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

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

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async run(rename: () => Promise<unknown>, install: () => Promise<unknown>) {
    assert.equal(
      this.phase,
      "not-entered",
      "replacement hook ran more than once",
    );
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
      // Preserve the original exception for the engine's existing failure path.
      throw error;
    }
  }

  snapshot() {
    return {
      phase: this.phase,
      failureStage: this.failureStage,
      code: this.code,
      errno: this.errno,
      evidence:
        this.platform === "win32" &&
        this.failureStage === "rename" &&
        sharingRefusalCodes.has(this.code)
          ? "platform-limited"
          : this.phase === "replacement-installed"
            ? "replacement-installed"
            : "incomplete",
    };
  }

  diagnose(t: Pick<TestContext, "diagnostic">) {
    t.diagnostic(`replacement-injection ${JSON.stringify(this.snapshot())}`);
  }

  assertInstalled() {
    // Diagnostic-only until native Windows phases are observed. A native rename
    // refusal is useful platform evidence, but does not prove engine protection.
    // Never skip the replacement assertions merely because the hook was entered.
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
