import { knownProviderEntrypoint as known } from "./vendor-entrypoint.js";
import path from "node:path";
import type { ProviderId } from "../../shared/types.js";
import type { ProcessRecord } from "./types.js";

export type ObservedRuntimeStatus =
  "absent" | "running" | "attributed" | "unknown";
const basename = (value: string) => path.posix.basename(value);
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const python = /^python(?:\d+(?:\.\d+)*)?$/;
const node = /^(?:node|nodejs)$/;

/** Private backend observation only. It is neither an immutable launch record nor a writer lock. */
export function assessObservedRuntime(
  record: ProcessRecord,
  provider: ProviderId,
): ObservedRuntimeStatus {
  const observed = record.argumentObservation;
  if (!observed) return "absent";
  if (
    observed.status !== "verified" ||
    observed.platform !== "linux" ||
    observed.source !== "linux-proc" ||
    observed.pid !== record.pid ||
    (record.parentPid !== undefined &&
      observed.parentPid !== record.parentPid) ||
    !Number.isSafeInteger(observed.pid) ||
    observed.pid < 1 ||
    !Number.isSafeInteger(observed.parentPid) ||
    observed.parentPid < 0 ||
    observed.executablePath !== record.executablePath ||
    typeof observed.startId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(observed.startId) ||
    BigInt(observed.startId) > 18446744073709551615n ||
    typeof observed.executablePath !== "string" ||
    !path.posix.isAbsolute(observed.executablePath) ||
    controls.test(observed.executablePath) ||
    !Array.isArray(observed.argv) ||
    !observed.argv.length ||
    observed.argv.length > 512 ||
    observed.argv.some(
      (part) => typeof part !== "string" || controls.test(part),
    ) ||
    observed.argv.reduce(
      (size, part) => size + Buffer.byteLength(part) + 1,
      0,
    ) > 65536
  )
    return "unknown";
  const argv = observed.argv;
  if (known(provider, observed.executablePath)) return "running";
  const runtime = basename(observed.executablePath);
  const argRuntime = basename(argv[0]);
  const isNode = node.test(runtime) && node.test(argRuntime);
  const isPython = python.test(runtime) && python.test(argRuntime);
  // Unsupported embeddings, Bun, alternate runtimes and rewritten argv[0] stay unknown.
  if (!isNode && !isPython) return "unknown";
  let index = 1,
    attributed = true;
  while (index < argv.length) {
    const value = argv[index];
    if (value === "--") {
      index++;
      break;
    }
    if (!value.startsWith("-") || value === "-") break;
    if (isPython && (value === "-m" || value.startsWith("-m"))) {
      const module = value === "-m" ? argv[index + 1] : value.slice(2);
      return typeof module === "string" && known(provider, module)
        ? "running"
        : "unknown";
    }
    if (
      (isPython && value.startsWith("-c")) ||
      (isNode && /^(?:-e|-p|--eval|--print)(?:=|$)/.test(value))
    )
      return "unknown";
    if (isNode) {
      const loader =
        /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=(.*))?$/.exec(
          value,
        );
      if (loader) {
        const target = loader[1] ?? argv[index + 1];
        if (typeof target === "string" && known(provider, target))
          return "running";
        return "unknown";
      }
      // Only recognize these no-operand options to locate known vendor scripts.
      // They never grant an unrelated attribution result in this first policy.
      if (
        /^(?:--inspect(?:-brk)?(?:=.*)?|--no-warnings|--trace-warnings)$/.test(
          value,
        )
      ) {
        attributed = false;
        index++;
        continue;
      }
      return "unknown";
    }
    if (/^-(?:B|E|I|O|OO|s|S|u|q|v|b|bb)$/.test(value)) {
      index++;
      continue;
    }
    // -X can activate imports (for example presite); warning category options can
    // resolve modules too. Do not turn an option operand into an unrelated script.
    return "unknown";
  }
  const script = argv[index];
  if (!script || script === "-") return "unknown";
  if (known(provider, script)) return "running";
  if (
    !attributed ||
    !path.posix.isAbsolute(script) ||
    path.posix.normalize(script) !== script ||
    script.endsWith("/") ||
    (isNode && !/\.(?:[cm]?js|[cm]?ts)$/.test(script))
  )
    return "unknown";
  // Script arguments are data, not executable/loader evidence. No source or environment is read.
  return "attributed";
}
