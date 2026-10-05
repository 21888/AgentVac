// Sandboxed production UI + real shared services, synthetic provider fixtures only.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
const project = path.resolve(".");
await fs.mkdir(path.join(project, ".qa"), { recursive: true });
const base = await fs.mkdtemp(path.join(project, ".qa", "multi-ui-"));
const out = path.join(project, "docs", "multi-provider-ui");
await fs.mkdir(out, { recursive: true });
const roots = {
  codex: path.join(base, "codex-data"),
  "claude-code": path.join(base, "claude-data"),
  cline: path.join(base, "cline-data"),
  cursor: path.join(base, "Cursor"),
};
async function write(provider, relative, age = 90) {
  const file = path.join(roots[provider], relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "synthetic provider fixture");
  const date = new Date(Date.now() - age * 86400000);
  await fs.utimes(file, date, date);
}
await write("codex", "log/codex-tui.log.1");
await write("codex", "auth.json");
await fs.mkdir(path.join(roots["claude-code"], "projects"), {
  recursive: true,
});
await write("claude-code", "settings.json");
await write("claude-code", "debug/11111111-1111-4111-8111-111111111111.txt");
await write("claude-code", "debug/22222222-2222-4222-8222-222222222222.txt", 2);
await write("cline", "db/sessions.db");
await write("cline", "db/session-search.db");
await write("cline", "db/session-search.db-wal");
await write("cline", "globalState.json");
for (const [id, age] of [
  ["1600000000000_abcde", 90],
  ["1700000000000_fghij", 2],
])
  for (const name of [id + ".json", id + ".messages.json", "hooks.jsonl"])
    await write("cline", `sessions/${id}/${name}`, age);
await fs.mkdir(path.join(roots.cursor, "User/globalStorage"), {
  recursive: true,
});
await write("cursor", "logs/20200101T010101/main.log");
await write("cursor", "logs/20210101T010101/main.log", 2);
const sessionPath =
  "projects/-synthetic-project/33333333-3333-4333-8333-333333333333.jsonl";
await write("claude-code", sessionPath);
await write(
  "claude-code",
  "projects/-synthetic-project/44444444-4444-4444-8444-444444444444.jsonl",
  2,
);
await write(
  "claude-code",
  sessionPath.slice(0, -6) + "/subagents/agent-a.jsonl",
);
for (const file of [
  "index",
  "data_0",
  "data_1",
  "data_2",
  "data_3",
  "f_000001",
])
  await write("cursor", "GPUCache/" + file);
for (const directory of [
  path.join(roots.cursor, "GPUCache"),
  path.join(roots["claude-code"], sessionPath.slice(0, -6), "subagents"),
  path.join(roots["claude-code"], sessionPath.slice(0, -6)),
]) {
  const old = new Date(Date.now() - 90 * 86400000);
  await fs.utimes(directory, old, old);
}
let status = "clear",
  cancelChoose = false,
  holdScan = false,
  releaseScan;
const services = new AppDataServices(path.join(base, "profile"), {
  home: path.join(base, "home"),
  env: {},
  processCheck: async () => ({ status, details: "合成夹具进程检查" }),
  providerProcessCheck: async () => ({
    status,
    details:
      status === "unknown"
        ? "无法确认进程状态，已阻止文件操作。"
        : "合成夹具完整进程检查",
  }),
});
await services.initialize();
let theme = "system";
const errors = [],
  report = [];
let browser, page;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const file = path.resolve(
      project,
      "dist",
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!file.startsWith(path.join(project, "dist") + path.sep))
      throw Error("denied");
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  browser = await chromium.launch({
    executablePath: process.env.AGENTVAC_BROWSER || "/usr/bin/chromium",
    chromiumSandbox: true,
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("__multiBridge", async (method, args) => {
    switch (method) {
      case "getContext":
        return services.getContext();
      case "getAppData":
        return services.getAppData();
      case "getPreferences":
        return { theme };
      case "setTheme":
        theme = args[0];
        return { theme };
      case "setProvider":
        return services.setProvider(args[0]);
      case "chooseRoot":
        if (cancelChoose) {
          cancelChoose = false;
          return null;
        }
        return services.selectProviderRoot(
          roots[services.getContext().provider],
        );
      case "activateWorkspace":
        return services.activateWorkspace(args[0]);
      case "activateCandidate":
        return services.activateCandidate(args[0]);
      case "forgetWorkspace":
        return services.forgetWorkspace(args[0]);
      case "loadDemo":
        return services.loadDemo();
      case "scan":
        if (holdScan) {
          holdScan = false;
          await new Promise((resolve) => (releaseScan = resolve));
        }
        return services
          .engine()
          .scan(
            args[0],
            (progress) =>
              void page.evaluate(
                (p) => window.__listeners.forEach((listener) => listener(p)),
                progress,
              ),
          );
      case "cancelScan":
        services.engine().cancelScan(args[0]);
        releaseScan?.();
        return;
      case "preview":
        return services.engine().preview(args[0]);
      case "quarantine":
        return services.engine().quarantine(...args);
      case "history":
        return services.engine().history();
      case "restore":
        return services.engine().restore(...args);
      case "inspectRecovery":
        return services.engine().inspectRecovery();
      case "cancelDiagnosis":
        return services.cancelDiagnosis(...args);
      case "copyRootPath":
        return;
      default:
        throw Error("Unhandled synthetic bridge " + method);
    }
  });
  await page.addInitScript(() => {
    window.__listeners = [];
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getAppData",
        "getPreferences",
        "setTheme",
        "setProvider",
        "chooseRoot",
        "activateWorkspace",
        "activateCandidate",
        "forgetWorkspace",
        "loadDemo",
        "scan",
        "cancelScan",
        "preview",
        "quarantine",
        "history",
        "restore",
        "inspectRecovery",
        "cancelDiagnosis",
        "copyRootPath",
      ].map((method) => [
        method,
        (...args) => window.__multiBridge(method, args),
      ]),
    );
    window.agentvac.onScanProgress = (listener) => {
      window.__listeners.push(listener);
      return () =>
        (window.__listeners = window.__listeners.filter((x) => x !== listener));
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const idle = () =>
    page.waitForFunction(
      () => document.querySelector(".primary-nav button")?.disabled === false,
    );
  await idle();
  const selector = page.getByRole("combobox", { name: "数据提供方" });
  assert.equal(await selector.locator("option").count(), 4);
  const note = (name) => {
    report.push(name);
    console.log("PASS", name);
  };
  const themeEvidence = [];
  async function settledTheme(color) {
    const label = color === "light" ? "浅色主题" : "深色主题";
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      color,
    );
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector(`button[aria-label="${expected}"]`)
          ?.getAttribute("aria-pressed") === "true",
      label,
    );
    await page.evaluate(
      async () =>
        await Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        ),
    );
    const state = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      selected: document
        .querySelector('.theme-switcher button[aria-pressed="true"]')
        ?.getAttribute("aria-label"),
      background: getComputedStyle(document.querySelector(".main-area"))
        .backgroundColor,
    }));
    assert.equal(state.theme, color);
    assert.equal(state.selected, label);
    themeEvidence.push(state);
  }

  for (const [provider, label] of [
    ["codex", "Codex"],
    ["claude-code", "Claude Code"],
    ["cline", "Cline"],
    ["cursor", "Cursor"],
  ]) {
    await selector.selectOption(provider);
    await idle();
    assert.equal(services.getContext().provider, provider);
    assert.equal(
      await page.locator(".page-eyebrow").textContent(),
      label + " · 本地数据",
    );
    if (provider !== "codex") assert.equal(services.getContext().root, null);
    cancelChoose = true;
    await page
      .getByRole("button", { name: "选择 " + label + " 目录", exact: true })
      .click();
    await idle();
    assert.equal(services.getContext().root, null);
    await page
      .getByRole("button", { name: "选择 " + label + " 目录", exact: true })
      .click();
    await idle();
    await page.getByRole("button", { name: "开始扫描", exact: true }).click();
    await idle();
    await page.getByRole("button", { name: "文件", exact: true }).click();
    if (provider === "claude-code") {
      await page.getByRole("checkbox", { name: /包括历史会话/ }).check();
      await page.getByRole("button", { name: "开始扫描", exact: true }).click();
      await idle();
    }
    const target =
      provider === "claude-code"
        ? sessionPath
        : provider === "cursor"
          ? "GPUCache"
          : provider === "cline"
            ? "db/session-search.db"
            : null;
    const select = target
      ? page.getByRole("checkbox", { name: "选择 " + target, exact: true })
      : page.locator(".file-table input[type=checkbox]:enabled").last();
    await select.check();
    await settledTheme("light");
    await page
      .getByRole("button", { name: "预览隔离操作", exact: true })
      .click();
    await idle();
    assert.equal(await selector.isDisabled(), true);
    const dialog = page.getByRole("dialog");
    if (target) assert.match(await dialog.innerText(), /整组/);
    await page.screenshot({
      path: path.join(out, provider + "-preview-light.png"),
      animations: "disabled",
    });
    await dialog.getByRole("checkbox").nth(0).check();
    await dialog.getByRole("checkbox").nth(1).check();
    await dialog
      .getByRole("button", { name: "确认移入隔离区", exact: true })
      .click();
    await idle();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "隔离记录", exact: true }).click();
    await idle();
    assert.match(
      await page.locator(".batch-heading").innerText(),
      new RegExp(label),
    );
    await page.getByRole("button", { name: "恢复此批次", exact: true }).click();
    await page.getByRole("dialog").getByRole("checkbox").check();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认恢复", exact: true })
      .click();
    await idle();
    await page.keyboard.press("Escape");
    assert.equal(
      (await services.engine().history())[0].items[0].status,
      "restored",
    );
    for (const color of ["light", "dark"]) {
      await settledTheme(color);
      await page.screenshot({
        path: path.join(out, provider + "-" + color + ".png"),
        animations: "disabled",
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
    }
    note(
      label +
        " provider selection, folder cancellation, real file-or-coherent-unit quarantine/history/restore, 1024px dual-theme layout",
    );
  }
  await selector.selectOption("claude-code");
  await idle();
  await page
    .getByRole("button", { name: "选择 Claude Code 目录", exact: true })
    .click();
  await idle();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-table input[type=checkbox]:enabled").last().check();
  status = "unknown";
  await page.getByRole("button", { name: "预览隔离操作", exact: true }).click();
  await idle();
  await page.getByRole("dialog").getByRole("checkbox").nth(0).check();
  await page.getByRole("dialog").getByRole("checkbox").nth(1).check();
  assert.equal(
    await page
      .getByRole("button", { name: "确认移入隔离区", exact: true })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await selector.selectOption("cursor");
  await idle();
  assert.equal(
    await page
      .getByRole("button", { name: "预览隔离操作", exact: true })
      .isDisabled(),
    true,
  );
  note("unknown process fails closed and switching drops stale selection");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(
      { tests: report, themeEvidence, errors, sandbox: true, synthetic: true },
      null,
      2,
    ),
  );
  console.log("MULTI_PROVIDER_UI_PASS", report.length);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
