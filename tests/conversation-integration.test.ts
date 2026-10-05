import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AgentVacEngine } from "../electron/engine.js";
import { getAdapter } from "../electron/providers/index.js";
import { ConversationServices } from "../electron/conversations/service.js";
import { conversationReaders } from "../electron/conversations/index.js";
import { initializeCursorSnapshotStorage } from "../electron/conversations/cursor-temp.js";
import type { ProviderId } from "../shared/types.js";
const SID = "550e8400-e29b-41d4-a716-446655440000";
const SID2 = "550e8400-e29b-41d4-a716-446655440001";
const created = "2026-06-01T00:00:00.000Z",
  updated = "2026-06-01T00:01:00.000Z";
const BODY =
  "synthetic ordinary dialogue " +
  "x".repeat(70000) +
  " LATE_INTEGRATION_KEYWORD";
async function setup(t: TestContext, provider: ProviderId) {
  const base = await fs.mkdtemp(
    path.join(
      await fs.realpath(os.tmpdir()),
      "agentvac-conversation-integration-",
    ),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(
    base,
    provider === "cursor"
      ? "Cursor"
      : provider === "cline"
        ? "data"
        : "." + provider,
  );
  await fs.mkdir(root);
  const originals = new Map<string, Buffer>();
  const put = async (rel: string, body: string, age = 90) => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    const stamp = new Date(Date.now() - age * 86400000);
    await fs.utimes(file, stamp, stamp);
    originals.set(rel, Buffer.from(body));
    return file;
  };
  let anchor = "";
  if (provider === "codex") {
    anchor = `sessions/2026/06/01/rollout-2026-06-01T00-00-00-${SID}.jsonl`;
    await put(
      anchor,
      [
        {
          type: "session_meta",
          timestamp: created,
          payload: {
            id: SID,
            timestamp: created,
            cwd: "/synthetic/project",
            source: "cli",
            cli_version: "0.1.0",
          },
        },
        {
          type: "response_item",
          timestamp: updated,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: BODY }],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await put(
      "session_index.jsonl",
      JSON.stringify({
        id: SID,
        thread_name: "Integration title",
        updated_at: updated,
      }) + "\n",
    );
  }
  if (provider === "claude-code") {
    anchor = `projects/-synthetic-project/${SID}.jsonl`;
    const rows = (id: string, body: string) =>
      [
        {
          type: "user",
          uuid: "user-" + id,
          parentUuid: null,
          sessionId: id,
          cwd: "/synthetic/project",
          timestamp: created,
          message: { role: "user", content: body },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    await put("history.jsonl", "opaque global history\n");
    await put(anchor, rows(SID, BODY));
    await put(
      `projects/-synthetic-project/${SID2}.jsonl`,
      rows(SID2, "latest protected"),
      1,
    );
    await put(
      `projects/-synthetic-project/${SID}/tool-results/toolu_1.txt`,
      "opaque complete tool result",
    );
    for (const rel of [
      `projects/-synthetic-project/${SID}/tool-results`,
      `projects/-synthetic-project/${SID}`,
    ])
      await fs.utimes(
        path.join(root, rel),
        new Date("2026-01-01"),
        new Date("2026-01-01"),
      );
  }
  if (provider === "cline") {
    const id = "1740000000000_abc12";
    anchor = `sessions/${id}/${id}.messages.json`;
    await put("globalState.json", "{}");
    await put("db/sessions.db", "opaque canonical marker");
    await put(
      `sessions/${id}/${id}.json`,
      JSON.stringify({
        version: 1,
        session_id: id,
        source: "cli",
        pid: 0,
        started_at: created,
        ended_at: updated,
        status: "completed",
        interactive: false,
        provider: "synthetic",
        model: "fixture",
        cwd: "/synthetic",
        workspace_root: "/synthetic/project",
        enable_tools: true,
        enable_spawn: false,
        enable_teams: false,
        messages_path: path.join(root, anchor),
        metadata: { title: "Integration title" },
      }),
    );
    await put(
      anchor,
      JSON.stringify({
        version: 1,
        updated_at: updated,
        agent: "lead",
        sessionId: id,
        messages: [
          {
            id: "message-1",
            role: "user",
            content: [{ type: "text", text: BODY }],
          },
        ],
      }),
    );
  }
  if (provider === "cursor") {
    await initializeCursorSnapshotStorage(path.join(base, "private-snapshots"));
    await fs.mkdir(path.join(root, "logs"));
    await fs.mkdir(path.join(root, "User/globalStorage"), { recursive: true });
    anchor = "User/globalStorage/state.vscdb";
    const db = new DatabaseSync(path.join(root, anchor));
    db.exec(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB); CREATE TABLE ItemTable (key TEXT,value BLOB)",
    );
    db.prepare("INSERT INTO ItemTable VALUES (?,?)").run(
      "private-auth-fixture",
      "NEVER-AUTH-DISPLAY",
    );
    const putDb = (k: string, v: unknown) =>
      db
        .prepare("INSERT INTO cursorDiskKV VALUES (?,?)")
        .run(k, JSON.stringify(v));
    putDb("composerData:conversation-1", {
      composerId: "conversation-1",
      name: "Integration title",
      createdAt: Date.parse(created),
      lastUpdatedAt: Date.parse(updated),
      fullConversationHeadersOnly: [{ bubbleId: "message-1" }],
    });
    putDb("bubbleId:conversation-1:message-1", {
      bubbleId: "message-1",
      type: 1,
      createdAt: created,
      text: BODY,
    });
    db.close();
    originals.set(anchor, await fs.readFile(path.join(root, anchor)));
  }
  const key = randomBytes(32);
  const makeEngine = async () => {
    const engine = new AgentVacEngine(
      root,
      key,
      false,
      async () => ({
        status: "clear",
        details: "Synthetic fixture-only process guard",
      }),
      [],
      getAdapter(provider),
    );
    await engine.initialize();
    return engine;
  };
  const engine = await makeEngine();
  const service = new ConversationServices({
    engine: () => engine,
    context: () => ({
      provider,
      root,
      demo: false,
      platform: process.platform,
    }),
    readers: conversationReaders,
  });
  return { root, base, anchor, engine, service, makeEngine, originals, put };
}
for (const provider of ["codex", "claude-code", "cline", "cursor"] as const)
  test(`${provider} real reader/service: consent, actual timestamps, full late-content search and source-byte preservation`, async (t) => {
    const f = await setup(t, provider);
    await assert.rejects(
      f.service.list({ requestId: randomUUID() }),
      /明确允许/,
    );
    await f.service.setAccess(true);
    const list = await f.service.list({
      requestId: randomUUID(),
      keyword: "LATE_INTEGRATION_KEYWORD",
      from: "2026-06-01T00:00:00Z",
      to: "2026-06-02T00:00:00Z",
    });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].createdAt, created);
    assert.ok(!JSON.stringify(list).includes("NEVER-AUTH-DISPLAY"));
    let cursor: string | undefined;
    let actual = "";
    let pages = 0;
    do {
      const page = await f.service.read({
        requestId: randomUUID(),
        conversationId: list.items[0].id,
        cursor,
        limit: 1,
      });
      actual += page.messages
        .flatMap((m) =>
          m.parts.filter((p) => p.type === "text").map((p) => p.text),
        )
        .join("");
      cursor = page.nextCursor ?? undefined;
      assert.ok(++pages < 20);
    } while (cursor);
    assert.equal(actual, BODY);
    for (const [rel, bytes] of f.originals)
      assert.deepEqual(await fs.readFile(path.join(f.root, rel)), bytes);
    await f.service.setAccess(false);
    await assert.rejects(
      f.service.read({
        requestId: randomUUID(),
        conversationId: list.items[0].id,
      }),
    );
  });
test("Claude real conversation preview, complete bundle quarantine, restart and exact restore", async (t) => {
  const f = await setup(t, "claude-code");
  await f.service.setAccess(true);
  const list = await f.service.list({
    requestId: randomUUID(),
    keyword: "LATE_INTEGRATION_KEYWORD",
  });
  assert.equal(list.items[0].canArchive, true);
  const preview = await f.service.previewArchive([list.items[0].id]);
  assert.equal(preview.preview.items.length, 1);
  assert.equal(preview.preview.items[0].cleanupUnit?.fileCount, 2);
  const result = await f.service.quarantine(preview.preview.token, true);
  assert.equal(result.completed, 1);
  assert.equal(result.failed.length, 0);
  await assert.rejects(fs.lstat(path.join(f.root, f.anchor)), {
    code: "ENOENT",
  });
  const restart = await f.makeEngine();
  const history = await restart.history();
  assert.equal(history[0].provider, "claude-code");
  assert.equal((await restart.restore(result.batchId, true)).completed, 1);
  for (const [rel, bytes] of f.originals)
    assert.deepEqual(await fs.readFile(path.join(f.root, rel)), bytes);
  await assert.rejects(f.service.quarantine(preview.preview.token, true));
});
test("Claude changed source between list and preview is rejected before any move", async (t) => {
  const f = await setup(t, "claude-code");
  await f.service.setAccess(true);
  const list = await f.service.list({
    requestId: randomUUID(),
    keyword: "LATE_INTEGRATION_KEYWORD",
  });
  await fs.appendFile(path.join(f.root, f.anchor), "{}\n");
  await assert.rejects(f.service.previewArchive([list.items[0].id]), /安全/);
  assert.ok(
    (await fs.readFile(path.join(f.root, f.anchor), "utf8")).endsWith("{}\n"),
  );
  assert.equal((await f.engine.history()).length, 0);
});
test("Claude revoked content preview cannot block ordinary file recovery", async (t) => {
  const f = await setup(t, "claude-code");
  await f.service.setAccess(true);
  const list = await f.service.list({
    requestId: randomUUID(),
    keyword: "LATE_INTEGRATION_KEYWORD",
  });
  const preview = await f.service.previewArchive([list.items[0].id]);
  await f.service.setAccess(false);
  await assert.rejects(f.service.quarantine(preview.preview.token, true));
  const scan = await f.engine.scan({ minAgeDays: 30, includeSessions: true });
  const row = scan.entries.find((i) => i.path === f.anchor)!;
  const normal = await f.engine.preview([row.id]);
  const done = await f.engine.quarantine(normal.token, true);
  assert.equal(done.completed, 1);
  assert.equal((await f.engine.restore(done.batchId, true)).completed, 1);
});
