import test from "node:test";
import assert from "node:assert/strict";
import {RoomClient, RoomAPIError} from "../src/room-client.js";

test("rejects non-local plaintext transport", () => {
  assert.throws(() => new RoomClient({baseUrl: "http://room.example/api"}), /HTTPS/);
});

test("uses scoped credential and exact connector routes", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({url, init});
    return new Response(JSON.stringify({sessionId: "session-1"}), {status: 200, headers: {"content-type": "application/json"}});
  };
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl});
  const session = {roomId: "room/a", credential: "secret"};
  await client.register(session, {clientInstanceId: "install-1", contractVersion: 1});
  await client.heartbeat(session, "session/1");
  assert.equal(seen[0].url, "https://room.example/api/rooms/room%2Fa/connector/sessions");
  assert.equal(seen[1].url, "https://room.example/api/rooms/room%2Fa/connector/sessions/session%2F1/heartbeat");
  assert.equal(seen[0].init.headers.Authorization, "Bearer secret");
  assert.equal(seen[0].init.redirect, "error");
});

test("never sends invitation credential as authorization", async () => {
  let captured;
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url, init) => {
    captured = {url, init};
    return new Response(JSON.stringify({roomId: "room-1"}), {status: 200});
  }});
  await client.redeemInvitation({invitationToken: "one-time-secret", identity: {displayName: "Aura"}});
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.match(captured.init.body, /one-time-secret/);
});

test("reports structured retryable API failures", async () => {
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async () =>
    new Response(JSON.stringify({code: "busy", message: "try later", retryable: true}), {status: 503})});
  await assert.rejects(() => client.roomState({roomId: "room-1", credential: "secret"}), (error) => {
    assert.ok(error instanceof RoomAPIError);
    assert.equal(error.code, "busy");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("uses canonical state and long-poll query names", async () => {
  const urls = [];
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({events: [], headSeq: 2}), {status: 200});
  }});
  const session = {roomId: "room-1", credential: "secret"};
  await client.roomState(session);
  await client.readEvents(session, 2, {wait: 20});
  assert.equal(urls[0], "https://room.example/api/rooms/room-1/state");
  assert.equal(urls[1], "https://room.example/api/rooms/room-1/events?after=2&limit=100&waitSeconds=20");
});
