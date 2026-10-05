import path from "node:path";
/** Internal layout-only resolver. No filesystem search, env, executable or caller override. */
export function resolvePackagedWorker(
  moduleDirectory: string,
  bundled: boolean,
): string {
  const directory = path.resolve(moduleDirectory);
  let output: string;
  if (bundled && path.basename(directory) === "dist-electron")
    output = directory;
  else if (
    path.basename(directory) === "native-harness" &&
    path.basename(path.dirname(directory)) === ".qa"
  ) {
    output = path.resolve(directory, "../../dist-electron");
  } else if (
    !bundled &&
    path.basename(directory) === "process-argv-linux" &&
    path.basename(path.dirname(directory)) === "electron"
  ) {
    output = path.resolve(directory, "../../dist-electron");
  } else throw new Error("process-argv-worker-layout-unavailable");
  return path.join(
    output.replace(/\.asar([\\/])/gu, ".asar.unpacked$1"),
    "process-argv-worker.cjs",
  );
}
