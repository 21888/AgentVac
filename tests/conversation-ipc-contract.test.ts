import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
const main = new URL("../electron/main.ts", import.meta.url),
  preload = new URL("../electron/preload.ts", import.meta.url);
test("every explicitly exported preload invocation has a production trusted-origin IPC handler", async () => {
  const [a, b] = await Promise.all([
    fs.readFile(main, "utf8"),
    fs.readFile(preload, "utf8"),
  ]);
  const handlers = new Set(
    [...a.matchAll(/register\(\s*"([a-z-]+)"/g)].map((m) => m[1]),
  );
  const methods = [
    ...b.matchAll(/ipcRenderer\.invoke\(\s*"agentvac:([a-z-]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    methods.filter((name) => !handlers.has(name)),
    [],
  );
  assert.ok(methods.includes("choose-conversation-source"));
  assert.ok(methods.includes("reset-conversation-source"));
  assert.match(a, /isTrustedRendererEvent/);
});
