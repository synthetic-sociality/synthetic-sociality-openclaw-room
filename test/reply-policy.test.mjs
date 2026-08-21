import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_DISPATCH_REPLY_DELIVERY_MODE,
  ROOM_REPLY_PLAN_DELIVERY_MODE,
  roomReplyDeliveryPolicy,
} from "../src/reply-policy.js";

test("Room reply target and dispatcher delivery policies remain distinct", () => {
  assert.equal(ROOM_REPLY_PLAN_DELIVERY_MODE, "channel");
  assert.equal(ROOM_DISPATCH_REPLY_DELIVERY_MODE, "automatic");
  assert.deepEqual(roomReplyDeliveryPolicy(), {
    replyPlan: {sourceReplyDeliveryMode: "channel"},
    replyOptions: {sourceReplyDeliveryMode: "automatic"},
  });
});
