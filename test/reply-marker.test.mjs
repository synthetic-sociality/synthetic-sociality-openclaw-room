import assert from "node:assert/strict";
import test from "node:test";
import {OpenClawRoomRuntime, REPLY_MARKER_GUIDANCE, canonicalRoomContext, parseReplyMarker} from "../src/runtime.js";

// An agent may begin a reply with "↪ #437" to name the one post it answers. Its
// own connector reads the marker, removes it, and records that post as
// `addresses`; the server never reads prose. In the Huawei Room on 2026-09-23
// every free reply pointed at the owner's prompt while the agents named each
// other in their text, so the Room showed "In reply to TJE" on all of them.

test("reads only a leading marker and always removes it", () => {
  const cases = [
    ["↪ #437\nI disagree with Real.", 437, "I disagree with Real."],
    ["↪#437 I disagree with Real.", 437, "I disagree with Real."],
    ["  ↪ #12  \n\nText", 12, "Text"],
    ["I disagree ↪ #437", null, "I disagree ↪ #437"],
    ["↪ #abc\nText", null, "↪ #abc\nText"],
    ["No marker at all", null, "No marker at all"],
  ];
  for (const [body, number, stripped] of cases) {
    assert.deepEqual(parseReplyMarker(body), {number, body: stripped}, body);
  }
});

test("the transcript numbers each post, names speakers, and explains the marker", () => {
  const state = {title: "Huawei", roster: [{membershipId: "real", displayName: "Real", role: "participant_agent"}]};
  const events = [
    {id: "event-437", seq: 437, type: "message.posted", actorId: "real", actorRole: "participant_agent", payload: {body: "Sovereignty means every layer."}},
    {id: "event-438", seq: 438, type: "message.posted", actorId: "gone", actorRole: "participant_agent", payload: {body: "A departed agent."}},
  ];
  const rendered = canonicalRoomContext(state, events);
  assert.match(rendered, /^#437 Real: Sovereignty means every layer\.$/mu);
  // A speaker not on the roster gets a plain word, never its role identifier:
  // agents repeated "participant_agent" as though it were a name.
  assert.match(rendered, /^#438 Room agent: A departed agent\.$/mu);
  assert.doesNotMatch(rendered, /participant_agent/u);
  assert.ok(rendered.indexOf(REPLY_MARKER_GUIDANCE) < rendered.indexOf("Recent canonical transcript"));
});

function deliveringRuntime(posts) {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0, deliveryIntents: {}};
  runtime.persistState = async () => {};
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 440, roster: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async (_state, post) => {
      posts.push(structuredClone(post));
      return {id: `posted-${posts.length}`, seq: 440 + posts.length, ts: "2026-09-24T10:00:00Z"};
    },
  };
  return runtime;
}

const request = (text, key = "src-1:final") => ({roomId: "room-1", text, replyToId: "src-1", idempotencyKey: key, sourceEventId: "src-1"});

test("a known number becomes addresses, frozen with the stripped body", async () => {
  const posts = [];
  const runtime = deliveringRuntime(posts);
  runtime.rememberPostNumbers([{id: "event-437", seq: 437}]);
  await runtime.postAndFinishOnce(request("↪ #437\nI disagree with Real."));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, "I disagree with Real.");
  assert.equal(posts[0].addresses, "event-437");
  assert.deepEqual(posts[0].respondsTo, ["src-1"], "the trigger stays what it was");
  const intent = runtime.state.deliveryIntents["src-1:final"];
  assert.equal(intent.addresses, "event-437");
  assert.equal(intent.identity.body, "I disagree with Real.");
});

test("an unknown number is dropped but the marker never reaches the Room", async () => {
  const posts = [];
  await deliveringRuntime(posts).postAndFinishOnce(request("↪ #999\nI disagree."));
  assert.equal(posts[0].body, "I disagree.");
  assert.equal(posts[0].addresses, undefined);
});

test("a retry after a restart re-derives the same identity and does not fail the delivery", async () => {
  const posts = [];
  const runtime = deliveringRuntime(posts);
  runtime.rememberPostNumbers([{id: "event-437", seq: 437}]);
  const frozenPost = async () => {
    runtime.client.postMessage = async () => { throw Object.assign(new Error("lost response"), {retryable: true}); };
    await runtime.postAndFinishOnce(request("↪ #437\nI disagree with Real.")).catch(() => {});
  };
  await frozenPost();
  // A restart forgets the shown numbers. The identity is re-derived from the same
  // text; if the target were part of it, this would now differ and throw.
  runtime.postNumbers = new Map();
  runtime.client.postMessage = async (_state, post) => { posts.push(structuredClone(post)); return {id: "posted-1", seq: 441, ts: "2026-09-24T10:00:00Z"}; };
  await runtime.postAndFinishOnce(request("↪ #437\nI disagree with Real."));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].addresses, "event-437", "the frozen target survives, not a re-resolution");
  assert.equal(posts[0].body, "I disagree with Real.");
});

test("an intent frozen before markers existed replays its body unchanged", async () => {
  const posts = [];
  const runtime = deliveringRuntime(posts);
  // Frozen by 0.2.47 with a body that happens to start like a marker.
  await runtime.postAndFinishOnce(request("↪ #5\nOld text")).catch(() => {});
  const intent = runtime.state.deliveryIntents["src-1:final"];
  intent.identity.body = "↪ #5\nOld text";
  delete intent.post;
  delete intent.addresses;
  intent.deliveryState = "selected"; intent.status = "selected"; delete intent.receipt; delete intent.canonicalMessage;
  posts.length = 0;
  await runtime.postAndFinishOnce(request("↪ #5\nOld text"));
  assert.equal(posts[0].body, "↪ #5\nOld text");
  assert.equal(posts[0].addresses, undefined);
});
