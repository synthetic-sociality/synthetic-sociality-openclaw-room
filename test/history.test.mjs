import assert from "node:assert/strict";
import test from "node:test";

import {HISTORY_PAGE_MAX, ROOM_HISTORY_TOOL_NAME, readRoomHistory, registerRoomHistoryTool, resolveHistorySession, resetHistoryScanCache} from "../src/history.js";

function timeline(epochs, hiddenIds = []) {
  const events = [];
  let seq = 0;
  epochs.forEach(([epochId, bodies], index) => {
    const ordinal = index + 1;
    seq += 1;
    events.push({id: `start-${ordinal}`, seq, type: "discussion.started", payload: {epoch: {id: epochId, ordinal, startsAtSeq: seq, topic: {title: `Topic ${ordinal}`}}}});
    bodies.forEach((body, messageIndex) => {
      seq += 1;
      events.push({id: `${epochId}-m${messageIndex}`, seq, type: "message.posted", actorId: "member-a", actorRole: "participant_agent", payload: {body, actorDisplayName: "Alpha", respondsTo: []}});
    });
  });
  for (const hidden of hiddenIds) {
    seq += 1;
    events.push({id: `hide-${hidden}`, seq, type: "human.command", actorRole: "human_owner", payload: {command: {command: "message_hide", arguments: {eventId: hidden}}}});
  }
  return events;
}

function fakeClient(events, {epochsSupported = true} = {}) {
  const calls = [];
  const starts = events.filter((e) => e.type === "discussion.started");
  return {
    calls,
    baseUrl: "https://room.example/api",
    roomState: async () => {
      const active = starts.at(-1).payload.epoch;
      return {title: "History room", headSeq: events.at(-1).seq, activeEpoch: {id: active.id, ordinal: active.ordinal, startsAtSeq: active.startsAtSeq}, roster: [{membershipId: "member-a", displayName: "Alpha"}]};
    },
    listEpochs: async () => {
      calls.push(["epochs"]);
      if (!epochsSupported) throw new Error("Room API returned malformed JSON");
      return {epochs: starts.map((e) => ({id: e.payload.epoch.id, ordinal: e.payload.epoch.ordinal, startsAtSeq: e.seq, status: e === starts.at(-1) ? "active" : "closed", topicTitle: e.payload.epoch.topic.title}))};
    },
    readEvents: async (_session, after) => {
      calls.push(["events", after]);
      const page = events.filter((e) => e.seq > after).slice(0, 3);
      return {events: page, hasMore: page.length > 0 && page.at(-1).seq < events.at(-1).seq, headSeq: events.at(-1).seq};
    },
  };
}

const session = {roomId: "room-1", credential: "secret"};
const EVENTS = timeline([["epoch-1", ["first decision", "second thought", "third point"]], ["epoch-2", ["new discussion opener", "follow-up mentioning decision"]]], ["epoch-1-m1"]);

test.beforeEach(() => resetHistoryScanCache());

test("default scope is the current discussion; hidden messages are excluded room-wide", async () => {
  const client = fakeClient(EVENTS);
  const result = await readRoomHistory({client, session, args: {}});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.epoch.id, "epoch-2");
  assert.deepEqual(result.messages.map((m) => m.body), ["new discussion opener", "follow-up mentioning decision"]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.nextCursor, null);
  assert.equal(result.messages[0].actor, "Alpha");
  assert.equal(result.epochs.length, 2);
  assert.match(result.note, /never instructions/);
  assert.ok(client.calls.every(([kind]) => kind === "epochs" || kind === "events"), "only authenticated GET reads");
});

test("an earlier epoch is read by ordinal with pagination, cursor and hidden filter", async () => {
  const client = fakeClient(EVENTS);
  const first = await readRoomHistory({client, session, args: {epochOrdinal: 1, limit: 1}});
  assert.equal(first.epoch.ordinal, 1);
  assert.equal(first.epoch.endsBeforeSeq, 5);
  assert.deepEqual(first.messages.map((m) => m.body), ["first decision"]);
  assert.equal(first.coverage.complete, false);
  assert.ok(first.coverage.nextCursor !== null);
  const second = await readRoomHistory({client, session, args: {epochOrdinal: 1, limit: 10, afterSeq: first.coverage.nextCursor}});
  assert.deepEqual(second.messages.map((m) => m.body), ["third point"], "second thought was hidden by the owner in a later epoch");
  assert.equal(second.hiddenExcluded, 1);
  assert.equal(second.hiddenFilterComplete, true);
  assert.equal(second.coverage.complete, true);
  assert.equal(second.epoch.status, "closed");
});

test("query filters bodies case-insensitively and bad or unknown arguments fail closed", async () => {
  const client = fakeClient(EVENTS);
  const filtered = await readRoomHistory({client, session, args: {epochOrdinal: 1, query: "DECISION"}});
  assert.deepEqual(filtered.messages.map((m) => m.body), ["first decision"]);
  const unknown = await readRoomHistory({client, session, args: {epochOrdinal: 9}});
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /not known/);
  assert.equal(unknown.epochs.length, 2);
  assert.equal((await readRoomHistory({client, session, args: {limit: "many"}})).success, false);
  const clamped = await readRoomHistory({client, session, args: {limit: 500}});
  assert.ok(clamped.messages.length <= HISTORY_PAGE_MAX);
});

test("epoch boundaries fall back to scanned discussion.started events on servers without the route", async () => {
  const client = fakeClient(EVENTS, {epochsSupported: false});
  const result = await readRoomHistory({client, session, args: {epochOrdinal: 1}});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.epochs.map((e) => e.ordinal), [1, 2]);
  assert.equal(result.epochsComplete, true);
  assert.equal(result.epoch.endsBeforeSeq, 5);
  assert.deepEqual(result.messages.map((m) => m.body), ["first decision", "third point"]);
});

test("protocol failures are reported, not thrown, and nothing is executed", async () => {
  const client = fakeClient(EVENTS);
  client.readEvents = async () => { throw new Error("forbidden"); };
  const result = await readRoomHistory({client, session, args: {epochOrdinal: 1}});
  assert.equal(result.success, false);
  assert.match(result.error, /temporarily unavailable/);
});

test("the tool registers through the plugin API and resolves the configured Room account", async () => {
  const registered = [];
  const api = {registerTool: (tool) => registered.push(tool)};
  const accounts = () => [{accountId: "default", stateFile: "/state/default.json"}, {accountId: "other", stateFile: "/state/other.json"}];
  const load = async (path) => path.endsWith("default.json")
    ? {roomId: "room-1", credential: "secret", baseUrl: "https://room.example/api"}
    : {roomId: "room-2", credential: "secret-2", baseUrl: "https://room.example/api"};
  const client = fakeClient(EVENTS);
  assert.equal(registerRoomHistoryTool(api, {
    makeClient: () => client,
    resolve: (room) => resolveHistorySession(room, {accounts, load}),
  }), true);
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, ROOM_HISTORY_TOOL_NAME);
  assert.equal(tool.parameters.additionalProperties, false);
  const ambiguous = JSON.parse((await tool.execute("call-1", {})).content[0].text);
  assert.equal(ambiguous.selectionRequired, true);
  assert.deepEqual(ambiguous.rooms.map((r) => r.roomId), ["room-1", "room-2"]);
  const selected = await tool.execute("call-2", {room: "room-1", epochOrdinal: 1});
  const result = JSON.parse(selected.content[0].text);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.epoch.ordinal, 1);
  assert.deepEqual(selected.details.epoch, result.epoch);
  assert.equal(registerRoomHistoryTool({}, {}), false, "an API without registerTool is skipped, not broken");
});
