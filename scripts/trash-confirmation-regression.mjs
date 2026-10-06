// Generated fixtures + production renderer/engine; mock Trash only.
// Requires the separately coordinated sandboxed GUI lane. Never disable sandbox.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { AgentVacEngine } from "../electron/engine.ts";
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-trash-ui-"),
);
const dist = path.resolve("dist"),
  output = path.resolve("evidence/trash-ack/gui");
await fs.mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  source: "Generated fixture renderer + engine; mock Trash only",
  checks: [],
  errors: [],
  externalRequests: [],
};
const note = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const releases = [];
function gate() {
  let release;
  const promise = new Promise((r) => (release = r));
  releases.push(release);
  return { promise, release };
}
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = path.resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(dist + path.sep))
      throw Error("Outside fixture renderer");
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
    res.end("not found");
  }
});
let browser;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
      root = path.join(base, mode),
      key = randomBytes(32);
    await fs.mkdir(path.join(root, "log"), { recursive: true });
    const engine = new AgentVacEngine(root, key, demo, async () => ({
      status: "clear",
      details: "Generated clear-process fixture",
    }));
    const ids = [];
    for (let i = 1; i <= 2; i++) {
      const file = path.join(root, "log", `codex-tui.log.${i}`);
      await fs.writeFile(file, "Generated Trash UI fixture only.");
      const old = new Date(Date.now() - 90 * 86400000);
      await fs.utimes(file, old, old);
      const scan = await engine.scan({
        minAgeDays: 30,
        includeSessions: false,
      });
      const preview = await engine.preview(
        scan.entries.filter((e) => e.selectable).map((e) => e.id),
      );
      const result = await engine.quarantine(preview.token, true);
      assert.equal(result.completed, 1);
      ids.push(result.batchId);
    }
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
    });
    page.on("pageerror", (e) => report.errors.push(`${mode}: ${e.message}`));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin)
        report.externalRequests.push(r.url());
    });
    const prepared = [],
      cancelled = [],
      submissions = [],
      moves = [];
    let prepareGate,
      trashGate,
      failNext = false;
    await page.exposeFunction("__trashFixture", async (method, args) => {
      switch (method) {
        case "getContext":
          return { root, provider: "codex", demo, platform: process.platform };
        case "getPreferences":
          return { theme: "system" };
        case "setTheme":
          return { theme: args[0] };
        case "history":
          return engine.history();
        case "copyRootPath":
        case "openQuarantine":
          return;
        case "chooseRoot":
          return null;
        case "prepareTrash": {
          const c = await engine.prepareTrash(args[0]);
          prepared.push(c);
          if (prepareGate) {
            const g = prepareGate;
            prepareGate = undefined;
            await g.promise;
          }
          return c;
        }
        case "cancelTrashConfirmation":
          cancelled.push(args[0]);
          return engine.cancelTrashConfirmation(args[0]);
        case "trash":
          submissions.push(args);
          return engine.trash(
            args[0],
            args[1],
            args[2],
            args[3],
            async (directory) => {
              assert.equal(
                path.dirname(directory),
                path.join(root, ".agentvac-quarantine"),
              );
              assert.ok(ids.includes(path.basename(directory)));
              moves.push(directory);
              if (trashGate) {
                const g = trashGate;
                trashGate = undefined;
                await g.promise;
              }
              if (failNext) {
                failNext = false;
                throw Error("Generated mock Trash failure before move");
              }
              const bin = path.join(base, mode + "-bin");
              await fs.mkdir(bin, { recursive: true });
              await fs.rename(
                directory,
                path.join(bin, path.basename(directory)),
              );
            },
          );
        default:
          throw Error("Unsupported generated Trash API: " + method);
      }
    });
    await page.addInitScript(() => {
      window.agentvac = Object.fromEntries(
        [
          "getContext",
          "getPreferences",
          "setTheme",
          "history",
          "copyRootPath",
          "openQuarantine",
          "chooseRoot",
          "prepareTrash",
          "cancelTrashConfirmation",
          "trash",
        ].map((method) => [
          method,
          (...args) => window.__trashFixture(method, args),
        ]),
      );
    });
    const dialog = page.getByRole("dialog"),
      impact = page.getByTestId("trash-impact"),
      closed = page.getByTestId("trash-closed"),
      phrase = page.getByPlaceholder("回收站", { exact: true }),
      submit = page.getByTestId("trash-submit");
    const idle = () =>
      page.waitForFunction(
        () => document.querySelector(".primary-nav button")?.disabled === false,
      );
    const open = async (id) => {
      await page
        .locator(".batch-card")
        .filter({ hasText: id })
        .getByRole("button", { name: "移入系统回收站", exact: true })
        .click();
      await closed.waitFor();
      await idle();
      assert.equal(await closed.isEnabled(), true);
    };
    const reset = async () => {
      assert.equal(await impact.isChecked(), false);
      assert.equal(await closed.isChecked(), false);
      assert.equal(await phrase.inputValue(), "");
      assert.equal(await submit.isDisabled(), true);
    };
    const consent = async () => {
      await impact.check();
      await phrase.fill("回收站");
      await closed.check();
      assert.equal(await submit.isEnabled(), true);
    };
    const noReplay = async (id, token) =>
      assert.rejects(
        engine.trash(id, true, true, token, async () =>
          assert.fail("Stale token reached mock Trash"),
        ),
      );
    await page.goto(origin);
    await idle();
    await page.getByRole("button", { name: "隔离记录", exact: true }).click();
    await idle();
    await open(ids[0]);
    await reset();
    const first = prepared.at(-1);
    assert.equal(first.batchId, ids[0]);
    assert.equal(first.demo, demo);
    assert.match(await closed.locator("..").innerText(), /管理员|其他用户/);
    if (demo) assert.match(await closed.locator("..").innerText(), /演示/);
    await impact.check();
    await phrase.fill("回收站");
    assert.equal(await submit.isDisabled(), true);
    assert.equal(submissions.length, 0);
    await closed.check();
    assert.equal(await submit.isEnabled(), true);
    await impact.uncheck();
    assert.equal(await submit.isDisabled(), true);
    await impact.check();
    await phrase.fill("错误");
    assert.equal(await submit.isDisabled(), true);
    await phrase.fill("回收站");
    note(`${mode}: closure, impact and phrase are independently required`);
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(
        (t) => document.documentElement.dataset.theme === t,
        theme,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `${mode}-${theme}-confirmation.png`),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1200, height: 850 });
    await dialog
      .getByRole("button", { name: "保留在隔离区", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await eventually(() => cancelled.includes(first.token));
    await noReplay(ids[0], first.token);
    await open(ids[0]);
    await reset();
    const reopened = prepared.at(-1);
    assert.notEqual(reopened.token, first.token);
    await consent();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await eventually(() => cancelled.includes(reopened.token));
    await noReplay(ids[0], reopened.token);
    await open(ids[1]);
    await reset();
    assert.equal(prepared.at(-1).batchId, ids[1]);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    note(`${mode}: cancel, Escape, reopen and another batch reset consent`);
    const preparing = gate();
    prepareGate = preparing;
    const count = prepared.length;
    await page
      .locator(".batch-card")
      .filter({ hasText: ids[0] })
      .getByRole("button", { name: "移入系统回收站", exact: true })
      .click();
    await eventually(() => prepared.length === count + 1);
    assert.equal(await impact.isDisabled(), true);
    assert.equal(await closed.isDisabled(), true);
    assert.equal(await phrase.isDisabled(), true);
    assert.equal(await submit.isDisabled(), true);
    preparing.release();
    await idle();
    await reset();
    const failedToken = prepared.at(-1).token;
    await consent();
    failNext = true;
    await submit.click();
    await dialog.getByRole("alert").waitFor();
    await idle();
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0], [ids[0], true, true, failedToken]);
    assert.equal(await impact.isChecked(), false);
    assert.equal(await closed.isChecked(), false);
    assert.equal(await phrase.inputValue(), "");
    assert.ok((await submit.count()) === 0 || (await submit.isDisabled()));
    await noReplay(ids[0], failedToken);
    assert.equal(
      (await engine.history()).find((b) => b.id === ids[0]).items[0].status,
      "quarantined",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    note(
      `${mode}: pending prepare and callback failure cannot retain actionable consent`,
    );
    await open(ids[0]);
    await reset();
    const retry = prepared.at(-1).token;
    assert.notEqual(retry, failedToken);
    await consent();
    const moving = gate();
    trashGate = moving;
    await submit.evaluate((button) => {
      button.click();
      button.click();
    });
    await eventually(() => moves.length === 2);
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1], [ids[0], true, true, retry]);
    assert.equal(await closed.isDisabled(), true);
    moving.release();
    await page
      .getByRole("heading", { name: "隔离批次已移入系统回收站", exact: true })
      .waitFor();
    await idle();
    await noReplay(ids[0], retry);
    const history = await engine.history();
    assert.equal(
      history.find((b) => b.id === ids[0]).items[0].status,
      "trashed",
    );
    assert.equal(
      history.find((b) => b.id === ids[1]).items[0].status,
      "quarantined",
    );
    assert.equal(moves.length, 2);
    note(
      `${mode}: fresh retry succeeds once; duplicate/replay cannot move again`,
    );
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
} finally {
  for (const release of releases) release();
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await new Promise((r) => server.close(r));
  await fs.rm(base, { recursive: true, force: true });
}
async function eventually(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      "Timed out waiting for generated fixture state",
    );
    await new Promise((r) => setTimeout(r, 20));
  }
}
