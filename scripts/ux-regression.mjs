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
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-e2e-"),
);
const dist = path.resolve("dist");
const screenshots = path.resolve("docs/ux-focused");
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
let preferences = { theme: "system" };
let demoNumber = 0;
let quarantineCalls = 0;
let throwAfterQuarantine = false;
let throwAfterRestore = false;
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
  const capture = page.screenshot.bind(page);
  let auditIndex = 0;
  const auditStates = [];
  const audit = async (label) => {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1024, height: 768 });
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        colorScheme,
      );
      const file =
        String(++auditIndex).padStart(2, "0") +
        "-" +
        label +
        "-" +
        colorScheme +
        ".png";
      await capture({
        path: path.join(screenshots, file),
        animations: "disabled",
      });
      const layout = await page.evaluate(() => ({
        focus: {
          tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute("aria-label"),
          inModal: !!document.activeElement?.closest('[role="dialog"]'),
        },
        modalOpen: !!document.querySelector('[role="dialog"]'),
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        modalOverflow: [...document.querySelectorAll(".modal")].map((el) => ({
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
          height: el.clientHeight,
          scrollHeight: el.scrollHeight,
        })),
        chartStops: document.querySelectorAll('.disk-chart [tabindex="0"]')
          .length,
        visibleText: document.body.innerText,
      }));
      auditStates.push({ label, theme: colorScheme, file, ...layout });
      await fs.writeFile(
        path.join(screenshots, "audit-states.json"),
        JSON.stringify(auditStates, null, 2),
      );
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize(viewport);
  };
  page.screenshot = async (options) => {
    await audit(path.basename(options.path, ".png"));
    return capture(options);
  };
  const idle = () =>
    page.waitForFunction(
      () => document.querySelector(".primary-nav button")?.disabled === false,
    );
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
        return preferences;
      case "setTheme": {
        if (!["system", "light", "dark"].includes(args[0]))
          throw new Error("invalid theme");
        preferences = { theme: args[0] };
        return preferences;
      }
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
        quarantineCalls++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (throwAfterQuarantine) {
          throwAfterQuarantine = false;
          await engine.quarantine(args[0], args[1]);
          throw new Error("测试夹具：文件移动后结果写入中断");
        }
        return engine.quarantine(args[0], args[1]);
      case "history":
        return engine.history();
      case "restore":
        if (throwAfterRestore) {
          throwAfterRestore = false;
          await engine.restore(args[0], args[1]);
          throw new Error("测试夹具：恢复后结果写入中断");
        }
        return engine.restore(args[0], args[1]);
      case "openQuarantine":
        await engine.getQuarantinePath();
        opened++;
        return;
      case "trash":
        return engine.trash(args[0], args[1], async (dir) => {
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
  await page.getByRole("button", { name: "体验演示扫描", exact: true }).click();
  await idle();
  await page.getByText("独立测试数据", { exact: true }).waitFor();

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction(
      (t) => document.documentElement.dataset.theme === t,
      theme,
    );
    const themeLineHeights = await page
      .locator(".theme-switcher button > span")
      .evaluateAll((elements) =>
        elements.map((el) => el.getBoundingClientRect().height),
      );
    assert.ok(themeLineHeights.every((height) => height < 20));
    assert.equal(await page.locator('.disk-chart [tabindex="0"]').count(), 1);
    assert.equal(
      await page.locator('.file-table tbody tr[tabindex="0"]').count(),
      1,
    );
    await audit("compact-controls-roving-focus");
  }
  note(
    "1024px theme controls stay on one line in both themes; chart and table each have one tab stop",
  );
  const firstArc = page.locator('.file-arc[tabindex="0"]');
  await firstArc.focus();
  const firstKey = await firstArc.getAttribute("data-chart-key");
  await page.keyboard.press("ArrowRight");
  assert.notEqual(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-chart-key"),
    ),
    firstKey,
  );
  await page.keyboard.press("Home");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-chart-key"),
    ),
    firstKey,
  );
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.locator(".inspector").waitFor();
  await page.getByRole("button", { name: "清除检查项", exact: true }).click();
  note("chart roving focus supports arrows, Home/End and Enter inspection");
  const safeBox = page.getByRole("checkbox", {
    name: "选择 log/codex-tui.log.1",
    exact: true,
  });
  await safeBox.check();
  const bulkBox = page.getByRole("checkbox", {
    name: "选择当前列表中的安全项目",
    exact: true,
  });
  assert.equal(await bulkBox.evaluate((el) => el.indeterminate), true);
  await bulkBox.check();
  assert.equal(await bulkBox.evaluate((el) => el.indeterminate), false);
  const previewButton = page.getByRole("button", {
    name: "预览隔离操作",
    exact: true,
  });
  await previewButton.click();
  await page.getByRole("dialog").waitFor();
  await idle();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await previewButton.evaluate((el) => document.activeElement === el),
    true,
  );
  note(
    "partial selection has a mixed bulk checkbox; Escape restores the original enabled trigger",
  );
  await previewButton.click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "确认演示隔离", exact: true })
    .click({ clickCount: 2 });
  await page
    .getByRole("heading", { name: "整理完成，随时可以恢复", exact: true })
    .waitFor();
  await idle();
  assert.equal(quarantineCalls, 1);
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  await audit("result-focus-after-double-click");
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator(".scan-heading h1")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  note(
    "rapid double click invokes quarantine once; result focus stays inside; Escape falls back to page heading when trigger is disabled",
  );
  await page.getByRole("button", { name: "隔离记录", exact: true }).click();
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page
    .getByRole("heading", { name: "文件已回到原来的位置", exact: true })
    .waitFor();
  await idle();
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator(".page-title h1")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  note(
    "restore result also re-focuses; Escape returns to the current page heading for its disabled trigger",
  );
  selectFixtureNext = true;
  await page.getByRole("button", { name: "切换目录", exact: true }).click();
  await idle();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await bulkBox.check();
  await previewButton.click();
  await page.getByRole("dialog").getByRole("checkbox").nth(0).check();
  await page.getByRole("dialog").getByRole("checkbox").nth(1).check();
  processStatus = { status: "running", details: "测试夹具：Codex 正在运行" };
  await page
    .getByRole("button", { name: "确认移入隔离区", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await idle();
  assert.equal(
    await page
      .getByRole("button", { name: "确认移入隔离区", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".modal-error")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await audit("blocked-action-with-clear-recheck");
  processStatus = { status: "clear", details: "测试夹具：Codex 已退出" };
  await page
    .getByRole("button", { name: "重新检查所选项目", exact: true })
    .click();
  await idle();
  assert.equal(await page.locator(".modal-error").count(), 0);
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  assert.equal(
    await page.getByRole("dialog").getByRole("checkbox").nth(0).isChecked(),
    false,
  );
  assert.equal(
    await page.getByRole("dialog").getByRole("checkbox").nth(1).isChecked(),
    false,
  );
  await audit("rechecked-preview-with-reset-confirmations");
  await page.keyboard.press("Escape");
  assert.equal(
    await previewButton.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal((await engine.history()).length, 0);
  note(
    "blocked action moves focus to its error and offers recheck; refreshed preview re-focuses, resets acknowledgements and leaves files untouched",
  );
  throwAfterQuarantine = true;
  await previewButton.click();
  await page.getByRole("dialog").getByRole("checkbox").nth(0).check();
  await page.getByRole("dialog").getByRole("checkbox").nth(1).check();
  await page
    .getByRole("button", { name: "确认移入隔离区", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await idle();
  assert.equal(
    await page
      .getByRole("button", { name: "重新检查所选项目", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "确认移入隔离区", exact: true })
      .count(),
    0,
  );
  await page
    .getByText(
      "部分文件可能已完成操作。请先检查隔离记录核实状态，再重新扫描；不要假定文件均未改变。",
      { exact: true },
    )
    .waitFor();
  await audit("uncertain-quarantine-guides-to-records");
  await page.getByRole("button", { name: "检查隔离记录", exact: true }).click();
  await idle();
  assert.equal(
    (await engine.history())[0].items.filter((i) => i.status === "quarantined")
      .length,
    3,
  );
  throwAfterRestore = true;
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await idle();
  assert.equal(
    await page.getByRole("button", { name: "确认恢复", exact: true }).count(),
    0,
  );
  await audit("uncertain-restore-guides-to-records");
  await page.getByRole("button", { name: "检查隔离记录", exact: true }).click();
  await idle();
  assert.equal(
    (await engine.history())[0].items.filter((i) => i.status === "restored")
      .length,
    3,
  );
  note(
    "exceptions after real fixture moves invalidate stale scan/selection, never resubmit the old token, disclose uncertainty and route to reconciled records for quarantine and restore",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(screenshots, "focused-results.json"),
    JSON.stringify({ at: new Date().toISOString(), passed: report }, null, 2),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
