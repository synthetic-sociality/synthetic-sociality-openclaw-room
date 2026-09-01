import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {canonicalRoomContext, commandInstruction, cyclePhaseInstruction, epochConversationId, eventEpochId, isAssignedEvent, isAssignedMessage, normalizeEvent, OpenClawRoomRuntime, resolveStandaloneRecipientSelectors, validateActiveEpochPage} from "../src/runtime.js";
import {RoomAPIError} from "../src/room-client.js";
import {loadState, saveState, validateState} from "../src/state.js";

test("derives stable epoch-scoped conversations and rotates them between epochs", () => {
  assert.match(epochConversationId("room-1", "epoch-1"), /^room-1:epoch:[a-f0-9]{32}$/);
  assert.equal(epochConversationId("room-1", "epoch-1"), epochConversationId("room-1", "epoch-1"));
  assert.notEqual(epochConversationId("room-1", "epoch-1"), epochConversationId("room-1", "epoch-2"));
  assert.throws(() => epochConversationId("room-1", ""), /active epoch/);
});

test("extracts the canonical epoch from discussion, cycle, message, and page metadata", () => {
  assert.equal(eventEpochId({type: "discussion.started", payload: {epoch: {id: "epoch-1"}}}), "epoch-1");
  assert.equal(eventEpochId({type: "discussion.cycle_attempt_ready", payload: {epochId: "epoch-2"}}), "epoch-2");
  assert.equal(eventEpochId({type: "message.posted", payload: {epochId: "epoch-3"}}), "epoch-3");
  assert.equal(eventEpochId({type: "message.posted", payload: {topic: {epochId: "epoch-4"}}}), "epoch-4");
  assert.equal(eventEpochId({type: "human.command", payload: {}}, "epoch-page"), "epoch-page");
});

test("normalizes the epoch-scoped conversation while preserving the raw room target", () => {
  const normalized = normalizeEvent({
    id: "message-1", type: "message.posted", actorRole: "human_owner",
    payload: {body: "Current task", epochId: "epoch-5"},
  }, "room-1", null, "", "epoch-5");
  assert.equal(normalized.roomId, "room-1");
  assert.equal(normalized.epochId, "epoch-5");
  assert.equal(normalized.conversationId, epochConversationId("room-1", "epoch-5"));
});

test("preserves an existing binding's baseline epoch and rotates the next epoch", () => {
  const baseline = normalizeEvent({
    id: "message-1", type: "message.posted", actorRole: "human_owner",
    payload: {body: "Old current task", epochId: "epoch-5"},
  }, "room-1", null, "", "epoch-5", "epoch-5");
  const next = normalizeEvent({
    id: "message-2", type: "message.posted", actorRole: "human_owner",
    payload: {body: "New task", epochId: "epoch-6"},
  }, "room-1", null, "", "epoch-6", "epoch-5");
  assert.equal(baseline.conversationId, "room-1");
  assert.equal(next.conversationId, epochConversationId("room-1", "epoch-6"));
});

test("keeps durable rounds generic and bounded instead of imposing a room topic", () => {
  const cycle = {budgets: {perAgentTurns: 7}};
  assert.equal(cyclePhaseInstruction({round: 1}, cycle).phase, "opening");
  assert.equal(cyclePhaseInstruction({round: 2}, cycle).phase, "follow_up");
  assert.equal(cyclePhaseInstruction({round: 7}, cycle).phase, "follow_up");
  assert.equal(cyclePhaseInstruction(
    {round: 1},
    {budgets: {perAgentTurns: 1}},
    {command: {command: "summarize"}},
  ).phase, "summary");
  const all = [cyclePhaseInstruction({round: 1}, cycle), cyclePhaseInstruction({round: 2}, cycle)]
    .map(({instruction}) => instruction.toLowerCase()).join(" ");
  for (const forbidden of ["sdg", "government", "national evidence", "evidence pitch"]) assert.doesNotMatch(all, new RegExp(forbidden));
});

test("initial greeting keeps the exact ask instruction and a bounded greeting phase", () => {
  const payload = {command: {
    command: "ask",
    idempotencyKey: "room-initial-greeting:v1:room:agent",
    arguments: {instruction: "Greet Alex and Sam."},
  }};
  assert.equal(commandInstruction(payload), "Greet Alex and Sam.");
  assert.equal(cyclePhaseInstruction({round: 1}, {budgets: {perAgentTurns: 1}}, payload).phase, "initial_greeting");
});

test("initializes one connector session when native startup and event polling overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-runtime-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1,
    baseUrl: "https://room.example/api",
    roomId: "room-1",
    membershipId: "member-1",
    credential: "secret",
    clientInstanceId: "client-1",
    cursor: 0,
  });
  let registrations = 0;
  let registrationBody;
  let connectorHeartbeats = 0;
  let statusRequests = 0;
  const activities = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/status")) {
        statusRequests += 1;
        return new Response(JSON.stringify({code: "request_validation_failed"}), {status: 400});
      }
      if (url.endsWith("/connector/sessions")) {
        registrations += 1;
    registrationBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          sessionId: "session-1",
          heartbeatIntervalSeconds: 60,
          capabilities: ["events.long_poll", "messages.logical_contribution.v1"],
        }), {status: 200});
      }
      if (url.endsWith("/heartbeat")) {
        connectorHeartbeats += 1;
        return new Response(JSON.stringify({sessionId: "session-1"}), {status: 200});
      }
      if (url.endsWith("/activity")) {
        activities.push(JSON.parse(init.body));
        return new Response(JSON.stringify({acceptedStreamSeq: 1}), {status: 202});
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const [first, second] = await Promise.all([runtime.initialize(), runtime.initialize()]);
  assert.equal(first.sessionId, "session-1");
  assert.equal(second.sessionId, "session-1");
  assert.equal(registrations, 1);
  assert.equal(statusRequests, 0, "legacy Room deployments must not be blocked by an unauthenticated /status probe");
  assert.deepEqual(registrationBody.metadata, {
    runtimeName: "OpenClaw", runtimeVersion: "2026.7.1-2",
    hostLabel: "default", transport: "long_poll", modelDescriptor: "host-selected",
  });
  assert.equal((await loadState(stateFile)).messagePayloadDialect, "v2");
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], {
    version: 1,
    kind: "heartbeat",
    runId: runtime.presenceRunId,
    streamSeq: 1,
  });
  await runtime.maintainPresence();
  assert.equal(connectorHeartbeats, 1);
  assert.equal(activities.length, 2);
  assert.equal(activities[1].streamSeq, 2);
  await runtime.close();
});

test("verified build provenance stays embedded without violating strict registration metadata", async () => {
  const directory=await mkdtemp(join(tmpdir(),"openclaw-room-provenance-")); const stateFile=join(directory,"default.json");
  await saveState(stateFile,{version:1,baseUrl:"https://room.example/api",roomId:"room-1",membershipId:"member-1",credential:"secret",clientInstanceId:"client-1",cursor:0});
  let metadata;
  const runtime=new OpenClawRoomRuntime({accountId:"default",stateFile,baseUrl:"https://room.example/api"},{releaseProvenance:{version:"0.2.26",sourceCommit:"a".repeat(40),artifactIdentity:"sha256:"+"b".repeat(64)},fetchImpl:async(url,init)=>{
    if(url.endsWith("/status"))return new Response(JSON.stringify({protocolCapabilities:[]}),{status:200});
    if(url.endsWith("/connector/sessions")){metadata=JSON.parse(init.body).metadata;return new Response(JSON.stringify({sessionId:"s",heartbeatIntervalSeconds:60}),{status:200})}
    if(url.endsWith("/activity"))return new Response(JSON.stringify({acceptedStreamSeq:1}),{status:202}); throw new Error(url);
  }});
  await runtime.initialize();
  assert.deepEqual(metadata, {runtimeName:"OpenClaw",runtimeVersion:"2026.7.1-2",hostLabel:"default",transport:"long_poll",modelDescriptor:"host-selected"});
  assert.equal(runtime.releaseProvenance.version,"0.2.26");
  assert.equal(runtime.releaseProvenance.sourceCommit,"a".repeat(40));
  assert.equal(runtime.releaseProvenance.artifactIdentity,"sha256:"+"b".repeat(64));
  await runtime.close();
});

test("activity relay failure never disconnects the canonical connector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-runtime-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "client-1", cursor: 0,
  });
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url) => {
      if (url.endsWith("/status")) return new Response(JSON.stringify({protocolCapabilities: []}), {status: 200});
      if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "session-1", heartbeatIntervalSeconds: 60}), {status: 200});
      if (url.endsWith("/activity")) return new Response(JSON.stringify({message: "relay unavailable"}), {status: 503});
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const session = await runtime.initialize();
  assert.equal(session.sessionId, "session-1");
  assert.equal(runtime.pendingPresence.streamSeq, 1);
  assert.ok(runtime.activityError);
  await runtime.close();
});

test("canonical object payloads route human and explicitly addressed messages", () => {
  const base = {type: "message.posted", actorId: "human-1", actorRole: "human_owner"};
  assert.equal(isAssignedMessage({...base, payload: {body: "Hello room"}}, "aura-member"), true);
  assert.equal(isAssignedMessage({...base, payload: {
    body: "Paula, only you", recipientSelectors: [{kind: "display_name", displayName: "Paula"}],
    resolvedRecipientMembershipIds: ["paula-member"],
  }}, "aura-member"), false);
  assert.equal(isAssignedMessage({...base, payload: {
    body: "Unresolved explicit target", recipientSelectors: [{kind: "display_name", displayName: "Missing"}],
    resolvedRecipientMembershipIds: [],
  }}, "aura-member"), false);
  assert.equal(isAssignedMessage({...base, payload: {
    body: "Open exchange", recipientSelectors: [], resolvedRecipientMembershipIds: [],
  }}, "aura-member"), true);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {body: "Aura?", recipientSelectors: [{kind: "membership", membershipId: "aura-member"}]},
  }, "aura-member"), true);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {body: "Everyone?", recipientSelectors: [{kind: "everyone"}]},
  }, "aura-member"), true);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {
      body: "Aura by resolved display name?",
      recipientSelectors: [{kind: "display_name", displayName: "Aura"}],
      resolvedRecipientMembershipIds: ["aura-member"],
    },
  }, "aura-member"), true);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "aura-member", actorRole: "participant_agent",
    payload: {
      body: "Do not loop my own contribution",
      recipientSelectors: [{kind: "everyone"}],
      resolvedRecipientMembershipIds: ["aura-member"],
    },
  }, "aura-member"), false);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {body: "For someone else", recipientSelectors: [{kind: "membership", membershipId: "other-member"}]},
  }, "aura-member"), false);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {
      body: "Resolved for someone else",
      recipientSelectors: [{kind: "membership", membershipId: "aura-member"}],
      resolvedRecipientMembershipIds: ["paula-member"],
    },
  }, "aura-member"), false);
  assert.equal(isAssignedMessage({
    type: "message.posted", actorId: "other-agent", actorRole: "participant_agent",
    payload: {
      body: "Server resolved this for nobody",
      recipientSelectors: [{kind: "everyone"}],
      resolvedRecipientMembershipIds: [],
    },
  }, "aura-member"), false);
});

test("cycle-ready events wake only their assigned membership and retain the human response source", () => {
  const event = {
    id: "ready-event-1",
    type: "discussion.cycle_attempt_ready",
    actorRole: "system",
    ts: "2026-08-06T08:00:00Z",
    payload: {
      membershipId: "aura-member",
      sourceEventId: "human-message-1",
      cycleId: "cycle-1",
    },
  };
  assert.equal(isAssignedEvent(event, "aura-member"), true);
  assert.equal(isAssignedEvent(event, "paula-member"), false);
  const normalized = normalizeEvent(event, "room-1", {
    attempt: {id: "attempt-2", round: 2},
    cycle: {id: "cycle-1", budgets: {totalTurns: 10}, totalTurns: 1},
  }, "[Canonical Room context]\nPaula: Europe needs public compute infrastructure.\n[/Canonical Room context]", "epoch-1");
  assert.equal(normalized.sourceEventId, "ready-event-1");
  assert.equal(normalized.respondsToId, "human-message-1");
  assert.match(normalized.text, /Continue the autonomous discussion/);
  assert.match(normalized.text, /Paula: Europe needs public compute infrastructure/);
});

test("canonical Room context carries topic and recent named contributions without the current trigger", () => {
  const context = canonicalRoomContext({
    title: "AI geopolitics",
    purpose: "Compare strategic positions",
    activeTopic: {title: "Compute sovereignty"},
    rules: [
      {text: "Read the other agents before replying.", enforcement: "guidance"},
      {text: "Owner reviews disputes.", enforcement: "human_moderation"},
    ],
  }, [
    {id: "old-1", type: "message.posted", actorRole: "participant_agent", payload: {actorDisplayName: "Paula", body: "Europe needs public compute."}},
    {id: "current", type: "message.posted", actorRole: "human_owner", payload: {actorDisplayName: "TJ", body: "Continue."}},
    {id: "audit-1", type: "turn.granted", payload: {}},
  ], "current", {roomId: "room-1", policy: {
    topicDrift: "soft", researchGroundingMode: "time-sensitive", researchMaxSources: 3,
  }});
  assert.match(context, /Room: AI geopolitics/);
  assert.match(context, /Current discussion: Compute sovereignty/);
  assert.match(context, /Paula: Europe needs public compute/);
  assert.match(context, /Read the other agents before replying/);
  assert.doesNotMatch(context, /Owner reviews disputes/);
  assert.match(context, /Research grounding policy: time-sensitive/);
  assert.match(context, /at most 3 sources/);
  assert.match(context, /Topic drift policy: soft/);
  assert.doesNotMatch(context, /TJ: Continue/);
  assert.doesNotMatch(context, /turn.granted/);
  const direct = normalizeEvent({
    id: "direct-question", seq: 8, type: "message.posted", actorRole: "human_owner",
    payload: {body: "What is your direct answer to this question?"},
  }, "room-1", {
    attempt: {id: "attempt-1", round: 1},
    cycle: {id: "cycle-1", totalTurns: 0, budgets: {totalTurns: 4, perAgentTurns: 2}},
  }, context, "epoch-1");
  assert.match(direct.text, /Current discussion: Compute sovereignty/);
  assert.match(direct.text, /What is your direct answer to this question/);
});

test("receive-boundary acknowledgement precedes coordination and model dispatch", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/unused", baseUrl: "https://room.example/api"});
  const controller = new AbortController();
  const event = {
    id: "source-5", seq: 5, type: "message.posted", actorId: "human-1", actorRole: "human_owner",
    payload: {body: "Question", epochId: "epoch-1"},
  };
  const trace = [];
  let releaseCoordination;
  const coordinationGate = new Promise((resolve) => { releaseCoordination = resolve; });
  runtime.state = {
    roomId: "room-1", membershipId: "member-1", cursor: 4,
    epochSessionRoutingInitialized: true, legacySessionEpochId: "epoch-1",
    deliveryIntents: {}, terminalEvidence: {},
  };
  runtime.connectorSession = {sessionId: "session-1"};
  runtime.client = {
    readEvents: async () => ({
      activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1,
      events: [event],
    }),
  };
  runtime.maintainPresence = async () => { trace.push("presence"); };
  runtime.recoverPostedEvidence = async () => false;
  runtime.recoverPendingDelivery = async () => false;
  runtime.markContextAcknowledged = async (source) => {
    trace.push(`context_acknowledged:${source.id}:${source.seq}`);
  };
  runtime.prepareCycleAttempt = async () => {
    trace.push("coordination");
    await coordinationGate;
    return null;
  };
  runtime.sharedRoomContext = async () => {
    trace.push("model_context");
    return "";
  };

  const iterator = runtime.assignedTurns(controller.signal);
  const pending = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, ["presence", "context_acknowledged:source-5:5", "coordination"]);
  assert.equal(runtime.state.cursor, 4);
  releaseCoordination();
  const delivered = await pending;
  assert.equal(delivered.value.sourceEventId, "source-5");
  assert.deepEqual(trace, ["presence", "context_acknowledged:source-5:5", "coordination", "model_context"]);
  controller.abort();
  await iterator.return();
});

test("durable cursor acknowledgement does not emit presentation acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-ack-separation-"));
  const runtime = deliveryLifecycleRuntime();
  runtime.account.stateFile = join(directory, "state.json");
  runtime.state.terminalEvidence = {
    "5": {status: "skipped", sourceEventId: "source-5", sourceSeq: 5, reason: "model_skip"},
  };
  await saveState(runtime.account.stateFile, runtime.state);
  let presentationCalls = 0;
  runtime.publishActivityFrame = async () => { presentationCalls += 1; };
  runtime.client = {acknowledge: async (_state, seq) => ({acknowledgedSeq: seq})};

  await runtime.ackEvent({id: "source-5", seq: 5});

  assert.equal(runtime.state.cursor, 5);
  assert.equal(presentationCalls, 0);
});

test("human source starts one server-owned cycle but only its ready event claims the attempt", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "aura-member"};
  const starts = [];
  runtime.client = {
    roomState: async () => ({
      activeEpoch: {id: "epoch-1"},
      roster: [
        {membershipId: "human-1", displayName: "TJ", role: "human_owner", status: "active"},
        {membershipId: "paula-member", displayName: "Paula", role: "participant_agent", status: "active"},
        {membershipId: "aura-member", displayName: "Aura", role: "participant_agent", status: "active"},
        {membershipId: "gone", displayName: "Gone", role: "participant_agent", status: "removed"},
      ],
    }),
    startDiscussionCycle: async (_state, request) => {
      starts.push(request);
      return {id: "cycle-1"};
    },
    claimDiscussionAttempt: async () => ({attempt: {id: "attempt-1", round: 1}, cycle: {id: "cycle-1"}}),
  };
  const result = await runtime.prepareCycleAttempt({
    id: "human-event", type: "message.posted", actorId: "human-1", actorRole: "human_owner", payload: {body: "Debate this"},
  });
  assert.equal(result, false);
  assert.deepEqual(starts[0].roster, [
    {membershipId: "paula-member", displayName: "Paula"},
    {membershipId: "aura-member", displayName: "Aura"},
  ]);
  assert.equal(starts[0].sourceEventId, "human-event");
});

test("eligible agent contribution seeds once while a cycle-bound contribution continues its cycle", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "reader-member"};
  const starts = [];
  const claims = [];
  runtime.client = {
    roomPolicy: async () => ({policy: {coordinationMode: "open", agentFollowUpEnabled: true}}),
    roomState: async () => ({
      activeEpoch: {id: "epoch-1"},
      roster: [
        {membershipId: "author-member", displayName: "Author", role: "participant_agent", status: "active"},
        {membershipId: "reader-member", displayName: "Reader", role: "participant_agent", status: "active"},
        {membershipId: "other-member", displayName: "Other", role: "participant_agent", status: "active"},
      ],
    }),
    startDiscussionCycle: async (_state, request) => { starts.push(request); return {id: "cycle-agent-1"}; },
    claimDiscussionAttempt: async (_state, cycleId) => {
      claims.push(cycleId);
      return {attempt: {id: `attempt-${claims.length}`, round: claims.length}, cycle: {id: cycleId}};
    },
  };
  const seeded = await runtime.prepareCycleAttempt({
    id: "agent-source", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
    payload: {body: "A new peer claim", resolvedRecipientMembershipIds: ["reader-member"]},
  });
  assert.equal(seeded, false);
  assert.deepEqual(starts[0].roster.map(({membershipId}) => membershipId), ["author-member", "reader-member"]);
  const continued = await runtime.prepareCycleAttempt({
    id: "agent-cycle-contribution", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
    payload: {body: "A bounded follow-up", cycleId: "cycle-existing", resolvedRecipientMembershipIds: ["reader-member"]},
  });
  assert.equal(continued, false);
  const ready = await runtime.prepareCycleAttempt({
    id: "ready-existing", type: "discussion.cycle_attempt_ready", actorId: "room_coordinator", actorRole: "system",
    payload: {cycleId: "cycle-existing", membershipId: "reader-member", sourceEventId: "agent-cycle-contribution"},
  });
  assert.equal(ready.cycle.id, "cycle-existing");
  assert.equal(starts.length, 1);
  assert.deepEqual(claims, ["cycle-existing"]);
});

test("agent contribution cannot seed outside the open follow-up policy", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "reader-member"};
  let stateReads = 0;
  runtime.client = {
    roomPolicy: async () => ({policy: {coordinationMode: "open", agentFollowUpEnabled: false}}),
    roomState: async () => { stateReads += 1; return {}; },
  };
  const result = await runtime.prepareCycleAttempt({
    id: "agent-source", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
    payload: {body: "A peer claim", resolvedRecipientMembershipIds: ["reader-member"]},
  });
  assert.equal(result, false);
  assert.equal(stateReads, 0);
});

test("follow-up guidance searches for synthesis without forcing consensus", () => {
  const result = cyclePhaseInstruction({round: 2}, {budgets: {perAgentTurns: 3}}, {});
  assert.match(result.instruction, /common ground or synthesis/);
  assert.match(result.instruction, /never force consensus/);
  assert.match(result.instruction, /justified disagreement may remain/);
});

function deliveryLifecycleRuntime() {
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile: "/unused", baseUrl: "https://room.example/api"});
  runtime.state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1",
    cursor: 4, messagePayloadDialect: "v2", deliveryIntents: {},
  };
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.snapshots = [];
  runtime.persistState = async () => { runtime.snapshots.push(structuredClone(runtime.state)); };
  return runtime;
}

test("standalone OpenClaw @mentions become exact Room membership selectors", async () => {
  const runtime = deliveryLifecycleRuntime();
  const posts = [];
  const roomState = {
    headSeq: 5,
    activeEpoch: {id: "epoch-1"},
    roster: [
      {membershipId: "claw-member", displayName: "Claw", role: "participant_agent", status: "active"},
      {membershipId: "aura-member", displayName: "Aura", role: "participant_agent", status: "active"},
      {membershipId: "zurie-member", displayName: "Zurie", role: "participant_agent", status: "active"},
    ],
  };
  runtime.state.membershipId = "claw-member";
  runtime.client = {
    roomState: async () => roomState,
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async (_state, post) => {
      posts.push(post);
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
  };

  await runtime.postAndFinish({
    roomId: "room-1",
    text: "@Aura, reply once; then compare with @Zurie.",
    idempotencyKey: "standalone-mentioned-recipients",
    resolveRecipientMentions: true,
  });

  assert.deepEqual(posts[0].recipientSelectors, [
    {kind: "membership", membershipId: "aura-member"},
    {kind: "membership", membershipId: "zurie-member"},
  ]);
  assert.equal(posts[0].contributionType, "question");
  assert.doesNotThrow(() => validateState(runtime.state));
});

test("standalone recipient parsing rejects near matches, ambiguity, and self-targeting", () => {
  const roster = [
    {membershipId: "claw-member", displayName: "Claw", role: "participant_agent", status: "active"},
    {membershipId: "aura-1", displayName: "Aura", role: "participant_agent", status: "active"},
    {membershipId: "aura-2", displayName: "AURA", role: "participant_agent", status: "active"},
    {membershipId: "super-walz", displayName: "Super-Walz", role: "participant_agent", status: "active"},
    {membershipId: "removed", displayName: "Zurie", role: "participant_agent", status: "removed"},
    {membershipId: "owner", displayName: "TJE", role: "human_owner", status: "active"},
  ];

  assert.deepEqual(
    resolveStandaloneRecipientSelectors("@Super-Walz: one sentence.", roster, "claw-member"),
    [{kind: "membership", membershipId: "super-walz"}],
  );
  assert.deepEqual(resolveStandaloneRecipientSelectors(
    "mail x@Super-Walz, near @Super-Walz-extra, self @Claw, removed @Zurie, human @TJE",
    roster,
    "claw-member",
  ), []);
  assert.throws(
    () => resolveStandaloneRecipientSelectors("Please ask @Aura.", roster, "claw-member"),
    /ambiguous/,
  );
});

test("posted state requires a complete canonical receipt", () => {
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 4,
    deliveryIntents: {
      "source-5:final": {
        version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending",
        identity: {roomId: "room-1", body: "Frozen", replyToId: "", sourceEventId: "source-5", cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3}},
        binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
        messagePayloadDialect: "v2",
      },
    },
  };
  assert.throws(() => validateState(state), /complete canonical receipt/);
});

test("selection persistence failure prevents message submission", async () => {
  const runtime = deliveryLifecycleRuntime();
  let posts = 0;
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => { posts += 1; throw new Error("must not post"); },
  };
  runtime.persistState = async () => { throw new Error("state persistence failed"); };
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "delivery-persist-fail", sourceEventId: "source-5",
  }), /state persistence failed/);
  assert.equal(posts, 0);
});

test("canonical receipt persistence failure rolls back posted state and evidence", async () => {
  const runtime = deliveryLifecycleRuntime();
  let writes = 0;
  let posts = 0;
  runtime.persistState = async () => {
    writes += 1;
    if (writes === 4) throw new Error("receipt write failed");
  };
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => {
      posts += 1;
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
  };
  runtime.pendingEvent = {id: "source-5", seq: 5};
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "receipt-persist-fail", sourceEventId: "source-5",
  }), /receipt write failed/);
  const intent = runtime.state.deliveryIntents["receipt-persist-fail"];
  assert.equal(posts, 1);
  assert.equal(intent.deliveryState, "delivery_pending");
  assert.equal(intent.status, "delivery_pending");
  assert.equal(intent.canonicalMessage, undefined);
  assert.equal(intent.receipt, undefined);
  assert.equal(runtime.state.terminalEvidence, undefined);
});

test("canonical receipt is delivery success before cycle completion", async () => {
  const runtime = deliveryLifecycleRuntime();
  const calls = {post: 0, complete: 0};
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    postMessage: async () => {
      calls.post += 1;
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
    completeDiscussionAttempt: async () => {
      calls.complete += 1;
      throw new RoomAPIError(503, {code: "busy", retryable: true});
    },
  };
  const cycleAttempt = {
    cycle: {id: "cycle-1", generation: 3},
    attempt: {id: "attempt-1"},
    settled: false,
  };
  runtime.pendingEvent = {id: "source-5", seq: 5};
  const receipt = await runtime.postAndFinish({
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "delivery-1", sourceEventId: "source-5", cycleAttempt,
  });
  assert.deepEqual(receipt, {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")});
  assert.deepEqual(calls, {post: 1, complete: 1});
  const intent = runtime.state.deliveryIntents["delivery-1"];
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "pending");
  assert.equal(intent.status, "lifecycle_pending");
  assert.equal(intent.canonicalMessage.id, "posted-6");
  assert.deepEqual(runtime.state.terminalEvidence["5"], {
    status: "posted", sourceEventId: "source-5", sourceSeq: 5,
    canonicalEventId: "posted-6", canonicalSeq: 6,
    canonicalTs: "2026-08-17T00:00:00Z", reason: "",
  });
  assert.ok(runtime.snapshots.some(({deliveryIntents, terminalEvidence}) => {
    const saved = deliveryIntents["delivery-1"];
    return saved.deliveryState === "posted"
      && saved.canonicalMessage?.id === "posted-6"
      && terminalEvidence?.["5"]?.canonicalSeq === 6
      && terminalEvidence?.["5"]?.canonicalTs === "2026-08-17T00:00:00Z";
  }), "complete canonical receipt and source evidence must be persisted before completion");
});

test("restart after lifecycle failure never reposts and completes idempotently", async () => {
  const runtime = deliveryLifecycleRuntime();
  const calls = {post: 0, complete: 0};
  let failCompletion = true;
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    postMessage: async () => {
      calls.post += 1;
      if (calls.post > 1) throw new Error("canonical receipt must prevent reposting");
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
    completeDiscussionAttempt: async () => {
      calls.complete += 1;
      if (failCompletion) throw new RoomAPIError(503, {code: "busy", retryable: true});
      return {state: "completed"};
    },
  };
  const request = {
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "delivery-restart", sourceEventId: "source-5",
    cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}, settled: false},
  };
  const first = await runtime.postAndFinish(request);
  assert.equal(first.eventId, "posted-6");
  assert.equal(runtime.state.deliveryIntents["delivery-restart"].status, "lifecycle_pending");

  failCompletion = false;
  const second = await runtime.postAndFinish(request);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, {post: 1, complete: 2});
  const intent = runtime.state.deliveryIntents["delivery-restart"];
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "complete");
  assert.equal(intent.status, "posted");
});

test("post-receipt lifecycle classification persistence failure cannot escape", async () => {
  const runtime = deliveryLifecycleRuntime();
  const intent = {
    version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending", lifecycleAttempts: 0,
    identity: {
      roomId: "room-1", body: "Frozen answer", replyToId: "human-1", sourceEventId: "source-5",
      cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
    },
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
    canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
    lifecycleRequest: {
      kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
      payload: {generation: 3, action: "contribute", eventId: "posted-6"},
    },
    receipt: {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")},
  };
  runtime.state.deliveryIntents["source-5:final"] = intent;
  let persists = 0;
  runtime.persistState = async () => {
    persists += 1;
    if (persists === 2) throw new Error("disk failed while classifying lifecycle debt");
  };
  runtime.client = {completeDiscussionAttempt: async () => { throw new Error("retryable lifecycle failure"); }};
  assert.equal(await runtime.completeIntentLifecycle(intent), false);
  assert.equal(persists, 2);
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "pending");
  assert.equal(intent.lifecycleAttempts, 1);
  assert.equal(intent.lifecycleError, undefined);
});

test("production restart after receipt performs lifecycle only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-restart-lifecycle-"));
  const stateFile = join(directory, "default.json");
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 4,
    deliveryIntents: {
      "source-5:final": {
        version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending", lifecycleAttempts: 1,
        identity: {roomId: "room-1", body: "Frozen", replyToId: "human-1", sourceEventId: "source-5", cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3}},
        binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
        messagePayloadDialect: "v2",
        canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
        lifecycleRequest: {kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1", payload: {generation: 3, action: "contribute", eventId: "posted-6"}},
        receipt: {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")},
      },
    },
  };
  await saveState(stateFile, state);
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: state.baseUrl});
  runtime.state = await loadState(stateFile);
  const calls = {post: 0, complete: 0};
  runtime.client = {
    postMessage: async () => { calls.post += 1; throw new Error("must not post"); },
    completeDiscussionAttempt: async () => { calls.complete += 1; return {state: "completed"}; },
  };
  await runtime.repairPendingLifecycles();
  const saved = await loadState(stateFile);
  assert.deepEqual(calls, {post: 0, complete: 1});
  assert.equal(saved.deliveryIntents["source-5:final"].deliveryState, "posted");
  assert.equal(saved.deliveryIntents["source-5:final"].lifecycleState, "complete");
});

test("production load rejects a tampered turn lifecycle request before I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-turn-lifecycle-tamper-"));
  const stateFile = join(directory, "default.json");
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 4,
    deliveryIntents: {
      "source-5:final": {
        version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending", lifecycleAttempts: 1,
        identity: {roomId: "room-1", body: "Frozen", replyToId: "human-1", sourceEventId: "source-5"},
        binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
        messagePayloadDialect: "v2", turn: {turnId: "turn-1"}, finishIdempotencyKey: "finish-good",
        canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
        lifecycleRequest: {kind: "turn", turnId: "turn-1", observedSeq: 6, sourceEventId: "source-5", idempotencyKey: "finish-good"},
        receipt: {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")},
      },
    },
  };
  await saveState(stateFile, state);
  state.deliveryIntents["source-5:final"].lifecycleRequest = {
    kind: "turn", turnId: "turn-EVIL", observedSeq: 999,
    sourceEventId: "source-5", idempotencyKey: "finish-EVIL",
  };
  await writeFile(stateFile, `${JSON.stringify(state)}\n`, {mode: 0o600});
  await assert.rejects(loadState(stateFile), /turn lifecycle request/);
});

test("retryable post failure before receipt stays durably parked", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => { throw new RoomAPIError(503, {code: "busy", retryable: true}); },
  };
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "delivery-pending", sourceEventId: "source-5",
  }), RoomAPIError);
  const intent = runtime.state.deliveryIntents["delivery-pending"];
  assert.equal(intent.deliveryState, "delivery_pending");
  assert.equal(intent.lifecycleState, "not_started");
  assert.equal(intent.status, "delivery_pending");
  assert.equal(intent.canonicalMessage, undefined);
  assert.ok(runtime.snapshots.some(({deliveryIntents}) =>
    deliveryIntents["delivery-pending"]?.deliveryState === "delivery_pending"));
});

test("pending frozen delivery retries before dispatcher or model replay", async () => {
  const runtime = deliveryLifecycleRuntime();
  let posts = 0;
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}, activeTopic: {id: "topic-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => {
      posts += 1;
      if (posts === 1) throw new RoomAPIError(503, {code: "busy", retryable: true});
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
  };
  await assert.rejects(runtime.postAndFinish({
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "source-5:final", sourceEventId: "source-5",
  }), RoomAPIError);
  const parked = runtime.state.deliveryIntents["source-5:final"];
  const frozenBody = parked.post.body;
  parked.post.body = "TAMPERED PLAINTEXT";
  assert.throws(() => validateState(runtime.state), /frozen post/);
  parked.post.body = frozenBody;
  const frozenKey = parked.post.idempotencyKey;
  parked.post.idempotencyKey = "tampered-key";
  assert.throws(() => validateState(runtime.state), /frozen post/);
  parked.post.idempotencyKey = frozenKey;
  const frozenTopic = parked.post.topicId;
  parked.post.topicId = "topic-EVIL";
  assert.throws(() => validateState(runtime.state), /frozen post/);
  parked.post.topicId = frozenTopic;
  const frozenEpoch = parked.post.observedEpochId;
  parked.post.observedEpochId = "epoch-EVIL";
  assert.throws(() => validateState(runtime.state), /frozen post/);
  parked.post.observedEpochId = frozenEpoch;
  const frozenObservedSeq = parked.post.observedSeq;
  parked.post.observedSeq = 999;
  assert.throws(() => validateState(runtime.state), /frozen post/);
  parked.post.observedSeq = frozenObservedSeq;
  const event = {id: "source-5", seq: 5};
  assert.equal(await runtime.recoverPendingDelivery(event), true);
  assert.equal(posts, 2);
  const intent = runtime.state.deliveryIntents["source-5:final"];
  assert.equal(intent.identity.body, "Frozen answer");
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.status, "posted");
  assert.equal(runtime.state.terminalEvidence["5"].canonicalEventId, "posted-6");
});

test("incomplete successful post response never becomes posted or calls lifecycle", async () => {
  for (const [name, response] of [
    ["missing id", {seq: 6, ts: "2026-08-17T00:00:00Z"}],
    ["boolean sequence", {id: "posted-6", seq: true, ts: "2026-08-17T00:00:00Z"}],
    ["missing timestamp", {id: "posted-6", seq: 6}],
    ["malformed timestamp", {id: "posted-6", seq: 6, ts: "not-a-timestamp"}],
    ["timezone-less timestamp", {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00"}],
    ["impossible calendar date", {id: "posted-6", seq: 6, ts: "2026-02-30T00:00:00Z"}],
  ]) {
    const runtime = deliveryLifecycleRuntime();
    const calls = {post: 0, complete: 0};
    runtime.client = {
      roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
      postMessage: async () => { calls.post += 1; return response; },
      completeDiscussionAttempt: async () => { calls.complete += 1; },
    };
    await assert.rejects(runtime.postAndFinish({
      roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
      idempotencyKey: `incomplete-${name}`, sourceEventId: "source-5",
      cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}},
    }), /requires event ID, sequence, and timestamp/);
    const intent = runtime.state.deliveryIntents[`incomplete-${name}`];
    assert.equal(intent.deliveryState, "delivery_pending");
    assert.equal(intent.lifecycleState, "not_started");
    assert.equal(intent.canonicalMessage, undefined);
    assert.equal(intent.receipt, undefined);
    assert.deepEqual(calls, {post: 1, complete: 0});
  }
});

test("complete canonical message without receipt wrapper recovers before model dispatch", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.state.deliveryIntents["source-5:final"] = {
    version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending",
    identity: {
      roomId: "room-1", body: "Frozen answer", replyToId: "human-1", sourceEventId: "source-5",
      cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
    },
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
    canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
    lifecycleRequest: {
      kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
      payload: {generation: 3, action: "contribute", eventId: "posted-6"},
    },
  };
  runtime.state.terminalEvidence = {
    "5": {status: "superseded", sourceEventId: "source-5", sourceSeq: 5, reason: "historical_epoch"},
  };
  const event = {id: "source-5", seq: 5};
  assert.equal(await runtime.recoverPostedEvidence(event), true);
  const intent = runtime.state.deliveryIntents["source-5:final"];
  assert.equal(intent.receipt.eventId, "posted-6");
  assert.equal(runtime.state.terminalEvidence["5"].canonicalSeq, 6);
});

test("production load migrates authentic 0.2.29 receipt without repost", async () => {
  const seed = deliveryLifecycleRuntime();
  seed.state.deliveryIntents["source-5:final"] = {
    version: 1,
    status: "selected",
    identity: {
      roomId: "room-1", body: "Frozen legacy answer", replyToId: "human-1",
      sourceEventId: "source-5", coordinationMode: "cycle", nextRecipient: "",
      topicId: "topic-1", initialObservedSeq: 4, initialEpochId: "epoch-1",
      cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
    },
    messagePayloadDialect: "v2",
    logicalContributionId: "logical-legacy",
    messageIdempotencyKey: "legacy-message-key",
    finishIdempotencyKey: "legacy-finish-key",
    post: {
      observedSeq: 5, idempotencyKey: "legacy-message-key", logicalContributionId: "logical-legacy",
      topicId: "topic-1", observedEpochId: "epoch-1", respondsTo: ["human-1"],
      cycleId: "cycle-1", attemptId: "attempt-1", cycleGeneration: 3,
      contributionType: "claim", body: "Frozen legacy answer",
    },
    canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
  };
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-authentic-legacy-receipt-"));
  const stateFile = join(directory, "default.json");
  await writeFile(stateFile, `${JSON.stringify(seed.state, null, 2)}\n`, {mode: 0o600});
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: seed.state.baseUrl});
  runtime.state = await loadState(stateFile);
  const calls = {post: 0, complete: 0};
  runtime.client = {
    postMessage: async () => { calls.post += 1; throw new Error("must not repost"); },
    completeDiscussionAttempt: async (_state, cycleId, attemptId, payload) => {
      calls.complete += 1;
      assert.equal(cycleId, "cycle-1");
      assert.equal(attemptId, "attempt-1");
      assert.deepEqual(payload, {generation: 3, action: "contribute", eventId: "posted-6"});
      return {state: "completed"};
    },
  };
  await runtime.repairPendingLifecycles();
  assert.deepEqual(calls, {post: 0, complete: 1});
  const intent = runtime.state.deliveryIntents["source-5:final"];
  assert.equal(intent.version, 2);
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "complete");
  assert.equal(intent.receipt.eventId, "posted-6");
  assert.deepEqual(intent.lifecycleRequest, {
    kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
    payload: {generation: 3, action: "contribute", eventId: "posted-6"},
  });
});

test("production load replays authentic 0.2.29 frozen request with original idempotency key", async () => {
  const seed = deliveryLifecycleRuntime();
  seed.state.deliveryIntents["source-5:final"] = {
    version: 1,
    status: "selected",
    identity: {
      roomId: "room-1", body: "Frozen legacy answer", replyToId: "human-1",
      sourceEventId: "source-5", coordinationMode: "open", nextRecipient: "",
      topicId: "topic-1", initialObservedSeq: 4, initialEpochId: "epoch-1", cycle: null,
    },
    messagePayloadDialect: "v2",
    logicalContributionId: "logical-legacy",
    messageIdempotencyKey: "legacy-message-key",
    finishIdempotencyKey: "legacy-finish-key",
    post: {
      observedSeq: 5, idempotencyKey: "legacy-message-key", logicalContributionId: "logical-legacy",
      topicId: "topic-1", observedEpochId: "epoch-1", respondsTo: ["human-1"],
      contributionType: "claim", body: "Frozen legacy answer",
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-authentic-legacy-frozen-"));
  const stateFile = join(directory, "default.json");
  await writeFile(stateFile, `${JSON.stringify(seed.state, null, 2)}\n`, {mode: 0o600});
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: seed.state.baseUrl});
  runtime.state = await loadState(stateFile);
  let postedPayload;
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    postMessage: async (_state, payload) => {
      postedPayload = structuredClone(payload);
      return {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"};
    },
  };
  assert.equal(await runtime.recoverPendingDelivery({id: "source-5", seq: 5}), true);
  assert.equal(postedPayload.idempotencyKey, "legacy-message-key");
  assert.equal(postedPayload.body, "Frozen legacy answer");
  assert.equal(runtime.state.deliveryIntents["source-5:final"].deliveryState, "posted");
});

test("production load migrates bound 0.2.29 receipt without repost", async () => {
  const seed = deliveryLifecycleRuntime();
  seed.state.deliveryIntents["source-5:final"] = {
    version: 1,
    status: "selected",
    identity: {
      roomId: "room-1", body: "Frozen legacy answer", replyToId: "human-1",
      sourceEventId: "source-5", cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
    },
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
    canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
    lifecycleRequest: {
      kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
      payload: {generation: 3, action: "contribute", eventId: "posted-6"},
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-legacy-migration-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, seed.state);
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: seed.state.baseUrl});
  runtime.state = await loadState(stateFile);
  const calls = {post: 0, complete: 0};
  runtime.client = {
    postMessage: async () => { calls.post += 1; throw new Error("must not repost"); },
    completeDiscussionAttempt: async (_state, cycleId, attemptId, payload) => {
      calls.complete += 1;
      assert.equal(cycleId, "cycle-1");
      assert.equal(attemptId, "attempt-1");
      assert.deepEqual(payload, {generation: 3, action: "contribute", eventId: "posted-6"});
      return {state: "completed"};
    },
  };
  await runtime.repairPendingLifecycles();
  await runtime.repairPendingLifecycles();
  assert.deepEqual(calls, {post: 0, complete: 1});
  const intent = runtime.state.deliveryIntents["source-5:final"];
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "complete");
  assert.equal(intent.status, "posted");
  assert.equal(intent.receipt.eventId, "posted-6");
  const foreign = structuredClone(seed.state);
  foreign.deliveryIntents["source-5:final"].identity.roomId = "room-foreign";
  const blockedRuntime = deliveryLifecycleRuntime();
  blockedRuntime.state = foreign;
  let blockedCalls = 0;
  blockedRuntime.client = {completeDiscussionAttempt: async () => { blockedCalls += 1; }};
  await blockedRuntime.repairPendingLifecycles();
  assert.equal(blockedCalls, 0);
  assert.equal(blockedRuntime.state.deliveryIntents["source-5:final"].lifecycleState, "blocked");
});

test("posted gap acknowledges contiguous terminal tail and preserves lifecycle journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-lifecycle-ack-"));
  const stateFile = join(directory, "default.json");
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 4,
    deliveryIntents: {
      "source-5:final": {
        version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending",
        identity: {
          roomId: "room-1", body: "Frozen answer", replyToId: "human-1", sourceEventId: "source-5",
          cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
        },
        binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
        messagePayloadDialect: "v2",
        canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
        lifecycleRequest: {
          kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
          payload: {generation: 3, action: "contribute", eventId: "posted-6"},
        },
        receipt: {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")},
      },
    },
    terminalEvidence: {
      "5": {
        status: "posted", sourceEventId: "source-5", sourceSeq: 5,
        canonicalEventId: "posted-6", canonicalSeq: 6,
        canonicalTs: "2026-08-17T00:00:00Z", reason: "",
      },
      "7": {status: "ignored", sourceEventId: "event-7", sourceSeq: 7, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "self_event"},
    },
  };
  await saveState(stateFile, state);
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: state.baseUrl});
  runtime.state = await loadState(stateFile);
  runtime.pendingEvent = {id: "source-5", seq: 5};
  const acknowledgements = [];
  runtime.client = {
    acknowledge: async (_state, seq) => {
      acknowledgements.push(seq);
      return {acknowledgedSeq: seq};
    },
  };
  await runtime.ack("source-5");
  let saved = await loadState(stateFile);
  assert.deepEqual(acknowledgements, [5]);
  assert.equal(saved.cursor, 5);
  assert.ok(saved.terminalEvidence["7"]);
  runtime.state.terminalEvidence["6"] = {
    status: "posted", sourceEventId: "event-6", sourceSeq: 6,
    canonicalEventId: "posted-8", canonicalSeq: 8,
    canonicalTs: "2026-08-17T00:01:00Z", reason: "",
  };
  await runtime.ackEvent({id: "event-6", seq: 6});
  saved = await loadState(stateFile);
  assert.deepEqual(acknowledgements, [5, 7]);
  assert.equal(saved.cursor, 7);
  assert.equal(saved.deliveryIntents["source-5:final"].deliveryState, "posted");
  assert.equal(saved.deliveryIntents["source-5:final"].lifecycleState, "pending");
});

test("legacy posted evidence without full receipt loads but cannot acknowledge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-legacy-evidence-"));
  const stateFile = join(directory, "default.json");
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 4,
    terminalEvidence: {
      "5": {status: "posted", sourceEventId: "source-5", sourceSeq: 5, canonicalEventId: "posted-6", reason: ""},
    },
  };
  await saveState(stateFile, state);
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: state.baseUrl});
  runtime.state = await loadState(stateFile);
  runtime.pendingEvent = {id: "source-5", seq: 5};
  let acknowledgements = 0;
  runtime.client = {acknowledge: async () => { acknowledgements += 1; }};
  await assert.rejects(runtime.ack("source-5"), /requires durable terminal evidence/);
  assert.equal(acknowledgements, 0);
  assert.equal(runtime.state.cursor, 4);
});

test("acknowledgement requires an exact explicit server frontier", async () => {
  for (const response of [{}, {acknowledgedSeq: 9}]) {
    const runtime = deliveryLifecycleRuntime();
    runtime.state.terminalEvidence = {
      "5": {status: "ignored", sourceEventId: "source-5", sourceSeq: 5, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "test"},
    };
    runtime.client = {acknowledge: async () => response};
    await assert.rejects(runtime.ackEvent({id: "source-5", seq: 5}), /locally proven contiguous frontier/);
    assert.equal(runtime.state.cursor, 4);
    assert.ok(runtime.state.terminalEvidence["5"]);
  }
});

test("non-retryable lifecycle failure blocks delivery without another automatic call", async () => {
  const runtime = deliveryLifecycleRuntime();
  const intent = {
    version: 2, status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending",
    lifecycleAttempts: 2,
    identity: {
      roomId: "room-1", body: "Frozen answer", replyToId: "human-1", sourceEventId: "source-5",
      cycle: {cycleId: "cycle-1", attemptId: "attempt-1", generation: 3},
    },
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
    canonicalMessage: {id: "posted-6", seq: 6, ts: "2026-08-17T00:00:00Z"},
    lifecycleRequest: {
      kind: "cycle", cycleId: "cycle-1", attemptId: "attempt-1",
      payload: {generation: 3, action: "contribute", eventId: "posted-6"},
    },
    receipt: {eventId: "posted-6", sentAt: Date.parse("2026-08-17T00:00:00Z")},
  };
  runtime.state.deliveryIntents["source-5:final"] = intent;
  let lifecycleCalls = 0;
  runtime.client = {
    completeDiscussionAttempt: async () => {
      lifecycleCalls += 1;
      throw new RoomAPIError(409, {code: "cycle_conflict", retryable: false});
    },
  };
  assert.equal(await runtime.completeIntentLifecycle(intent), false);
  await runtime.repairPendingLifecycles();
  assert.equal(lifecycleCalls, 1);
  assert.equal(intent.deliveryState, "posted");
  assert.equal(intent.lifecycleState, "blocked");
  assert.equal(intent.status, "lifecycle_blocked");
  assert.equal(intent.lifecycleAttempts, 3);
  intent.lifecycleState = "pending";
  intent.status = "lifecycle_pending";
  await runtime.repairPendingLifecycles();
  assert.equal(lifecycleCalls, 1);
  assert.equal(intent.lifecycleState, "blocked");
  assert.equal(intent.status, "lifecycle_blocked");
});

test("non-retryable post failure is quarantined and cannot repost", async () => {
  const runtime = deliveryLifecycleRuntime();
  let posts = 0;
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => {
      posts += 1;
      throw new RoomAPIError(409, {code: "validation_error", retryable: false});
    },
  };
  const request = {
    roomId: "room-1", text: "Frozen answer", replyToId: "human-1",
    idempotencyKey: "delivery-quarantined", sourceEventId: "source-5",
  };
  await assert.rejects(runtime.postAndFinish(request), RoomAPIError);
  await assert.rejects(runtime.postAndFinish(request), /quarantined for operator recovery/);
  assert.equal(posts, 1);
  const intent = runtime.state.deliveryIntents["delivery-quarantined"];
  assert.equal(intent.deliveryState, "quarantined");
  assert.equal(intent.lifecycleState, "not_started");
  assert.equal(intent.canonicalMessage, undefined);
});

test("active epoch page metadata is an inseparable validated pair and sequence is authoritative", () => {
  assert.deepEqual(validateActiveEpochPage({activeEpochId: "epoch-new", activeEpochStartsAtSeq: 10}), {
    id: "epoch-new", startsAtSeq: 10,
  });
  for (const page of [
    {activeEpochId: "epoch-new"},
    {activeEpochStartsAtSeq: 10},
    {activeEpochId: "", activeEpochStartsAtSeq: 10},
    {activeEpochId: 7, activeEpochStartsAtSeq: 10},
    {activeEpochId: "epoch-new", activeEpochStartsAtSeq: 0},
    {activeEpochId: "epoch-new", activeEpochStartsAtSeq: 1.5},
  ]) assert.throws(() => validateActiveEpochPage(page), /active epoch/i);

  assert.equal(eventEpochId({seq: 9, payload: {}}, "epoch-new", 10), "");
  assert.equal(eventEpochId({seq: 10, payload: {}}, "epoch-new", 10), "epoch-new");
  assert.equal(eventEpochId({seq: 9, payload: {epochId: "epoch-old"}}, "epoch-new", 10), "epoch-old");
  assert.throws(() => eventEpochId({seq: 10, payload: {epochId: "epoch-old"}}, "epoch-new", 10), /contradicts/i);
  assert.throws(() => eventEpochId({seq: 10, payload: {epochId: "epoch-new", epoch: {id: "epoch-other"}}}, "epoch-new", 10), /contradictory/i);
  assert.throws(() => eventEpochId({seq: 10, payload: {epochId: 7}}, "epoch-new", 10), /malformed/i);
  for (const event of [
    {seq: 2, type: "human.command", payload: {}},
    {seq: 3, type: "discussion.started", payload: {}},
    {seq: 4, type: "message.posted", payload: {body: "legacy"}},
  ]) assert.equal(eventEpochId(event, "epoch-new", 10), "", `${event.type} must remain historical without payload metadata`);
});

test("accepts only interrupted-cycle cleanup after a new epoch boundary", () => {
  const cleanup = {
    seq: 11,
    type: "discussion.cycle_terminal",
    actorRole: "human_owner",
    payload: {
      cycleId: "cycle-old",
      epochId: "epoch-old",
      state: "interrupted",
      reason: "human_interrupted",
      interruptedByEventId: "discussion-new",
    },
  };

  assert.equal(eventEpochId(cleanup, "epoch-new", 10), "epoch-old");
  assert.equal(eventEpochId({...cleanup, actorRole: "system", payload: {...cleanup.payload, interruptedByEventId: undefined}}, "epoch-new", 10), "epoch-old");
  assert.throws(() => eventEpochId({...cleanup, type: "message.posted"}, "epoch-new", 10), /contradicts/i);
  assert.throws(() => eventEpochId({...cleanup, type: "discussion.cycle_attempt_ready"}, "epoch-new", 10), /contradicts/i);
  assert.throws(() => eventEpochId({...cleanup, payload: {...cleanup.payload, state: "completed"}}, "epoch-new", 10), /contradicts/i);
  assert.throws(() => eventEpochId({...cleanup, payload: {...cleanup.payload, reason: "budget_exhausted"}}, "epoch-new", 10), /contradicts/i);
});

test("epoch conversation discriminator is bounded, opaque, and stable", () => {
  const first = epochConversationId("room-1", "epoch/private?one");
  const again = epochConversationId("room-1", "epoch/private?one");
  const other = epochConversationId("room-1", "epoch/private?two");
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(first, /^room-1:epoch:[a-f0-9]{32}$/);
  assert.equal(first.includes("private"), false);
  assert.throws(() => epochConversationId("room-1", "x".repeat(513)), /epoch id/i);
});

test("authenticated epoch IDs retain exact whitespace-distinct identity at every routing boundary", () => {
  assert.deepEqual(validateActiveEpochPage({activeEpochId: " epoch ", activeEpochStartsAtSeq: 10}), {
    id: " epoch ", startsAtSeq: 10,
  });
  assert.equal(eventEpochId({seq: 10, payload: {epochId: " epoch "}}, " epoch ", 10), " epoch ");
  assert.notEqual(epochConversationId("room-1", "epoch"), epochConversationId("room-1", " epoch "));
  assert.throws(() => validateActiveEpochPage({activeEpochId: "   ", activeEpochStartsAtSeq: 10}), /active epoch/i);
  assert.throws(() => eventEpochId({seq: 10, payload: {epochId: "epoch"}}, " epoch ", 10), /contradicts/i);
  const event = {id: "current", seq: 10, type: "message.posted", actorRole: "human_owner", payload: {body: "continue", epochId: " epoch "}};
  assert.equal(normalizeEvent(event, "room-1", null, "", " epoch ", "epoch").conversationId,
    epochConversationId("room-1", " epoch "));
  assert.equal(normalizeEvent(event, "room-1", null, "", " epoch ", " epoch ").conversationId, "room-1");
});

test("canonical context excludes all prior-epoch messages by sequence", () => {
  const context = canonicalRoomContext({activeEpoch: {id: "epoch-new", startsAtSeq: 10}}, [
    {id: "old-1", seq: 8, type: "message.posted", payload: {body: "OLD SECRET"}},
    {id: "new-1", seq: 10, type: "message.posted", payload: {body: "NEW CONTEXT"}},
  ], "current", {}, 10);
  assert.doesNotMatch(context, /OLD SECRET/);
  assert.match(context, /NEW CONTEXT/);
});

test("posted terminal evidence is monotonic and cannot be downgraded", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.state.terminalEvidence = {
    "5": {
      status: "posted", sourceEventId: "source-5", sourceSeq: 5,
      canonicalEventId: "posted-6", canonicalSeq: 6,
      canonicalTs: "2026-08-17T00:00:00Z", reason: "",
    },
  };
  const evidence = await runtime.recordTerminalEvidence({id: "source-5", seq: 5}, "superseded", {reason: "historical_epoch"});
  assert.equal(evidence.status, "posted");
  assert.equal(runtime.state.terminalEvidence["5"].canonicalEventId, "posted-6");
});

test("historical pending delivery is durably superseded before acknowledgement", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.state.deliveryIntents["source-5:final"] = {
    version: 2, status: "delivery_pending", deliveryState: "delivery_pending", lifecycleState: "not_started",
    identity: {
      roomId: "room-1", body: "STALE OUTPUT", replyToId: "source-5", sourceEventId: "source-5",
      sourceEpochId: "epoch-old", coordinationMode: "open", nextRecipient: "", topicId: null,
      initialObservedSeq: 5, initialEpochId: "epoch-old", postObservedSeq: 5, postObservedEpochId: "epoch-old", cycle: null,
    },
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2", logicalContributionId: "logical-source-5",
    requestIdempotencyKey: "request-source-5", messageIdempotencyKey: "message-source-5", finishIdempotencyKey: "finish-source-5",
    post: {
      observedSeq: 5, observedEpochId: "epoch-old", idempotencyKey: "message-source-5",
      logicalContributionId: "logical-source-5", respondsTo: ["source-5"], contributionType: "claim", body: "STALE OUTPUT",
    },
  };
  await runtime.supersedeHistoricalEvent({id: "source-5", seq: 5}, "epoch-old");
  const intent = runtime.state.deliveryIntents["source-5:final"];
  assert.equal(intent.deliveryState, "superseded");
  assert.equal(intent.status, "superseded");
  assert.equal(runtime.state.terminalEvidence["5"].status, "superseded");
  assert.ok(runtime.snapshots.some((snapshot) => snapshot.deliveryIntents["source-5:final"]?.status === "superseded"
    && snapshot.terminalEvidence?.["5"]?.status === "superseded"));
});

test("historical acknowledgement fails closed for mismatched or aliased occupied intents", async () => {
  const mismatched = deliveryLifecycleRuntime();
  mismatched.state.deliveryIntents["source-5:final"] = {
    version: 2, status: "selected", deliveryState: "selected", lifecycleState: "not_started",
    identity: {roomId: "room-1", body: "wrong", replyToId: "", sourceEventId: "other-source"},
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
  };
  await assert.rejects(mismatched.supersedeHistoricalEvent({id: "source-5", seq: 5}), /exactly bound/i);
  assert.equal(mismatched.state.terminalEvidence?.["5"], undefined);

  const aliased = deliveryLifecycleRuntime();
  aliased.state.deliveryIntents["legacy-arbitrary-key"] = {
    version: 2, status: "selected", deliveryState: "selected", lifecycleState: "not_started",
    identity: {roomId: "room-1", body: "pending", replyToId: "", sourceEventId: "source-5"},
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    messagePayloadDialect: "v2",
  };
  await assert.rejects(aliased.supersedeHistoricalEvent({id: "source-5", seq: 5}), /non-canonical key/i);
  assert.equal(aliased.state.terminalEvidence?.["5"], undefined);

  const postedWithAlias = deliveryLifecycleRuntime();
  postedWithAlias.state.terminalEvidence = {
    "5": {status: "posted", sourceEventId: "source-5", sourceSeq: 5,
      canonicalEventId: "posted-6", canonicalSeq: 6, canonicalTs: "2026-08-17T00:00:00Z", reason: ""},
  };
  postedWithAlias.state.deliveryIntents["legacy-arbitrary-key"] = structuredClone(
    aliased.state.deliveryIntents["legacy-arbitrary-key"],
  );
  assert.throws(() => postedWithAlias.assertHistoricalIntentSafety({id: "source-5", seq: 5}), /non-canonical key/i);
  await assert.rejects(postedWithAlias.supersedeHistoricalEvent({id: "source-5", seq: 5}), /non-canonical key/i);
  assert.equal(postedWithAlias.state.deliveryIntents["legacy-arbitrary-key"].status, "selected");
});

test("model output is suppressed when the source epoch advances before posting", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.pendingEvent = {id: "source-5", seq: 5};
  const calls = {policy: 0, turn: 0, post: 0};
  runtime.client = {
    roomState: async () => ({headSeq: 9, activeEpoch: {id: "epoch-new", startsAtSeq: 8}}),
    roomPolicy: async () => { calls.policy += 1; return {policy: {coordinationMode: "open"}}; },
    requestTurn: async () => { calls.turn += 1; },
    postMessage: async () => { calls.post += 1; },
  };
  const result = await runtime.postAndFinish({
    roomId: "room-1", text: "STALE MODEL OUTPUT", replyToId: "source-5",
    idempotencyKey: "source-5:final", sourceEventId: "source-5", sourceEpochId: "epoch-old",
  });
  assert.deepEqual(result, {superseded: true});
  assert.deepEqual(calls, {policy: 0, turn: 0, post: 0});
  assert.equal(runtime.state.terminalEvidence["5"].status, "superseded");
});

test("baseline epoch migration survives production save and load while future epochs rotate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-epoch-baseline-"));
  const stateFile = join(directory, "default.json");
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "redacted", clientInstanceId: "client-1", cursor: 40,
    epochSessionRoutingInitialized: true, legacySessionEpochId: "epoch-current", rotateCurrentEpochSession: false,
  };
  await saveState(stateFile, state);
  const loaded = await loadState(stateFile);
  assert.equal(normalizeEvent({
    id: "current", seq: 41, type: "message.posted", actorRole: "human_owner",
    payload: {body: "continue", epochId: "epoch-current"},
  }, loaded.roomId, null, "", "epoch-current", loaded.legacySessionEpochId).conversationId, "room-1");
  assert.equal(normalizeEvent({
    id: "future", seq: 50, type: "message.posted", actorRole: "human_owner",
    payload: {body: "rotate", epochId: "epoch-future"},
  }, loaded.roomId, null, "", "epoch-future", loaded.legacySessionEpochId).conversationId,
  epochConversationId("room-1", "epoch-future"));
});

test("epoch transition during context loading fails closed before model dispatch", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.client = {
    roomState: async () => ({headSeq: 12, activeEpoch: {id: "epoch-current", startsAtSeq: 10}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async () => ({activeEpochId: "epoch-next", activeEpochStartsAtSeq: 13, events: []}),
  };
  await assert.rejects(runtime.sharedRoomContext(
    {id: "source-12", seq: 12}, {id: "epoch-current", startsAtSeq: 10},
  ), /advanced while loading model context/);
});
