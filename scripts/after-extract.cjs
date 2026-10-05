// Keep the exact target Electron runtime notices before macOS branding removes them.
const fs = require("node:fs/promises");
const path = require("node:path");
module.exports = async function preserveRuntimeNotices(context) {
  const out = context.appOutDir;
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(
          out,
          context.packager.info.framework.distMacOsAppName,
          "Contents",
          "Resources",
        )
      : path.join(out, "resources");
  await fs.mkdir(resources, { recursive: true });
  let source;
  for (const name of ["LICENSE.electron.txt", "LICENSE"]) {
    try {
      await fs.access(path.join(out, name));
      source = path.join(out, name);
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!source)
    throw new Error("Electron runtime license missing from extracted archive.");
  await fs.copyFile(source, path.join(resources, "LICENSE.electron.txt"));
  await fs.copyFile(
    path.join(out, "LICENSES.chromium.html"),
    path.join(resources, "LICENSES.chromium.html"),
  );
};
