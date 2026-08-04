import assert from "node:assert/strict";
import test from "node:test";
import {ROOM_SOURCE_REPLY_DELIVERY_MODE} from "../src/reply-policy.js";

test("Room replies use OpenClaw automatic source delivery", () => {
  assert.equal(ROOM_SOURCE_REPLY_DELIVERY_MODE, "automatic");
  assert.notEqual(ROOM_SOURCE_REPLY_DELIVERY_MODE, "channel");
});
