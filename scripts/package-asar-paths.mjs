import path from "node:path";

// @electron/asar traverses its header using the host's path.sep. Its API
// members must therefore use native separators; portable report/allowlist
// paths are normalized separately after listPackage returns.
export function asarMemberPath(relative, hostPath = path) {
  return hostPath.normalize(relative);
}

export function portableAsarEntry(entry, hostPath = path) {
  return entry.split(hostPath.sep).join("/");
}
