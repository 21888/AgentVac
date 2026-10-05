import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClineArrayPage } from "../electron/conversations/cline-json-stream.js";
const id = "1740000000000_abc12";
const msg = (text: string) => ({
  id: "synthetic",
  role: "user",
  content: [{ type: "text", text }],
});
const envelope = (messages: unknown[]) => ({
  version: 1,
  updated_at: "2026-01-01T00:00:00Z",
  agent: "lead",
  sessionId: id,
  messages,
});
async function fixture(
  body: string,
  run: (f: Awaited<ReturnType<typeof fs.open>>) => Promise<void>,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentvac-cline-stream-"),
  );
  const p = path.join(dir, "synthetic.json");
  await fs.writeFile(p, body);
  const f = await fs.open(p, "r");
  try {
    await run(f);
  } finally {
    await f.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const read = (f: Awaited<ReturnType<typeof fs.open>>, extra = {}) =>
  readClineArrayPage(f, { format: "sdk-v1", sessionId: id, ...extra });
test("SDK v1 preserves user and tool-result data", async () =>
  fixture(
    JSON.stringify(
      envelope([
        msg("你好 🙂"),
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "fixture" },
          ],
        },
      ]),
    ),
    async (f) => {
      const r = await read(f);
      assert.equal(r.complete, true);
      assert.deepEqual(
        r.values,
        envelope([
          msg("你好 🙂"),
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "x", content: "fixture" },
            ],
          },
        ]).messages,
      );
    },
  ));
test("byte bookmarks page without duplicating messages", async () =>
  fixture(
    JSON.stringify(
      envelope(Array.from({ length: 205 }, (_, i) => msg("item " + i))),
    ),
    async (f) => {
      let cursor;
      const seen = [];
      do {
        const r = await read(f, { cursor, limit: 7 });
        seen.push(...r.values);
        cursor = r.next;
      } while (cursor);
      assert.equal(seen.length, 205);
      assert.deepEqual(seen[204], msg("item 204"));
    },
  ));
test("legacy API array requires explicit legacy reader mode", async () =>
  fixture(JSON.stringify([msg("legacy")]), async (f) => {
    await assert.rejects(read(f), /CLINE_INVALID_JSON/);
    const r = await readClineArrayPage(f, { format: "legacy-api" });
    assert.deepEqual(r.values, [msg("legacy")]);
  }));
test("empty SDK arrays are complete", async () =>
  fixture(JSON.stringify(envelope([])), async (f) =>
    assert.equal((await read(f)).complete, true),
  ));
test("future schema rejected", async () =>
  fixture(JSON.stringify({ ...envelope([]), version: 2 }), async (f) => {
    await assert.rejects(read(f), /CLINE_UNSUPPORTED_FORMAT/);
  }));
test("wrong session ID rejected", async () =>
  fixture(
    JSON.stringify({ ...envelope([]), sessionId: "other" }),
    async (f) => {
      await assert.rejects(read(f), /CLINE_UNSUPPORTED_FORMAT/);
    },
  ));
test("missing role envelope rejected", async () =>
  fixture(JSON.stringify({ ...envelope([]), agent: undefined }), async (f) => {
    await assert.rejects(read(f), /CLINE_UNSUPPORTED_FORMAT/);
  }));
test("duplicate envelope keys rejected", async () =>
  fixture(
    '{"version":1,"version":1,"agent":"lead","sessionId":"' +
      id +
      '","messages":[]}',
    async (f) => {
      await assert.rejects(read(f), /CLINE_INVALID_JSON/);
    },
  ));
test("version after messages rejected rather than assumed", async () =>
  fixture(
    JSON.stringify({ messages: [], version: 1, agent: "lead", sessionId: id }),
    async (f) => {
      await assert.rejects(read(f), /CLINE_UNSUPPORTED_FORMAT/);
    },
  ));
test("unknown additive envelope fields tolerated", async () =>
  fixture(
    JSON.stringify({
      ...envelope([msg("text")]),
      future_addition: { nested: true },
      system_prompt: "synthetic prompt",
    }),
    async (f) => {
      assert.equal((await read(f)).values.length, 1);
    },
  ));
test("quoted braces and escaped strings do not break framing", async () =>
  fixture(
    JSON.stringify(envelope([msg('}\\\"\n[ 🙃 \\ /'), msg("next")])),
    async (f) => {
      assert.equal((await read(f)).values.length, 2);
    },
  ));
test("UTF-8 boundary across 64 KiB chunk preserves bytes", async () =>
  fixture(JSON.stringify(envelope([msg("中".repeat(40000))])), async (f) => {
    assert.deepEqual((await read(f)).values, [msg("中".repeat(40000))]);
  }));
test("oversized message stops without unbounded allocation", async () =>
  fixture(JSON.stringify(envelope([msg("x".repeat(100000))])), async (f) => {
    await assert.rejects(read(f, { maxValueBytes: 1000 }), /CLINE_READ_LIMIT/);
  }));
test("deep nesting rejected", async () =>
  fixture(
    JSON.stringify(
      envelope([JSON.parse("[".repeat(65) + "0" + "]".repeat(65))]),
    ),
    async (f) => {
      await assert.rejects(read(f), /CLINE_READ_LIMIT/);
    },
  ));
test("already cancelled read opens no stream work", async () =>
  fixture(JSON.stringify(envelope([msg("x")])), async (f) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      read(f, { signal: controller.signal }),
      /CLINE_CANCELLED/,
    );
  }));
for (const [name, body] of [
  ["trailing comma", "[{},]"],
  ["mismatched nesting", "[{]"],
  ["trailing garbage", "[]x"],
  ["unterminated string", '["abc'],
  ["bad primitive", "[undefined]"],
])
  test("malformed JSON: " + name, async () =>
    fixture(body, async (f) => {
      await assert.rejects(
        readClineArrayPage(f, { format: "legacy-api" }),
        /CLINE_INVALID_JSON/,
      );
    }),
  );
test("invalid UTF-8 rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-cline-utf8-"));
  const p = path.join(dir, "bad.json");
  await fs.writeFile(p, Buffer.from([91, 34, 255, 34, 93]));
  const f = await fs.open(p, "r");
  try {
    await assert.rejects(
      readClineArrayPage(f, { format: "legacy-api" }),
      /CLINE_INVALID_JSON/,
    );
  } finally {
    await f.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("page read budget enforced", async () =>
  fixture(JSON.stringify(envelope([msg("x".repeat(200000))])), async (f) => {
    await assert.rejects(read(f, { maxReadBytes: 4096 }), /CLINE_READ_LIMIT/);
  }));
test("SDK array-coercible agent is rejected", async () =>
  fixture(JSON.stringify({ ...envelope([]), agent: ["lead"] }), async (f) => {
    await assert.rejects(read(f), /CLINE_UNSUPPORTED_FORMAT/);
  }));

import {
  clineConversationReader,
  parseClineManifest,
  projectClineMessage,
} from "../electron/conversations/cline.js";
import type { ConversationDescriptor } from "../electron/conversations/types.js";
const manifest = {
  version: 1,
  session_id: id,
  source: "cli",
  pid: 0,
  started_at: "2025-02-01T00:00:00.000Z",
  ended_at: "2025-02-02T00:00:00.000Z",
  status: "completed",
  interactive: false,
  provider: "synthetic",
  model: "fixture",
  cwd: "/synthetic",
  workspace_root: "/synthetic/project",
  enable_tools: true,
  enable_spawn: false,
  enable_teams: false,
  metadata: { title: "Synthetic project conversation" },
};
async function sdkFixture(
  run: (root: string, dir: string) => Promise<void>,
  messages: unknown[] = [msg("synthetic user")],
) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-cline-reader-"),
  );
  const root = path.join(base, "data");
  const dir = path.join(root, "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, "db"));
  await fs.writeFile(path.join(root, "db", "sessions.db"), "synthetic marker");
  await fs.writeFile(path.join(root, "globalState.json"), "{}");
  await fs.writeFile(
    path.join(dir, id + ".json"),
    JSON.stringify({
      ...manifest,
      messages_path: path.join(dir, id + ".messages.json"),
    }),
  );
  await fs.writeFile(
    path.join(dir, id + ".messages.json"),
    JSON.stringify(envelope(messages)),
  );
  try {
    await run(root, dir);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}
async function list(root: string, warnings: string[] = []) {
  const result: ConversationDescriptor[] = [];
  for await (const item of clineConversationReader.enumerate({
    root,
    warn: (w) => warnings.push(w),
  }))
    result.push(item);
  return result;
}
test("SDK reader lists actual title/project/times without mtime substitution", async () =>
  sdkFixture(async (root, dir) => {
    await fs.utimes(
      path.join(dir, id + ".messages.json"),
      new Date("2020-01-01"),
      new Date("2020-01-01"),
    );
    const [item] = await list(root);
    assert.equal(item.summary.title, manifest.metadata.title);
    assert.equal(item.summary.project, manifest.workspace_root);
    assert.equal(item.summary.createdAt, manifest.started_at);
    assert.equal(item.summary.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(item.summary.identityVerified, true);
    const p = await clineConversationReader.read({ root }, item, { limit: 50 });
    assert.equal(p.messages[0].parts[0].text, "synthetic user");
    assert.equal(p.nextCursor, null);
  }));
test("SDK reader refreshes titles and rejects stale descriptor after source change", async () =>
  sdkFixture(async (root, dir) => {
    const [old] = await list(root);
    await fs.writeFile(
      path.join(dir, id + ".json"),
      JSON.stringify({ ...manifest, metadata: { title: "Refreshed title" } }),
    );
    await assert.rejects(
      clineConversationReader.read({ root }, old, { limit: 50 }),
      /changed/,
    );
    const [fresh] = await list(root);
    assert.equal(fresh.summary.title, "Refreshed title");
  }));
test("SDK reader pages canonical conversation with no duplicated API/UI copies", async () =>
  sdkFixture(
    async (root) => {
      const [item] = await list(root);
      const a = await clineConversationReader.read({ root }, item, {
        limit: 2,
      });
      const b = await clineConversationReader.read({ root }, item, {
        limit: 2,
        cursor: a.nextCursor,
      });
      assert.equal(a.messages.length, 2);
      assert.equal(b.messages.length, 1);
      assert.equal(b.nextCursor, null);
    },
    [msg("one"), msg("two"), msg("three")],
  ));
test("SDK external messages path is protected", async () =>
  sdkFixture(async (root, dir) => {
    await fs.writeFile(
      path.join(dir, id + ".json"),
      JSON.stringify({ ...manifest, messages_path: "/outside/private.json" }),
    );
    const warnings: string[] = [];
    assert.equal((await list(root, warnings)).length, 0);
    assert.ok(warnings.length);
  }));
test("SDK malformed and future manifest versions fail closed", async () =>
  sdkFixture(async (root, dir) => {
    await fs.writeFile(
      path.join(dir, id + ".json"),
      JSON.stringify({ ...manifest, version: 2 }),
    );
    assert.equal((await list(root)).length, 0);
  }));
test("SDK unknown updated time stays unknown rather than mtime", async () =>
  sdkFixture(async (root, dir) => {
    await fs.writeFile(
      path.join(dir, id + ".json"),
      JSON.stringify({ ...manifest, ended_at: undefined }),
    );
    await fs.writeFile(
      path.join(dir, id + ".messages.json"),
      JSON.stringify({ ...envelope([]), updated_at: "invalid" }),
    );
    assert.equal((await list(root))[0].summary.updatedAt, null);
  }));
test("SDK symlink and hardlink transcript are not read", async () =>
  sdkFixture(async (root, dir) => {
    const p = path.join(dir, id + ".messages.json");
    await fs.rename(p, p + ".original");
    await fs.symlink(p + ".original", p);
    assert.equal((await list(root)).length, 0);
    await fs.unlink(p);
    await fs.link(p + ".original", p);
    assert.equal((await list(root)).length, 0);
  }));
test("SDK cancellation interrupts enumeration", async () =>
  sdkFixture(async (root) => {
    const signal = AbortSignal.abort();
    await assert.rejects(async () => {
      for await (const _ of clineConversationReader.enumerate({
        root,
        signal,
      })) {
      }
    }, /cancelled/i);
  }));
test("SDK cursor bound to source fingerprint", async () =>
  sdkFixture(async (root) => {
    const [item] = await list(root);
    await assert.rejects(
      clineConversationReader.read({ root }, item, {
        limit: 1,
        cursor: { fingerprint: "forged", byteOffset: 1, messageIndex: 0 },
      }),
      /changed/,
    );
  }));
test("SDK manifest status must not coerce an array into accepted status", () =>
  assert.equal(
    parseClineManifest({ ...manifest, status: ["completed"] }, id),
    undefined,
  ));
test("attachment data and system role do not enter renderer projection", () => {
  const p = projectClineMessage(
    {
      role: "user",
      content: [
        { type: "image", source: { data: "SYNTHETIC_SECRET" } },
        {
          type: "tool_result",
          content: [{ type: "image", source: { data: "SYNTHETIC_SECRET" } }],
        },
      ],
    },
    0,
  );
  assert.ok(p);
  assert.equal(JSON.stringify(p).includes("SYNTHETIC_SECRET"), false);
  assert.equal(
    projectClineMessage({ role: "system", content: [] }, 0),
    undefined,
  );
});
test("legacy native task index and API content are read without UI duplication", async () => {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-cline-legacy-reader-"),
  );
  const root = path.join(base, "globalStorage", "saoudrizwan.claude-dev");
  const task = "1740000000000";
  const dir = path.join(root, "tasks", task);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(root, "state"));
  await fs.writeFile(
    path.join(root, "state", "taskHistory.json"),
    JSON.stringify([
      {
        id: task,
        ts: 1750000000000,
        task: "Legacy title",
        cwdOnTaskInitialization: "/fixture/project",
      },
    ]),
  );
  await fs.writeFile(
    path.join(dir, "api_conversation_history.json"),
    JSON.stringify([{ role: "user", content: "legacy content" }]),
  );
  await fs.writeFile(
    path.join(dir, "ui_messages.json"),
    JSON.stringify([{ ts: 1750000000000, text: "duplicate UI content" }]),
  );
  try {
    const items = await list(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].summary.title, "Legacy title");
    assert.equal(items[0].summary.createdAt, null);
    const page = await clineConversationReader.read({ root }, items[0], {
      limit: 50,
    });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].parts[0].text, "legacy content");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
test("SDK manifest rejects nonexistent calendar date", () =>
  assert.equal(
    parseClineManifest({ ...manifest, started_at: "2026-02-30T10:00:00Z" }, id),
    undefined,
  ));
test("SDK manifest rejects timestamp without explicit timezone", () =>
  assert.equal(
    parseClineManifest({ ...manifest, started_at: "2026-10-05T10:00:00" }, id),
    undefined,
  ));
test("SDK manifest accepts explicit timezone offsets", () =>
  assert.ok(
    parseClineManifest(
      { ...manifest, started_at: "2026-10-05T10:00:00+08:00" },
      id,
    ),
  ));
test("long ordinary messages remain completely readable through bounded continuation", async () =>
  sdkFixture(
    async (root) => {
      const [item] = await list(root);
      let cursor: unknown;
      let combined = "";
      let pages = 0;
      do {
        const page = await clineConversationReader.read({ root }, item, {
          limit: 1,
          cursor,
        });
        combined += page.messages
          .flatMap((m) =>
            m.parts.filter((p) => p.type === "text").map((p) => p.text),
          )
          .join("");
        cursor = page.nextCursor;
        assert.ok(++pages < 30);
      } while (cursor);
      assert.equal(combined, "alpha ".repeat(10000) + "LATE_KEYWORD");
    },
    [msg("alpha ".repeat(10000) + "LATE_KEYWORD")],
  ));
test("continuation preserves multiple blocks and Unicode without duplicate native-message identity", async () =>
  sdkFixture(
    async (root) => {
      const [item] = await list(root);
      let cursor: unknown;
      const seen = new Set<string>();
      const native = new Set<string>();
      let joined = "";
      let pages = 0;
      do {
        const page = await clineConversationReader.read({ root }, item, {
          limit: 1,
          cursor,
        });
        for (const message of page.messages) {
          assert.ok(!seen.has(message.id));
          seen.add(message.id);
          if (message.continuation) native.add(message.continuation.messageId);
          joined += message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        }
        cursor = page.nextCursor;
        assert.ok(++pages < 30);
      } while (cursor);
      assert.equal(native.size, 1);
      assert.equal(
        joined,
        "x".repeat(16383) + "🙂" + "y".repeat(20000) + "末尾",
      );
    },
    [
      {
        id: "long-native",
        role: "assistant",
        ts: 1750000000000,
        content: [
          { type: "text", text: "x".repeat(16383) + "🙂" },
          { type: "text", text: "y".repeat(20000) + "末尾" },
        ],
      },
    ],
  ));
test("more than128 content blocks continue without permanently dropping late blocks", async () =>
  sdkFixture(
    async (root) => {
      const [item] = await list(root);
      let cursor: unknown;
      let joined = "";
      let count = 0;
      do {
        const page = await clineConversationReader.read({ root }, item, {
          limit: 1,
          cursor,
        });
        joined += page.messages
          .flatMap((m) =>
            m.parts.filter((p) => p.type === "text").map((p) => p.text),
          )
          .join("");
        cursor = page.nextCursor;
        assert.ok(++count < 10);
      } while (cursor);
      assert.equal(
        joined,
        Array.from({ length: 150 }, (_, i) => `block${i};`).join(""),
      );
    },
    [
      {
        role: "user",
        content: Array.from({ length: 150 }, (_, i) => ({
          type: "text",
          text: `block${i};`,
        })),
      },
    ],
  ));
test("viewer never changes canonical metadata, transcript, database or settings bytes", async () =>
  sdkFixture(async (root, dir) => {
    const files = [
      path.join(dir, id + ".json"),
      path.join(dir, id + ".messages.json"),
      path.join(root, "db", "sessions.db"),
      path.join(root, "globalState.json"),
    ];
    const before = await Promise.all(files.map((p) => fs.readFile(p)));
    const [item] = await list(root);
    await clineConversationReader.read({ root }, item, { limit: 50 });
    const after = await Promise.all(files.map((p) => fs.readFile(p)));
    assert.deepEqual(after, before);
  }));
test("huge transcript pages past the16MiB read budget without rescanning prior message bodies", async () =>
  sdkFixture(
    async (root) => {
      const [item] = await list(root);
      let cursor: unknown;
      let last = "";
      let count = 0;
      do {
        const page = await clineConversationReader.read({ root }, item, {
          limit: 24,
          cursor,
        });
        last =
          page.messages
            .at(-1)
            ?.parts.filter((p) => p.type === "text")
            .at(-1)?.text ?? last;
        cursor = page.nextCursor;
        assert.ok(++count < 100);
      } while (cursor);
      assert.ok(last.endsWith("TAIL_REACHED"));
    },
    Array.from({ length: 18 }, (_, i) =>
      msg("x".repeat(1024 * 1024) + (i === 17 ? "TAIL_REACHED" : "")),
    ),
  ));
test("SDK title falls back to first actual user text when no native title or prompt exists", async () =>
  sdkFixture(async (root, dir) => {
    await fs.writeFile(
      path.join(dir, id + ".json"),
      JSON.stringify({ ...manifest, metadata: {} }),
    );
    const [item] = await list(root);
    assert.equal(item.summary.title, "synthetic user");
    assert.equal(item.summary.titleSource, "first-user-message");
  }));
test("linked child messages in parent artifact directory remain browsable as child source", async () =>
  sdkFixture(async (root, dir) => {
    const childId = id + "__helper";
    await fs.writeFile(
      path.join(dir, "helper.messages.json"),
      JSON.stringify({
        ...envelope([msg("child actual text")]),
        sessionId: childId,
        agent: "subagent",
      }),
    );
    const items = await list(root);
    assert.equal(items.length, 2);
    const child = items.find((item) => item.locator.sessionId === childId)!;
    assert.ok(child);
    assert.equal(child.summary.createdAt, null);
    const page = await clineConversationReader.read({ root }, child, {
      limit: 10,
    });
    assert.equal(page.messages[0].source?.kind, "subagent");
    assert.equal(page.messages[0].parts[0].text, "child actual text");
  }));
import { validateClineReadRoot } from "../electron/conversations/cline-read-root.js";
test("read-only SDK root recognition does not require extension global settings", async () =>
  sdkFixture(async (root) => {
    await fs.unlink(path.join(root, "globalState.json"));
    assert.equal((await validateClineReadRoot(root)).marker, "sqlite");
  }));
test("read-only file-index SDK recognition remains separate from cleanup root authority", async () =>
  sdkFixture(async (root) => {
    await fs.unlink(path.join(root, "db", "sessions.db"));
    await fs.unlink(path.join(root, "globalState.json"));
    await fs.writeFile(
      path.join(root, "sessions", "sessions.index.json"),
      '{"version":1,"sessions":{}}',
    );
    assert.equal((await validateClineReadRoot(root)).marker, "file-index");
  }));
test("read-only root recognition rejects linked canonical markers", async () =>
  sdkFixture(async (root) => {
    const p = path.join(root, "db", "sessions.db");
    await fs.rename(p, p + ".fixture");
    await fs.symlink(p + ".fixture", p);
    await assert.rejects(validateClineReadRoot(root), /unsafe/);
  }));
test("read-only root recognition rejects other-provider namespaces", async () => {
  await assert.rejects(validateClineReadRoot("/tmp/.codex"), /unsafe/);
});
test("SDK-only file-backend source really enumerates and reads without extension settings", async () =>
  sdkFixture(async (root) => {
    await fs.unlink(path.join(root, "db", "sessions.db"));
    await fs.unlink(path.join(root, "globalState.json"));
    await fs.writeFile(
      path.join(root, "sessions", "sessions.index.json"),
      '{"version":1,"sessions":{}}',
    );
    const [item] = await list(root);
    assert.ok(item);
    const page = await clineConversationReader.read({ root }, item, {
      limit: 10,
    });
    assert.equal(page.messages[0].parts[0].text, "synthetic user");
  }));
