import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ARTIFACT_CONTEXT_CHARACTER_LIMIT, HANDOVER_CONTEXT_CHARACTER_LIMIT, HOST_LABEL, canonicalRoomContext, commandInstruction, discussionHandoverContext, sourceArtifactContext, cyclePhaseInstruction, epochConversationId, epochEvidence, eventEpochId, isAssignedEvent, isAssignedMessage, isBoundaryEvent, isLifecycleOnlyCycleTerminal, normalizeEvent, OpenClawRoomRuntime, resetEnrollmentLineages, resolveStandaloneRecipientSelectors, validateActiveEpochPage} from "../src/runtime.js";
import {RoomAPIError} from "../src/room-client.js";
import {loadState, saveState, validateState} from "../src/state.js";
// Runtimes in this file get a private scratch state file: a runtime may write
// its state (ackEvent, persistState), and the directory is made 0700.
import {after as afterStateTests} from "node:test";
import {mkdtemp as mkdtempState, rm as rmState} from "node:fs/promises";
import {tmpdir as tmpdirState} from "node:os";
import {join as joinState} from "node:path";
const TEST_STATE_DIRECTORY = await mkdtempState(joinState(tmpdirState(), "openclaw-room-test-state-"));
const UNUSED_STATE_FILE = joinState(TEST_STATE_DIRECTORY, "state.json");
afterStateTests(() => rmState(TEST_STATE_DIRECTORY, {recursive: true, force: true}));

const ZURIE_FIXTURE_HASHES = Object.freeze({
  132: "136e0ad9f1b82b40338da0def2cecd6fccf2e05dcb70f8838520de23cf2b1194",
  133: "6891830fa71f0592fd1749ea7cd6361add53e426e84de3ec94bd3024c7345bb4",
  134: "fa953f52ef58410726a0c61687b88cc7d329874210820b015c93ca638dda0a49",
});

const JOINED_CODING_EPOCH_FIXTURE_HASHES = Object.freeze({
  838: "b258ffca5aa364f2b7ce8cab6bca888cd86bcca30e5fa9c93706898668f4bacb",
  839: "0f67bce1fe6977a3b4dc15ca5fd073f714a4ce42e00d06427ee9dc944d3d0ec6",
  840: "c5facd66eecdf9d7b21ecdc4e3f567b6999aeeea925f3c37cb881a7965917b1f",
  "839.future-epoch": "2fb55cf7623d82239a75e36e57aad7e93c353f6b80067f88120024547da0c79c",
  "839.empty-epoch": "1b2b0bd7712cce9069d0658114c9e12a5ec5f015970299a931dbf0efc8c81ce0",
});

test("disabled account refuses initialization before any state read or network call", async () => {
  let calls=0;
  const runtime=new OpenClawRoomRuntime({accountId:"disabled",enabled:false,stateFile:"/does-not-exist/state.json"},{fetchImpl:async()=>{calls++;throw Error("unexpected network");}});
  await assert.rejects(runtime.initialize(),/disabled/);assert.equal(calls,0);
});

test("disabled or revoked private state refuses registration without rewriting it", async () => {
  for (const flag of [{enabled:false},{revoked:true}]) {
    const directory=await mkdtemp(join(tmpdir(),"openclaw-disabled-state-"));
    const stateFile=join(directory,"state.json");
    await saveState(stateFile,{version:1,baseUrl:"https://fixture.invalid/api",roomId:"room",membershipId:"membership",credential:"fixture-only",clientInstanceId:"fixture",cursor:0,...flag});
    const before=await readFile(stateFile);let calls=0;
    const runtime=new OpenClawRoomRuntime({accountId:"fixture",enabled:true,stateFile},{fetchImpl:async()=>{calls++;throw Error("unexpected network");}});
    await assert.rejects(runtime.initialize(),/disabled, revoked or closed/);
    assert.equal(calls,0);assert.deepEqual(await readFile(stateFile),before);
  }
});

async function loadZurieFixture(seq) {
  const bytes = await readFile(new URL(`./fixtures/zurie-epoch-boundary/seq-${seq}.canonical.json`, import.meta.url));
  assert.equal(bytes.at(-1), 0x0a, `fixture ${seq} must have one repository final LF`);
  const canonical = bytes.subarray(0, -1);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), ZURIE_FIXTURE_HASHES[seq]);
  return JSON.parse(canonical.toString("utf8"));
}

async function loadJoinedCodingEpochFixture(seq) {
  const bytes = await readFile(new URL(`./fixtures/joined-coding-epoch-transition/seq-${seq}.canonical.json`, import.meta.url));
  assert.equal(bytes.at(-1), 0x0a, `fixture ${seq} must have one repository final LF`);
  const canonical = bytes.subarray(0, -1);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), JOINED_CODING_EPOCH_FIXTURE_HASHES[seq]);
  return JSON.parse(canonical.toString("utf8"));
}

async function loadJoinedCodingProductionProjection() {
  const bytes = await readFile(new URL("./fixtures/joined-coding-production-state-projection.json", import.meta.url));
  const fixture = JSON.parse(bytes.toString("utf8"));
  assert.equal(fixture.schemaVersion, 1);
  for (const forbidden of ["baseUrl", "credential", "clientInstanceId", "deliveryIntents"]) {
    assert.equal(Object.hasOwn(fixture.state, forbidden), false, `production projection must omit ${forbidden}`);
  }
  assert.equal(JSON.stringify(fixture).includes("privateMessageBodies"), true);
  assert.equal(JSON.stringify(fixture).includes('"body"'), false);
  return fixture;
}

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
    hostLabel: HOST_LABEL, transport: "long_poll", modelDescriptor: "host-selected",
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
  // Contract P8-4: the next idle frame once the half of the freshness passed.
  assert.equal(activities.length, 1);
  runtime.idleFrameAt -= 20_000;
  await runtime.maintainPresence();
  assert.equal(connectorHeartbeats, 2);
  assert.equal(activities.length, 2);
  assert.equal(activities[1].streamSeq, 2);
  await runtime.close();
});

test("persists an owner-approved Room before hot activation without a gateway restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-enrollment-"));
  const sourceFile = join(directory, "default.json");
  const sourceState = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret-1", identityVersion: 3,
    clientInstanceId: "client-1", cursor: 5,
  };
  await saveState(sourceFile, sourceState);
  const activations = [];
  const runtime = new OpenClawRoomRuntime(
    {accountId: "default", stateFile: sourceFile, baseUrl: sourceState.baseUrl},
    {
      activateEnrollment: async (activation) => {
        const persisted = await loadState(activation.stateFile);
        activations.push({activation, persisted});
      },
    },
  );
  runtime.state = sourceState;
  // Contract P8-2: the listing schedule of a join lineage is process-wide, and
  // an earlier test of this file listed for the same base URL and
  // clientInstanceId. A fresh schedule: this is the lineage's first listing.
  resetEnrollmentLineages();
  let listings = 0;
  runtime.client = {
    connectorEnrollments: async (state) => {
      assert.equal(state.clientInstanceId, "client-1");
      listings += 1;
      return listings === 1 ? [{invitationId: "invite-2", roomTitle: "WAM GGF3"}] : [];
    },
    claimConnectorEnrollment: async (state, invitationId) => {
      assert.equal(state.clientInstanceId, "client-1");
      assert.equal(invitationId, "invite-2");
      return {
        roomId: "room-2", membershipId: "member-2", credential: "secret-2",
        credentialExpiresAt: "2026-12-01T00:00:00Z", identityVersion: 3, headSeq: 7,
      };
    },
  };

  const activated = await runtime.acceptConnectorEnrollments();
  assert.equal(activated.length, 1);
  assert.equal(activations.length, 1);
  assert.equal(activations[0].activation.accountId, "member-2");
  assert.equal(activations[0].persisted.roomId, "room-2");
  assert.equal(activations[0].persisted.membershipId, "member-2");
  assert.equal(activations[0].persisted.credential, "secret-2");
  assert.equal(activations[0].persisted.clientInstanceId, "client-1");
  assert.equal(activations[0].persisted.cursor, 7);
  // Contract P8-2: no second listing within the interval; directly after an
  // accepted registration the account lists again, whatever the schedule.
  assert.deepEqual(await runtime.acceptConnectorEnrollments(), []);
  assert.equal(listings, 1);
  runtime.enrollmentOwed = true; // what registerConnector sets
  assert.deepEqual(await runtime.acceptConnectorEnrollments(), []);
  assert.equal(listings, 2);
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
  assert.deepEqual(metadata, {runtimeName:"OpenClaw",runtimeVersion:"2026.7.1-2",hostLabel:HOST_LABEL,transport:"long_poll",modelDescriptor:"host-selected"});
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
  // P1a-4: without a Room phase instruction the connector adds none.
  assert.doesNotMatch(normalized.text, /Continue the autonomous discussion|Room phase instruction/);
  assert.match(normalized.text, /\[Room turn facts\]\nDiscussion phase: follow_up/);
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
  assert.match(context, /maximum sources 3/);
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
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
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
  // This partial state is never saved (the P3-1 ledger write would persist it).
  runtime.persistState = async () => {};
  runtime.client = {
    readEvents: async () => ({
      activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1,
      events: [event],
    }),
    // The delivery fence reads the Room state's start (P7c-7).
    roomState: async () => ({activeEpoch: {id: "epoch-1", startsAtSeq: 1}}),
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

test("coordinated human source starts one server-owned cycle but only its ready event claims the attempt", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "aura-member"};
  const starts = [];
  runtime.client = {
    roomPolicy: async () => ({policy: {coordinationMode: "coordinated"}}),
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

test("explicit owner retry targets only the non-summary agent and never calls a model at source delivery", async () => {
  const event = {id: "retry", type: "human.command", actorRole: "human_owner", payload: {command: {
    command: "ask", resolvedTargetMembershipIds: ["second"], arguments: {instruction: "Try once", retryUnavailable: true},
  }}};
  assert.equal(isAssignedEvent(event, "second"), true);
  assert.equal(isAssignedEvent(event, "first"), false);
  assert.equal(isAssignedEvent({...event, actorRole: "participant_agent"}, "second"), false);
  for (const mode of ["open", "coordinated"]) {
    const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
    runtime.state = {roomId: "room-1", membershipId: "second"};
    const starts = [];
    runtime.client = {
      roomPolicy: async () => ({coordinationMode: mode, summaryCoordinatorMembershipId: "first"}),
      roomState: async () => ({activeEpoch: {id: "epoch-1"}, roster: ["first", "second"].map(membershipId => ({
        membershipId, displayName: membershipId, status: "active", role: "participant_agent", executionReady: false,
      }))}),
      startDiscussionCycle: async (_state, request) => { starts.push(request); return {id: "retry-cycle"}; },
      claimDiscussionAttempt: async () => { throw new Error("source must not claim or execute"); },
    };
    assert.equal(await runtime.prepareCycleAttempt(event), false);
    assert.deepEqual(starts[0].roster, [{membershipId: "second", displayName: "second"}]);
    assert.equal(starts[0].sourceEventId, "retry");
  }
  // Contract P2a-4: an addressed ask starts a cycle with or without
  // retryUnavailable, for every resolved target and only for them.
  for (const args of [{}, {retryUnavailable: "true"}]) {
    assert.equal(isAssignedEvent({...event, payload: {command: {...event.payload.command, arguments: args}}}, "second"), true);
  }
  const both = {...event, payload: {command: {...event.payload.command, resolvedTargetMembershipIds: ["first", "second"]}}};
  assert.equal(isAssignedEvent(both, "second"), true);
  assert.equal(isAssignedEvent(both, "third"), false);
});

test("open-room agent contribution replies directly while a cycle-bound contribution continues its cycle", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
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
  // ADR 0089: in an open Room an addressed peer replies directly, no cycle.
  const seeded = await runtime.prepareCycleAttempt({
    id: "agent-source", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
    payload: {body: "A new peer claim", resolvedRecipientMembershipIds: ["reader-member"]},
  });
  assert.equal(seeded, null);
  assert.equal(starts.length, 0);
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
  assert.equal(starts.length, 0);
  assert.deepEqual(claims, ["cycle-existing"]);
});

test("agent contribution cannot seed outside the open follow-up policy", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
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

test("follow-up phase carries no connector guidance; a Room phase instruction passes verbatim", () => {
  const result = cyclePhaseInstruction({round: 2}, {budgets: {perAgentTurns: 3}}, {});
  assert.equal(result.phase, "follow_up");
  assert.equal(result.instruction, "");
  const room = "Respond to the strongest objection so far.";
  assert.equal(cyclePhaseInstruction({round: 2}, {budgets: {perAgentTurns: 3}}, {phaseInstruction: room}).instruction, room);
});

function deliveryLifecycleRuntime() {
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
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
    {activeEpochStartsAtSeq: 10},
    {activeEpochId: "", activeEpochStartsAtSeq: 10},
    {activeEpochId: 7, activeEpochStartsAtSeq: 10},
  ]) assert.throws(() => validateActiveEpochPage(page), /active epoch/i);
  // Contract P6-2: a valid id with a start of any other shape is the start
  // unknown, never a stopped channel (test/parity-p6.test.mjs).
  for (const startsAtSeq of [undefined, 0, 1.5, "10"]) {
    assert.deepEqual(validateActiveEpochPage({activeEpochId: "epoch-new", activeEpochStartsAtSeq: startsAtSeq}), {id: "epoch-new", startsAtSeq: 0});
  }

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

test("accepts exactly the lifecycle-only terminal state, reason, and role table", () => {
  const terminal = {
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

  const accepted = [
    terminal,
    {...terminal, actorRole: "agent_owner"},
    {...terminal, actorRole: "system"},
    {...terminal, actorRole: "system", payload: {...terminal.payload, state: "timed_out", reason: "cycle_deadline_reached"}},
    {...terminal, actorRole: "system", payload: {...terminal.payload, reason: "coordination_mode_changed"}},
    {...terminal, actorRole: "system", payload: {...terminal.payload, reason: "epoch_superseded"}},
  ];
  for (const event of accepted) {
    assert.equal(isLifecycleOnlyCycleTerminal(event), true);
    assert.equal(eventEpochId(event, "epoch-new", 10, "epoch-old"), "epoch-old");
  }

  const rejected = [
    {...terminal, type: "message.posted"},
    {...terminal, type: "discussion.cycle_attempt_ready"},
    {...terminal, payload: {...terminal.payload, cycleId: ""}},
    {...terminal, payload: {...terminal.payload, state: "completed"}},
    {...terminal, payload: {...terminal.payload, state: "failed"}},
    {...terminal, payload: {...terminal.payload, reason: "budget_exhausted"}},
    {...terminal, actorRole: "human_owner", payload: {...terminal.payload, state: "timed_out", reason: "cycle_deadline_reached"}},
  ];
  for (const event of rejected) {
    assert.equal(isLifecycleOnlyCycleTerminal(event), false);
    assert.throws(() => eventEpochId(event, "epoch-new", 10), /contradicts/i);
  }
});

test("epoch evidence is shared, exact, and contradiction-safe", () => {
  assert.equal(epochEvidence({type: "message.posted", payload: {}}), "");
  for (const payload of [
    {epochId: "epoch-1"},
    {epoch: {id: "epoch-1"}},
    {epoch: {topic: {epochId: "epoch-1"}}},
    {topic: {epochId: "epoch-1"}},
  ]) assert.equal(epochEvidence({type: "message.posted", payload}), "epoch-1");
  assert.equal(epochEvidence({
    type: "discussion.cycle_terminal", payload: {summaryHandoff: {epochId: "epoch-1"}},
  }), "epoch-1");
  assert.equal(epochEvidence({
    type: "message.posted", payload: {summaryHandoff: {epochId: "ignored"}},
  }), "");
  assert.throws(() => epochEvidence({
    type: "discussion.cycle_terminal",
    payload: {epochId: "epoch-1", summaryHandoff: {epochId: "epoch-2"}},
  }), {message: "Room event contains contradictory epoch evidence"});
});

test("boundary classification requires exact adjacent transition and durable prior epoch evidence", () => {
  const event = {seq: 11, type: "message.posted", payload: {epochId: "epoch-old"}};
  assert.equal(isBoundaryEvent({...event, seq: 9}, "epoch-new", 10, "epoch-old"), false);
  assert.equal(isBoundaryEvent({...event, payload: {epochId: "epoch-new"}}, "epoch-new", 10, "epoch-old"), false);
  assert.equal(isBoundaryEvent(event, "epoch-new", 10, "epoch-old"), true);
  assert.equal(isBoundaryEvent(event, "epoch-new", 10, "future-epoch"), false);
  assert.equal(isBoundaryEvent({...event, seq: 12}, "epoch-new", 10, "epoch-old"), false);
  assert.equal(isBoundaryEvent({...event, payload: {}}, "epoch-new", 10, "epoch-old"), false);
  assert.throws(() => isBoundaryEvent({
    ...event, type: "discussion.cycle_terminal",
    payload: {epochId: "epoch-old", summaryHandoff: {epochId: "epoch-other"}},
  }, "epoch-new", 10, "epoch-old"), {message: "Room event contains contradictory epoch evidence"});
});

test("fixture 132-134 acknowledges the timed-out terminal as lifecycle-only", async () => {
  const events = await Promise.all([132, 133, 134].map(loadZurieFixture));
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-zurie-epoch-"));
  const stateFile = join(directory, "default.json");
  const controller = new AbortController();
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "bczi4bui9f7q159",
    membershipId: "nnrafww8dv4g7a6", credential: "redacted", clientInstanceId: "client-1",
    cursor: 131, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "qjw1tu1jfnm1wsp",
  };
  await saveState(stateFile, runtime.state);
  runtime.connectorSession = {sessionId: "session-1"};
  const acknowledgements = [];
  runtime.client = {
    readEvents: async () => ({
      activeEpochId: "dqb8eamems9yi2e", activeEpochStartsAtSeq: 133, events,
    }),
    listEpochs: async () => ({epochs: [
      {id: "qjw1tu1jfnm1wsp", ordinal: 1, startsAtSeq: 1, status: "closed"},
      {id: "dqb8eamems9yi2e", ordinal: 2, startsAtSeq: 133, status: "active"},
    ]}),
    acknowledge: async (_state, seq) => {
      acknowledgements.push(seq);
      if (seq === 134) controller.abort();
      return {acknowledgedSeq: seq};
    },
    roomPolicy: async () => { throw new Error("room policy must not be read"); },
    startDiscussionCycle: async () => { throw new Error("cycle must not start"); },
    claimDiscussionAttempt: async () => { throw new Error("attempt must not be claimed"); },
    postMessage: async () => { throw new Error("message must not post"); },
    acknowledgePeerContribution: async () => { throw new Error("peer ack must not run"); },
  };
  runtime.maintainPresence = async () => {};
  runtime.recoverPostedEvidence = async () => false;
  runtime.recoverPendingDelivery = async () => false;
  runtime.markContextAcknowledged = async () => { throw new Error("activity acknowledgement must not run"); };
  runtime.publishActivity = async () => { throw new Error("activity must not publish"); };
  const evidence = [];
  const supersedeHistoricalEvent = runtime.supersedeHistoricalEvent.bind(runtime);
  runtime.supersedeHistoricalEvent = async (event, epochId) => {
    evidence.push([event.seq, "superseded", "historical_epoch"]);
    return supersedeHistoricalEvent(event, epochId);
  };
  const recordTerminalEvidence = runtime.recordTerminalEvidence.bind(runtime);
  runtime.recordTerminalEvidence = async (event, status, options) => {
    evidence.push([event.seq, status, options.reason]);
    return recordTerminalEvidence(event, status, options);
  };

  const result = await runtime.assignedTurns(controller.signal).next();
  assert.equal(result.done, true);
  assert.deepEqual(acknowledgements, [132, 133, 134]);
  assert.deepEqual(evidence, [
    [132, "superseded", "historical_epoch"],
    [133, "ignored", "discussion_start_not_a_trigger"], // contract L1-16
    [134, "ignored", "prior_epoch_lifecycle"],
  ]);
  assert.equal(runtime.state.cursor, 134);
  assert.deepEqual(runtime.state.terminalEvidence, {});
  assert.deepEqual(runtime.state.deliveryIntents, {});
});

function attachEpochTransitionFixture(runtime, events, counters, acknowledge, signalController = null) {
  runtime.connectorSession = {sessionId: "fixture-session"};
  runtime.client = {
    readEvents: async () => {
      if (signalController?.abortOnRead) signalController.controller.abort();
      return {
        activeEpochId: "circlnbi28xnwc0",
        activeEpochStartsAtSeq: 838,
        events,
      };
    },
    listEpochs: async () => ({epochs: [
      {id: "ssftrri7y8uioxl", ordinal: 11, status: "closed"},
      {id: "circlnbi28xnwc0", ordinal: 12, startsAtSeq: 838, status: "active"},
    ]}),
    acknowledge,
    roomPolicy: async () => { counters.coordination += 1; throw new Error("room policy must not be read"); },
    roomState: async () => { counters.coordination += 1; throw new Error("room state must not be read"); },
    startDiscussionCycle: async () => { counters.turn += 1; throw new Error("cycle must not start"); },
    claimDiscussionAttempt: async () => { counters.claim += 1; throw new Error("attempt must not be claimed"); },
    postMessage: async () => { counters.post += 1; throw new Error("message must not post"); },
    acknowledgePeerContribution: async () => { counters.turn += 1; throw new Error("peer acknowledgement must not run"); },
    publishActivity: async () => { counters.activity += 1; throw new Error("activity must not publish"); },
  };
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => { counters.activity += 1; throw new Error("activity acknowledgement must not run"); };
  runtime.publishActivityFrame = async () => { counters.activity += 1; throw new Error("activity frame must not publish"); };
  runtime.prepareCycleAttempt = async () => { counters.turn += 1; throw new Error("turn preparation must not run"); };
  runtime.sharedRoomContext = async () => { counters.model += 1; throw new Error("model context must not be built"); };
  runtime.recordSkipped = async () => { counters.fallback += 1; throw new Error("fallback must not terminalize"); };
  runtime.postAndFinish = async () => { counters.post += 1; throw new Error("output must not post"); };
}

function zeroEpochTransitionSideEffects() {
  return {model: 0, post: 0, fallback: 0, claim: 0, turn: 0, activity: 0, coordination: 0};
}

test("redacted production-state projection proves seq839 durably before ack and continues after restart", async () => {
  const fixture = await loadJoinedCodingProductionProjection();
  const events = await Promise.all([838, 839, 840].map(loadJoinedCodingEpochFixture));
  assert.deepEqual(events.map((event) => event.seq), [838, 839, 840]);
  assert.deepEqual([
    events[1].actorRole,
    events[1].payload.state,
    events[1].payload.reason,
  ], fixture.expected.terminalTuple);
  assert.equal(events[1].payload.cycleId, fixture.expected.terminalCycleId);
  assert.equal(events[1].payload.epochId, fixture.epochCatalog.epochs[0].id);
  assert.equal(events[0].payload.epoch.id, fixture.page.activeEpochId);
  assert.equal(events[0].payload.epoch.startsAtSeq, fixture.page.activeEpochStartsAtSeq);

  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-production-projection-"));
  const stateFile = join(directory, "state.json");
  await saveState(stateFile, {
    ...fixture.state,
    baseUrl: "https://fixture.invalid/api",
    credential: "fixture-only",
    clientInstanceId: "fixture-only",
    messagePayloadDialect: "v2",
    deliveryIntents: {},
    terminalEvidence: {},
  });
  const loaded = await loadState(stateFile);
  assert.equal(loaded.legacySessionEpochId, "xzkyspqr18fh5bs", "fixture must retain the real mismatched legacy routing epoch");

  const firstCounters = zeroEpochTransitionSideEffects();
  const firstTrace = [];
  const first = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  first.state = loaded;
  attachEpochTransitionFixture(first, events.slice(1), firstCounters, async (_state, seq) => {
    firstTrace.push(["acknowledge", seq]);
    if (seq === fixture.expected.terminalSeq) throw new Error("fixture interruption after durable terminal evidence");
    return {acknowledgedSeq: seq};
  });
  first.client.listEpochs = async () => {
    firstTrace.push(["listEpochs"]);
    return structuredClone(fixture.epochCatalog);
  };
  await assert.rejects(first.assignedTurns(new AbortController().signal).next(), /fixture interruption after durable terminal evidence/);
  assert.deepEqual(firstTrace, [["listEpochs"], ["acknowledge", 839]]);
  assert.deepEqual(firstCounters, zeroEpochTransitionSideEffects());

  const interrupted = await loadState(stateFile);
  assert.equal(interrupted.cursor, 838);
  assert.equal(interrupted.legacySessionEpochId, "xzkyspqr18fh5bs");
  assert.deepEqual(interrupted.terminalEvidence["839"], {
    status: "ignored", sourceEventId: fixture.expected.terminalEventId, sourceSeq: 839,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: fixture.expected.terminalReason,
  });

  const restartCounters = zeroEpochTransitionSideEffects();
  const restartTrace = [];
  const restartController = new AbortController();
  const restarted = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  restarted.state = interrupted;
  attachEpochTransitionFixture(restarted, events.slice(1), restartCounters, async (_state, seq) => {
    restartTrace.push(["acknowledge", seq]);
    if (seq === fixture.expected.continuationSeq) restartController.abort();
    return {acknowledgedSeq: seq};
  });
  restarted.client.listEpochs = async () => {
    restartTrace.push(["listEpochs"]);
    return structuredClone(fixture.epochCatalog);
  };
  const result = await restarted.assignedTurns(restartController.signal).next();
  assert.equal(result.done, true);
  assert.deepEqual(restartTrace, [["listEpochs"], ["acknowledge", 839], ["acknowledge", 840]]);
  assert.deepEqual(restartCounters, zeroEpochTransitionSideEffects());

  const complete = await loadState(stateFile);
  assert.equal(complete.cursor, 840);
  assert.equal(complete.legacySessionEpochId, "xzkyspqr18fh5bs");
  assert.deepEqual(complete.terminalEvidence, {});
  assert.deepEqual(complete.deliveryIntents, {});
});

test("fixture 838-840 durably ignores the reviewed prior-epoch terminal and continues after restart", async () => {
  const events = await Promise.all([838, 839, 840].map(loadJoinedCodingEpochFixture));
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-joined-coding-epoch-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "bjqiu9u7dwqptlq",
    membershipId: "1iy2lgr5uyg7cj4", credential: "fixture-only", clientInstanceId: "client-fixture",
    cursor: 837, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "ssftrri7y8uioxl",
  });

  const firstCounters = zeroEpochTransitionSideEffects();
  const firstAcks = [];
  const first = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://room.example/api"});
  first.state = await loadState(stateFile);
  attachEpochTransitionFixture(first, events, firstCounters, async (_state, seq) => {
    firstAcks.push(seq);
    if (seq === 839) throw new Error("fixture interruption after durable terminal evidence");
    return {acknowledgedSeq: seq};
  });
  await assert.rejects(first.assignedTurns(new AbortController().signal).next(), /fixture interruption/);
  assert.deepEqual(firstAcks, [838, 839]);
  assert.deepEqual(firstCounters, zeroEpochTransitionSideEffects());

  const interrupted = await loadState(stateFile);
  assert.equal(interrupted.cursor, 838);
  assert.deepEqual(interrupted.terminalEvidence["839"], {
    status: "ignored", sourceEventId: "5k207wbhmkomklv", sourceSeq: 839,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "prior_epoch_lifecycle",
  });
  assert.deepEqual(interrupted.deliveryIntents, {});

  const restartCounters = zeroEpochTransitionSideEffects();
  const restartAcks = [];
  const restartController = new AbortController();
  const restarted = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://room.example/api"});
  restarted.state = await loadState(stateFile);
  attachEpochTransitionFixture(restarted, events, restartCounters, async (_state, seq) => {
    restartAcks.push(seq);
    if (seq === 840) restartController.abort();
    return {acknowledgedSeq: seq};
  });
  const restartResult = await restarted.assignedTurns(restartController.signal).next();
  assert.equal(restartResult.done, true, "no event may cross the model boundary");
  assert.deepEqual(restartAcks, [839, 840], "restart must reuse 839 evidence and continue to the next event");
  assert.deepEqual(restartCounters, zeroEpochTransitionSideEffects());

  const complete = await loadState(stateFile);
  assert.equal(complete.cursor, 840);
  assert.deepEqual(complete.terminalEvidence, {});
  assert.deepEqual(complete.deliveryIntents, {});

  const replayCounters = zeroEpochTransitionSideEffects();
  const replayAcks = [];
  const replayController = new AbortController();
  const replayed = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://room.example/api"});
  replayed.state = await loadState(stateFile);
  attachEpochTransitionFixture(
    replayed,
    events,
    replayCounters,
    async (_state, seq) => { replayAcks.push(seq); return {acknowledgedSeq: seq}; },
    {controller: replayController, abortOnRead: true},
  );
  const replayResult = await replayed.assignedTurns(replayController.signal).next();
  assert.equal(replayResult.done, true);
  assert.deepEqual(replayAcks, []);
  assert.deepEqual(replayCounters, zeroEpochTransitionSideEffects());
  assert.deepEqual(await loadState(stateFile), complete, "duplicate replay must not rewrite durable state");
});

test("old-epoch conversational, malformed, contradictory, and unknown events remain rejected without side effects", async () => {
  const terminal = await loadJoinedCodingEpochFixture(839);
  const rejected = [
    ["conversational message", {...terminal, type: "message.posted", payload: {body: "stale", epochId: "ssftrri7y8uioxl"}}],
    ["attempt-ready", {...terminal, type: "discussion.cycle_attempt_ready"}],
    ["terminal without cycle", {...terminal, payload: {...terminal.payload, cycleId: ""}}],
    ["unknown reason", {...terminal, payload: {...terminal.payload, reason: "arbitrary_reason"}}],
    ["unknown actor role", {...terminal, actorRole: "room_master"}],
    ["system terminal from non-coordinator", {...terminal, actorId: "not-the-coordinator"}],
    ["system terminal without canonical refs", {...terminal, refs: []}],
    ["system terminal with invalid generation", {...terminal, payload: {...terminal.payload, generation: 0}}],
    ["malformed epoch", {...terminal, payload: {...terminal.payload, epochId: 7}}],
    ["contradictory epoch", {...terminal, payload: {...terminal.payload, summaryHandoff: {epochId: "circlnbi28xnwc0"}}}],
  ];

  for (const [label, event] of rejected) {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-room-old-epoch-reject-"));
    const stateFile = join(directory, "default.json");
    await saveState(stateFile, {
      version: 1, baseUrl: "https://room.example/api", roomId: "bjqiu9u7dwqptlq",
      membershipId: "1iy2lgr5uyg7cj4", credential: "fixture-only", clientInstanceId: "client-fixture",
      cursor: 838, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
      epochSessionRoutingInitialized: true, legacySessionEpochId: "ssftrri7y8uioxl",
    });
    const before = await readFile(stateFile);
    const counters = zeroEpochTransitionSideEffects();
    const acknowledgements = [];
    const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://room.example/api"});
    runtime.state = await loadState(stateFile);
    attachEpochTransitionFixture(runtime, [event], counters, async (_state, seq) => {
      acknowledgements.push(seq);
      return {acknowledgedSeq: seq};
    });
    await assert.rejects(runtime.assignedTurns(new AbortController().signal).next(), /epoch|contradict/i, label);
    assert.deepEqual(acknowledgements, [], label);
    assert.deepEqual(counters, zeroEpochTransitionSideEffects(), label);
    assert.deepEqual(await readFile(stateFile), before, label);
  }
});

async function assertRejectedEpochFixture(fixture) {
  const event = await loadJoinedCodingEpochFixture(fixture);
  const directory = await mkdtemp(join(tmpdir(), `openclaw-room-${fixture}-reject-`));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "bjqiu9u7dwqptlq",
    membershipId: "1iy2lgr5uyg7cj4", credential: "fixture-only", clientInstanceId: "client-fixture",
    cursor: 838, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "ssftrri7y8uioxl",
  });
  const beforeBytes = await readFile(stateFile);
  const counters = zeroEpochTransitionSideEffects();
  const acknowledgements = [];
  const controller = new AbortController();
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = await loadState(stateFile);
  const beforeState = structuredClone(runtime.state);
  attachEpochTransitionFixture(runtime, [event], counters, async (_state, seq) => {
    acknowledgements.push(seq);
    controller.abort();
    return {acknowledgedSeq: seq};
  });

  await assert.rejects(
    runtime.assignedTurns(controller.signal).next(),
    /epoch|prior/i,
    fixture,
  );
  assert.deepEqual(acknowledgements, [], fixture);
  assert.deepEqual(counters, zeroEpochTransitionSideEffects(), fixture);
  assert.deepEqual(runtime.state, beforeState, `${fixture}: in-memory state must not change`);
  assert.deepEqual(await readFile(stateFile), beforeBytes, `${fixture}: durable state must not change`);
  assert.deepEqual(runtime.state.terminalEvidence, {}, fixture);
  assert.deepEqual(runtime.state.deliveryIntents, {}, fixture);
  assert.equal(runtime.state.cursor, 838, fixture);
}

test("839.future-epoch lifecycle terminal fails before evidence acknowledgement or state change", async () => {
  await assertRejectedEpochFixture("839.future-epoch");
});

test("older-than-immediate-prior lifecycle terminal fails before evidence acknowledgement or state change", async () => {
  const terminal = await loadJoinedCodingEpochFixture(839);
  const event = structuredClone(terminal);
  event.id = "older-epoch-negative";
  event.payload.epochId = "older-epoch";
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-older-epoch-reject-"));
  const stateFile = join(directory, "state.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://fixture.invalid/api", roomId: "bjqiu9u7dwqptlq",
    membershipId: "1iy2lgr5uyg7cj4", credential: "fixture-only", clientInstanceId: "fixture-only",
    cursor: 838, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "older-epoch",
  });
  const before = await readFile(stateFile);
  const counters = zeroEpochTransitionSideEffects();
  const acknowledgements = [];
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  runtime.state = await loadState(stateFile);
  attachEpochTransitionFixture(runtime, [event], counters, async (_state, seq) => {
    acknowledgements.push(seq);
    return {acknowledgedSeq: seq};
  });
  runtime.client.listEpochs = async () => ({epochs: [
    {id: "older-epoch", ordinal: 10, status: "closed"},
    {id: "ssftrri7y8uioxl", ordinal: 11, status: "closed"},
    {id: "circlnbi28xnwc0", ordinal: 12, startsAtSeq: 838, status: "active"},
  ]});

  await assert.rejects(runtime.assignedTurns(new AbortController().signal).next(), {
    message: "Room event epoch evidence contradicts the authoritative active epoch boundary",
  });
  assert.deepEqual(acknowledgements, []);
  assert.deepEqual(counters, zeroEpochTransitionSideEffects());
  assert.deepEqual(await readFile(stateFile), before);
});

test("839.empty-epoch lifecycle terminal fails before evidence acknowledgement or state change", async () => {
  await assertRejectedEpochFixture("839.empty-epoch");
});

test("contradictory fixture terminal fails before evidence or acknowledgement", async () => {
  const events = await Promise.all([132, 133, 134].map(loadZurieFixture));
  events[2] = structuredClone(events[2]);
  events[2].payload.summaryHandoff.epochId = "dqb8eamems9yi2e";
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-zurie-contradiction-"));
  const stateFile = join(directory, "default.json");
  const runtime = new OpenClawRoomRuntime({accountId: "test", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "bczi4bui9f7q159",
    membershipId: "nnrafww8dv4g7a6", credential: "redacted", clientInstanceId: "client-1",
    cursor: 131, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "qjw1tu1jfnm1wsp",
  };
  await saveState(stateFile, runtime.state);
  runtime.connectorSession = {sessionId: "session-1"};
  const acknowledgements = [];
  runtime.client = {
    readEvents: async () => ({
      activeEpochId: "dqb8eamems9yi2e", activeEpochStartsAtSeq: 133, events,
    }),
    acknowledge: async (_state, seq) => {
      acknowledgements.push(seq);
      return {acknowledgedSeq: seq};
    },
    roomPolicy: async () => { throw new Error("room policy must not be read"); },
    startDiscussionCycle: async () => { throw new Error("cycle must not start"); },
    claimDiscussionAttempt: async () => { throw new Error("attempt must not be claimed"); },
    postMessage: async () => { throw new Error("message must not post"); },
    acknowledgePeerContribution: async () => { throw new Error("peer ack must not run"); },
  };
  runtime.maintainPresence = async () => {};
  runtime.recoverPostedEvidence = async () => false;
  runtime.recoverPendingDelivery = async () => false;
  runtime.markContextAcknowledged = async () => { throw new Error("activity acknowledgement must not run"); };
  runtime.publishActivity = async () => { throw new Error("activity must not publish"); };

  await assert.rejects(runtime.assignedTurns(new AbortController().signal).next(), {
    message: "Room event contains contradictory epoch evidence",
  });
  assert.deepEqual(acknowledgements, [132, 133]);
  assert.equal(runtime.state.cursor, 133);
  assert.equal(runtime.state.terminalEvidence["134"], undefined);
  assert.deepEqual(runtime.state.deliveryIntents, {});
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

test("shared context resolves the exact attached document version as untrusted evidence", async () => {
  const runtime = deliveryLifecycleRuntime();
  const source = {
    id: "human-10", seq: 10, type: "message.posted", actorRole: "human_owner",
    payload: {body: "Read this", attachments: [{
      artifactId: "artifact-1", versionId: "version-1", name: "开幕式日程.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: "a".repeat(64),
    }]},
  };
  const ready = {
    id: "ready-12", seq: 12, type: "discussion.cycle_attempt_ready",
    payload: {sourceEventId: "human-10"},
  };
  const calls = [];
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 12, activeEpoch: {id: "epoch-1", startsAtSeq: 1}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [source, ready]}),
    listArtifacts: async () => ({items: []}),
    getArtifact: async (_session, artifactId) => {
      calls.push(artifactId);
      return {
        currentVersion: {versionId: "version-2", extractionStatus: "ready", extractedText: "wrong"},
        versions: [
          {versionId: "version-2", extractionStatus: "ready", extractedText: "wrong"},
          {versionId: "version-1", extractionStatus: "ready", extractedText: "09:00 开幕式\n09:30 Keynote"},
        ],
      };
    },
  };
  const rendered = await runtime.sharedRoomContext(ready, {id: "epoch-1", startsAtSeq: 1});
  assert.deepEqual(calls, ["artifact-1"]);
  assert.match(rendered, /untrusted uploaded content/);
  assert.match(rendered, /09:00 开幕式/);
  assert.doesNotMatch(rendered, /wrong/);
});

test("a later message receives the Room document library as a catalog without document text", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 20, activeEpoch: {id: "epoch-1", startsAtSeq: 1}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: []}),
    listArtifacts: async () => ({items: [{
      artifactId: "artifact-1", visibility: "room_shared", title: "Agenda",
      currentVersion: {versionId: "version-1", name: "agenda.docx", sha256: "b".repeat(64), extractionStatus: "ready", extractedText: "Collective agenda text"},
    }, {
      artifactId: "artifact-private", visibility: "private", title: "Hidden",
      currentVersion: {versionId: "version-p", name: "hidden.pdf", extractedText: "secret"},
    }]}),
    getArtifact: async () => { throw new Error("catalog listing must not fetch any artifact"); },
  };
  const rendered = await runtime.sharedRoomContext(
    {id: "later-20", seq: 20, type: "message.posted", payload: {body: "Read the document"}},
    {id: "epoch-1", startsAtSeq: 1},
  );
  assert.match(rendered, /catalog only/);
  assert.match(rendered, /agenda\.docx/);
  assert.match(rendered, /artifact-1 \/ version-1/);
  assert.match(rendered, new RegExp("b".repeat(64)));
  assert.doesNotMatch(rendered, /Collective agenda text/);
  assert.doesNotMatch(rendered, /hidden\.pdf|secret/);
});

test("a pending library version is listed as pending without a backfill read", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 21, activeEpoch: {id: "epoch-1", startsAtSeq: 1}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: []}),
    listArtifacts: async () => ({items: [{
      artifactId: "artifact-1", visibility: "room_shared", title: "Agenda",
      currentVersion: {versionId: "version-1", name: "agenda.docx", extractionStatus: "pending", extractedText: ""},
    }]}),
    getArtifact: async () => { throw new Error("catalog listing must not read pending versions"); },
  };
  const rendered = await runtime.sharedRoomContext(
    {id: "later-21", seq: 21, type: "message.posted", payload: {body: "Read the document"}},
    {id: "epoch-1", startsAtSeq: 1},
  );
  assert.match(rendered, /extraction pending/);
});

test("a bound attachment keeps its exact full text while the rest of the library stays a catalog", async () => {
  const runtime = deliveryLifecycleRuntime();
  const source = {
    id: "human-30", seq: 30, type: "message.posted", actorRole: "human_owner",
    payload: {body: "Read this", attachments: [{artifactId: "artifact-1", versionId: "version-1", name: "bound.pdf", mediaType: "application/pdf", sha256: "d".repeat(64)}]},
  };
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 30, activeEpoch: {id: "epoch-1", startsAtSeq: 1}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [source]}),
    listArtifacts: async () => ({items: [
      {artifactId: "artifact-1", visibility: "room_shared", title: "Bound", currentVersion: {versionId: "version-1", name: "bound.pdf", extractionStatus: "ready", extractedText: "IGNORED"}},
      {artifactId: "artifact-2", visibility: "room_shared", title: "Other", currentVersion: {versionId: "version-9", name: "other.pdf", extractionStatus: "ready", extractedText: "Other full text"}},
    ]}),
    getArtifact: async () => ({currentVersion: {versionId: "version-1", extractionStatus: "ready", extractedText: "Exact bound text"}}),
  };
  const rendered = await runtime.sharedRoomContext(source, {id: "epoch-1", startsAtSeq: 1});
  assert.match(rendered, /Exact bound text/);
  assert.match(rendered, /other\.pdf/);
  assert.doesNotMatch(rendered, /Other full text/);
  assert.doesNotMatch(rendered, /- bound\.pdf/);
});

test("B13: library growth and wave count do not grow the OpenClaw document context", async () => {
  const documents = [0, 1].map((index) => ({
    artifactId: `artifact-${index}`, visibility: "room_shared", title: `Doc ${index}`,
    currentVersion: {versionId: `v${index}`, name: `doc-${index}.pdf`, mediaType: "application/pdf", sha256: String.fromCharCode(97 + index).repeat(64), extractionStatus: "ready", extractedText: "Lorem ipsum ".repeat(2_050).slice(0, 22_500)},
  }));
  const before = Math.min(ARTIFACT_CONTEXT_CHARACTER_LIMIT, documents.reduce((sum, d) => sum + d.currentVersion.extractedText.length, 0));
  const sizes = [];
  for (let wave = 0; wave < 12; wave += 1) {
    const rendered = await sourceArtifactContext({id: `wave-${wave}`, type: "message.posted", payload: {body: `Question ${wave}`}}, [], async () => { throw new Error("no fetch"); }, documents);
    sizes.push(rendered.length);
    assert.doesNotMatch(rendered, /Lorem ipsum/);
  }
  assert.equal(new Set(sizes).size, 1, JSON.stringify(sizes));
  assert.ok(sizes[0] < 1_000);
  assert.ok(before > 40_000);
  console.log(`B13 measurement (OpenClaw document context per wave): before=${before} chars, after=${sizes[0]} chars, waves=12`);
});

const HANDOVER_START = {
  id: "start-2", seq: 41, type: "discussion.started", actorRole: "human_owner", actorId: "owner-1",
  payload: {
    epoch: {id: "epoch-2", ordinal: 2, startsAtSeq: 41, topic: {title: "Continue the work"}, status: "active"},
    handover: {
      sourceEpochId: "epoch-1", sourceEpochOrdinal: 1, coveredThroughSeq: 40, revision: 1, reviewStatus: "human_reviewed",
      digest: "f".repeat(64), submittedByMembershipId: "owner-1",
      sections: {goal: "Keep decisions, drop the accumulated history.", decisions: [{statement: "Fresh session per discussion.", rationale: "Prompts grew to 59k characters."}], openQuestions: ["Which runtime hook reports usage?"]},
      sourceRefs: [{kind: "event", eventId: "evt-40", seq: 40, note: "decision message"}],
    },
  },
};

test("discussionHandoverContext renders bounded sections and sources, nothing without a handover", () => {
  const rendered = discussionHandoverContext(HANDOVER_START);
  for (const expected of ["Reviewed handover from discussion #1", "covered through canonical seq 40", "Goal: Keep decisions", "- Fresh session per discussion. — because Prompts grew to 59k characters.", "Open questions:", "event evt-40 (seq 40) — decision message", "Derived summary, not a source"]) {
    assert.ok(rendered.includes(expected), expected);
  }
  assert.equal(discussionHandoverContext({payload: {epoch: {}}}), "");
  assert.equal(discussionHandoverContext(undefined), "");
  const huge = structuredClone(HANDOVER_START);
  huge.payload.handover.sections.results = Array.from({length: 10}, () => "x".repeat(2_000));
  assert.ok(discussionHandoverContext(huge).length <= HANDOVER_CONTEXT_CHARACTER_LIMIT);
});

test("B34: the new discussion's model context carries the handover, a library catalog and a fresh conversation id", async () => {
  const runtime = deliveryLifecycleRuntime();
  runtime.state.epochSessionRoutingInitialized = true;
  runtime.state.legacySessionEpochId = "epoch-1";
  const reads = [];
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 41, activeEpoch: {id: "epoch-2", startsAtSeq: 41}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async (_session, after) => { reads.push(after); return {activeEpochId: "epoch-2", activeEpochStartsAtSeq: 41, events: [HANDOVER_START]}; },
    listArtifacts: async () => ({items: [{artifactId: "artifact-1", visibility: "room_shared", title: "Kabeltracker", currentVersion: {versionId: "v1", name: "kabeltracker.pdf", extractionStatus: "ready", extractedText: "LIBRARY FULL TEXT ".repeat(2_000)}}]}),
    getArtifact: async () => { throw new Error("catalog listing must not fetch artifacts"); },
  };
  const infoLines = [];
  runtime.logger = {info: (line) => infoLines.push(line)};
  const rendered = await runtime.sharedRoomContext(HANDOVER_START, {id: "epoch-2", startsAtSeq: 41});
  assert.equal(infoLines.filter((line) => line.includes("context sizes")).length, 1, infoLines);
  assert.match(infoLines[0], new RegExp(`total=${rendered.length}$`));
  assert.doesNotMatch(infoLines[0], /Keep decisions|LIBRARY FULL TEXT/);
  assert.match(rendered, /Reviewed handover from discussion #1/);
  assert.match(rendered, /kabeltracker\.pdf/);
  assert.doesNotMatch(rendered, /LIBRARY FULL TEXT/);
  assert.equal(reads.length, 1, "the start event is in the loaded page; no extra read");
  const normalized = normalizeEvent(HANDOVER_START, "room-1", null, rendered, "epoch-2", "epoch-1");
  assert.equal(normalized.conversationId, epochConversationId("room-1", "epoch-2"));
  assert.notEqual(normalized.conversationId, "room-1");
  assert.match(normalized.text, /synthetic_sociality_room_history/);
  assert.ok(normalized.text.length < 8_000, String(normalized.text.length));
  console.log(`B34 measurement (OpenClaw first prompt of new discussion incl. handover): ${normalized.text.length} chars; library text present: ${normalized.text.includes("LIBRARY FULL TEXT")}`);
  // A later turn far past the epoch start reuses the cached handover without re-reading it.
  const later = {id: "m-99", seq: 99, type: "message.posted", actorRole: "human_owner", payload: {body: "What did we decide?"}};
  runtime.client.roomState = async () => ({title: "OpenClaw", headSeq: 99, activeEpoch: {id: "epoch-2", startsAtSeq: 41}});
  runtime.client.readEvents = async (_session, after) => { reads.push(after); return {activeEpochId: "epoch-2", activeEpochStartsAtSeq: 41, events: [later]}; };
  const againRendered = await runtime.sharedRoomContext(later, {id: "epoch-2", startsAtSeq: 41});
  assert.match(againRendered, /Reviewed handover from discussion #1/);
  assert.deepEqual(reads, [40, 49]);
});

test("a later turn fetches the epoch start event once when it lies outside the transcript window", async () => {
  const runtime = deliveryLifecycleRuntime();
  const reads = [];
  const later = {id: "m-99", seq: 99, type: "message.posted", actorRole: "human_owner", payload: {body: "Later"}};
  runtime.client = {
    roomState: async () => ({title: "OpenClaw", headSeq: 99, activeEpoch: {id: "epoch-2", startsAtSeq: 41}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    readEvents: async (_session, after) => { reads.push(after); return {activeEpochId: "epoch-2", activeEpochStartsAtSeq: 41, events: after === 40 ? [HANDOVER_START] : [later]}; },
    listArtifacts: async () => ({items: []}),
  };
  const first = await runtime.sharedRoomContext(later, {id: "epoch-2", startsAtSeq: 41});
  const second = await runtime.sharedRoomContext(later, {id: "epoch-2", startsAtSeq: 41});
  assert.match(first, /Reviewed handover/);
  assert.match(second, /Reviewed handover/);
  assert.deepEqual(reads, [49, 40, 49]);
});

// ADR 0089: open Rooms give agents equal access without a server-chosen order.
test("open-room human and general agent posts reply directly without a cycle", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "reader-member"};
  const starts = [];
  runtime.client = {
    roomPolicy: async () => ({policy: {coordinationMode: "open", agentFollowUpEnabled: true}}),
    startDiscussionCycle: async (_state, request) => { starts.push(request); return {id: "unexpected"}; },
  };
  assert.equal(await runtime.prepareCycleAttempt({
    id: "human-open", type: "message.posted", actorId: "human-1", actorRole: "human_owner", payload: {body: "Debate this"},
  }), null);
  const general = {id: "agent-general", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
    payload: {body: "My view for everyone", resolvedRecipientMembershipIds: [], recipientSelectors: []}};
  assert.equal(isAssignedEvent(general, "reader-member"), true);
  assert.equal(isAssignedEvent(general, "author-member"), false);
  assert.equal(await runtime.prepareCycleAttempt(general), null);
  const addressedElsewhere = {...general, id: "agent-other", payload: {body: "Other?", resolvedRecipientMembershipIds: ["other-member"]}};
  assert.equal(isAssignedEvent(addressedElsewhere, "reader-member"), false);
  const cycleBound = {...general, id: "agent-cycle", payload: {body: "bounded", cycleId: "cycle-1", resolvedRecipientMembershipIds: []}};
  assert.equal(isAssignedEvent(cycleBound, "reader-member"), false);
  assert.equal(starts.length, 0);
});

test("coordinated rooms and disabled peer replies keep agent posts from starting replies", async () => {
  for (const policy of [{coordinationMode: "coordinated", agentFollowUpEnabled: true}, {coordinationMode: "open", agentFollowUpEnabled: false}]) {
    const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
    runtime.state = {roomId: "room-1", membershipId: "reader-member"};
    runtime.client = {
      roomPolicy: async () => ({policy}),
      startDiscussionCycle: async () => { throw new Error("must not start a cycle"); },
    };
    assert.equal(await runtime.prepareCycleAttempt({
      id: "agent-general", type: "message.posted", actorId: "author-member", actorRole: "participant_agent",
      payload: {body: "My view", resolvedRecipientMembershipIds: []},
    }), false);
  }
});

const fullFixtureState = (state) => ({version: 1, baseUrl: "https://room.example/api", credential: "fixture-only", ...state});

test("reply cap refusal is a terminal skipped delivery, never quarantined or reposted", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "reader-member", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0};
  runtime.persistState = async () => {};
  let posts = 0;
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 7, roster: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => { posts += 1; throw new RoomAPIError(409, {code: "reply_cap_reached", retryable: false}); },
  };
  const request = {roomId: "room-1", text: "One more reply", replyToId: "src-1", idempotencyKey: "src-1:final", sourceEventId: "src-1"};
  // Production binds the source before any sourced post (live turn or recovery).
  runtime.pendingEvent = {id: "src-1", seq: 1};
  assert.deepEqual(await runtime.postAndFinishOnce(request), {skipped: true, reason: "reply_cap_reached"});
  const intent = runtime.state.deliveryIntents["src-1:final"];
  assert.equal(intent.deliveryState, "skipped");
  assert.notEqual(intent.status, "quarantined");
  assert.deepEqual(await runtime.postAndFinishOnce(request), {skipped: true, reason: "reply_cap_reached"});
  assert.equal(posts, 1);
  validateState(fullFixtureState(runtime.state));

  // A sourced skip without its bound source fails closed and stays pending.
  const unboundRuntime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  unboundRuntime.state = {roomId: "room-1", membershipId: "reader-member", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0};
  unboundRuntime.persistState = async () => {};
  unboundRuntime.client = runtime.client;
  await assert.rejects(unboundRuntime.postAndFinishOnce(request), /Terminal Room refusal skip requires the bound pending source event/);
  assert.equal(unboundRuntime.state.deliveryIntents["src-1:final"].status, "delivery_pending");
});

test("outbound reply cap refusal persists a skip without source evidence", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "reader-member", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0};
  let saves = 0;
  runtime.persistState = async () => { saves += 1; validateState(fullFixtureState(runtime.state)); };
  let posts = 0;
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 7, roster: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => { posts += 1; throw new RoomAPIError(409, {code: "reply_cap_reached", retryable: false}); },
  };
  const request = {roomId: "room-1", text: "Outbound note", idempotencyKey: "outbound-1"};
  assert.deepEqual(await runtime.postAndFinishOnce(request), {skipped: true, reason: "reply_cap_reached"});
  const intent = runtime.state.deliveryIntents["outbound-1"];
  assert.equal(intent.status, "skipped");
  assert.equal(intent.skippedSourceSeq, undefined);
  assert.deepEqual(runtime.state.terminalEvidence ?? {}, {});
  assert.ok(saves > 0);
  assert.deepEqual(await runtime.postAndFinishOnce(request), {skipped: true, reason: "reply_cap_reached"});
  assert.equal(posts, 1);
});

test("the Room client preserves the reply cap refusal code", () => {
  const error = new RoomAPIError(409, {code: "reply_cap_reached", retryable: false});
  assert.equal(error.code, "reply_cap_reached");
  assert.equal(error.retryable, false);
});

// ADR 0089: a human "summarize now" still uses one coordinator cycle in an open Room.
test("open-room summarize starts one coordinator cycle", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "member-1"};
  const starts = [];
  runtime.client = {
    roomPolicy: async () => ({policy: {coordinationMode: "open", summaryCoordinatorMembershipId: "member-1"}}),
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, roster: ["member-1", "member-2"].map(membershipId => ({
      membershipId, displayName: membershipId, status: "active", role: "participant_agent",
    }))}),
    startDiscussionCycle: async (_state, request) => { starts.push(request); return {id: "summary-cycle"}; },
  };
  const event = {id: "summarize-1", type: "human.command", actorId: "owner", actorRole: "human_owner",
    payload: {command: {command: "summarize", idempotencyKey: "sum-1"}}};
  assert.equal(isAssignedEvent(event, "member-1"), true);
  assert.equal(await runtime.prepareCycleAttempt(event), false);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].roster.map(({membershipId}) => membershipId), ["member-1"]);
  assert.equal(starts[0].sourceEventId, "summarize-1");
});

// A duplicate delivery of the same open-mode source posts exactly once.
test("duplicate open-mode delivery reuses the canonical receipt without reposting", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0};
  runtime.persistState = async () => {};
  let posts = 0;
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 3, roster: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => {
      posts += 1;
      return {id: "canonical-1", seq: 4, ts: "2026-09-22T10:00:00Z"};
    },
  };
  const request = {roomId: "room-1", text: "One open reply", replyToId: "src-1", idempotencyKey: "src-1:final", sourceEventId: "src-1"};
  const first = await runtime.postAndFinishOnce(request);
  const second = await runtime.postAndFinishOnce(request);
  assert.equal(first.eventId, "canonical-1");
  assert.deepEqual(second, first);
  assert.equal(posts, 1);
  assert.equal(runtime.state.deliveryIntents["src-1:final"].deliveryState, "posted");
});

// A frozen open-mode post is a normal pending delivery. reply_cap_reached is a
// normal refusal. Recovery must persist that skip through the real save/load
// path, record terminal evidence, and never repost it.
async function savePendingReplyCapState(sourceId) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-reply-cap-"));
  const stateFile = join(directory, "state.json");
  const body = "redacted frozen reply";
  const messageKey = "fixture-message-key";
  const intent = {
    version: 2,
    status: "delivery_pending",
    deliveryState: "delivery_pending",
    lifecycleState: "not_started",
    messagePayloadDialect: "v1",
    logicalContributionId: "fixture-logical",
    messageIdempotencyKey: messageKey,
    requestIdempotencyKey: "fixture-request",
    finishIdempotencyKey: "fixture-finish",
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
    identity: {
      roomId: "room-1",
      body,
      coordinationMode: "open",
      cycle: null,
      sourceEventId: sourceId,
      sourceEpochId: "epoch-1",
      postObservedEpochId: "epoch-1",
      postObservedSeq: 12,
      initialObservedSeq: 12,
      initialEpochId: "epoch-1",
      replyToId: "human-1",
      topicId: "topic-1",
      nextRecipient: "",
      recipientSelectors: [],
      resolveRecipientMentions: false,
    },
    post: {
      body,
      contributionType: "claim",
      idempotencyKey: messageKey,
      observedEpochId: "epoch-1",
      observedSeq: 12,
      respondsTo: ["human-1"],
      topicId: "topic-1",
    },
  };
  await saveState(stateFile, {
    version: 1,
    baseUrl: "https://fixture.invalid/api",
    roomId: "room-1",
    membershipId: "member-1",
    credential: "fixture-only",
    clientInstanceId: "client-1",
    cursor: 10,
    messagePayloadDialect: "v1",
    deliveryIntents: {[`${sourceId}:final`]: intent},
    terminalEvidence: {},
  });
  return stateFile;
}

test("reply-cap recovery persists a skipped frozen delivery and does not repost after restart", async () => {
  const sourceId = "src-cap";
  const stateFile = await savePendingReplyCapState(sourceId);
  const event = {id: sourceId, seq: 11, type: "message.posted", actorRole: "human_owner", payload: {body: "prompt"}};
  let posts = 0;
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 12, roster: []}),
    publishActivity: async () => ({acceptedStreamSeq: 1}),
    postMessage: async () => {
      posts += 1;
      throw new RoomAPIError(409, {code: "reply_cap_reached", retryable: false});
    },
  };
  assert.equal(await runtime.recoverPendingDelivery(event, new AbortController().signal), true);
  assert.equal(posts, 1);
  const saved = await loadState(stateFile);
  const skipped = saved.deliveryIntents[`${sourceId}:final`];
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.deliveryState, "skipped");
  assert.equal(skipped.skippedReason, "reply_cap_reached");
  assert.equal(skipped.skippedSourceSeq, 11);
  assert.equal(skipped.canonicalMessage, undefined);
  assert.deepEqual(saved.terminalEvidence["11"], {
    status: "skipped",
    sourceEventId: sourceId,
    sourceSeq: 11,
    canonicalEventId: "",
    canonicalSeq: 0,
    canonicalTs: "",
    reason: "reply_cap_reached",
  });

  // Acknowledgement prunes the evidence at the cursor; the skipped intent must
  // still save and load, or recovery crashes after the server acknowledged.
  let acknowledged = 0;
  runtime.client.acknowledge = async (_state, seq) => { acknowledged += 1; return {acknowledgedSeq: seq}; };
  runtime.pendingEvent = event;
  await runtime.ackEvent(event);
  assert.equal(acknowledged, 1);
  const acked = await loadState(stateFile);
  assert.equal(acked.cursor, 11);
  assert.deepEqual(acked.terminalEvidence, {});
  assert.equal(acked.deliveryIntents[`${sourceId}:final`].status, "skipped");

  const restarted = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  restarted.state = acked;
  restarted.client = {
    publishActivity: async () => { throw new Error("restart must not publish activity"); },
    postMessage: async () => { posts += 1; throw new Error("restart must not repost"); },
    roomState: async () => { throw new Error("restart must not read room state"); },
  };
  assert.equal(await restarted.recoverPendingDelivery(event, new AbortController().signal), false);
  assert.equal(posts, 1);
  assert.throws(() => validateState({
    ...saved,
    terminalEvidence: {},
  }), /Room skipped delivery requires matching terminal evidence/);
  assert.throws(() => validateState({
    ...saved,
    deliveryIntents: {[`${sourceId}:final`]: {...skipped, skippedSourceSeq: undefined}},
  }), /Room skipped delivery requires its source sequence/);
  assert.throws(() => validateState({
    ...saved,
    terminalEvidence: {"11": {...saved.terminalEvidence["11"], sourceEventId: "other-source"}},
  }), /Room skipped delivery requires matching terminal evidence/);
  assert.throws(() => validateState({
    ...saved,
    deliveryIntents: {[`${sourceId}:final`]: {...skipped, status: "not-a-status", deliveryState: "skipped"}},
  }), /Room delivery intent status is invalid/);
});

// A frozen open-mode reply refused after the Room switched to coordinated mode
// carries no turn or cycle, so turn_required can never succeed for it. Recovery
// must end it as a terminal skip instead of retrying forever.
test("a frozen open-mode reply refused with turn_required is skipped and not reposted after restart", async () => {
  const sourceId = "src-coordinated";
  const stateFile = await savePendingReplyCapState(sourceId);
  const event = {id: sourceId, seq: 11, type: "message.posted", actorRole: "human_owner", payload: {body: "prompt"}};
  let posts = 0;
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 12, roster: []}),
    publishActivity: async () => ({acceptedStreamSeq: 1}),
    postMessage: async () => {
      posts += 1;
      throw new RoomAPIError(409, {code: "turn_required", retryable: true});
    },
  };
  assert.equal(await runtime.recoverPendingDelivery(event, new AbortController().signal), true);
  assert.equal(posts, 1);
  const saved = await loadState(stateFile);
  const skipped = saved.deliveryIntents[`${sourceId}:final`];
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.deliveryState, "skipped");
  assert.equal(skipped.skippedReason, "coordination_mode_changed");
  assert.equal(skipped.skippedSourceSeq, 11);
  assert.deepEqual(saved.terminalEvidence["11"], {
    status: "skipped",
    sourceEventId: sourceId,
    sourceSeq: 11,
    canonicalEventId: "",
    canonicalSeq: 0,
    canonicalTs: "",
    reason: "coordination_mode_changed",
  });

  let acknowledged = 0;
  runtime.client.acknowledge = async (_state, seq) => { acknowledged += 1; return {acknowledgedSeq: seq}; };
  runtime.pendingEvent = event;
  await runtime.ackEvent(event);
  assert.equal(acknowledged, 1);
  const acked = await loadState(stateFile);
  assert.equal(acked.cursor, 11);
  assert.deepEqual(acked.terminalEvidence, {});
  assert.equal(acked.deliveryIntents[`${sourceId}:final`].status, "skipped");
  assert.equal(acked.deliveryIntents[`${sourceId}:final`].skippedReason, "coordination_mode_changed");

  const restarted = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  restarted.state = acked;
  restarted.client = {
    publishActivity: async () => { throw new Error("restart must not publish activity"); },
    postMessage: async () => { posts += 1; throw new Error("restart must not repost"); },
    roomState: async () => { throw new Error("restart must not read room state"); },
  };
  assert.equal(await restarted.recoverPendingDelivery(event, new AbortController().signal), false);
  assert.equal(posts, 1);
});

// Other retryable refusals are not terminal: the frozen post stays pending.
for (const [label, body] of [
  ["a codeless retryable 409", {retryable: true}],
  ["a room_paused 409", {code: "room_paused", retryable: true}],
]) {
  test(`${label} leaves a frozen open-mode reply delivery_pending`, async () => {
    const sourceId = "src-retry";
    const stateFile = await savePendingReplyCapState(sourceId);
    const event = {id: sourceId, seq: 11, type: "message.posted", actorRole: "human_owner", payload: {body: "prompt"}};
    const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
    runtime.state = await loadState(stateFile);
    runtime.client = {
      roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 12, roster: []}),
      publishActivity: async () => ({acceptedStreamSeq: 1}),
      postMessage: async () => { throw new RoomAPIError(409, body); },
    };
    await assert.rejects(runtime.recoverPendingDelivery(event, new AbortController().signal), /Room API request failed \(status=409\)/);
    const saved = await loadState(stateFile);
    const intent = saved.deliveryIntents[`${sourceId}:final`];
    assert.equal(intent.status, "delivery_pending");
    assert.equal(intent.deliveryState, "delivery_pending");
    assert.equal(intent.skippedReason, undefined);
    assert.deepEqual(saved.terminalEvidence, {});
  });
}

// turn_required is terminal only for a turnless, cycleless post. A frozen post
// that carries a turn stays pending and the refusal is rethrown.
test("a frozen reply that carries a turn refused with turn_required stays delivery_pending", async () => {
  const sourceId = "src-turn";
  const stateFile = await savePendingReplyCapState(sourceId);
  const fixture = await loadState(stateFile);
  const frozen = fixture.deliveryIntents[`${sourceId}:final`];
  frozen.identity.coordinationMode = "coordinated";
  frozen.turnRequest = {observedSeq: 12, idempotencyKey: frozen.requestIdempotencyKey, topicId: "topic-1"};
  frozen.turn = {turnId: "turn-1"};
  frozen.post.turnId = "turn-1";
  await saveState(stateFile, fixture);
  const event = {id: sourceId, seq: 11, type: "message.posted", actorRole: "human_owner", payload: {body: "prompt"}};
  let posts = 0;
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 12, roster: []}),
    publishActivity: async () => ({acceptedStreamSeq: 1}),
    requestTurn: async () => { throw new Error("a frozen turn must not request another"); },
    postMessage: async (_state, post) => {
      posts += 1;
      assert.equal(post.turnId, "turn-1");
      throw new RoomAPIError(409, {code: "turn_required", retryable: true});
    },
  };
  await assert.rejects(
    runtime.recoverPendingDelivery(event, new AbortController().signal),
    (error) => error instanceof RoomAPIError && error.code === "turn_required",
  );
  assert.equal(posts, 1);
  const saved = await loadState(stateFile);
  const intent = saved.deliveryIntents[`${sourceId}:final`];
  assert.equal(intent.status, "delivery_pending");
  assert.equal(intent.deliveryState, "delivery_pending");
  assert.equal(intent.deliveryErrorCode, "turn_required");
  assert.equal(intent.skippedReason, undefined);
  assert.equal(intent.skippedSourceSeq, undefined);
  assert.deepEqual(intent.turn, {turnId: "turn-1"});
  assert.deepEqual(saved.terminalEvidence, {});
});

// A skip saved just before an epoch rotation whose acknowledgement did not land
// comes back as a historical source. It is already terminal: acknowledge it,
// never supersede, throw, or repost.
test("an unacknowledged reply-cap skip survives an epoch rotation and restart", async () => {
  const sourceId = "src-cap-rotated";
  const stateFile = await savePendingReplyCapState(sourceId);
  const event = {id: sourceId, seq: 11, type: "message.posted", actorRole: "human_owner", payload: {body: "prompt"}};
  let posts = 0;
  const runtime = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 12, roster: []}),
    publishActivity: async () => ({acceptedStreamSeq: 1}),
    postMessage: async () => { posts += 1; throw new RoomAPIError(409, {code: "reply_cap_reached", retryable: false}); },
    acknowledge: async () => { throw new Error("acknowledgement lost"); },
  };
  assert.equal(await runtime.recoverPendingDelivery(event, new AbortController().signal), true);
  runtime.pendingEvent = event;
  await assert.rejects(runtime.ackEvent(event), /acknowledgement lost/);

  const saved = await loadState(stateFile);
  assert.equal(saved.cursor, 10);
  assert.equal(saved.terminalEvidence["11"].status, "skipped");
  const restarted = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  restarted.state = saved;
  let acknowledged = 0;
  restarted.client = {
    postMessage: async () => { posts += 1; throw new Error("restart must not repost"); },
    acknowledge: async (_state, seq) => { acknowledged += 1; return {acknowledgedSeq: seq}; },
  };
  restarted.assertHistoricalIntentSafety(event);
  const evidence = await restarted.supersedeHistoricalEvent(event, "epoch-0");
  assert.equal(evidence.status, "skipped");
  assert.equal(restarted.state.deliveryIntents[`${sourceId}:final`].status, "skipped");
  restarted.pendingEvent = event;
  await restarted.ackEvent(event);
  assert.equal(acknowledged, 1);
  assert.equal(posts, 1);
  const acked = await loadState(stateFile);
  assert.equal(acked.cursor, 11);
  assert.equal(acked.deliveryIntents[`${sourceId}:final`].status, "skipped");

  // A skipped intent whose evidence belongs to another sequence stays refused.
  const mismatched = new OpenClawRoomRuntime({accountId: "fixture", stateFile, baseUrl: "https://fixture.invalid/api"});
  mismatched.state = structuredClone(saved);
  mismatched.state.deliveryIntents[`${sourceId}:final`].skippedSourceSeq = 99;
  await assert.rejects(
    mismatched.supersedeHistoricalEvent(event, "epoch-0"),
    /Historical Room delivery intent is not a recognized pending state/,
  );
});

// If the skip evidence cannot be written, the in-memory intent must roll back
// to its pending state so the process can still save and recover.
test("a refused reply-cap evidence write rolls the intent back to pending", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: UNUSED_STATE_FILE, baseUrl: "https://room.example/api"});
  runtime.state = {
    roomId: "room-1", membershipId: "reader-member", clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: 0,
    terminalEvidence: {"1": {
      status: "skipped", sourceEventId: "other-source", sourceSeq: 1,
      canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "model_no_visible_reply",
    }},
  };
  runtime.persistState = async () => {};
  runtime.client = {
    roomState: async () => ({activeEpoch: {id: "epoch-1"}, headSeq: 7, roster: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => { throw new RoomAPIError(409, {code: "reply_cap_reached", retryable: false}); },
  };
  runtime.pendingEvent = {id: "src-1", seq: 1};
  const request = {roomId: "room-1", text: "One more reply", replyToId: "src-1", idempotencyKey: "src-1:final", sourceEventId: "src-1"};
  await assert.rejects(runtime.postAndFinishOnce(request), /already bound to a different source event/);
  const intent = runtime.state.deliveryIntents["src-1:final"];
  assert.equal(intent.status, "delivery_pending");
  assert.equal(intent.skippedReason, undefined);
  assert.equal(intent.skippedSourceSeq, undefined);
  assert.equal(runtime.state.terminalEvidence["1"].sourceEventId, "other-source");
  validateState(fullFixtureState(runtime.state));
});
