import assert from "node:assert/strict";
import test from "node:test";
import {
  looksLikeRoomId,
  normalizeRoomTarget,
  resolveConfiguredRoomTarget,
} from "../src/target.js";

const roomId = "k65qajj986wao68";

test("normalizes native and prefixed Room targets", () => {
  assert.equal(normalizeRoomTarget(roomId), roomId);
  assert.equal(normalizeRoomTarget(`room:${roomId}`), roomId);
  assert.equal(normalizeRoomTarget(`synthetic-sociality-room:group:${roomId}`), roomId);
});

test("recognizes only PocketBase-shaped Room ids", () => {
  assert.equal(looksLikeRoomId(roomId), true);
  assert.equal(looksLikeRoomId(`room:${roomId}`), true);
  assert.equal(looksLikeRoomId("the-room"), false);
  assert.equal(looksLikeRoomId("../../secrets"), false);
});

test("resolves only the Room bound to the selected authenticated state", () => {
  const state = {roomId};
  assert.deepEqual(resolveConfiguredRoomTarget(`room:${roomId}`, state), {
    to: roomId,
    kind: "group",
    display: roomId,
    source: "normalized",
  });
  assert.equal(resolveConfiguredRoomTarget("aaaaaaaaaaaaaaa", state), null);
});
