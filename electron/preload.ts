import { contextBridge, ipcRenderer } from "electron";
import type { AgentVacAPI } from "../shared/types.js";
const api: AgentVacAPI = {
  getContext: () => ipcRenderer.invoke("agentvac:context"),
  getAppData: () => ipcRenderer.invoke("agentvac:app-data"),
  activateWorkspace: (id) =>
    ipcRenderer.invoke("agentvac:activate-workspace", id),
  activateCandidate: (id) =>
    ipcRenderer.invoke("agentvac:activate-candidate", id),
  forgetWorkspace: (id) => ipcRenderer.invoke("agentvac:forget-workspace", id),
  chooseDiagnosticRoot: (kind) =>
    ipcRenderer.invoke("agentvac:choose-diagnostic-root", kind),
  diagnoseStorage: (request) =>
    ipcRenderer.invoke("agentvac:diagnose-storage", request),
  cancelDiagnosis: (requestId) =>
    ipcRenderer.invoke("agentvac:cancel-diagnosis", requestId),
  importRecoveryKeys: (confirmed) =>
    ipcRenderer.invoke("agentvac:import-keys", confirmed),
  exportRecoveryKeys: (confirmed) =>
    ipcRenderer.invoke("agentvac:export-keys", confirmed),
  inspectRecovery: () => ipcRenderer.invoke("agentvac:inspect-recovery"),
  resetDemo: (confirmed) =>
    ipcRenderer.invoke("agentvac:reset-demo", confirmed),
  openSystemTrash: () => ipcRenderer.invoke("agentvac:open-system-trash"),
  getPreferences: () => ipcRenderer.invoke("agentvac:preferences"),
  setTheme: (theme) => ipcRenderer.invoke("agentvac:set-theme", theme),
  copyRootPath: () => ipcRenderer.invoke("agentvac:copy-root"),
  chooseRoot: () => ipcRenderer.invoke("agentvac:choose-root"),
  loadDemo: () => ipcRenderer.invoke("agentvac:demo"),
  cancelScan: (requestId) =>
    ipcRenderer.invoke("agentvac:cancel-scan", requestId),
  scan: (options) => ipcRenderer.invoke("agentvac:scan", options),
  onScanProgress: (listener) => {
    const handler = (
      _event: unknown,
      progress: Parameters<typeof listener>[0],
    ) => listener(progress);
    ipcRenderer.on("agentvac:scan-progress", handler);
    return () => ipcRenderer.removeListener("agentvac:scan-progress", handler);
  },
  preview: (ids) => ipcRenderer.invoke("agentvac:preview", ids),
  quarantine: (token, confirmedClosed) =>
    ipcRenderer.invoke("agentvac:quarantine", token, confirmedClosed),
  history: () => ipcRenderer.invoke("agentvac:history"),
  restore: (id, confirmedClosed) =>
    ipcRenderer.invoke("agentvac:restore", id, confirmedClosed),
  trash: (id, confirmed) => ipcRenderer.invoke("agentvac:trash", id, confirmed),
  openQuarantine: () => ipcRenderer.invoke("agentvac:open-quarantine"),
};
contextBridge.exposeInMainWorld("agentvac", api);
