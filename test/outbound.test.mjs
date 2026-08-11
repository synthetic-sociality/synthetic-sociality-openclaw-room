import assert from "node:assert/strict";
import test from "node:test";
import {outboundIdempotencyKey} from "../src/outbound.js";

test("uses OpenClaw's durable delivery intent when one is available", () => {
  assert.equal(outboundIdempotencyKey("queue-123"), "queue-123");
});

test("gives separate proactive sends separate Room idempotency keys", () => {
  const ids = ["first", "second"];
  const makeId = () => ids.shift();
  assert.equal(outboundIdempotencyKey(undefined, {makeId}), "outbound:first:text");
  assert.equal(outboundIdempotencyKey(undefined, {makeId}), "outbound:second:text");
});
