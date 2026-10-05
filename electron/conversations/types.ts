import type { ProviderId } from "../../shared/types.js";
import type {
  ConversationSummary,
  ConversationMessage,
} from "../../shared/conversations.js";
export type ReaderSummary = Omit<
  ConversationSummary,
  "id" | "provider" | "canArchive" | "archiveReason"
>;
export type ConversationWarningCode =
  | "SNAPSHOT_LIMIT"
  | "SOURCE_CHANGED"
  | "UNSUPPORTED_SCHEMA"
  | "PRIVATE_STORAGE_UNAVAILABLE"
  | "READ_LIMIT"
  | "PARTIAL_PARSE";
export interface ConversationReaderContext {
  root: string;
  signal?: AbortSignal;
  requestId?: string;
  /** Return metadata-only warnings; never put dialogue, credentials or raw database errors here. */
  warn?: (message: string, code?: ConversationWarningCode) => void;
  /** Request-local cache only; service clears it after request and invokes cleanup. */
  cache?: Map<string, unknown>;
  registerCleanup?: (cleanup: () => Promise<void>) => void;
}
/** Node-only: never forward locator or adapter cursors to the renderer. */
export interface ConversationDescriptor {
  sourceKey: string;
  /** Stable source identity/version, independent of title/project display text. */
  sourceRevision: string;
  summary: ReaderSummary;
  locator: Record<string, unknown>;
}
export interface ConversationReaderPage {
  messages: ConversationMessage[];
  nextCursor: unknown | null;
  partial: boolean;
  warnings: string[];
}
export interface ConversationReader {
  readonly provider: ProviderId;
  /** Bounded metadata enumeration, including real source timestamps. No filesystem mtime substitution. */
  enumerate(
    context: ConversationReaderContext,
  ): AsyncIterable<ConversationDescriptor>;
  read(
    context: ConversationReaderContext,
    descriptor: ConversationDescriptor,
    options: { cursor?: unknown; limit: number },
  ): Promise<ConversationReaderPage>;
}
// Reader output never grants cleanup authority. The orchestration layer owns consent,
// opaque IDs/cursors, current-root binding and separately reviewed conversation transactions.
