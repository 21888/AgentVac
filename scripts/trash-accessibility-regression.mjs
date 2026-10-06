// Test-only: unchanged production CSP/rendering, generated real-engine fixtures,
// same-origin installed axe-core and a mock Trash adapter. Never native OS Trash.
// Launch only through the coordinated GUI lane; Chromium sandbox is mandatory.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AgentVacEngine } from "../electron/engine.ts";
const require = createRequire(import.meta.url);
const axeSource = await fs.readFile(require.resolve("axe-core/axe.min.js"));
const dist = path.resolve("dist"),
  output = path.resolve("evidence/trash-ack/accessibility");
const html = await fs.readFile(path.join(dist, "index.html"), "utf8");
const expectedCsp = html.match(
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
)?.[1];
assert.ok(expectedCsp, "The built renderer must retain its production CSP");
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-trash-a11y-"),
);
await fs.mkdir(output, { recursive: true });
const coverage = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];
const report = {
  at: new Date().toISOString(),
  source:
    "Unchanged built renderer and CSP; generated real engine; configured mock Trash only",
  axeVersion: require("axe-core/package.json").version,
  axeSha256: createHash("sha256").update(axeSource).digest("hex"),
  viewport: { width: 1024, height: 768 },
  coverage,
  limitation:
    "Automated contrast/name/label and keyboard checks do not establish full WCAG compliance, OS assistive-technology usability, native Electron IPC, or native OS Trash acceptance.",
  attempt: 4,
  priorAttempt: "evidence/trash-ack/accessibility-attempt-3",
  checks: [],
  settling: [],
  geometry: [],
  audits: [],
  auditFailures: [],
  buttonStates: [],
  errors: [],
  externalRequests: [],
  cspViolations: [],
};
const note = (value) => {
  report.checks.push(value);
  console.log("PASS", value);
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (pathname === "/__test__/axe.min.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(axeSource);
      return;
    }
    const file = path.resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(dist + path.sep))
      throw Error("Outside generated test renderer");
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.AGENTVAC_BROWSER
      ? { executablePath: process.env.AGENTVAC_BROWSER }
      : process.platform === "linux"
        ? { executablePath: "/usr/bin/chromium" }
        : {}),
  });
  for (const demo of [true, false]) {
    const mode = demo ? "demo" : "generated-real-mode",
      root = path.join(base, mode);
    await fs.mkdir(path.join(root, "log"), { recursive: true });
    const file = path.join(root, "log/codex-tui.log.1");
    await fs.writeFile(file, "Generated accessibility fixture only.");
    const old = new Date(Date.now() - 90 * 86400000);
    await fs.utimes(file, old, old);
    const engine = new AgentVacEngine(
      root,
      randomBytes(32),
      demo,
      async () => ({
        status: "clear",
        details: "Generated clear-process fixture",
      }),
    );
    const scan = await engine.scan({ minAgeDays: 30, includeSessions: false });
    const preview = await engine.preview(
      scan.entries.filter((e) => e.selectable).map((e) => e.id),
    );
    const batch = await engine.quarantine(preview.token, true);
    assert.equal(batch.completed, 1);
    let submissions = 0,
      moves = 0;
    const page = await browser.newPage({
      viewport: report.viewport,
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) =>
      report.errors.push(`${mode}: ${error.message}`),
    );
    page.on("request", (request) => {
      if (
        /^https?:/.test(request.url()) &&
        new URL(request.url()).origin !== origin
      )
        report.externalRequests.push(request.url());
    });
    await page.exposeFunction("__trashA11yFixture", async (method, args) => {
      switch (method) {
        case "getContext":
          return { root, provider: "codex", demo, platform: process.platform };
        case "getPreferences":
          return { theme: "system" };
        case "setTheme":
          return { theme: args[0] };
        case "history":
          return engine.history();
        case "chooseRoot":
          return null;
        case "copyRootPath":
        case "openQuarantine":
          return;
        case "prepareTrash":
          return engine.prepareTrash(args[0]);
        case "cancelTrashConfirmation":
          return engine.cancelTrashConfirmation(args[0]);
        case "trash":
          submissions++;
          return engine.trash(
            args[0],
            args[1],
            args[2],
            args[3],
            async (directory) => {
              assert.equal(
                directory,
                path.join(root, ".agentvac-quarantine", batch.batchId),
              );
              moves++;
              await fs.rename(directory, path.join(base, mode + "-mock-trash"));
            },
          );
        default:
          throw Error("Unsupported accessibility fixture API: " + method);
      }
    });
    await page.addInitScript(() => {
      window.__trashCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        window.__trashCspViolations.push({
          directive: event.effectiveDirective,
          blockedURI: event.blockedURI,
        }),
      );
      window.agentvac = Object.fromEntries(
        [
          "getContext",
          "getPreferences",
          "setTheme",
          "history",
          "chooseRoot",
          "copyRootPath",
          "openQuarantine",
          "prepareTrash",
          "cancelTrashConfirmation",
          "trash",
        ].map((method) => [
          method,
          (...args) => window.__trashA11yFixture(method, args),
        ]),
      );
    });
    const idle = () =>
      page.waitForFunction(
        () => document.querySelector(".primary-nav button")?.disabled === false,
      );
    await page.goto(origin);
    await idle();
    assert.equal(
      await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute("content"),
      expectedCsp,
    );
    await page.addScriptTag({ url: origin + "/__test__/axe.min.js" });
    await page.getByRole("button", { name: "隔离记录", exact: true }).click();
    await idle();
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(
        (value) => document.documentElement.dataset.theme === value,
        theme,
      );
      await page
        .locator(".batch-card")
        .filter({ hasText: batch.batchId })
        .getByRole("button", { name: "移入系统回收站", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: /移入系统回收站/ }),
        closed = page.getByTestId("trash-closed"),
        impact = page.getByTestId("trash-impact"),
        phrase = page.getByPlaceholder("回收站", { exact: true }),
        submit = page.getByTestId("trash-submit");
      await closed.waitFor();
      await idle();
      assert.equal(await dialog.count(), 1);
      assert.equal(await closed.isEnabled(), true);
      assert.equal(await closed.isChecked(), false);
      assert.equal(await impact.isChecked(), false);
      assert.equal(await phrase.inputValue(), "");
      assert.equal(await submit.isDisabled(), true);
      assert.equal(
        await dialog
          .getByRole("checkbox", {
            name: demo ? /我确认本次只操作演示数据/ : /我已退出所有/,
          })
          .count(),
        1,
      );
      assert.equal(
        await dialog.getByRole("checkbox", { name: /我了解上述影响/ }).count(),
        1,
      );
      assert.equal(
        await dialog
          .getByRole("textbox", { name: /输入.*回收站.*确认此操作/ })
          .count(),
        1,
      );
      assert.equal(
        await dialog
          .getByRole("button", { name: "确认移入系统回收站", exact: true })
          .count(),
        1,
      );
      await audit(page, mode, theme, "unchecked-disabled");
      await keyboardContainment(page, dialog, `${mode}/${theme}/disabled`);
      // Native keyboard activation must toggle only the focused checkbox, without
      // bypassing the separate impact or phrase requirement.
      await closed.focus();
      await page.keyboard.press("Space");
      assert.equal(await closed.isChecked(), true);
      assert.equal(await submit.isDisabled(), true);
      await page.keyboard.press("Space");
      assert.equal(await closed.isChecked(), false);
      assert.equal(await submit.isDisabled(), true);
      await impact.focus();
      await page.keyboard.press("Space");
      assert.equal(await impact.isChecked(), true);
      assert.equal(await submit.isDisabled(), true);
      await phrase.focus();
      await page.keyboard.type("回收站");
      assert.equal(await phrase.inputValue(), "回收站");
      assert.equal(await submit.isDisabled(), true);
      await closed.focus();
      await page.keyboard.press("Space");
      assert.equal(await closed.isChecked(), true);
      assert.equal(await submit.isEnabled(), true);
      await keyboardContainment(page, dialog, `${mode}/${theme}/enabled`);
      await audit(page, mode, theme, "confirmed-enabled");
      // The correction changes foreground only. Verify its >=5:1 margin and
      // unchanged pair under actual hover and keyboard focus, not selector text.
      await page.mouse.move(0, 0);
      await closed.focus();
      const idleColors = await captureButtonState(
        page,
        submit,
        mode,
        theme,
        "enabled-idle",
      );
      assert.equal(idleColors.hover, false);
      assert.equal(idleColors.focusVisible, false);
      await submit.hover();
      const hoverColors = await captureButtonState(
        page,
        submit,
        mode,
        theme,
        "enabled-hover",
      );
      assert.equal(hoverColors.hover, true);
      assert.deepEqual(
        [hoverColors.color, hoverColors.backgroundColor],
        [idleColors.color, idleColors.backgroundColor],
      );
      await page.mouse.move(0, 0);
      await dialog
        .getByRole("button", { name: "保留在隔离区", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await submit.evaluate((element) => element === document.activeElement),
        true,
      );
      const focusColors = await captureButtonState(
        page,
        submit,
        mode,
        theme,
        "enabled-keyboard-focus",
      );
      assert.equal(focusColors.focusVisible, true);
      assert.deepEqual(
        [focusColors.color, focusColors.backgroundColor],
        [idleColors.color, idleColors.backgroundColor],
      );
      await closed.focus();
      await page.keyboard.press("Space");
      assert.equal(await closed.isChecked(), false);
      assert.equal(await submit.isDisabled(), true);
      await closed.focus();
      await page.keyboard.press("Space");
      assert.equal(await submit.isEnabled(), true);
      await impact.focus();
      await page.keyboard.press("Space");
      assert.equal(await impact.isChecked(), false);
      assert.equal(await submit.isDisabled(), true);
      assert.equal(
        submissions,
        0,
        "Keyboard navigation/toggles must not submit Trash",
      );
      assert.equal(moves, 0);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `${mode}-${theme}-keyboard.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.ok(
        await page.evaluate(
          () =>
            document.activeElement instanceof HTMLElement &&
            document.activeElement.tagName === "BUTTON" &&
            !document.activeElement.closest('[role="dialog"]'),
        ),
      );
      note(
        `${mode}/${theme}: accessible names, Tab/Shift-Tab containment, Space gates and Escape focus return; axe status recorded separately`,
      );
    }
    assert.equal(
      (await engine.history()).find((b) => b.id === batch.batchId).items[0]
        .status,
      "quarantined",
    );
    assert.equal(
      await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute("content"),
      expectedCsp,
    );
    report.cspViolations.push(
      ...(await page.evaluate(() => window.__trashCspViolations)),
    );
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.cspViolations, []);
  // Keep every original audit gate. Defer the aggregate failure only so an
  // indeterminate contrast node does not suppress independent keyboard checks.
  assert.equal(
    report.auditFailures.length,
    0,
    "Unresolved accessibility audit gates: " +
      JSON.stringify(report.auditFailures),
  );
} catch (error) {
  report.runError = String(error);
  throw error;
} finally {
  report.summary = {
    groups: report.checks.length,
    auditStates: report.audits.length,
    violationRules: report.audits.reduce((n, a) => n + a.violations.length, 0),
    incompleteRules: report.audits.reduce((n, a) => n + a.incomplete.length, 0),
    contrastIndeterminateStates: report.audits.filter((a) =>
      a.incomplete.some((rule) => rule.id === "color-contrast"),
    ).length,
    contrastIndeterminateNodes: report.audits.reduce(
      (n, a) =>
        n +
        a.incomplete
          .filter((rule) => rule.id === "color-contrast")
          .reduce((sum, rule) => sum + rule.nodes.length, 0),
      0,
    ),
    deferredAuditFailures: report.auditFailures.length,
    overall: report.runError ? "failed" : "passed-limited-checks",
  };
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
async function keyboardContainment(page, dialog, label) {
  const controls = dialog.locator(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
  );
  const count = await controls.count();
  assert.ok(count >= 5, `${label}: expected focusable dialog controls`);
  const first = controls.first(),
    last = controls.last();
  await last.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await first.evaluate((e) => e === document.activeElement),
    true,
    `${label}: Tab wraps to first`,
  );
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await last.evaluate((e) => e === document.activeElement),
    true,
    `${label}: Shift-Tab wraps to last`,
  );
  for (const key of ["Tab", "Shift+Tab"])
    for (let i = 0; i < count + 2; i++) {
      await page.keyboard.press(key);
      assert.equal(
        await page.evaluate(
          () => !!document.activeElement?.closest('[role="dialog"]'),
        ),
        true,
        `${label}: ${key} remains inside dialog`,
      );
    }
}
async function audit(page, mode, theme, state) {
  const label = `${mode}-${theme}-${state}`;
  try {
    const settled = await settleRenderedDialog(page);
    report.settling.push({ mode, theme, state, ...settled });
  } catch (error) {
    report.settling.push({ mode, theme, state, error: String(error) });
    await captureDiagnostics(page, mode, theme, state);
    throw error;
  }
  await captureDiagnostics(page, mode, theme, state);
  const result = await page.evaluate(async (tags) => {
    const result = await window.axe.run(
      document.querySelector('[role="dialog"]'),
      { runOnly: { type: "tag", values: tags } },
    );
    const summary = (issues) =>
      issues.map((issue) => ({
        id: issue.id,
        impact: issue.impact,
        description: issue.description,
        helpUrl: issue.helpUrl,
        nodes: issue.nodes.map((node) => ({
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary,
          checks: [...node.any, ...node.all, ...node.none].map((check) => ({
            id: check.id,
            message: check.message,
            data: check.data,
            relatedNodes: (check.relatedNodes ?? []).map((related) => ({
              target: related.target,
              html: related.html,
            })),
          })),
        })),
      }));
    return {
      violations: summary(result.violations),
      incomplete: summary(result.incomplete),
      passes: result.passes.map((rule) => ({
        id: rule.id,
        nodes: rule.nodes.length,
      })),
    };
  }, coverage);
  report.audits.push({
    mode,
    theme,
    state,
    status: result.violations.length
      ? "violations"
      : result.incomplete.length
        ? "indeterminate"
        : "no-violations-or-incomplete-observed",
    ...result,
  });
  try {
    assert.deepEqual(
      result.violations,
      [],
      `${mode}/${theme}/${state}: axe violations`,
    );
    assert.deepEqual(
      result.incomplete.filter((rule) => rule.id === "color-contrast"),
      [],
      `${mode}/${theme}/${state}: contrast must be determinately checked`,
    );
    assert.ok(
      result.passes.some(
        (rule) => rule.id === "color-contrast" && rule.nodes > 0,
      ),
      `${mode}/${theme}/${state}: color-contrast must run`,
    );
  } catch (error) {
    report.auditFailures.push({
      mode,
      theme,
      state,
      violationRules: result.violations.map((rule) => rule.id),
      incompleteContrastTargets: result.incomplete
        .filter((rule) => rule.id === "color-contrast")
        .flatMap((rule) => rule.nodes.map((node) => node.target)),
      reason: String(error),
    });
  }
}

async function settleRenderedDialog(page) {
  // Observe normal production rendering. Do not disable animations, alter styles,
  // replace fonts, or relax axe's contrast checks to obtain a determinate result.
  return page.evaluate(async () => {
    const started = performance.now(),
      timeout = 6000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let fontReady = false;
    void document.fonts.ready.then(() => {
      fontReady = true;
    });
    const finiteActive = () =>
      document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return (
          Number.isFinite(timing?.endTime) &&
          animation.playState !== "finished" &&
          animation.playState !== "idle"
        );
      });
    while (
      !fontReady ||
      document.fonts.status !== "loaded" ||
      finiteActive().length
    ) {
      if (performance.now() - started > timeout)
        throw Error(
          "Fonts or finite animations did not settle within 6 seconds",
        );
      await sleep(50);
    }
    const selectors = [
      ".modal-backdrop",
      ".modal",
      ".modal-notice",
      ".modal-notice > div > p",
      ".acknowledgement > span",
      ".modal-actions button",
    ];
    const snapshot = () =>
      JSON.stringify(
        selectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)].map((element) => {
            const r = element.getBoundingClientRect(),
              css = getComputedStyle(element);
            return [
              selector,
              r.x,
              r.y,
              r.width,
              r.height,
              element.scrollTop,
              element.scrollWidth,
              element.scrollHeight,
              css.color,
              css.backgroundColor,
              css.opacity,
              css.transform,
              css.fontFamily,
              css.fontSize,
              css.lineHeight,
            ];
          }),
        ),
      );
    let previous,
      stable = 0,
      samples = 0;
    while (stable < 4) {
      if (performance.now() - started > timeout)
        throw Error("Dialog layout/colors did not settle within 6 seconds");
      await sleep(100);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const current = snapshot();
      samples++;
      stable =
        current === previous &&
        document.fonts.status === "loaded" &&
        finiteActive().length === 0
          ? stable + 1
          : 0;
      previous = current;
    }
    return {
      elapsedMs: performance.now() - started,
      samples,
      stableSamples: stable,
      fonts: document.fonts.status,
      fontReady,
      finiteActiveAnimations: finiteActive().length,
    };
  });
}

async function captureDiagnostics(page, mode, theme, state) {
  const label = `${mode}-${theme}-${state}`;
  const geometry = await page.evaluate(() => {
    const rect = (value) => ({
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      left: value.left,
    });
    const name = (element) =>
      element.tagName.toLowerCase() +
      (element.id ? "#" + element.id : "") +
      (element.getAttribute("class")
        ? "." + element.getAttribute("class").trim().replace(/\s+/g, ".")
        : "");
    const styles = (element) => {
      const css = getComputedStyle(element);
      return {
        color: css.color,
        backgroundColor: css.backgroundColor,
        backgroundImage: css.backgroundImage,
        opacity: css.opacity,
        fontFamily: css.fontFamily,
        fontSize: css.fontSize,
        fontWeight: css.fontWeight,
        lineHeight: css.lineHeight,
        position: css.position,
        zIndex: css.zIndex,
        transform: css.transform,
        filter: css.filter,
        backdropFilter: css.backdropFilter,
        overflow: css.overflow,
        overflowX: css.overflowX,
        overflowY: css.overflowY,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      fonts: document.fonts.status,
      animations: document.getAnimations().map((animation) => ({
        playState: animation.playState,
        timing: animation.effect?.getComputedTiming(),
      })),
      targets: [
        ...document.querySelectorAll(
          ".modal-notice > div > p, .acknowledgement > span",
        ),
      ].map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const textRects = [...range.getClientRects()]
          .filter((r) => r.width > 0 && r.height > 0)
          .slice(0, 16);
        const ancestors = [];
        let parent = element;
        for (
          let depth = 0;
          parent && depth < 8;
          depth++, parent = parent.parentElement
        )
          ancestors.push({
            name: name(parent),
            rect: rect(parent.getBoundingClientRect()),
            scrollTop: parent.scrollTop,
            clientHeight: parent.clientHeight,
            scrollHeight: parent.scrollHeight,
            styles: styles(parent),
          });
        return {
          name: name(element),
          text: element.textContent.trim(),
          rect: rect(element.getBoundingClientRect()),
          styles: styles(element),
          ancestors,
          textRects: textRects.map((r) => ({
            rect: rect(r),
            samples: [
              [r.left + Math.min(2, r.width / 2), r.top + r.height / 2],
              [r.left + r.width / 2, r.top + r.height / 2],
              [r.right - Math.min(2, r.width / 2), r.top + r.height / 2],
            ].map(([x, y]) => ({
              x,
              y,
              stack: document
                .elementsFromPoint(x, y)
                .slice(0, 16)
                .map((node) => ({
                  name: name(node),
                  rect: rect(node.getBoundingClientRect()),
                  styles: styles(node),
                })),
            })),
          })),
        };
      }),
    };
  });
  const filename = label + "-geometry.json";
  await fs.writeFile(
    path.join(output, filename),
    JSON.stringify(geometry, null, 2) + "\n",
  );
  await page.screenshot({
    path: path.join(output, label + "-settled.png"),
    animations: "allow",
  });
  report.geometry.push({
    mode,
    theme,
    state,
    filename,
    screenshot: label + "-settled.png",
  });
}

async function captureButtonState(page, button, mode, theme, state) {
  await settleRenderedDialog(page);
  const style = await button.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      color: css.color,
      backgroundColor: css.backgroundColor,
      backgroundImage: css.backgroundImage,
      opacity: css.opacity,
      filter: css.filter,
      fontSize: css.fontSize,
      fontWeight: css.fontWeight,
      outlineColor: css.outlineColor,
      outlineStyle: css.outlineStyle,
      outlineWidth: css.outlineWidth,
      outlineOffset: css.outlineOffset,
      hover: element.matches(":hover"),
      focusVisible: element.matches(":focus-visible"),
      disabled: element.disabled,
    };
  });
  const rgb = (value) => {
    const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    assert.ok(match, "Button colors must be measured opaque RGB values");
    return match.slice(1).map(Number);
  };
  const luminance = (values) =>
    values
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce(
        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
        0,
      );
  const foreground = luminance(rgb(style.color)),
    background = luminance(rgb(style.backgroundColor));
  const contrastRatio =
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05);
  const result = {
    mode,
    theme,
    state,
    ...style,
    contrastRatio,
    requiredCorrectionMargin: 5,
  };
  report.buttonStates.push(result);
  assert.equal(style.disabled, false);
  assert.equal(style.opacity, "1");
  assert.equal(style.backgroundImage, "none");
  assert.equal(style.filter, "none");
  assert.ok(
    contrastRatio >= 5,
    `${mode}/${theme}/${state}: action text must retain at least 5:1`,
  );
  await page.screenshot({
    path: path.join(output, `${mode}-${theme}-${state}-button.png`),
    animations: "allow",
  });
  return result;
}
