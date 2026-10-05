import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const afterExtract = require("../scripts/after-extract.cjs");
const afterPack = require("../scripts/after-pack.cjs");
for (const platform of ["darwin", "linux", "win32"]) {
  test(`packaging preserves exact target runtime licenses inside ${platform} app`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentvac-packaging-fixture-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const out = path.join(root, "out");
    await fs.mkdir(out);
    await fs.writeFile(
      path.join(out, "LICENSE"),
      `Electron ${platform} fixture license`,
    );
    await fs.writeFile(
      path.join(out, "LICENSES.chromium.html"),
      `Chromium ${platform} fixture notices`,
    );
    const context = {
      appOutDir: out,
      electronPlatformName: platform,
      packager: {
        projectDir: process.cwd(),
        info: { framework: { distMacOsAppName: "Electron.app" } },
        appInfo: { productFilename: "AgentVac" },
      },
    };
    await afterExtract(context);
    if (platform === "darwin") {
      await fs.rename(
        path.join(out, "Electron.app"),
        path.join(out, "AgentVac.app"),
      );
      await fs.unlink(path.join(out, "LICENSE"));
      await fs.unlink(path.join(out, "LICENSES.chromium.html"));
    }
    await afterPack(context);
    const resources =
      platform === "darwin"
        ? path.join(out, "AgentVac.app/Contents/Resources")
        : path.join(out, "resources");
    assert.equal(
      await fs.readFile(path.join(resources, "LICENSE.electron.txt"), "utf8"),
      `Electron ${platform} fixture license`,
    );
    assert.equal(
      await fs.readFile(path.join(resources, "LICENSES.chromium.html"), "utf8"),
      `Chromium ${platform} fixture notices`,
    );
    for (const [source, target] of [
      ["LICENSE", "LICENSE.agentvac.txt"],
      ["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
    ]) {
      assert.equal(
        await fs.readFile(path.join(resources, target), "utf8"),
        await fs.readFile(source, "utf8"),
      );
    }
  });
}
