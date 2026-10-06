import {
  encodeInheritedRequest,
  decodeInheritedResponse,
} from "./inherited-protocol.mjs";
export const LEASE_LIMITS = Object.freeze({
  nonceBytes: 16,
  controlBytes: 24,
  responseBytes: 92,
  copyBytes: 16 * 1024 * 1024,
  leaseMs: 30000,
});
function nonceBytes(value) {
  if (
    !Buffer.isBuffer(value) ||
    value.length !== 16 ||
    value.every((b) => b === 0)
  )
    throw Error("LEASE_INVALID_NONCE");
  return value;
}
function framed(body) {
  const out = Buffer.alloc(body.length + 4);
  out.writeUInt32LE(body.length);
  body.copy(out, 4);
  return out;
}
export function encodeLeaseRequest(request, pid = process.pid) {
  const nonce = nonceBytes(request?.nonce);
  if (
    request?.mode !== "acl" ||
    request?.directory !== false ||
    request?.allowMissingLeaf !== false
  )
    throw Error("LEASE_INVALID_MODE");
  const inherited = encodeInheritedRequest(request, pid).subarray(4);
  return framed(Buffer.concat([Buffer.from("AVL2"), nonce, inherited]));
}
export function encodeLeaseControl(kind, nonce) {
  if (kind !== "release" && kind !== "cancel")
    throw Error("LEASE_INVALID_CONTROL");
  const body = Buffer.alloc(24);
  body.write("AVC2");
  body[4] = kind === "release" ? 1 : 2;
  nonceBytes(nonce).copy(body, 8);
  return framed(body);
}
export function decodeLeaseResponse(body, request) {
  const nonce = nonceBytes(request?.nonce);
  if (
    !Buffer.isBuffer(body) ||
    body.length !== 92 ||
    !body.subarray(0, 4).equals(Buffer.from("AVR2")) ||
    body[4] < 1 ||
    body[4] > 4 ||
    body[5] > 5 ||
    body[6] ||
    body[7] ||
    !body.subarray(8, 24).equals(nonce)
  )
    throw Error("LEASE_INVALID_RESPONSE");
  const value = decodeInheritedResponse(body.subarray(24), request);
  const phase = ["", "ready", "released", "refused", "cancelled"][body[4]];
  const reason = [
    "none",
    "initial-file-nonempty",
    "initial-file-hardlink",
    "initial-file-not-regular",
    "filesystem-unsupported",
    "sharing-conflict",
  ][body[5]];
  if (
    (phase !== "refused" && reason !== "none") ||
    ([
      "initial-file-nonempty",
      "initial-file-hardlink",
      "initial-file-not-regular",
    ].includes(reason) &&
      value.outcome !== "identity-unavailable") ||
    (reason === "filesystem-unsupported" &&
      value.outcome !== "locality-rejected") ||
    (reason === "sharing-conflict" && value.outcome !== "metadata-unavailable")
  )
    throw Error("LEASE_INVALID_REASON");
  if (
    (phase === "ready" || phase === "released") &&
    value.outcome !== "verified-private"
  )
    throw Error("LEASE_INVALID_SUCCESS");
  if (
    phase === "ready" &&
    (value.exists !== true ||
      value.directory !== false ||
      value.identity?.size !== "0" ||
      value.identity?.links !== 1)
  )
    throw Error("LEASE_NOT_EMPTY_FILE");
  if (
    (phase === "released" || phase === "cancelled") &&
    (value.exists !== true ||
      value.directory !== false ||
      value.identity?.links !== 1 ||
      BigInt(value.identity.size) > BigInt(LEASE_LIMITS.copyBytes))
  )
    throw Error("LEASE_INVALID_FINAL_FILE");
  if (
    phase === "refused" &&
    (value.outcome === "verified-private" || value.outcome === "verified-local")
  )
    throw Error("LEASE_INVALID_REFUSAL");
  return { ...value, phase, reason };
}
