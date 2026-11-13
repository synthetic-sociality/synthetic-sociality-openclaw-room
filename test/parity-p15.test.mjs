// P15: ask sources and the membership watcher pause (OpenClaw 0.2.80; shared contract P15-1..3 and the identical
// parityP15Cases of the Hermes connector). Offline: the real RoomClient request path with a recording fetch, the
// shared participation gate, and the exported cycle-source functions. No Room contact.
import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {RoomAPIError, RoomClient} from "../src/room-client.js";
import {OpenClawRoomRuntime, currentItemLine, cycleSourceMessage, resetEnrollmentLineages, scanCycleSourceMessage} from "../src/runtime.js";

const participation = await import("../src/participation.js").catch(() => null);
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const CASES = conformance.parityP15Cases;
const SESSION = {roomId: "room-1", credential: "secret-1"};
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const ASK = {id: "evt-ask", seq: 40, type: "human.command", actorId: "h1", actorRole: "human_owner",
  payload: {command: {command: "ask", arguments: {instruction: "Real, please compare both drafts"}, resolvedTargetMembershipIds: ["a3"]}}};
const READY = {id: "evt-ready", seq: 41, type: "discussion.cycle_attempt_ready", payload: {sourceEventId: "evt-ask"}};

function gateFor(statuses) {
  assert.ok(participation?.ParticipationGate, "OpenClaw 0.2.80 has the shared participation gate");
  const probes = [];
  const gate = new participation.ParticipationGate({recheckMs: 40, probe: async () => {
    probes.push(Date.now());
    return typeof statuses === "function" ? statuses() : statuses.shift() ?? "";
  }});
  return {gate, probes};
}

function client(gate, answer = () => Response.json({})) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url: String(url), method: init.method ?? "GET"});
    return answer(String(url), init);
  };
  const result = new RoomClient({baseUrl: "https://room.example/api", credential: "secret-1", fetchImpl});
  result.participation = gate;
  return {client: result, calls};
}

const denied = (code = "forbidden") => Response.json({code}, {status: 403});

test("P15 conformance names the clause and the shared cases", () => {
  assert.match(conformance.parityP15Contract, /^docs\/delivery-lifecycle-contract-v1\.md#p15/);
  assert.equal(CASES.length, 12);
  const section = contract.split("## P15 — ")[1].split("\n## ")[0];
  assert.deepEqual(section.split("\n").filter((line) => /^- P15-\d\d /.test(line)).map((line) => line.slice(2)), CASES);
});

test(CASES[0], () => {
  const source = cycleSourceMessage(READY, [ASK]);
  assert.equal(source?.id, "evt-ask", "an ask is a cycle source in the loaded page");
  assert.equal(currentItemLine(source, "Thorsten"), "#40 Thorsten: Real, please compare both drafts");
  assert.deepEqual(source.payload.command.resolvedTargetMembershipIds, ["a3"], "addressing uses the resolved targets");
});

test(CASES[1], async () => {
  const reads = [];
  const readPage = async (after) => (reads.push(after), {events: [ASK].filter((item) => item.seq > after)});
  const found = await scanCycleSourceMessage({...READY, seq: 90}, 10, readPage);
  assert.equal(found?.id, "evt-ask", "the bounded epoch scan finds an older ask");
  assert.ok(reads.every((after) => after >= 9), "never before the epoch floor");
});

test(CASES[2], async () => {
  let status = "muted";
  const {gate} = gateFor(() => status);
  const {client: room, calls} = client(gate, (url) => Response.json(url.includes("/events") ? {events: []} : {}));
  gate.observe("muted");
  const pending = Promise.allSettled([room.readEvents(SESSION, 0, {wait: 1}), room.heartbeat(SESSION, "s-1"),
    room.publishActivity(SESSION, {kind: "heartbeat"}), room.acknowledge(SESSION, 3)]);
  await tick();
  assert.equal(calls.length, 0, "every background watcher waits while paused");
  status = "active";
  await pending;
  assert.equal(calls.length, 4, "all resume on active");
  assert.equal(gate.paused, false);
});

test(CASES[3], async () => {
  const {gate, probes} = gateFor(["active"]);
  const {client: room} = client(gate, () => denied());
  await assert.rejects(room.postMessage(SESSION, {body: "x"}), (error) => error instanceof RoomAPIError && error.status === 403);
  assert.equal(probes.length, 1, "one own-roster probe");
  assert.equal(gate.paused, false, "an active member is not paused");
});

test(CASES[4], async () => {
  const {gate} = gateFor(["", ""]);
  gate.observe("muted");
  await gate.probe({force: true});
  assert.equal(gate.paused, true, "an unread probe cannot resume");
  // The runtime's own-roster probe ignores other memberships and a missing own entry.
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/nonexistent/x.json", baseUrl: "https://room.example/api"});
  runtime.state = {membershipId: "a1", roomId: "room-1"};
  runtime.client = {roomState: async () => ({roster: [{membershipId: "a2", status: "active"}]})};
  assert.equal(await runtime.ownMembershipStatus(), "");
  runtime.participation.observe("muted");
  await runtime.participation.probe({force: true});
  assert.equal(runtime.participation.paused, true);
});

test(CASES[5], async () => {
  const {gate, probes} = gateFor(["muted"]);
  const {client: room} = client(gate, () => denied("credential_revoked"));
  await assert.rejects(room.heartbeat(SESSION, "s-1"), (error) => error.code === "credential_revoked");
  assert.equal(probes.length, 0, "credential failures never probe");
  gate.observe("muted");
  const controller = new AbortController();
  const waiting = room.readEvents(SESSION, 0, {wait: 1, signal: controller.signal});
  controller.abort();
  await assert.rejects(waiting);
  const later = room.heartbeat(SESSION, "s-1");
  gate.close();
  await assert.rejects(later);
});

test(CASES[6], async () => {
  const one = gateFor(() => "muted");
  const two = gateFor(() => "active");
  const first = client(one.gate);
  const second = client(two.gate);
  one.gate.observe("muted");
  const paused = first.client.heartbeat(SESSION, "s-1").catch(() => {});
  await second.client.heartbeat({roomId: "room-2", credential: "secret-2"}, "s-2");
  assert.equal(second.calls.length, 1, "the sibling membership keeps running");
  assert.equal(first.calls.length, 0);
  one.gate.close();
  await paused;
});

test(CASES[7], async () => {
  assert.ok(participation?.ParticipationGate, "OpenClaw 0.2.80 has the shared participation gate");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("/connector/enrollments")) return Response.json({code: "connector_not_active"}, {status: 409});
    if (String(url).endsWith("/state")) return Response.json({roster: [{membershipId: "member-1", status: "muted"}]});
    return Response.json({});
  };
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: "/nonexistent/x.json", baseUrl: "https://room.example/api"}, {fetchImpl});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1", credential: "secret-1",
    clientInstanceId: "client-1", cursor: 0};
  runtime.client = new RoomClient({baseUrl: "https://room.example/api", credential: "secret-1", fetchImpl});
  runtime.client.participation = runtime.participation;
  resetEnrollmentLineages();
  await runtime.acceptConnectorEnrollments();
  assert.equal(runtime.participation.paused, true, "the muted answer pauses the gate");
  const before = calls.length;
  const heartbeat = runtime.client.heartbeat(runtime.state, "s-1").catch(() => {});
  const events = runtime.client.readEvents(runtime.state, 0, {wait: 1}).catch(() => {});
  await tick();
  assert.equal(calls.length, before, "heartbeat and event watchers wait");
  runtime.participation.close();
  await Promise.all([heartbeat, events]);
});

test(CASES[8], async () => {
  const {gate} = gateFor(() => "muted");
  const {client: room, calls} = client(gate);
  gate.observe("muted");
  for (const call of [() => room.postMessage(SESSION, {body: "x"}), () => room.finishTurn(SESSION, {turnId: "t"}),
    () => room.createArtifact(SESSION, Buffer.from("x"), "a.txt", "text/plain", "A")]) {
    await assert.rejects(call(), (error) => error.code === "membership_inactive");
  }
  assert.equal(calls.length, 0, "turn tools and replies fail fast without a Room contact");
});

test(CASES[9], async () => {
  const {gate, probes} = gateFor(["active"]);
  const {client: room} = client(gate, () => denied());
  await assert.rejects(room.downloadArtifact(SESSION, "art-1", "v-1", "image/png"));
  assert.equal(probes.length, 1);
  assert.equal(gate.paused, false, "an active member's photo refusal surfaces, no pause");
});

test(CASES[10], async () => {
  let status = "muted";
  const {gate, probes} = gateFor(() => status);
  gate.observe("muted");
  await gate.probe({force: true});
  status = "active";
  await Promise.all([gate.probeOffer(), gate.probeOffer(), gate.probeOffer()]);
  assert.equal(probes.length, 2, "one prompt probe for concurrent offers, inside the interval");
  assert.equal(gate.paused, false);
});

test(CASES[11], async () => {
  const {gate, probes} = gateFor(["muted"]);
  const {client: room, calls} = client(gate, () => denied());
  await assert.rejects(room.readEvents(SESSION, 0, {wait: 1}), (error) => error.status === 403);
  assert.equal(probes.length, 1, "the denial probed first");
  assert.equal(gate.paused, true, "only roster evidence paused it");
  const next = room.heartbeat(SESSION, "s-1").catch(() => {});
  await tick();
  assert.equal(calls.length, 1, "later background contacts wait");
  gate.close();
  await next;
});

// PR80-O-003 / PR80-O-004 (contract P15-2): the enrollment claim fails fast and is asked again at the next listing;
// credential-renewal and recovery reads of the Room state wait while paused, and the own-roster probe stays reachable.
import {mkdtemp as makeTemp} from "node:fs/promises";
import {tmpdir as osTmp} from "node:os";
import {join as joinPath} from "node:path";
import {randomBytes, createHash} from "node:crypto";
import {renewCredential} from "../src/credential-renewal.js";
import {roomForState} from "../src/recovery.js";
import {loadState as readState, saveState as writeState} from "../src/state.js";
import {ParticipationGate as Gate} from "../src/participation.js";

test("PR80-O-003 a muted source membership at claim time refuses the claim at once and the next poll claims", async () => {
  const directory = await makeTemp(joinPath(osTmp(), "openclaw-room-o003-"));
  const stateFile = joinPath(directory, "default.json");
  const source = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    credential: "secret-1", clientInstanceId: "client-1", cursor: 0};
  await writeState(stateFile, source);
  let runtime;
  const claims = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/connector/enrollments")) {
      // Muted between the listing and the claim.
      runtime.participation.observe("muted");
      return Response.json({enrollments: [{invitationId: "invite-9", roomId: "room-9"}]});
    }
    if (path.includes("/connector/enrollments/") || path.endsWith("/claim")) {
      claims.push(path);
      return Response.json({roomId: "room-9", membershipId: "member-9", credential: "fresh-9", credentialExpiresAt: "2099-01-01T00:00:00Z", identityVersion: 1, headSeq: 3});
    }
    if (path.endsWith("/state")) return Response.json({roster: [{membershipId: "member-1", status: "active"}]});
    return Response.json({});
  };
  const activations = [];
  runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: source.baseUrl},
    {fetchImpl, activateEnrollment: async (activation) => { activations.push(activation); }});
  runtime.state = {...source};
  runtime.client = new RoomClient({baseUrl: source.baseUrl, credential: source.credential, fetchImpl});
  runtime.client.participation = runtime.participation;
  resetEnrollmentLineages();
  const first = await Promise.race([runtime.acceptConnectorEnrollments(), tick(300).then(() => "waited")]);
  assert.deepEqual(first, [], "the claim fails fast instead of waiting for an unmute");
  assert.deepEqual(claims, []);
  runtime.participation.observe("active");
  resetEnrollmentLineages();
  const fetchAgain = runtime.client;
  fetchAgain.participation = null; // the next poll's listing no longer mutes
  runtime.client = new RoomClient({baseUrl: source.baseUrl, credential: source.credential, fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith("/connector/enrollments")) return Response.json({enrollments: [{invitationId: "invite-9", roomId: "room-9"}]});
    return fetchImpl(url, init);
  }});
  runtime.client.participation = runtime.participation;
  const second = await runtime.acceptConnectorEnrollments();
  assert.equal(claims.length, 1, "the next poll claims");
  assert.equal(second.length, 1);
  assert.equal(activations.length, 1);
  runtime.participation.close();
});

test("PR80-O-004 the final credential-renewal and the recovery Room-state reads wait while paused; the own-roster probe stays reachable", async () => {
  const stateFile = joinPath(await makeTemp(joinPath(osTmp(), "openclaw-room-o004-")), "state.json");
  const state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    clientInstanceId: "instance-1", credential: "expired-base", credentialExpiresAt: "2020-01-01T00:00:00Z",
    cursor: 7, terminalEvidence: {}, deliveryIntents: {}};
  await writeState(stateFile, state);
  const request = {roomId: "room-1", membershipId: "member-1", displayName: "An agent", identityVersion: 2,
    baseCredentialGeneration: 1, requestId: randomBytes(32).toString("base64url"), deliveredSeq: 9, acknowledgedSeq: 7,
    state: "owner_requested", expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const proof = {...request, grantId: "grant-1", credentialExpiresAt: "2030-01-01T00:00:00Z"};
  let status = "active";
  const stateReads = [];
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith("/state")) {
      stateReads.push(status);
      return Response.json({roomId: "room-1", roster: [{...proof, status}]});
    }
    return Response.json({});
  };
  const client = new RoomClient({baseUrl: state.baseUrl, credential: state.credential, fetchImpl});
  let probes = 0;
  const gate = new Gate({recheckMs: 30, probe: async () => {
    probes += 1;
    const answer = await client.roomState({roomId: "room-1", credential: "probe"}, undefined, {probe: true});
    return answer.roster.find((item) => item.membershipId === "member-1")?.status ?? "";
  }});
  client.participation = gate;
  // The renewal grant flow is the fixture's; the final Room-state read is the real RoomClient path.
  let confirmed = false;
  Object.assign(client, {
    credentialRenewalIntent: async () => ({request: confirmed ? null : request}),
    requestCredentialRenewal: async () => ({...request, state: "issued", grantId: "grant-1"}),
    redeemCredentialRenewal: async () => proof,
    verifyCredentialRenewal: async () => proof,
    confirmCredentialRenewal: async () => {
      confirmed = true;
      status = "muted";
      gate.observe("muted"); // a mute lands between the confirmation and the final read
      return {id: "event-1", type: "credential.renewed", payload: {membershipId: "member-1", credentialGeneration: 2, credentialExpiresAt: proof.credentialExpiresAt}};
    },
  });
  const renewal = renewCredential({state: structuredClone(state), stateFile, account: {}, client});
  for (let waited = 0; probes < 1 && waited < 3000; waited += 20) await tick(20);
  assert.ok(probes >= 1, "the paused renewal rechecks through the own-roster probe");
  assert.ok(stateReads.length >= 1 && stateReads.every((value) => value === "muted"), "only probes reached the Room while paused");
  const recovery = roomForState(client, {...state, credential: "replacement"}).roomState();
  await tick(40);
  const readsWhilePaused = stateReads.length;
  assert.equal(readsWhilePaused, probes, "every Room-state contact while paused was a probe");
  status = "active";
  assert.equal(await renewal, true, "the renewal completes after the unmute instead of failing with membership_inactive");
  assert.equal((await recovery).roomId, "room-1", "the recovery read completes after the unmute");
  assert.equal((await readState(stateFile)).credentialRotation, undefined);
  gate.close();
});
