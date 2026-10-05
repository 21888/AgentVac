import { test } from "node:test";
import assert from "node:assert/strict";
import { format, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isTrustedRendererEvent,
  rendererFileUrl,
} from "../electron/renderer-origin.js";

const expected =
  "file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/nsi123.tmp/app/resources/app.asar/dist/index.html";
function fixture(url = expected) {
  const mainFrame = { url };
  const contents = { mainFrame };
  return { contents, event: { sender: contents, senderFrame: mainFrame } };
}

test("shipped Node reproduces legacy tilde formatting mismatch on Windows paths", () => {
  const file =
    "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nsi123.tmp\\app\\resources\\app.asar\\dist\\index.html";
  const canonical = pathToFileURL(file, { windows: true }).href;
  const legacy = format({ protocol: "file", slashes: true, pathname: file });
  assert.equal(canonical, expected);
  assert.ok(legacy.includes("RUNNER~1"));
  assert.ok(!legacy.includes("RUNNER%7E1"));
  const trusted = fixture(canonical);
  assert.equal(
    isTrustedRendererEvent(trusted.event, trusted.contents, canonical),
    true,
  );
  trusted.event.senderFrame.url = canonical.replace("%7E", "~");
  assert.equal(
    isTrustedRendererEvent(trusted.event, trusted.contents, canonical),
    false,
  );
});

test("one generated URL preserves exact special-character path spelling", () => {
  for (const component of [
    "RUNNER~1",
    "has space",
    "percent%",
    "hash#",
    "query?",
    "unicode-数据",
  ])
    assert.equal(
      rendererFileUrl(
        path.resolve(component, "resources/app.asar/dist/index.html"),
      ),
      pathToFileURL(
        path.resolve(component, "resources/app.asar/dist/index.html"),
      ).href,
    );
});

test("only the expected window and its exact main frame can invoke", () => {
  const { contents, event } = fixture();
  assert.equal(isTrustedRendererEvent(event, contents, expected), true);
  assert.equal(
    isTrustedRendererEvent(
      { ...event, sender: { mainFrame: event.senderFrame } },
      contents,
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedRendererEvent(
      { ...event, senderFrame: { url: expected } },
      contents,
      expected,
    ),
    false,
  );
  assert.equal(
    isTrustedRendererEvent({ ...event, senderFrame: null }, contents, expected),
    false,
  );
});

test("sibling and alternate files remain outside the production allowlist", () => {
  for (const url of [
    expected + ".bak",
    expected.replace("index.html", "other.html"),
    expected.replace("/dist/", "/other/"),
    expected.replace("RUNNER%7E1", "another-user"),
    expected.toLowerCase(),
    expected.replace("/C:/", "/D:/"),
  ]) {
    const { contents, event } = fixture(url);
    assert.equal(isTrustedRendererEvent(event, contents, expected), false, url);
  }
});

test("queries, fragments, credentials and other schemes cannot borrow trust", () => {
  for (const url of [
    expected + "?x=1",
    expected + "#section",
    expected + "#",
    expected.replace("file:///", "file://host/"),
    expected.replace("file:///", "file://user:pass@host/"),
    "https://example.com/index.html",
    "http://127.0.0.1:5173/",
    "data:text/html,test",
    "about:blank",
  ]) {
    const { contents, event } = fixture(url);
    assert.equal(isTrustedRendererEvent(event, contents, expected), false, url);
  }
});

test("encoded separators, traversal, escape aliases and NUL are rejected", () => {
  for (const url of [
    expected.replace("/dist/", "/dist%2F"),
    expected.replace("/dist/", "/dist%2f"),
    expected.replace("/dist/", "/dist%5C"),
    expected.replace("/dist/", "/other/%2E%2E/dist/"),
    expected.replace("index.html", "%69ndex.html"),
    expected.replace("%7E", "%257E"),
    expected + "%00",
    expected + "\0",
  ]) {
    const { contents, event } = fixture(url);
    assert.equal(isTrustedRendererEvent(event, contents, expected), false, url);
  }
});

test("explicit local development origin still requires sender and main-frame identity", () => {
  const dev = "http://127.0.0.1:5173";
  const { contents, event } = fixture(dev + "/screen");
  assert.equal(isTrustedRendererEvent(event, contents, expected, dev), true);
  assert.equal(
    isTrustedRendererEvent({ ...event, sender: {} }, contents, expected, dev),
    false,
  );
  for (const url of [
    "http://127.0.0.1:5174/",
    "http://localhost:5173/",
    "https://127.0.0.1:5173/",
    "not-a-url",
  ]) {
    event.senderFrame.url = url;
    assert.equal(isTrustedRendererEvent(event, contents, expected, dev), false);
  }
});

test("production launch and IPC use the same URL with no loadFile serializer", async () => {
  const source = await fs.readFile(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /isTrustedRendererEvent\(\s*event,\s*window\.webContents,\s*localRendererUrl,\s*devUrl,?\s*\)/,
  );
  assert.match(source, /await window\.loadURL\(localRendererUrl\)/);
  assert.doesNotMatch(source, /window\.loadFile\(/);
});
