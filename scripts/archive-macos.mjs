// Cross-host packaging: preserve macOS framework symlinks rather than dereferencing them.
// This only archives the generated .app directories; it does not sign, notarize, or execute them.
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const output = path.resolve(process.argv[2] || "release-mac");
async function validateLinks(dir, bundle) {
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name);
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), await fs.readlink(file));
      if (!target.startsWith(bundle + path.sep))
        throw new Error("Bundle symlink escapes app: " + file);
    } else if (st.isDirectory()) await validateLinks(file, bundle);
  }
}
for (const [arch, folder] of [
  ["x64", "mac"],
  ["arm64", "mac-arm64"],
]) {
  const input = path.join(output, folder);
  const bundle = path.join(input, "AgentVac.app");
  if (!(await fs.lstat(bundle)).isDirectory())
    throw new Error("Missing generated macOS app: " + bundle);
  await validateLinks(bundle, bundle);
  const zip = path.join(output, `AgentVac-0.1.0-macos-${arch}.zip`);
  try {
    await fs.unlink(zip);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await new Promise((resolve, reject) => {
    const child = spawn("zip", ["-q", "-r", "-y", zip, "AgentVac.app"], {
      cwd: input,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("zip exited " + code)),
    );
  });
  console.log("Created symlink-preserving macOS archive:", zip);
}
