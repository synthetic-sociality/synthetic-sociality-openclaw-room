import assert from "node:assert/strict";
import test from "node:test";
import {RoomClient} from "../src/room-client.js";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {saveState} from "../src/state.js";

function mockFetch(captured, overrides = {}) {
  return async (url, init) => {
    captured.push({url, body: init?.body ? JSON.parse(init.body) : undefined});
    if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "s1", heartbeatIntervalSeconds: 60}), {status: 200});
    if (url.endsWith("/heartbeat")) return new Response(JSON.stringify({}), {status: 200});
    if (url.endsWith("/activity")) return new Response(JSON.stringify({acceptedStreamSeq: 1}), {status: 202});
    if (url.endsWith("/turns/request")) return new Response(JSON.stringify({turnId: "t1", state: "granted", holderMembershipId: "member-1"}), {status: 202});
    if (url.endsWith("/messages")) return new Response(JSON.stringify({id: "msg-1", seq: 5, ts: new Date().toISOString()}), {status: 201});
    if (url.endsWith("/turns/finish")) return new Response(JSON.stringify({turnId: "t1", state: "finished"}), {status: 200});
    if (url.endsWith("/state")) return new Response(JSON.stringify({headSeq: 3, ...(overrides.state ?? {activeEpochId: "ep-1"})}), {status: 200});
    throw new Error(`unexpected request: ${url}`);
  };
}

// ── contributionType regression ──────────────────────────────────────

test("postAndFinish sends contributionType claim (not rejected text)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-api-"));
  const stateFile = join(dir, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "c1", cursor: 0,
  });

  const captured = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: mockFetch(captured),
  });

  await runtime.initialize();
  await runtime.postAndFinish({roomId: "room-1", text: "Hello", idempotencyKey: "ik-1"});

  const msgReq = captured.find((c) => c.url.endsWith("/messages"));
  assert.ok(msgReq, "postAndFinish must POST to /messages");
  assert.equal(msgReq.body.contributionType, "claim",
    `contributionType must be claim, got ${msgReq.body.contributionType}`);
  assert.equal(msgReq.body.turnId, "t1");
  await runtime.close();
});

test("postAndFinish reads activeEpoch.id from state (canonical shape)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-api-"));
  const stateFile = join(dir, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "c1", cursor: 0,
  });

  const captured = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: mockFetch(captured, {state: {activeEpoch: {id: "epoch-canonical"}}}),
  });

  await runtime.initialize();
  await runtime.postAndFinish({roomId: "room-1", text: "Hello", idempotencyKey: "ik-1"});

  const msgReq = captured.find((c) => c.url.endsWith("/messages"));
  assert.equal(msgReq.body.observedEpochId, "epoch-canonical",
    `observedEpochId must be epoch-canonical, got ${msgReq.body.observedEpochId}`);
  await runtime.close();
});

// ── API endpoint regression ──────────────────────────────────────────

test("connector uses /turns/request and /turns/finish (no removed paths)", async () => {
  const turned = [];
  const finished = [];
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/turns/request")) {
      turned.push(body);
      return new Response(JSON.stringify({turnId: "t-1", state: "granted"}), {status: 202});
    }
    if (url.endsWith("/turns/finish")) {
      finished.push(body);
      return new Response(JSON.stringify({turnId: "t-1", state: "finished"}), {status: 200});
    }
    throw new Error(`unexpected: ${url}`);
  }});
  const session = {roomId: "room-1", credential: "secret"};
  const turn = await client.requestTurn(session, {observedSeq: 1, idempotencyKey: "req-1"});
  assert.equal(turn.turnId, "t-1");
  const result = await client.finishTurn(session, {turnId: turn.turnId, observedSeq: 2, idempotencyKey: "fin-1"});
  assert.equal(result.state, "finished");
});

test("API errors do not silently swallow — non-retryable codes throw", async () => {
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async () =>
    new Response(JSON.stringify({code: "stale_context", message: "stale"}), {status: 400})});
  await assert.rejects(() => client.roomState({roomId: "room-1", credential: "secret"}), (error) => {
    assert.ok(!error.retryable, "400 stale_context must NOT be retryable");
    return true;
  });
});

test("postAndFinish emits preparing_response and terminal posted activity frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-api-"));
  const stateFile = join(dir, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "c1", cursor: 0,
  });

  const activityFrames = [];
  const captured = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      captured.push({url, body});
      if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "s1", heartbeatIntervalSeconds: 60}), {status: 200});
      if (url.endsWith("/heartbeat")) return new Response(JSON.stringify({}), {status: 200});
      if (url.endsWith("/activity")) {
        activityFrames.push(body);
        return new Response(JSON.stringify({acceptedStreamSeq: body.streamSeq}), {status: 202});
      }
      if (url.endsWith("/turns/request")) return new Response(JSON.stringify({turnId: "t1", state: "granted", holderMembershipId: "member-1"}), {status: 202});
      if (url.endsWith("/messages")) return new Response(JSON.stringify({id: "msg-1", seq: 5, ts: new Date().toISOString()}), {status: 201});
      if (url.endsWith("/turns/finish")) return new Response(JSON.stringify({turnId: "t1", state: "finished"}), {status: 200});
      if (url.endsWith("/state")) return new Response(JSON.stringify({headSeq: 3, activeEpoch: {id: "ep-1"}}), {status: 200});
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await runtime.initialize();
  try {
    await runtime.postAndFinish({roomId: "room-1", text: "Hello", idempotencyKey: "ik-1", sourceEventId: "src-1"});

    const preparing = activityFrames.find((f) => f.kind === "lifecycle" && f.status === "preparing_response");
    assert.ok(preparing, "must emit lifecycle preparing_response");
    assert.equal(preparing.sourceEventId, "src-1");
    assert.equal(preparing.runId, runtime.activityRunId, "activity frames use the activity run id");

    const terminal = activityFrames.find((f) => f.kind === "terminal" && f.status === "posted");
    assert.ok(terminal, "must emit terminal posted");
    assert.equal(terminal.sourceEventId, "src-1");
    assert.equal(terminal.canonicalEventId, "msg-1");
  } finally {
    await runtime.close();
  }
});

test("assignedTurns emits context_acknowledged for assigned messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-api-"));
  const stateFile = join(dir, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "c1", cursor: 0,
  });

  const activityFrames = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "s1", heartbeatIntervalSeconds: 60}), {status: 200});
      if (url.endsWith("/heartbeat")) return new Response(JSON.stringify({}), {status: 200});
      if (url.endsWith("/activity")) {
        activityFrames.push(body);
        return new Response(JSON.stringify({acceptedStreamSeq: body.streamSeq}), {status: 202});
      }
      if (url.endsWith("/events")) return new Response(JSON.stringify({events: [], headSeq: 5}), {status: 200});
      if (url.endsWith("/state")) return new Response(JSON.stringify({headSeq: 3, activeEpoch: {id: "ep-1"}}), {status: 200});
      if (url.endsWith("/acknowledgements")) return new Response(JSON.stringify({acknowledgedSeq: 2}), {status: 200});
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await runtime.initialize();
  try {
    // Simulate an assigned event via isAssignedMessage path: publish directly
    await runtime.markContextAcknowledged({id: "event-1", seq: 7}, undefined);

    const ack = activityFrames.find((f) => f.kind === "context_acknowledged");
    assert.ok(ack, "must emit context_acknowledged");
    assert.equal(ack.sourceEventId, "event-1");
    assert.equal(ack.sourceSeq, 7);
    assert.equal(ack.streamSeq, ack.streamSeq);
  } finally {
    await runtime.close();
  }
});

test("activity publication failure never terminates the connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-api-"));
  const stateFile = join(dir, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "c1", cursor: 0,
  });

  const warnings = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url) => {
      if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "s1", heartbeatIntervalSeconds: 60}), {status: 200});
      if (url.endsWith("/activity")) return new Response("temporary failure", {status: 503});
      throw new Error(`unexpected request: ${url}`);
    },
    logger: {warn: (message) => warnings.push(message)},
  });

  await runtime.initialize();
  try {
    await assert.doesNotReject(() => runtime.publishActivityFrame({kind: "lifecycle", status: "reading_shared_room"}));
    assert.ok(runtime.activityError, "must retain the activity publish error for diagnostics");
    assert.ok(warnings.some((message) => /publish failed kind=lifecycle/.test(message)));
  } finally {
    await runtime.close();
  }
});
