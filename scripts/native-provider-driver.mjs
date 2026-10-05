// esbuild compiles the original harness below; dynamic import preserves the
// provenance preflight before any synthetic fixture or Electron launch.
import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyNativeDriverExecution } from "./native-driver-provenance.mjs";
const execution = await verifyNativeDriverExecution(import.meta.url);
const out =
  process.env.AGENTVAC_NATIVE_EVIDENCE_DIR ||
  path.resolve(".qa/native-provider-evidence");
await fs.mkdir(out, { recursive: true });
await fs.writeFile(
  path.join(out, `provider-driver-${process.platform}-${process.arch}.json`),
  JSON.stringify(execution, null, 2) + "\n",
);
await import("./native-provider-regression.mjs");
