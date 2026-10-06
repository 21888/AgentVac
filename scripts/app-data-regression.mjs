// Production Vue + real AppDataServices, generated local fixtures only. Dialogs and OS Trash use test adapters.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppDataServices } from "../electron/app-services.ts";
import { createDemo } from "../electron/fixtures.ts";
import { PreferenceStore } from "../electron/preferences.ts";
const base = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "agentvac-services-ui-"),
);
const out = path.resolve("docs/app-data-regression");
await fs.mkdir(out, { recursive: true });
const home = path.join(base, "home"),
  root = path.join(home, ".codex"),
  profile = path.join(base, "profile"),
  sqliteRoot = path.join(base, "独立数据库位置"),
  logRoot = path.join(base, "独立日志位置"),
  backup = path.join(base, "my-generated-recovery-backup.json");
await createDemo(root);
await fs.mkdir(sqliteRoot);
await fs.mkdir(logRoot);
await fs.writeFile(
  path.join(root, "config.toml"),
  `sqlite_home = ${JSON.stringify(sqliteRoot)}\nlog_dir = ${JSON.stringify(logRoot)}\napi_key = "synthetic-do-not-display"\n`,
);
await fs.writeFile(path.join(logRoot, "agent.log"), "generated ordinary log");
await fs.writeFile(
  path.join(sqliteRoot, "state_8.sqlite"),
  "generated protected state bytes",
);
const databasePath = path.join(sqliteRoot, "logs_2.sqlite");
const ddl = (await fs.readFile("tests/diagnostics.test.ts", "utf8"))
  .split("const LOG_DDL = `")[1]
  .split("`;")[0];
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA auto_vacuum=NONE;");
db.exec(ddl);
db.close();
let processStatus = {
  status: "clear",
  details: "Generated fixture: no Codex processes",
};
let resetTrashMode = "normal",
  trashMoves = 0,
  trashOpens = 0,
  dialogCanceled = false,
  importCanceled = false,
  chooseCanceled = false;
const serviceOptions = {
  home,
  env: { CODEX_SQLITE_HOME: sqliteRoot },
  cwd: base,
  processCheck: async () => processStatus,
  trashItem: async (dir) => {
    const dest = path.join(base, "generated-trash", randomUUID());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(dir, dest);
    trashMoves++;
    if (resetTrashMode === "after-move")
      throw new Error("Generated failure after move");
  },
};
let services = new AppDataServices(profile, serviceOptions);
await services.initialize();
const prefs = new PreferenceStore(profile);
await prefs.load();
const dist = path.resolve("dist");
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (name === "/__test__/axe.min.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(
        await fs.readFile(path.resolve("node_modules/axe-core/axe.min.js")),
      );
      return;
    }
    const file = path.resolve(
      dist,
      "." + (name === "/" ? "/index.html" : name),
    );
    if (!file.startsWith(dist + path.sep)) throw Error("forbidden");
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

let browser;
const errors = [],
  report = [],
  states = [];
let diagCalls = 0,
  importCalls = 0,
  exportCalls = 0,
  lastDiagnostic,
  holdDiagnosis = false,
  releaseDiagnosis,
  lastDiagnosisRequest;
const cancelDiagnosisIds = [];
const note = (s) => {
  report.push(s);
  console.log("PASS", s);
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
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|Refused to/.test(m.text())
    )
      errors.push(m.text());
  });
  await page.exposeFunction("__serviceUI", async (method, args) => {
    switch (method) {
      case "getContext":
        return services.getContext();
      case "getAppData":
        return services.getAppData();
      case "getPreferences":
        return prefs.current();
      case "setTheme":
        return prefs.setTheme(args[0]);
      case "copyRootPath":
        return;
      case "chooseRoot":
        if (chooseCanceled) {
          chooseCanceled = false;
          return null;
        }
        return services.selectCodexRoot(root);
      case "activateWorkspace":
        return services.activateWorkspace(args[0]);
      case "activateCandidate":
        return services.activateCandidate(args[0]);
      case "forgetWorkspace":
        return services.forgetWorkspace(args[0]);
      case "chooseDiagnosticRoot":
        if (dialogCanceled) {
          dialogCanceled = false;
          return null;
        }
        return services.rememberDiagnosticRoot(
          args[0] === "sqlite" ? sqliteRoot : logRoot,
          args[0],
        );
      case "cancelDiagnosis":
        cancelDiagnosisIds.push(args[0]);
        services.cancelDiagnosis(args[0]);
        if (args[0] === lastDiagnosisRequest?.requestId) releaseDiagnosis?.();
        return;
      case "diagnoseStorage": {
        diagCalls++;
        lastDiagnosisRequest = args[0];
        const hold = holdDiagnosis;
        holdDiagnosis = false;
        const original = fs.lstat;
        let held = false;
        if (hold)
          fs.lstat = async (p, ...rest) => {
            if (!held && p === sqliteRoot) {
              held = true;
              await new Promise((resolve) => {
                releaseDiagnosis = resolve;
              });
            }
            return original(p, ...rest);
          };
        try {
          lastDiagnostic = await services.diagnose(args[0]);
          return lastDiagnostic;
        } finally {
          fs.lstat = original;
          releaseDiagnosis = null;
        }
      }
      case "loadDemo":
        return services.loadDemo();
      case "resetDemo":
        return services.resetDemo(args[0]);
      case "inspectRecovery":
        return services.engine().inspectRecovery();
      case "importRecoveryKeys":
        assert.equal(args[0], true);
        importCalls++;
        if (importCanceled) {
          importCanceled = false;
          return { canceled: true };
        }
        return { canceled: false, result: await services.importKeys(backup) };
      case "exportRecoveryKeys":
        assert.equal(args[0], true);
        exportCalls++;
        return { canceled: false, result: await services.exportKeys(backup) };
      case "openSystemTrash":
        trashOpens++;
        return;
      case "scan":
        return services.engine().scan(args[0], (p) => {
          void page
            .evaluate((data) => window.__progress?.(data), p)
            .catch(() => {});
        });
      case "cancelScan":
        return services.engine().cancelScan(args[0]);
      case "preview":
        return services.engine().preview(args[0]);
      case "quarantine":
        return services.engine().quarantine(args[0], args[1]);
      case "history":
        return services.engine().history();
      case "restore":
        return services.engine().restore(args[0], args[1]);
      case "openQuarantine":
        return;
      case "prepareTrash":
        return services.engine().prepareTrash(args[0]);
      case "cancelTrashConfirmation":
        return services.engine().cancelTrashConfirmation(args[0]);
      case "trash":
        return services
          .engine()
          .trash(args[0], args[1], args[2], args[3], serviceOptions.trashItem);
      default:
        throw Error("unsupported " + method);
    }
  });
  await page.addInitScript(() => {
    window.agentvac = Object.fromEntries(
      [
        "getContext",
        "getAppData",
        "getPreferences",
        "setTheme",
        "copyRootPath",
        "chooseRoot",
        "activateWorkspace",
        "activateCandidate",
        "forgetWorkspace",
        "chooseDiagnosticRoot",
        "diagnoseStorage",
        "cancelDiagnosis",
        "loadDemo",
        "resetDemo",
        "inspectRecovery",
        "importRecoveryKeys",
        "exportRecoveryKeys",
        "openSystemTrash",
        "scan",
        "cancelScan",
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
        (...args) => window.__serviceUI(method, args),
      ]),
    );
    window.agentvac.onScanProgress = (listener) => {
      window.__progress = listener;
      return () => {
        window.__progress = null;
      };
    };
  });
  const idle = () =>
    page.waitForFunction(
      () => document.querySelector(".primary-nav button")?.disabled === false,
    );
  const audit = async (name, locator) => {
    if (locator) await locator.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(
        (t) => document.documentElement.dataset.theme === t,
        theme,
      );
      const file = path.join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      const state = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        sidebarOverflow:
          document.querySelector(".sidebar").scrollHeight >
          document.querySelector(".sidebar").clientHeight,
        modal: !!document.querySelector(".modal"),
        focusInModal: !!document.activeElement?.closest(".modal"),
        text: document.body.innerText,
      }));
      assert.equal(state.horizontalOverflow, false);
      assert.equal(state.sidebarOverflow, false);
      if (state.modal) assert.equal(state.focusInModal, true);
      assert.ok(!state.text.includes("synthetic-do-not-display"));
      const axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: [
              "wcag2a",
              "wcag2aa",
              "wcag21a",
              "wcag21aa",
              "wcag22aa",
              "best-practice",
            ],
          },
        });
        return {
          violations: r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => ({
              target: n.target,
              summary: n.failureSummary,
            })),
          })),
          incomplete: r.incomplete.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({
              target: n.target,
              summary: n.failureSummary,
            })),
          })),
        };
      });
      assert.deepEqual(
        axe.violations,
        [],
        `${name}/${theme}: accessibility violations`,
      );
      states.push({ name, theme, file, ...state, axe });
      await fs.writeFile(
        path.join(out, "states.json"),
        JSON.stringify(states, null, 2),
      );
    }
  };
  await page.goto("http://127.0.0.1:" + server.address().port);
  await idle();
  await page.addScriptTag({
    url: "http://127.0.0.1:" + server.address().port + "/__test__/axe.min.js",
  });
  await audit("01-first-connection");
  assert.equal(diagCalls, 0);
  await page
    .getByRole("button", { name: "连接真实 Codex 目录", exact: true })
    .click();
  await idle();
  assert.equal(services.getContext().root, root);
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await audit("02-directory-management");
  const exportButton = page.getByTestId("export-recovery-keys");
  await exportButton.click();
  assert.equal(await page.getByTestId("admin-confirm").isDisabled(), true);
  await audit("03-export-risk");
  await page.keyboard.press("Escape");
  assert.equal(exportCalls, 0);
  assert.equal(
    await exportButton.evaluate((e) => e === document.activeElement),
    true,
  );
  await exportButton.click();
  await page.getByTestId("admin-risk-ack").check();
  await page.getByTestId("admin-confirm").click();
  await idle();
  assert.equal(exportCalls, 1);
  assert.ok((await fs.stat(backup)).size > 32);
  await services.importKeys(backup);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("button", { name: `选择建议位置 ${sqliteRoot}`, exact: true })
    .click();
  await idle();
  assert.equal(services.getContext().root, root);
  assert.equal(diagCalls, 0);
  const missingPath = path.join(base, "missing-record"),
    movedPath = path.join(base, "moved-record");
  await fs.mkdir(missingPath);
  await fs.mkdir(movedPath);
  await services.rememberDiagnosticRoot(missingPath, "logs");
  await services.rememberDiagnosticRoot(movedPath, "logs");
  await fs.rename(missingPath, missingPath + "-actual");
  await fs.rename(movedPath, movedPath + "-actual");
  await fs.mkdir(movedPath);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await idle();
  await page.getByText("目录缺失", { exact: false }).first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: `连接目录 ${missingPath}`, exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: `连接目录 ${movedPath}`, exact: true })
      .isDisabled(),
    true,
  );
  await audit(
    "13-unavailable-workspaces",
    page.getByRole("button", {
      name: `只移除目录记录 ${missingPath}`,
      exact: true,
    }),
  );
  await page
    .getByRole("button", { name: `只移除目录记录 ${missingPath}`, exact: true })
    .click();
  await idle();
  assert.ok((await fs.stat(missingPath + "-actual")).isDirectory());
  assert.equal(
    (await services.getAppData()).workspaces.entries.some(
      (e) => e.path === missingPath,
    ),
    false,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "manage-title",
  );
  note(
    "explicit candidate activation adds a diagnostic root without changing active Codex root or scanning; missing/moved entries stay disabled and forget removes only records",
  );
  const beforeChooser = (await services.getAppData()).workspaces.entries.length;
  await page.getByRole("button", { name: "空间诊断", exact: true }).click();
  await idle();
  dialogCanceled = true;
  await page
    .getByRole("button", { name: "添加 SQLite 位置", exact: true })
    .click();
  await idle();
  assert.equal(
    (await services.getAppData()).workspaces.entries.length,
    beforeChooser,
  );
  assert.equal(diagCalls, 0);
  await page
    .getByRole("button", { name: "添加 SQLite 位置", exact: true })
    .click();
  await idle();
  await page
    .getByRole("checkbox", { name: `诊断 ${root}`, exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: `诊断 ${sqliteRoot}`, exact: true })
    .check();
  await page.getByTestId("run-diagnostics").click();
  await idle();
  assert.equal(lastDiagnostic.configHints.length, 0);
  assert.ok(
    lastDiagnostic.files.some((f) => f.path.endsWith("state_8.sqlite")),
  );
  assert.ok(lastDiagnostic.sqliteTotalBytes > lastDiagnostic.totals.sqlite);
  await audit("04-diagnostics-files", page.locator(".diagnostic-totals"));
  await page.getByTestId("diagnostic-config-opt-in").check();
  assert.equal(await page.locator(".diagnostic-totals").count(), 0);
  await page.getByTestId("run-diagnostics").click();
  await idle();
  assert.equal(lastDiagnostic.configHints.length, 2);
  await audit("05-explicit-config", page.locator(".diagnostic-options"));
  assert.equal(await page.getByTestId("run-deep-check").isDisabled(), true);
  await page.getByTestId("deep-check-opt-in").check();
  assert.equal(await page.getByTestId("run-deep-check").isDisabled(), true);
  await page.getByTestId("deep-check-closed").check();
  const hashBefore = createHash("sha256")
    .update(await fs.readFile(databasePath))
    .digest("hex");
  await page.getByTestId("run-deep-check").click();
  await idle();
  assert.equal(lastDiagnostic.deepCheck.status, "ok");
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(databasePath))
      .digest("hex"),
    hashBefore,
  );
  await audit("06-deep-observations", page.getByTestId("deep-check-metrics"));
  await fs.writeFile(databasePath + "-wal", "generated sidecar");
  await page.getByTestId("run-deep-check").click();
  await idle();
  assert.equal(lastDiagnostic.deepCheck.reason, "SIDECARS_PRESENT");
  await audit("07-deep-blocked", page.getByTestId("deep-check-blocked"));
  await fs.unlink(databasePath + "-wal");
  processStatus = {
    status: "unknown",
    details: "generated unknown process state",
  };
  await page.getByTestId("run-deep-check").click();
  await idle();
  assert.equal(lastDiagnostic.deepCheck.reason, "PROCESS_UNKNOWN");
  processStatus = { status: "clear", details: "generated clear" };
  note(
    "explicit scope/config opt-in, actual SQLite metadata and read-only metrics, sidecar/unknown-process blocks; chooser cancellation preserves selection",
  );
  holdDiagnosis = true;
  await page.getByTestId("run-diagnostics").click();
  await page.getByTestId("cancel-diagnosis").waitFor();
  for (let i = 0; !releaseDiagnosis && i < 100; i++)
    await page.waitForTimeout(20);
  assert.ok(releaseDiagnosis);
  const cancelledId = lastDiagnosisRequest.requestId;
  assert.equal(
    await page
      .getByTestId("cancel-diagnosis")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await audit("14-diagnosis-progress");
  await page.getByTestId("cancel-diagnosis").click();
  await idle();
  assert.equal(cancelDiagnosisIds.at(-1), cancelledId);
  assert.equal(await page.locator(".diagnostic-totals").count(), 0);
  assert.equal(await page.locator(".message-banner.error").count(), 0);
  await page
    .getByText("诊断已取消，未修改源文件。本次结果已清空，可重新读取。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByTestId("run-diagnostics")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await audit("15-diagnosis-cancelled");
  holdDiagnosis = true;
  await page.getByTestId("run-diagnostics").click();
  for (let i = 0; !releaseDiagnosis && i < 100; i++)
    await page.waitForTimeout(20);
  assert.ok(releaseDiagnosis);
  assert.notEqual(lastDiagnosisRequest.requestId, cancelledId);
  await page.evaluate((id) => window.agentvac.cancelDiagnosis(id), cancelledId);
  assert.equal(await page.getByTestId("diagnosis-progress").isVisible(), true);
  releaseDiagnosis();
  await idle();
  assert.ok(lastDiagnostic.files.length > 0);
  note(
    "diagnosis cancellation uses current request ID, reports normal cancellation without stale metrics, and ignores a late old ID",
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await page.getByTestId("bulk-select-safe").click();
  await page.getByTestId("preview-selection").click();
  await idle();
  for (const box of await page.getByRole("dialog").getByRole("checkbox").all())
    await box.check();
  await page
    .getByRole("button", { name: "确认移入隔离区", exact: true })
    .click();
  await idle();
  await page.keyboard.press("Escape");
  const batches = await services.engine().history();
  const valid = batches.find((b) =>
    b.items.some((i) => i.status === "quarantined"),
  );
  assert.ok(valid);
  await fs.writeFile(
    path.join(root, ".agentvac-quarantine", valid.id, "unexpected.bin"),
    "generated irregular",
  );
  const invalidId = randomUUID();
  await fs.mkdir(path.join(root, ".agentvac-quarantine", invalidId));
  await fs.writeFile(
    path.join(root, ".agentvac-quarantine", invalidId, "manifest.json"),
    "{}",
  );
  await fs.writeFile(
    path.join(root, ".agentvac-quarantine", invalidId, randomUUID() + ".data"),
    "generated retained but unverified bytes",
  );
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await page.getByTestId("inspect-recovery").click();
  await idle();
  const inspection = await services.engine().inspectRecovery();
  const retained = inspection.batches.reduce((n, b) => n + b.storedFiles, 0);
  assert.ok(inspection.inspectedFiles > retained);
  await page.getByText(`${retained} 个实际留存文件`, { exact: true }).waitFor();
  await audit("08-readonly-recovery", page.locator(".recovery-total"));
  const keyPath = path.join(profile, "recovery", "journal-signing.key"),
    originalKey = await fs.readFile(keyPath);
  await fs.writeFile(keyPath, Buffer.alloc(31, 7));
  services = new AppDataServices(profile, serviceOptions);
  await services.initialize();
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await idle();
  assert.equal((await services.getAppData()).recovery.canSign, false);
  await page.getByTestId("signing-warning").waitFor();
  await page.getByRole("button", { name: "隔离记录", exact: true }).click();
  await idle();
  assert.equal(
    await page.locator(".batch-actions .danger-outline:not(:disabled)").count(),
    0,
  );
  assert.ok(
    (await page.locator(".batch-actions .secondary:not(:disabled)").count()) >
      0,
  );
  await page.getByTestId("open-system-trash").click();
  await idle();
  assert.equal(trashOpens, 1);
  await audit("09-signing-unavailable");
  await page
    .locator(".batch-actions .secondary:not(:disabled)")
    .first()
    .click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await idle();
  await page.keyboard.press("Escape");
  assert.equal(
    (await services.engine().history())
      .find((b) => b.id === valid.id)
      .items.filter((i) => i.status === "restored").length,
    3,
  );
  note(
    "real retained-data counts distinguish irregular files; unsigned batches have no direct restore; missing signing capability disables mutations but authenticated old restore and opening Trash work",
  );
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await idle();
  await page.getByTestId("bulk-select-safe").click();
  await page.getByTestId("preview-selection").click();
  await idle();
  for (const box of await page.getByRole("dialog").getByRole("checkbox").all())
    await box.check();
  assert.equal(
    await page
      .getByRole("button", { name: "确认移入隔离区", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await page.getByTestId("import-recovery-keys").click();
  assert.equal(await page.getByTestId("admin-confirm").isDisabled(), true);
  await audit("10-import-risk");
  await page.getByTestId("admin-risk-ack").check();
  importCanceled = true;
  await page.getByTestId("admin-confirm").click();
  await idle();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByText("已选择 3 项", { exact: true }).waitFor();
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await page.getByTestId("import-recovery-keys").click();
  await page.getByTestId("admin-risk-ack").check();
  await page.getByTestId("admin-confirm").click();
  await idle();
  assert.equal(importCalls, 2);
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByText("未选择项目", { exact: true }).waitFor();
  assert.equal(await page.locator(".file-table tbody tr").count(), 0);
  note(
    "key export/import require explicit risk acknowledgement; native cancellation preserves choices; successful import clears prior scan and selections",
  );
  await fs.writeFile(keyPath, originalKey);
  services = new AppDataServices(profile, serviceOptions);
  await services.initialize();
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await page
    .getByRole("button", { name: "打开演示并扫描", exact: true })
    .click();
  await idle();
  const demoRoot = services.getContext().root;
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  await page.getByTestId("reset-demo").click();
  await audit("11-reset-demo-risk");
  await page.keyboard.press("Escape");
  assert.equal(trashMoves, 0);
  await page.getByTestId("reset-demo").click();
  await page.getByTestId("admin-risk-ack").check();
  await page.getByTestId("admin-confirm").click();
  await idle();
  assert.equal(trashMoves, 1);
  assert.equal(services.getContext().root, demoRoot);
  await page.getByRole("button", { name: "目录与恢复", exact: true }).click();
  await idle();
  resetTrashMode = "after-move";
  await page.getByTestId("reset-demo").click();
  await page.getByTestId("admin-risk-ack").check();
  await page.getByTestId("admin-confirm").click();
  await idle();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(services.getContext().root, null);
  assert.equal(await page.locator(".file-table tbody tr").count(), 0);
  await audit("12-reset-demo-interrupted");
  note(
    "single reusable demo reset requires confirmation; real adapter move succeeds once; post-move failure refreshes actual context and never reports rebuilt success",
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await audit("16-minimum-window-reset-error");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: report,
        states: states.length,
        errors,
        sourceSha256: Object.fromEntries(
          await Promise.all(
            [
              "src/App.vue",
              "src/style.css",
              "electron/app-services.ts",
              "electron/diagnostics.ts",
            ].map(async (file) => [
              file,
              createHash("sha256")
                .update(await fs.readFile(file))
                .digest("hex"),
            ]),
          ),
        ),
        scope:
          "Browser UI with real AppDataServices and generated fixtures. Folder dialogs and OS Trash adapters simulated. Not a native Electron or WCAG certification.",
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
