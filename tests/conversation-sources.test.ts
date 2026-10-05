import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { prepareReadOnlyConversationSource } from "../electron/conversations/sources.js";
import { ConversationServices } from "../electron/conversations/service.js";
import { conversationReaders } from "../electron/conversations/index.js";
import type { AppContext } from "../shared/types.js";
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-read-source-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
test("explicit Cursor transcript root works without any cleanup root and bypasses only SQLite snapshot gate", async (t) => {
  const base = await fixture(t);
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  const raw =
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "actual exported body" }] },
    }) + "\n";
  await fs.writeFile(path.join(root, "session-1.jsonl"), raw);
  let context: AppContext = {
    provider: "cursor",
    root: null,
    demo: false,
    platform: process.platform,
  };
  const service = new ConversationServices({
    engine: () => {
      throw Error("no cleanup root");
    },
    context: () => context,
    readers: conversationReaders,
    readerAvailability: () => "SQLite gate unavailable",
  });
  assert.equal(service.getAccess().root, null);
  const source = await prepareReadOnlyConversationSource(
    "cursor-transcripts",
    root,
  );
  const selected = await service.useReadOnlySource(source);
  assert.equal(selected.root, root);
  assert.equal(selected.allowed, false);
  assert.equal(selected.readOnlySource, true);
  assert.equal(selected.unavailableReason, undefined);
  await assert.rejects(service.list({ requestId: randomUUID() }), /允许/);
  await service.setAccess(true);
  const list = await service.list({ requestId: randomUUID() });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].createdAt, null);
  assert.equal(list.items[0].canArchive, false);
  assert.equal(
    (
      await service.read({
        requestId: randomUUID(),
        conversationId: list.items[0].id,
      })
    ).messages[0].parts[0].text,
    "actual exported body",
  );
  await assert.rejects(service.previewArchive([list.items[0].id]), /完整归档/);
  assert.equal(
    await fs.readFile(path.join(root, "session-1.jsonl"), "utf8"),
    raw,
  );
  context = { ...context, provider: "cline" };
  assert.equal(service.getAccess().allowed, false);
  assert.equal(service.getAccess().root, null);
  await assert.rejects(
    service.read({ requestId: randomUUID(), conversationId: list.items[0].id }),
  );
});
test("source preparation inspects only metadata; consent controls actual transcript reads", async (t) => {
  const base = await fixture(t);
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "session-1.jsonl"),
    "SYNTHETIC private unread body",
  );
  const original = fs.readFile;
  let reads = 0;
  fs.readFile = (async (...args: any[]) => {
    reads++;
    return (original as any)(...args);
  }) as typeof fs.readFile;
  try {
    await prepareReadOnlyConversationSource("cursor-transcripts", root);
    assert.equal(reads, 0);
  } finally {
    fs.readFile = original;
  }
});
test("read-only root pin rejects replacement and never follows a linked root", async (t) => {
  const base = await fixture(t);
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  const source = await prepareReadOnlyConversationSource(
    "cursor-transcripts",
    root,
  );
  await fs.rename(root, root + "-original");
  await fs.mkdir(root);
  await assert.rejects(source.verify(), /身份/);
  await fs.rmdir(root);
  await fs.symlink(root + "-original", root, "dir");
  await assert.rejects(
    prepareReadOnlyConversationSource("cursor-transcripts", root),
    /受支持/,
  );
});
test("wrong provider and unrelated directories cannot become alternate sources", async (t) => {
  const base = await fixture(t);
  await assert.rejects(
    prepareReadOnlyConversationSource("cursor-transcripts", base),
    /受支持/,
  );
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  const source = await prepareReadOnlyConversationSource(
    "cursor-transcripts",
    root,
  );
  const service = new ConversationServices({
    engine: () => {
      throw Error("none");
    },
    context: () => ({
      provider: "cline",
      root: null,
      demo: false,
      platform: process.platform,
    }),
    readers: conversationReaders,
  });
  await assert.rejects(service.useReadOnlySource(source), /改变/);
});
test("resetting an alternate source revokes IDs and does not create a cleaner root", async (t) => {
  const base = await fixture(t);
  const root = path.join(base, "agent-transcripts");
  await fs.mkdir(root);
  const service = new ConversationServices({
    engine: () => {
      throw Error("none");
    },
    context: () => ({
      provider: "cursor",
      root: null,
      demo: false,
      platform: process.platform,
    }),
    readers: conversationReaders,
  });
  await service.useReadOnlySource(
    await prepareReadOnlyConversationSource("cursor-transcripts", root),
  );
  await service.setAccess(true);
  const before = service.getAccess();
  const after = await service.resetSource();
  assert.equal(after.allowed, false);
  assert.equal(after.root, null);
  assert.equal(after.sourceKind, "selected");
  assert.notEqual(after.revision, before.revision);
});
test("Cline file-index SDK data is readable without extension settings or cleaner validation", async (t) => {
  const base = await fixture(t);
  const root = path.join(base, "sdk-data"),
    id = "1740000000000_abc12";
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(root, "sessions", "sessions.index.json"),
    '{"version":1,"sessions":{}}',
  );
  await fs.writeFile(
    path.join(dir, id + ".json"),
    JSON.stringify({
      version: 1,
      session_id: id,
      source: "cli",
      pid: 0,
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T01:00:00Z",
      status: "completed",
      interactive: false,
      provider: "fixture",
      model: "fixture",
      cwd: "/synthetic",
      workspace_root: "/synthetic",
      enable_tools: true,
      enable_spawn: false,
      enable_teams: false,
      messages_path: path.join(dir, id + ".messages.json"),
      metadata: { title: "Standalone SDK" },
    }),
  );
  const body = JSON.stringify({
    version: 1,
    updated_at: "2026-01-01T01:00:00Z",
    agent: "lead",
    sessionId: id,
    messages: [
      { role: "user", content: [{ type: "text", text: "SDK-only body" }] },
    ],
  });
  await fs.writeFile(path.join(dir, id + ".messages.json"), body);
  const service = new ConversationServices({
    engine: () => {
      throw Error("no file cleanup root");
    },
    context: () => ({
      provider: "cline",
      root: null,
      demo: false,
      platform: process.platform,
    }),
    readers: conversationReaders,
  });
  await service.useReadOnlySource(
    await prepareReadOnlyConversationSource("cline-sdk", root),
  );
  await service.setAccess(true);
  const list = await service.list({
    requestId: randomUUID(),
    keyword: "SDK-only",
  });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].canArchive, false);
  assert.equal(list.items[0].title, "Standalone SDK");
  assert.equal(
    await fs.readFile(path.join(dir, id + ".messages.json"), "utf8"),
    body,
  );
});
