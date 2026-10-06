import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { promises as fs } from "node:fs";
import {
  initializeCursorSnapshotStorage,
  getCursorSnapshotStorageAvailability,
  createCursorSnapshotDirectory,
} from "../electron/conversations/cursor-temp.js";
for (const root of [
  "\\\\server\\share\\private",
  "\\\\?\\UNC\\server\\share\\private",
  "C:relative",
  "C:\\Mapped\\Private",
])
  test(
    "Windows 0.2 release gate blocks every private-root form before filesystem/helper access: " +
      root,
    async (t) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!,
        env = { ...process.env };
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "win32",
      });
      process.env.SystemRoot = "C:\\Windows";
      const mkdir = t.mock.method(fs, "mkdir", async () => {
        throw Error("must not create any private directory");
      });
      const lstat = t.mock.method(fs, "lstat", async () => {
        throw Error("must not inspect target before locality");
      });
      let spawned = 0;
      t.mock.method(childProcess, "spawn", () => {
        spawned++;
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null as number | null,
          signalCode: null as string | null,
          kill: () => true,
        });
        queueMicrotask(() => {
          child.exitCode = 4;
          child.emit("close", 4);
        });
        return child;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        Object.defineProperty(process, "platform", platform);
        for (const k of Object.keys(process.env))
          if (!(k in env)) delete process.env[k];
        Object.assign(process.env, env);
      });
      await assert.rejects(
        initializeCursorSnapshotStorage(root),
        (error) =>
          error instanceof Error &&
          error.message === "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE",
      );
      assert.equal(mkdir.mock.callCount(), 0);
      assert.equal(lstat.mock.callCount(), 0);
      assert.equal(getCursorSnapshotStorageAvailability().available, false);
      assert.equal(
        getCursorSnapshotStorageAvailability().reason,
        "windows-reader-disabled",
      );
      await assert.rejects(createCursorSnapshotDirectory());
      assert.equal(mkdir.mock.callCount(), 0);
      assert.equal(spawned, 0);
    },
  );
