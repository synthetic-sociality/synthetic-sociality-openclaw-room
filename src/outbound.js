import {randomUUID} from "node:crypto";

export function outboundIdempotencyKey(deliveryQueueId, {makeId = randomUUID} = {}) {
  const durableIntentId = String(deliveryQueueId ?? "").trim();
  if (durableIntentId) return durableIntentId;
  return `outbound:${makeId()}:text`;
}
