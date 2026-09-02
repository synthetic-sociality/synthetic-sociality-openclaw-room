import test from "node:test";
import assert from "node:assert/strict";
import {RoomClient, RoomAPIError} from "../src/room-client.js";

test("accepts a room state response larger than one MiB", async () => {
  const payload = JSON.stringify({avatarDataUrl: `data:image/png;base64,${"a".repeat((1 << 20) + 32)}`});
  const client = new RoomClient({baseUrl: "https://room.example", fetchImpl: async () => new Response(payload, {status: 200})});
  const result = await client.roomState({roomId: "room", credential: "secret"});
  assert.equal(result.avatarDataUrl.length > (1 << 20), true);
});

test("rejects non-local plaintext transport", () => {
  assert.throws(() => new RoomClient({baseUrl: "http://room.example/api"}), /HTTPS/);
});

test("uses scoped credential and exact connector routes", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({url, init});
    const status = url.endsWith("/activity") ? 202 : 200;
    return new Response(JSON.stringify({sessionId: "session-1"}), {status, headers: {"content-type": "application/json"}});
  };
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl});
  const session = {roomId: "room/a", credential: "secret"};
  await client.register(session, {clientInstanceId: "install-1", contractVersion: 1});
  await client.heartbeat(session, "session/1");
  await client.publishActivity(session, {version: 1, kind: "heartbeat", runId: "presence-1", streamSeq: 1});
  assert.equal(seen[0].url, "https://room.example/api/rooms/room%2Fa/connector/sessions");
  assert.equal(seen[1].url, "https://room.example/api/rooms/room%2Fa/connector/sessions/session%2F1/heartbeat");
  assert.equal(seen[2].url, "https://room.example/api/rooms/room%2Fa/activity");
  assert.deepEqual(JSON.parse(seen[2].init.body), {version: 1, kind: "heartbeat", runId: "presence-1", streamSeq: 1});
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

test("redeems a device pairing code on the exact public route without authorization", async () => {
  let captured;
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url, init) => {
    captured = {url, init};
    return new Response(JSON.stringify({roomId: "room-1", membershipId: "member-1"}), {status: 200});
  }});
  await client.redeemPairing({deviceCode: "ABCDEFG2", identity: {displayName: "Aura", systemDescriptor: "OpenClaw"}});
  assert.equal(captured.url, "https://room.example/api/invitation-pairings/redeem");
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(captured.init.body), {
    deviceCode: "ABCDEFG2",
    identity: {displayName: "Aura", systemDescriptor: "OpenClaw"},
  });
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

test("validation diagnostics expose only status API code and field paths", async () => {
  const secretToken = "token-super-secret";
  const privateId = "membership-private-id";
  const privateBody = "confidential contribution text";
  const responseBody = {
    code: "request_validation_failed",
    message: `request validation failed for ${secretToken} ${privateId}`,
    requestId: privateId,
    body: {content: privateBody, token: secretToken},
    errors: [
      {path: ["body", "logicalContributionId"], message: privateId, value: privateId},
      {fieldPath: "body.recipientSelectors[0].membershipId", rejected: privateId},
      {path: ["body", secretToken], message: privateBody},
    ],
  };
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async () =>
    new Response(JSON.stringify(responseBody), {status: 422})});
  await assert.rejects(() => client.roomState({roomId: "room-1", credential: secretToken}), (error) => {
    assert.ok(error instanceof RoomAPIError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "request_validation_failed");
    assert.deepEqual(error.fieldPaths, ["body.logicalContributionId", "body.recipientSelectors[0].membershipId"]);
    const diagnostic = JSON.stringify({message: error.message, status: error.status, code: error.code, fieldPaths: error.fieldPaths});
    assert.match(diagnostic, /422/);
    assert.match(diagnostic, /request_validation_failed/);
    assert.doesNotMatch(diagnostic, new RegExp([secretToken, privateId, privateBody].join("|")));
    assert.equal("body" in error, false);
    return true;
  });
});

test("unsafe API codes and field paths are omitted from diagnostics", () => {
  const error = new RoomAPIError(400, {
    code: "tokensecretvalue",
    errors: [{fieldPath: "body.tokensecretvalue"}],
    message: "secret content",
  });
  assert.equal(error.code, "");
  assert.deepEqual(error.fieldPaths, []);
  assert.equal(error.message, "Room API request failed (status=400)");
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

test("reads artifact derived text through the membership-authorized route", async () => {
  let captured;
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url, init) => {
    captured = {url, init};
    return new Response(JSON.stringify({artifactId: "artifact/1"}), {status: 200});
  }});
  await client.getArtifact({roomId: "room one", credential: "room-secret"}, "artifact/1");
  assert.equal(captured.url, "https://room.example/api/rooms/room%20one/artifacts/artifact%2F1");
  assert.equal(captured.init.headers.Authorization, "Bearer room-secret");
  assert.equal(captured.init.method, "GET");
  await client.listArtifacts({roomId: "room one", credential: "room-secret"});
  assert.equal(captured.url, "https://room.example/api/rooms/room%20one/artifacts");
  assert.equal(captured.init.headers.Authorization, "Bearer room-secret");
});
