import type { ProviderId, Preview } from "./types.js";
export type ConversationRole =
  "user" | "assistant" | "system" | "tool" | "unknown";
export interface ConversationSummary {
  id: string;
  provider: ProviderId;
  title: string;
  titleSource: "native" | "first-user-message" | "identifier" | "unknown";
  project: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  timeSource: "native" | "messages" | "unknown";
  createdAtSource?: "native" | "messages" | "unknown";
  updatedAtSource?: "native" | "messages" | "unknown";
  messageCount: number | null;
  sizeBytes: number;
  sourceLabel: string;
  identityVerified: boolean;
  canArchive: boolean;
  archiveReason: string;
  warnings: string[];
}
export interface ConversationPart {
  type:
    "text" | "tool-call" | "tool-result" | "thinking" | "attachment" | "notice";
  text: string;
}
export interface ConversationMessage {
  source?: {
    kind: "main" | "subagent" | "branch" | "imported";
    label: string;
    id?: string;
  };
  continuation?: {
    messageId: string;
    partIndex: number;
    offset: number;
    hasMore: boolean;
  };
  id: string;
  role: ConversationRole;
  timestamp: string | null;
  parts: ConversationPart[];
}
export interface ConversationQuery {
  requestId: string;
  title?: string;
  keyword?: string;
  searchScope?: "content" | "title-project" | "all";
  project?: string;
  from?: string;
  /** Exclusive boundary, e.g. start of next LOCAL calendar day converted to ISO. */
  to?: string;
  dateField?: "createdAt" | "updatedAt";
  includeUnknownTimes?: boolean;
  sort?: "created-desc" | "updated-desc" | "title";
  limit?: number;
  cursor?: string;
}
export interface ConversationListPage {
  snapshotId: string;
  queryFingerprint: string;
  consentRevision: string;
  matchedConversations: number;
  requestId: string;
  provider: ProviderId;
  root: string;
  items: ConversationSummary[];
  nextCursor: string | null;
  scannedConversations: number;
  partial: boolean;
  warnings: string[];
}
export interface ConversationReadRequest {
  requestId: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
}
export interface ConversationMessagePage {
  requestId: string;
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  nextCursor: string | null;
  partial: boolean;
  warnings: string[];
}
export type ConversationSourceKind =
  "selected" | "cline-sdk" | "cursor-transcripts";
export interface ConversationAccess {
  sourceKind?: ConversationSourceKind;
  sourceLabel?: string;
  readOnlySource?: boolean;
  unavailableReason?: string;
  provider: ProviderId;
  root: string | null;
  allowed: boolean;
  revision: string;
}
export interface ConversationArchivePreview {
  conversations: ConversationSummary[];
  preview: Preview;
}
export interface ConversationAPI {
  getConversationAccess(): Promise<ConversationAccess>;
  chooseConversationSource(
    kind: Exclude<ConversationSourceKind, "selected">,
  ): Promise<ConversationAccess | null>;
  resetConversationSource(): Promise<ConversationAccess>;
  setConversationAccess(allowed: boolean): Promise<ConversationAccess>;
  listConversations(request: ConversationQuery): Promise<ConversationListPage>;
  readConversation(
    request: ConversationReadRequest,
  ): Promise<ConversationMessagePage>;
  cancelConversationRequest(requestId: string): Promise<void>;
  previewConversationArchive(
    ids: string[],
  ): Promise<ConversationArchivePreview>;
}
