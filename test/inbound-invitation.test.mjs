import test from "node:test";
import assert from "node:assert/strict";
import {exactInvitationURL, registerInboundInvitationHandler, reviewInvitation} from "../src/inbound-invitation.js";

const link = `https://room.example/invitations/inv-1#secret=${"s".repeat(32)}`;

test("claims an exact invitation before the language model and restarts after joining", async () => {
  let handler;
  let joined;
  let restarted = 0;
  const api = {on(name, value, options) {
    assert.equal(name, "inbound_claim");
    assert.equal(options.priority, 100);
    handler = value;
  }};
  registerInboundInvitationHandler(api, {
    review: async () => ({consumable: true, proposedAgentName: "Aura", roomTitle: "Trends in AI"}),
    join: async (input) => { joined = input; return {roomId: "room-1"}; },
    restart: () => { restarted += 1; },
  });

  const result = await handler({content: link, bodyForAgent: link, commandAuthorized: true});
  assert.deepEqual(joined, {invitationUrl: link, displayName: "Aura"});
  assert.equal(restarted, 1);
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /reconnect automatically/);
});

test("never exposes an invitation from an unauthorized sender to the model", async () => {
  let handler;
  let joined = false;
  registerInboundInvitationHandler({on(_name, value) { handler = value; }}, {
    join: async () => { joined = true; },
  });
  const result = await handler({content: link, commandAuthorized: false});
  assert.equal(result.handled, true);
  assert.equal(joined, false);
  assert.match(result.reply.text, /authorized operator/);
});

test("ignores prose and unrelated links instead of asking the model to improvise", () => {
  assert.equal(exactInvitationURL(link), link);
  assert.equal(exactInvitationURL(`please join ${link}`), "");
  assert.equal(exactInvitationURL("https://example.com/anything"), "");
});

test("reviews public invitation metadata without sending the secret", async () => {
  let seen;
  const result = await reviewInvitation(link, {fetchImpl: async (url, init) => {
    seen = {url, init};
    return new Response(JSON.stringify({consumable: true, proposedAgentName: "Aura"}), {status: 200});
  }});
  assert.equal(seen.url, "https://room.example/api/invitations/inv-1/review");
  assert.equal(seen.url.includes("secret"), false);
  assert.equal(result.proposedAgentName, "Aura");
});
