import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  ConversationMessage,
  ConversationPart,
} from "../../shared/conversations.js";
import type {
  ConversationReader,
  ConversationReaderContext,
  ConversationDescriptor,
  ReaderSummary,
} from "./types.js";
import {
  withCursorSnapshot,
  openCursorSnapshot,
  CURSOR_SNAPSHOT_LIMIT,
  type CursorSnapshot,
  CursorReadError,
} from "./cursor-snapshot.js";
import {
  checkConversationAbort,
  openConversationFile,
  ConversationReadError,
} from "./safe-read.js";
import { readJsonl } from "./jsonl.js";
import { messageChunk } from "./jsonl-content.js";

const MAX_CONVERSATIONS = 5000;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const DB =
  /^User\/(?:globalStorage|workspaceStorage\/[a-zA-Z0-9_-]{1,128})\/state\.vscdb$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
interface SqlItem extends Omit<ReaderSummary, "project" | "sourceLabel"> {
  composerId: string;
}
interface SqlResult {
  ok: boolean;
  code?: string;
  items?: SqlItem[];
  next?: unknown;
  messages?: ConversationMessage[];
  partial?: boolean;
  warnings?: string[];
  composerIds?: string[];
  indexOnly?: boolean;
}

/** Directory enumeration must not walk linked parents before safe-file checks. */
async function safeDirectory(target: string): Promise<() => Promise<void>> {
  if (
    !path.isAbsolute(target) ||
    path.normalize(target) !== target ||
    /[\x00-\x1f\x7f]/.test(target)
  )
    throw new CursorReadError("CURSOR_UNSAFE_DIRECTORY");
  let current = path.parse(target).root;
  const pins: { path: string; dev: number; ino: number }[] = [];
  for (const component of target
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new CursorReadError("CURSOR_UNSAFE_DIRECTORY");
    pins.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return async () => {
    for (const pin of pins) {
      const stat = await fs.lstat(pin.path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== pin.dev ||
        stat.ino !== pin.ino
      )
        throw new CursorReadError("CURSOR_SOURCE_CHANGED");
    }
  };
}

async function useSnapshot<T>(
  context: ConversationReaderContext,
  relative: string,
  use: (snapshot: string, fingerprint: string) => Promise<T>,
  expected?: string,
): Promise<T> {
  if (!context.cache || !context.registerCleanup)
    return withCursorSnapshot(
      context.root,
      relative,
      context.signal,
      use,
      expected,
    );
  const key = `cursor-snapshot:${context.root}:${relative}`;
  let snapshot = context.cache.get(key) as CursorSnapshot | undefined;
  if (!snapshot) {
    const used = Number(context.cache.get("cursor-snapshot-bytes") ?? 0);
    snapshot = await openCursorSnapshot(
      context.root,
      relative,
      context.signal,
      expected,
      CURSOR_SNAPSHOT_LIMIT - used,
    );
    context.cache.set("cursor-snapshot-bytes", used + snapshot.bytes);
    // Retain at most the global copy. Workspace copies are small metadata joins
    // or explicit reads and are disposed immediately, preventing many live copies.
    if (relative.includes("workspaceStorage/")) {
      try {
        const result = await use(snapshot.path, snapshot.fingerprint);
        await snapshot.verify();
        return result;
      } finally {
        await snapshot.close();
      }
    }
    context.cache.set(key, snapshot);
    context.registerCleanup(() => snapshot!.close());
  }
  if (expected && snapshot.fingerprint !== expected)
    throw new CursorReadError("CURSOR_SOURCE_CHANGED");
  await snapshot.verify();
  const result = await use(snapshot.path, snapshot.fingerprint);
  await snapshot.verify();
  return result;
}

function sql(
  snapshot: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SqlResult> {
  checkConversationAbort(signal);
  const built = typeof __dirname === "string";
  const base = built
    ? __dirname.replace(/\.asar([\\/])/g, ".asar.unpacked$1")
    : path.dirname(fileURLToPath(import.meta.url));
  const worker = new Worker(
    path.join(base, built ? "cursor-sql-worker.cjs" : "cursor-sql-worker.ts"),
    {
      workerData: { ...request, path: snapshot },
      execArgv: built ? [] : ["--experimental-strip-types"],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (result?: SqlResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      await worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result!);
    };
    const cancel = () => {
      void finish(
        undefined,
        new ConversationReadError("CONVERSATION_CANCELLED"),
      );
    };
    const timer = setTimeout(() => {
      void finish(undefined, new CursorReadError("CURSOR_READ_TIMEOUT"));
    }, 10_000);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once("message", (data: SqlResult) => {
      if (!data || typeof data !== "object" || data.ok !== true)
        void finish(
          undefined,
          new CursorReadError(data?.code ?? "CURSOR_WORKER_FAILED"),
        );
      else void finish(data);
    });
    worker.once("error", () => {
      void finish(undefined, new CursorReadError("CURSOR_WORKER_FAILED"));
    });
    worker.once("exit", () => {
      if (!settled)
        void finish(undefined, new CursorReadError("CURSOR_WORKER_FAILED"));
    });
    if (signal?.aborted) cancel();
  });
}

function explain(error: unknown): string {
  const code = error instanceof CursorReadError ? error.code : "";
  if (code === "CURSOR_SNAPSHOT_SIZE_LIMIT")
    return "Cursor's database exceeds the 512 MiB safe-copy limit. Select a native transcript export instead; no database data was changed.";
  if (code === "CURSOR_SOURCE_CHANGED")
    return "Cursor storage changed during reading. Close Cursor and refresh to obtain a stable view.";
  if (code === "CURSOR_ROLLBACK_JOURNAL_PRESENT")
    return "Cursor has an outstanding rollback journal. Reopen and close Cursor normally before trying again.";
  if (code === "CURSOR_UNSUPPORTED_SCHEMA")
    return "This Cursor database layout is not supported. Its contents remain protected; use a native transcript export.";
  if (code === "CURSOR_READ_TIMEOUT")
    return "Cursor's database query reached the safety time limit and was cancelled.";
  if (code === "CURSOR_WINDOWS_PRIVACY_UNVERIFIED")
    return "Cursor database reading is disabled until Windows private-snapshot ACL validation passes native testing. A separately selected transcript can still be viewed.";
  if (code === "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE")
    return "Private local snapshot storage is unavailable. No Cursor database content was copied; a separately selected transcript can still be viewed.";
  return "A Cursor conversation source could not be read safely. Its contents remain unchanged.";
}
function warningCode(
  error: unknown,
):
  | "SNAPSHOT_LIMIT"
  | "SOURCE_CHANGED"
  | "UNSUPPORTED_SCHEMA"
  | "PRIVATE_STORAGE_UNAVAILABLE"
  | "READ_LIMIT"
  | "PARTIAL_PARSE" {
  if (
    error instanceof ConversationReadError &&
    error.code === "CONVERSATION_CHANGED"
  )
    return "SOURCE_CHANGED";
  const code = error instanceof CursorReadError ? error.code : "";
  if (code === "CURSOR_SNAPSHOT_SIZE_LIMIT") return "SNAPSHOT_LIMIT";
  if (code === "CURSOR_SOURCE_CHANGED") return "SOURCE_CHANGED";
  if (code.startsWith("CURSOR_UNSUPPORTED_")) return "UNSUPPORTED_SCHEMA";
  if (
    code === "CURSOR_WINDOWS_PRIVACY_UNVERIFIED" ||
    code === "CURSOR_PRIVATE_SNAPSHOT_STORAGE_UNAVAILABLE" ||
    code === "CURSOR_SNAPSHOT_NO_SPACE"
  )
    return "PRIVATE_STORAGE_UNAVAILABLE";
  if (code === "CURSOR_READ_TIMEOUT") return "READ_LIMIT";
  return "PARTIAL_PARSE";
}
async function project(
  root: string,
  relative: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let file: Awaited<ReturnType<typeof openConversationFile>> | undefined;
  try {
    file = await openConversationFile(
      root,
      relative.replace(/state\.vscdb$/, "workspace.json"),
      signal,
    );
    if (file.stat.size > 64 * 1024) return null;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await file.handle.readFile(),
      ),
    );
    await file.verifyUnchanged();
    if (!isObject(value)) return null;
    const uri =
      typeof value.folder === "string"
        ? value.folder
        : typeof value.workspace === "string"
          ? value.workspace
          : null;
    return uri && uri.length <= 4096 && !/[\x00-\x1f\x7f]/.test(uri)
      ? uri
      : null;
  } catch {
    checkConversationAbort(signal);
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
async function databasePaths(
  context: ConversationReaderContext,
): Promise<string[]> {
  const result = ["User/globalStorage/state.vscdb"];
  let handle: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    const ws = path.join(context.root, "User/workspaceStorage");
    const verify = await safeDirectory(ws);
    handle = await fs.opendir(ws);
    let count = 0;
    for await (const entry of handle) {
      checkConversationAbort(context.signal);
      if (++count > 2048) {
        context.warn?.(
          "Cursor workspace enumeration reached its safety limit.",
          "READ_LIMIT",
        );
        break;
      }
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)
      )
        result.push(`User/workspaceStorage/${entry.name}/state.vscdb`);
      if (result.length >= 128) {
        context.warn?.(
          "Cursor database discovery reached its safety limit.",
          "READ_LIMIT",
        );
        break;
      }
    }
    await verify();
  } catch (error) {
    checkConversationAbort(context.signal);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      context.warn?.(
        "Cursor workspace directories could not be enumerated safely.",
        "PARTIAL_PARSE",
      );
    return ["User/globalStorage/state.vscdb"];
  }
  return result;
}

/** Public forum-evidenced composer/bubble shapes, never a canonical mutation adapter. */
export const cursorConversationReader: ConversationReader = {
  provider: "cursor",
  async *enumerate(context) {
    let count = 0;
    const paths = await databasePaths(context);
    if (context.cache && context.registerCleanup) {
      // Reserve the global source before project metadata spends the request
      // quota. A missing/oversized global source is reported in its normal pass.
      try {
        await useSnapshot(context, paths[0], async () => undefined);
      } catch {
        checkConversationAbort(context.signal);
      }
    }
    const projects = new Map<string, Set<string>>();
    const ownProject = new Map<string, string>();
    const indexOnly = new Set<string>();
    for (const relative of paths.filter((p) =>
      p.includes("workspaceStorage"),
    )) {
      const projectName = await project(context.root, relative, context.signal);
      if (projectName) ownProject.set(relative, projectName);
      try {
        const index = await useSnapshot(context, relative, (snapshot) =>
          sql(
            snapshot,
            { mode: "workspace-index", limit: 100 },
            context.signal,
          ),
        );
        if (index.indexOnly) indexOnly.add(relative);
        if (projectName)
          for (const composerId of index.composerIds ?? []) {
            const matched = projects.get(composerId) ?? new Set<string>();
            matched.add(projectName);
            projects.set(composerId, matched);
          }
      } catch (error) {
        checkConversationAbort(context.signal);
        if (
          error instanceof CursorReadError &&
          error.code === "CURSOR_SNAPSHOT_SIZE_LIMIT"
        )
          context.warn?.(
            "Cursor's cumulative snapshot budget was reached; some project mappings were not read.",
            "SNAPSHOT_LIMIT",
          );
        // Unknown project is preferable to a guessed association.
      }
    }
    for (const relative of paths) {
      if (indexOnly.has(relative)) continue;
      checkConversationAbort(context.signal);
      let descriptors: ConversationDescriptor[];
      try {
        descriptors = await useSnapshot(
          context,
          relative,
          async (snapshot, fingerprint) => {
            const records: ConversationDescriptor[] = [];
            for (const mode of ["list", "headers"]) {
              let after: string | undefined;
              do {
                const page = await sql(
                  snapshot,
                  { mode, after, limit: 100 },
                  context.signal,
                );
                for (const warning of page.warnings ?? [])
                  context.warn?.(warning, "PARTIAL_PARSE");
                for (const item of page.items ?? []) {
                  if (++count > MAX_CONVERSATIONS) {
                    context.warn?.(
                      "Cursor conversation enumeration reached its safety limit.",
                      "READ_LIMIT",
                    );
                    return records;
                  }
                  const { composerId, ...summary } = item;
                  const matchedProjects = projects.get(composerId);
                  const projectName =
                    ownProject.get(relative) ??
                    (matchedProjects?.size === 1
                      ? [...matchedProjects][0]
                      : null);
                  if (
                    !projectName &&
                    matchedProjects &&
                    matchedProjects.size > 1
                  )
                    summary.warnings.push(
                      "This conversation is indexed by multiple projects; no single project was inferred.",
                    );
                  records.push({
                    sourceKey: `${relative}:${composerId}`,
                    sourceRevision: fingerprint,
                    summary: {
                      ...summary,
                      project: projectName,
                      sourceLabel:
                        "Cursor SQLite · read-only compatibility view",
                    },
                    locator: { database: relative, composerId, fingerprint },
                  });
                }
                after = typeof page.next === "string" ? page.next : undefined;
              } while (after && count < MAX_CONVERSATIONS);
            }
            return records;
          },
        );
      } catch (error) {
        checkConversationAbort(context.signal);
        if (!(
          error instanceof CursorReadError &&
          error.code === "CURSOR_DATABASE_MISSING"
        ))
          context.warn?.(explain(error), warningCode(error));
        continue;
      }
      for (const descriptor of descriptors) {
        checkConversationAbort(context.signal);
        yield descriptor;
      }
      if (count >= MAX_CONVERSATIONS) break;
    }
  },
  async read(context, descriptor, options) {
    const { database, composerId, fingerprint } = descriptor.locator;
    if (
      typeof database !== "string" ||
      !DB.test(database) ||
      typeof composerId !== "string" ||
      !ID.test(composerId) ||
      typeof fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      descriptor.sourceKey !== `${database}:${composerId}`
    )
      throw new CursorReadError("CURSOR_INVALID_DESCRIPTOR");
    let index = 0,
      textOffset = 0;
    if (options.cursor !== undefined) {
      if (typeof options.cursor === "number") index = options.cursor;
      else if (
        isObject(options.cursor) &&
        Object.keys(options.cursor).sort().join(",") === "index,textOffset" &&
        typeof options.cursor.index === "number" &&
        typeof options.cursor.textOffset === "number"
      ) {
        index = options.cursor.index;
        textOffset = options.cursor.textOffset;
      } else throw new CursorReadError("CURSOR_INVALID_CURSOR");
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !Number.isSafeInteger(textOffset) ||
        textOffset < 0
      )
        throw new CursorReadError("CURSOR_INVALID_CURSOR");
    }
    if (descriptor.sourceRevision !== fingerprint)
      throw new CursorReadError("CURSOR_INVALID_DESCRIPTOR");
    const result = await useSnapshot(
      context,
      database,
      (snapshot) =>
        sql(
          snapshot,
          {
            mode: "read",
            composerId,
            offset: index,
            textOffset,
            limit: options.limit,
          },
          context.signal,
        ),
      fingerprint,
    );
    return {
      messages: result.messages ?? [],
      nextCursor: result.next ?? null,
      partial: result.partial ?? false,
      warnings: result.warnings ?? [],
    };
  },
};

const TRANSCRIPT_WARNING =
  "Cursor's JSONL transcript format can omit tool outputs, message timestamps, IDs, and model metadata. Missing fields are not reconstructed.";
function transcriptMessage(
  value: Record<string, unknown>,
  offset: number,
): ConversationMessage | null {
  if (
    typeof value.role !== "string" ||
    !["user", "assistant", "system", "tool"].includes(value.role) ||
    !isObject(value.message) ||
    !Array.isArray(value.message.content)
  )
    return null;
  const parts: ConversationPart[] = [];
  for (const block of value.message.content.slice(0, 128)) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      let input = "";
      try {
        input = JSON.stringify(block.input ?? null);
      } catch {
        parts.push({
          type: "notice",
          text: "This tool input exceeds the supported nesting depth and could not be rendered safely.",
        });
      }
      parts.push({
        type: "tool-call",
        text: `${block.name.slice(0, 200)}\n${input}`,
      });
    } else
      parts.push({
        type: "notice",
        text: "Unsupported rich or attachment block. No embedded content is executed or fetched.",
      });
  }
  if (value.message.content.length > 128)
    parts.push({
      type: "notice",
      text: "Additional content blocks exceed the display limit.",
    });
  if (!parts.length) return null;
  // Public Cursor transcript rows do not define authoritative message times.
  // In particular, timestamps embedded inside user text are never trusted metadata.
  const result = {
    id: `cursor-transcript-${offset}`,
    role: value.role as ConversationMessage["role"],
    timestamp: null,
    parts,
    source: {
      kind: "imported" as const,
      label: "Cursor native transcript record",
    },
  };
  return result;
}

/**
 * Explicitly selected agent-transcripts directory only. This reader never discovers
 * ~/.cursor from the separate IDE app-data consent or traverses a project tree.
 */
export const cursorTranscriptReader: ConversationReader = {
  provider: "cursor",
  async *enumerate(context) {
    if (path.basename(context.root) !== "agent-transcripts")
      throw new CursorReadError("CURSOR_EXPLICIT_TRANSCRIPT_ROOT_REQUIRED");
    const verifyDirectory = await safeDirectory(context.root);
    const directory = await fs.opendir(context.root);
    let count = 0;
    for await (const entry of directory) {
      checkConversationAbort(context.signal);
      if (++count > MAX_CONVERSATIONS) {
        context.warn?.(
          "Cursor transcript enumeration reached its safety limit.",
          "READ_LIMIT",
        );
        break;
      }
      const stem = entry.name.replace(/\.jsonl$/, "");
      if (!ID.test(stem) || entry.isSymbolicLink()) continue;
      const relative =
        entry.isFile() && entry.name.endsWith(".jsonl")
          ? entry.name
          : entry.isDirectory()
            ? `${entry.name}/${entry.name}.jsonl`
            : null;
      if (!relative) continue;
      let file: Awaited<ReturnType<typeof openConversationFile>> | undefined;
      try {
        file = await openConversationFile(
          context.root,
          relative,
          context.signal,
        );
        let title = stem,
          titleSource: ReaderSummary["titleSource"] = "identifier",
          messages = 0,
          partial = false;
        for await (const line of readJsonl(file.handle, file.stat.size, {
          signal: context.signal,
          maxBytes: 8 * 1024 * 1024,
          maxRecords: 20_000,
        })) {
          if (line.issue) partial = true;
          const message = line.value
            ? transcriptMessage(line.value, line.start)
            : null;
          if (!message) {
            partial = true;
            continue;
          }
          messages++;
          if (message.role === "user" && titleSource === "identifier") {
            const first = message.parts
              .find((p) => p.type === "text" && p.text.trim())
              ?.text.trim();
            if (first) {
              title = first.replace(/\s+/g, " ").slice(0, 200);
              titleSource = "first-user-message";
            }
          }
        }
        await file.verifyUnchanged();
        await verifyDirectory();
        yield {
          sourceKey: `transcript:${relative}`,
          sourceRevision: file.fingerprint,
          summary: {
            title,
            titleSource,
            project: null,
            createdAt: null,
            updatedAt: null,
            timeSource: "unknown",
            messageCount: partial ? null : messages,
            sizeBytes: file.stat.size,
            sourceLabel: "Cursor native JSONL transcript · selected folder",
            identityVerified: false,
            warnings: [
              TRANSCRIPT_WARNING,
              ...(partial
                ? [
                    "Transcript metadata scan is incomplete or contains malformed records.",
                  ]
                : []),
            ],
          },
          locator: { transcript: relative, fingerprint: file.fingerprint },
        };
      } catch {
        checkConversationAbort(context.signal);
        context.warn?.(
          "A Cursor transcript could not be read safely.",
          "PARTIAL_PARSE",
        );
      } finally {
        await file?.close().catch(() => {});
      }
    }
  },
  async read(context, descriptor, options) {
    if (path.basename(context.root) !== "agent-transcripts")
      throw new CursorReadError("CURSOR_EXPLICIT_TRANSCRIPT_ROOT_REQUIRED");
    const relative = descriptor.locator.transcript;
    if (
      typeof relative !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}(?:\/[A-Za-z0-9_-]{1,200})?\.jsonl$/.test(
        relative,
      ) ||
      descriptor.sourceKey !== `transcript:${relative}`
    )
      throw new CursorReadError("CURSOR_INVALID_DESCRIPTOR");
    const file = await openConversationFile(
      context.root,
      relative,
      context.signal,
    );
    try {
      if (file.fingerprint !== descriptor.locator.fingerprint)
        throw new CursorReadError("CURSOR_SOURCE_CHANGED");
      let start = 0,
        characterOffset = 0;
      if (typeof options.cursor === "number") start = options.cursor;
      else if (options.cursor !== undefined) {
        if (
          !isObject(options.cursor) ||
          Object.keys(options.cursor).sort().join(",") !==
            "byteOffset,characterOffset" ||
          typeof options.cursor.byteOffset !== "number" ||
          typeof options.cursor.characterOffset !== "number"
        )
          throw new CursorReadError("CURSOR_INVALID_CURSOR");
        start = options.cursor.byteOffset;
        characterOffset = options.cursor.characterOffset;
      }
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > file.stat.size ||
        !Number.isSafeInteger(characterOffset) ||
        characterOffset < 0
      )
        throw new CursorReadError("CURSOR_INVALID_CURSOR");
      if (start > 0) {
        const b = Buffer.alloc(1);
        await file.handle.read(b, 0, 1, start - 1);
        if (b[0] !== 10) throw new CursorReadError("CURSOR_INVALID_CURSOR");
      }
      const messages: ConversationMessage[] = [],
        warnings = [TRANSCRIPT_WARNING];
      let next = start,
        partial = false,
        bytes = 0;
      let continuation:
        { byteOffset: number; characterOffset: number } | undefined;
      const limit = Math.max(
        1,
        Math.min(100, Number.isInteger(options.limit) ? options.limit : 50),
      );
      for await (const line of readJsonl(file.handle, file.stat.size, {
        start,
        signal: context.signal,
        maxBytes: 8 * 1024 * 1024,
        maxRecords: 20_000,
      })) {
        if (line.issue) {
          partial = true;
          if (
            !warnings.includes(
              "Some records are malformed, incomplete, or beyond safety limits.",
            )
          )
            warnings.push(
              "Some records are malformed, incomplete, or beyond safety limits.",
            );
        }
        if (line.issue === "scan-limit" || line.issue === "record-limit") break;
        next = line.end;
        const message = line.value
          ? transcriptMessage(line.value, line.start)
          : null;
        if (message) {
          const chunk = messageChunk(
            message,
            line.start === start ? characterOffset : 0,
          );
          messages.push(chunk.message);
          bytes += Buffer.byteLength(JSON.stringify(chunk.message));
          if (message.parts.some((p) => p.type === "notice")) {
            partial = true;
            warnings.push(
              "Some rich or attachment blocks are not represented as conversation text.",
            );
          }
          if (chunk.nextCharacter !== null) {
            continuation = {
              byteOffset: line.start,
              characterOffset: chunk.nextCharacter,
            };
            break;
          }
        } else {
          if (line.start === start && characterOffset)
            throw new CursorReadError("CURSOR_INVALID_CURSOR");
          partial = true;
          warnings.push(
            "Some transcript records have an unsupported message shape.",
          );
        }
        if (messages.length >= limit || bytes >= 1024 * 1024) break;
      }
      await file.verifyUnchanged();
      return {
        messages,
        nextCursor:
          continuation ?? (next < file.stat.size && next > start ? next : null),
        partial: partial || (next < file.stat.size && next === start),
        warnings: [...new Set(warnings)],
      };
    } finally {
      await file.close();
    }
  },
};
