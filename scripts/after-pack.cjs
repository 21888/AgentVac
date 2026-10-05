// Preserve licenses inside the actual app bundle, including .app archives made on Linux.
const fs = require("node:fs/promises");
const path = require("node:path");
module.exports = async function preserveNotices(context) {
  const out = context.appOutDir;
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(
          out,
          context.packager.appInfo.productFilename + ".app",
          "Contents",
          "Resources",
        )
      : path.join(out, "resources");
  await fs.mkdir(resources, { recursive: true });
  for (const own of [
    ["LICENSE", "LICENSE.agentvac.txt"],
    ["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
  ]) {
    await fs.copyFile(
      path.join(context.packager.projectDir, own[0]),
      path.join(resources, own[1]),
    );
  }
  // Electron-builder removes the outer macOS notices during branding; afterExtract
  // has already copied the exact target runtime's notices into its Resources folder.
  for (const name of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
    if (!(await fs.stat(path.join(resources, name))).isFile())
      throw new Error("Bundled runtime notice missing: " + name);
  }
};
