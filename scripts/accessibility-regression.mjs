// Automated accessibility audit of the unchanged production renderer.
// Uses the real engine and generated temporary fixtures; no user Codex data.
// axe is served only by this test server, under the production same-origin CSP.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { AgentVacEngine } from "../electron/engine.ts";
import { createDemo } from "../electron/fixtures.ts";
import { PreferenceStore } from "../electron/preferences.ts";

const require = createRequire(import.meta.url);
const axeSource = await fs.readFile(require.resolve("axe-core/axe.min.js"));
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-a11y-"),
);
const dist = path.resolve("dist");
const resultPath = path.resolve("docs/accessibility-results.json");
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (pathname === "/__test__/axe.min.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(axeSource);
      return;
    }
    const file = path.resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(dist + path.sep)) throw new Error("Forbidden");
    response.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "application/octet-stream",
    );
    response.end(await fs.readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
let engine;
let context = { root: null, demo: false, platform: process.platform };
let demoNumber = 0;
const preferenceDirectory = path.join(base, "preferences");
await fs.mkdir(preferenceDirectory);
const preferences = new PreferenceStore(preferenceDirectory);
await preferences.load();
const key = randomBytes(32);
const errors = [];
const report = {
  at: new Date().toISOString(),
  engine: "axe-core",
  version: require("axe-core/package.json").version,
  viewport: { width: 1024, height: 768 },
  source:
    "Production dist, unmodified CSP, real engine with generated fixtures",
  coverage: [
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
    "best-practice",
  ],
  limitation:
    "Automated renderer checks do not prove full WCAG compliance, assistive-technology usability, or native operating-system integration.",
  states: [],
  runtimeErrors: errors,
};
const save = async () => {
  report.summary = {
    states: report.states.length,
    violationRules: report.states.reduce(
      (sum, state) => sum + state.violations.length,
      0,
    ),
    violationNodes: report.states.reduce(
      (sum, state) =>
        sum + state.violations.reduce((n, issue) => n + issue.nodes.length, 0),
      0,
    ),
    incompleteRules: report.states.reduce(
      (sum, state) => sum + state.incomplete.length,
      0,
    ),
  };
  await fs.writeFile(resultPath, JSON.stringify(report, null, 2) + "\n");
};
try {
  if (process.env.AGENTVAC_BROWSER) {
    browser = await chromium.launch({
      executablePath: process.env.AGENTVAC_BROWSER,
      headless: true,
      chromiumSandbox: true,
    });
  } else if (process.platform === "linux") {
    const { default: serverless } = await import("@sparticuz/chromium");
    browser = await chromium.launch({
      executablePath: await serverless.executablePath(),
      args: serverless.args,
      headless: true,
    });
  } else browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: report.viewport,
    deviceScaleFactor: 1,
  });
  const idle = () =>
    page.waitForFunction(
      () => document.querySelector(".primary-nav button")?.disabled === false,
    );
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to load|Refused to connect/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).origin !== origin
    )
      errors.push("Unexpected external request: " + request.url());
  });
  await page.exposeFunction("__agentvacA11y", async (method, args) => {
    switch (method) {
      case "getContext":
        return context;
      case "getPreferences":
        await preferences.flush();
        return preferences.current();
      case "setTheme":
        return preferences.setTheme(args[0]);
      case "chooseRoot":
        return null;
      case "copyRootPath":
        return;
      case "loadDemo": {
        const root = path.join(base, "demo-" + ++demoNumber);
        await createDemo(root);
        engine = new AgentVacEngine(root, key, true);
        await engine.initialize();
        context = { root, demo: true, platform: process.platform };
        return context;
      }
      case "scan":
        return engine.scan(args[0]);
      case "cancelScan":
        return engine.cancelScan();
      case "preview":
        return engine.preview(args[0]);
      case "quarantine":
        return engine.quarantine(args[0], args[1]);
      case "history":
        return engine.history();
      case "restore":
        return engine.restore(args[0], args[1]);
      case "openQuarantine":
        return;
      case "trash":
        throw new Error(
          "Accessibility audit never executes system-trash actions.",
        );
      default:
        throw new Error("Unknown test-only API: " + method);
    }
  });
  await page.addInitScript(() => {
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getPreferences",
        "setTheme",
        "chooseRoot",
        "copyRootPath",
        "loadDemo",
        "scan",
        "cancelScan",
        "preview",
        "quarantine",
        "history",
        "restore",
        "openQuarantine",
        "trash",
      ].map((method) => [
        method,
        (...args) => window.__agentvacA11y(method, args),
      ]),
    );
  });
  await page.goto(origin);
  await idle();
  await page.addScriptTag({ url: origin + "/__test__/axe.min.js" });
  const audit = async (name) => {
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(
        (expected) => document.documentElement.dataset.theme === expected,
        theme,
      );
      const results = await page.evaluate(async (tags) => {
        const result = await window.axe.run(document, {
          runOnly: { type: "tag", values: tags },
          resultTypes: ["violations", "incomplete", "passes", "inapplicable"],
        });
        const compact = (issue) => ({
          id: issue.id,
          impact: issue.impact,
          description: issue.description,
          help: issue.help,
          helpUrl: issue.helpUrl,
          tags: issue.tags,
          nodes: issue.nodes.map((node) => ({
            target: node.target,
            html: node.html,
            impact: node.impact,
            failureSummary: node.failureSummary,
            checks: [...node.any, ...node.all, ...node.none].map((check) => ({
              id: check.id,
              impact: check.impact,
              message: check.message,
              data: check.data,
            })),
          })),
        });
        return {
          violations: result.violations.map(compact),
          incomplete: result.incomplete.map(compact),
          passedRules: result.passes.length,
          inapplicableRules: result.inapplicable.length,
        };
      }, report.coverage);
      const scopeVisibility = await page.evaluate(() => {
        const notice = document.querySelector(".notice-line");
        const scope = document.querySelector("#bulk-scope-help");
        const rect = scope?.getBoundingClientRect();
        const top = rect
          ? document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            )
          : null;
        return {
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          noticePosition: notice ? getComputedStyle(notice).position : null,
          scopeVisible:
            !scope || (!!top && (scope.contains(top) || top.contains(scope))),
        };
      });
      report.states.push({ name, theme, ...results, scopeVisibility });
      if (
        !name.includes("preview") &&
        !name.includes("confirmation") &&
        !name.includes("review") &&
        name !== "operation-result"
      ) {
        assert.equal(
          scopeVisibility.horizontalOverflow,
          false,
          `${name} ${theme}: horizontal overflow`,
        );
        if (scopeVisibility.noticePosition)
          assert.equal(
            scopeVisibility.noticePosition,
            "static",
            "Status must remain in document flow",
          );
        assert.equal(
          scopeVisibility.scopeVisible,
          true,
          `${name} ${theme}: bulk scope must remain visible`,
        );
      }
      await save();
      console.log(
        `${results.violations.length ? "FAIL" : "PASS"} ${name} ${theme}: ${results.violations.length} violations, ${results.incomplete.length} incomplete rules`,
      );
    }
  };
  await audit("welcome");
  await page.getByRole("button", { name: "隔离记录", exact: true }).click();
  await audit("history-empty");
  await page.getByRole("button", { name: "保护规则", exact: true }).click();
  await audit("rules");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "体验演示扫描", exact: true }).click();
  await idle();
  await audit("files");
  await page
    .getByRole("checkbox", { name: "包括历史会话", exact: false })
    .check();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await page
    .getByRole("button", { name: "会话记录", exact: false })
    .first()
    .click();
  await page.locator(".file-table tbody tr").first().click();
  await audit("sessions-with-inspector");
  await page.getByTestId("bulk-review-sessions").click();
  await audit("session-bulk-review");
  await page.getByTestId("bulk-session-ack").check();
  await page.getByTestId("bulk-session-confirm").click();
  await page.getByTestId("preview-selection").click();
  await idle();
  await audit("session-preview");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "全部文件", exact: true }).click();
  await page.getByTestId("bulk-select-safe").click();
  await page.getByTestId("preview-selection").click();
  await idle();
  await audit("log-preview");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认演示隔离", exact: true }).click();
  await idle();
  await page
    .getByRole("heading", { name: "整理完成，随时可以恢复", exact: true })
    .waitFor();
  await audit("operation-result");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "隔离记录", exact: true }).click();
  await idle();
  await audit("history");
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await audit("restore-confirmation");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "移入系统回收站", exact: true })
    .click();
  await audit("trash-confirmation");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await idle();
  await page.keyboard.press("Escape");
  await audit("history-restored");
  assert.deepEqual(errors, []);
  assert.equal(
    report.summary.violationRules,
    0,
    "Automated accessibility violations remain; inspect docs/accessibility-results.json",
  );
} finally {
  await save();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
