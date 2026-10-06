const owned = new Set();
export const ownedResourceCount = () => owned.size;
const error = (code) => Object.assign(new Error(code), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
/** Detached transport seam. spawnPinned must be supplied only by a reviewed
 * fixed-provenance fixture launcher, never renderer/IPC input. */
export function acquireFramedResource(
  protocol,
  { spawnPinned, request, signal, deadlineMs = 31000, reapMs = 500 },
) {
  const { encodeRequest, encodeControl, decodeResponse, responseBytes } =
    protocol;
  if (
    typeof encodeRequest !== "function" ||
    typeof encodeControl !== "function" ||
    typeof decodeResponse !== "function" ||
    !Number.isSafeInteger(responseBytes) ||
    responseBytes < 24 ||
    responseBytes > 92
  )
    return Promise.reject(error("LEASE_INVALID_PROTOCOL"));
  if (
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    typeof spawnPinned !== "function" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 31000 ||
    !Number.isSafeInteger(reapMs) ||
    reapMs < 1 ||
    reapMs > 500
  )
    return Promise.reject(error("LEASE_INVALID_LIMITS"));
  if (signal?.aborted) return Promise.reject(error("LEASE_CANCELLED"));
  if (owned.size >= 2) return Promise.reject(error("LEASE_ADMISSION_BUSY"));
  let copied, frame;
  try {
    copied = {
      scope: request.scope,
      path: request.path,
      mode: request.mode,
      directory: request.directory,
      allowMissingLeaf: request.allowMissingLeaf,
      nonce: Buffer.from(request.nonce),
    };
    frame = encodeRequest(copied);
  } catch {
    return Promise.reject(error("LEASE_INVALID_REQUEST"));
  }
  const ready = deferred(),
    terminal = deferred(),
    closed = deferred(),
    ticket = {};
  owned.add(ticket);
  let child,
    state = "acquiring",
    failure,
    buffer = Buffer.alloc(0),
    outputBytes = 0,
    stdoutEnded = false,
    childExited = false,
    observedExit,
    childClosed = false,
    terminalFrame,
    refusalFrame,
    refusalEvidence,
    protocolTainted = false,
    refusalTimer,
    watchdog,
    cancelTimer;
  const detach = () => {
    clearTimeout(watchdog);
    clearTimeout(cancelTimer);
    clearTimeout(refusalTimer);
    signal?.removeEventListener("abort", cancel);
  };
  const kill = () => {
    if (child && !childExited && !childClosed) {
      try {
        child.kill();
      } catch {}
    }
  };
  const fail = (code, nativeOutcome, nativeReason) => {
    if (code !== "LEASE_NATIVE_REFUSED") protocolTainted = true;
    if (!failure) {
      failure = error(code);
      Object.defineProperty(failure, "verifiedTerminalRefusal", {
        get: () => !!refusalEvidence,
      });
      if (
        [
          "none",
          "initial-file-nonempty",
          "initial-file-hardlink",
          "initial-file-not-regular",
          "filesystem-unsupported",
          "sharing-conflict",
        ].includes(nativeReason)
      )
        failure.nativeReason = nativeReason;
      if (
        typeof nativeOutcome === "string" &&
        [
          "metadata-unavailable",
          "identity-unavailable",
          "context-rejected",
          "caller-rejected",
          "locality-rejected",
          "acl-rejected",
          "scope-rejected",
          "invalid-request",
          "timeout",
        ].includes(nativeOutcome)
      )
        failure.nativeOutcome = nativeOutcome;
      Object.freeze(failure);
    }
    state = "failed";
    ready.reject(failure);
    terminal.reject(failure);
    if (code === "LEASE_NATIVE_REFUSED" && !protocolTainted) {
      refusalTimer ??= setTimeout(kill, reapMs);
      refusalTimer.unref?.();
    } else kill();
  };
  const waitClosed = async () => {
    if (childClosed) return { teardownConfirmed: true };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ teardownConfirmed: false }), reapMs);
    });
    const answer = await Promise.race([
      closed.promise.then(() => ({ teardownConfirmed: true })),
      timeout,
    ]);
    clearTimeout(timer);
    return answer;
  };
  const cancel = () => {
    if (childClosed) return;
    fail("LEASE_CANCELLED");
  };
  try {
    child = spawnPinned();
  } catch {
    owned.delete(ticket);
    return Promise.reject(error("LEASE_SPAWN_FAILED"));
  }
  if (
    !child?.stdin ||
    !child.stdout ||
    !child.stderr ||
    typeof child.kill !== "function" ||
    typeof child.on !== "function"
  ) {
    if (child && typeof child.on === "function")
      child.on("close", () => owned.delete(ticket));
    try {
      child?.kill?.();
    } catch {}
    return Promise.reject(error("LEASE_INVALID_CHILD"));
  }
  watchdog = setTimeout(() => fail("LEASE_DEADLINE"), deadlineMs);
  watchdog.unref?.();
  signal?.addEventListener("abort", cancel, { once: true });
  const lease = {
    ready: null,
    refusalEvidence: () => refusalEvidence,
    isLive: () => state === "ready" && !failure && !childExited && !childClosed,
    release: () => {
      if (state !== "ready" || failure || childExited || childClosed)
        return Promise.reject(error("LEASE_RELEASE_STATE"));
      state = "releasing";
      try {
        child.stdin.end(encodeControl("release", copied.nonce));
      } catch {
        fail("LEASE_CONTROL_WRITE_FAILED");
      }
      return terminal.promise;
    },
    abort: async () => {
      if (childClosed) return { teardownConfirmed: true };
      if (state === "ready" && !failure && !childExited) {
        state = "cancelling";
        try {
          child.stdin.end(encodeControl("cancel", copied.nonce));
        } catch {
          fail("LEASE_CONTROL_WRITE_FAILED");
        }
        cancelTimer = setTimeout(kill, Math.min(100, reapMs));
        cancelTimer.unref?.();
      } else kill();
      return waitClosed();
    },
  };
  child.stdout.on("data", (chunk) => {
    try {
      if (!Buffer.isBuffer(chunk)) throw error("LEASE_OUTPUT_TYPE");
      outputBytes += chunk.length;
      if (outputBytes > 2 * (4 + responseBytes))
        throw error("LEASE_OUTPUT_LIMIT");
      if (failure) {
        protocolTainted = true;
        kill();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (length !== responseBytes) throw error("LEASE_OUTPUT_FRAME");
        if (buffer.length < 4 + length) break;
        const decoded = Object.freeze(
          decodeResponse(buffer.subarray(4, 4 + length), copied),
        );
        buffer = buffer.subarray(4 + length);
        if (decoded.phase === "ready" && state === "acquiring") {
          lease.ready = decoded;
          state = "ready";
          ready.resolve(Object.freeze(lease));
        } else if (
          decoded.phase === "released" &&
          state === "releasing" &&
          !terminalFrame
        )
          terminalFrame = decoded;
        else if (
          decoded.phase === "cancelled" &&
          state === "cancelling" &&
          !terminalFrame
        )
          terminalFrame = decoded;
        else if (
          decoded.phase === "refused" &&
          !refusalFrame &&
          !terminalFrame
        ) {
          refusalFrame = decoded;
          if (buffer.length) protocolTainted = true;
          fail("LEASE_NATIVE_REFUSED", decoded.outcome, decoded.reason);
          return;
        } else throw error("LEASE_OUTPUT_STATE");
      }
    } catch (e) {
      fail(
        e?.code || "LEASE_INVALID_OUTPUT",
        e?.nativeOutcome,
        e?.nativeReason,
      );
    }
  });
  child.stdout.on("end", () => {
    stdoutEnded = true;
    if (buffer.length || (!terminalFrame && !refusalFrame))
      fail("LEASE_PREMATURE_EOF");
  });
  child.stdout.on("error", () => fail("LEASE_OUTPUT_ERROR"));
  child.stderr.on("data", (chunk) => {
    if (chunk?.length) fail("LEASE_STDERR");
  });
  child.stderr.on("error", () => fail("LEASE_STDERR"));
  child.stdin.on("error", () => fail("LEASE_INPUT_ERROR"));
  child.on("error", () => fail("LEASE_CHILD_ERROR"));
  child.on("exit", (code, exitSignal) => {
    if (childExited) {
      fail("LEASE_DUPLICATE_EXIT");
      return;
    }
    childExited = true;
    observedExit = { code, exitSignal };
    // The process has released its handles now, even if another process keeps a
    // stdout endpoint open. Revoke write eligibility immediately. A clean exit
    // after RELEASE/CANCEL may precede delivery of its buffered terminal frame.
    if (!failure) {
      if (code !== 0 || exitSignal) fail("LEASE_CHILD_EXIT");
      else if (state === "acquiring" || state === "ready") {
        // Readiness is revoked immediately, but a clean fast rejection may still
        // have a bounded REFUSED frame buffered in stdout. This state never
        // accepts READY and cannot authorize a write or new control.
        state = "exited-observation";
      }
    }
  });
  child.on("close", (code, exitSignal) => {
    childClosed = true;
    owned.delete(ticket);
    detach();
    closed.resolve();
    if (
      refusalFrame &&
      failure?.code === "LEASE_NATIVE_REFUSED" &&
      !protocolTainted &&
      code === 0 &&
      !exitSignal &&
      childExited &&
      observedExit?.code === 0 &&
      observedExit?.exitSignal === exitSignal &&
      stdoutEnded &&
      buffer.length === 0 &&
      outputBytes === (lease.ready ? 2 : 1) * (4 + responseBytes)
    ) {
      refusalEvidence = Object.freeze({
        phase: "refused",
        outcome: refusalFrame.outcome,
        reason: refusalFrame.reason,
        nonceBound: true,
        teardownConfirmed: true,
      });
    }
    if (failure) return;
    if (
      code !== 0 ||
      exitSignal ||
      !childExited ||
      observedExit?.code !== code ||
      observedExit?.exitSignal !== exitSignal ||
      !stdoutEnded ||
      buffer.length ||
      !terminalFrame
    ) {
      fail("LEASE_CHILD_EXIT");
      return;
    }
    state = "closed";
    terminal.resolve(
      Object.freeze({ ...terminalFrame, teardownConfirmed: true }),
    );
  });
  try {
    if (signal?.aborted) cancel();
    else child.stdin.write(frame);
  } catch {
    fail("LEASE_REQUEST_WRITE_FAILED");
  }
  return ready.promise;
}
