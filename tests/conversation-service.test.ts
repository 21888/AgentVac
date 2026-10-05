import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConversationServices } from "../electron/conversations/service.js";
import type {
  ConversationReader,
  ConversationDescriptor,
  ConversationReaderPage,
} from "../electron/conversations/types.js";
import type { AgentVacEngine } from "../electron/engine.js";
import type { AppContext, ProviderId } from "../shared/types.js";
import type {
  ConversationMessage,
  ConversationQuery,
} from "../shared/conversations.js";
const req = (more: Partial<ConversationQuery> = {}) => ({
  requestId: randomUUID(),
  ...more,
});
function descriptor(
  key = "one",
  changes: Partial<ConversationDescriptor["summary"]> = {},
): ConversationDescriptor {
  return {
    sourceKey: key,
    sourceRevision: "revision-" + key,
    locator: { relativePath: key, private: "PRIVATE-LOCATOR" },
    summary: {
      title: "Title " + key,
      titleSource: "native",
      project: "/demo/project",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      timeSource: "native",
      messageCount: 1,
      sizeBytes: 100,
      sourceLabel: "Synthetic source",
      identityVerified: true,
      warnings: [],
      ...changes,
    },
  };
}
const msg = (
  text: string,
  id = "m",
  extra: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id,
  role: "user",
  timestamp: "2026-01-01T00:00:00Z",
  parts: [{ type: "text", text }],
  ...extra,
});
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
function setup(provider: ProviderId = "codex") {
  let data = [descriptor()];
  let reads = 0;
  let enumerations = 0;
  let blocked = false;
  let now = Date.now();
  const invalidated: string[] = [];
  const fake = {
    root: "/synthetic-root",
    provider,
    isBusy: false,
    verifyRootIdentity: async () => {},
    invalidatePreview: (token: string) => invalidated.push(token),
    cancelScan: () => {},
    scan: async () => ({
      entries: data.map((d, i) => ({
        id: String(i),
        path: d.sourceKey,
        selectable: true,
        cleanupUnit: { kind: "bundle" },
      })),
    }),
    preview: async () => ({
      token: randomUUID(),
      items: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    quarantine: async (_t: string, _c: boolean, guard?: () => void) => {
      guard?.();
      return { completed: 1, failed: [], bytes: 1, batchId: randomUUID() };
    },
  };
  let engine = fake as unknown as AgentVacEngine;
  let context: AppContext = {
    provider,
    root: fake.root,
    demo: true,
    platform: process.platform,
  };
  const reader: ConversationReader = {
    provider,
    async *enumerate() {
      enumerations++;
      yield* data;
    },
    async read() {
      reads++;
      return {
        messages: [msg("Actual content")],
        nextCursor: null,
        partial: false,
        warnings: [],
      };
    },
  };
  const service = new ConversationServices({
    engine: () => engine,
    context: () => context,
    readers: [reader],
    blocked: () => blocked,
    now: () => now,
  });
  return {
    service,
    reader,
    fake,
    invalidated,
    get reads() {
      return reads;
    },
    get enumerations() {
      return enumerations;
    },
    setData: (v: ConversationDescriptor[]) => (data = v),
    setBlocked: (v: boolean) => (blocked = v),
    setNow: (v: number) => (now = v),
    switchRoot: () => {
      engine = { ...fake, root: "/other-root" } as unknown as AgentVacEngine;
      context = { ...context, root: "/other-root" };
    },
    switchProvider: () => {
      engine = { ...fake, provider: "cline" } as unknown as AgentVacEngine;
      context = { ...context, provider: "cline" };
    },
  };
}
async function granted(provider: ProviderId = "codex") {
  const f = setup(provider);
  await f.service.setAccess(true);
  return f;
}
test("explicit consent is required before any enumeration or content read", async () => {
  const f = setup();
  assert.equal(f.service.getAccess().allowed, false);
  await assert.rejects(f.service.list(req()), /明确允许/);
  assert.equal(f.enumerations, 0);
  assert.equal(f.reads, 0);
  await f.service.setAccess(true);
  assert.equal((await f.service.list(req())).items.length, 1);
});
test("renderer sees opaque ids, no source locators/native cursors/private fields", async () => {
  const f = await granted();
  const p = await f.service.list(req());
  assert.match(p.items[0].id, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(p).includes("PRIVATE-LOCATOR"));
  f.reader.read = async () => ({
    messages: [{ ...msg("body"), private: "SECRET" } as ConversationMessage],
    nextCursor: { secret: "PRIVATE-CURSOR" },
    partial: false,
    warnings: [],
  });
  const detail = await f.service.read({
    requestId: randomUUID(),
    conversationId: p.items[0].id,
  });
  assert.ok(!JSON.stringify(detail).includes("PRIVATE"));
  assert.ok(!JSON.stringify(detail).includes("SECRET"));
});
test("title, project and content filters remain distinct", async () => {
  const f = await granted();
  assert.equal((await f.service.list(req({ title: "Title" }))).items.length, 1);
  assert.equal(f.reads, 0);
  assert.equal(
    (await f.service.list(req({ keyword: "Title" }))).items.length,
    0,
  );
  assert.equal(
    (
      await f.service.list(
        req({ keyword: "Title", searchScope: "title-project" }),
      )
    ).items.length,
    1,
  );
  assert.equal(
    (await f.service.list(req({ project: "other" }))).items.length,
    0,
  );
  assert.equal(
    (await f.service.list(req({ keyword: "actual CONTENT" }))).items.length,
    1,
  );
});
test("date to is exclusive, unknown times never silently use mtime, invalid/future values become unknown", async () => {
  const f = await granted();
  f.setData([
    descriptor("before", { updatedAt: "2026-03-08T06:59:59Z" }),
    descriptor("inside", { updatedAt: "2026-03-08T07:00:00Z" }),
    descriptor("end", { updatedAt: "2026-03-09T04:00:00Z" }),
    descriptor("bad", { updatedAt: "2026-02-30T10:00:00Z" }),
    descriptor("future", { updatedAt: "2099-01-01T00:00:00Z" }),
    descriptor("no-zone", { updatedAt: "2026-01-01T00:00:00" }),
  ]);
  const result = await f.service.list(
    req({ from: "2026-03-08T00:00:00-05:00", to: "2026-03-09T00:00:00-04:00" }),
  );
  assert.deepEqual(result.items.map((i) => i.title).sort(), [
    "Title before",
    "Title inside",
  ]);
  const unknown = await f.service.list(
    req({
      from: "2026-03-08T00:00:00-05:00",
      to: "2026-03-09T00:00:00-04:00",
      includeUnknownTimes: true,
    }),
  );
  assert.equal(unknown.items.length, 5);
  await assert.rejects(
    f.service.list(req({ from: "2026-02-30T00:00:00Z" })),
    /无效/,
  );
});
test("equal-time pagination is stable and reusable for Back; cursor cannot cross query", async () => {
  const f = await granted();
  f.setData(["a", "b", "c"].map((k) => descriptor(k)));
  const first = await f.service.list(req({ limit: 1 }));
  const second = await f.service.list(
    req({ limit: 1, cursor: first.nextCursor! }),
  );
  const again = await f.service.list(
    req({ limit: 1, cursor: first.nextCursor! }),
  );
  assert.deepEqual(second.items, again.items);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(first.snapshotId, second.snapshotId);
  await assert.rejects(
    f.service.list(
      req({ limit: 1, cursor: first.nextCursor!, title: "changed" }),
    ),
    /分页/,
  );
});
test("message cursors are reusable but bound to one conversation and expire", async () => {
  const f = await granted();
  f.setData([descriptor("a"), descriptor("b")]);
  f.reader.read = async (_ctx, _d, o) => ({
    messages: [msg(o.cursor ? "page2" : "page1")],
    nextCursor: o.cursor ? null : { offset: 1 },
    partial: false,
    warnings: [],
  });
  const list = await f.service.list(req());
  const first = await f.service.read({
    requestId: randomUUID(),
    conversationId: list.items[0].id,
  });
  const query = { conversationId: list.items[0].id, cursor: first.nextCursor! };
  const a = await f.service.read({ requestId: randomUUID(), ...query });
  const b = await f.service.read({ requestId: randomUUID(), ...query });
  assert.deepEqual(a.messages, b.messages);
  await assert.rejects(
    f.service.read({
      requestId: randomUUID(),
      conversationId: list.items[1].id,
      cursor: first.nextCursor!,
    }),
    /分页/,
  );
  f.setNow(Date.now() + 11 * 60_000);
  await assert.rejects(
    f.service.read({ requestId: randomUUID(), ...query }),
    /分页/,
  );
});
test("root/provider change and consent revoke invalidate all old ids and cursors", async () => {
  for (const change of ["switchRoot", "switchProvider", "revoke"] as const) {
    const f = await granted();
    const first = await f.service.list(req());
    if (change === "revoke") await f.service.setAccess(false);
    else f[change]();
    assert.equal(f.service.getAccess().allowed, false);
    await assert.rejects(
      f.service.read({
        requestId: randomUUID(),
        conversationId: first.items[0].id,
      }),
    );
  }
});
test("changed source revision invalidates previous conversation id", async () => {
  const f = await granted();
  const first = await f.service.list(req());
  f.setData([{ ...descriptor(), sourceRevision: "new" }]);
  const next = await f.service.list(req());
  assert.notEqual(first.items[0].id, next.items[0].id);
  await assert.rejects(
    f.service.read({
      requestId: randomUUID(),
      conversationId: first.items[0].id,
    }),
    /分页/,
  );
});
test("revoke aborts in-flight reads and drains private snapshot cleanup", async () => {
  const f = await granted();
  const first = await f.service.list(req());
  const entered = deferred();
  let cleaned = false;
  f.reader.read = async (ctx) => {
    ctx.registerCleanup?.(async () => {
      cleaned = true;
    });
    entered.resolve();
    await new Promise<void>((r) =>
      ctx.signal!.addEventListener("abort", () => r(), { once: true }),
    );
    return {
      messages: [msg("PRIVATE LATE BODY")],
      nextCursor: null,
      partial: false,
      warnings: [],
    };
  };
  const pending = f.service.read({
    requestId: randomUUID(),
    conversationId: first.items[0].id,
  });
  const rejection = assert.rejects(pending, /取消/);
  await entered.promise;
  await f.service.setAccess(false);
  await rejection;
  assert.equal(cleaned, true);
});
test("new consent cannot resurrect a pending older grant after revocation", async () => {
  const f = setup();
  const gate = deferred();
  f.fake.verifyRootIdentity = async () => gate.promise;
  const grant = f.service.setAccess(true);
  const rejection = assert.rejects(grant, /改变/);
  await f.service.setAccess(false);
  gate.resolve();
  await rejection;
  assert.equal(f.service.getAccess().allowed, false);
});
test("duplicate requests rejected and cancel closes only matching request", async () => {
  const f = await granted();
  const entered = deferred();
  f.reader.enumerate = async function* (ctx) {
    entered.resolve();
    await new Promise<void>((r) =>
      ctx.signal!.addEventListener("abort", () => r(), { once: true }),
    );
    yield descriptor();
  };
  const request = req();
  const pending = f.service.list(request);
  const rejection = assert.rejects(pending, /取消/);
  await entered.promise;
  await assert.rejects(f.service.list(request), /重复/);
  f.service.cancel(request.requestId);
  await rejection;
});
test("parser/SQLite exceptions and diagnostic warnings never echo transcript snippets", async () => {
  const f = await granted();
  f.reader.enumerate = async function* () {
    throw Error("Unexpected token SECRET-DIALOGUE-CREDENTIAL");
  };
  await assert.rejects(
    f.service.list(req()),
    (e) =>
      e instanceof Error &&
      !e.message.includes("SECRET") &&
      e.message.includes("安全"),
  );
  f.reader.enumerate = async function* (ctx) {
    ctx.warn?.("SECRET");
    yield descriptor();
  };
  const result = await f.service.list(req());
  assert.equal(result.partial, true);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});
test("search finds late continuation boundary but never joins separate messages or notices", async () => {
  const f = await granted();
  f.reader.read = async (_ctx, _d, o) => {
    const continuation = {
      messageId: "native1",
      partIndex: 0,
      offset: o.cursor ? 32768 : 0,
      hasMore: !o.cursor,
    };
    return {
      messages: [
        msg(
          o.cursor ? "bar late-keyword" : "x".repeat(32765) + "foo",
          o.cursor ? "segment2" : "segment1",
          { continuation },
        ),
      ],
      nextCursor: o.cursor ? null : { offset: 32768 },
      partial: false,
      warnings: [],
    };
  };
  assert.equal(
    (await f.service.list(req({ keyword: "foobar" }))).items.length,
    1,
  );
  assert.equal(
    (await f.service.list(req({ keyword: "late-keyword" }))).items.length,
    1,
  );
  f.reader.read = async () => ({
    messages: [
      msg("foo", "1"),
      msg("bar", "2"),
      { ...msg("", "3"), parts: [{ type: "notice", text: "synthetic-only" }] },
    ],
    nextCursor: null,
    partial: false,
    warnings: [],
  });
  assert.equal(
    (await f.service.list(req({ keyword: "foobar" }))).items.length,
    0,
  );
  assert.equal(
    (await f.service.list(req({ keyword: "synthetic-only" }))).items.length,
    0,
  );
});
test("partial reader coverage and nonprogress cursors never become complete search results", async () => {
  const f = await granted();
  f.reader.read = async () => ({
    messages: [msg("no match")],
    nextCursor: { same: 1 },
    partial: true,
    warnings: [],
  });
  const result = await f.service.list(req({ keyword: "missing" }));
  assert.equal(result.partial, true);
  assert.equal(result.items.length, 0);
});
test("all unsupported canonical providers remain read-only regardless of identity", async () => {
  for (const provider of ["codex", "cline", "cursor"] as const) {
    const f = await granted(provider);
    const list = await f.service.list(req());
    assert.equal(list.items[0].canArchive, false);
    await assert.rejects(
      f.service.previewArchive([list.items[0].id]),
      /完整归档事务/,
    );
  }
});
test("conversation preview token wraps engine token and is revoked without exposing internal token", async () => {
  const f = await granted("claude-code");
  const engineToken = randomUUID();
  f.fake.preview = async () => ({
    token: engineToken,
    items: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const first = await f.service.list(req());
  const preview = await f.service.previewArchive([first.items[0].id]);
  assert.notEqual(preview.preview.token, engineToken);
  assert.equal(f.service.ownsPreview(preview.preview.token), true);
  await f.service.setAccess(false);
  assert.deepEqual(f.invalidated, [engineToken]);
  assert.equal(f.service.ownsPreview(preview.preview.token), false);
  await assert.rejects(f.service.quarantine(preview.preview.token, true));
});
test("in-flight preview minted after revoke is destroyed and never returned", async () => {
  const f = await granted("claude-code");
  const entered = deferred(),
    release = deferred();
  const internal = randomUUID();
  f.fake.preview = async () => {
    entered.resolve();
    await release.promise;
    return {
      token: internal,
      items: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  };
  const first = await f.service.list(req());
  const pending = f.service.previewArchive([first.items[0].id]);
  const rejection = assert.rejects(pending, /取消/);
  await entered.promise;
  const revoke = f.service.setAccess(false);
  release.resolve();
  await revoke;
  await rejection;
  assert.deepEqual(f.invalidated, [internal]);
});
test("revocation while mutation waits invalidates write authorization before commit", async () => {
  const f = await granted("claude-code");
  const entered = deferred(),
    release = deferred();
  let writes = 0;
  f.fake.quarantine = async (_token, _closed, guard) => {
    entered.resolve();
    await release.promise;
    guard?.();
    writes++;
    return { completed: 1, failed: [], bytes: 1, batchId: randomUUID() };
  };
  const first = await f.service.list(req());
  const preview = await f.service.previewArchive([first.items[0].id]);
  const operation = f.service.quarantine(preview.preview.token, true);
  const rejection = assert.rejects(operation, /改变/);
  await entered.promise;
  await f.service.setAccess(false);
  release.resolve();
  await rejection;
  assert.equal(writes, 0);
});
test("unsafe oversized/duplicate message envelopes reject without forwarding body", async () => {
  const f = await granted();
  const list = await f.service.list(req());
  f.reader.read = async () => ({
    messages: [msg("body"), msg("other")],
    nextCursor: null,
    partial: false,
    warnings: [],
  });
  await assert.rejects(
    f.service.read({
      requestId: randomUUID(),
      conversationId: list.items[0].id,
    }),
    /安全/,
  );
  f.reader.read = async () => ({
    messages: [msg("x".repeat(600000))],
    nextCursor: null,
    partial: false,
    warnings: [],
  });
  await assert.rejects(
    f.service.read({
      requestId: randomUUID(),
      conversationId: list.items[0].id,
    }),
    /安全/,
  );
});
test("content requests refuse concurrent file operation and duplicate archive selections", async () => {
  const f = await granted("claude-code");
  const list = await f.service.list(req());
  f.setBlocked(true);
  await assert.rejects(f.service.list(req()));
  f.setBlocked(false);
  await assert.rejects(
    f.service.previewArchive([list.items[0].id, list.items[0].id]),
    /无效/,
  );
});

test("refresh of unchanged source preserves an already open detail cursor", async () => {
  const f = await granted();
  f.reader.read = async (_ctx, _d, o) => ({
    messages: [msg(o.cursor ? "second-page" : "first-page")],
    nextCursor: o.cursor ? null : { offset: 1 },
    partial: false,
    warnings: [],
  });
  const list = await f.service.list(req());
  const detail = await f.service.read({
    requestId: randomUUID(),
    conversationId: list.items[0].id,
  });
  await f.service.list(req({ title: "Title" }));
  const next = await f.service.read({
    requestId: randomUUID(),
    conversationId: list.items[0].id,
    cursor: detail.nextCursor!,
  });
  assert.equal(next.messages[0].parts[0].text, "second-page");
});

for (const field of ["role", "part-type", "source-kind"] as const)
  test("strict message discriminator rejects coerced " + field, async () => {
    const f = await granted();
    const list = await f.service.list(req());
    const message: any = msg("synthetic");
    if (field === "role") message.role = ["user"];
    if (field === "part-type") message.parts[0].type = ["text"];
    if (field === "source-kind")
      message.source = { kind: ["main"], label: "synthetic" };
    f.reader.read = async () => ({
      messages: [message],
      nextCursor: null,
      partial: false,
      warnings: [],
    });
    await assert.rejects(
      f.service.read({
        requestId: randomUUID(),
        conversationId: list.items[0].id,
      }),
      /安全/,
    );
  });
