import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  screen,
  clipboard,
  nativeTheme,
} from "electron";
import path from "node:path";
import os from "node:os";
import { isTrustedRendererEvent, rendererFileUrl } from "./renderer-origin.js";
import { AppDataServices } from "./app-services.js";
import { shutdownDiagnosticWorkers } from "./diagnostics.js";
import { PreferenceStore } from "./preferences.js";
import { checkCodexProcesses } from "./processes.js";
import type { ScanOptions, DiagnoseRequest } from "../shared/types.js";
app.setName("AgentVac");
if (!app.isPackaged && process.env.AGENTVAC_TEST_USER_DATA)
  app.setPath("userData", path.resolve(process.env.AGENTVAC_TEST_USER_DATA));
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow;
let services: AppDataServices;
let preferences: PreferenceStore;
let operation = false;
let operationName = "";
let quitting = false;
let flushedForQuit = false;
const writeOperations = new Set([
  "quarantine",
  "restore",
  "trash",
  "demo",
  "reset-demo",
  "import-keys",
  "export-keys",
]);
const devUrl =
  !app.isPackaged && process.env.AGENTVAC_DEV_URL === "http://127.0.0.1:5173"
    ? process.env.AGENTVAC_DEV_URL
    : undefined;
const localRendererUrl = rendererFileUrl(
  path.join(__dirname, "../dist/index.html"),
);
function register(
  name: string,
  handler: (...args: any[]) => Promise<unknown>,
  allowWhileBusy = false,
) {
  ipcMain.handle("agentvac:" + name, async (event, ...args) => {
    if (
      !isTrustedRendererEvent(
        event,
        window.webContents,
        localRendererUrl,
        devUrl,
      )
    )
      throw new Error("不可信 IPC 来源。");
    if (quitting) throw new Error("应用正在退出，请等待文件写入完成。");
    if (allowWhileBusy) return handler(...args);
    if (operation) throw new Error("请等待当前操作完成。");
    operation = true;
    operationName = name;
    try {
      return await handler(...args);
    } finally {
      operation = false;
      operationName = "";
    }
  });
}
function selected() {
  return services.engine();
}
app.on("before-quit", (event) => {
  if (flushedForQuit || (operation && writeOperations.has(operationName)))
    return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  services?.cancelDiagnosis();
  void Promise.allSettled([
    preferences?.flush(),
    services?.flush(),
    shutdownDiagnosticWorkers(),
  ]).finally(() => {
    flushedForQuit = true;
    app.quit();
  });
});
app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
app
  .whenReady()
  .then(async () => {
    const profile = app.getPath("userData");
    const isolatedTest =
      !app.isPackaged && !!process.env.AGENTVAC_TEST_USER_DATA;
    services = new AppDataServices(profile, {
      home: isolatedTest ? profile : os.homedir(),
      env: isolatedTest
        ? {}
        : {
            CODEX_HOME: process.env.CODEX_HOME,
            CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME,
          },
      cwd: isolatedTest ? profile : process.cwd(),
      processCheck: checkCodexProcesses,
      trashItem: (directory) => shell.trashItem(directory),
    });
    await services.initialize();
    preferences = new PreferenceStore(app.getPath("userData"));
    nativeTheme.themeSource = (await preferences.load()).theme;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: "AgentVac",
                submenu: [
                  { role: "about" as const },
                  { type: "separator" as const },
                  { role: "hide" as const },
                  { role: "hideOthers" as const },
                  { role: "unhide" as const },
                  { type: "separator" as const },
                  { role: "quit" as const },
                ],
              },
            ]
          : []),
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "显示",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
        ...(process.platform !== "darwin"
          ? [{ label: "文件", submenu: [{ role: "quit" as const }] }]
          : []),
      ]),
    );
    const available = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({
      width: Math.min(1440, available.width),
      height: Math.min(950, available.height),
      minWidth: Math.min(1000, available.width),
      minHeight: Math.min(700, available.height),
      title: "AgentVac",
      autoHideMenuBar: process.platform !== "darwin",
      icon: path.join(__dirname, "../build/icon.png"),
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#11131a" : "#f5f6fa",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    let closingNotice = false;
    window.on("close", (event) => {
      if (operationName === "diagnose-storage") services.cancelDiagnosis();
      if (operation && writeOperations.has(operationName)) {
        event.preventDefault();
        quitting = false;
        flushedForQuit = false;
        if (!closingNotice) {
          closingNotice = true;
          void dialog
            .showMessageBox(window, {
              type: "info",
              title: "操作进行中",
              message: "请等待当前操作完成。",
              detail:
                "扫描可以取消。文件操作或恢复资料写入完成前请保持窗口开启。",
              buttons: ["继续等待"],
            })
            .finally(() => {
              closingNotice = false;
            });
        }
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    register("context", async () => services.getContext());
    register(
      "preferences",
      async () => {
        await preferences.flush();
        return preferences.current();
      },
      true,
    );
    register(
      "set-theme",
      async (theme) => {
        const saved = await preferences.setTheme(theme);
        nativeTheme.themeSource = saved.theme;
        return saved;
      },
      true,
    );
    nativeTheme.on("updated", () => {
      if (window && !window.isDestroyed())
        window.setBackgroundColor(
          nativeTheme.shouldUseDarkColors ? "#11131a" : "#f5f6fa",
        );
    });
    register("copy-root", async () => {
      const current = services.getContext();
      if (!current.root) throw new Error("请先选择目录。");
      clipboard.writeText(current.root);
    });
    register("choose-root", async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择 Codex 数据目录（通常为 .codex）",
        properties: ["openDirectory", "showHiddenFiles"],
      });
      if (result.canceled) return null;
      return services.selectCodexRoot(result.filePaths[0], false);
    });
    register("demo", async () => services.loadDemo());
    register("reset-demo", async (confirmed: boolean) =>
      services.resetDemo(confirmed),
    );
    register("app-data", async () => services.getAppData());
    register("activate-workspace", async (id: string) =>
      services.activateWorkspace(id),
    );
    register("activate-candidate", async (id: string) =>
      services.activateCandidate(id),
    );
    register("forget-workspace", async (id: string) =>
      services.forgetWorkspace(id),
    );
    register("choose-diagnostic-root", async (kind: "sqlite" | "logs") => {
      if (kind !== "sqlite" && kind !== "logs")
        throw new Error("诊断目录类型无效。");
      const result = await dialog.showOpenDialog(window, {
        title:
          kind === "sqlite"
            ? "选择 Codex SQLite 数据目录"
            : "选择 Codex 普通日志目录",
        properties: ["openDirectory", "showHiddenFiles"],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return services.rememberDiagnosticRoot(result.filePaths[0], kind);
    });
    register("diagnose-storage", async (request: DiagnoseRequest) =>
      services.diagnose(request),
    );
    register(
      "cancel-diagnosis",
      async (requestId?: string) => services.cancelDiagnosis(requestId),
      true,
    );
    register("inspect-recovery", async () => selected().inspectRecovery());
    register("import-keys", async (confirmed: boolean) => {
      if (confirmed !== true)
        throw new Error("请先确认只导入你自己的恢复钥匙备份。");
      const choice = await dialog.showOpenDialog(window, {
        title: "导入 AgentVac 恢复钥匙备份",
        properties: ["openFile", "showHiddenFiles"],
        filters: [{ name: "AgentVac 恢复钥匙", extensions: ["json", "key"] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
      return {
        canceled: false,
        result: await services.importKeys(choice.filePaths[0]),
      };
    });
    register("export-keys", async (confirmed: boolean) => {
      if (confirmed !== true)
        throw new Error("请先确认安全保管恢复钥匙备份，不要发送给他人。");
      const choice = await dialog.showSaveDialog(window, {
        title: "保存恢复钥匙备份（含敏感恢复材料）",
        defaultPath: "AgentVac-recovery-keys.json",
        filters: [{ name: "AgentVac 恢复钥匙", extensions: ["json"] }],
      });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      return {
        canceled: false,
        result: await services.exportKeys(choice.filePath),
      };
    });
    register("open-system-trash", async () => {
      if (process.platform === "darwin") {
        const error = await shell.openPath(path.join(os.homedir(), ".Trash"));
        if (error)
          throw new Error("无法打开系统废纸篓，请通过 Finder 查看：" + error);
      } else if (process.platform === "win32") {
        await shell.openExternal("shell:RecycleBinFolder");
      } else {
        await shell.openExternal("trash:///");
      }
    });
    register(
      "cancel-scan",
      async (requestId?: string) => selected().cancelScan(requestId),
      true,
    );
    register("scan", async (options: ScanOptions) =>
      selected().scan(options, (progress) => {
        if (window && !window.isDestroyed())
          window.webContents.send("agentvac:scan-progress", progress);
      }),
    );
    register("preview", async (ids: string[]) => selected().preview(ids));
    register("quarantine", async (token: string, closed: boolean) => {
      if (typeof token !== "string" || typeof closed !== "boolean")
        throw new Error("无效请求。");
      return selected().quarantine(token, closed);
    });
    register("history", async () => selected().history());
    register("restore", async (id: string, closed: boolean) => {
      if (typeof id !== "string" || typeof closed !== "boolean")
        throw new Error("无效请求。");
      return selected().restore(id, closed);
    });
    register("trash", async (id: string, confirmed: boolean) =>
      selected().trash(id, confirmed, (dir) => shell.trashItem(dir)),
    );
    register("open-quarantine", async () => {
      const dir = await selected().getQuarantinePath();
      const problem = await shell.openPath(dir);
      if (problem) throw new Error(problem);
    });
    if (devUrl) await window.loadURL(devUrl);
    // loadFile uses legacy URL formatting, which differs for paths such as
    // Windows short-name TEMP directories (RUNNER~1). Load the exact allowlist URL.
    else await window.loadURL(localRendererUrl);
    app.on("activate", () => {
      if (window && !window.isDestroyed()) window.show();
    });
  })
  .catch((err) => {
    dialog.showErrorBox("AgentVac 启动失败", String(err));
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
