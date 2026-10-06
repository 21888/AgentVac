// Fixed-location QA builder; no arbitrary source or output arguments.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildObservedProject } from "./core.mjs";
const expectedPinsSha256 =
  "49f5cce3cccdc09e12abc2da9d6d2bb3ca64b9e386a934f36edd2eec30460801";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
if (
  process.argv.length !== 2 ||
  process.execArgv.length ||
  process.env.NODE_OPTIONS?.trim() ||
  process.cwd() !== root
)
  throw new Error("PROCESS_OBSERVER_UNEXPECTED_EXECUTION");
const receipt = await buildObservedProject(root, expectedPinsSha256);
console.log(
  "AGENTVAC_INSTRUMENTED_BUILD " +
    JSON.stringify({
      instrumented: true,
      productionAcceptance: false,
      target: receipt.target,
      pinsSha256: receipt.pinsSha256,
      sourceDigest: receipt.sourceDigestBefore,
      productionDigest: receipt.productionDigestBefore,
      copiedSourceDigest: receipt.copiedSourceDigest,
      builtDigest: receipt.builtDigest,
      originalProductionFilesUnchanged:
        receipt.originalProductionFilesUnchanged,
    }),
);
