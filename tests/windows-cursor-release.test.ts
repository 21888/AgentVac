import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import {
  initializeCursorSnapshotStorage,
  createCursorSnapshotDirectory,
  getCursorSnapshotStorageAvailability,
} from "../electron/conversations/cursor-temp.js";
import { openCursorSnapshot } from "../electron/conversations/cursor-snapshot.js";
import { cursorTranscriptReader } from "../electron/conversations/cursor.js";

function windowsMode(t: { after(fn: () => void): void }) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

test("0.2 Windows database release gate refuses before filesystem or helper access", async (t) => {
  windowsMode(t);
  let touched = 0;
  const refuse = () => {
    touched++;
    throw Error("UNEXPECTED_ACCESS");
  };
  for (const name of [
    "lstat",
    "open",
    "mkdir",
    "writeFile",
    "opendir",
  ] as const)
    t.mock.method(fs, name, refuse);
  const native = t.mock.method(childProcess, "spawn", refuse);
  syncBuiltinESMExports();
  t.after(() => {
    native.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(getCursorSnapshotStorageAvailability(), {
    available: false,
    reason: "windows-reader-disabled",
  });
  await assert.rejects(
    initializeCursorSnapshotStorage("C:\\Generated\\private-copy"),
    /CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE/,
  );
  await assert.rejects(
    createCursorSnapshotDirectory(),
    /CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE/,
  );
  await assert.rejects(
    openCursorSnapshot(
      "C:\\Generated\\Cursor",
      "User/globalStorage/state.vscdb",
      undefined,
    ),
    /CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE/,
  );
  assert.deepEqual(getCursorSnapshotStorageAvailability(), {
    available: false,
    reason: "windows-reader-disabled",
  });
  assert.equal(touched, 0);
});

test("explicit generated Cursor transcript remains readable with Windows database gate disabled", async (t) => {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-release-transcript-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  const content =
    [
      {
        role: "user",
        message: {
          content: [{ type: "text", text: "Generated transcript question" }],
        },
      },
      {
        role: "assistant",
        message: {
          content: [{ type: "text", text: "Generated transcript reply" }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  const file = path.join(root, "session-release.jsonl");
  await fs.writeFile(file, content);
  windowsMode(t);
  assert.equal(getCursorSnapshotStorageAvailability().available, false);
  const descriptors = [];
  for await (const item of cursorTranscriptReader.enumerate({ root }))
    descriptors.push(item);
  assert.equal(descriptors.length, 1);
  const page = await cursorTranscriptReader.read({ root }, descriptors[0], {
    limit: 10,
  });
  assert.equal(
    page.messages.map((m) => m.parts.map((p) => p.text).join(" ")).join(" "),
    "Generated transcript question Generated transcript reply",
  );
  assert.equal(page.nextCursor, null);
  assert.equal(await fs.readFile(file, "utf8"), content);
  assert.equal((await fs.readdir(base)).join(","), "agent-transcripts");
});
