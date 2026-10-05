import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProcessBlockers } from "../scripts/native-process-diagnostics.mjs";
import { claudeCodeAdapter } from "../electron/providers/claude-code.js";
test("native process diagnostics identify known system-script ambiguity without disclosing raw commands or private arguments", () => {
  const report = summarizeProcessBlockers(
    {
      platform: "linux",
      complete: true,
      processes: [
        {
          pid: 42,
          name: "/usr/bin/python3",
          commandLine:
            "/usr/bin/python3 /usr/bin/networkd-dispatcher --private-secret=DO_NOT_LOG",
        },
        { pid: 43, name: "node", commandLine: "node -e SECRET_CODE" },
      ],
    },
    claudeCodeAdapter,
  );
  assert.equal(report.blockers.length, 2);
  assert.ok(!JSON.stringify(report).includes("networkd-dispatcher"));
  assert.equal(report.blockers[1].inlineRuntime, true);
  assert.ok(!JSON.stringify(report).includes("DO_NOT_LOG"));
  assert.ok(!JSON.stringify(report).includes("SECRET_CODE"));
  assert.ok(!JSON.stringify(report).includes("/usr/bin/"));
});
test("native guard diagnostics expose only stable observation/refusal codes", () => {
  const report = summarizeProcessBlockers(
    {
      platform: "linux",
      complete: true,
      processes: [
        {
          pid: 50,
          name: "MainThread",
          commandLine: "node SECRET_SCRIPT SECRET_ARGUMENT",
          argumentObservation: {
            status: "unavailable",
            pid: 50,
            reason: "permission",
          },
        },
      ],
    },
    claudeCodeAdapter,
  );
  assert.equal(report.blockers[0].argumentObservation, "unavailable");
  assert.equal(report.blockers[0].argumentRefusal, "permission");
  assert.equal(report.blockers[0].observedClassification, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /SECRET_/);
});
