import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {canonicalRoomContext, commandInstruction, cyclePhaseInstruction, isAssignedEvent, isAssignedMessage, normalizeEvent, OpenClawRoomRuntime} from "../src/runtime.js";
import {saveState} from "../src/state.js";

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
  const activities = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/connector/sessions")) {
        registrations += 1;
		registrationBody = JSON.parse(init.body);
        return new Response(JSON.stringify({sessionId: "session-1", heartbeatIntervalSeconds: 60}), {status: 200});
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
	assert.deepEqual(registrationBody.metadata, {
	  runtimeName: "OpenClaw", runtimeVersion: "2026.7.1-2",
	  roomConnectorVersion: "0.2.26", roomConnectorCommit: "unknown", roomConnectorArtifact: "unknown",
	  hostLabel: "default", transport: "long_poll", modelDescriptor: "host-selected",
	});
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

test("verified build provenance is sent independently of OpenClaw core version", async () => {
	const directory=await mkdtemp(join(tmpdir(),"openclaw-room-provenance-")); const stateFile=join(directory,"default.json");
	await saveState(stateFile,{version:1,baseUrl:"https://room.example/api",roomId:"room-1",membershipId:"member-1",credential:"secret",clientInstanceId:"client-1",cursor:0});
	let metadata;
	const runtime=new OpenClawRoomRuntime({accountId:"default",stateFile,baseUrl:"https://room.example/api"},{releaseProvenance:{version:"0.2.26",sourceCommit:"a".repeat(40),artifactIdentity:"sha256:"+"b".repeat(64)},fetchImpl:async(url,init)=>{
	  if(url.endsWith("/connector/sessions")){metadata=JSON.parse(init.body).metadata;return new Response(JSON.stringify({sessionId:"s",heartbeatIntervalSeconds:60}),{status:200})}
	  if(url.endsWith("/activity"))return new Response(JSON.stringify({acceptedStreamSeq:1}),{status:202}); throw new Error(url);
	}});
	await runtime.initialize(); assert.equal(metadata.runtimeVersion,"2026.7.1-2"); assert.equal(metadata.roomConnectorVersion,"0.2.26"); assert.equal(metadata.roomConnectorCommit,"a".repeat(40)); assert.equal(metadata.roomConnectorArtifact,"sha256:"+"b".repeat(64)); await runtime.close();
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
  }, "[Canonical Room context]\nPaula: Europe needs public compute infrastructure.\n[/Canonical Room context]");
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
  }, context);
  assert.match(direct.text, /Current discussion: Compute sovereignty/);
  assert.match(direct.text, /What is your direct answer to this question/);
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
