import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {isAssignedEvent, isAssignedMessage, normalizeEvent, OpenClawRoomRuntime} from "../src/runtime.js";
import {saveState} from "../src/state.js";

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
  let connectorHeartbeats = 0;
  const activities = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/connector/sessions")) {
        registrations += 1;
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
  });
  assert.equal(normalized.sourceEventId, "ready-event-1");
  assert.equal(normalized.respondsToId, "human-message-1");
  assert.match(normalized.text, /Continue the autonomous discussion/);
});

test("human source starts one server-owned cycle and claims only this membership attempt", async () => {
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
  assert.equal(result.attempt.id, "attempt-1");
  assert.deepEqual(starts[0].roster, [
    {membershipId: "paula-member", displayName: "Paula"},
    {membershipId: "aura-member", displayName: "Aura"},
  ]);
  assert.equal(starts[0].sourceEventId, "human-event");
});
