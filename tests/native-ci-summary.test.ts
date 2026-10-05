import { test } from "node:test";
import assert from "node:assert/strict";
// The summary is a plain Node script so it runs before/after build failures.
import {
  requiredNativeChecks,
  validateNativeEvidence,
} from "../scripts/native-ci-summary.mjs";

const expected = {
  sourceRevision: "fixture-sha",
  ciRunId: "12",
  ciRunAttempt: "2",
  platform: "win32",
  arch: "x64",
};
function report() {
  return {
    ...expected,
    nativeExecution: true,
    packagedArtifactTested: false,
    status: "PASS_WITH_LIMITATIONS",
    checks: Object.fromEntries(
      requiredNativeChecks.map((name: string) => [name, { status: "PASS" }]),
    ),
  };
}

test("fresh source-native evidence may retain explicitly untested installer/UI scope", () => {
  assert.deepEqual(validateNativeEvidence(report(), expected), []);
});
test("stale commit, run, attempt and architecture evidence is refused", () => {
  for (const field of Object.keys(expected)) {
    const stale = { ...report(), [field]: "old" };
    assert.ok(
      validateNativeEvidence(stale, expected).some((problem: string) =>
        problem.includes(field),
      ),
    );
  }
});
test("required native skips and missing checks cannot produce source-native acceptance", () => {
  const skipped = report();
  skipped.checks["diagnostic-cancel-no-orphans"].status = "SKIP";
  assert.ok(
    validateNativeEvidence(skipped, expected).some((problem: string) =>
      problem.includes("diagnostic-cancel-no-orphans"),
    ),
  );
  delete skipped.checks["native-trash-generated-batch"];
  assert.ok(
    validateNativeEvidence(skipped, expected).some((problem: string) =>
      problem.includes("native-trash-generated-batch"),
    ),
  );
});
test("self-test or mislabeled packaged evidence is not source-native acceptance", () => {
  assert.ok(
    validateNativeEvidence({ ...report(), nativeExecution: false }, expected)
      .length,
  );
  assert.ok(
    validateNativeEvidence(
      { ...report(), packagedArtifactTested: true },
      expected,
    ).length,
  );
  assert.ok(
    validateNativeEvidence({ ...report(), status: "FAIL" }, expected).length,
  );
});
