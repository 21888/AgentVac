import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
const source = await readFile(
  new URL("./report-stages.mjs", import.meta.url),
  "utf8",
);
const names = [
  "SOURCE",
  "INSTALL",
  "BATCH",
  "ACL_PREPARE",
  "ACL",
  "RECOVERY",
  "BUILD",
  "OBSERVED_BUILD",
  "OBSERVER",
  "DESKTOP",
  "PROVIDERS",
  "ACL_CONTRACTS",
  "SOURCE_AFTER",
  "OBSERVED_AFTER",
];
function run(platform, changes = {}) {
  const logs = [];
  const env = Object.fromEntries(names.map((n) => ["AV_DIAG_" + n, "success"]));
  const process = { platform, env: { ...env, ...changes }, exitCode: 0 };
  runInNewContext(source, {
    process,
    console: { log: (text) => logs.push(text) },
  });
  assert.equal(logs.length, 1);
  return { result: JSON.parse(logs[0]), code: process.exitCode, text: logs[0] };
}
for (const [platform, expected] of [
  ["darwin", 10],
  ["win32", 8],
]) {
  test(platform + " expected stages remain diagnostic-only on success", () => {
    const { result, code } = run(platform);
    assert.equal(code, 0);
    assert.equal(result.expected, expected);
    assert.equal(result.successfulSteps, expected);
    assert.equal(result.productionAccepted, false);
  });
}
test("a failed native fixture cannot become a successful stage report", () => {
  const { result, code } = run("darwin", { AV_DIAG_DESKTOP: "failure" });
  assert.equal(code, 1);
  assert.equal(result.failedSteps, 1);
  assert.equal(result.productionAccepted, false);
});
test("cancelled, skipped and missing expected stages remain missing evidence", () => {
  const { result, code } = run("win32", {
    AV_DIAG_ACL: "cancelled",
    AV_DIAG_RECOVERY: "skipped",
    AV_DIAG_ACL_PREPARE: "",
  });
  assert.equal(code, 1);
  assert.equal(result.missingSteps, 3);
});
test("unexpected environment values do not leak and cannot count as success", () => {
  const { result, code, text } = run("darwin", {
    AV_DIAG_PROVIDERS: "SECRET /private/path --argument",
  });
  assert.equal(code, 1);
  assert.equal(result.missingSteps, 1);
  assert.equal(text.includes("SECRET"), false);
});
test("unsupported platform does not count as a diagnostic pass", () => {
  const { result, code } = run("linux");
  assert.equal(code, 1);
  assert.equal(result.platform, "unsupported");
});
