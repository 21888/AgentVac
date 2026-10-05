// Read-only CI diagnostics: never emit raw command lines or alter the actual guard.
import {
  collectStableProcessSnapshot,
  collectProcessSnapshot,
  applicationExecutablePaths,
} from "../electron/processes.ts";
import { getAdapter } from "../electron/providers/index.ts";
import { assessObservedRuntime } from "../electron/providers/observed-runtime.ts";
const refusalCodes = new Set([
  "unsupported",
  "invalid-request",
  "permission",
  "exited",
  "changed",
  "truncated",
  "invalid-data",
  "cancelled",
  "timeout",
  "unavailable",
]);
export function summarizeProcessBlockers(snapshot, adapter) {
  const blockers = snapshot.processes
    .filter(
      (record) =>
        adapter.assessProcesses({
          platform: snapshot.platform,
          complete: true,
          processes: [record],
        }).status !== "clear",
    )
    .slice(0, 8);
  return {
    complete: snapshot.complete,
    total: snapshot.processes.length,
    blockers: blockers.map((record) => {
      const command = record.commandLine ?? "";
      return {
        name: record.name
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)
          .replace(/[^A-Za-z0-9_. ()-]/g, "?")
          .slice(0, 80),
        status: adapter.assessProcesses({
          platform: snapshot.platform,
          complete: true,
          processes: [record],
        }).status,
        pid: record.pid ?? null,
        hasCommand: !!command,
        inlineRuntime: /(?:^|\s)(?:-e|-p|-c|--eval|--print)(?:=|\s|$)/.test(
          command,
        ),
        argumentObservation: ["verified", "unavailable"].includes(
          record.argumentObservation?.status,
        )
          ? record.argumentObservation.status
          : "not-collected",
        argumentRefusal:
          record.argumentObservation?.status === "unavailable"
            ? refusalCodes.has(record.argumentObservation.reason)
              ? record.argumentObservation.reason
              : "invalid-data"
            : null,
        observedClassification: assessObservedRuntime(record, adapter.id),
      };
    }),
  };
}
export async function nativeProcessObservation(application, provider) {
  const owned = await application.evaluate(({ app }) => ({
    pid: process.pid,
    paths: [process.execPath],
    platform: process.platform,
    pids: app.getAppMetrics().map((item) => item.pid),
  }));
  const app = {
    pid: owned.pid,
    executablePaths: applicationExecutablePaths(owned.paths[0], owned.platform),
  };
  const snapshot = await collectStableProcessSnapshot((signal) =>
    collectProcessSnapshot(owned.pids, app, signal),
  );
  const adapter = getAdapter(provider);
  return {
    provider,
    status: adapter.assessProcesses(snapshot).status,
    ...summarizeProcessBlockers(snapshot, adapter),
  };
}
