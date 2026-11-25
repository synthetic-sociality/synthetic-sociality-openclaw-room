import assert from "node:assert/strict";
import test, {mock} from "node:test";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {RoomAPIError} from "../src/room-client.js";

const CASES = [
  "RDC-01 an event-read grant ends the wait immediately with zero extra grant-state reads",
  "RDC-02 fallback state-read waits are at least 2, 4, 8, 10, 10 seconds; early reads fail the case",
  "RDC-03 no state read starts at or after the lease deadline, including a lease shorter than 2 seconds and a next wait crossing the deadline",
  "RDC-04 one multi-event batch performs at most one state read; another batch may read again; another membership never shares its answer",
  "RDC-05 preparing_response allows the first send and a send at 5 seconds, refuses another before 5 seconds in a rolling window, and keeps different turns and memberships independent",
  "RDC-06 pending grant/debounce waits do not delay heartbeat, post, acknowledgement or stop; stop cancels the wait and causes no later read/activity",
  "RDC-07 a Room-stopped membership makes no grant-state read or preparing_response and retains its stop reason; sibling memberships continue",
  "RDC-08 a failed contact or Retry-After cannot create a tight poll or shorten the minimum wait; an event grant still ends waiting",
];
const NOW = Date.parse("2026-11-18T02:00:00Z");
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
async function advance(ms) {
  for (let left = ms; left > 0;) {
    const step = Math.min(left, 250);
    mock.timers.tick(step);
    await flush();
    left -= step;
  }
}
const pending = (runtime, ms = 60_000, turnId = "turn-1") => {
  const result = {};
  result.done = runtime.waitForGrant({turnId, state: "queued", leaseExpiresAt: new Date(Date.now() + ms).toISOString()})
    .then((grant) => { result.grant = grant; }, (error) => { result.error = error; });
  return result;
};

function fixture(member = "member-a", roomId = "room-a") {
  const calls = [];
  const runtime = new OpenClawRoomRuntime({enabled: true});
  runtime.state = {roomId, membershipId: member, cursor: 0, epochSessionRoutingInitialized: true, deliveryIntents: {}, terminalEvidence: {}};
  const record = (kind) => calls.push({kind, at: Date.now() - NOW, member, roomId});
  runtime.client = {
    roomState: async () => { record("state"); return {headSeq: 9, activeEpoch: {id: "epoch-a", startsAtSeq: 1}}; },
    readEvents: async () => { record("events"); return {events: [], activeEpochId: "epoch-a", activeEpochStartsAtSeq: 1}; },
    publishActivity: async (_state, frame) => { record(frame.status || frame.kind); return {acceptedStreamSeq: frame.streamSeq}; },
    heartbeatConnector: async () => { record("heartbeat"); return {}; },
    postMessage: async () => { record("post"); return {}; },
    acknowledge: async () => { record("ack"); return {}; },
    roomPolicy: async () => { record("policy"); return {coordinationMode: "coordinated"}; },
  };
  return {runtime, calls, record};
}

function clockCase(name, body) {
  test(name, async (t) => {
    mock.timers.enable({apis: ["setTimeout", "Date"], now: NOW});
    const runtimes = [];
    const make = (...args) => { const f = fixture(...args); runtimes.push(f.runtime); return f; };
    try { await body({t, make}); }
    finally { for (const runtime of runtimes) await runtime.close(); await flush(); mock.timers.reset(); }
  });
}

async function eventGrant(runtime, turnId = "turn-1", activeChange = false) {
  runtime.client.readEvents = async () => ({events: [{type: activeChange ? "turn.changed" : "turn.granted",
    payload: activeChange ? {activeTurn: {turnId, holderMembershipId: runtime.state.membershipId}}
      : {turnId, holderMembershipId: runtime.state.membershipId}}]});
  await runtime.readEventsResilient(0);
  await flush();
}

clockCase(CASES[0], async ({make}) => {
  for (const activeChange of [false, true]) {
    const {runtime, calls} = make();
    const wait = pending(runtime);
    await advance(1_000);
    await eventGrant(runtime, "turn-1", activeChange);
    assert.equal(wait.grant?.turnId, "turn-1");
    assert.equal(calls.filter((c) => c.kind === "state").length, 0);
  }
});

clockCase(CASES[1], async ({make}) => {
  const {runtime, calls} = make();
  pending(runtime);
  await advance(34_000);
  assert.deepEqual(calls.filter((c) => c.kind === "state").map((c) => c.at), [2_000, 6_000, 14_000, 24_000, 34_000]);
});

clockCase(CASES[2], async ({make}) => {
  for (const [lease, expected] of [[1_000, []], [6_000, [2_000]], [10_000, [2_000, 6_000]]]) {
    const {runtime, calls} = make();
    const start = Date.now() - NOW;
    const wait = pending(runtime, lease);
    await advance(lease);
    assert.ok(wait.error, `wait ends at lease ${lease}`);
    assert.deepEqual(calls.filter((c) => c.kind === "state").map((c) => c.at - start), expected);
    await runtime.close();
  }
});

// Exercise the actual receive loop and cycle-preparation path with two addressed source events per page.
async function receiveBatch(f, offset = 0) {
  const {runtime} = f;
  const abort = new AbortController();
  const events = [1, 2].map((seq) => ({id: `event-${offset + seq}`, seq: offset + seq,
    type: "message.posted", actorRole: "human_owner", actorId: "owner", payload: {body: "fixture"}}));
  runtime.initialize = async () => ({});
  runtime.controlFence = runtime.renewAccess = runtime.applyRecoveryClosures = runtime.maintainPresenceResilient = async () => {};
  runtime.reportLedger = () => {};
  runtime.recordReceived = async () => {};
  runtime.recordTerminalEvidence = async () => {};
  runtime.noteMissedSource = async () => {};
  runtime.recoverPostedEvidence = runtime.recoverPendingDelivery = async () => false;
  runtime.client.startDiscussionCycle = async () => { f.record("cycle"); return {}; };
  runtime.client.roomState = async () => { f.record("state"); return {activeEpoch: {id: "epoch-a", startsAtSeq: 1},
    roster: [{membershipId: runtime.state.membershipId, status: "active", role: "participant_agent"}]}; };
  runtime.client.readEvents = async () => ({events, activeEpochId: "epoch-a", activeEpochStartsAtSeq: 1});
  runtime.ackEvent = async (event) => { f.record("ack"); runtime.state.cursor = event.seq; if (event === events.at(-1)) abort.abort(); };
  for await (const _turn of runtime.assignedTurnsOnce(abort.signal)) assert.fail("cycle source should not dispatch a model");
}

clockCase(CASES[3], async ({make}) => {
  const a = make(), b = make("member-b"), otherRoom = make("member-a", "room-b");
  await receiveBatch(a);
  assert.equal(a.calls.filter((c) => c.kind === "state").length, 1);
  await receiveBatch(a, 2);
  await receiveBatch(b);
  await receiveBatch(otherRoom);
  assert.equal(a.calls.filter((c) => c.kind === "state").length, 2);
  assert.equal(b.calls.filter((c) => c.kind === "state").length, 1);
  assert.equal(otherRoom.calls.filter((c) => c.kind === "state").length, 1);
});

clockCase(CASES[4], async ({make}) => {
  const a = make(), b = make("member-b"), otherRoom = make("member-a", "room-b");
  await a.runtime.markTurnPreparing("source-a");
  await advance(4_999);
  await a.runtime.markTurnPreparing("source-a");
  await a.runtime.markTurnPreparing("source-b");
  await b.runtime.markTurnPreparing("source-a");
  await otherRoom.runtime.markTurnPreparing("source-a");
  await advance(1);
  await a.runtime.markTurnPreparing("source-a");
  await advance(1);
  await a.runtime.markTurnPreparing("source-a");
  assert.deepEqual(a.calls.map((c) => c.at), [0, 4_999, 5_000]);
  assert.equal(b.calls.length, 1);
  assert.equal(otherRoom.calls.length, 1);
});

clockCase(CASES[5], async ({make}) => {
  const {runtime, calls} = make();
  const wait = pending(runtime);
  await runtime.markTurnPreparing("source-a");
  await runtime.markTurnPreparing("source-a");
  // Existing independent heartbeat, post and ack entry points need no request-discipline wait.
  await runtime.client.heartbeatConnector(runtime.state);
  await runtime.client.postMessage(runtime.state, {});
  await runtime.client.acknowledge(runtime.state, 1);
  assert.ok(calls.every((c) => c.at === 0));
  await runtime.close();
  await flush();
  assert.ok(wait.error, "stop cancels pending grant immediately");
  await advance(20_000);
  await runtime.markTurnPreparing("source-b");
  assert.equal(calls.filter((c) => c.kind === "state").length, 0);
  assert.equal(calls.filter((c) => c.kind === "preparing_response").length, 1);
});

clockCase("RDC-06 production send lock: a queued post releases the binding for heartbeats, another post and acknowledgements", async ({make}) => {
  const {runtime, calls, record} = make();
  runtime.persistState = async () => {};
  runtime.connectorSession = {sessionId: "session-a"};
  runtime.acceptConnectorEnrollments = async () => {};
  runtime.idleFrameDue = () => false;
  runtime.client.heartbeat = async () => { record("heartbeat"); return {}; };
  runtime.client.requestTurn = async () => ({turnId: "turn-1", state: "queued", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()});
  runtime.client.postMessage = async () => { record("post"); return {id: "post-a", seq: 10, ts: new Date().toISOString()}; };
  runtime.client.finishTurn = async () => ({});
  const stop = new AbortController();
  const queued = runtime.postAndFinish({roomId: "room-a", text: "queued", idempotencyKey: "queued", signal: stop.signal}).catch(() => {});
  await flush();
  // A later independent open-mode post must not inherit the queued turn's wait.
  runtime.client.roomPolicy = async () => ({coordinationMode: "open"});
  let heartbeatDone = false, postDone = false, ackDone = false;
  const heartbeat = runtime.maintainPresence().then(() => { heartbeatDone = true; });
  const post = runtime.postAndFinish({roomId: "room-a", text: "open", idempotencyKey: "open"}).then(() => { postDone = true; });
  const ack = runtime.markContextAcknowledged({id: "source", seq: 1}).then(() => { ackDone = true; });
  await flush();
  await flush();
  try {
    assert.ok(heartbeatDone && postDone && ackDone, "ordinary traffic finishes without advancing the clock");
    assert.ok(calls.filter((c) => ["heartbeat", "post", "context_acknowledged"].includes(c.kind)).every((c) => c.at === 0));
  } finally {
    // Cancel the grant before close awaits binding operations (also exposes deadlocks).
    stop.abort();
    runtime.heartbeatAbort.abort();
    await flush();
    await Promise.allSettled([queued, heartbeat, post, ack]);
  }
});

clockCase("RDC-05 a failed preparing frame cannot be retried inside five seconds by an acknowledgement", async ({make}) => {
  const {runtime, calls, record} = make();
  let first = true;
  runtime.client.publishActivity = async (_state, frame) => {
    record(frame.status || frame.kind);
    if (first) { first = false; throw new TypeError("fetch failed"); }
    return {acceptedStreamSeq: frame.streamSeq};
  };
  await runtime.markTurnPreparing("source");
  await advance(1_000);
  await runtime.markContextAcknowledged({id: "source", seq: 1});
  assert.deepEqual(calls.map((c) => [c.kind, c.at]), [["preparing_response", 0], ["context_acknowledged", 1_000]]);
});

clockCase("RDC-05 standalone turns without a source event have independent activity windows", async ({make}) => {
  const {runtime, calls} = make();
  runtime.persistState = async () => {};
  runtime.client.roomPolicy = async () => ({coordinationMode: "open"});
  runtime.client.postMessage = async () => ({id: "reply", seq: 10, ts: new Date().toISOString()});
  await runtime.postAndFinish({roomId: "room-a", text: "one", idempotencyKey: "one"});
  await runtime.postAndFinish({roomId: "room-a", text: "two", idempotencyKey: "two"});
  assert.equal(calls.filter((c) => c.kind === "preparing_response").length, 2);
});

clockCase(CASES[6], async ({make}) => {
  const a = make(), b = make("member-b");
  a.runtime.credentialExpired = true;
  let reason = "credential_expired";
  a.runtime.status = {stoppedByRoom: () => true, room: (_r, _m, patch) => { if (patch.errorCode) reason = patch.errorCode; }};
  const wait = pending(a.runtime);
  await a.runtime.markTurnPreparing("source-a");
  pending(b.runtime);
  await b.runtime.markTurnPreparing("source-a");
  await advance(2_000);
  assert.ok(wait.error);
  assert.equal(a.calls.length, 0);
  assert.equal(reason, "credential_expired");
  assert.equal(b.calls.filter((c) => c.kind === "state").length, 1);
  assert.equal(b.calls.filter((c) => c.kind === "preparing_response").length, 1);
});

clockCase(CASES[7], async ({make}) => {
  const a = make();
  let attempt = 0;
  a.runtime.client.roomState = async () => {
    a.record("state");
    if (++attempt <= 2) throw new RoomAPIError(429, {}, {retryAfter: attempt === 1 ? 12 : 1});
    return {};
  };
  const wait = pending(a.runtime);
  await advance(14_000);
  assert.deepEqual(a.calls.map((c) => c.at), [2_000, 14_000]);
  assert.equal(wait.error, undefined, "failed contacts remain in the wait");
  await advance(1_000);
  await eventGrant(a.runtime);
  assert.equal(wait.grant?.turnId, "turn-1", "grant interrupts Retry-After too");
  await advance(10_000);
  assert.equal(a.calls.length, 2);
});

clockCase("RDC request count: 10 queued turns in a busy Room, all general calls per membership in [0, 60000) <= 60", async ({make, t}) => {
  // Ten queued turns requested in [0, 10 s), granted by the next second's event read.
  // The same read also returns other-member traffic every 5 s; one post and ack every 10 s;
  // independent heartbeats every 12 s. Every fake Room call is counted, heartbeats separately.
  const members = [make(), make("member-b")];
  for (let second = 0; second < 60; second++) {
    for (const f of members) {
      if (second >= 1 && second <= 10) {
        f.runtime.client.readEvents = async () => { f.record("events"); return {events: [{type: "turn.granted",
          payload: {turnId: `queued-${second - 1}`, holderMembershipId: f.runtime.state.membershipId}},
          ...(second % 5 === 0 ? [{type: "message.posted", actorId: "other-member", payload: {body: "other member traffic"}}] : [])]}; };
        await f.runtime.readEventsResilient(0);
      }
      if (second < 10) { f.record("request-turn"); pending(f.runtime, 120_000, `queued-${second}`); }
      if (second % 5 === 0 && !(second >= 1 && second <= 10)) {
        f.runtime.client.readEvents = async () => { f.record("events"); return {events: [{type: "message.posted", payload: {body: "other member traffic"}}]}; };
        await f.runtime.readEventsResilient(0);
      }
      if (second % 10 === 0) { await f.runtime.client.postMessage(f.runtime.state, {}); await f.runtime.client.acknowledge(f.runtime.state, second); }
      if (second % 12 === 0) await f.runtime.client.heartbeatConnector(f.runtime.state);
    }
    await advance(1_000);
  }
  const counts = members.map((f) => {
    const within = f.calls.filter((c) => c.at >= 0 && c.at < 60_000);
    const general = within.filter((c) => c.kind !== "heartbeat").length;
    const beats = within.filter((c) => c.kind === "heartbeat").length;
    t.diagnostic(`${f.runtime.state.membershipId}: general=${general}, heartbeats=${beats}, grant-state=${within.filter((c) => c.kind === "state").length}, interval=[0,60000)`);
    return general;
  });
  assert.ok(counts.every((general) => general <= 60), `general calls ${counts} > 60`);
});

clockCase("RDC production request count: ten queued deliveries, busy pages and two grants in [0, 60000), all general calls <= 60", async ({make, t}) => {
  const stop = new AbortController();
  const members = [make(), make("member-b")];
  const jobs = [];
  for (const f of members) {
    const {runtime, record} = f;
    runtime.persistState = async () => {};
    runtime.client.requestTurn = async () => {
      record("request-turn");
      f.requested = (f.requested || 0) + 1;
      f.turnId = `turn-${f.requested}`;
      return {turnId: f.turnId, state: "queued", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()};
    };
    runtime.client.postMessage = async () => { record("post"); return {id: `post-${f.requested}`, seq: 100 + f.requested, ts: new Date().toISOString()}; };
    runtime.client.finishTurn = async () => { record("finish"); return {}; };
    f.completed = 0;
    jobs.push((async () => {
      for (let turn = 0; turn < 10 && !stop.signal.aborted; turn++) {
        await runtime.postAndFinish({roomId: runtime.state.roomId, text: "fixture reply", idempotencyKey: `delivery-${turn}`,
          sourceEventId: `source-${turn}`, signal: stop.signal});
        f.completed++;
      }
    })().catch((error) => { if (!stop.signal.aborted) throw error; }));
  }
  await flush();
  try {
    for (let second = 0; second < 60; second++) {
      for (const f of members) {
        if (second % 5 === 0) {
          f.runtime.client.readEvents = async () => {
            f.record("events");
            return {events: [{type: "message.posted", actorId: "other-member", payload: {body: "busy room"}},
              ...([10, 40].includes(second) ? [{type: "turn.granted", payload: {turnId: f.turnId,
                holderMembershipId: f.runtime.state.membershipId}}] : [])]};
          };
          await f.runtime.readEventsResilient(0);
          await f.runtime.client.acknowledge(f.runtime.state, second + 1);
        }
        if (second % 12 === 0) await f.runtime.client.heartbeatConnector(f.runtime.state);
      }
      await advance(1_000);
    }
    const counts = members.map((f) => {
      const calls = f.calls.filter((c) => c.at >= 0 && c.at < 60_000);
      const general = calls.filter((c) => c.kind !== "heartbeat").length;
      const kinds = Object.fromEntries([...new Set(calls.map((c) => c.kind))].map((kind) => [kind, calls.filter((c) => c.kind === kind).length]));
      t.diagnostic(`${f.runtime.state.membershipId}: ten queued deliveries, completed=${f.completed}, general=${general}, ${JSON.stringify(kinds)}, interval=[0,60000)`);
      return general;
    });
    assert.ok(counts.every((count) => count <= 60), `general calls ${counts} > 60`);
    assert.ok(members.every((f) => f.completed === 2), "both event grants complete real send/lifecycle paths");
  } finally {
    stop.abort();
    await Promise.allSettled(jobs);
  }
});

test("RDC conformance: final shared cases and exact contract digest", async () => {
  const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.deepEqual(conformance.parityP2c3fCases, CASES);
  assert.ok(contract.includes("membership stopped by the Room (P2c-3d) does not use it.\n\nP2c-3f Request discipline"));
  // P2c-3h (0.2.92, markers included) follows P2c-3f directly; P2c-4 follows it.
  assert.ok(contract.includes("re-admission rules permit it.\n\n<<<P2c-3h\nA Room event that the connector has quarantined never holds"));
  assert.ok(contract.includes("Recovery verbs remain available as optional forensics.\nP2c-3h>>>\n\nP2c-4 Local status."));
  assert.equal(createHash("sha256").update(contract).digest("hex"), conformance.contractSha256);
});
