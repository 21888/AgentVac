import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openConversationFile } from "../electron/conversations/safe-read.js";
import { readJsonl } from "../electron/conversations/jsonl.js";
import { codexConversationReader } from "../electron/conversations/codex.js";
import { claudeCodeConversationReader } from "../electron/conversations/claude-code.js";
import { plainTextContent } from "../electron/conversations/jsonl-content.js";
import type { ConversationReader } from "../electron/conversations/types.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const x of iter) result.push(x);
  return result;
}
const SID = "550e8400-e29b-41d4-a716-446655440000";
const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T10:01:00.000Z";
async function withTranscript(
  provider: "codex" | "claude",
  records: unknown[],
  action: (
    root: string,
    reader: ConversationReader,
    relative: string,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-reader-"));
  const relative =
    provider === "codex"
      ? `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${SID}.jsonl`
      : `projects/-tmp-project/${SID}.jsonl`;
  try {
    await fs.mkdir(path.dirname(path.join(root, relative)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, relative),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await fs.utimes(
      path.join(root, relative),
      new Date("2026-10-01"),
      new Date("2026-10-01"),
    );
    await action(
      root,
      provider === "codex"
        ? codexConversationReader
        : claudeCodeConversationReader,
      relative,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const cmeta = () => ({
  type: "session_meta",
  timestamp: T1,
  payload: {
    id: SID,
    timestamp: T1,
    cwd: "/tmp/project",
    source: "cli",
    cli_version: "0.1.0",
  },
});
const cev = (type: string, message: string, timestamp = T1) => ({
  type: "event_msg",
  timestamp,
  payload: { type, message },
});
const cres = (role: string, text: string, timestamp = T1) => ({
  type: "response_item",
  timestamp,
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  },
});
const cla = (
  id: string,
  parent: string | null,
  type = "user",
  content: unknown = id,
  extra = {},
) => ({
  type,
  uuid: id,
  parentUuid: parent,
  sessionId: SID,
  cwd: "/tmp/project",
  timestamp: type === "user" ? T1 : T2,
  message: { role: type, content },
  ...extra,
});

test("Codex deduplicates cross-source events but preserves repeated turns and true source times", async () => {
  await withTranscript(
    "codex",
    [
      cmeta(),
      cev("user_message", "Hello"),
      cres("user", "Hello"),
      cres("assistant", "Reply", T2),
      cev("agent_message", "Reply", T2),
      cev("user_message", "Hello", T2),
      cres("user", "Hello", T2),
    ],
    async (root, reader) => {
      const rows = await collect(reader.enumerate({ root }));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].summary.identityVerified, true);
      assert.equal(rows[0].summary.createdAt, T1);
      assert.equal(rows[0].summary.updatedAt, T2);
      assert.equal(rows[0].summary.messageCount, 3);
      const one = await reader.read({ root }, rows[0], { limit: 2 });
      const two = await reader.read({ root }, rows[0], {
        limit: 2,
        cursor: one.nextCursor,
      });
      assert.deepEqual(
        [...one.messages, ...two.messages].map((m) => m.parts[0].text),
        ["Hello", "Reply", "Hello"],
      );
      assert.equal(two.nextCursor, null);
    },
  );
});

test("Codex source-title index wins and nested tool properties cannot rename a conversation", async () => {
  await withTranscript(
    "codex",
    [cmeta(), cres("user", "First prompt")],
    async (root, reader) => {
      await fs.writeFile(
        path.join(root, "session_index.jsonl"),
        JSON.stringify({
          id: SID,
          thread_name: "Native title",
          updated_at: T2,
        }) + "\n",
      );
      const rows = await collect(reader.enumerate({ root }));
      assert.equal(rows[0].summary.title, "Native title");
      assert.equal(rows[0].summary.titleSource, "native");
    },
  );
});

test("Codex compaction records do not require a nested payload discriminator", async () => {
  await withTranscript(
    "codex",
    [
      cmeta(),
      cres("user", "Question"),
      {
        type: "compacted",
        timestamp: T2,
        payload: { message: "Source summary", replacement_history: [] },
      },
    ],
    async (root, reader) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.equal(page.messages.length, 2);
      assert.match(page.messages[1].parts[0].text, /Source summary/);
    },
  );
});

test("Codex duplicate suppression cannot cross a real user-assistant turn boundary", async () => {
  await withTranscript(
    "codex",
    [
      cmeta(),
      cres("user", "repeat"),
      cres("assistant", "answer"),
      cev("user_message", "repeat", T2),
    ],
    async (root, reader) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.deepEqual(
        page.messages.map((m) => m.parts[0].text),
        ["repeat", "answer", "repeat"],
      );
    },
  );
});

test("Codex mismatched native identity reveals neither dialogue nor inferred title", async () => {
  const wrong = cmeta();
  wrong.payload.id = "660e8400-e29b-41d4-a716-446655440000";
  await withTranscript(
    "codex",
    [wrong, cres("user", "WRONG_SESSION_CONTENT")],
    async (root, reader) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      assert.equal(descriptor.summary.identityVerified, false);
      assert.doesNotMatch(
        JSON.stringify(descriptor.summary),
        /WRONG_SESSION_CONTENT/,
      );
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.equal(page.messages.length, 0);
    },
  );
});

test("Codex paginated storage remains read-only without reverse dependency proof", async () => {
  await withTranscript(
    "codex",
    [
      {
        ...cmeta(),
        payload: { ...cmeta().payload, history_mode: "paginated" },
      },
      cres("user", "Readable local turn"),
    ],
    async (root, reader) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      assert.equal(descriptor.summary.identityVerified, false);
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.equal(page.messages[0].parts[0].text, "Readable local turn");
    },
  );
});

test("Codex subagent records carry distinct provenance and cannot grant archival", async () => {
  await withTranscript(
    "codex",
    [
      {
        ...cmeta(),
        payload: {
          ...cmeta().payload,
          parent_thread_id: "660e8400-e29b-41d4-a716-446655440000",
          source: { subagent: "review" },
        },
      },
      cres("assistant", "Child answer"),
    ],
    async (root, reader) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      assert.equal(descriptor.summary.identityVerified, false);
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.equal(page.messages[0].source?.kind, "subagent");
    },
  );
});

test("Claude selects the latest main parentUuid branch, walks progress bridges, and excludes sidechains", async () => {
  await withTranscript(
    "claude",
    [
      cla("u1", null, "user", "Question"),
      cla("old", "u1", "assistant", "Discarded branch"),
      {
        type: "progress",
        uuid: "progress",
        parentUuid: "u1",
        sessionId: SID,
        timestamp: T1,
      },
      cla("a1", "progress", "assistant", "Selected answer"),
      cla("side", "u1", "assistant", "Subagent secret", { isSidechain: true }),
      {
        type: "custom-title",
        sessionId: SID,
        customTitle: "Native Claude title",
      },
    ],
    async (root, reader) => {
      const rows = await collect(reader.enumerate({ root }));
      assert.equal(rows[0].summary.title, "Native Claude title");
      assert.equal(rows[0].summary.createdAt, T1);
      assert.equal(rows[0].summary.messageCount, 2);
      const page = await reader.read({ root }, rows[0], { limit: 10 });
      assert.deepEqual(
        page.messages.map((m) => m.parts[0].text),
        ["Question", "Selected answer"],
      );
    },
  );
});

test("Claude compaction summary replaces logical parents and tool outputs retain role", async () => {
  await withTranscript(
    "claude",
    [
      cla("u1", null, "user", "Old question"),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "u1",
        sessionId: SID,
        timestamp: T2,
      },
      cla("summary", "boundary", "user", "Remembered summary", {
        isCompactSummary: true,
      }),
      cla("tool", "summary", "user", [
        { type: "tool_result", tool_use_id: "t1", content: "Result" },
      ]),
      cla("answer", "tool", "assistant", [
        { type: "text", text: "<img src=x onerror=alert(1)>" },
        { type: "image", source: { data: "SECRET_BINARY" } },
      ]),
    ],
    async (root, reader) => {
      const rows = await collect(reader.enumerate({ root }));
      const page = await reader.read({ root }, rows[0], { limit: 10 });
      assert.equal(rows[0].summary.messageCount, 3);
      assert.equal(page.messages.length, 5);
      assert.equal(page.messages[0].parts[0].type, "notice");
      assert.equal(
        page.messages.find((m) => m.parts[0].type === "tool-result")?.role,
        "tool",
      );
      assert.ok(
        page.messages.some(
          (m) => m.parts[0].type === "text" && m.parts[0].text.includes("<img"),
        ),
      );
      assert.doesNotMatch(JSON.stringify(page), /SECRET_BINARY/);
    },
  );
});

test("Claude companion subagents keep separate provenance, native chains, and a combined revision", async () => {
  await withTranscript(
    "claude",
    [cla("main", null, "user", "Main conversation")],
    async (root, reader, relative) => {
      const directory = relative.slice(0, -6) + "/subagents/workflows/run-1";
      await fs.mkdir(path.join(root, directory), { recursive: true });
      const child = directory + "/agent-worker.jsonl";
      await fs.writeFile(
        path.join(root, child),
        [
          cla("child-u", null, "user", "Child task", { isSidechain: true }),
          cla("child-old", "child-u", "assistant", "Discarded child branch", {
            isSidechain: true,
          }),
          cla("child-a", "child-u", "assistant", "Latest child answer", {
            isSidechain: true,
          }),
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
      );
      const [descriptor] = await collect(reader.enumerate({ root }));
      assert.equal(descriptor.summary.messageCount, 3);
      const page = await reader.read({ root }, descriptor, { limit: 10 });
      assert.deepEqual(
        page.messages.map((m) => m.source?.kind),
        ["main", "subagent", "subagent"],
      );
      assert.deepEqual(
        page.messages.map((m) => m.parts[0].text),
        ["Main conversation", "Child task", "Latest child answer"],
      );
      assert.equal(page.messages[2].source?.id, "worker");
      assert.equal(new Set(page.messages.map((m) => m.id)).size, 3);
      await fs.appendFile(path.join(root, child), "\n");
      await assert.rejects(reader.read({ root }, descriptor, { limit: 10 }), {
        code: "CONVERSATION_CHANGED",
      });
    },
  );
});

test("Claude newly appearing or linked companion files cannot silently enter a previous page", async () => {
  await withTranscript(
    "claude",
    [cla("main", null, "user", "Main")],
    async (root, reader, relative) => {
      const [descriptor] = await collect(reader.enumerate({ root }));
      const dir = relative.slice(0, -6) + "/subagents";
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.symlink(
        path.join(root, relative),
        path.join(root, dir, "agent-linked.jsonl"),
      );
      await assert.rejects(reader.read({ root }, descriptor, { limit: 10 }), {
        code: "CONVERSATION_CHANGED",
      });
      const [updated] = await collect(reader.enumerate({ root }));
      assert.equal(updated.summary.identityVerified, false);
      const page = await reader.read({ root }, updated, { limit: 10 });
      assert.equal(page.messages.length, 1);
      assert.equal(page.partial, true);
    },
  );
});

test("reader content schema discriminators never coerce arrays to trusted types", () => {
  const content = plainTextContent(
    [{ type: ["text"], text: "must not be accepted" }],
    "codex",
  );
  assert.equal(content.unsupported, true);
  assert.doesNotMatch(content.text, /must not be accepted/);
});

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} search streams exclude synthetic attachment labels and preserve native block boundaries`, async () => {
    const content =
      provider === "codex"
        ? [
            { type: "input_text", text: "left" },
            { type: "input_text", text: "right" },
            { type: "input_image", image_url: "data:image/png;base64,SECRET" },
            { type: "input_text", text: "real preview disabled text" },
          ]
        : [
            { type: "text", text: "left" },
            { type: "text", text: "right" },
            { type: "image", source: { data: "SECRET" } },
            { type: "text", text: "real preview disabled text" },
          ];
    const record =
      provider === "codex"
        ? {
            type: "response_item",
            timestamp: T1,
            payload: { type: "message", role: "user", content },
          }
        : cla("parts", null, "user", content);
    await withTranscript(
      provider,
      provider === "codex" ? [cmeta(), record] : [record],
      async (root, reader) => {
        const [descriptor] = await collect(reader.enumerate({ root }));
        const page = await reader.read({ root }, descriptor, { limit: 100 });
        const streams = new Map<string, string>();
        for (const message of page.messages)
          for (const part of message.parts) {
            if (part.type === "notice" || part.type === "attachment") continue;
            const key = message.continuation
              ? message.continuation.messageId +
                ":" +
                message.continuation.partIndex
              : message.id;
            streams.set(key, (streams.get(key) ?? "") + part.text);
          }
        const bodies = [...streams.values()];
        assert.equal(
          bodies.some((text) => text.includes("Image attachment")),
          false,
        );
        assert.equal(
          bodies.some((text) => text.includes("leftright")),
          false,
        );
        assert.equal(
          bodies.some((text) => text.includes("real preview disabled text")),
          true,
        );
        assert.doesNotMatch(JSON.stringify(page), /SECRET/);
        assert.deepEqual(
          page.messages.map((m) => m.continuation?.partIndex),
          [0, 1, 2, 3],
        );
      },
    );
  });
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} returns all long-message characters through continuations without splitting Unicode`, async () => {
    const original =
      "a".repeat(32767) + "😀" + "z".repeat(60000) + "LATE_SEARCH_NEEDLE";
    await withTranscript(
      provider,
      provider === "codex"
        ? [cmeta(), cres("user", original)]
        : [cla("long", null, "user", original)],
      async (root, reader) => {
        const [descriptor] = await collect(reader.enumerate({ root }));
        let cursor: unknown = undefined;
        const texts: string[] = [];
        const ids = new Set<string>();
        for (let pages = 0; pages < 10; pages++) {
          const page = await reader.read({ root }, descriptor, {
            limit: 1,
            cursor,
          });
          assert.equal(page.partial, false);
          for (const message of page.messages) {
            assert.equal(ids.has(message.id), false);
            ids.add(message.id);
            texts.push(
              ...message.parts
                .filter((p) => p.type === "text")
                .map((p) => p.text),
            );
          }
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        assert.equal(texts.join(""), original);
        assert.match(texts.at(-1)!, /LATE_SEARCH_NEEDLE/);
      },
    );
  });
  test(`${provider} page continuation refuses changed files and pre-cancelled readers`, async () => {
    await withTranscript(
      provider,
      provider === "codex"
        ? [cmeta(), cres("user", "one"), cres("assistant", "two")]
        : [cla("u", null, "user", "one"), cla("a", "u", "assistant", "two")],
      async (root, reader, relative) => {
        const [descriptor] = await collect(reader.enumerate({ root }));
        const first = await reader.read({ root }, descriptor, { limit: 1 });
        await fs.appendFile(path.join(root, relative), "\n");
        await assert.rejects(
          reader.read({ root }, descriptor, {
            limit: 1,
            cursor: first.nextCursor,
          }),
          { code: "CONVERSATION_CHANGED" },
        );
        const signal = AbortSignal.abort();
        await assert.rejects(collect(reader.enumerate({ root, signal })), {
          code: "CONVERSATION_CANCELLED",
        });
      },
    );
  });
}

test("request cache retains one bounded pointer index, rechecks storage, and excludes message bodies", async () => {
  const late = "BODY_MUST_NOT_PERSIST_IN_CACHE";
  await withTranscript(
    "codex",
    [cmeta(), cres("user", "Title"), cres("assistant", late)],
    async (root, reader, relative) => {
      const context = { root, cache: new Map<string, unknown>() };
      const [descriptor] = await collect(reader.enumerate(context));
      const first = await reader.read(context, descriptor, { limit: 1 });
      const index = context.cache.get("codex:current-index");
      const second = await reader.read(context, descriptor, {
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.equal(second.messages[0].parts[0].text, late);
      assert.equal(context.cache.get("codex:current-index"), index);
      assert.doesNotMatch(
        JSON.stringify(index),
        /BODY_MUST_NOT_PERSIST_IN_CACHE/,
      );
      await fs.appendFile(path.join(root, relative), "\n");
      await assert.rejects(reader.read(context, descriptor, { limit: 1 }), {
        code: "CONVERSATION_CHANGED",
      });
    },
  );
});

test("Claude progress fan-out reconstruction remains bounded and selects the source branch", async () => {
  const records: unknown[] = [cla("u", null, "user", "Root")];
  for (let i = 0; i < 4000; i++)
    records.push({
      type: "progress",
      uuid: "p" + i,
      parentUuid: i ? "p" + (i - 1) : "u",
      sessionId: SID,
    });
  for (let i = 0; i < 4000; i++)
    records.push({
      type: "attachment",
      uuid: "leaf" + i,
      parentUuid: "p3999",
      sessionId: SID,
    });
  await withTranscript("claude", records, async (root, reader) => {
    const start = performance.now();
    const [descriptor] = await collect(reader.enumerate({ root }));
    assert.equal(descriptor.summary.messageCount, 1);
    assert.ok(
      performance.now() - start < 5000,
      "bounded graph walk exceeded five seconds",
    );
  });
});

test("bounded JSONL preserves split UTF-8, rejects malformed bytes, and resumes by byte boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-jsonl-"));
  try {
    await fs.writeFile(
      path.join(root, "fixture.jsonl"),
      Buffer.concat([
        Buffer.from(
          JSON.stringify({ text: "a".repeat(65518) + "你好😀" }) + "\r\n",
        ),
        Buffer.from('{"bad":"'),
        Buffer.from([255]),
        Buffer.from('"}\n'),
        Buffer.from("{broken}\n"),
        Buffer.from('{"final":true}'),
      ]),
    );
    const file = await openConversationFile(root, "fixture.jsonl");
    try {
      const rows = [];
      for await (const row of readJsonl(file.handle, file.stat.size))
        rows.push(row);
      assert.equal((rows[0].value!.text as string).slice(-4), "你好😀");
      assert.equal(rows[1].issue, "invalid-utf8");
      assert.equal(rows[2].issue, "invalid-json");
      assert.equal(rows[3].issue, "unterminated-record");
      const resumed = [];
      for await (const row of readJsonl(file.handle, file.stat.size, {
        start: rows[2].end,
      }))
        resumed.push(row);
      assert.equal(resumed[0].value!.final, true);
      await file.verifyUnchanged();
    } finally {
      await file.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("oversized JSONL line is discarded, subsequent records remain accessible", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-jsonl-"));
  try {
    await fs.writeFile(
      path.join(root, "fixture.jsonl"),
      "x".repeat(2 * 1024 * 1024) + '\n{"ok":true}\n',
    );
    const file = await openConversationFile(root, "fixture.jsonl");
    try {
      const rows = [];
      for await (const row of readJsonl(file.handle, file.stat.size))
        rows.push(row);
      assert.equal(rows[0].issue, "oversized-record");
      assert.equal(rows[1].value!.ok, true);
    } finally {
      await file.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe opener rejects traversal, symlinks, hardlinks and stale snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentvac-jsonl-"));
  try {
    await fs.writeFile(path.join(root, "fixture.jsonl"), "{}\n");
    await assert.rejects(openConversationFile(root, "../fixture.jsonl"), {
      code: "CONVERSATION_UNSAFE_FILE",
    });
    await fs.symlink(
      path.join(root, "fixture.jsonl"),
      path.join(root, "link.jsonl"),
    );
    await assert.rejects(openConversationFile(root, "link.jsonl"), {
      code: "CONVERSATION_UNSAFE_FILE",
    });
    const file = await openConversationFile(root, "fixture.jsonl");
    await fs.appendFile(path.join(root, "fixture.jsonl"), "{}\n");
    await assert.rejects(file.verifyUnchanged(), {
      code: "CONVERSATION_CHANGED",
    });
    await file.close();
    await fs.link(
      path.join(root, "fixture.jsonl"),
      path.join(root, "hard.jsonl"),
    );
    await assert.rejects(openConversationFile(root, "hard.jsonl"), {
      code: "CONVERSATION_UNSAFE_FILE",
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex reverted physical rollout suffix keeps distinct source versions of a stable thread", async () => {
  await withTranscript(
    "codex",
    [
      {
        ...cmeta(),
        payload: { ...cmeta().payload, history_mode: "paginated" },
      },
      cres("user", "original physical version"),
    ],
    async (root, reader, relative) => {
      const rollout = "018ee444-1a22-7b33-8333-222222222222";
      const reverted = relative.replace(".jsonl", "_" + rollout + ".jsonl");
      await fs.writeFile(
        path.join(root, reverted),
        [
          {
            ...cmeta(),
            payload: {
              ...cmeta().payload,
              history_mode: "paginated",
              history_base: {
                thread_id: SID,
                end_ordinal_exclusive: 2,
                end_byte_offset: 100,
              },
            },
          },
          cres("user", "reverted local version"),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
      const rows = await collect(reader.enumerate({ root }));
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((r) => r.sourceKey)).size, 2);
      assert.equal(new Set(rows.map((r) => r.locator.sessionId)).size, 1);
      const values = [];
      for (const row of rows) {
        assert.equal(row.summary.identityVerified, false);
        const page = await reader.read({ root }, row, { limit: 10 });
        values.push(
          ...page.messages.flatMap((m) =>
            m.parts.filter((p) => p.type === "text").map((p) => p.text),
          ),
        );
      }
      assert.deepEqual(values.sort(), [
        "original physical version",
        "reverted local version",
      ]);
      assert.ok(rows.some((r) => r.summary.sourceLabel.includes(rollout)));
    },
  );
});
test("Codex reverted filename still requires matching stable session metadata identity", async () => {
  await withTranscript("codex", [cmeta()], async (root, reader, relative) => {
    await fs.unlink(path.join(root, relative));
    const reverted = relative.replace(
      ".jsonl",
      "_018ee444-1a22-7b33-8333-222222222222.jsonl",
    );
    await fs.writeFile(
      path.join(root, reverted),
      [
        {
          ...cmeta(),
          payload: {
            ...cmeta().payload,
            id: "018ee444-1a22-7b33-8333-222222222222",
          },
        },
        cres("user", "must not surface"),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const rows = await collect(reader.enumerate({ root }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary.identityVerified, false);
    const page = await reader.read({ root }, rows[0], { limit: 10 });
    assert.equal(page.messages.length, 0);
  });
});

test("known native compressed rollouts report an explicit inventory gap without opening compressed payloads", async () => {
  await withTranscript(
    "codex",
    [cmeta(), cres("user", "plain supported")],
    async (root, reader, relative) => {
      await fs.writeFile(
        path.join(root, relative + ".zst"),
        "SYNTHETIC_UNOPENED_COMPRESSED_PAYLOAD",
      );
      const warnings: string[] = [];
      const rows = await collect(
        reader.enumerate({
          root,
          warn: (_message, code) => warnings.push(code ?? "generic"),
        }),
      );
      assert.equal(rows.length, 1);
      assert.ok(warnings.includes("UNSUPPORTED_SCHEMA"));
    },
  );
});
