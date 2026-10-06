import {
  acquireFramedResource,
  ownedResourceCount,
} from "./resource-transport-internal.mjs";
import {
  encodeLeaseRequest,
  encodeLeaseControl,
  decodeLeaseResponse,
  LEASE_LIMITS,
} from "./lease-protocol.mjs";
const protocol = Object.freeze({
  encodeRequest: encodeLeaseRequest,
  encodeControl: encodeLeaseControl,
  decodeResponse: decodeLeaseResponse,
  responseBytes: LEASE_LIMITS.responseBytes,
});
export const ownedGeneratedLeaseCount = ownedResourceCount;
export const acquireGeneratedLease = (options) =>
  acquireFramedResource(protocol, options);
