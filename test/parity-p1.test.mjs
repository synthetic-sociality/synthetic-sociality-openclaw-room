// Shared conformance cases for parity release P1 (delivery contract section
// "P1 — Refusal, attempt authority and failure reporting"). Case names are
// identical in the Hermes and OpenClaw conformance.json files.
import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(join(tmpdir(), "openclaw-room-parity-p1-"));
process.env.HOME = home;
const {createRoomChannel} = await import("../src/channel.js");
const {
  OpenClawRoomRuntime, attemptRenewalDelaySeconds, classifyPostRefusal,
} = await import("../src/runtime.js");
const {RoomAPIError, SAFE_API_CODES} = await import("../src/room-client.js");
const {loadState, saveState, validateState} = await import("../src/state.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const SECRET = "p1-credential-never-logged";
const BODY = "P1 reply body that must never reach a log line";
const SOURCE = {id: "ready-5", seq: 5};
const CYCLE = () => ({
  cycle: {id: "cycle-1", generation: 3},
  attempt: {id: "attempt-1", membershipId: "member-1", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()},
  settled: false,
});

function p1Runtime() {
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: SECRET, clientInstanceId: "client-1",
    cursor: 4, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
  };
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.snapshots = [];
  runtime.persistState = async () => { runtime.snapshots.push(structuredClone(runtime.state)); };
  runtime.lines = [];
  runtime.logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (line) => runtime.lines.push(`${level} ${line}`)]));
  return runtime;
}

function recordingClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    claimDiscussionAttempt: async (_state, cycleId) => {
      calls.push(["claim", cycleId]);
      const attempt = CYCLE();
      return {cycle: attempt.cycle, attempt: attempt.attempt};
    },
    postMessage: async (_state, post) => {
      calls.push(["post", post.idempotencyKey, post.observedSeq]);
      return {id: "posted-6", seq: 6, ts: "2026-10-01T10:00:00Z"};
    },
    completeDiscussionAttempt: async (_state, cycleId, attemptId, request) => {
      calls.push(["complete", attemptId, structuredClone(request)]);
      return {};
    },
    ...overrides,
  };
  return client;
}

function cyclePost(runtime, cycleAttempt, extra = {}) {
  return runtime.postAndFinish({
    roomId: "room-1", text: BODY, replyToId: "human-1",
    idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id, cycleAttempt, ...extra,
  });
}

function channelContext(stateFile, run, controller = new AbortController()) {
  let status = {running: false, connected: false};
  return {
    account: {accountId: "default", stateFile},
    accountId: "default",
    abortSignal: controller.signal,
    cfg: {},
    channelRuntime: {
      inbound: {run},
      routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
      session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
      reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
    },
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: () => {}, error: () => {}},
  };
}

// The host swallows a thrown delivery and continues; mirror that here.
const hostDeliver = (text, payload = {}) => async ({raw, adapter}) => {
  const turn = adapter.resolveTurn(adapter.ingest(raw));
  try { await turn.delivery.deliver({text, ...payload}); } catch {}
};

test("P1-01 lease renewed while model runs; post after re-claim", async () => {
  const now = Date.parse("2026-10-01T09:59:36.896Z");
  assert.equal(attemptRenewalDelaySeconds("2026-10-01T10:01:37.859Z", now), 30);
  assert.equal(attemptRenewalDelaySeconds(new Date(now + 6_000).toISOString(), now), 2);
  assert.equal(attemptRenewalDelaySeconds(new Date(now - 1_000).toISOString(), now), 1);
  assert.equal(attemptRenewalDelaySeconds("not-a-time", now), 30);

  const runtime = p1Runtime();
  runtime.client = recordingClient();
  runtime.pendingEvent = SOURCE;
  const cycleAttempt = CYCLE();
  // A lease about to run out renews after max(1, remaining/3) seconds.
  cycleAttempt.attempt.leaseExpiresAt = new Date(Date.now() + 2_000).toISOString();
  const lease = runtime.startAttemptLease(SOURCE, cycleAttempt);
  assert.ok(lease.timer, "renewal is scheduled when the model run starts");
  const deadline = Date.now() + 10_000;
  while (runtime.client.calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  await lease.inflight;
  assert.deepEqual(runtime.client.calls, [["claim", "cycle-1"]], "the timer renewed the lease while the model ran");
  assert.ok(Date.parse(cycleAttempt.attempt.leaseExpiresAt) > Date.now() + 60_000, "the renewed expiry is kept");
  assert.ok(lease.timer, "the next renewal is scheduled");

  const receipt = await cyclePost(runtime, cycleAttempt);
  assert.equal(receipt.eventId, "posted-6");
  assert.deepEqual(runtime.client.calls.map(([kind]) => kind), ["claim", "claim", "post", "complete"]);
  assert.equal(lease.stopped, true, "renewal stops before the pre-post re-claim");
  assert.equal(lease.timer, null);
  assert.equal(runtime.state.deliveryIntents[`${SOURCE.id}:final`].deliveryState, "posted");
});

test("P1-02 re-claim failure supersedes without post", async () => {
  const cases = [
    ["renewal refused", async (runtime, lease) => runtime.renewAttemptLease(lease), {code: "cycle_superseded"}, "cycle_superseded"],
    // Unreachable is transient: retried within the lease, lost once it has run out (P1-1).
    ["renewal unreachable until the lease runs out", async (runtime, lease) => {
      await runtime.renewAttemptLease(lease);
      while (!lease.superseded) await new Promise((resolve) => setTimeout(resolve, 10));
    }, new Error("socket hang up"), "attempt_renewal_failed"],
    ["renewal returns another attempt", async (runtime, lease) => runtime.renewAttemptLease(lease), "other", "attempt_superseded"],
    ["pre-post re-claim refused", async () => {}, {code: "cycle_no_attempt", retryable: true}, "cycle_no_attempt"],
  ];
  for (const [label, during, refusal, reason] of cases) {
    const runtime = p1Runtime();
    runtime.client = recordingClient({
      claimDiscussionAttempt: async () => {
        runtime.client.calls.push(["claim"]);
        if (refusal === "other") return {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-2", membershipId: "member-1"}};
        if (refusal instanceof Error) throw refusal;
        throw new RoomAPIError(409, refusal);
      },
    });
    runtime.pendingEvent = SOURCE;
    runtime.attemptRenewalRetryMs = 20;
    const cycleAttempt = CYCLE();
    if (refusal instanceof Error) cycleAttempt.attempt.leaseExpiresAt = new Date(Date.now() + 200).toISOString();
    const lease = runtime.startAttemptLease(SOURCE, cycleAttempt);
    await during(runtime, lease);
    const result = await cyclePost(runtime, cycleAttempt);
    assert.deepEqual(result, {superseded: true, reason}, label);
    const calls = runtime.client.calls;
    assert.equal(calls.filter(([kind]) => kind === "post").length, 0, `${label}: no post follows`);
    assert.deepEqual(calls.filter(([kind]) => kind === "complete").map(([, , request]) => request), [
      {generation: 3, action: "fail", executionFailure: {layer: "infrastructure", code: "attempt_timeout"}},
    ], `${label}: the lost attempt is released once with a typed fail`);
    const intent = runtime.state.deliveryIntents[`${SOURCE.id}:final`];
    assert.equal(intent.deliveryState, "superseded", label);
    assert.equal(intent.identity.body, BODY, `${label}: the reply stays in the intent`);
    assert.equal(runtime.state.terminalEvidence["5"].status, "superseded", label);
    assert.equal(runtime.state.terminalEvidence["5"].reason, reason, label);
    // Durable: the first write after loss already carries the superseded evidence.
    assert.ok(runtime.snapshots.some((state) => state.terminalEvidence?.["5"]?.status === "superseded"), label);
    // Monotonic: no later skip, replay or restart can downgrade it.
    await runtime.recordSkipped(SOURCE.id, "model_no_visible_reply");
    assert.equal(runtime.state.terminalEvidence["5"].status, "superseded", label);
    assert.deepEqual(await cyclePost(runtime, cycleAttempt), {superseded: true, reason}, `${label}: replay`);
    assert.equal(runtime.client.calls.filter(([kind]) => kind === "post").length, 0, `${label}: replay never posts`);
    assert.equal(lease.timer, null, `${label}: renewal stopped`);
    validateState(runtime.state);
  }
});

test("P1-03 post refused cycle_superseded → superseded, not pass, not model_no_visible_reply", async () => {
  const runtime = p1Runtime();
  runtime.client = recordingClient({
    postMessage: async () => {
      runtime.client.calls.push(["post"]);
      throw new RoomAPIError(409, {code: "cycle_superseded", retryable: false});
    },
  });
  runtime.pendingEvent = SOURCE;
  const cycleAttempt = CYCLE();
  runtime.startAttemptLease(SOURCE, cycleAttempt);
  assert.deepEqual(await cyclePost(runtime, cycleAttempt), {superseded: true, reason: "cycle_superseded"});
  const intent = runtime.state.deliveryIntents[`${SOURCE.id}:final`];
  assert.equal(intent.status, "superseded");
  assert.equal(intent.supersededReason, "cycle_superseded");
  assert.equal(intent.identity.body, BODY);
  assert.deepEqual(runtime.state.terminalEvidence["5"], {
    status: "superseded", sourceEventId: SOURCE.id, sourceSeq: 5,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "cycle_superseded",
  });
  const actions = runtime.client.calls.filter(([kind]) => kind === "complete").map(([, , request]) => request.action);
  assert.deepEqual(actions, ["fail"], "never pass");
  await runtime.recordSkipped(SOURCE.id);
  assert.equal(runtime.state.terminalEvidence["5"].reason, "cycle_superseded");

  // Channel: a superseded reply settles nothing further and records no skip.
  const calls = {settled: [], skipped: [], ack: []};
  const event = {
    id: "ready-5", sourceEventId: "ready-5", respondsToId: "human-1", roomId: "room-1", epochId: "epoch-1",
    conversationId: "room-1:epoch:x", senderId: "system", senderName: "Room", senderKind: "human",
    text: "turn", occurredAt: 1, raw: {}, cycleAttempt: CYCLE(),
  };
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { yield event; },
    markTurnReading: async () => {},
    postAndFinish: async () => ({superseded: true, reason: "cycle_superseded"}),
    settleDiscussionAttempt: async (_attempt, action) => calls.settled.push(action),
    recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
    ack: async (eventId) => calls.ack.push(eventId),
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  await channel.plugin.gateway.startAccount(channelContext(join(home, "p1-03.json"), hostDeliver(BODY)));
  assert.deepEqual(calls, {settled: [], skipped: [], ack: ["ready-5"]});
});

test("P1-04 post refused stale_epoch / turn_not_active / turn_expired → superseded", async () => {
  // Retryable flags as the Room sends them (message_submission.go).
  for (const [code, retryable, mode] of [
    ["stale_epoch", true, "open"],
    ["turn_not_active", false, "coordinated"],
    ["turn_expired", true, "coordinated"],
  ]) {
    const runtime = p1Runtime();
    runtime.client = recordingClient({
      roomPolicy: async () => ({policy: {coordinationMode: mode}}),
      requestTurn: async () => ({state: "granted", turnId: "turn-1"}),
      postMessage: async () => {
        runtime.client.calls.push(["post"]);
        throw new RoomAPIError(409, {code, retryable});
      },
    });
    runtime.pendingEvent = SOURCE;
    const request = {roomId: "room-1", text: BODY, replyToId: "human-1", idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id};
    assert.deepEqual(await runtime.postAndFinish(request), {superseded: true, reason: code}, code);
    assert.equal(classifyPostRefusal(new RoomAPIError(409, {code, retryable}), runtime.state.deliveryIntents[request.idempotencyKey]).outcome, "superseded");
    const intent = runtime.state.deliveryIntents[request.idempotencyKey];
    assert.equal(intent.deliveryState, "superseded", code);
    assert.equal(intent.identity.body, BODY, code);
    assert.equal(runtime.state.terminalEvidence["5"].reason, code);
    assert.deepEqual(await runtime.postAndFinish(request), {superseded: true, reason: code}, `${code} replay`);
    assert.equal(runtime.client.calls.filter(([kind]) => kind === "post").length, 1, `${code}: never reposted`);
    validateState(runtime.state);
  }
});

test("P1-05 post refused stale_context → refresh and re-key once, then post", async () => {
  const stale = () => new RoomAPIError(409, {code: "stale_context", retryable: true});
  {
    const runtime = p1Runtime();
    let head = 5;
    runtime.client = recordingClient({
      roomState: async () => ({headSeq: head, activeEpoch: {id: "epoch-1"}}),
      postMessage: async (_state, post) => {
        runtime.client.calls.push(["post", post.idempotencyKey, post.observedSeq, post.body]);
        if (runtime.client.calls.filter(([kind]) => kind === "post").length === 1) {
          head = 7;
          throw stale();
        }
        return {id: "posted-8", seq: 8, ts: "2026-10-01T10:00:00Z"};
      },
    });
    runtime.pendingEvent = SOURCE;
    const receipt = await runtime.postAndFinish({
      roomId: "room-1", text: BODY, replyToId: "human-1", idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id,
    });
    assert.equal(receipt.eventId, "posted-8");
    const posts = runtime.client.calls.filter(([kind]) => kind === "post");
    assert.equal(posts.length, 2);
    assert.equal(posts[0][3], posts[1][3], "the same frozen contribution is re-posted");
    assert.equal(posts[0][2], 5);
    assert.equal(posts[1][2], 7, "observedSeq follows the newer head");
    assert.notEqual(posts[0][1], posts[1][1], "the observation-scoped key changes with observedSeq");
    const intent = runtime.state.deliveryIntents[`${SOURCE.id}:final`];
    assert.deepEqual(intent.supersededIdempotencyAttempts, [{idempotencyKey: posts[0][1], observedSeq: 5, reason: "stale_context"}]);
    assert.equal(intent.post.idempotencyKey, intent.messageIdempotencyKey);
    validateState(runtime.state);
  }
  // A head that is not newer is not re-keyed: the frozen request stays parked.
  {
    const runtime = p1Runtime();
    runtime.client = recordingClient({postMessage: async () => { runtime.client.calls.push(["post"]); throw stale(); }});
    runtime.pendingEvent = SOURCE;
    await assert.rejects(runtime.postAndFinish({
      roomId: "room-1", text: BODY, idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id,
    }), (error) => error.roomDeliveryOutcome === "delivery_pending");
    assert.equal(runtime.client.calls.length, 1);
  }
  // Bounded: each newer head re-keys once, at most two refreshes per call.
  {
    const runtime = p1Runtime();
    let head = 5;
    runtime.client = recordingClient({
      roomState: async () => ({headSeq: head, activeEpoch: {id: "epoch-1"}}),
      postMessage: async () => { runtime.client.calls.push(["post"]); head += 1; throw stale(); },
    });
    runtime.pendingEvent = SOURCE;
    await assert.rejects(runtime.postAndFinish({
      roomId: "room-1", text: BODY, idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id,
    }), RoomAPIError);
    assert.equal(runtime.client.calls.length, 3);
    assert.equal(runtime.state.deliveryIntents[`${SOURCE.id}:final`].deliveryState, "delivery_pending");
  }
});

test("P1-06 error-code vocabulary keeps every listed code", () => {
  assert.ok(Array.isArray(conformance.errorCodes) && conformance.errorCodes.length > 0);
  assert.deepEqual([...conformance.errorCodes].sort(), [...SAFE_API_CODES].sort());
  for (const code of conformance.errorCodes) {
    assert.equal(new RoomAPIError(409, {code}).code, code, code);
  }
  for (const code of ["stale_epoch", "turn_not_active", "turn_expired", "turns_not_used", "message_too_large", "idempotency_mismatch", "invalid_contribution"]) {
    assert.ok(conformance.errorCodes.includes(code), `G8: ${code}`);
  }
  const unlisted = new RoomAPIError(409, {code: "observed_seq_ahead", retryable: false});
  assert.equal(unlisted.code, "");
  assert.equal(classifyPostRefusal(unlisted, {identity: {}, post: {}}).outcome, "quarantined");
});

test("P1-07 every fail carries executionFailure", async () => {
  const runtime = p1Runtime();
  runtime.client = recordingClient();
  for (const failure of [undefined, {layer: "host", code: "x"}, {layer: "runtime", code: ""}, {layer: "provider", code: "rate_limited"}]) {
    await runtime.settleDiscussionAttempt(CYCLE(), "fail", undefined, failure);
  }
  await runtime.settleDiscussionAttempt(CYCLE(), "pass");
  assert.deepEqual(runtime.client.calls.map(([, , request]) => request), [
    {generation: 3, action: "fail", executionFailure: {layer: "runtime", code: "execution_failed"}},
    {generation: 3, action: "fail", executionFailure: {layer: "runtime", code: "execution_failed"}},
    {generation: 3, action: "fail", executionFailure: {layer: "runtime", code: "execution_failed"}},
    {generation: 3, action: "fail", executionFailure: {layer: "provider", code: "rate_limited"}},
    {generation: 3, action: "pass"},
  ]);

  // The channel names the failure for every fail it settles.
  const fallback = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
  for (const [label, run, expected] of [
    ["operational fallback", hostDeliver(fallback, {isError: true}), {layer: "runtime", code: "gateway_operational_error"}],
    ["handler threw", async () => { throw new Error("host turn failed"); }, {layer: "runtime", code: "execution_failed"}],
    ["delivery failed", hostDeliver(BODY), {layer: "runtime", code: "execution_failed"}],
  ]) {
    const settled = [];
    const skipped = [];
    const event = {
      id: "e1", sourceEventId: "e1", roomId: "room-1", epochId: "epoch-1", conversationId: "c", senderId: "h",
      senderName: "H", senderKind: "human", text: "t", occurredAt: 1, raw: {}, cycleAttempt: CYCLE(),
    };
    const client = {
      initialize: async () => ({sessionId: "s"}),
      assignedTurns: async function* () { yield event; },
      markTurnReading: async () => {},
      postAndFinish: async () => { throw new Error("delivery key was reused with a different semantic intent"); },
      settleDiscussionAttempt: async (_attempt, action, _signal, failure) => settled.push([action, failure]),
      recordSkipped: async (_id, reason) => skipped.push(reason),
      ack: async () => {},
      close: async () => {},
    };
    const channel = createRoomChannel({makeClient: () => client});
    await channel.plugin.gateway.startAccount(channelContext(join(home, `p1-07-${settled.length}.json`), run)).catch(() => {});
    assert.deepEqual(settled, [["fail", expected]], label);
    assert.ok(!skipped.includes("model_no_visible_reply"), label);
  }
});

test("P1-08 send-path quarantine releases the attempt, stops renewal, dispatches next", async () => {
  const runtime = p1Runtime();
  runtime.connectorSession = {sessionId: "session-1"};
  runtime.state.epochSessionRoutingInitialized = true;
  runtime.state.legacySessionEpochId = "epoch-1";
  const controller = new AbortController();
  const ready = {
    id: "ready-5", seq: 5, type: "discussion.cycle_attempt_ready", actorRole: "system", actorId: "room_coordinator",
    payload: {cycleId: "cycle-1", membershipId: "member-1", epochId: "epoch-1", generation: 3, round: 1, sourceEventId: "human-4"},
  };
  const next = {id: "human-6", seq: 6, type: "message.posted", actorRole: "human_owner", actorId: "human-1", payload: {body: "next question", epochId: "epoch-1"}};
  const acknowledgements = [];
  runtime.client = recordingClient({
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [ready, next]}),
    acknowledge: async (_state, seq) => { acknowledgements.push(seq); return {acknowledgedSeq: seq}; },
    postMessage: async () => {
      runtime.client.calls.push(["post"]);
      throw new RoomAPIError(400, {code: "validation_error", retryable: false});
    },
  });
  runtime.maintainPresence = async () => {};
  runtime.renewAccess = async () => false;
  runtime.markContextAcknowledged = async () => {};
  runtime.sharedRoomContext = async () => "";
  const turns = runtime.assignedTurns(controller.signal);
  const first = await turns.next();
  assert.equal(first.value.sourceEventId, "ready-5");
  const lease = runtime.attemptLeases.get("ready-5");
  assert.ok(lease?.timer, "renewal runs while the model runs");
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: BODY, replyToId: first.value.respondsToId, idempotencyKey: "ready-5:final",
    sourceEventId: "ready-5", sourceEpochId: "epoch-1", cycleAttempt: first.value.cycleAttempt,
  }), (error) => error.roomDeliveryOutcome === "quarantined");
  assert.equal(lease.stopped, true);
  assert.equal(lease.timer, null, "renewal stopped at record time");
  assert.deepEqual(runtime.client.calls.filter(([kind]) => kind === "complete").map(([, , request]) => request), [
    {generation: 3, action: "fail", executionFailure: {layer: "infrastructure", code: "attempt_timeout"}},
  ]);
  assert.equal(first.value.cycleAttempt.settled, true, "the attempt is released when the quarantine is recorded");
  const claimsAtRecord = runtime.client.calls.filter(([kind]) => kind === "claim").length;
  const second = await turns.next();
  assert.equal(second.value.sourceEventId, "human-6", "the next queued event runs at once");
  assert.equal(runtime.client.calls.filter(([kind]) => kind === "claim").length, claimsAtRecord);
  assert.deepEqual(acknowledgements, [], "the quarantined source is isolated, never acknowledged");
  assert.equal(runtime.state.terminalEvidence["5"], undefined, "no fabricated terminal evidence");
  assert.equal(runtime.attemptLeases.size, 0);
  controller.abort();
  await turns.return();

  // Channel: a quarantined delivery settles a typed fail, skips nothing,
  // acknowledges nothing, and the loop dispatches the next event.
  const calls = {settled: [], skipped: [], ack: [], delivered: []};
  const events = [
    {id: "q-1", sourceEventId: "q-1", roomId: "room-1", epochId: "epoch-1", conversationId: "c", senderId: "s",
      senderName: "S", senderKind: "human", text: "t", occurredAt: 1, raw: {}, cycleAttempt: CYCLE()},
    {id: "n-2", sourceEventId: "n-2", roomId: "room-1", epochId: "epoch-1", conversationId: "c", senderId: "s",
      senderName: "S", senderKind: "human", text: "t", occurredAt: 2, raw: {}},
  ];
  const client = {
    initialize: async () => ({sessionId: "s"}),
    assignedTurns: async function* () { for (const event of events) yield event; },
    markTurnReading: async () => {},
    postAndFinish: async ({sourceEventId}) => {
      calls.delivered.push(sourceEventId);
      if (sourceEventId === "q-1") throw Object.assign(new RoomAPIError(400, {code: "validation_error"}), {roomDeliveryOutcome: "quarantined"});
      return {eventId: "posted-n", sentAt: 1};
    },
    settleDiscussionAttempt: async (_attempt, action, _signal, failure) => calls.settled.push([action, failure]),
    recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
    ack: async (eventId) => calls.ack.push(eventId),
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  await channel.plugin.gateway.startAccount(channelContext(join(home, "p1-08.json"), hostDeliver(BODY)));
  assert.deepEqual(calls, {
    settled: [["fail", {layer: "infrastructure", code: "attempt_timeout"}]],
    skipped: [],
    ack: ["n-2"],
    delivered: ["q-1", "n-2"],
  });
});

test("P1-09 refusal outcomes are logged without body or secrets", async () => {
  const lines = [];
  for (const [code, retryable] of [["reply_cap_reached", false], ["cycle_superseded", false], ["validation_error", false]]) {
    const runtime = p1Runtime();
    runtime.client = recordingClient({
      postMessage: async () => { throw new RoomAPIError(409, {code, retryable, message: `${BODY} ${SECRET}`}); },
    });
    runtime.pendingEvent = SOURCE;
    const request = {roomId: "room-1", text: BODY, idempotencyKey: `${SOURCE.id}:final`, sourceEventId: SOURCE.id};
    if (code === "reply_cap_reached") await runtime.postAndFinish(request);
    else await cyclePost(runtime, CYCLE()).catch(() => {});
    const event = {id: "e7", seq: 7};
    runtime.pendingEvent = event;
    await runtime.recordSkipped("e7", "model_no_visible_reply");
    lines.push(...runtime.lines);
  }
  for (const kind of ["skipped", "superseded", "quarantined"]) {
    assert.ok(lines.some((line) => line.includes(`Room delivery ${kind} `)), `${kind} is logged: ${lines.join(" | ")}`);
  }
  assert.ok(lines.some((line) => line.includes("Room attempt settle")), "settle is logged");
  assert.ok(lines.some((line) => /code=reply_cap_reached sourceSeq=5 attempt=-/.test(line)));
  assert.ok(lines.some((line) => /code=validation_error sourceSeq=5 attempt=attempt-1/.test(line)));
  assert.ok(lines.some((line) => /settled fail code=infrastructure\/attempt_timeout sourceSeq=\S+ attempt=attempt-1/.test(line)));
  for (const line of lines) {
    assert.match(line, /code=\S+ sourceSeq=\S+ attempt=\S+/, line);
    assert.doesNotMatch(line, new RegExp(`${BODY}|${SECRET}`), line);
  }
});

test("P1-10 D4a replay: Zurie events 949–957 produce superseded and a typed settle", async () => {
  // Values as recorded in ANALYSIS-20261001-universal-connector-mapping.md §5
  // D4a (Room bjqiu9u7dwqptlq, account 1iy2lgr5uyg7cj4). Only the events the
  // analysis documents are replayed; seq 950, 951, 955 and 956 are absent.
  const ROOM = "bjqiu9u7dwqptlq";
  const ZURIE = "1iy2lgr5uyg7cj4";
  const PAULA = "hzoypcez4c4xyib";
  const EPOCH = "dicdfbutey44p4q";
  const CYCLE_ID = "cy6514bc125be3b";
  const ATTEMPT_ID = "4xczwqrbgzgwmp7";
  const events = [
    {id: "4hnj1fcn2xjz60a", seq: 949, type: "discussion.started", ts: "2026-10-01T09:59:36.209Z", actorRole: "human_owner", actorId: "owner",
      roomId: ROOM, eventVersion: 1, refs: [], payload: {epoch: {id: EPOCH, ordinal: 13, startsAtSeq: 949, status: "active"}}},
    {id: "66t4g8qfvjvzivg", seq: 952, type: "discussion.cycle_attempt_ready", ts: "2026-10-01T09:59:36.902Z", actorRole: "system",
      actorId: "room_coordinator", roomId: ROOM, eventVersion: 1, refs: ["4hnj1fcn2xjz60a"],
      payload: {cycleId: CYCLE_ID, epochId: EPOCH, generation: 1, membershipId: ZURIE, round: 1, sourceEventId: "4hnj1fcn2xjz60a"}},
    {id: "6fp0y8xhzi1td6g", seq: 953, type: "discussion.cycle_attempt_ready", ts: "2026-10-01T10:01:52.145Z", actorRole: "system",
      actorId: "room_coordinator", roomId: ROOM, eventVersion: 1, refs: ["4hnj1fcn2xjz60a"],
      payload: {cycleId: CYCLE_ID, epochId: EPOCH, generation: 1, membershipId: PAULA, round: 1, sourceEventId: "4hnj1fcn2xjz60a"}},
  ];
  const claimedAt = Date.parse("2026-10-01T09:59:36.896Z");
  const leaseExpiresAt = "2026-10-01T10:01:37.859Z";
  // 0.2.52 never renewed; P1 renews every 30 s inside this 121 s lease.
  assert.equal(attemptRenewalDelaySeconds(leaseExpiresAt, claimedAt), 30);

  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-d4a-"));
  const stateFile = join(directory, "zurie.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId: ZURIE, credential: SECRET,
    clientInstanceId: "client-zurie", cursor: 948, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "",
  });
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = await loadState(stateFile);
  runtime.connectorSession = {sessionId: "session-zurie"};
  const lines = [];
  runtime.logger = Object.fromEntries(["info", "warn", "error"].map((level) => [level, (line) => lines.push(line)]));
  const controller = new AbortController();
  const calls = {claims: 0, posts: 0, completes: [], acknowledgements: []};
  let reads = 0;
  runtime.client = {
    readEvents: async () => {
      reads += 1;
      if (reads > 1) controller.abort();
      return {activeEpochId: EPOCH, activeEpochStartsAtSeq: 949, events: reads > 1 ? [] : events};
    },
    acknowledge: async (_state, seq) => { calls.acknowledgements.push(seq); return {acknowledgedSeq: seq}; },
    roomState: async () => ({headSeq: 952, activeEpoch: {id: EPOCH, startsAtSeq: 949}, roster: []}),
    claimDiscussionAttempt: async () => {
      calls.claims += 1;
      // The Room timed the attempt out at 10:01:37.859Z; every later claim is refused.
      if (calls.claims > 1) throw new RoomAPIError(409, {code: "cycle_superseded", retryable: false});
      return {
        cycle: {id: CYCLE_ID, generation: 1, roster: [{membershipId: ZURIE}, {membershipId: PAULA}], totalTurns: 0, followUps: 0,
          budgets: {totalTurns: 10, perAgentTurns: 5, maxFollowUps: 10}, progress: {}},
        attempt: {id: ATTEMPT_ID, membershipId: ZURIE, round: 1, generation: 1, leaseExpiresAt},
      };
    },
    postMessage: async () => { calls.posts += 1; throw new RoomAPIError(409, {code: "cycle_superseded", retryable: false}); },
    completeDiscussionAttempt: async (_state, _cycleId, attemptId, request) => {
      calls.completes.push([attemptId, structuredClone(request)]);
      throw new RoomAPIError(409, {code: "cycle_superseded", retryable: false});
    },
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.markTurnReading = async () => {};
  runtime.markTurnPreparing = async () => {};
  runtime.sharedRoomContext = async () => "";

  const reply = "Z".repeat(1193);
  const channel = createRoomChannel({makeClient: () => runtime});
  await channel.plugin.gateway.startAccount(channelContext(stateFile, hostDeliver(reply), controller));

  assert.equal(calls.posts, 0, "the reply is fenced before it reaches POST /messages");
  assert.deepEqual(calls.completes, [
    [ATTEMPT_ID, {generation: 1, action: "fail", executionFailure: {layer: "infrastructure", code: "attempt_timeout"}}],
  ], "one typed settle; never pass");
  const state = await loadState(stateFile);
  const intent = state.deliveryIntents["66t4g8qfvjvzivg:final"];
  assert.equal(intent.status, "superseded");
  assert.equal(intent.supersededReason, "cycle_superseded");
  assert.equal(intent.identity.body.length, 1193, "the reply stays in the intent");
  assert.equal(state.terminalEvidence["952"].status, "superseded");
  assert.equal(state.terminalEvidence["952"].reason, "cycle_superseded");
  assert.equal(state.terminalEvidence["953"].reason, "not_assigned_or_technical");
  assert.doesNotMatch(JSON.stringify(state), /model_no_visible_reply/);
  assert.deepEqual(calls.acknowledgements, [949], "the documented gap at 950 holds the frontier");
  assert.ok(lines.some((line) => line === `Room delivery superseded code=cycle_superseded sourceSeq=952 attempt=${ATTEMPT_ID}`), lines.join("\n"));
  assert.ok(lines.every((line) => !line.includes(reply) && !line.includes(SECRET)));
});

test("conformance P1 case names resolve to tests in this file", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  const cases = Object.entries(conformance.parityP1Cases ?? {});
  assert.equal(cases.length, 10);
  for (const [id, name] of cases) {
    assert.ok(name.startsWith(`${id} `), id);
    assert.ok(source.includes(`test(${JSON.stringify(name)},`), name);
  }
});

test("closing the runtime during a renewal never records lost authority", async () => {
  const runtime = p1Runtime();
  runtime.client = recordingClient({
    claimDiscussionAttempt: (_state, _cycleId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
    }),
  });
  runtime.pendingEvent = SOURCE;
  const lease = runtime.startAttemptLease(SOURCE, CYCLE());
  clearTimeout(lease.timer);
  lease.timer = null;
  lease.inflight = runtime.renewAttemptLease(lease);
  await runtime.close();
  assert.equal(await lease.inflight, false);
  assert.equal(lease.superseded, false);
  assert.equal(runtime.state.terminalEvidence["5"], undefined);
  assert.deepEqual(runtime.client.calls, []);
});

test("a parked frozen replay waits and re-scans instead of stopping the channel", async () => {
  const runtime = p1Runtime();
  runtime.connectorSession = {sessionId: "session-1"};
  runtime.state.epochSessionRoutingInitialized = true;
  runtime.state.legacySessionEpochId = "epoch-1";
  const controller = new AbortController();
  const stop = new Error("test stop");
  const event = {id: "human-5", seq: 5, type: "message.posted", actorRole: "human_owner", actorId: "human-1", payload: {body: "q", epochId: "epoch-1"}};
  runtime.client = recordingClient({readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [event]})});
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.recoverPendingDelivery = async (source) => {
    runtime.pendingEvent = source;
    runtime.state.deliveryIntents["human-5:final"] = {version: 2, deliveryState: "delivery_pending"};
    throw new RoomAPIError(503, {code: "busy", retryable: true});
  };
  runtime.logger.warn = (line) => {
    runtime.lines.push(line);
    controller.abort(stop);
  };
  await assert.rejects(runtime.assignedTurns(controller.signal).next(), (error) => error === stop);
  assert.ok(runtime.lines.some((line) => line.startsWith("Room delivery parked for retry code=busy sourceSeq=5")));
  assert.equal(runtime.pendingEvent, null);
  assert.equal(runtime.parkedRetryDelay, 2_000);
});

test("a later delivery call never downgrades a recorded quarantine", async () => {
  const calls = {settled: [], skipped: [], ack: []};
  const event = {id: "q-1", sourceEventId: "q-1", roomId: "room-1", epochId: "epoch-1", conversationId: "c", senderId: "s",
    senderName: "S", senderKind: "human", text: "t", occurredAt: 1, raw: {}, cycleAttempt: CYCLE()};
  let deliveries = 0;
  const client = {
    initialize: async () => ({sessionId: "s"}),
    assignedTurns: async function* () { yield event; },
    markTurnReading: async () => {},
    postAndFinish: async () => {
      deliveries += 1;
      if (deliveries === 1) throw Object.assign(new RoomAPIError(400, {code: "validation_error"}), {roomDeliveryOutcome: "quarantined"});
      throw new Error("OpenClaw Room delivery is quarantined for operator recovery");
    },
    settleDiscussionAttempt: async (_attempt, action, _signal, failure) => calls.settled.push([action, failure]),
    recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
    ack: async (eventId) => calls.ack.push(eventId),
    close: async () => {},
  };
  const run = async ({raw, adapter}) => {
    const turn = adapter.resolveTurn(adapter.ingest(raw));
    for (const text of ["first", "second"]) {
      try { await turn.delivery.deliver({text}); } catch {}
    }
  };
  const channel = createRoomChannel({makeClient: () => client});
  await channel.plugin.gateway.startAccount(channelContext(join(home, "no-downgrade.json"), run));
  // P1a-6: the turn's reply is the first model-authored payload; the second is logged, never posted.
  assert.equal(deliveries, 1);
  assert.deepEqual(calls, {settled: [["fail", {layer: "infrastructure", code: "attempt_timeout"}]], skipped: [], ack: []});
});

test("a parked replay refused as quarantined is isolated and the next event runs", async () => {
  const runtime = p1Runtime();
  runtime.connectorSession = {sessionId: "session-1"};
  runtime.state.epochSessionRoutingInitialized = true;
  runtime.state.legacySessionEpochId = "epoch-1";
  const parked = {id: "human-5", seq: 5, type: "message.posted", actorRole: "human_owner", actorId: "human-1", payload: {body: "q", epochId: "epoch-1"}};
  const next = {id: "human-6", seq: 6, type: "message.posted", actorRole: "human_owner", actorId: "human-1", payload: {body: "next", epochId: "epoch-1"}};
  let refusal = new RoomAPIError(503, {code: "busy", retryable: true});
  const acknowledgements = [];
  runtime.client = recordingClient({
    postMessage: async () => { runtime.client.calls.push(["post"]); throw refusal; },
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [parked, next]}),
    acknowledge: async (_state, seq) => { acknowledgements.push(seq); return {acknowledgedSeq: seq}; },
  });
  runtime.pendingEvent = parked;
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: BODY, replyToId: "human-5", idempotencyKey: "human-5:final", sourceEventId: "human-5",
  }), (error) => error.roomDeliveryOutcome === "delivery_pending");
  runtime.pendingEvent = null;
  refusal = new RoomAPIError(400, {code: "validation_error", retryable: false});
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.sharedRoomContext = async () => "";
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const result = await turns.next();
  assert.equal(result.value.sourceEventId, "human-6", "the channel keeps running and processes the next event");
  assert.equal(runtime.state.deliveryIntents["human-5:final"].deliveryState, "quarantined");
  assert.equal(runtime.client.calls.filter(([kind]) => kind === "post").length, 2, "one replay, no repost");
  assert.equal(runtime.state.terminalEvidence["5"], undefined);
  assert.deepEqual(acknowledgements, []);
  assert.equal(runtime.pendingEvent?.id, "human-6");
  controller.abort();
  await turns.return();
});

test("a renewal-driven release and a channel settle send exactly one complete", async () => {
  const runtime = p1Runtime();
  let releaseComplete;
  runtime.client = recordingClient({
    claimDiscussionAttempt: async () => { throw new RoomAPIError(409, {code: "cycle_superseded"}); },
    completeDiscussionAttempt: async (_state, _cycleId, attemptId, request) => {
      runtime.client.calls.push(["complete", attemptId, structuredClone(request)]);
      await new Promise((resolve) => { releaseComplete = resolve; });
      return {};
    },
  });
  runtime.pendingEvent = SOURCE;
  const cycleAttempt = CYCLE();
  const lease = runtime.startAttemptLease(SOURCE, cycleAttempt);
  clearTimeout(lease.timer);
  lease.timer = null;
  const renewal = runtime.renewAttemptLease(lease);
  while (!releaseComplete) await new Promise((resolve) => setImmediate(resolve));
  const channelSettle = runtime.settleDiscussionAttempt(cycleAttempt, "pass");
  releaseComplete();
  await Promise.all([renewal, channelSettle]);
  assert.deepEqual(runtime.client.calls.filter(([kind]) => kind === "complete").map(([, , request]) => request), [
    {generation: 3, action: "fail", executionFailure: {layer: "infrastructure", code: "attempt_timeout"}},
  ]);
  assert.equal(cycleAttempt.settled, true);
});

test("a renewal claim that does not answer in time is retried, then lost when the lease runs out", async () => {
  const runtime = p1Runtime();
  runtime.attemptRenewalRequestTimeoutMs = 50;
  runtime.attemptRenewalRetryMs = 20;
  runtime.client = recordingClient({
    claimDiscussionAttempt: (_state, _cycleId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }),
  });
  runtime.pendingEvent = SOURCE;
  const cycleAttempt = CYCLE();
  cycleAttempt.attempt.leaseExpiresAt = new Date(Date.now() + 400).toISOString();
  const lease = runtime.startAttemptLease(SOURCE, cycleAttempt);
  clearTimeout(lease.timer);
  lease.timer = null;
  const started = Date.now();
  // AbortSignal.timeout does not hold the event loop open; the gateway does.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    assert.equal(await runtime.renewAttemptLease(lease), false);
    assert.equal(lease.superseded, false, "one unanswered claim does not lose a valid lease");
    while (!lease.superseded && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started < 5_000, "each claim is bounded by the request timeout");
  assert.equal(lease.superseded, true);
  assert.equal(runtime.state.terminalEvidence["5"].reason, "attempt_renewal_failed");
  assert.deepEqual(runtime.client.calls.filter(([kind]) => kind === "complete").map(([, , request]) => request.action), ["fail"]);
});

test("an outbound post superseded by an epoch advance names its reason", async () => {
  let live;
  const client = {
    initialize: async () => ({sessionId: "s"}),
    assignedTurns: async function* () {
      await assert.rejects(live.plugin.message.send.text({accountId: "default", to: "room-1", text: "hello"}),
        {message: "Room did not accept the post: historical_epoch"});
    },
    postAndFinish: async () => ({superseded: true}),
    close: async () => {},
  };
  live = createRoomChannel({makeClient: () => client});
  await live.plugin.gateway.startAccount(channelContext(join(home, "outbound-epoch.json"), async () => {}));
});

test("a transient renewal failure within the lease is retried and the turn is posted (canary 2026-10-02 07:48)", async () => {
  // Live sequence, Zurie attempt 06wh3u60zhz5jnm: claim ok, first renewal ok,
  // second renewal failed client-side (no request reached the Room) and
  // superseded a 120 s lease that still had about 60 s left. Now: logged with
  // its real error, retried, renewed, and the reply is posted.
  const runtime = p1Runtime();
  const warnings = [];
  runtime.logger = {info: () => {}, warn: (line) => warnings.push(line), error: (line) => warnings.push(line)};
  runtime.attemptRenewalRetryMs = 20;
  const outcomes = ["ok", "fetch failed", "ok", "fetch failed", "ok", "ok"];
  runtime.client = recordingClient({
    claimDiscussionAttempt: async (_state, cycleId, signal) => {
      assert.ok(signal instanceof AbortSignal, "every claim is bounded");
      const outcome = outcomes.shift();
      runtime.client.calls.push(["claim", outcome]);
      if (outcome !== "ok") throw new TypeError(outcome, {cause: Object.assign(new Error("other side closed"), {code: "UND_ERR_SOCKET"})});
      const attempt = CYCLE();
      return {cycle: attempt.cycle, attempt: attempt.attempt};
    },
  });
  runtime.pendingEvent = SOURCE;
  const cycleAttempt = CYCLE();
  const lease = runtime.startAttemptLease(SOURCE, cycleAttempt);
  clearTimeout(lease.timer);
  lease.timer = null;
  assert.equal(await runtime.renewAttemptLease(lease), true, "first renewal");
  clearTimeout(lease.timer);
  lease.timer = null;
  assert.equal(await runtime.renewAttemptLease(lease), false, "second renewal fails");
  assert.equal(lease.superseded, false, "a valid lease is not lost to one failure");
  assert.equal(runtime.state.terminalEvidence?.["5"], undefined);
  assert.ok(lease.timer, "a retry is scheduled within the lease");
  while (lease.inflight === null && runtime.client.calls.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  await lease.inflight;
  assert.deepEqual(runtime.client.calls.map(([, outcome]) => outcome), ["ok", "fetch failed", "ok"]);
  assert.equal(lease.superseded, false);
  // The pre-post re-claim follows the same rule: one transient failure, then ok.
  const receipt = await cyclePost(runtime, cycleAttempt);
  assert.equal(receipt.eventId, "posted-6");
  assert.deepEqual(runtime.client.calls.slice(3).map(([kind, outcome]) => (kind === "claim" ? `claim:${outcome}` : kind)),
    ["claim:fetch failed", "claim:ok", "post", "complete"]);
  assert.equal(runtime.state.deliveryIntents[`${SOURCE.id}:final`].deliveryState, "posted");
  // Each failure is logged with the real error, never a body.
  assert.equal(warnings.length, 2, warnings.join("\n"));
  for (const line of warnings) {
    assert.match(line, /^Room attempt renewal failed code=attempt_(renewal|reclaim)_failed sourceSeq=5 attempt=attempt-1 error=TypeError cause=UND_ERR_SOCKET transient; lease remaining \d+ms$/u);
    assert.ok(!line.includes(BODY));
  }
});
