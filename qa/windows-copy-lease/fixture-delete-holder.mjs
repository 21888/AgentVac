import {
  acquireFramedResource,
  ownedResourceCount,
} from "./resource-transport-internal.mjs";
import { encodeLeaseRequest } from "./lease-protocol.mjs";
const outcomes = [
  "verified-local",
  "verified-private",
  "invalid-request",
  "locality-rejected",
  "acl-rejected",
  "metadata-unavailable",
  "timeout",
  "identity-unavailable",
  "context-rejected",
  "caller-rejected",
  "scope-rejected",
];
function encodeRequest(request) {
  const bytes = encodeLeaseRequest(request);
  bytes.write("AVD2", 4);
  return bytes;
}
function encodeControl(kind, nonce) {
  if (
    !["release", "cancel"].includes(kind) ||
    !Buffer.isBuffer(nonce) ||
    nonce.length !== 16
  )
    throw Error("HOLDER_INVALID_CONTROL");
  const bytes = Buffer.alloc(28);
  bytes.writeUInt32LE(24);
  bytes.write("AVD2", 4);
  bytes[8] = kind === "release" ? 2 : 3;
  nonce.copy(bytes, 12);
  return bytes;
}
function decodeResponse(bytes, request) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== 24 ||
    !bytes.subarray(0, 4).equals(Buffer.from("AVD2")) ||
    ![1, 2, 3, 4].includes(bytes[4]) ||
    bytes[5] >= outcomes.length ||
    bytes[6] ||
    bytes[7] ||
    !bytes.subarray(8).equals(request.nonce)
  )
    throw Error("HOLDER_INVALID_RESPONSE");
  const phase = { 1: "ready", 2: "released", 3: "refused", 4: "cancelled" }[
      bytes[4]
    ],
    code = bytes[5];
  if ((phase !== "refused" && code !== 1) || (phase === "refused" && code < 2))
    throw Error("HOLDER_INVALID_OUTCOME");
  return Object.freeze({
    phase,
    outcome: phase === "refused" ? outcomes[code] : "verified-delete-holder",
    reason: "none",
  });
}
const protocol = Object.freeze({
  encodeRequest,
  encodeControl,
  decodeResponse,
  responseBytes: 24,
});
export const ownedGeneratedHolderCount = ownedResourceCount;
export async function acquireFixtureDeleteHolder(options) {
  const resource = await acquireFramedResource(protocol, options);
  return Object.freeze({
    isHolding: resource.isLive,
    release: resource.release,
    abort: resource.abort,
  });
}
