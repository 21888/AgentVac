// Test-only bridge: runs the production Vue UI against the real engine and generated fixtures.
// It never grants a browser arbitrary filesystem access or opens a real Codex directory.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { AgentVacEngine } = await import(
  process.env.AGENTVAC_SCAN_ENGINE || "../electron/engine.ts"
);
import { createDemo } from "../electron/fixtures.ts";
import { PreferenceStore } from "../electron/preferences.ts";
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-e2e-"),
);
const dist = path.resolve(process.env.AGENTVAC_SCAN_DIST || "dist");
const screenshots = path.resolve(
  process.env.AGENTVAC_SCAN_EVIDENCE || "docs/scan-regression",
);
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
let latestScan, latestProgress;
let scanCalls = [],
  cancelIds = [];
let heldScan = false;
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
    viewport: { width: 1024, height: 768 },
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
        cancelIds.push(args[0]);
        engine.cancelScan(args[0]);
        gateCancelled = true;
        releaseScanGate?.();
        return;
      case "scan": {
        const shouldHold = holdNextScan;
        holdNextScan = false;
        heldScan = false;
        gateCancelled = false;
        latestProgress = null;
        scanCalls.push(args[0]);
        const deliveries = [];
        const original = fs.lstat;
        fs.lstat = async (p, ...rest) => {
          if (shouldHold && !heldScan && latestProgress?.visitedEntries > 10) {
            heldScan = true;
            await new Promise((resolve) => {
              releaseScanGate = resolve;
            });
          }
          return original(p, ...rest);
        };
        try {
          latestScan = await engine.scan(args[0], (progress) => {
            latestProgress = progress;
            deliveries.push(
              page.evaluate(
                (data) => window.__progressListener?.(data),
                progress,
              ),
            );
          });
          return latestScan;
        } finally {
          fs.lstat = original;
          releaseScanGate = null;
          await Promise.allSettled(deliveries);
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
    window.agentvac.onScanProgress = (listener) => {
      window.__progressListener = listener;
      return () => {
        window.__progressListener = null;
      };
    };
  });
  const auditStates = [];
  const audit = async (name) => {
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await waitTheme(theme);
      const file = path.join(screenshots, `${name}-${theme}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      const state = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        state: document
          .querySelector('[data-testid="scan-state"]')
          ?.getAttribute("data-state"),
        tableHeight:
          document.querySelector(".table-scroll")?.getBoundingClientRect()
            .height ?? null,
        modalOpen: !!document.querySelector(".modal"),
        focusInModal: !!document.activeElement?.closest(".modal"),
        wrappedCategoryLabels: [
          ...document.querySelectorAll(".category-nav"),
        ].filter((el) => el.getBoundingClientRect().height > 40).length,
        coverageText: document.querySelector('[data-testid="scan-coverage"]')
          ?.textContent,
        bodyText: document.body.innerText,
      }));
      auditStates.push({ name, theme, file, ...state });
      assert.equal(state.overflow, false);
      assert.equal(state.wrappedCategoryLabels, 0);
      if (state.modalOpen) assert.equal(state.focusInModal, true);
      if (state.tableHeight !== null)
        assert.ok(
          state.tableHeight > 60,
          `${name} ${theme}: table remains usable`,
        );
      await fs.writeFile(
        path.join(screenshots, "audit-states.json"),
        JSON.stringify(auditStates, null, 2),
      );
    }
  };
  await page.goto("http://127.0.0.1:" + server.address().port);
  await idle();
  assert.equal(
    await page.getByTestId("scan-state").getAttribute("data-state"),
    "idle",
  );
  await page.getByRole("button", { name: "体验演示扫描", exact: true }).click();
  await idle();
  assert.equal(latestScan.status, "complete");
  assert.ok(latestScan.coverage.protectedDirectories > 0);
  await audit("01-complete-scan");
  const old = new Date(Date.now() - 120 * 86400000);
  console.log("Generating 50,020 rotated-log fixtures");
  for (let start = 0; start < 50020; start += 100) {
    await Promise.all(
      Array.from(
        { length: Math.min(100, 50020 - start) },
        async (_, offset) => {
          const file = path.join(
            context.root,
            "log",
            `codex-tui.log.${1000 + start + offset}`,
          );
          await fs.writeFile(file, "AgentVac generated scan fixture.");
          await fs.utimes(file, old, old);
        },
      ),
    );
  }
  holdNextScan = true;
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  for (let attempts = 0; !heldScan && attempts < 300; attempts++)
    await page.waitForTimeout(50);
  assert.equal(heldScan, true);
  await page.getByTestId("scan-progress").waitFor();
  const currentId = await page
    .getByTestId("scan-progress")
    .getAttribute("data-request-id");
  const visited = await page.getByTestId("progress-visited").textContent();
  assert.equal(currentId, scanCalls.at(-1).requestId);
  assert.ok(Number(visited.replaceAll(",", "")) > 10);
  await page.evaluate((event) => window.__progressListener?.(event), {
    ...latestProgress,
    requestId: "00000000-0000-4000-8000-000000000001",
    visitedEntries: 999999,
    discoveredBytes: 99999999,
  });
  assert.equal(
    await page.getByTestId("progress-visited").textContent(),
    visited,
  );
  await page.evaluate((event) => window.__progressListener?.(event), {
    ...latestProgress,
    root: context.root + "-different",
    visitedEntries: 999998,
  });
  assert.equal(
    await page.getByTestId("progress-visited").textContent(),
    visited,
  );
  await page.waitForTimeout(2200);
  assert.notEqual(
    (await page.getByTestId("progress-elapsed").textContent()).trim(),
    "0 秒",
  );
  await audit("02-real-progress");
  await page.getByRole("button", { name: "取消扫描", exact: true }).click();
  await idle();
  assert.equal(cancelIds.at(-1), currentId);
  assert.equal(
    await page.getByTestId("scan-state").getAttribute("data-state"),
    "cancelled",
  );
  assert.equal(await page.locator(".file-table tbody tr").count(), 0);
  await audit("03-cancelled");
  note(
    "real progress matches active request, stale/wrong-root events ignored, cancellation is scoped and clears all selectable rows",
  );
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  assert.equal(latestScan.status, "partial");
  assert.equal(latestScan.coverage.limitReason, "entry-count");
  assert.equal(latestScan.coverage.maxEntries, 50000);
  assert.equal(
    await page.getByTestId("scan-state").getAttribute("data-state"),
    "partial",
  );
  assert.equal(await page.getByTestId("bulk-select-safe").isDisabled(), true);
  assert.equal(
    await page
      .getByRole("checkbox", { name: "选择当前列表中的安全项目", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.getByTestId("rescan-100k").isVisible(), true);
  await audit("04-partial-50k");
  await page.locator(".file-table tbody input:not(:disabled)").first().check();
  await page.getByTestId("preview-selection").click();
  await idle();
  await page.getByTestId("partial-preview-warning").waitFor();
  await audit("05-partial-preview");
  await page.keyboard.press("Escape");
  await page.getByTestId("rescan-100k").click();
  await idle();
  assert.equal(scanCalls.at(-1).maxEntries, 100000);
  assert.equal(latestScan.status, "complete");
  assert.ok(latestScan.entries.length > 50000);
  assert.equal(await page.getByTestId("rescan-100k").count(), 0);
  await page.getByText("未选择项目", { exact: true }).waitFor();
  await audit("06-complete-100k-rescan");
  note(
    "real 50k truncation disables bulk but allows manual preview with warning; explicit 100k rescan returns complete result and clears old selection",
  );
  const originalRoot = context.root;
  await fs.rename(originalRoot, originalRoot + "-held");
  try {
    await page.getByRole("button", { name: "开始扫描", exact: true }).click();
    await idle();
    assert.equal(
      await page.getByTestId("scan-state").getAttribute("data-state"),
      "error",
    );
    assert.equal(await page.locator(".file-table tbody tr").count(), 0);
    await audit("07-scan-error");
  } finally {
    await fs.rename(originalRoot + "-held", originalRoot);
  }
  note(
    "real root I/O failure produces explicit failed state without old selectable entries",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(screenshots, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: report,
        coverage: latestScan.coverage,
        scanCalls,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
