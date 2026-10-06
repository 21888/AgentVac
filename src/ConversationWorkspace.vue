<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { AppContext } from "../shared/types";
import type {
  ConversationAPI,
  ConversationAccess,
  ConversationArchivePreview,
  ConversationListPage,
  ConversationMessagePage,
  ConversationQuery,
  ConversationSummary,
} from "../shared/conversations";
import ConversationMessageView from "./conversations/ConversationMessage.vue";
import {
  conversationScope,
  conversationPlatformLimit,
} from "./release-support";
import {
  dateBoundary,
  formatConversationSize,
  formatConversationTime,
  hiddenSelection,
  virtualWindow,
} from "./conversations/presentation";
import "./conversations.css";

const props = defineProps<{
  context: AppContext;
  busy: boolean;
  canSign: boolean;
  revision: number;
}>();
const emit = defineEmits<{
  "choose-root": [];
  history: [];
  "archive-preview": [value: ConversationArchivePreview];
  "busy-change": [value: string];
}>();
const api = window.agentvac as typeof window.agentvac &
  Partial<ConversationAPI>;
const supported = [
  "getConversationAccess",
  "setConversationAccess",
  "listConversations",
  "readConversation",
  "cancelConversationRequest",
  "previewConversationArchive",
].every(
  (name) =>
    typeof (api as unknown as Record<string, unknown>)?.[name] === "function",
);
const providerNames: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cline: "Cline",
  cursor: "Cursor",
};
const providerName = computed(
  () => providerNames[props.context.provider] ?? "未知提供方",
);
const access = ref<ConversationAccess | null>(null);
const effectiveRoot = computed(() => access.value?.root ?? props.context.root);
const consent = ref(false);
const accessLoading = ref(false);
const accessChanging = ref(false);
const error = ref("");
const notice = ref("");
const list = ref<ConversationListPage | null>(null);
const listLoading = ref(false);
const listCancelled = ref(false);
const listRequest = ref<string | null>(null);
const listCursors = ref<(string | undefined)[]>([undefined]);
const listPageIndex = ref(0);
const applied = ref("");
const title = ref("");
const keyword = ref("");
const project = ref("");
const from = ref("");
const to = ref("");
const dateField = ref<"createdAt" | "updatedAt">("updatedAt");
const includeUnknownTimes = ref(false);
const sort = ref<"created-desc" | "updated-desc" | "title">("updated-desc");
const filtersOpen = ref(false);
const selected = ref(new Map<string, ConversationSummary>());
const activeId = ref<string | null>(null);
const activeItem = ref<ConversationSummary | null>(null);
const refreshPending = ref(false);
const detail = ref<ConversationMessagePage | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const detailRequest = ref<string | null>(null);
const detailCursors = ref<(string | undefined)[]>([undefined]);
const detailOffsets = ref<number[]>([0]);
const detailPageIndex = ref(0);
const previewLoading = ref(false);
const listViewport = ref<HTMLElement | null>(null);
const detailViewport = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(480);
const rowHeight = 106;
let observer: ResizeObserver | undefined;
let disposed = false;
let sequence = 0;
let accessSequence = 0;
const fingerprint = computed(() =>
  JSON.stringify({
    title: title.value.trim(),
    keyword: keyword.value.trim(),
    project: project.value.trim(),
    from: from.value,
    to: to.value,
    dateField: dateField.value,
    includeUnknownTimes: includeUnknownTimes.value,
    sort: sort.value,
  }),
);
const dirty = computed(
  () => !!list.value && applied.value !== fingerprint.value,
);
const items = computed(() => list.value?.items ?? []);
const visibleWindow = computed(() =>
  virtualWindow(
    items.value.length,
    scrollTop.value,
    viewportHeight.value,
    rowHeight,
  ),
);
const visibleRows = computed(() =>
  items.value.slice(visibleWindow.value.start, visibleWindow.value.end),
);
const hidden = computed(() => hiddenSelection(selected.value, items.value));
const eligiblePage = computed(() =>
  items.value.filter((item) => item.canArchive && item.identityVerified),
);
const allPageSelected = computed(
  () =>
    eligiblePage.value.length > 0 &&
    eligiblePage.value.every((item) => selected.value.has(item.id)),
);
const hasAnyPageSelected = computed(() =>
  eligiblePage.value.some((item) => selected.value.has(item.id)),
);
const selectedBytes = computed(() =>
  [...selected.value.values()].reduce((sum, item) => sum + item.sizeBytes, 0),
);
const contentAllowed = computed(
  () =>
    access.value?.allowed === true &&
    !!access.value.root &&
    access.value.provider === props.context.provider,
);
const interactionBlocked = computed(
  () => props.busy || accessChanging.value || previewLoading.value,
);
const canPreview = computed(
  () =>
    contentAllowed.value &&
    !access.value?.readOnlySource &&
    selected.value.size > 0 &&
    !interactionBlocked.value &&
    !listLoading.value &&
    !listCancelled.value &&
    !dirty.value &&
    props.canSign &&
    [...selected.value.values()].every(
      (item) => item.canArchive && item.identityVerified,
    ),
);
const activeSummary = computed(
  () => detail.value?.conversation ?? activeItem.value,
);
const activeFilterCount = computed(
  () =>
    [
      title.value.trim(),
      keyword.value.trim(),
      project.value.trim(),
      from.value,
      to.value,
    ].filter(Boolean).length,
);
const timezoneLabel = Intl.DateTimeFormat().resolvedOptions().timeZone;
function timeSourceLabel(source: string | undefined) {
  return source === "native"
    ? "原生元数据"
    : source === "messages"
      ? "消息时间戳"
      : "未知";
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
function requestId(_prefix: string) {
  return crypto.randomUUID();
}
function scopeMatches(provider: string, root: string | null) {
  return (
    !disposed &&
    provider === props.context.provider &&
    root === effectiveRoot.value
  );
}
async function cancelRequest(kind: "list" | "detail", announce = true) {
  const request = kind === "list" ? listRequest : detailRequest;
  const id = request.value;
  request.value = null;
  if (kind === "list") {
    listLoading.value = false;
    if (announce) listCancelled.value = true;
  } else {
    detailLoading.value = false;
    if (announce) detailError.value = "读取已取消。可以重新打开这条对话。";
  }
  if (!id) return;
  try {
    await api.cancelConversationRequest?.(id);
  } catch (cause) {
    if (!disposed && announce)
      error.value = `已停止显示此请求；后台取消未确认：${message(cause)}`;
  }
}
function clearContent() {
  void cancelRequest("list", false);
  void cancelRequest("detail", false);
  sequence++;
  list.value = null;
  detail.value = null;
  activeId.value = null;
  activeItem.value = null;
  selected.value = new Map();
  applied.value = "";
  listCursors.value = [undefined];
  listPageIndex.value = 0;
  detailCursors.value = [undefined];
  detailOffsets.value = [0];
  detailPageIndex.value = 0;
}
async function loadAccess() {
  if (!supported) return;
  const generation = ++accessSequence;
  const { provider, root } = props.context;
  accessLoading.value = true;
  try {
    const result = await api.getConversationAccess!();
    if (
      generation !== accessSequence ||
      disposed ||
      provider !== props.context.provider ||
      root !== props.context.root
    )
      return;
    access.value = result;
    if (contentAllowed.value) await queryPage(0, true);
  } catch (cause) {
    if (generation === accessSequence && !disposed)
      error.value = message(cause);
  } finally {
    if (generation === accessSequence) accessLoading.value = false;
  }
}
async function changeAccess(allowed: boolean) {
  if (
    interactionBlocked.value ||
    (allowed && (!consent.value || !!access.value?.unavailableReason)) ||
    !effectiveRoot.value
  )
    return;
  const provider = props.context.provider,
    root = effectiveRoot.value;
  accessChanging.value = true;
  error.value = "";
  emit("busy-change", allowed ? "确认本地内容读取" : "撤回本地内容读取");
  if (!allowed) {
    // Revocation is fail-closed locally even if its IPC acknowledgement fails.
    if (access.value) access.value = { ...access.value, allowed: false };
    consent.value = false;
    clearContent();
  }
  try {
    const result = await api.setConversationAccess!(allowed);
    if (!scopeMatches(provider, root)) return;
    if (
      result.root !== root ||
      result.provider !== provider ||
      result.allowed !== allowed
    )
      throw new Error("读取授权状态与当前请求不一致，请重新确认当前目录。");
    access.value = result;
    if (!allowed) {
      consent.value = false;
      notice.value = "内容读取已撤回，当前列表、正文和选择已清空。";
    }
  } catch (cause) {
    if (!disposed) error.value = message(cause);
  } finally {
    accessChanging.value = false;
    emit("busy-change", "");
  }
  await nextTick();
  if (allowed && contentAllowed.value && !disposed) await queryPage(0, true);
}
async function changeReadSource(reset = false) {
  if (interactionBlocked.value || !supported) return;
  const provider = props.context.provider,
    cleanerRoot = props.context.root;
  const generation = ++accessSequence;
  clearContent();
  consent.value = false;
  error.value = "";
  accessChanging.value = true;
  emit("busy-change", "选择只读会话来源");
  try {
    const result = reset
      ? await api.resetConversationSource!()
      : await api.chooseConversationSource!(
          provider === "cline" ? "cline-sdk" : "cursor-transcripts",
        );
    if (
      disposed ||
      generation !== accessSequence ||
      provider !== props.context.provider ||
      cleanerRoot !== props.context.root
    )
      return;
    access.value = result ?? (await api.getConversationAccess!());
    if (access.value.provider !== provider)
      throw Error("读取来源与当前工具不一致。");
  } catch (cause) {
    if (!disposed) error.value = message(cause);
  } finally {
    accessChanging.value = false;
    emit("busy-change", "");
  }
  if (contentAllowed.value && !disposed) await queryPage(0, true);
}
function makeQuery(cursor?: string): ConversationQuery {
  const lower = dateBoundary(from.value);
  const upper = dateBoundary(to.value, true);
  if (lower && upper && lower > upper)
    throw new Error("开始日期不能晚于结束日期。");
  return {
    requestId: requestId("conversations"),
    title: title.value.trim() || undefined,
    keyword: keyword.value.trim() || undefined,
    project: project.value.trim() || undefined,
    from: lower,
    to: upper,
    dateField: dateField.value,
    includeUnknownTimes: includeUnknownTimes.value,
    sort: sort.value,
    limit: 20,
    cursor,
  };
}
async function queryPage(index: number, reset = false) {
  if (!contentAllowed.value || interactionBlocked.value) return;
  let request: ConversationQuery;
  try {
    request = makeQuery(reset ? undefined : listCursors.value[index]);
  } catch (cause) {
    error.value = message(cause);
    return;
  }
  void cancelRequest("list", false);
  const generation = ++sequence;
  const inputFingerprint = fingerprint.value;
  const provider = props.context.provider,
    root = effectiveRoot.value;
  listLoading.value = true;
  listCancelled.value = false;
  error.value = "";
  notice.value = "";
  listRequest.value = request.requestId;
  try {
    const result = await api.listConversations!(request);
    if (
      generation !== sequence ||
      listRequest.value !== request.requestId ||
      !scopeMatches(provider, root) ||
      !contentAllowed.value
    )
      return;
    if (
      result.requestId !== request.requestId ||
      result.provider !== provider ||
      result.root !== root ||
      result.consentRevision !== access.value?.revision
    )
      throw new Error("对话结果与当前目录或请求不一致，已丢弃。请重新读取。");
    if (
      !reset &&
      index > 0 &&
      list.value &&
      result.snapshotId !== list.value.snapshotId
    )
      throw new Error("分页结果的读取快照已改变，请从第一页重新读取。");
    list.value = result;
    applied.value = inputFingerprint;
    listPageIndex.value = reset ? 0 : index;
    if (reset) listCursors.value = [undefined];
    const cursors = listCursors.value.slice(0, listPageIndex.value + 1);
    if (result.nextCursor) cursors.push(result.nextCursor);
    listCursors.value = cursors;
    // Reconcile selection against backend changes, without inventing eligibility.
    const reconciled = new Map(selected.value);
    for (const item of result.items)
      if (reconciled.has(item.id)) {
        if (item.canArchive && item.identityVerified)
          reconciled.set(item.id, item);
        else reconciled.delete(item.id);
      }
    selected.value = reconciled;
    scrollTop.value = 0;
    await nextTick();
    if (listViewport.value) listViewport.value.scrollTop = 0;
  } catch (cause) {
    if (
      generation === sequence &&
      listRequest.value === request.requestId &&
      !disposed
    ) {
      error.value = message(cause);
      if (list.value) listCancelled.value = true;
    }
  } finally {
    if (listRequest.value === request.requestId) {
      listLoading.value = false;
      listRequest.value = null;
    }
  }
}
function refreshAfterReadError() {
  void cancelRequest("detail", false);
  activeId.value = null;
  activeItem.value = null;
  detail.value = null;
  detailError.value = "";
  void queryPage(0, true);
}
function resetFilters() {
  title.value = "";
  keyword.value = "";
  project.value = "";
  from.value = "";
  to.value = "";
  dateField.value = "updatedAt";
  includeUnknownTimes.value = false;
  sort.value = "updated-desc";
  void queryPage(0, true);
}
async function openConversation(item: ConversationSummary, index = 0) {
  if (
    !contentAllowed.value ||
    interactionBlocked.value ||
    listLoading.value ||
    dirty.value ||
    listCancelled.value
  )
    return;
  if (activeId.value !== item.id) {
    detail.value = null;
    detailCursors.value = [undefined];
    detailOffsets.value = [0];
    index = 0;
  }
  activeId.value = item.id;
  activeItem.value = item;
  void cancelRequest("detail", false);
  const id = requestId("conversation-detail");
  detailRequest.value = id;
  detailLoading.value = true;
  detailError.value = "";
  const provider = props.context.provider,
    root = effectiveRoot.value;
  try {
    const result = await api.readConversation!({
      requestId: id,
      conversationId: item.id,
      cursor: detailCursors.value[index],
      limit: 12,
    });
    if (
      detailRequest.value !== id ||
      activeId.value !== item.id ||
      !scopeMatches(provider, root) ||
      !contentAllowed.value
    )
      return;
    if (
      result.requestId !== id ||
      result.conversation.id !== item.id ||
      result.conversation.provider !== provider
    )
      throw new Error("正文结果与当前对话不一致，已丢弃。");
    detail.value = result;
    detailPageIndex.value = index;
    const cursors = detailCursors.value.slice(0, index + 1);
    const offsets = detailOffsets.value.slice(0, index + 1);
    if (result.nextCursor) {
      cursors.push(result.nextCursor);
      offsets.push((offsets[index] ?? 0) + result.messages.length);
    }
    detailCursors.value = cursors;
    detailOffsets.value = offsets;
    await nextTick();
    if (detailViewport.value) detailViewport.value.scrollTop = 0;
  } catch (cause) {
    if (detailRequest.value === id && !disposed)
      detailError.value = message(cause);
  } finally {
    if (detailRequest.value === id) {
      detailLoading.value = false;
      detailRequest.value = null;
    }
  }
}
function toggleSelection(item: ConversationSummary) {
  if (
    !item.canArchive ||
    !item.identityVerified ||
    interactionBlocked.value ||
    listLoading.value ||
    listCancelled.value ||
    dirty.value
  )
    return;
  const next = new Map(selected.value);
  if (next.has(item.id)) next.delete(item.id);
  else if (next.size >= 20) {
    notice.value = "一次最多选择 20 条对话，请分批预览。";
    return;
  } else next.set(item.id, item);
  selected.value = next;
}
function togglePageSelection() {
  if (
    interactionBlocked.value ||
    listLoading.value ||
    listCancelled.value ||
    dirty.value
  )
    return;
  const next = new Map(selected.value);
  if (allPageSelected.value)
    for (const item of eligiblePage.value) next.delete(item.id);
  else {
    const missing = eligiblePage.value.filter((item) => !next.has(item.id));
    if (next.size + missing.length > 20) {
      notice.value =
        "本页与其他页的选择合计超过 20 条。请先清除部分选择，再按批次预览。";
      return;
    }
    for (const item of missing) next.set(item.id, item);
  }
  selected.value = next;
}
function clearHidden() {
  const visible = new Set(items.value.map((item) => item.id));
  selected.value = new Map(
    [...selected.value].filter(([id]) => visible.has(id)),
  );
}
async function prepareArchive(single?: ConversationSummary) {
  if (single) {
    if (
      !single.canArchive ||
      !single.identityVerified ||
      !props.canSign ||
      interactionBlocked.value ||
      dirty.value ||
      listLoading.value ||
      listCancelled.value
    )
      return;
  } else if (!canPreview.value) return;
  const rows = single ? [single] : [...selected.value.values()];
  const provider = props.context.provider,
    root = effectiveRoot.value;
  previewLoading.value = true;
  error.value = "";
  emit("busy-change", "检查所选对话");
  try {
    const result = await api.previewConversationArchive!(
      rows.map((item) => item.id),
    );
    if (!scopeMatches(provider, root) || !contentAllowed.value) return;
    if (result.preview.provider !== provider || result.preview.root !== root)
      throw new Error("隔离预览与当前目录不一致，已拒绝显示。");
    emit("archive-preview", result);
  } catch (cause) {
    if (!disposed) error.value = message(cause);
  } finally {
    previewLoading.value = false;
    emit("busy-change", "");
  }
}
async function rowKey(event: KeyboardEvent, item: ConversationSummary) {
  const index = items.value.findIndex((row) => row.id === item.id);
  const movement =
    event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowUp"
        ? -1
        : event.key === "PageDown"
          ? 5
          : event.key === "PageUp"
            ? -5
            : 0;
  if (!movement && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.value.length - 1
        : Math.max(0, Math.min(items.value.length - 1, index + movement));
  const viewport = listViewport.value;
  if (!viewport) return;
  const top = next * rowHeight;
  if (
    top < viewport.scrollTop ||
    top + rowHeight > viewport.scrollTop + viewport.clientHeight
  )
    viewport.scrollTop = top;
  scrollTop.value = viewport.scrollTop;
  await nextTick();
  viewport
    .querySelector<HTMLElement>(
      `[data-conversation-index="${next}"] .conversation-open`,
    )
    ?.focus();
}
function keyShortcut(event: KeyboardEvent) {
  if (
    event.key !== "/" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    interactionBlocked.value
  )
    return;
  const target = event.target as HTMLElement;
  if (
    target.matches("input, textarea, select, [contenteditable=true]") ||
    document.querySelector("[aria-modal=true]")
  )
    return;
  event.preventDefault();
  searchInput.value?.focus();
}
watch(listViewport, (element) => {
  observer?.disconnect();
  if (!element) return;
  observer = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight;
  });
  observer.observe(element);
  viewportHeight.value = element.clientHeight;
});
watch(
  [() => props.revision, () => props.busy],
  ([revision, busy], [previousRevision]) => {
    if (revision !== previousRevision) {
      clearContent();
      refreshPending.value = true;
    }
    if (refreshPending.value && !busy && contentAllowed.value) {
      refreshPending.value = false;
      void queryPage(0, true);
    }
  },
);
onMounted(() => {
  void loadAccess();
  document.addEventListener("keydown", keyShortcut);
});
onUnmounted(() => {
  disposed = true;
  accessSequence++;
  sequence++;
  observer?.disconnect();
  document.removeEventListener("keydown", keyShortcut);
  void cancelRequest("list", false);
  void cancelRequest("detail", false);
});
</script>

<template>
  <section
    class="conversation-workspace"
    aria-labelledby="conversation-workspace-title"
    data-testid="conversation-workspace"
  >
    <header class="conversation-heading page-title">
      <div>
        <div class="conversation-eyebrow">LOCAL CONVERSATIONS</div>
        <h1 id="conversation-workspace-title" tabindex="-1">对话管理</h1>
        <p data-testid="conversation-release-scope">
          {{ conversationScope[context.provider] }}
        </p>
      </div>
      <div class="conversation-heading-actions">
        <span v-if="context.demo" class="demo-pill">合成演示数据</span
        ><button
          class="button secondary"
          :disabled="busy"
          @click="emit('history')"
        >
          隔离与恢复
        </button>
      </div>
    </header>
    <p
      class="conversation-feedback"
      role="note"
      data-testid="conversation-platform-limit"
    >
      {{
        conversationPlatformLimit(
          context.provider,
          context.platform,
          !!access?.readOnlySource,
        )
      }}
    </p>
    <div v-if="error" class="conversation-feedback is-warning" role="alert">
      <span>{{ error }}</span
      ><button class="text-button" @click="error = ''">关闭提示</button>
    </div>
    <p v-if="notice" class="conversation-feedback" role="status">
      {{ notice }}
    </p>
    <div
      v-if="supported"
      class="conversation-source-bar"
      data-testid="conversation-source-bar"
    >
      <div>
        <span
          >对话读取目录<span v-if="access?.readOnlySource">
            · 仅只读</span
          ></span
        ><strong>{{ effectiveRoot ?? "尚未选择" }}</strong
        ><small>{{ access?.sourceLabel ?? "当前工具数据目录" }}</small>
      </div>
      <div class="conversation-source-actions">
        <button
          v-if="
            (context.provider === 'cline' || context.provider === 'cursor') &&
            api.chooseConversationSource
          "
          class="button secondary"
          :disabled="interactionBlocked"
          @click="changeReadSource()"
          data-testid="conversation-choose-source"
        >
          {{
            context.provider === "cline"
              ? "选择 SDK 会话目录"
              : "选择 agent-transcripts"
          }}
        </button>
        <button
          v-if="access?.readOnlySource && api.resetConversationSource"
          class="button secondary"
          :disabled="interactionBlocked"
          @click="changeReadSource(true)"
          data-testid="conversation-reset-source"
        >
          使用工具数据目录
        </button>
      </div>
    </div>
    <div v-if="!effectiveRoot" class="conversation-onboarding">
      <div class="conversation-empty-symbol" aria-hidden="true">◌</div>
      <h2>先连接一个对话目录</h2>
      <p>
        选择
        {{ providerName }}
        的本地数据目录。连接目录后，仍需单独同意读取对话内容。
      </p>
      <button
        class="button primary"
        :disabled="busy"
        @click="emit('choose-root')"
      >
        选择 {{ providerName }} 目录
      </button>
    </div>
    <div v-else-if="!supported" class="conversation-onboarding">
      <h2>当前接口不支持对话管理</h2>
      <p>
        请运行包含对话管理接口的 AgentVac
        桌面构建。现有文件分析和恢复功能仍可从导航进入。
      </p>
    </div>
    <div
      v-else-if="accessLoading && !access"
      class="conversation-onboarding"
      role="status"
    >
      <span class="conversation-spinner" aria-hidden="true"></span>
      <h2>正在确认读取范围…</h2>
    </div>
    <div
      v-else-if="!contentAllowed"
      class="conversation-onboarding conversation-consent"
      data-testid="conversation-consent"
      tabindex="0"
      role="region"
      aria-labelledby="conversation-consent-heading"
    >
      <div class="conversation-empty-symbol" aria-hidden="true">◎</div>
      <h2 id="conversation-consent-heading">只在本机，读懂你的对话</h2>
      <p>
        列表、内容搜索与正文预览需要读取所选目录中的对话记录。标题、项目、消息和工具结果可能包含敏感信息。
      </p>
      <div class="conversation-consent-scope">
        <span>{{ providerName }} · 当前读取范围</span
        ><strong>{{ effectiveRoot }}</strong>
        <ul>
          <li>在本机处理，不发送对话内容到网络</li>
          <li>未知格式会标注限制，不按文件修改时间推测对话时间</li>
          <li>内容读取与隔离操作分别确认，可随时撤回读取</li>
        </ul>
      </div>
      <p
        v-if="access?.unavailableReason"
        class="conversation-database-consent"
        role="alert"
        data-testid="conversation-unavailable"
      >
        {{ access.unavailableReason }}
      </p>
      <p
        v-if="context.provider === 'cursor' && !access?.readOnlySource"
        class="conversation-database-consent"
        data-testid="cursor-database-consent"
      >
        Cursor 的只读查询会先把整个数据库复制到 AgentVac
        的私有临时目录。副本也可能包含未查询的设置或认证相关页；不会联网，源文件不会修改。正常结束后清理副本，异常退出时可能残留，直到安全清理。
      </p>
      <label class="conversation-consent-check"
        ><input
          v-model="consent"
          type="checkbox"
          :disabled="accessChanging || busy || !!access?.unavailableReason"
          data-testid="conversation-consent-checkbox"
        /><span
          >我同意在本机读取此目录的对话内容<span
            v-if="context.provider === 'cursor' && !access?.readOnlySource"
            >，并按上述方式创建本地数据库副本</span
          ></span
        ></label
      >
      <button
        class="button primary"
        :disabled="
          !consent || accessChanging || busy || !!access?.unavailableReason
        "
        @click="changeAccess(true)"
        data-testid="conversation-grant"
      >
        {{ accessChanging ? "正在确认…" : "读取本地对话" }}
      </button>
    </div>
    <template v-else>
      <form class="conversation-search" @submit.prevent="queryPage(0, true)">
        <div class="conversation-search-row">
          <label class="conversation-search-input"
            ><span>标题</span
            ><input
              ref="searchInput"
              v-model="title"
              type="search"
              maxlength="300"
              placeholder="搜索对话标题"
              aria-label="搜索对话标题"
              :disabled="interactionBlocked" /></label
          ><label class="conversation-search-input"
            ><span>正文</span
            ><input
              v-model="keyword"
              type="search"
              maxlength="300"
              placeholder="搜索消息与工具内容"
              aria-label="搜索对话全文"
              :disabled="interactionBlocked" /></label
          ><button
            type="button"
            class="button secondary conversation-filter-toggle"
            :aria-expanded="filtersOpen"
            aria-controls="conversation-advanced-filters"
            @click="filtersOpen = !filtersOpen"
          >
            筛选<span
              v-if="activeFilterCount"
              class="conversation-filter-count"
              >{{ activeFilterCount }}</span
            ></button
          ><button
            class="button primary"
            type="submit"
            :disabled="interactionBlocked || listLoading"
            data-testid="conversation-apply"
          >
            应用筛选
          </button>
        </div>
        <div
          v-if="filtersOpen"
          id="conversation-advanced-filters"
          class="conversation-advanced-filters"
        >
          <label
            >项目<input
              v-model="project"
              type="search"
              maxlength="300"
              placeholder="项目名或路径"
              :disabled="interactionBlocked"
              aria-label="按项目筛选"
          /></label>
          <label
            >时间依据<select
              v-model="dateField"
              :disabled="interactionBlocked"
              aria-label="对话时间依据"
            >
              <option value="updatedAt">最后对话时间</option>
              <option value="createdAt">对话创建时间</option>
            </select></label
          >
          <label
            >从<input
              v-model="from"
              type="date"
              :disabled="interactionBlocked"
              aria-label="对话开始日期"
          /></label>
          <label
            >至<input
              v-model="to"
              type="date"
              :disabled="interactionBlocked"
              aria-label="对话结束日期"
          /></label>
          <label
            >排序<select
              v-model="sort"
              :disabled="interactionBlocked"
              aria-label="对话排序"
            >
              <option value="updated-desc">最近对话优先</option>
              <option value="created-desc">最新创建优先</option>
              <option value="title">标题顺序</option>
            </select></label
          >
          <div class="conversation-filter-notes">
            <label
              ><input
                v-model="includeUnknownTimes"
                type="checkbox"
                :disabled="interactionBlocked"
              />日期筛选时也包含未知时间</label
            ><span>日期按 {{ timezoneLabel }} 计算；不使用文件修改时间。</span
            ><button
              type="button"
              class="text-button"
              :disabled="interactionBlocked || listLoading"
              @click="resetFilters"
            >
              重置筛选
            </button>
          </div>
        </div>
      </form>
      <div
        v-if="dirty"
        class="conversation-feedback is-warning"
        role="status"
        data-testid="conversation-stale"
      >
        筛选条件已改变，列表仍显示上次结果。应用筛选后才能选择或预览隔离。
      </div>
      <div v-if="listCancelled" class="conversation-feedback" role="status">
        列表读取已取消或未完成。现有结果可能不是最新，可重新应用筛选。
      </div>
      <div
        v-if="list?.partial || list?.warnings.length"
        class="conversation-coverage"
      >
        <strong v-if="list.partial">读取范围不完整</strong
        ><span v-if="list.partial">当前列表只代表已成功读取的记录。</span>
        <details v-if="list.warnings.length">
          <summary>{{ list.warnings.length }} 条读取说明</summary>
          <p
            v-for="(warning, index) in list.warnings.slice(0, 12)"
            :key="index"
          >
            {{ warning }}
          </p>
          <p v-if="list.warnings.length > 12">更多说明未展开。</p>
        </details>
      </div>
      <div class="conversation-panels">
        <section
          class="conversation-list-panel"
          aria-labelledby="conversation-list-title"
        >
          <header class="conversation-list-toolbar">
            <label
              ><input
                type="checkbox"
                :checked="allPageSelected"
                :indeterminate="hasAnyPageSelected && !allPageSelected"
                :disabled="
                  !eligiblePage.length ||
                  interactionBlocked ||
                  listLoading ||
                  listCancelled ||
                  dirty
                "
                @change="togglePageSelection"
                aria-label="选择本页可隔离对话"
              /><span id="conversation-list-title"
                >本页 {{ items.length }} 条</span
              ></label
            ><button
              v-if="listLoading"
              class="text-button"
              type="button"
              @click="cancelRequest('list')"
              data-testid="conversation-cancel-list"
            >
              取消读取</button
            ><button
              v-else
              class="text-button"
              :disabled="interactionBlocked"
              @click="queryPage(0, true)"
              aria-label="刷新对话列表"
            >
              刷新
            </button>
          </header>
          <div
            ref="listViewport"
            class="conversation-list-viewport"
            role="list"
            aria-label="本地对话"
            :aria-busy="listLoading"
            @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
            data-testid="conversation-list"
          >
            <div
              v-if="!list && listLoading"
              class="conversation-panel-empty"
              role="status"
            >
              <span class="conversation-spinner" aria-hidden="true"></span
              ><strong>正在读取本地对话…</strong>
              <p>大目录可能需要更长时间。你可以取消或切换工作空间。</p>
            </div>
            <div v-else-if="!items.length" class="conversation-panel-empty">
              <strong>{{ list ? "没有匹配的对话" : "尚未读取对话" }}</strong>
              <p>
                {{
                  list
                    ? "试试放宽筛选条件，或核对读取说明。未知格式不会被当作空对话。"
                    : "应用筛选以重新读取。"
                }}
              </p>
              <button
                v-if="list && activeFilterCount"
                class="text-button"
                :disabled="interactionBlocked"
                @click="resetFilters"
              >
                清除筛选
              </button>
            </div>
            <div
              v-if="visibleWindow.before"
              :style="{ height: visibleWindow.before + 'px' }"
              aria-hidden="true"
            ></div>
            <article
              v-for="(item, rowIndex) in visibleRows"
              :key="item.id"
              class="conversation-row"
              :class="{
                active: activeId === item.id,
                selected: selected.has(item.id),
              }"
              role="listitem"
              :aria-posinset="visibleWindow.start + rowIndex + 1"
              :aria-setsize="items.length"
              :data-conversation-index="visibleWindow.start + rowIndex"
              data-testid="conversation-row"
            >
              <input
                type="checkbox"
                :checked="selected.has(item.id)"
                :disabled="
                  !item.canArchive ||
                  !item.identityVerified ||
                  interactionBlocked ||
                  listLoading ||
                  listCancelled ||
                  dirty
                "
                :aria-label="`选择对话：${item.title}`"
                :title="item.archiveReason"
                @change="toggleSelection(item)"
              />
              <button
                class="conversation-open"
                :aria-label="`打开对话：${item.title}`"
                :aria-pressed="activeId === item.id"
                :disabled="
                  interactionBlocked || listLoading || dirty || listCancelled
                "
                @click="openConversation(item)"
                @keydown="rowKey($event, item)"
              >
                <strong :title="item.title">{{
                  item.title || "未命名对话"
                }}</strong
                ><span
                  class="conversation-row-project"
                  :title="item.project ?? '未记录项目'"
                  >{{ item.project ?? "未记录项目" }}</span
                ><span class="conversation-row-meta"
                  ><time :datetime="item.updatedAt ?? undefined">{{
                    formatConversationTime(item.updatedAt)
                  }}</time
                  ><span>{{
                    item.messageCount === null
                      ? "消息数未知"
                      : `${item.messageCount} 条消息`
                  }}</span></span
                ><span
                  class="conversation-row-status"
                  :class="{ readonly: !item.canArchive }"
                  >{{
                    item.canArchive && item.identityVerified
                      ? "可预览隔离"
                      : "仅可读取"
                  }}<span v-if="item.warnings.length"> · 含读取说明</span></span
                >
              </button>
            </article>
            <div
              v-if="visibleWindow.after"
              :style="{ height: visibleWindow.after + 'px' }"
              aria-hidden="true"
            ></div>
          </div>
          <footer class="conversation-pagination">
            <button
              class="button secondary"
              :disabled="
                listPageIndex === 0 ||
                listLoading ||
                interactionBlocked ||
                dirty
              "
              @click="queryPage(listPageIndex - 1)"
              aria-label="上一页对话"
            >
              上一页</button
            ><span>第 {{ listPageIndex + 1 }} 页</span
            ><button
              class="button secondary"
              :disabled="
                !list?.nextCursor || listLoading || interactionBlocked || dirty
              "
              @click="queryPage(listPageIndex + 1)"
              aria-label="下一页对话"
            >
              下一页
            </button>
          </footer>
        </section>
        <section
          class="conversation-detail-panel"
          aria-label="对话正文预览"
          :aria-busy="detailLoading"
          data-testid="conversation-detail"
        >
          <div
            v-if="!activeId"
            class="conversation-panel-empty conversation-detail-empty"
          >
            <span class="conversation-empty-symbol" aria-hidden="true">◌</span>
            <h2>让上下文留在眼前</h2>
            <p>
              从左侧打开对话，查看消息、工具结果和时间来源。勾选只用于整理，不会自动修改内容。
            </p>
            <span class="conversation-key-hint">↑ ↓ 浏览列表 · / 搜索标题</span>
          </div>
          <template v-else>
            <header class="conversation-detail-heading">
              <div>
                <h2>{{ activeSummary?.title ?? "正在打开对话…" }}</h2>
                <p>
                  {{ activeSummary?.project ?? "未记录项目"
                  }}<span v-if="!items.some((item) => item.id === activeId)">
                    · 此对话不在当前结果页</span
                  >
                </p>
              </div>
              <button
                v-if="detailLoading"
                class="text-button"
                @click="cancelRequest('detail')"
              >
                取消读取</button
              ><button
                v-else-if="detailError"
                class="text-button"
                :disabled="interactionBlocked || listLoading"
                @click="refreshAfterReadError"
              >
                刷新列表后重新打开</button
              ><button
                v-else-if="activeSummary"
                class="text-button"
                @click="openConversation(activeSummary, detailPageIndex)"
                :disabled="interactionBlocked"
              >
                重新读取
              </button>
            </header>
            <div
              ref="detailViewport"
              class="conversation-detail-viewport"
              tabindex="0"
              aria-label="可滚动的对话内容"
            >
              <div
                v-if="detailError"
                class="conversation-feedback is-warning"
                role="alert"
              >
                {{ detailError }}
              </div>
              <div
                v-if="detailLoading"
                class="conversation-reading"
                role="status"
              >
                <span class="conversation-spinner" aria-hidden="true"></span
                >正在读取正文…
              </div>
              <template v-if="detail">
                <details class="conversation-provenance">
                  <summary>对话来源与整理条件</summary>
                  <dl>
                    <div>
                      <dt>提供方</dt>
                      <dd>{{ providerName }}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>
                        {{
                          formatConversationTime(detail.conversation.createdAt)
                        }}
                        ·
                        {{
                          timeSourceLabel(
                            detail.conversation.createdAtSource ??
                              detail.conversation.timeSource,
                          )
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>最后对话</dt>
                      <dd>
                        {{
                          formatConversationTime(detail.conversation.updatedAt)
                        }}
                        ·
                        {{
                          timeSourceLabel(
                            detail.conversation.updatedAtSource ??
                              detail.conversation.timeSource,
                          )
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>时间来源</dt>
                      <dd>
                        {{
                          detail.conversation.timeSource === "native"
                            ? "原生对话元数据"
                            : detail.conversation.timeSource === "messages"
                              ? "消息中的时间戳"
                              : "无可信时间记录"
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>标题来源</dt>
                      <dd>
                        {{
                          detail.conversation.titleSource === "native"
                            ? "原生标题"
                            : detail.conversation.titleSource ===
                                "first-user-message"
                              ? "首条用户消息"
                              : detail.conversation.titleSource === "identifier"
                                ? "记录标识符"
                                : "未知"
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>源记录</dt>
                      <dd>{{ detail.conversation.sourceLabel }}</dd>
                    </div>
                    <div>
                      <dt>逻辑大小</dt>
                      <dd>
                        {{
                          formatConversationSize(detail.conversation.sizeBytes)
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>整理条件</dt>
                      <dd>{{ detail.conversation.archiveReason }}</dd>
                    </div>
                  </dl>
                </details>
                <div
                  v-if="
                    detail.partial ||
                    detail.warnings.length ||
                    detail.conversation.warnings.length
                  "
                  class="conversation-coverage"
                >
                  <strong v-if="detail.partial">正文读取不完整</strong>
                  <p
                    v-for="(warning, index) in [
                      ...detail.warnings,
                      ...detail.conversation.warnings,
                    ].slice(0, 12)"
                    :key="index"
                  >
                    {{ warning }}
                  </p>
                  <p v-if="detail.partial">
                    无法确认未展示内容；请结合源工具核对。
                  </p>
                </div>
                <ConversationMessageView
                  v-for="(entry, index) in detail.messages"
                  :key="entry.id + ':' + index"
                  :message="entry"
                  :index="(detailOffsets[detailPageIndex] ?? 0) + index + 1"
                />
                <div
                  v-if="!detail.messages.length"
                  class="conversation-panel-empty"
                >
                  <strong>本页没有可显示的消息</strong>
                  <p>这不代表原记录为空，请查看来源及读取说明。</p>
                </div>
              </template>
            </div>
            <footer class="conversation-detail-footer">
              <div class="conversation-message-pagination">
                <button
                  class="text-button"
                  :disabled="
                    detailPageIndex === 0 ||
                    detailLoading ||
                    interactionBlocked ||
                    !!detailError ||
                    listLoading ||
                    dirty ||
                    listCancelled
                  "
                  @click="
                    activeSummary &&
                    openConversation(activeSummary, detailPageIndex - 1)
                  "
                  aria-label="上一页消息"
                >
                  上一段</button
                ><span
                  >正文第 {{ detailPageIndex + 1 }} 页<span
                    v-if="detail?.nextCursor"
                  >
                    · 后面还有消息</span
                  ></span
                ><button
                  class="text-button"
                  :disabled="
                    !detail?.nextCursor ||
                    detailLoading ||
                    interactionBlocked ||
                    !!detailError ||
                    listLoading ||
                    dirty ||
                    listCancelled
                  "
                  @click="
                    activeSummary &&
                    openConversation(activeSummary, detailPageIndex + 1)
                  "
                  aria-label="下一页消息"
                >
                  下一段
                </button>
              </div>
              <div v-if="activeSummary" class="conversation-single-action">
                <span :title="activeSummary.archiveReason">{{
                  activeSummary.archiveReason
                }}</span
                ><button
                  class="button secondary"
                  :disabled="
                    !activeSummary.canArchive ||
                    !activeSummary.identityVerified ||
                    interactionBlocked ||
                    !canSign ||
                    dirty ||
                    listLoading ||
                    listCancelled
                  "
                  @click="prepareArchive(activeSummary)"
                >
                  预览此对话隔离
                </button>
              </div>
            </footer>
          </template>
        </section>
      </div>
      <div
        v-if="hidden.length"
        class="conversation-feedback is-warning conversation-hidden-selection"
        role="status"
        data-testid="conversation-hidden-selection"
      >
        <span
          >已选
          {{ hidden.length }}
          条不在当前结果页，可能位于其他页或筛选范围外。预览会包含这些选择。</span
        ><button
          class="text-button"
          :disabled="interactionBlocked"
          @click="clearHidden"
        >
          清除本页外选择
        </button>
      </div>
      <footer class="conversation-action-bar">
        <div class="conversation-selection-summary">
          <strong>{{
            selected.size ? `已选 ${selected.size} 条对话` : "按需选择对话"
          }}</strong
          ><span>{{
            selected.size
              ? formatConversationSize(selectedBytes)
              : `已检查 ${list?.scannedConversations ?? 0} 条 · 匹配 ${list?.matchedConversations ?? 0} 条${list?.partial ? "（已读取范围内）" : ""}`
          }}</span>
        </div>
        <button
          v-if="selected.size"
          class="text-button"
          :disabled="interactionBlocked"
          @click="selected = new Map()"
        >
          取消全部选择</button
        ><span class="conversation-local-note">仅本机 · 隔离可恢复</span
        ><button
          class="button primary"
          :disabled="!canPreview"
          @click="prepareArchive()"
          data-testid="conversation-preview-selected"
        >
          {{ previewLoading ? "正在检查…" : "预览所选对话隔离" }}
        </button>
      </footer>
      <div class="conversation-privacy-footer">
        <span
          >正文按页读取，链接与附件不会自动打开。切换提供方或目录后需重新同意。</span
        ><button
          class="text-button"
          :disabled="interactionBlocked"
          @click="changeAccess(false)"
          data-testid="conversation-revoke"
        >
          撤回内容读取
        </button>
      </div>
    </template>
  </section>
</template>
