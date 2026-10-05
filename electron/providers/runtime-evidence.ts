import type { ProcessRecord } from "./types.js";
const basename = (value: string) =>
  value.replaceAll("\\", "/").split("/").at(-1) ?? "";
/** Evidence hints only. They can make a record more conservative, never prove it unrelated. */
export function processExecutableHints(record: ProcessRecord): string[] {
  const out = [record.name];
  if (typeof record.executablePath === "string" && record.executablePath)
    out.push(record.executablePath);
  if (typeof record.commandLine === "string") {
    const match = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))/.exec(
      record.commandLine.trim(),
    );
    const first = match?.[1] ?? match?.[2] ?? match?.[3];
    if (first) out.push(first);
  }
  return out;
}
export function isGenericRuntimeCandidate(record: ProcessRecord): boolean {
  return processExecutableHints(record).some((value) =>
    /^(?:node|nodejs|bun|deno|electron|java|javaw|python)(?:[0-9_. -]|$)/i.test(
      basename(value),
    ),
  );
}
