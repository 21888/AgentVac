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
  path.join(await fs.realpath(os.tmpdir()), "agentvac-bulk-"),
);
const dist = path.resolve("dist");
const screenshots = path.resolve("docs/bulk-regression");
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
let latestScan;
let latestPreview;
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
  status: "unknown",
  details: "测试夹具：无法自动检测进程。",
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
        if (!holdNextScan) return (latestScan = await engine.scan(args[0]));
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
        return (latestPreview = await engine.preview(args[0]));
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

  const url = "http://127.0.0.1:" + server.address().port;
  const old = new Date(Date.now() - 120 * 86400000);
  async function generatedRoot(name, logs, sessions = 0) {
    const root = path.join(base, name);
    await fs.mkdir(path.join(root, "log"), { recursive: true });
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    const files = [
      ...Array.from({ length: logs }, (_, i) => [
        `log/codex-tui.log.${String(i + 1).padStart(5, "0")}`,
        `Generated log ${i}\n`,
      ]),
      ...Array.from({ length: sessions }, (_, i) => [
        `sessions/rollout-${String(i + 1).padStart(5, "0")}.jsonl`,
        `Generated session ${i}\n`,
      ]),
      [
        "auth.json",
        "Generated protected credential fixture, not a real credential.",
      ],
    ];
    for (let i = 0; i < files.length; i += 100)
      await Promise.all(
        files.slice(i, i + 100).map(async ([relative, content]) => {
          const file = path.join(root, relative);
          await fs.writeFile(file, content);
          await fs.utimes(file, old, old);
        }),
      );
    engine = new AgentVacEngine(root, key, true);
    await engine.initialize();
    context = { root, demo: true, platform: process.platform };
    await page.goto(url);
    await page.getByRole("button", { name: "开始扫描", exact: true }).click();
    await idle();
    return root;
  }
  const scope = page.getByTestId("bulk-selection-scope");
  const safe = page.getByTestId("bulk-select-safe");
  const hidden = page.getByTestId("hidden-selection-notice");
  const search = page.getByRole("textbox", {
    name: "搜索文件路径",
    exact: true,
  });
  const selected = (count) =>
    page
      .getByText(count ? `已选择 ${count} 项` : "未选择项目", { exact: true })
      .waitFor();
  const currentCount = () =>
    page.locator(".file-table tbody input:checked").count();
  const previewSelection = async () => {
    await page.getByTestId("preview-selection").click();
    await idle();
  };
  const closeModal = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  };
  await generatedRoot("300-log-files", 300);
  assert.equal(await scope.getAttribute("data-count"), "300");
  assert.equal(
    Number(await scope.getAttribute("data-bytes")),
    latestScan.summary.safeBytes,
  );
  assert.equal(await page.getByTestId("bulk-review-sessions").count(), 0);
  await page
    .getByRole("button", { name: "运行日志", exact: false })
    .first()
    .click();
  await safe.click();
  await selected(300);
  assert.equal(await hidden.getAttribute("data-hidden-count"), "200");
  assert.equal(await hidden.getAttribute("data-outside-filter-count"), "0");
  await previewSelection();
  assert.equal(latestPreview.items.length, 300);
  assert.equal(new Set(latestPreview.items.map((x) => x.id)).size, 300);
  assert.ok(
    latestPreview.items.every((x) => x.risk === "safe" && x.selectable),
  );
  await closeModal();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await currentCount(), 100);
  await page.getByTestId("clear-hidden-selection").click();
  await selected(100);
  assert.equal(await hidden.count(), 0);
  assert.ok(
    await page
      .getByTestId("preview-selection")
      .evaluate((el) => el === document.activeElement),
  );
  await search.fill("no-match-generated-fixture");
  assert.equal(await hidden.getAttribute("data-hidden-count"), "100");
  assert.equal(await hidden.getAttribute("data-outside-filter-count"), "100");
  await search.fill("");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await currentCount(), 100);
  await search.fill(".00001");
  await safe.click();
  await selected(1);
  assert.equal(await hidden.count(), 0);
  await previewSelection();
  assert.equal(latestPreview.items.length, 1);
  assert.equal(latestPreview.items[0].path, "log/codex-tui.log.00001");
  await closeModal();
  note(
    "300 actual log files: cross-page exact set and bytes, pagination, hidden counts, filter round-trip, clear-hidden focus and replacement semantics",
  );
  await page
    .getByRole("combobox", { name: "按文件年龄筛选", exact: true })
    .selectOption("180");
  assert.equal(await hidden.getAttribute("data-outside-filter-count"), "1");
  assert.equal(await safe.count(), 0);
  await page
    .getByRole("combobox", { name: "按文件年龄筛选", exact: true })
    .selectOption("all");
  await selected(1);
  assert.equal(await hidden.count(), 0);
  await page
    .getByRole("combobox", { name: "候选文件最短年龄", exact: true })
    .selectOption("180");
  await selected(0);
  assert.equal(await scope.count(), 0);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  assert.equal(latestScan.summary.eligibleFiles, 0);
  note(
    "display-age filter preserves explicit selection with disclosure; scan-policy change invalidates selection and rescans eligibility",
  );

  await generatedRoot("300-session-files", 1, 300);
  await safe.click();
  await selected(1);
  assert.equal(await page.getByTestId("bulk-review-sessions").count(), 0);
  await page
    .getByRole("checkbox", { name: "包括历史会话", exact: false })
    .check();
  await selected(0);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await safe.click();
  await selected(1);
  await page
    .getByRole("button", { name: "会话记录", exact: false })
    .first()
    .click();
  assert.equal(await hidden.getAttribute("data-outside-filter-count"), "1");
  const review = page.getByTestId("bulk-review-sessions");
  assert.equal(await scope.getAttribute("data-count"), "300");
  await review.click();
  assert.ok(await page.getByTestId("bulk-session-confirm").isDisabled());
  await closeModal();
  await selected(1);
  assert.ok(await review.evaluate((el) => el === document.activeElement));
  await review.click();
  await page.getByTestId("bulk-session-ack").check();
  await page.getByTestId("bulk-session-confirm").click();
  await selected(300);
  assert.equal(await hidden.getAttribute("data-outside-filter-count"), "0");
  await previewSelection();
  assert.equal(latestPreview.items.length, 300);
  assert.ok(
    latestPreview.items.every(
      (x) => x.category === "session" && x.risk === "review",
    ),
  );
  await page.getByText("你选择了历史会话", { exact: true }).waitFor();
  await closeModal();
  await page.getByRole("button", { name: "全部文件", exact: true }).click();
  assert.equal(await review.count(), 0);
  await safe.click();
  await selected(1);
  await previewSelection();
  assert.equal(latestPreview.items[0].category, "log");
  await closeModal();
  await page
    .getByRole("checkbox", { name: "包括历史会话", exact: false })
    .uncheck();
  await selected(0);
  note(
    "300 actual sessions: opt-in and explicit category, risk acknowledgement, cancellation preserves prior selection, final exact session preview, safe bulk replaces hidden sessions and disabling review clears stale selection",
  );

  const largeRoot = await generatedRoot("5001-log-files", 5001);
  assert.equal(latestScan.summary.eligibleFiles, 5001);
  assert.equal(await scope.getAttribute("data-count"), "5001");
  assert.ok(await safe.isDisabled());
  await selected(0);
  await page
    .getByText("缩小筛选或分批选择；当前选择未改变", { exact: false })
    .waitFor();
  assert.ok((await page.locator(".file-arc").count()) <= 132);
  assert.equal(await page.locator(".file-table tbody tr").count(), 100);
  await search.fill(".00001");
  await safe.click();
  await selected(1);
  await search.fill("");
  assert.ok(await safe.isDisabled());
  await selected(1);
  await previewSelection();
  assert.equal(latestPreview.items.length, 1);
  await closeModal();
  await assert.rejects(
    () =>
      engine.preview(
        latestScan.entries.filter((x) => x.selectable).map((x) => x.id),
      ),
    /5000/,
  );
  note(
    "5001 actual files: bounded table/chart, disabled cross-page action, no truncation or selection mutation, backend rejects over-limit set",
  );
  const now = new Date();
  await fs.utimes(path.join(largeRoot, "log/codex-tui.log.05001"), now, now);
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  assert.equal(latestScan.summary.eligibleFiles, 5000);
  assert.equal(await scope.getAttribute("data-count"), "5000");
  assert.ok(await safe.isEnabled());
  await safe.click();
  await selected(5000);
  await previewSelection();
  assert.equal(latestPreview.items.length, 5000);
  assert.equal(new Set(latestPreview.items.map((x) => x.id)).size, 5000);
  assert.ok(
    latestPreview.items.every(
      (x) => x.risk === "safe" && x.path !== "log/codex-tui.log.05001",
    ),
  );
  assert.equal(latestPreview.totalBytes, latestScan.summary.safeBytes);
  await closeModal();
  note(
    "exact 5000 boundary succeeds with authoritative engine preview; fresh protected file excluded and byte total matches exact candidate set",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(screenshots, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment:
          "Linux headless Chromium; production renderer + real metadata engine; generated fixtures only",
        passed: report,
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
