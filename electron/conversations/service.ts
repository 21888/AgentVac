import { ConversationContentMatcher, normalizeSearch } from "./search.js";
import type { ReadOnlyConversationSource } from "./sources.js";
import { randomUUID, createHash } from "node:crypto";
import type { AgentVacEngine } from "../engine.js";
import type {
  AppContext,
  ProviderId,
  Preview,
  OperationResult,
} from "../../shared/types.js";
import type {
  ConversationAccess,
  ConversationQuery,
  ConversationSummary,
  ConversationListPage,
  ConversationReadRequest,
  ConversationMessagePage,
  ConversationArchivePreview,
  ConversationMessage,
} from "../../shared/conversations.js";
import type {
  ConversationReader,
  ConversationDescriptor,
  ConversationReaderContext,
} from "./types.js";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONVERSATIONS = 5000,
  MAX_SCAN_PAGES = 2000,
  MAX_SEARCH_BYTES = 128 * 1024 * 1024,
  MAX_QUERY_MS = 60_000;
const FAIL = {
  consent: "请先明确允许读取当前目录中的会话正文。",
  context: "提供方、目录或读取授权已改变，请重新打开会话管理。",
  cursor: "会话分页已失效或不属于当前筛选，请重新查询。",
  read: "会话读取未能安全完成；内容可能已改变、不可访问或格式暂不支持。",
  cancel: "会话读取已取消；未修改源文件。",
  query: "会话筛选条件无效。",
  unsupported: "此会话尚无已验证的完整归档事务；不能用单个文件移动代替。",
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const normalized = normalizeSearch;
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw Error(FAIL.query);
  return value;
}
function parsedTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const year = +match[1],
    month = +match[2],
    day = +match[3];
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    +match[4] > 23 ||
    +match[5] > 59 ||
    +match[6] > 59
  )
    return null;
  if (
    match[7] !== "Z" &&
    (+match[7].slice(1, 3) > 23 || +match[7].slice(4, 6) > 59)
  )
    return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function time(value: unknown, now = Date.now()): string | null {
  const n = parsedTime(value);
  return n !== null && n >= 0 && n <= now + 300_000
    ? new Date(n).toISOString()
    : null;
}
function messages(value: unknown): ConversationMessage[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024
  )
    throw Error(FAIL.read);
  const ids = new Set<string>();
  return value.map((input: unknown) => {
    if (
      !record(input) ||
      typeof input.id !== "string" ||
      !input.id ||
      input.id.length > 1000 ||
      ids.has(input.id) ||
      typeof input.role !== "string" ||
      !["user", "assistant", "system", "tool", "unknown"].includes(
        input.role,
      ) ||
      !Array.isArray(input.parts) ||
      input.parts.length > 256
    )
      throw Error(FAIL.read);
    ids.add(input.id);
    const output: ConversationMessage = {
      id: input.id,
      role: input.role as ConversationMessage["role"],
      timestamp: time(input.timestamp),
      parts: input.parts.map((part) => {
        if (
          !record(part) ||
          typeof part.type !== "string" ||
          ![
            "text",
            "tool-call",
            "tool-result",
            "thinking",
            "attachment",
            "notice",
          ].includes(part.type) ||
          typeof part.text !== "string" ||
          part.text.length > 512 * 1024
        )
          throw Error(FAIL.read);
        return {
          type: part.type as ConversationMessage["parts"][number]["type"],
          text: part.text,
        };
      }),
    };
    const source = input.source;
    if (source !== undefined) {
      if (
        !record(source) ||
        typeof source.kind !== "string" ||
        !["main", "subagent", "branch", "imported"].includes(source.kind) ||
        typeof source.label !== "string"
      )
        throw Error(FAIL.read);
      output.source = {
        kind: source.kind as NonNullable<ConversationMessage["source"]>["kind"],
        label: source.label.slice(0, 300),
        ...(typeof source.id === "string"
          ? { id: source.id.slice(0, 1000) }
          : {}),
      };
    }
    const c = input.continuation;
    if (c !== undefined) {
      if (
        !record(c) ||
        typeof c.messageId !== "string" ||
        !c.messageId ||
        c.messageId.length > 1000 ||
        !Number.isSafeInteger(c.partIndex) ||
        Number(c.partIndex) < 0 ||
        !Number.isSafeInteger(c.offset) ||
        Number(c.offset) < 0 ||
        typeof c.hasMore !== "boolean"
      )
        throw Error(FAIL.read);
      output.continuation = {
        messageId: c.messageId,
        partIndex: Number(c.partIndex),
        offset: Number(c.offset),
        hasMore: c.hasMore,
      };
    }
    return output;
  });
}
interface Binding {
  engine?: AgentVacEngine;
  identity: object;
  verify: () => Promise<void>;
  reader?: ConversationReader;
  root: string;
  provider: ProviderId;
  revision: string;
}
interface Registered {
  descriptor: ConversationDescriptor;
  reader: ConversationReader;
  summary: ConversationSummary;
  binding: Binding;
}
interface Snapshot {
  id: string;
  fingerprint: string;
  binding: Binding;
  items: ConversationSummary[];
  scanned: number;
  partial: boolean;
  warnings: string[];
  created: number;
}
type Cursor =
  | { kind: "list"; snapshot: Snapshot; offset: number }
  | { kind: "read"; entry: Registered; native: unknown; created: number };
interface RequestState {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  kind: "list" | "read" | "preview";
}
/** Local-only orchestration: consent, stable snapshots and IDs never come from file contents. */
export class ConversationServices {
  private bound?: Binding;
  private source?: {
    value: ReadOnlyConversationSource;
    selectedEngine?: AgentVacEngine;
    selectedRoot: string | null;
    provider: ProviderId;
  };
  private allowed = false;
  private revision = randomUUID();
  private entries = new Map<string, Registered>();
  private sourceIds = new Map<string, string>();
  private cursors = new Map<string, Cursor>();
  private active = new Map<string, RequestState>();
  private previews = new Map<
    string,
    { binding: Binding; engineToken: string; value: Preview }
  >();
  constructor(
    private readonly options: {
      engine: () => AgentVacEngine;
      context: () => AppContext;
      readers: readonly ConversationReader[];
      blocked?: () => boolean;
      now?: () => number;
      readerAvailability?: (provider: ProviderId) => string | undefined;
    },
  ) {}
  private clock() {
    return this.options.now?.() ?? Date.now();
  }
  private synchronize() {
    const context = this.options.context();
    let engine: AgentVacEngine | undefined;
    try {
      if (context.root) engine = this.options.engine();
    } catch {}
    if (
      this.source &&
      (this.source.provider !== context.provider ||
        this.source.selectedRoot !== context.root ||
        this.source.selectedEngine !== engine)
    ) {
      this.revoke();
      this.source = undefined;
      this.bound = undefined;
    }
    const identity = this.source?.value ?? engine;
    const root = this.source?.value.root ?? engine?.root;
    if (
      this.bound &&
      (this.bound.identity !== identity ||
        this.bound.root !== root ||
        this.bound.provider !== context.provider)
    ) {
      this.revoke();
      this.bound = undefined;
    }
    if (identity && root && !this.bound)
      this.bound = this.source
        ? {
            identity,
            root,
            provider: context.provider,
            revision: this.revision,
            verify: this.source.value.verify,
            reader: this.source.value.reader,
          }
        : {
            identity,
            engine: engine!,
            root,
            provider: context.provider,
            revision: this.revision,
            verify: () => engine!.verifyRootIdentity(),
          };
    return context;
  }
  private revoke() {
    this.allowed = false;
    this.revision = randomUUID();
    for (const request of this.active.values()) request.controller.abort();
    for (const preview of this.previews.values())
      preview.binding.engine?.invalidatePreview(preview.engineToken);
    this.previews.clear();
    this.entries.clear();
    this.sourceIds.clear();
    this.cursors.clear();
    if (this.bound) this.bound = { ...this.bound, revision: this.revision };
  }
  getAccess(): ConversationAccess {
    const context = this.synchronize();
    return {
      ...(!this.source && this.options.readerAvailability?.(context.provider)
        ? {
            unavailableReason: this.options.readerAvailability(
              context.provider,
            ),
          }
        : {}),
      provider: context.provider,
      root: this.bound?.root ?? context.root,
      sourceKind: this.source?.value.kind ?? "selected",
      sourceLabel: this.source?.value.label ?? "当前工具数据目录",
      readOnlySource: !!this.source,
      allowed: this.allowed && !!this.bound,
      revision: this.revision,
    };
  }
  async setAccess(allowed: boolean): Promise<ConversationAccess> {
    if (typeof allowed !== "boolean") throw Error(FAIL.consent);
    this.synchronize();
    if (!allowed) {
      this.revoke();
      await this.drain();
      return this.getAccess();
    }
    const unavailable =
      !this.source &&
      this.options.readerAvailability?.(
        this.bound?.provider ?? this.options.context().provider,
      );
    if (unavailable) throw Error(unavailable);
    if (this.options.blocked?.() || !this.bound || this.bound.engine?.isBusy)
      throw Error(FAIL.context);
    const binding = this.bound,
      revision = this.revision;
    await binding.verify();
    this.synchronize();
    if (
      this.bound !== binding ||
      this.revision !== revision ||
      this.options.blocked?.()
    )
      throw Error(FAIL.context);
    this.revoke();
    this.allowed = true;
    return this.getAccess();
  }
  async useReadOnlySource(
    value: ReadOnlyConversationSource,
  ): Promise<ConversationAccess> {
    const context = this.synchronize();
    let engine: AgentVacEngine | undefined;
    try {
      engine = this.options.engine();
    } catch {}
    if (
      value.provider !== context.provider ||
      this.options.blocked?.() ||
      engine?.isBusy
    )
      throw Error(FAIL.context);
    const revision = this.revision;
    await value.verify();
    const current = this.synchronize();
    if (
      current.provider !== context.provider ||
      current.root !== context.root ||
      revision !== this.revision ||
      this.options.blocked?.()
    )
      throw Error(FAIL.context);
    this.revoke();
    await this.drain();
    this.source = {
      value,
      selectedEngine: engine,
      selectedRoot: context.root,
      provider: context.provider,
    };
    this.bound = undefined;
    return this.getAccess();
  }
  async resetSource(): Promise<ConversationAccess> {
    this.revoke();
    await this.drain();
    this.source = undefined;
    this.bound = undefined;
    return this.getAccess();
  }
  private assert(binding: Binding) {
    this.synchronize();
    if (
      !this.allowed ||
      !this.bound ||
      this.bound.identity !== binding.identity ||
      this.revision !== binding.revision
    )
      throw Error(FAIL.context);
  }
  private async binding(): Promise<Binding> {
    this.synchronize();
    if (!this.allowed || !this.bound) throw Error(FAIL.consent);
    if (this.options.blocked?.() || this.bound.engine?.isBusy)
      throw Error("请等待当前文件操作完成后读取会话。");
    const binding = { ...this.bound, revision: this.revision };
    await binding.verify();
    this.assert(binding);
    return binding;
  }
  private start(id: unknown, kind: RequestState["kind"]) {
    if (
      typeof id !== "string" ||
      !UUID.test(id) ||
      this.active.has(id) ||
      this.active.size >= 3
    )
      throw Error("会话请求标识无效、重复或已有过多读取。");
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const deadline = setTimeout(() => controller.abort(), MAX_QUERY_MS);
    deadline.unref();
    this.active.set(id, { controller, done, finish, kind });
    return {
      controller,
      end: () => {
        clearTimeout(deadline);
        this.active.delete(id);
        finish();
      },
    };
  }
  cancel(id: string) {
    if (typeof id !== "string" || !UUID.test(id))
      throw Error("会话请求标识无效。");
    this.active.get(id)?.controller.abort();
  }
  async cancelAndDrain() {
    for (const request of this.active.values()) request.controller.abort();
    await this.drain();
  }
  private async drain() {
    await Promise.allSettled(
      [...this.active.values()].map((request) => request.done),
    );
  }
  private context(
    binding: Binding,
    signal: AbortSignal,
    id: string,
    warnings: string[],
  ) {
    const cleanup: Array<() => Promise<void>> = [];
    const cache = new Map<string, unknown>();
    const context: ConversationReaderContext = {
      root: binding.root,
      signal,
      requestId: id,
      cache,
      registerCleanup: (fn) => cleanup.push(fn),
      warn: (_message, code) => {
        const known = {
          SNAPSHOT_LIMIT:
            "数据库副本超过本次 512 MiB 安全预算，结果不完整；请使用原工具导出或选择较小的只读来源。",
          SOURCE_CHANGED:
            "读取期间来源发生变化，相关会话未纳入结果；请等待原工具写入结束后重新查询。",
          UNSUPPORTED_SCHEMA:
            "部分会话使用尚未支持的存储格式，已保留原数据并跳过。",
          PRIVATE_STORAGE_UNAVAILABLE:
            "无法建立已验证的私有本地副本，数据库会话暂不可读。",
          READ_LIMIT: "部分会话达到单条记录、文件或检索预算上限，结果不完整。",
          PARTIAL_PARSE: "部分会话记录无法完整解析，结果不完整。",
        };
        const message =
          code && Object.hasOwn(known, code)
            ? known[code]
            : "部分会话无法完整、安全地读取，请检查范围说明。";
        if (!warnings.includes(message)) warnings.push(message);
      },
    };
    return {
      context,
      dispose: async () => {
        cache.clear();
        await Promise.allSettled(cleanup.map((fn) => fn()));
      },
    };
  }
  private check(binding: Binding, signal: AbortSignal) {
    if (signal.aborted) throw Error(FAIL.cancel);
    this.assert(binding);
  }
  private query(input: ConversationQuery) {
    if (!record(input)) throw Error(FAIL.query);
    const title = boundedText(input.title ?? "", 300).trim(),
      keyword = boundedText(input.keyword ?? "", 300).trim(),
      project = boundedText(input.project ?? "", 1000).trim();
    const scope = input.searchScope ?? "content";
    const field = input.dateField ?? "updatedAt";
    const sort = input.sort ?? "updated-desc";
    if (
      !["content", "title-project", "all"].includes(scope) ||
      !["createdAt", "updatedAt"].includes(field) ||
      !["created-desc", "updated-desc", "title"].includes(sort) ||
      (input.includeUnknownTimes !== undefined &&
        typeof input.includeUnknownTimes !== "boolean")
    )
      throw Error(FAIL.query);
    const boundary = (value: unknown) => {
      if (value === undefined) return null;
      if (
        typeof value !== "string" ||
        value.length > 64 ||
        !/[TZ]|[+-]\d\d:\d\d$/.test(value)
      )
        throw Error(FAIL.query);
      const n = parsedTime(value);
      if (n === null) throw Error(FAIL.query);
      return n;
    };
    const from = boundary(input.from),
      to = boundary(input.to);
    if (from !== null && to !== null && from >= to) throw Error(FAIL.query);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Error(FAIL.query);
    return {
      title,
      keyword,
      project,
      scope,
      field,
      sort,
      from,
      to,
      includeUnknown: input.includeUnknownTimes ?? false,
      limit,
    };
  }
  private register(
    descriptor: ConversationDescriptor,
    reader: ConversationReader,
    binding: Binding,
  ): Registered {
    if (
      !descriptor ||
      typeof descriptor.sourceKey !== "string" ||
      descriptor.sourceKey.length > 4096 ||
      typeof descriptor.sourceRevision !== "string" ||
      !descriptor.sourceRevision ||
      descriptor.sourceRevision.length > 2048 ||
      !record(descriptor.locator) ||
      !record(descriptor.summary)
    )
      throw Error(FAIL.read);
    const sourceKey = reader.provider + ":" + descriptor.sourceKey;
    let id = this.sourceIds.get(sourceKey);
    const old = id ? this.entries.get(id) : undefined;
    if (old && old.descriptor.sourceRevision !== descriptor.sourceRevision) {
      this.entries.delete(id!);
      id = undefined;
    }
    if (!id) id = randomUUID();
    const summary = descriptor.summary;
    const createdAt = time(summary.createdAt, this.clock()),
      updatedAt = time(summary.updatedAt, this.clock());
    const safeTitle =
      typeof summary.title === "string"
        ? summary.title.slice(0, 300)
        : "未命名会话";
    const source =
      typeof summary.sourceLabel === "string"
        ? summary.sourceLabel.slice(0, 300)
        : "会话来源";
    const compatible =
      !!binding.engine &&
      reader.provider === "claude-code" &&
      summary.identityVerified === true &&
      typeof descriptor.locator.relativePath === "string" &&
      descriptor.locator.relativePath === descriptor.sourceKey;
    const value: ConversationSummary = {
      id,
      provider: binding.provider,
      title: safeTitle,
      titleSource: [
        "native",
        "first-user-message",
        "identifier",
        "unknown",
      ].includes(summary.titleSource)
        ? summary.titleSource
        : "unknown",
      project:
        typeof summary.project === "string"
          ? summary.project.slice(0, 4096)
          : null,
      createdAt,
      updatedAt,
      timeSource: ["native", "messages", "unknown"].includes(summary.timeSource)
        ? summary.timeSource
        : "unknown",
      createdAtSource: createdAt
        ? (summary.createdAtSource ?? summary.timeSource)
        : "unknown",
      updatedAtSource: updatedAt
        ? (summary.updatedAtSource ?? summary.timeSource)
        : "unknown",
      messageCount:
        Number.isSafeInteger(summary.messageCount) && summary.messageCount! >= 0
          ? summary.messageCount
          : null,
      sizeBytes:
        Number.isSafeInteger(summary.sizeBytes) && summary.sizeBytes >= 0
          ? summary.sizeBytes
          : 0,
      sourceLabel: source,
      identityVerified: summary.identityVerified === true,
      canArchive: compatible,
      archiveReason: compatible
        ? "可请求完整会话组预览；仍需核验活跃状态、文件年龄及全部关联成员。"
        : FAIL.unsupported,
      warnings: summary.warnings?.length
        ? ["该来源存在解析或覆盖限制，请检查会话详情。"]
        : [],
    };
    const entry =
      old &&
      old.descriptor.sourceRevision === descriptor.sourceRevision &&
      old.binding.identity === binding.identity &&
      old.binding.revision === binding.revision
        ? Object.assign(old, { descriptor, reader, summary: value, binding })
        : { descriptor, reader, summary: value, binding };
    if (!this.entries.has(id) && this.entries.size >= MAX_CONVERSATIONS * 2) {
      const victim = this.entries.keys().next().value!;
      const prior = this.entries.get(victim)!;
      this.entries.delete(victim);
      this.sourceIds.delete(
        prior.reader.provider + ":" + prior.descriptor.sourceKey,
      );
    }
    this.entries.set(id, entry);
    this.sourceIds.set(sourceKey, id);
    return entry;
  }
  private cursor(value: Cursor) {
    const id = randomUUID();
    if (this.cursors.size >= 1000)
      this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(id, value);
    return id;
  }
  private listPage(
    snapshot: Snapshot,
    offset: number,
    limit: number,
    requestId: string,
  ): ConversationListPage {
    this.assert(snapshot.binding);
    const next = offset + limit;
    return {
      requestId,
      snapshotId: snapshot.id,
      queryFingerprint: snapshot.fingerprint,
      consentRevision: snapshot.binding.revision,
      provider: snapshot.binding.provider,
      root: snapshot.binding.root,
      items: snapshot.items.slice(offset, next),
      nextCursor:
        next < snapshot.items.length
          ? this.cursor({ kind: "list", snapshot, offset: next })
          : null,
      scannedConversations: snapshot.scanned,
      matchedConversations: snapshot.items.length,
      partial: snapshot.partial,
      warnings: [...snapshot.warnings],
    };
  }
  async list(input: ConversationQuery): Promise<ConversationListPage> {
    const query = this.query(input);
    const state = this.start(input.requestId, "list");
    let dispose = async () => {};
    try {
      const binding = await this.binding();
      this.check(binding, state.controller.signal);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(query))
        .digest("hex");
      if (input.cursor !== undefined) {
        const saved = this.cursors.get(input.cursor);
        if (
          !saved ||
          saved.kind !== "list" ||
          saved.snapshot.fingerprint !== fingerprint ||
          this.clock() - saved.snapshot.created > 10 * 60_000
        )
          throw Error(FAIL.cursor);
        return this.listPage(
          saved.snapshot,
          saved.offset,
          query.limit,
          input.requestId,
        );
      }
      const reader =
        binding.reader ??
        this.options.readers.find(
          (reader) => reader.provider === binding.provider,
        );
      if (!reader) throw Error(FAIL.read);
      const warnings: string[] = [];
      const setup = this.context(
        binding,
        state.controller.signal,
        input.requestId,
        warnings,
      );
      dispose = setup.dispose;
      const found: ConversationSummary[] = [];
      let scanned = 0,
        partial = false,
        searchBytes = 0;
      const started = this.clock();
      const seen = new Set<string>();
      for await (const descriptor of reader.enumerate(setup.context)) {
        this.check(binding, state.controller.signal);
        if (
          scanned >= MAX_CONVERSATIONS ||
          this.clock() - started > MAX_QUERY_MS
        ) {
          partial = true;
          warnings.push("已达到本次检索范围上限，结果不完整；请缩小筛选范围。");
          break;
        }
        if (seen.has(descriptor.sourceKey)) {
          partial = true;
          warnings.push("重复来源已跳过，请检查会话范围。");
          continue;
        }
        seen.add(descriptor.sourceKey);
        scanned++;
        const entry = this.register(descriptor, reader, binding);
        const summary = entry.summary;
        if (
          query.title &&
          !normalized(summary.title).includes(normalized(query.title))
        )
          continue;
        if (
          query.project &&
          !normalized(summary.project ?? "").includes(normalized(query.project))
        )
          continue;
        const date = summary[query.field as "createdAt" | "updatedAt"];
        const stamp = date ? Date.parse(date) : null;
        if (query.from !== null || query.to !== null) {
          if (stamp === null && !query.includeUnknown) continue;
          if (
            stamp !== null &&
            ((query.from !== null && stamp < query.from) ||
              (query.to !== null && stamp >= query.to))
          )
            continue;
        }
        if (query.keyword) {
          const needle = normalized(query.keyword);
          let match =
            query.scope !== "content" &&
            normalized(summary.title + "\n" + (summary.project ?? "")).includes(
              needle,
            );
          if (!match && query.scope !== "title-project") {
            let native: unknown = undefined;
            const matcher = new ConversationContentMatcher(query.keyword);
            let pages = 0;
            while (true) {
              this.check(binding, state.controller.signal);
              if (
                ++pages > MAX_SCAN_PAGES ||
                searchBytes > MAX_SEARCH_BYTES ||
                this.clock() - started > MAX_QUERY_MS
              ) {
                partial = true;
                warnings.push("正文搜索达到安全预算，尚未检查所有内容。");
                break;
              }
              const page = await reader.read(setup.context, descriptor, {
                cursor: native,
                limit: 100,
              });
              partial ||= page.partial;
              for (const message of messages(page.messages)) {
                for (
                  let partIndex = 0;
                  partIndex < message.parts.length;
                  partIndex++
                ) {
                  const part = message.parts[partIndex];
                  if (part.type === "notice" || part.type === "attachment")
                    continue;
                  const key = message.continuation
                    ? JSON.stringify([
                        message.continuation.messageId,
                        message.continuation.partIndex,
                        part.type,
                      ])
                    : JSON.stringify([message.id, partIndex]);
                  searchBytes += Buffer.byteLength(part.text);
                  matcher.consume(
                    key,
                    part.text,
                    !!message.continuation?.hasMore,
                  );
                  if (matcher.matched) match = true;
                  if (matcher.partial) {
                    partial = true;
                    if (
                      !warnings.includes(
                        "极长的组合字符序列超过规范化缓存，正文匹配范围不完整。",
                      )
                    )
                      warnings.push(
                        "极长的组合字符序列超过规范化缓存，正文匹配范围不完整。",
                      );
                  }
                }
              }
              if (page.nextCursor === null) {
                matcher.finish();
                match ||= matcher.matched;
              }
              if (match || page.nextCursor === null) break;
              const previous = JSON.stringify(native);
              native = page.nextCursor;
              if (JSON.stringify(native) === previous) {
                partial = true;
                warnings.push("来源分页未能前进，已停止搜索。");
                break;
              }
            }
          }
          if (!match) continue;
        }
        found.push(summary);
      }
      this.check(binding, state.controller.signal);
      await binding.verify();
      this.check(binding, state.controller.signal);
      partial ||= warnings.length > 0;
      found.sort((a, b) => {
        if (query.sort === "title")
          return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
        const key = query.sort === "created-desc" ? "createdAt" : "updatedAt";
        const av = a[key] ? Date.parse(a[key]!) : -Infinity,
          bv = b[key] ? Date.parse(b[key]!) : -Infinity;
        return bv - av || a.id.localeCompare(b.id);
      });
      const snapshot: Snapshot = {
        id: randomUUID(),
        fingerprint,
        binding,
        items: found,
        scanned,
        partial,
        warnings: [...new Set(warnings)].slice(0, 20),
        created: this.clock(),
      };
      const snapshots = [
        ...new Set(
          [...this.cursors.values()]
            .filter((c) => c.kind === "list")
            .map((c) => (c.kind === "list" ? c.snapshot.id : "")),
        ),
      ];
      if (snapshots.length >= 20) {
        const victim = snapshots[0];
        for (const [id, cursor] of this.cursors)
          if (cursor.kind === "list" && cursor.snapshot.id === victim)
            this.cursors.delete(id);
      }
      return this.listPage(snapshot, 0, query.limit, input.requestId);
    } catch (error) {
      if (state.controller.signal.aborted) throw Error(FAIL.cancel);
      if (error instanceof Error && Object.values(FAIL).includes(error.message))
        throw error;
      throw Error(FAIL.read);
    } finally {
      await dispose();
      state.end();
    }
  }
  private entry(id: unknown, binding: Binding) {
    if (typeof id !== "string" || !UUID.test(id)) throw Error(FAIL.cursor);
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.binding.identity !== binding.identity ||
      entry.binding.revision !== binding.revision
    )
      throw Error(FAIL.cursor);
    return entry;
  }
  async read(input: ConversationReadRequest): Promise<ConversationMessagePage> {
    if (!record(input)) throw Error(FAIL.query);
    const state = this.start(input.requestId, "read");
    let dispose = async () => {};
    try {
      const binding = await this.binding();
      const entry = this.entry(input.conversationId, binding);
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw Error(FAIL.query);
      let native: unknown = undefined;
      if (input.cursor !== undefined) {
        const cursor = this.cursors.get(input.cursor);
        if (
          !cursor ||
          cursor.kind !== "read" ||
          cursor.entry !== entry ||
          this.clock() - cursor.created > 10 * 60_000
        )
          throw Error(FAIL.cursor);
        native = cursor.native;
      }
      const warnings: string[] = [];
      const setup = this.context(
        binding,
        state.controller.signal,
        input.requestId,
        warnings,
      );
      dispose = setup.dispose;
      const result = await entry.reader.read(setup.context, entry.descriptor, {
        cursor: native,
        limit,
      });
      this.check(binding, state.controller.signal);
      await binding.verify();
      this.check(binding, state.controller.signal);
      const safeMessages = messages(result.messages);
      return {
        requestId: input.requestId,
        conversation: entry.summary,
        messages: safeMessages,
        nextCursor:
          result.nextCursor === null
            ? null
            : this.cursor({
                kind: "read",
                entry,
                native: result.nextCursor,
                created: this.clock(),
              }),
        partial: result.partial || warnings.length > 0,
        warnings: result.warnings.length
          ? ["部分内容有格式、来源或覆盖限制；原始数据未改变。"]
          : warnings,
      };
    } catch (error) {
      if (state.controller.signal.aborted) throw Error(FAIL.cancel);
      if (error instanceof Error && Object.values(FAIL).includes(error.message))
        throw error;
      throw Error(FAIL.read);
    } finally {
      await dispose();
      state.end();
    }
  }
  async previewArchive(ids: string[]): Promise<ConversationArchivePreview> {
    const state = this.start(randomUUID(), "preview");
    let engineToken: string | undefined;
    let binding: Binding | undefined;
    let dispose = async () => {};
    try {
      binding = await this.binding();
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 20 ||
        new Set(ids).size !== ids.length
      )
        throw Error(FAIL.query);
      const entries = ids.map((id) => this.entry(id, binding!));
      if (!binding.engine || entries.some((entry) => !entry.summary.canArchive))
        throw Error(FAIL.unsupported);
      const requestId = randomUUID();
      state.controller.signal.addEventListener(
        "abort",
        () => binding?.engine?.cancelScan(requestId),
        { once: true },
      );
      const scan = await binding.engine.scan({
        requestId,
        minAgeDays: 30,
        includeSessions: true,
      });
      this.check(binding, state.controller.signal);
      const setup = this.context(
        binding,
        state.controller.signal,
        requestId,
        [],
      );
      dispose = setup.dispose;
      for (const entry of entries) {
        await entry.reader.read(setup.context, entry.descriptor, { limit: 1 });
        this.check(binding, state.controller.signal);
      }
      const fileIds = entries.map((entry) => {
        const row = scan.entries.find(
          (row) => row.path === entry.descriptor.locator.relativePath,
        );
        if (!row?.selectable || !row.cleanupUnit)
          throw Error("会话仍活跃、最近修改或关联成员尚未通过完整组验证。");
        return row.id;
      });
      const preview = await binding.engine.preview(fileIds);
      engineToken = preview.token;
      this.check(binding, state.controller.signal);
      const token = randomUUID();
      const value = { ...preview, token };
      this.previews.set(token, { binding, engineToken, value });
      return {
        conversations: entries.map((entry) => entry.summary),
        preview: value,
      };
    } catch (error) {
      if (engineToken && binding)
        binding.engine?.invalidatePreview(engineToken);
      if (state.controller.signal.aborted) throw Error(FAIL.cancel);
      if (
        error instanceof Error &&
        (Object.values(FAIL).includes(error.message) ||
          error.message.startsWith("会话仍活跃"))
      )
        throw error;
      throw Error(FAIL.read);
    } finally {
      await dispose();
      state.end();
    }
  }
  ownsPreview(token: string) {
    return this.previews.has(token);
  }
  async quarantine(token: string, closed: boolean): Promise<OperationResult> {
    const saved = this.previews.get(token);
    this.previews.delete(token);
    if (!saved) throw Error(FAIL.cursor);
    this.assert(saved.binding);
    if (!saved.binding.engine) throw Error(FAIL.unsupported);
    return saved.binding.engine.quarantine(saved.engineToken, closed, () =>
      this.assert(saved.binding),
    );
  }
}
