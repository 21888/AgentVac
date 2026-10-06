// Native fixture diagnostics only. Never serialize an input object or message.
// OperationResult exposes strings, not structured error codes. Every reason
// below is an inference from a fixed public engine message or an errno prefix.
export const NATIVE_MUTATION_OBSERVATION_LIMITS = Object.freeze({
  requests: 8,
  failedItems: 8,
  messageCharacters: 2048,
});

const boundedMessage = (value) =>
  typeof value === "string"
    ? value.slice(0, NATIVE_MUTATION_OBSERVATION_LIMITS.messageCharacters)
    : null;

const engineReasons = new Map([
  ["无法确认进程状态，已阻止文件操作。", "INFERRED_ENGINE_PROCESS_UNKNOWN"],
  [
    "操作已取消；已停止后续文件修改，已执行步骤保留可恢复记录。",
    "INFERRED_ENGINE_CANCELLED",
  ],
  ["扫描已取消；文件未改变。", "INFERRED_ENGINE_SCAN_CANCELLED"],
  [
    "预览期间操作已取消或目录已切换，预览已失效。",
    "INFERRED_ENGINE_PREVIEW_CANCELLED_OR_SWITCHED",
  ],
  [
    "提供方或目录已切换，旧操作已失效。",
    "INFERRED_ENGINE_OPERATION_INVALIDATED",
  ],
  [
    "提供方或目录已切换，旧扫描与预览已失效。",
    "INFERRED_ENGINE_CONTEXT_INVALIDATED",
  ],
  ["根目录已被替换，请重新选择目录。", "INFERRED_ENGINE_ROOT_REPLACED"],
  ["所选目录不是规范真实路径。", "INFERRED_ENGINE_ROOT_NONCANONICAL"],
  [
    "请选择规范的 Codex 数据目录，不能选择磁盘根目录。",
    "INFERRED_ENGINE_ROOT_DISALLOWED",
  ],
  ["源文件已变化。", "INFERRED_ENGINE_SOURCE_CHANGED"],
  [
    "文件自扫描后发生变化，已跳过；请重新扫描。",
    "INFERRED_ENGINE_SOURCE_CHANGED_SINCE_SCAN",
  ],
  [
    "清理单元自扫描后发生变化；请重新扫描。",
    "INFERRED_ENGINE_UNIT_CHANGED_SINCE_SCAN",
  ],
  [
    "移动后文件标识不一致，请人工检查。",
    "INFERRED_ENGINE_MOVED_IDENTITY_MISMATCH",
  ],
  ["隔离目标已存在。", "INFERRED_ENGINE_TARGET_EXISTS"],
  [
    "当前或活动数据保护范围发生变化，已阻止恢复。",
    "INFERRED_ENGINE_RESTORE_PROTECTION_CHANGED",
  ],
  ["隔离文件已变化；拒绝恢复。", "INFERRED_ENGINE_STORED_FILE_CHANGED"],
  ["原路径已存在文件；不会覆盖。", "INFERRED_ENGINE_RESTORE_TARGET_EXISTS"],
  [
    "恢复链接状态发生变化；隔离数据仍保留。",
    "INFERRED_ENGINE_RESTORE_LINK_CHANGED",
  ],
  ["扫描条目已失效。", "INFERRED_ENGINE_SCAN_ENTRY_INVALID"],
  ["条目不可隔离或扫描已失效。", "INFERRED_ENGINE_ENTRY_INELIGIBLE"],
  [
    "当前安全策略禁止新的此类文件隔离；已有签名记录仍按版本化恢复策略处理。",
    "INFERRED_ENGINE_POLICY_BLOCKED",
  ],
  [
    "当前或活动数据属于此单元，已整体保护。",
    "INFERRED_ENGINE_ACTIVE_DATA_PROTECTED",
  ],
  [
    "动态保护范围无法验证，已阻止操作。",
    "INFERRED_ENGINE_PROTECTION_UNVERIFIED",
  ],
  ["另一项操作正在进行，请稍候。", "INFERRED_ENGINE_BUSY"],
  ["预览已失效，请重新预览。", "INFERRED_ENGINE_PREVIEW_INVALID"],
  ["无效相对路径", "INFERRED_ENGINE_RELATIVE_PATH_INVALID"],
  ["路径越界", "INFERRED_ENGINE_PATH_OUTSIDE_ROOT"],
  ["操作清单绑定已失效。", "INFERRED_ENGINE_JOURNAL_BINDING_INVALID"],
  ["操作清单已被替换，已拒绝写入。", "INFERRED_ENGINE_JOURNAL_REPLACED"],
  [
    "恢复记录的操作目录绑定已失效。",
    "INFERRED_ENGINE_CHECKPOINT_BINDING_INVALID",
  ],
  [
    "隔离父目录已被替换，恢复记录未覆盖新目录。",
    "INFERRED_ENGINE_QUARANTINE_PARENT_REPLACED",
  ],
  [
    "隔离批次目录已被替换，恢复记录未覆盖新目录。",
    "INFERRED_ENGINE_BATCH_DIRECTORY_REPLACED",
  ],
  [
    "隔离清单已被替换或改变，恢复记录未覆盖它。",
    "INFERRED_ENGINE_CHECKPOINT_MANIFEST_REPLACED",
  ],
  [
    "临时记录或其目录已被替换；未知路径保持原样。",
    "INFERRED_ENGINE_TEMPORARY_REPLACED",
  ],
  ["隔离清单已被替换。", "INFERRED_ENGINE_MANIFEST_REPLACED"],
  [
    "刚写入的隔离清单已被替换，已停止后续操作。",
    "INFERRED_ENGINE_PUBLISHED_MANIFEST_REPLACED",
  ],
]);
// These public provider labels fill engine.ts's fixed process-error templates.
for (const provider of ["Codex", "Claude Code", "Cline", "Cursor"]) {
  engineReasons.set(
    `检测到 ${provider} 正在运行，请退出后重试。`,
    "INFERRED_ENGINE_PROCESS_RUNNING",
  );
  engineReasons.set(
    `请先确认已退出全部 ${provider} 相关进程。`,
    "INFERRED_ENGINE_PROCESS_CONFIRMATION_REQUIRED",
  );
}
const errnoReasons = new Map(
  [
    "EACCES",
    "EPERM",
    "ENOENT",
    "EEXIST",
    "EXDEV",
    "ENOTDIR",
    "EISDIR",
    "EIO",
    "EBUSY",
    "EINVAL",
    "ENOSPC",
    "EDQUOT",
    "EMFILE",
    "ENFILE",
    "ELOOP",
    "ENOTEMPTY",
    "ENAMETOOLONG",
    "ENOTSUP",
    "EBADF",
    "EROFS",
    "ECANCELED",
    "EAGAIN",
    "EFAULT",
    "ENOMEM",
    "ETXTBSY",
    "ENOSYS",
  ].map((code) => [code, `INFERRED_ERRNO_${code}`]),
);
const contextPrefixes = [
  [
    "移动已完成或部分完成，记录待协调；请刷新隔离记录。",
    "INFERRED_ENGINE_MOVE_RECONCILIATION_PENDING",
  ],
  ["整组隔离尚未移动任何成员：", "INFERRED_ENGINE_UNIT_NOT_MOVED"],
  ["整组隔离失败，已安全恢复原位：", "INFERRED_ENGINE_UNIT_ROLLED_BACK"],
  [
    "恢复已创建原文件，但隔离链接移除失败。可重试恢复：",
    "INFERRED_ENGINE_RESTORE_UNLINK_PENDING",
  ],
];

export function inferredMutationReasonCodes(error) {
  let message = boundedMessage(error);
  if (message === null) return ["UNCLASSIFIED"];
  const codes = [];
  for (const [prefix, code] of contextPrefixes) {
    if (message.startsWith(prefix)) {
      codes.push(code);
      message = message.slice(prefix.length);
      break;
    }
  }
  const rollbackSeparator = " 回滚尚未完成；数据仍保留：";
  const rollbackAt = message.indexOf(rollbackSeparator);
  if (codes.length && rollbackAt >= 0) {
    codes.push(inferredLeafReason(message.slice(0, rollbackAt)));
    codes.push("INFERRED_ENGINE_ROLLBACK_PENDING");
    codes.push(
      inferredLeafReason(message.slice(rollbackAt + rollbackSeparator.length)),
    );
  } else codes.push(inferredLeafReason(message));
  return codes;
}

function inferredLeafReason(message) {
  // Only exact engine messages and anchored errno prefixes are classified.
  // Unknown text, including path suffixes and process details, is not emitted.
  const known = engineReasons.get(message);
  if (known) return known;
  if (message.startsWith("目录路径含链接或非目录，已拒绝："))
    return "INFERRED_ENGINE_PARENT_NOT_PLAIN";
  const errno = /^([A-Z]+):/.exec(message)?.[1];
  return errnoReasons.get(errno) ?? "UNCLASSIFIED";
}

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

function returnedBatchObservation(value) {
  const batch = record(value);
  const completed = count(batch?.completed);
  const failed = Array.isArray(batch?.failed) ? batch.failed : null;
  const displayedFailures = Array.from(
    {
      length: Math.min(
        failed?.length ?? 0,
        NATIVE_MUTATION_OBSERVATION_LIMITS.failedItems,
      ),
    },
    (_, index) => failed[index],
  );
  return {
    // OperationResult has no batch status. This is derived from counts.
    inferredBatchStatus:
      completed === null || failed === null
        ? "invalid_result"
        : failed.length
          ? completed
            ? "partial_failure"
            : "failed"
          : completed
            ? "completed"
            : "empty",
    completed,
    failedCount: failed?.length ?? null,
    omittedFailedItemCount:
      failed === null ? null : failed.length - displayedFailures.length,
    // Ordinals are positions in failed[], not original selection indices.
    failedItems: displayedFailures.map((item, failedIndex) => ({
      failedItemOrdinal: failedIndex + 1,
      inferredReasonCodes: inferredMutationReasonCodes(item?.error),
    })),
  };
}

export function recordDuplicateMutationObservation(rows, write = console.log) {
  const requestCount = Array.isArray(rows) ? rows.length : null;
  // Read only the bounded prefix; even status counting must not traverse tails.
  const requests = Array.from(
    {
      length: Math.min(
        requestCount ?? 0,
        NATIVE_MUTATION_OBSERVATION_LIMITS.requests,
      ),
    },
    (_, index) => rows[index],
  );
  const observation = {
    requestCount,
    displayedRequestCount: requests.length,
    omittedRequestCount:
      requestCount === null ? null : requestCount - requests.length,
    displayedFulfilledCount: requests.filter(
      (row) => row?.status === "fulfilled",
    ).length,
    displayedRejectedCount: requests.filter((row) => row?.status === "rejected")
      .length,
    displayedInvalidStatusCount: requests.filter(
      (row) => !["fulfilled", "rejected"].includes(row?.status),
    ).length,
    requests: requests.map((row, index) => {
      const requestOrdinal = index + 1;
      if (row?.status !== "fulfilled")
        return {
          requestOrdinal,
          status: row?.status === "rejected" ? "rejected" : "invalid",
        };
      return {
        requestOrdinal,
        status: "fulfilled",
        ...returnedBatchObservation(row.value),
      };
    }),
  };
  try {
    write("AGENTVAC_DUPLICATE_MUTATION " + JSON.stringify(observation));
  } catch {
    /* Diagnostic sink failure cannot prevent the original assertions. */
  }
  return observation;
}

const providers = new Set(["codex", "claude-code", "cursor", "cline"]);
const operations = new Set([
  "GUARD_QUARANTINE",
  "QUARANTINE",
  "DUPLICATE_QUARANTINE",
  "RESTORE_CONFLICT",
  "RESTORE",
  "RESTORE_REPLAY",
  "SWITCHED_QUARANTINE",
]);

function thrownMutationReasonCodes(error) {
  let message = boundedMessage(error instanceof Error ? error.message : error);
  if (message === null) return ["UNCLASSIFIED"];
  // Playwright/Electron may prefix the public engine error. Match only these
  // fixed transport wrappers; never inspect or emit their stack/path details.
  if (message.startsWith("page.evaluate: ")) message = message.slice(15);
  if (message.startsWith("Error: ")) message = message.slice(7);
  for (const method of ["quarantine", "restore"]) {
    const prefix = `Error invoking remote method 'agentvac:${method}': Error: `;
    if (message.startsWith(prefix)) {
      message = message.slice(prefix.length);
      break;
    }
  }
  return inferredMutationReasonCodes(message.split(/\r?\n/, 1)[0]);
}

// Attach these handlers to the existing operation promise. Observing happens
// before the caller's await/aggregate assertions. Preserve both value identity
// and rejection identity, including deliberately rejected guard/replay probes.
export function providerMutationObservationHandlers(
  provider,
  operation,
  write = console.log,
) {
  const labels = {
    provider: providers.has(provider) ? provider : "invalid",
    operation: operations.has(operation) ? operation : "INVALID_OPERATION",
  };
  const emit = (observation) => {
    // Diagnostic sink failure must not change the original operation outcome.
    try {
      write("AGENTVAC_PROVIDER_MUTATION " + JSON.stringify(observation));
    } catch {
      /* No raw fallback output. */
    }
  };
  return [
    (value) => {
      emit({
        ...labels,
        status: "fulfilled",
        ...returnedBatchObservation(value),
      });
      return value;
    },
    (error) => {
      emit({
        ...labels,
        status: "rejected",
        inferredReasonCodes: thrownMutationReasonCodes(error),
      });
      throw error;
    },
  ];
}
