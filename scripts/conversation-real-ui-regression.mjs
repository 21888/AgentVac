// Production renderer + real services + all four real readers, synthetic files only.
// Transport is an explicit Playwright test bridge; native Electron IPC is a separate gate.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { AppDataServices } from "../electron/app-services.ts";
import { ConversationServices } from "../electron/conversations/service.ts";
import { conversationReaders } from "../electron/conversations/index.ts";
import { initializeCursorSnapshotStorage } from "../electron/conversations/cursor-temp.ts";
import { createConversationFixtures } from "./conversation-ui-fixtures.mjs";
const project = path.resolve(".");
await fs.mkdir(path.join(project, ".qa"), { recursive: true });
const base = await fs.mkdtemp(
  path.join(project, ".qa", "real-conversation-ui-"),
);
const output = path.join(project, "docs/conversation-ui");
await fs.mkdir(output, { recursive: true });
const fixture = await createConversationFixtures(base);
await initializeCursorSnapshotStorage(path.join(base, "private-snapshots"));
const services = new AppDataServices(path.join(base, "profile"), {
  home: path.join(base, "home"),
  env: {},
  processCheck: async () => ({ status: "clear", details: "合成进程状态" }),
  providerProcessCheck: async () => ({
    status: "clear",
    details: "合成进程状态",
  }),
});
await services.initialize();
await services.selectProviderRoot(fixture.roots.codex, "codex");
const conversations = new ConversationServices({
  engine: () => services.engine(),
  context: () => services.getContext(),
  readers: conversationReaders,
});
const hash = async (p) =>
  createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
const before = await Promise.all(fixture.originalFiles.map(hash));
let theme = "light";
const calls = [];
const bridge = async (method, args) => {
  calls.push(method);
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
    case "history":
      return services.engine().history();
    case "copyRootPath":
      return;
    case "setProvider":
      await conversations.cancelAndDrain();
      await services.setProvider(args[0]);
      return services.selectProviderRoot(fixture.roots[args[0]], args[0]);
    case "chooseRoot":
      return null;
    case "getConversationAccess":
      return conversations.getAccess();
    case "setConversationAccess":
      return conversations.setAccess(args[0]);
    case "listConversations":
      return conversations.list(args[0]);
    case "readConversation":
      return conversations.read(args[0]);
    case "cancelConversationRequest":
      return conversations.cancel(args[0]);
    case "previewConversationArchive":
      return conversations.previewArchive(args[0]);
    default:
      throw Error("Unrequested native-source UI test action " + method);
  }
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://127.0.0.1").pathname,
    );
    const p = path.resolve(
      project,
      "dist",
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!p.startsWith(path.join(project, "dist") + path.sep))
      throw Error("denied");
    res.setHeader(
      "Content-Type",
      p.endsWith(".js")
        ? "application/javascript"
        : p.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await fs.readFile(p));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  at: new Date().toISOString(),
  source:
    "Production renderer, real ConversationServices and four provider readers over explicit test bridge; synthetic native-format files only; not native Electron IPC",
  checks: [],
  errors: [],
  externalRequests: [],
  fixtureRoot: base,
};
let browser, page;
const pass = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
try {
  browser = await chromium.launch({
    executablePath: process.env.AGENTVAC_BROWSER || "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
  });
  page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
    timezoneId: "America/New_York",
  });
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(origin))
      report.externalRequests.push(r.url());
  });
  await page.exposeFunction("__realConversationBridge", bridge);
  await page.addInitScript(() => {
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getAppData",
        "getPreferences",
        "setTheme",
        "history",
        "copyRootPath",
        "setProvider",
        "chooseRoot",
        "getConversationAccess",
        "setConversationAccess",
        "listConversations",
        "readConversation",
        "cancelConversationRequest",
        "previewConversationArchive",
      ].map((method) => [
        method,
        (...args) => window.__realConversationBridge(method, args),
      ]),
    );
  });
  await page.goto(origin);
  for (const provider of ["codex", "claude-code", "cline", "cursor"]) {
    if (provider !== "codex")
      await page
        .getByRole("combobox", { name: "数据提供方", exact: true })
        .selectOption(provider);
    await page.getByRole("button", { name: "对话管理", exact: true }).click();
    await page.getByTestId("conversation-consent").waitFor();
    if (provider === "cursor") {
      await page.getByTestId("cursor-database-consent").waitFor();
      assert.ok(
        (
          await page.getByTestId("cursor-database-consent").textContent()
        ).includes("整个数据库"),
      );
    }
    await page.getByTestId("conversation-consent-checkbox").check();
    await page.getByTestId("conversation-grant").click();
    await page.getByTestId("conversation-row").first().waitFor();
    await page
      .getByRole("searchbox", { name: "搜索对话标题", exact: true })
      .fill("本地对话合成验证 00");
    await page.getByTestId("conversation-apply").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="conversation-row"]').length ===
        1,
    );
    await page
      .getByRole("searchbox", { name: "搜索对话全文", exact: true })
      .fill("FINAL_NATIVE_TEXT");
    await page.getByTestId("conversation-apply").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="conversation-list"]')
          .getAttribute("aria-busy") === "false",
    );
    await page.getByTestId("conversation-row").first().waitFor();
    assert.equal(await page.getByTestId("conversation-row").count(), 1);
    pass(provider + ": real title and full-text search find the last message");
    await page.locator(".conversation-open").first().click();
    await page.locator(".conversation-message").first().waitFor();
    await page.getByTestId("conversation-apply").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="conversation-list"]')
          .getAttribute("aria-busy") === "false",
    );
    let pages = 0;
    while (
      await page
        .getByRole("button", { name: "下一页消息", exact: true })
        .isEnabled()
    ) {
      await page
        .getByRole("button", { name: "下一页消息", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="conversation-detail"]')
            .getAttribute("aria-busy") === "false",
      );
      assert.ok(++pages < 30);
    }
    assert.ok(
      (await page.getByTestId("conversation-detail").textContent()).includes(
        "FINAL_NATIVE_TEXT",
      ),
    );
    pass(provider + ": last real message reachable without source mutation");
    if (pages >= 2) {
      await page
        .getByRole("button", { name: "上一页消息", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="conversation-detail"]')
            .getAttribute("aria-busy") === "false",
      );
      await page
        .getByRole("button", { name: "下一页消息", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="conversation-detail"]')
            .getAttribute("aria-busy") === "false",
      );
      assert.ok(
        (await page.getByTestId("conversation-detail").textContent()).includes(
          "FINAL_NATIVE_TEXT",
        ),
      );
      pass(
        provider +
          ": previously visited opaque message cursor remains reusable",
      );
    }
    await page.getByRole("button", { name: /^筛选/ }).click();
    await page.getByLabel("对话开始日期", { exact: true }).fill("2026-08-01");
    await page.getByLabel("对话结束日期", { exact: true }).fill("2026-08-01");
    await page.getByTestId("conversation-apply").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="conversation-list"]')
          .getAttribute("aria-busy") === "false",
    );
    await page.getByTestId("conversation-row").first().waitFor();
    assert.equal(await page.getByTestId("conversation-row").count(), 1);
    pass(
      provider +
        ": native timestamp matches local date despite January file mtime",
    );
    await page.getByLabel("对话开始日期", { exact: true }).fill("2026-01-01");
    await page.getByLabel("对话结束日期", { exact: true }).fill("2026-01-01");
    await page.getByTestId("conversation-apply").click();
    await page.getByText("没有匹配的对话", { exact: true }).waitFor();
    pass(
      provider +
        ": file modification date does not leak into conversation date filter",
    );
    await page.getByRole("button", { name: "重置筛选", exact: true }).click();
    await page.getByTestId("conversation-row").first().waitFor();
    await page.getByRole("button", { name: /^筛选/ }).click();
    if (provider === "codex" || provider === "claude-code") {
      await page
        .getByRole("button", { name: "下一页对话", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".conversation-pagination")
          .textContent.includes("第 2 页"),
      );
      await page
        .getByRole("button", { name: "上一页对话", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".conversation-pagination")
          .textContent.includes("第 1 页"),
      );
      pass(
        provider + ": real snapshot list supports forward and back navigation",
      );
    }
    await page.getByTestId("conversation-revoke").click();
    await page.getByTestId("conversation-consent").waitFor();
    assert.equal(conversations.getAccess().allowed, false);
  }
  assert.deepEqual(await Promise.all(fixture.originalFiles.map(hash)), before);
  pass("All original synthetic native source bytes remain identical");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  pass("No runtime errors or external requests in four real-reader flows");
} catch (error) {
  report.failure = String(error);
  await page
    ?.screenshot({ path: path.join(output, "real-service-failure.png") })
    .catch(() => {});
  throw error;
} finally {
  report.calls = calls;
  await fs.writeFile(
    path.join(output, "real-service-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await conversations.cancelAndDrain();
  await new Promise((r) => server.close(r));
}
