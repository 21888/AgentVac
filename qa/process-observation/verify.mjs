import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPins, verifyObservedProject, targetRelative } from "./core.mjs";
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
await loadPins(path.join(root, "qa/process-observation"), expectedPinsSha256);
console.log(
  "AGENTVAC_INSTRUMENTED_VERIFY " +
    JSON.stringify(
      await verifyObservedProject(path.join(root, targetRelative)),
    ),
);
