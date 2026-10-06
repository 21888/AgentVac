// Test-only bridge: runs the production Vue UI against the real engine and generated fixtures.
// It never grants a browser arbitrary filesystem access or opens a real Codex directory.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.ts";
import { createDemo } from "../electron/fixtures.ts";
import { PreferenceStore } from "../electron/preferences.ts";
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-e2e-"),
);
const dist = path.resolve("dist");
const screenshots = path.resolve("docs/screenshots");
await fs.mkdir(screenshots, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const p = path.resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!p.startsWith(dist + path.sep)) throw new Error("Forbidden");
    res.setHeader(
      "Content-Type",
      p.endsWith(".html")
        ? "text/html; charset=utf-8"
        : p.endsWith(".js")
          ? "application/javascript"
          : p.endsWith(".css")
            ? "text/css"
            : "application/octet-stream",
    );
    res.end(await fs.readFile(p));
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
let engine;
let context = { root: null, demo: false, platform: process.platform };
const preferencesDirectory = path.join(base, "app-preferences");
await fs.mkdir(preferencesDirectory);
let preferenceWrites = 0;
let preferences = new PreferenceStore(preferencesDirectory);
await preferences.load();
let demoNumber = 0;
let opened = 0;
let copiedRoot = "";
let trashCalls = 0;
let errors = [];
let selectFixtureNext = false;
let holdNextScan = false;
let releaseScanGate = null;
let gateCancelled = false;
let processStatus = {
  status: "clear",
  details: "测试夹具：完整检查未检测到进程。",
};
const key = randomBytes(32);
const report = [];
const note = (name) => {
  report.push(name);
  console.log("PASS", name);
};
try {
  if (process.env.AGENTVAC_BROWSER)
    browser = await chromium.launch({
      executablePath: process.env.AGENTVAC_BROWSER,
      headless: true,
      chromiumSandbox: true,
    });
  else if (process.platform === "linux") {
    const { default: serverless } = await import("@sparticuz/chromium");
    browser = await chromium.launch({
      executablePath: await serverless.executablePath(),
      args: serverless.args,
      headless: true,
    });
  } else browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 1,
  });
  const idle = () =>
    page.waitForFunction(
      () => document.querySelector(".primary-nav button")?.disabled === false,
    );
  const waitTheme = (theme) =>
    page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      theme,
    );
  await page.emulateMedia({ colorScheme: "light" });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    const url = request.url();
    if (
      /^https?:/.test(url) &&
      !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
    )
      errors.push("Unexpected external renderer request: " + url);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to load|Refused to connect/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  await page.exposeFunction("__agentvacTest", async (method, args) => {
    switch (method) {
      case "getContext":
        return context;
      case "getPreferences":
        await preferences.flush();
        return preferences.current();
      case "setTheme":
        preferenceWrites++;
        return preferences.setTheme(args[0]);
      case "copyRootPath":
        copiedRoot = context.root;
        return;
      case "chooseRoot": {
        if (!selectFixtureNext) return null;
        selectFixtureNext = false;
        const root = path.join(base, "real-mode-fixture");
        await createDemo(root);
        engine = new AgentVacEngine(
          root,
          key,
          false,
          async () => processStatus,
        );
        await engine.initialize();
        context = { root, demo: false, platform: process.platform };
        return context;
      } // Still generated fixtures; only the UI safety mode changes.
      case "loadDemo": {
        const root = path.join(base, "demo-" + ++demoNumber);
        await createDemo(root);
        engine = new AgentVacEngine(root, key, true);
        await engine.initialize();
        context = { root, demo: true, platform: process.platform };
        return context;
      }
      case "cancelScan":
        engine.cancelScan();
        gateCancelled = true;
        releaseScanGate?.();
        return;
      case "scan": {
        if (!holdNextScan) return engine.scan(args[0]);
        holdNextScan = false;
        gateCancelled = false;
        const original = fs.lstat;
        let held = false;
        fs.lstat = async (p, ...rest) => {
          if (!held && p === context.root) {
            held = true;
            if (!gateCancelled)
              await new Promise((resolve) => {
                releaseScanGate = resolve;
              });
          }
          return original(p, ...rest);
        };
        try {
          return await engine.scan(args[0]);
        } finally {
          fs.lstat = original;
          releaseScanGate = null;
        }
      }
      case "preview":
        return engine.preview(args[0]);
      case "quarantine":
        return engine.quarantine(args[0], args[1]);
      case "history":
        return engine.history();
      case "restore":
        return engine.restore(args[0], args[1]);
      case "openQuarantine":
        await engine.getQuarantinePath();
        opened++;
        return;
      case "prepareTrash":
        return engine.prepareTrash(args[0]);
      case "cancelTrashConfirmation":
        return engine.cancelTrashConfirmation(args[0]);
      case "trash":
        return engine.trash(args[0], args[1], args[2], args[3], async (dir) => {
          await fs.mkdir(path.join(base, "mock-system-trash"), {
            recursive: true,
          });
          await fs.rename(
            dir,
            path.join(base, "mock-system-trash", path.basename(dir)),
          );
          trashCalls++;
        });
      default:
        throw new Error("Unknown test-only API");
    }
  });
  await page.addInitScript(() => {
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getPreferences",
        "setTheme",
        "copyRootPath",
        "chooseRoot",
        "loadDemo",
        "cancelScan",
        "scan",
        "preview",
        "quarantine",
        "history",
        "restore",
        "openQuarantine",
        "prepareTrash",
        "cancelTrashConfirmation",
        "trash",
      ].map((method) => [
        method,
        (...args) => window.__agentvacTest(method, args),
      ]),
    );
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page
    .getByRole("button", { name: "体验演示扫描", exact: true })
    .waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "01-welcome.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "选择 Codex 目录", exact: true })
    .click();
  assert.equal(context.root, null);
  note("onboarding + cancelled directory dialog leaves state untouched");
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  await waitTheme("dark");
  assert.equal(
    (await page.evaluate(() => window.agentvac.getPreferences())).theme,
    "dark",
  );
  const beforeRefresh = preferenceWrites;
  preferences = new PreferenceStore(preferencesDirectory);
  await preferences.load();
  await page.evaluate(() => localStorage.removeItem("agentvac.theme"));
  await page.reload();
  await idle();
  await waitTheme("dark");
  assert.equal(
    await page
      .getByRole("button", { name: "深色主题", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(preferenceWrites, beforeRefresh);
  note(
    "theme reload uses the real persisted preference even without localStorage cache, and hydration never writes it back",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await waitTheme("dark");
  await page.getByRole("button", { name: "浅色主题", exact: true }).click();
  await waitTheme("light");
  assert.equal(
    (await page.evaluate(() => window.agentvac.getPreferences())).theme,
    "light",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await waitTheme("light");
  note("explicit light and dark modes do not change with system colour-scheme");
  await page.getByRole("button", { name: "跟随系统主题", exact: true }).click();
  await waitTheme("dark");
  assert.equal(
    (await page.evaluate(() => window.agentvac.getPreferences())).theme,
    "system",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await waitTheme("light");
  note(
    "system appearance responds dynamically while preserving the persisted system mode",
  );

  await page.getByRole("button", { name: "体验演示扫描", exact: true }).click();
  await idle();
  await page.getByText("独立测试数据", { exact: true }).waitFor();
  holdNextScan = true;
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await page.getByRole("button", { name: "取消扫描", exact: true }).click();
  await idle();
  assert.equal(
    await page.getByTestId("scan-state").getAttribute("data-state"),
    "cancelled",
  );
  assert.equal(await page.locator(".file-table tbody tr").count(), 0);
  note("cancel scan remains responsive and leaves no stale selectable results");
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await page
    .locator(".file-table tbody tr")
    .filter({ hasText: "logs_1.sqlite" })
    .click();
  await page
    .locator(".inspector")
    .getByText("logs_1.sqlite", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择 logs_1.sqlite", exact: true })
      .isDisabled(),
    true,
  );
  note(
    "single-row inspector explains protected live log database without selecting it",
  );

  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "02-overview-demo.png"),
    fullPage: false,
    animations: "disabled",
  });
  note("real generated demo scan and space overview");
  await page.getByRole("button", { name: "复制目录路径", exact: true }).click();
  assert.equal(copiedRoot, context.root);
  note("copy directory invokes only the selected-root clipboard bridge");
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(screenshots, "08-workbench-1200.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(screenshots, "09-workbench-1024.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  note("file table, space attribution and inspector fit 1200×800 and 1024×768");
  await page.getByRole("button", { name: /^筛选日志，/ }).click();
  assert.equal(await page.locator(".file-table tbody tr").count(), 6);
  await page.getByRole("button", { name: "全部文件", exact: true }).click();
  note("clickable real-byte distribution filters actual matching files");

  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择 auth.json", exact: true })
    .waitFor();
  await idle();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择 auth.json", exact: true })
      .isDisabled(),
    true,
  );
  await idle();
  assert.equal(
    await page
      .getByRole("checkbox", {
        name: "选择 sessions/2025/06/rollout-demo-planning.jsonl",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  note("credentials and sessions protected by default");
  const search = page.getByRole("textbox", { name: "搜索文件路径" });
  await search.fill("nothing-matches-this");
  await page.getByText("没有符合条件的项目", { exact: true }).waitFor();
  await search.fill("");
  note("search empty state and reset");
  await page
    .getByRole("checkbox", { name: "选择当前列表中的安全项目", exact: true })
    .check();
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  let dialog = page.getByRole("dialog");
  assert.equal(
    await dialog
      .getByRole("button", { name: "确认演示隔离", exact: true })
      .isDisabled(),
    true,
  );
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "03-cleanup-preview-demo.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await idle();
  assert.equal((await engine.history()).length, 0);
  note("preview requires acknowledgement; Escape cancels without mutation");
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await page.emulateMedia({ colorScheme: "dark" });
  await waitTheme("dark");
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole("checkbox").isChecked(), true);
  await page.emulateMedia({ colorScheme: "light" });
  await waitTheme("light");
  assert.equal(await dialog.getByRole("checkbox").isChecked(), true);
  note(
    "system appearance changes preserve selected files and an acknowledged open confirmation",
  );
  await dialog
    .getByRole("button", { name: "确认演示隔离", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "整理完成，随时可以恢复", exact: true })
    .waitFor();
  await idle();
  assert.equal(
    (await engine.history())[0].items.filter((i) => i.status === "quarantined")
      .length,
    3,
  );
  note("explicit quarantine moves exactly selected 3 logs");
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  note("quarantine result transition retains focus inside its modal");
  await page.getByRole("button", { name: "查看隔离记录", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "04-quarantine-history-demo.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "打开隔离目录", exact: true }).click();
  assert.equal(opened, 1);
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await idle();
  assert.equal((await engine.history())[0].items[0].status, "quarantined");
  note("history and open-folder request; cancelled restore is non-mutating");
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认恢复", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "文件已回到原来的位置", exact: true })
    .waitFor();
  await idle();
  assert.equal(
    (await engine.history())[0].items.every((i) => i.status === "restored"),
    true,
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  note("complete recoverable quarantine → history → restore workflow");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  assert.equal(
    await page.getByRole("checkbox", { name: /包括历史会话/ }).isDisabled(),
    true,
  );
  await page
    .getByRole("combobox", { name: "候选文件最短年龄" })
    .selectOption("90");
  assert.equal(
    await page.getByTestId("scan-state").getAttribute("data-state"),
    "idle",
  );
  assert.equal(await page.locator(".file-table tbody tr").count(), 0);
  note("policy changes invalidate old scan and selection");
  await page
    .getByRole("combobox", { name: "候选文件最短年龄" })
    .selectOption("30");
  await page
    .getByRole("button", { name: "开始扫描", exact: true })
    .first()
    .click();
  await idle();
  assert.equal(
    await page
      .getByRole("checkbox", {
        name: "选择 sessions/2025/06/rollout-demo-planning.jsonl",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  note(
    "Codex session-file cleanup is gated even with old review settings; signed recovery remains available",
  );
  await page
    .getByRole("button", { name: "开始扫描", exact: true })
    .first()
    .click();
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
  await page
    .getByRole("button", { name: "移入系统回收站", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  assert.equal(
    await dialog
      .getByRole("button", { name: "确认移入系统回收站", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByTestId("trash-impact").check();
  await dialog.getByTestId("trash-closed").check();
  await dialog.getByPlaceholder("回收站", { exact: true }).fill("回收站");
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "05-system-trash-confirmation-demo.png"),
    fullPage: false,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "确认移入系统回收站", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "隔离批次已移入系统回收站", exact: true })
    .waitFor();
  assert.equal(trashCalls, 1);
  await idle();
  assert.equal(
    (await engine.history()).some((b) =>
      b.items.some((i) => i.status === "trashed"),
    ),
    true,
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  note(
    "typed double confirmation → mock system trash, signed receipt, no permanent deletion",
  );
  await page.getByRole("button", { name: "保护规则", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "06-protection-rules.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "隔离记录", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshots, "07-compact-history.png"),
    fullPage: false,
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  note("1024×768 desktop layout has no document horizontal overflow");
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  selectFixtureNext = true;
  await page
    .getByRole("button", { name: "切换目录", exact: true })
    .first()
    .click();
  await idle();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page
    .getByRole("button", { name: "开始扫描", exact: true })
    .first()
    .click();
  await idle();
  await page
    .getByRole("checkbox", { name: "选择当前列表中的安全项目", exact: true })
    .check();
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  dialog = page.getByRole("dialog");
  await idle();
  const confirmReal = dialog.getByRole("button", {
    name: "确认移入隔离区",
    exact: true,
  });
  await dialog.getByRole("checkbox").nth(0).check();
  assert.equal(await confirmReal.isDisabled(), true);
  await dialog.getByRole("checkbox").nth(1).check();
  assert.equal(await confirmReal.isEnabled(), true);
  assert.equal(await page.locator("main").evaluate((el) => el.inert), true);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  note(
    "real-mode fixture requires closed-process acknowledgement; modal focus stays trapped",
  );
  processStatus = {
    status: "running",
    details: "测试夹具：Codex 进程正在运行",
  };
  await confirmReal.click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "检测到 Codex 正在运行" })
    .waitFor();
  await idle();
  assert.equal((await engine.history()).length, 0);
  await page.keyboard.press("Escape");
  note("newly running process blocks operation after preview with no mutation");
  processStatus = { status: "clear", details: "测试夹具：未检测到运行进程" };
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").nth(0).check();
  await dialog.getByRole("checkbox").nth(1).check();
  await fs.appendFile(
    path.join(context.root, "log/codex-tui.log.1"),
    "changed-after-preview",
  );
  await dialog
    .getByRole("button", { name: "确认移入隔离区", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "操作完成，部分项目需留意", exact: true })
    .waitFor();
  await idle();
  const partialBatch = (await engine.history())[0];
  assert.equal(
    partialBatch.items.filter((i) => i.status === "quarantined").length,
    2,
  );
  assert.equal(
    partialBatch.items.filter((i) => i.status === "failed").length,
    1,
  );
  note(
    "GUI partial quarantine clearly reports changed file while preserving unaffected success",
  );
  await page.getByRole("button", { name: "查看隔离记录", exact: true }).click();
  await fs.writeFile(
    path.join(context.root, "log/codex-tui.log.2"),
    "new conflicting fixture",
  );
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.equal(
    await dialog
      .getByRole("button", { name: "确认恢复", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page
    .getByRole("heading", { name: "操作完成，部分项目需留意", exact: true })
    .waitFor();
  await idle();
  assert.equal(
    await fs.readFile(path.join(context.root, "log/codex-tui.log.2"), "utf8"),
    "new conflicting fixture",
  );
  note(
    "GUI restore closure confirmation and destination-conflict partial result; no overwrite",
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const oldDate = new Date(Date.now() - 90 * 86400000);
  await Promise.all(
    Array.from({ length: 225 }, async (_, i) => {
      const p = path.join(context.root, "log", `codex-tui.log.${1001 + i}`);
      await fs.writeFile(p, `fixture ${i}`);
      await fs.utimes(p, oldDate, oldDate);
    }),
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  assert.equal(await page.locator(".file-table tbody tr").count(), 100);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await page.locator(".file-table tbody tr").count(), 100);
  assert.match(await page.locator(".pagination").innerText(), /2\s*\/\s*3/);
  note(
    "large fixture table paginates at 100 rows without mounting all records",
  );
  await page
    .getByRole("textbox", { name: "搜索文件路径" })
    .fill("no-matches-reset-page");
  await page.getByText("没有符合条件的项目", { exact: true }).waitFor();
  assert.match(await page.locator(".pagination").innerText(), /1\s*\/\s*1/);
  await page
    .getByRole("textbox", { name: "搜索文件路径" })
    .fill("log/codex-tui.log.1001");
  const keyboardRow = page.locator(".file-table tbody tr").first();
  await keyboardRow.focus();
  await page.keyboard.press("Space");
  assert.equal(
    await page
      .getByRole("checkbox", {
        name: "选择 log/codex-tui.log.1001",
        exact: true,
      })
      .isChecked(),
    true,
  );
  await page.keyboard.press("Enter");
  await page
    .locator(".inspector")
    .getByText("codex-tui.log.1001", { exact: true })
    .first()
    .waitFor();
  await page.keyboard.press("Space");
  assert.equal(
    await page
      .getByRole("checkbox", {
        name: "选择 log/codex-tui.log.1001",
        exact: true,
      })
      .isChecked(),
    false,
  );
  note(
    "filter resets pagination; row keyboard Enter inspects and Space toggles explicit selection",
  );
  assert.deepEqual(errors, []);
  note("no unhandled renderer errors");
  await fs.rm(path.join(screenshots, "e2e-failure.png"), { force: true });
  await fs.writeFile(
    "docs/e2e-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment:
          "Linux headless Chromium; test-only bridge to real engine; mock OS trash",
        passed: report,
        screenshots: await fs.readdir(screenshots),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  if (browser) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) {
      await pages[0].screenshot({
        path: path.join(screenshots, "e2e-failure.png"),
        fullPage: false,
        animations: "disabled",
      });
      console.error(
        (await pages[0].locator("body").innerText()).slice(0, 7000),
      );
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
