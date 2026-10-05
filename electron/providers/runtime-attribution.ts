import path from "node:path";
/** Raw POSIX ps text loses argv boundaries. Only the minimal two-operand
 * shape can establish a single script without borrowing later arguments.
 * Flags, loaders, arguments and split/quoted POSIX paths remain unknown until
 * a separately verified lossless OS-argv collector is available. */
export function hasUnambiguousRawScript(
  command: string,
  platform: NodeJS.Platform,
  name: string,
  suffix: RegExp = /\.(?:[cm]?[jt]s|py)$/i,
): boolean {
  if (/[\x00-\x1f\x7f]/.test(command)) return false;
  if (
    !/^(?:node|nodejs|bun|deno|electron|java|javaw|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/i.test(
      name,
    )
  )
    return false;
  const match =
    platform === "win32"
      ? /^(?:"([^"\r\n]+)"|([^\s"\r\n]+)) +(?:"([^"\r\n]+)"|([^\s"\r\n]+))$/.exec(
          command.trim(),
        )
      : /^([^\s"'`\\]+) +([^\s"'`\\]+)$/.exec(command.trim());
  if (!match) return false;
  const executable = platform === "win32" ? (match[1] ?? match[2]) : match[1];
  const script = platform === "win32" ? (match[3] ?? match[4]) : match[2];
  if (!executable || !script || !suffix.test(script)) return false;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  if (
    !/^(?:node|nodejs|bun|deno|electron|java|javaw|python(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/i.test(
      flavor.basename(executable),
    )
  )
    return false;
  if (platform === "win32" && !/^[a-z]:[\\/]/i.test(script)) return false;
  return flavor.isAbsolute(script) && flavor.normalize(script) === script;
}
