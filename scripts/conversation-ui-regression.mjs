// Synthetic contract fixtures for renderer-only adversarial and accessibility checks.
// Real provider/service and native IPC acceptance are separate, required gates.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const project = path.resolve(".");
const output = path.join(project, "docs/conversation-ui");
await fs.mkdir(output, { recursive: true });
const axe = await fs.readFile(require.resolve("axe-core/axe.min.js"));
const root = path.join(project, ".qa/synthetic-conversation-contract-fixtures");
let provider = "codex",
  allowed = false,
  consentRevision = 0,
  theme = "light";
let heldList = false,
  releaseList,
  heldDetail = false,
  releaseDetail;
let nextListError = false,
  nextListPartial = false,
  nextArchiveError = false,
  nextRevokeError = false;
let unavailableReason;
let sourceKind = "selected";
const sourceRoot = () =>
  sourceKind === "selected" ? root : path.join(root, "agent-transcripts");
let archived = new Set(),
  batches = [],
  calls = [],
  cancelled = new Set();
const titleHostile =
  '<img src="https://invalid.example/beacon" onerror="alert(1)">';
const rows = Array.from({ length: 240 }, (_, index) => ({
  id: `fixture-${index}`,
  provider: "codex",
  title:
    index === 0
      ? "修复会话读取与本地搜索"
      : index === 1
        ? titleHostile
        : `对话 ${String(index).padStart(3, "0")} · ${index % 2 ? "性能验证" : "界面审阅"}`,
  titleSource: "native",
  project: index % 2 ? "/synthetic/atlas" : "/synthetic/agentvac",
  createdAt:
    index === 2
      ? null
      : new Date(Date.UTC(2026, 9, 5) - index * 86400000).toISOString(),
  updatedAt:
    index === 2
      ? null
      : new Date(Date.UTC(2026, 9, 5, 12) - index * 86400000).toISOString(),
  timeSource: index === 2 ? "unknown" : "messages",
  createdAtSource: "native",
  updatedAtSource: "messages",
  messageCount: index === 0 ? 40 : 2,
  sizeBytes: 12450 + index,
  sourceLabel: `synthetic/session-${index}.jsonl`,
  identityVerified: index !== 3,
  canArchive: index !== 3,
  archiveReason:
    index === 3
      ? "未知版本仅可读取，无法核实关联记录。"
      : "后台合成测试条件已核实；须预览并确认后隔离。",
  warnings: index === 3 ? ["这是未知格式的合成测试记录。"] : [],
  body: index % 2 ? "atlas-only needle" : "agentvac-only 内容关键词",
}));
const messages = Array.from({ length: 40 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 ? "assistant" : "user",
  timestamp: new Date(Date.UTC(2026, 9, 5, 12, index)).toISOString(),
  parts:
    index === 1
      ? [
          {
            type: "text",
            text: `这是安全文本预览。\n${titleHostile}\n[运行](javascript:alert(1))\nhttps://invalid.example/never-fetch\n\n\`\`\`ts\nconst localOnly = true;\n\`\`\`\n代码不会执行。`,
          },
          {
            type: "tool-call",
            text: 'shell: npm test\n{"command":"echo synthetic fixture"}',
          },
          { type: "tool-result", text: "PASS · 仅供测试" },
          {
            type: "attachment",
            text: "图片占位说明 https://invalid.example/private.png",
          },
          { type: "text", text: "第五内容段完整可达" },
        ]
      : index === 2
        ? [
            {
              type: "text",
              text: "长段落合成内容。".repeat(8000) + "末尾完整可达标记",
            },
          ]
        : [
            {
              type: "text",
              text:
                index === 0
                  ? "帮我检查本地对话管理是否能安全读取、筛选和恢复。"
                  : `合成消息 ${index}。本页内容保持在当前进程，不执行工具调用，不加载媒体。`,
            },
          ],
}));
function access() {
  return {
    provider,
    root: sourceRoot(),
    sourceKind,
    sourceLabel:
      sourceKind === "selected"
        ? "当前工具数据目录"
        : "Cursor agent-transcripts（只读）",
    readOnlySource: sourceKind !== "selected",
    allowed,
    revision: String(consentRevision),
    unavailableReason:
      sourceKind === "selected" ? unavailableReason : undefined,
  };
}
function assertAccess() {
  if (!allowed) throw Error("请先同意读取对话内容。");
}
async function bridge(method, args) {
  calls.push({ method, args });
  switch (method) {
    case "getContext":
      return { provider, root, demo: true, platform: "linux" };
    case "getPreferences":
      return { theme };
    case "setTheme":
      theme = args[0];
      return { theme };
    case "history":
      return batches;
    case "chooseRoot":
      return null;
    case "copyRootPath":
      return;
    case "setProvider":
      provider = args[0];
      sourceKind = "selected";
      allowed = false;
      consentRevision++;
      return { provider, root, demo: true, platform: "linux" };
    case "chooseConversationSource":
      sourceKind = args[0];
      allowed = false;
      consentRevision++;
      return access();
    case "resetConversationSource":
      sourceKind = "selected";
      allowed = false;
      consentRevision++;
      return access();
    case "getConversationAccess":
      return access();
    case "setConversationAccess":
      if (!args[0] && nextRevokeError) {
        nextRevokeError = false;
        throw Error("合成撤回确认失败");
      }
      allowed = args[0];
      consentRevision++;
      return access();
    case "cancelConversationRequest":
      cancelled.add(args[0]);
      return;
    case "listConversations": {
      assertAccess();
      const request = args[0];
      if (heldList) {
        heldList = false;
        await new Promise((resolve) => (releaseList = resolve));
      }
      if (nextListError) {
        nextListError = false;
        throw Error("合成读取失败：可重试且未修改任何文件。");
      }
      let matching = rows.filter((row) => !archived.has(row.id));
      if (request.title)
        matching = matching.filter((row) => row.title.includes(request.title));
      if (request.keyword)
        matching = matching.filter((row) => row.body.includes(request.keyword));
      if (request.project)
        matching = matching.filter((row) =>
          row.project.includes(request.project),
        );
      if (request.from || request.to)
        matching = matching.filter((row) => {
          const value = row[request.dateField ?? "updatedAt"];
          return value
            ? (!request.from || value >= request.from) &&
                (!request.to || value < request.to)
            : request.includeUnknownTimes;
        });
      if (request.sort === "title")
        matching.sort((a, b) => a.title.localeCompare(b.title));
      else
        matching.sort((a, b) =>
          (
            b[request.sort === "created-desc" ? "createdAt" : "updatedAt"] ?? ""
          ).localeCompare(
            a[request.sort === "created-desc" ? "createdAt" : "updatedAt"] ??
              "",
          ),
        );
      const start = Number(request.cursor ?? 0),
        limit = request.limit ?? 100;
      const partial = nextListPartial;
      nextListPartial = false;
      return {
        requestId: request.requestId,
        provider,
        root: sourceRoot(),
        items: matching
          .slice(start, start + limit)
          .map(({ body, ...row }) => ({
            ...row,
            provider,
            canArchive: sourceKind === "selected" && row.canArchive,
          })),
        nextCursor:
          start + limit < matching.length ? String(start + limit) : null,
        scannedConversations: rows.length,
        matchedConversations: matching.length,
        partial,
        warnings: partial
          ? ["合成搜索上限：有记录尚未检查，匹配数并非全局总数。"]
          : [],
        snapshotId: "fixture-snapshot",
        queryFingerprint: JSON.stringify(request),
        consentRevision: String(consentRevision),
      };
    }
    case "readConversation": {
      assertAccess();
      const request = args[0];
      if (heldDetail) {
        heldDetail = false;
        await new Promise((resolve) => (releaseDetail = resolve));
      }
      const row = rows.find((item) => item.id === request.conversationId);
      const start = Number(request.cursor ?? 0),
        limit = request.limit ?? 12;
      const source =
        request.conversationId === "fixture-0"
          ? messages
          : messages.slice(0, 2);
      return {
        requestId: request.requestId,
        conversation: { ...row, provider },
        messages: source.slice(start, start + limit),
        nextCursor:
          start + limit < source.length ? String(start + limit) : null,
        partial: false,
        warnings: [],
      };
    }
    case "previewConversationArchive": {
      assertAccess();
      if (nextArchiveError) {
        nextArchiveError = false;
        throw Error("源记录已改变，请重新核实。");
      }
      const conversations = rows.filter((row) => args[0].includes(row.id));
      return {
        conversations,
        preview: {
          token: JSON.stringify(args[0]),
          provider,
          root,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          scanStatus: "complete",
          processStatus: { status: "clear", details: "合成进程状态：已退出" },
          totalBytes: conversations.reduce(
            (sum, row) => sum + row.sizeBytes,
            0,
          ),
          items: conversations.map((row) => ({
            id: row.id,
            path: row.sourceLabel,
            category: "session",
            risk: "review",
            size: row.sizeBytes,
            mtimeMs: 1,
            ageDays: 90,
            reason: row.archiveReason,
            selectable: true,
            kind: "file",
          })),
        },
      };
    }
    case "quarantine": {
      const ids = JSON.parse(args[0]);
      ids.forEach((id) => archived.add(id));
      const batch = {
        id: "synthetic-batch-1",
        provider,
        root,
        createdAt: new Date().toISOString(),
        items: ids.map((id) => ({
          id,
          path: `synthetic/${id}.jsonl`,
          size: 100,
          status: "quarantined",
        })),
      };
      batches.push(batch);
      return {
        batchId: batch.id,
        completed: ids.length,
        failed: [],
        bytes: 100 * ids.length,
      };
    }
    case "restore": {
      const batch = batches.find((batch) => batch.id === args[0]);
      batch.items.forEach((item) => {
        archived.delete(item.id);
        item.status = "restored";
      });
      return {
        batchId: batch.id,
        completed: batch.items.length,
        failed: [],
        bytes: 100 * batch.items.length,
      };
    }
    default:
      throw Error("Unsupported synthetic renderer API: " + method);
  }
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1").pathname,
    );
    if (pathname === "/__test__/axe.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(axe);
      return;
    }
    const file = path.resolve(
      project,
      "dist",
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(path.join(project, "dist") + path.sep))
      throw Error("denied");
    response.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(await fs.readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  at: new Date().toISOString(),
  source:
    "Production renderer with explicitly synthetic contract fixtures; does not establish backend or native IPC correctness",
  checks: [],
  accessibility: [],
  runtimeErrors: [],
  externalRequests: [],
};
const pass = (text) => {
  report.checks.push(text);
  console.log("PASS", text);
};
let browser, page;
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
  page.on("pageerror", (e) => report.runtimeErrors.push(e.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(origin))
      report.externalRequests.push(request.url());
  });
  await page.exposeFunction("__conversationFixture", bridge);
  await page.addInitScript(() => {
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getPreferences",
        "setTheme",
        "history",
        "chooseRoot",
        "copyRootPath",
        "setProvider",
        "getConversationAccess",
        "chooseConversationSource",
        "resetConversationSource",
        "setConversationAccess",
        "listConversations",
        "readConversation",
        "cancelConversationRequest",
        "previewConversationArchive",
        "quarantine",
        "restore",
      ].map((method) => [
        method,
        (...args) => window.__conversationFixture(method, args),
      ]),
    );
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "对话管理", exact: true }).click();
  await page.getByTestId("conversation-consent").waitFor();
  assert.equal(
    calls.filter((call) => call.method === "listConversations").length,
    0,
  );
  assert.equal(await page.getByTestId("conversation-grant").isDisabled(), true);
  pass("No list or message read before explicit content consent");
  await page.addScriptTag({ url: origin + "/__test__/axe.js" });
  const audit = async (name) => {
    const result = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      }));
    });
    report.accessibility.push({ name, violations: result });
    if (result.length)
      await page.screenshot({ path: path.join(output, `failure-${name}.png`) });
    assert.deepEqual(result, [], `Accessibility ${name}`);
  };
  await audit("consent-light");
  await page.getByTestId("conversation-consent-checkbox").check();
  await page.getByTestId("conversation-grant").click();
  await page.getByTestId("conversation-row").first().waitFor();
  assert.ok((await page.getByTestId("conversation-row").count()) < 20);
  pass("Paginated list renders fewer than 20 rows in the viewport");
  await page.getByRole("heading", { name: "对话管理", exact: true }).focus();
  await page.keyboard.press("/");
  assert.equal(
    await page
      .getByRole("searchbox", { name: "搜索对话标题", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.locator(".conversation-open").first().focus();
  await page.keyboard.press("End");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        .closest("[data-conversation-index]")
        ?.getAttribute("data-conversation-index"),
    ),
    "19",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        .closest("[data-conversation-index]")
        ?.getAttribute("data-conversation-index"),
    ),
    "1",
  );
  pass(
    "Keyboard search and Home/End/arrow navigation preserve focused virtual rows",
  );
  await page
    .getByRole("button", {
      name: "打开对话：修复会话读取与本地搜索",
      exact: true,
    })
    .click();
  await page.locator(".conversation-message").first().waitFor();
  assert.equal(await page.locator(".conversation-message").count(), 12);
  assert.equal(
    await page
      .locator(
        ".conversation-detail-panel img,.conversation-detail-panel iframe,.conversation-detail-panel a",
      )
      .count(),
    0,
  );
  assert.ok(
    (await page.locator(".conversation-detail-panel").textContent()).includes(
      titleHostile,
    ),
  );
  pass(
    "Hostile HTML, links, attachments, and code remain inert while messages page at 12",
  );
  await page.getByRole("button", { name: "后组内容段", exact: true }).click();
  await page.getByText("第五内容段完整可达", { exact: true }).waitFor();
  const longMessage = page.locator(".conversation-message").nth(2);
  while (
    await longMessage
      .getByRole("button", { name: "继续此段内容", exact: true })
      .isEnabled()
  )
    await longMessage
      .getByRole("button", { name: "继续此段内容", exact: true })
      .click();
  assert.ok((await longMessage.textContent()).includes("末尾完整可达标记"));
  pass(
    "Long text and fifth content part remain fully reachable through bounded paging",
  );
  await page.getByRole("button", { name: "下一页消息", exact: true }).click();
  await page.getByText("正文第 2 页", { exact: false }).waitFor();
  assert.equal(await page.locator(".conversation-message").count(), 12);
  pass("Forward message paging replaces old DOM");
  await page.getByRole("button", { name: "上一页消息", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "选择对话：修复会话读取与本地搜索",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "下一页对话", exact: true }).click();
  await page.getByTestId("conversation-hidden-selection").waitFor();
  assert.ok(
    (
      await page.getByTestId("conversation-hidden-selection").textContent()
    ).includes("1 条"),
  );
  pass("Selection across result pages is retained and explicitly warned");
  await page
    .getByRole("button", { name: "清除本页外选择", exact: true })
    .click();
  assert.equal(
    await page.getByTestId("conversation-hidden-selection").count(),
    0,
  );
  await page
    .getByRole("searchbox", { name: "搜索对话标题", exact: true })
    .fill("修复会话");
  await page.getByTestId("conversation-stale").waitFor();
  assert.equal(
    await page.getByTestId("conversation-preview-selected").isDisabled(),
    true,
  );
  await page.getByTestId("conversation-apply").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="conversation-row"]').length ===
      1,
  );
  pass(
    "Changed filters mark old results stale and disable operations until applied",
  );
  await page
    .getByRole("searchbox", { name: "搜索对话全文", exact: true })
    .fill("needle");
  await page.getByTestId("conversation-apply").click();
  await page.getByText("没有匹配的对话", { exact: true }).waitFor();
  pass("Title and full-text filters are distinct and compose");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByTestId("conversation-row").first().waitFor();
  await page.getByRole("button", { name: /^筛选/ }).click();
  await page
    .getByRole("searchbox", { name: "按项目筛选", exact: true })
    .fill("atlas");
  await page.getByLabel("对话开始日期", { exact: true }).fill("2026-09-01");
  await page.getByLabel("对话结束日期", { exact: true }).fill("2026-10-05");
  await page.getByTestId("conversation-apply").click();
  await page.waitForTimeout(150);
  const lastQuery = calls
    .filter((call) => call.method === "listConversations")
    .at(-1).args[0];
  assert.equal(lastQuery.to, "2026-10-06T04:00:00.000Z");
  assert.equal(lastQuery.from, "2026-09-01T04:00:00.000Z");
  assert.equal(lastQuery.project, "atlas");
  pass(
    "Project and local-calendar exclusive date boundaries reach the API exactly",
  );
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.getByTestId("conversation-row").first().waitFor();
  await page.getByRole("button", { name: /^筛选/ }).click();
  heldList = true;
  await page.getByRole("button", { name: "刷新对话列表", exact: true }).click();
  await page.getByTestId("conversation-cancel-list").click();
  releaseList();
  await page.waitForTimeout(150);
  assert.ok(cancelled.size > 0);
  assert.equal(await page.getByTestId("conversation-cancel-list").count(), 0);
  pass("Cancelled list reply does not revive a pending request");
  nextListError = true;
  await page.getByRole("button", { name: "刷新对话列表", exact: true }).click();
  await page.getByText(/合成读取失败/).waitFor();
  nextListPartial = true;
  await page.getByRole("button", { name: "刷新对话列表", exact: true }).click();
  await page.getByText("读取范围不完整", { exact: true }).waitFor();
  pass("Read errors can retry and partial coverage is prominently disclosed");
  await page.getByRole("button", { name: "刷新对话列表", exact: true }).click();
  await page.getByTestId("conversation-row").first().waitFor();
  await page
    .getByRole("checkbox", {
      name: "选择对话：修复会话读取与本地搜索",
      exact: true,
    })
    .check();
  await page.getByTestId("conversation-preview-selected").click();
  await page.getByRole("dialog").waitFor();
  assert.ok(
    (await page.getByRole("dialog").textContent()).includes(
      "确认这一次对话隔离",
    ),
  );
  await page.getByRole("button", { name: "返回检查", exact: true }).click();
  assert.equal(archived.size, 0);
  pass(
    "Backend preview opens existing confirmation modal; Cancel makes no mutation",
  );
  await page.getByTestId("conversation-preview-selected").click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("checkbox", { name: /我已审阅所选项目/ }).check();
  await page.getByRole("button", { name: "确认演示隔离", exact: true }).click();
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll(".conversation-open")).some((e) =>
        e.textContent.includes("修复会话读取与本地搜索"),
      ),
  );
  assert.equal(archived.size, 1);
  pass(
    "Confirmed archive refreshes conversation workspace without hidden legacy scan",
  );
  assert.equal(calls.filter((call) => call.method === "scan").length, 0);
  await page.getByRole("button", { name: "隔离与恢复", exact: true }).click();
  await page.getByRole("button", { name: "对话管理", exact: true }).click();
  await page.getByTestId("conversation-row").first().waitFor();
  await page.getByTestId("conversation-revoke").click();
  await page.getByTestId("conversation-consent").waitFor();
  assert.equal(await page.locator(".conversation-message").count(), 0);
  assert.equal(await page.getByTestId("conversation-row").count(), 0);
  pass("Revocation removes visible content and selections");
  await page.getByTestId("conversation-consent-checkbox").check();
  await page.getByTestId("conversation-grant").click();
  await page.getByTestId("conversation-row").first().waitFor();
  heldDetail = true;
  await page.locator(".conversation-open").first().click();
  await page
    .getByRole("combobox", { name: "数据提供方", exact: true })
    .selectOption("claude-code");
  releaseDetail();
  await page.getByRole("button", { name: "对话管理", exact: true }).click();
  await page.getByTestId("conversation-consent").waitFor();
  assert.equal(await page.locator(".conversation-message").count(), 0);
  pass(
    "Provider navigation cancels detail and does not leak old content or consent",
  );
  await page.getByTestId("conversation-consent-checkbox").check();
  await page.getByTestId("conversation-grant").click();
  await page.getByTestId("conversation-row").first().waitFor();
  await page.locator(".conversation-open").first().click();
  await page.locator(".conversation-message").first().waitFor();
  for (const [width, height] of [
    [1200, 850],
    [1024, 768],
    [900, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["light", "dark"]) {
      await page
        .getByRole("button", {
          name: mode === "light" ? "浅色主题" : "深色主题",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        (expected) => document.documentElement.dataset.theme === expected,
        mode,
      );
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      await audit(`${mode}-${width}x${height}`);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(output, `conversations-${mode}-${width}x${height}.png`),
      });
    }
  }
  pass(
    "Light/dark workspace has zero selected axe violations and no page horizontal overflow at three desktop sizes",
  );
  nextRevokeError = true;
  await page.getByTestId("conversation-revoke").click();
  await page.getByTestId("conversation-consent").waitFor();
  assert.equal(await page.locator(".conversation-message").count(), 0);
  assert.equal(await page.getByTestId("conversation-row").count(), 0);
  assert.equal(await page.getByTestId("conversation-grant").isDisabled(), true);
  pass(
    "Failed revocation acknowledgement still clears all local content and requires new explicit consent",
  );
  unavailableReason = "合成保护检查尚未完成，此提供方的内容读取暂不可用。";
  await page
    .getByRole("combobox", { name: "数据提供方", exact: true })
    .selectOption("cursor");
  await page.getByTestId("conversation-unavailable").waitFor();
  assert.equal(await page.getByTestId("conversation-grant").isDisabled(), true);
  await page.getByTestId("cursor-database-consent").waitFor();
  pass(
    "Unavailable reader reports its backend reason and cannot grant misleading consent",
  );
  await page.getByTestId("conversation-choose-source").click();
  await page.getByTestId("conversation-consent").waitFor();
  assert.equal(await page.getByTestId("conversation-unavailable").count(), 0);
  assert.equal(await page.getByTestId("cursor-database-consent").count(), 0);
  assert.ok(
    (await page.getByTestId("conversation-source-bar").textContent()).includes(
      "仅只读",
    ),
  );
  await page.getByTestId("conversation-consent-checkbox").check();
  await page.getByTestId("conversation-grant").click();
  await page.getByTestId("conversation-row").first().waitFor();
  assert.equal(
    await page
      .getByTestId("conversation-row")
      .first()
      .locator('input[type="checkbox"]')
      .isDisabled(),
    true,
  );
  pass(
    "Explicit alternate source receives new consent and read-only rows without SQLite snapshot disclosure",
  );
  await page.getByTestId("conversation-reset-source").click();
  await page.getByTestId("conversation-unavailable").waitFor();
  assert.equal(await page.getByTestId("conversation-row").count(), 0);
  pass(
    "Resetting alternate source clears old content and restores selected-root reader capability gate",
  );
  assert.deepEqual(report.runtimeErrors, []);
  assert.deepEqual(report.externalRequests, []);
  pass("No renderer runtime errors or external requests");
} finally {
  await fs.writeFile(
    path.join(output, "renderer-contract-results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
