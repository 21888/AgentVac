import { createHash } from "node:crypto";
import { LEASE_LIMITS } from "./lease-protocol.mjs";
export class LeaseCopyError extends Error {
  constructor(code, writtenKnown = 0, writeMayBePending = false) {
    super(code);
    this.code = code;
    this.writtenKnown = writtenKnown;
    this.writeMayBePending = writeMayBePending;
  }
}
const identity = (s) => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = (s) => s.isFile() && s.nlink === 1n && s.ino > 0n;
function matchesNative(s, n) {
  return (
    n &&
    /^[a-f0-9]{8}$/i.test(n.volume32) &&
    /^[a-f0-9]{16}$/i.test(n.fileIndex64) &&
    s.dev === BigInt("0x" + n.volume32) &&
    s.ino === BigInt("0x" + n.fileIndex64) &&
    n.links === 1
  );
}
/** Detached generated-fixture seam. A future production caller must obtain lease
 * from a private, authenticated transport registry, never renderer input.
 * Cancellation retains the pending fs.write until it settles; no physical I/O
 * timeout or atomic helper-liveness guarantee is claimed here. */
export async function copyGeneratedFixtureUnderLease(options) {
  const { source, destination, lease, expectedBytes, expectedSha256, signal } =
    options;
  let written = 0,
    pending = false,
    cancelled = false,
    abortPromise,
    buffer,
    writeAttempted = false,
    writeExtentUncertain = false;
  const abort = () => {
    cancelled = true;
    abortPromise ??= Promise.resolve()
      .then(() => lease.abort())
      .catch(() => {});
  };
  const check = () => {
    if (cancelled || signal?.aborted)
      throw new LeaseCopyError("LEASE_COPY_CANCELLED", written, pending);
    if (!lease.isLive())
      throw new LeaseCopyError("LEASE_COPY_LOST", written, pending);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > LEASE_LIMITS.copyBytes ||
      typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)
    )
      throw new LeaseCopyError("LEASE_COPY_INVALID_BUDGET");
    check();
    const initial = await destination.stat({ bigint: true });
    check();
    if (
      !regular(initial) ||
      initial.size !== 0n ||
      !matchesNative(initial, lease.ready?.identity) ||
      lease.ready?.outcome !== "verified-private" ||
      lease.ready?.phase !== "ready"
    )
      throw new LeaseCopyError("LEASE_COPY_DESTINATION_MISMATCH");
    const bound = identity(initial),
      sourceBefore = await source.stat({ bigint: true });
    check();
    if (!regular(sourceBefore) || sourceBefore.size !== BigInt(expectedBytes))
      throw new LeaseCopyError("LEASE_COPY_SOURCE_MISMATCH");
    const sourceBound = identity(sourceBefore),
      hash = createHash("sha256");
    buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, expectedBytes)));
    const checkDestination = async () => {
      const s = await destination.stat({ bigint: true });
      check();
      if (
        !regular(s) ||
        !same(identity(s), bound) ||
        s.size !== BigInt(written)
      )
        throw new LeaseCopyError("LEASE_COPY_DESTINATION_CHANGED", written);
      return s;
    };
    while (written < expectedBytes) {
      check();
      const wanted = Math.min(
        buffer.length,
        expectedBytes - written,
        LEASE_LIMITS.copyBytes - written,
      );
      if (wanted <= 0) throw new LeaseCopyError("LEASE_COPY_BUDGET", written);
      const read = await source.read(buffer, 0, wanted, written);
      check();
      if (
        !Number.isSafeInteger(read.bytesRead) ||
        read.bytesRead <= 0 ||
        read.bytesRead > wanted
      )
        throw new LeaseCopyError("LEASE_COPY_SOURCE_CHANGED", written);
      hash.update(buffer.subarray(0, read.bytesRead));
      let offset = 0;
      while (offset < read.bytesRead) {
        await checkDestination();
        check();
        const amount = read.bytesRead - offset;
        if (
          amount > expectedBytes - written ||
          amount > LEASE_LIMITS.copyBytes - written
        )
          throw new LeaseCopyError("LEASE_COPY_BUDGET", written);
        pending = true;
        writeAttempted = true;
        let result;
        try {
          result = await destination.write(buffer, offset, amount, written);
        } catch (e) {
          writeExtentUncertain = true;
          throw e;
        } finally {
          pending = false;
        }
        if (
          !Number.isSafeInteger(result.bytesWritten) ||
          result.bytesWritten <= 0 ||
          result.bytesWritten > amount
        )
          throw new LeaseCopyError("LEASE_COPY_WRITE_FAILED", written);
        written += result.bytesWritten;
        offset += result.bytesWritten;
        check();
      }
    }
    const sourceAfter = await source.stat({ bigint: true });
    check();
    if (
      !same(identity(sourceAfter), sourceBound) ||
      sourceAfter.size !== sourceBefore.size ||
      sourceAfter.mtimeNs !== sourceBefore.mtimeNs ||
      sourceAfter.ctimeNs !== sourceBefore.ctimeNs ||
      hash.digest("hex") !== expectedSha256
    )
      throw new LeaseCopyError("LEASE_COPY_SOURCE_CHANGED", written);
    await checkDestination();
    await destination.sync();
    check();
    // Read back through the original descriptor, never reopen its pathname.
    const actual = createHash("sha256");
    let position = 0;
    while (position < written) {
      check();
      const r = await destination.read(
        buffer,
        0,
        Math.min(buffer.length, written - position),
        position,
      );
      check();
      if (
        !Number.isSafeInteger(r.bytesRead) ||
        r.bytesRead <= 0 ||
        r.bytesRead > written - position
      )
        throw new LeaseCopyError("LEASE_COPY_READBACK_FAILED", written);
      actual.update(buffer.subarray(0, r.bytesRead));
      position += r.bytesRead;
    }
    if (actual.digest("hex") !== expectedSha256)
      throw new LeaseCopyError("LEASE_COPY_HASH_MISMATCH", written);
    const final = await checkDestination();
    const released = await lease.release();
    if (cancelled || signal?.aborted)
      throw new LeaseCopyError("LEASE_COPY_CANCELLED", written);
    if (
      released?.teardownConfirmed !== true ||
      released?.phase !== "released" ||
      released?.outcome !== "verified-private" ||
      !matchesNative(final, released.identity) ||
      released.identity.size !== String(written) ||
      lease.isLive()
    )
      throw new LeaseCopyError("LEASE_COPY_RELEASE_UNVERIFIED", written);
    const after = await destination.stat({ bigint: true });
    if (
      !regular(after) ||
      !same(identity(after), bound) ||
      after.size !== BigInt(written)
    )
      throw new LeaseCopyError("LEASE_COPY_DESTINATION_CHANGED", written);
    return {
      written,
      sha256: expectedSha256,
      sourceUnchanged: true,
      helperClosed: true,
      productionAccepted: false,
    };
  } catch (error) {
    abort();
    await abortPromise;
    const failure =
      error instanceof LeaseCopyError
        ? error
        : new LeaseCopyError("LEASE_COPY_IO_FAILED", written, pending);
    failure.writeAttempted = writeAttempted;
    failure.writeExtentUncertain = writeExtentUncertain;
    throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (abortPromise) await abortPromise;
    buffer?.fill(0);
  }
}
