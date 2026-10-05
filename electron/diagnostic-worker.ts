import path from "node:path";
import { inspectSqliteInWorker } from "./diagnostic-parser.js";
import {
  MAX_DIAGNOSTIC_REQUEST,
  validateDiagnosticResult,
} from "./diagnostic-protocol.js";
// This process alone loads SQLite. It never spawns descendants or writes source data.
// An independent async supervisor owns its lifetime even when DatabaseSync blocks.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_DIAGNOSTIC_REQUEST) process.exit(1);
});
process.stdin.on("end", async () => {
  try {
    const request = JSON.parse(input);
    if (
      typeof request.databasePath !== "string" ||
      typeof request.expected !== "string" ||
      request.databasePath.length > 4096 ||
      request.expected.length > 512
    )
      throw new Error();
    const result = validateDiagnosticResult(
      await inspectSqliteInWorker(
        request.databasePath,
        [{ path: path.dirname(request.databasePath), kind: "sqlite-home" }],
        request.expected,
      ),
    );
    process.stdout.end(
      JSON.stringify(
        result ?? { status: "blocked", reason: "WORKER_PROTOCOL_INVALID" },
      ),
    );
  } catch {
    process.stdout.end(
      JSON.stringify({ status: "blocked", reason: "WORKER_FAILED" }),
    );
  }
});
