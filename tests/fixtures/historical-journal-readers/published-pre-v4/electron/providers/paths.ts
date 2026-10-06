import path from "node:path";
export function validRelative(p: string): boolean {
  return (
    !!p &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    !path.posix.isAbsolute(p) &&
    !/^[a-z]:/i.test(p) &&
    p.split("/").every((s) => s && s !== "." && s !== ".." && !s.includes(":"))
  );
}
