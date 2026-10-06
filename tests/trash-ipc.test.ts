import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isTrustedRendererEvent } from "../electron/renderer-origin.js";
const compile = (text: string) =>
  ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

test("production preload forwards closure and token exactly, including malformed omissions", async () => {
  const source = await fs.readFile(
    new URL("../electron/preload.ts", import.meta.url),
    "utf8",
  );
  const calls: unknown[][] = [];
  let api: any;
  runInNewContext(compile(source), {
    exports: {},
    require: (name: string) => {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => {
            assert.equal(key, "agentvac");
            api = value;
          },
        },
        ipcRenderer: {
          invoke: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve();
          },
        },
      };
    },
  });
  await api.prepareTrash("batch");
  await api.cancelTrashConfirmation("cancelled-token");
  for (const closed of [undefined, false, "true", true])
    await api.trash("batch", true, closed, "supplied-token");
  assert.deepEqual(calls, [
    ["agentvac:prepare-trash", "batch"],
    ["agentvac:cancel-trash-confirmation", "cancelled-token"],
    ...[undefined, false, "true", true].map((v) => [
      "agentvac:trash",
      "batch",
      true,
      v,
      "supplied-token",
    ]),
  ]);
});
test("production IPC guard still rejects foreign senders and stale/busy requests before handlers", async () => {
  const source = await fs.readFile(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function register("),
    end = source.indexOf("function selected()", start);
  assert.ok(start > 0 && end > start);
  const registered = new Map<string, Function>();
  const url = "file:///generated-fixture/dist/index.html",
    frame = { url },
    contents = { mainFrame: frame };
  let discards = 0,
    drains = 0,
    calls = 0,
    failDrain = false;
  const engine = {
    discardTrashConfirmation: () => {
      discards++;
    },
  };
  const runtime = runInNewContext(
    compile(`
    let operation = false, operationName = '', quitting = false;
    ${source.slice(start, end)}
    function selected() { return engine; }
    exports.api = {register, setBusy(value) { operation = value; }, setQuitting(value) { quitting = value; }};
  `),
    {
      exports: {},
      engine,
      Error,
      window: { webContents: contents },
      localRendererUrl: url,
      devUrl: undefined,
      isTrustedRendererEvent,
      conversations: {
        cancelAndDrain: async () => {
          drains++;
          if (failDrain) throw new Error("synthetic drain failure");
        },
      },
      ipcMain: {
        handle: (name: string, handler: Function) =>
          registered.set(name, handler),
      },
    },
  );
  runtime.register("trash", async (...args: unknown[]) => {
    calls++;
    return args;
  });
  const invoke = registered.get("agentvac:trash")!;
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url } },
    { sender: contents, senderFrame: { url: "https://example.invalid" } },
  ])
    await assert.rejects(invoke(event, "batch", true, true, "token"), /不可信/);
  assert.equal(calls, 0);
  assert.equal(discards, 0);
  assert.equal(drains, 0);
  const event = { sender: contents, senderFrame: frame };
  runtime.setBusy(true);
  await assert.rejects(invoke(event, "batch", true, true, "token"), /等待/);
  assert.equal(discards, 1);
  assert.equal(calls, 0);
  runtime.setBusy(false);
  const result = await invoke(event, "batch", true, false, "fresh-token");
  assert.deepEqual([...result], ["batch", true, false, "fresh-token"]);
  assert.equal(calls, 1);
  assert.equal(drains, 1);
  failDrain = true;
  await assert.rejects(
    invoke(event, "batch", true, true, "stale-after-drain"),
    /synthetic drain failure/,
  );
  assert.equal(discards, 2);
  assert.equal(calls, 1);
  failDrain = false;
  runtime.setQuitting(true);
  await assert.rejects(invoke(event, "batch", true, true, "token"), /退出/);
  assert.equal(calls, 1);
});
