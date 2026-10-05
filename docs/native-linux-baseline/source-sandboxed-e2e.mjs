// Run on a real desktop (or Xvfb on Linux). Unlike e2e.mjs this uses the real Electron preload/IPC.
// Only generated demo fixtures are touched; application metadata uses a separate temporary profile.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const userData = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-native-qa-"),
);
let application;
let demoRoot;
try {
  application = await electron.launch({
    chromiumSandbox: true,
    args: ["."],
    timeout: 30000,
    env: { ...process.env, AGENTVAC_TEST_USER_DATA: userData },
  });
  const page = await application.firstWindow();
  const launchArgs = await application.evaluate(() => process.argv);
  assert.ok(!launchArgs.includes("--no-sandbox"), "Chromium sandbox must stay enabled");
  await page.getByRole("button", { name: "体验演示扫描", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  demoRoot = (await page.evaluate(() => window.agentvac.getContext())).root;
  assert.ok(demoRoot && path.basename(demoRoot).startsWith("agentvac-demo-"));
  await page
    .getByRole("checkbox", { name: "选择当前列表中的安全项目", exact: true })
    .check();
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认演示隔离", exact: true })
    .click();
  await page.getByRole("button", { name: "查看隔离记录", exact: true }).click();
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认恢复", exact: true })
    .click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const rows = await page.evaluate(() => window.agentvac.history());
  assert.equal(
    rows[0].items.every((item) => item.status === "restored"),
    true,
  );
  await page.screenshot({
    path: `docs/native-linux/source-sandboxed-${process.platform}.png`,
    animations: "disabled",
  });
  await fs.writeFile(
    `docs/native-linux/source-sandboxed-${process.platform}-results.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        platform: process.platform,
        chromiumSandboxRequested: true,
        launchArgs,
        electron: await application.evaluate(() => process.versions.electron),
        checks: [
          "real desktop window launched",
          "sandboxed preload and verified IPC",
          "generated demo scan",
          "confirmed quarantine",
          "history",
          "restore exact batch",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS native Electron UI/IPC fixture workflow on",
    process.platform,
  );
} finally {
  await application?.close();
  await fs.rm(userData, { recursive: true, force: true });
  if (demoRoot && path.basename(demoRoot).startsWith("agentvac-demo-"))
    await fs.rm(demoRoot, { recursive: true, force: true });
}
