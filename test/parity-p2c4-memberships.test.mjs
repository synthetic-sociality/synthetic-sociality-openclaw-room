// Contract P2c-4 (OpenClaw 0.2.83, tkw-049): local status per (Room, membership). Two accounts of one gateway in the
// same Room (the shared Aura+Claw gateway, Room bczi4bui9f7q159) each keep their own `memberships` entry; the `rooms`
// entry is a deterministic summary that never alternates with the last writer. Same cases as the Hermes connector
// (conformance parityP2c4MembershipCases).
import assert from "node:assert/strict";
import test from "node:test";
import {mkdir, mkdtemp, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalStatus} from "../src/local-status.js";
import {OpenClawRoomRuntime, resetEnrollmentLineages} from "../src/runtime.js";
import {connectorControl} from "../src/connector-control.js";
import {saveState} from "../src/state.js";
import {resolvedRoomAccounts} from "../src/account-discovery.js";

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = conformance.parityP2c4MembershipCases;
const ROOM = "bczi4bui9f7q159";
const AURA = "hrrbgxqkv9iuzje";
const CLAW = "0ye16c9a9jr868p";
const PER_CONNECTION = ["connection", "lastConnectedAt", "lastErrorCode", "lastErrorAt", "lastGateWaitSeconds", "lastGateWaitAt",
  "lastGateWaitReason", "lastReconnectedAt", "lastOutageSeconds", "acknowledgedSeq", "holeSeqs", "quarantinedSeqs", "ledgerCode"];

async function freshStatus() {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-members-"));
  const path = join(directory, "status.json");
  return {path, status: new LocalStatus(path, {version: "0.2.83", hostLabel: "test"})};
}

const read = async (path) => JSON.parse(await readFile(path, "utf8"));

// A runtime of one account on the shared gateway: only its state and the shared writer matter here.
function account(accountId, membershipId, status) {
  const runtime = new OpenClawRoomRuntime({accountId, stateFile: join(tmpdir(), `${accountId}-${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId, credential: "fixture-credential",
    clientInstanceId: `client-${accountId}`, cursor: 0};
  runtime.status = status;
  return runtime;
}

test("conformance P2c-4 membership case names resolve to tests in this suite", async () => {
  const entries = Object.entries(CASES ?? {});
  assert.deepEqual(entries.map(([id]) => id), ["P2c-4-M1", "P2c-4-M2", "P2c-4-M3", "P2c-4-M4", "P2c-4-M5", "P2c-4-M6", "P2c-4-M7"]);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const [id, name] of entries) {
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(CASES[${JSON.stringify(id)}],`)).length, 1, name);
  }
});

test(CASES["P2c-4-M1"], async () => {
  const {path, status} = await freshStatus();
  const aura = account("aura", AURA, status);
  const claw = account("claw", CLAW, status);
  aura.reportStatus({connected: true, registered: true});
  claw.reportStatus({connected: true, registered: true});
  claw.reportStatus({connection: "reconnecting", errorCode: "network"});
  aura.reportStatus({ledger: {acknowledgedSeq: 40, holeSeqs: [42], quarantinedSeqs: [], ledgerCode: "ack_hole"}});
  const data = await read(path);
  assert.deepEqual(Object.keys(data.memberships ?? {}).sort(), [CLAW, AURA].sort());
  const a = data.memberships[AURA];
  const c = data.memberships[CLAW];
  assert.deepEqual([a.roomId, a.membershipId, a.connection, a.lastErrorCode, a.acknowledgedSeq, a.holeSeqs], [ROOM, AURA, "connected", "", 40, [42]]);
  assert.deepEqual([c.roomId, c.membershipId, c.connection, c.lastErrorCode, c.acknowledgedSeq, c.holeSeqs], [ROOM, CLAW, "reconnecting", "network", 0, []]);
  for (const entry of [a, c]) assert.deepEqual(Object.keys(entry).sort(), ["membershipId", "roomId", ...PER_CONNECTION].sort());
});

test(CASES["P2c-4-M2"], async () => {
  const {path, status} = await freshStatus();
  const aura = account("aura", AURA, status);
  const claw = account("claw", CLAW, status);
  aura.reportStatus({connected: true, registered: true});
  claw.reportStatus({connected: true, registered: true});
  const before = await read(path);
  claw.reportStatus({connection: "stopped", errorCode: "credential_revoked"});
  const after = await read(path);
  assert.deepEqual(after.memberships[AURA], before.memberships[AURA]);
  assert.deepEqual([after.memberships[CLAW].connection, after.memberships[CLAW].lastErrorCode], ["stopped", "credential_revoked"]);
  // The live account keeps reporting; the stopped one stays stopped.
  aura.reportStatus({connection: "reconnecting", errorCode: "network"});
  aura.reportStatus({connected: true, registered: true});
  const later = await read(path);
  assert.equal(later.memberships[AURA].connection, "connected");
  assert.equal(later.memberships[CLAW].connection, "stopped");
});

test(CASES["P2c-4-M3"], async () => {
  // The same per-membership values written in either order give the same summary; heartbeats of both accounts in
  // turn never flip it (on 0.2.82 the Room entry took the last writer's membershipId and connection).
  const summaries = [];
  for (const order of [[AURA, CLAW], [CLAW, AURA]]) {
    const {path, status} = await freshStatus();
    const runtimes = {[AURA]: account("aura", AURA, status), [CLAW]: account("claw", CLAW, status)};
    runtimes[AURA].reportStatus({connected: true, registered: true});
    runtimes[CLAW].reportStatus({connected: true, registered: true});
    runtimes[AURA].reportStatus({connection: "inactive", inactive: true, errorCode: "connector_not_active"});
    const seen = new Set();
    for (let beat = 0; beat < 4; beat += 1) {
      for (const member of order) {
        runtimes[member].reportStatus({connected: true});
        const room = (await read(path)).rooms[ROOM];
        seen.add(JSON.stringify([room.membershipId, room.connection]));
      }
    }
    assert.equal(seen.size, 1, `alternated: ${[...seen].join(" / ")}`);
    const data = await read(path);
    const room = data.rooms[ROOM];
    // Worst connection wins (inactive over connected); its membership is the representative.
    assert.deepEqual([room.membershipId, room.connection, room.lastErrorCode], [AURA, "inactive", "connector_not_active"]);
    assert.deepEqual(room.membershipIds, [CLAW, AURA].sort());
    for (const field of PER_CONNECTION) assert.deepEqual(room[field], data.memberships[AURA][field], field);
    const {lastConnectedAt, lastErrorAt, ...stable} = room;
    summaries.push(stable);
  }
  assert.deepEqual(summaries[0], summaries[1]);
  // Equal connection states: ties go to the smallest membership id.
  const {path, status} = await freshStatus();
  account("aura", AURA, status).reportStatus({connected: true, registered: true});
  account("claw", CLAW, status).reportStatus({connected: true, registered: true});
  assert.equal((await read(path)).rooms[ROOM].membershipId, [AURA, CLAW].sort()[0]);
});

test(CASES["P2c-4-M4"], async () => {
  const {path, status} = await freshStatus();
  const only = account("aura", AURA, status);
  only.reportStatus({connected: true, registered: true});
  only.reportStatus({connection: "reconnecting", errorCode: "network"});
  only.reportStatus({gateWaitSeconds: 1.26, gateWaitReason: "host_run_busy"});
  only.reportStatus({ledger: {acknowledgedSeq: 9, holeSeqs: [], quarantinedSeqs: [11], ledgerCode: "quarantine_held"}});
  const data = await read(path);
  const room = data.rooms[ROOM];
  // The Room entry keeps every key and value it had, plus the additive membership list.
  assert.deepEqual(Object.keys(room).sort(), ["membershipId", "membershipIds", ...PER_CONNECTION].sort());
  assert.deepEqual([room.membershipId, room.connection, room.lastErrorCode, room.lastGateWaitSeconds, room.lastGateWaitReason,
    room.acknowledgedSeq, room.quarantinedSeqs, room.ledgerCode], [AURA, "reconnecting", "network", 1.3, "host_run_busy", 9, [11], "quarantine_held"]);
  assert.deepEqual(room.membershipIds, [AURA]);
  const {membershipIds, ...legacy} = room;
  assert.deepEqual(data.memberships, {[AURA]: {roomId: ROOM, ...legacy}});
});

test(CASES["P2c-4-M5"], async () => {
  const {path, status} = await freshStatus();
  const aura = account("aura", AURA, status);
  const claw = account("claw", CLAW, status);
  aura.reportStatus({connected: true, registered: true});
  claw.reportStatus({connected: true, registered: true});
  // P2c-3b: Aura is muted; Claw is not.
  aura.reportStatus({connection: "inactive", inactive: true, errorCode: "connector_not_active"});
  claw.reportStatus({connected: true});
  let data = await read(path);
  assert.deepEqual([data.memberships[AURA].connection, data.memberships[CLAW].connection], ["inactive", "connected"]);
  // P2c-3a: Claw's outage and reconnect are its own; Aura's mute survives Claw's re-registration.
  claw.reportStatus({connection: "reconnecting", errorCode: "network"});
  claw.reportStatus({connected: true, registered: true});
  aura.reportStatus({connected: true});
  data = await read(path);
  assert.equal(data.memberships[AURA].connection, "inactive");
  assert.equal(data.memberships[AURA].lastReconnectedAt, null);
  assert.equal(data.memberships[CLAW].connection, "connected");
  assert.ok(data.memberships[CLAW].lastReconnectedAt);
  // P3-3: each membership's own ledger.
  claw.reportStatus({ledger: {acknowledgedSeq: 7, holeSeqs: [8], quarantinedSeqs: [], ledgerCode: "ack_hole"}});
  data = await read(path);
  assert.deepEqual([data.memberships[AURA].holeSeqs, data.memberships[CLAW].holeSeqs], [[], [8]]);
  // The unmute ends only Aura's mark.
  aura.reportStatus({inactive: false, connection: "connected", errorCode: ""});
  data = await read(path);
  assert.deepEqual([data.memberships[AURA].connection, data.memberships[CLAW].connection], ["connected", "connected"]);
});

test(CASES["P2c-4-M6"], async () => {
  // One membership in the Room: a value reported with the Room only is that membership's.
  const single = await freshStatus();
  single.status.room(ROOM, AURA, {connected: true, registered: true});
  single.status.room(ROOM, "", {gateWaitSeconds: 2.04});
  let data = await read(single.path);
  assert.equal(data.memberships[AURA].lastGateWaitSeconds, 2);
  assert.equal(data.rooms[ROOM].lastGateWaitSeconds, 2);
  assert.deepEqual(Object.keys(data.memberships), [AURA]);
  // Two memberships: not attributed, no entry changes and no third entry appears.
  const shared = await freshStatus();
  shared.status.room(ROOM, AURA, {connected: true, registered: true});
  shared.status.room(ROOM, CLAW, {connected: true, registered: true});
  const before = await read(shared.path);
  shared.status.room(ROOM, "", {errorCode: "network", connection: "reconnecting"});
  data = await read(shared.path);
  assert.deepEqual(data.memberships, before.memberships);
  assert.deepEqual(data.rooms, before.rooms);
});

test(CASES["P2c-4-M7"], async () => {
  // Re-admission under a new membership id (contract P2c-4, P18): the Room revoked member-2; the owner re-admits and
  // the server returns member-3 for the same Room. member-2's stopped entry and its ledger are dropped, member-3
  // starts its own entry and alone represents the Room.
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-members-readmit-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const directory = join(root, "synthetic-sociality-room", "accounts");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const source = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    credential: "secret-1", identityVersion: 3, clientInstanceId: "client-1", cursor: 5};
  const sourceFile = join(directory, "default.json");
  await saveState(sourceFile, source);
  await saveState(join(directory, "member-2.json"), {...source, roomId: "room-2", membershipId: "member-2", credential: "secret-old",
    cursor: 2645, revoked: true, revokedReason: "credential_revoked", revokedAt: "2026-11-12T09:40:00.000Z"});
  const {path, status} = await freshStatus();
  status.room("room-2", "member-2", {connected: true, registered: true});
  status.room("room-2", "member-2", {ledger: {acknowledgedSeq: 40, holeSeqs: [42], quarantinedSeqs: [], ledgerCode: "ack_hole"}});
  status.room("room-2", "member-2", {connection: "stopped", errorCode: "credential_revoked"});
  const cfg = {channels: {"synthetic-sociality-room": {enabled: true, baseUrl: source.baseUrl, stateFile: sourceFile}}};
  connectorControl.setAccounts(() => resolvedRoomAccounts(cfg));
  const activations = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: sourceFile, baseUrl: source.baseUrl},
    {status, activateEnrollment: async (activation) => { activations.push(activation.accountId); }});
  runtime.state = {...source};
  runtime.logger = {warn: () => {}, info: () => {}};
  resetEnrollmentLineages();
  runtime.client = {
    connectorEnrollments: async () => [{invitationId: "invite-9", roomId: "room-2"}],
    claimConnectorEnrollment: async () => ({roomId: "room-2", membershipId: "member-3", credential: "secret-fresh",
      credentialExpiresAt: "2026-12-12T00:00:00Z", identityVersion: 3, headSeq: 2650}),
  };
  try {
    await runtime.acceptConnectorEnrollments();
  } finally {
    connectorControl.setAccounts(() => []);
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
  assert.deepEqual(activations, ["member-3"]);
  let data = await read(path);
  assert.equal(data.memberships["member-2"], undefined, "the replaced membership's entry is dropped");
  assert.equal(data.rooms["room-2"], undefined, "no entry remains, so no summary");
  // The new membership's runtime reports: its own fresh values, and a Room-only value is attributed to it again.
  status.room("room-2", "member-3", {connected: true, registered: true});
  status.room("room-2", "", {gateWaitSeconds: 1.5});
  data = await read(path);
  assert.deepEqual(Object.keys(data.memberships), ["member-3"]);
  const room = data.rooms["room-2"];
  assert.deepEqual([room.membershipId, room.connection, room.lastErrorCode, room.acknowledgedSeq, room.holeSeqs, room.lastGateWaitSeconds,
    room.membershipIds], ["member-3", "connected", "", 0, [], 1.5, ["member-3"]]);

  // A removed binding: the summary is recomputed from the remaining entries and its marks go with the entry.
  const shared = await freshStatus();
  shared.status.room(ROOM, AURA, {connected: true, registered: true});
  shared.status.room(ROOM, CLAW, {connected: true, registered: true});
  shared.status.room(ROOM, CLAW, {connection: "inactive", inactive: true, errorCode: "connector_not_active"});
  assert.equal((await read(shared.path)).rooms[ROOM].membershipId, CLAW);
  shared.status.forget(ROOM, CLAW);
  data = await read(shared.path);
  assert.deepEqual(Object.keys(data.memberships), [AURA]);
  assert.deepEqual([data.rooms[ROOM].membershipId, data.rooms[ROOM].connection, data.rooms[ROOM].membershipIds], [AURA, "connected", [AURA]]);
  shared.status.room(ROOM, CLAW, {connected: true});
  assert.equal((await read(shared.path)).memberships[CLAW].connection, "connected", "the inactive mark was dropped with the entry");
  shared.status.forget(ROOM, CLAW);
  shared.status.forget(ROOM, AURA);
  data = await read(shared.path);
  assert.deepEqual([data.memberships, data.rooms[ROOM]], [{}, undefined]);
});
