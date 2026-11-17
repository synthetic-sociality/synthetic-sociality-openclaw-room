// Contract P2c-3d (OpenClaw 0.2.88, 2026-11-17): a membership stopped by the Room is reported as stopped with its
// reason. Live fault (17 Nov): two memberships of the closed Room "Alibaba", their credentials expired on 9 Nov, read
// `connection: "connecting"` with an empty `lastErrorCode` while they waited for a renewal the Room never grants.
// The same four cases as the Hermes connector (conformance parityP2c3dCases).
import assert from "node:assert/strict";
import test from "node:test";
import {createHash, randomBytes} from "node:crypto";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalStatus} from "../src/local-status.js";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {loadState, saveState} from "../src/state.js";

const CASES = [
  "SBR-01 a credential_expired answer reports the membership as stopped with lastErrorCode credential_expired",
  "SBR-02 a credential_revoked answer reports the membership as stopped with lastErrorCode credential_revoked",
  "SBR-03 while it waits for a renewal or re-admission the membership is never reported connecting or reconnecting and keeps its code",
  "SBR-04 a successful renewal returns the membership to the normal path; a sibling membership's entry is never changed",
];
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const ROOM = "yvxd27gg48i8kw7";
const MEMBER = "ub8898d453rgsq5";
const SIBLING = "hpaey501k5fmc3n";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The existing fake Room of the renewal tests: an expired base credential, an owner renewal the Room grants only when
// `grant()` says so, and a registration that answers 401 credential_expired (or credential_revoked) for the base.
async function fakeRoom({grant = () => false, refusal = "credential_expired", intentStatus = () => 200} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oc-p2c3d-"));
  const stateFile = join(directory, "accounts", "alibaba.json");
  const state = {version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId: MEMBER,
    clientInstanceId: "instance-1", credential: "expired-base", credentialExpiresAt: "2026-11-09T22:56:00Z",
    cursor: 7, terminalEvidence: {}, deliveryIntents: {}};
  await saveState(stateFile, state);
  const request = {roomId: ROOM, membershipId: MEMBER, displayName: "Aura", identityVersion: 2, baseCredentialGeneration: 1,
    requestId: randomBytes(32).toString("base64url"), deliveredSeq: 9, acknowledgedSeq: 7, state: "owner_requested",
    expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const proof = {...request, grantId: "grant-1", credentialExpiresAt: "2030-01-01T00:00:00Z"};
  let replacement, confirmed = false;
  const routes = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const credential = init.headers.Authorization?.slice(7);
    const body = init.body && JSON.parse(init.body);
    routes.push(path.split("/").at(-1));
    let response, status = 200;
    if (path.endsWith("/credential-renewal-intent")) {
      status = intentStatus();
      response = status === 200 ? {request: !confirmed && grant() ? request : null} : {code: "unavailable"};
    } else if (path.endsWith("/credential-renewal-requests")) {
      const durable = (await loadState(stateFile)).credentialRotation;
      assert.equal(body.grantSecretHash, createHash("sha256").update(durable.grantSecret).digest("hex"));
      response = {...request, state: "issued", grantId: "grant-1"}; status = 201;
    } else if (path.endsWith("/redeem")) { replacement = body.replacementCredential; response = proof; }
    else if (path.endsWith("/verify")) { assert.equal(credential, replacement); response = proof; }
    else if (path.endsWith("/confirm")) {
      assert.equal(credential, replacement); confirmed = true;
      response = {id: "event-1", type: "credential.renewed", payload: {membershipId: MEMBER, credentialGeneration: 2, credentialExpiresAt: proof.credentialExpiresAt}};
    } else if (path.endsWith("/state")) { assert.equal(credential, replacement); response = {roomId: ROOM, roster: [proof]}; }
    else if (path.endsWith("/connector/sessions")) {
      if (credential === "expired-base") { response = {code: refusal}; status = 401; }
      else response = {sessionId: "fresh-session", heartbeatIntervalSeconds: 15, capabilities: []};
    } else if (path.endsWith("/activity")) response = {acceptedStreamSeq: body.streamSeq};
    else { response = {code: "not_found"}; status = 404; }
    return new Response(JSON.stringify(response), {status, headers: {"content-type": "application/json"}});
  };
  const statusPath = join(directory, "status.json");
  const status = new LocalStatus(statusPath, {version: "0.2.88", hostLabel: "test"});
  // Every write of the status file, as the host's watchdog would read it.
  const writes = [];
  const write = status.write.bind(status);
  status.write = () => {
    const done = write();
    writes.push(structuredClone(status.snapshot()));
    return done;
  };
  return {stateFile, statusPath, status, writes, routes, fetchImpl};
}

const entryOf = (snapshot, membershipId = MEMBER) => snapshot.memberships?.[membershipId];
const pair = (entry) => [entry?.connection, entry?.lastErrorCode];

// A runtime that waits for a renewal: `onWait(n)` runs at the start of each 30 s renewal wait; after `waits` waits it
// closes the runtime (the host's stop), so the start ends.
function waitingRuntime(room, {waits = 4, onWait = () => {}} = {}) {
  let count = 0;
  const runtime = new OpenClawRoomRuntime({accountId: "alibaba", stateFile: room.stateFile, enabled: true}, {
    fetchImpl: room.fetchImpl, waitForRenewal: true, status: room.status, logger: {info() {}, warn() {}, error() {}},
    renewalWait: async (milliseconds, signal) => {
      assert.equal(milliseconds, 30_000);
      count += 1;
      await onWait(count);
      if (count >= waits) {
        await runtime.close();
        signal?.throwIfAborted();
      }
    },
  });
  return runtime;
}

test("conformance parityP2c3dCases carries the four shared cases, each a test of this suite, and the contract carries P2c-3d", async () => {
  assert.deepEqual(conformance.parityP2c3dCases, CASES);
  const paragraph = contract.indexOf("\nP2c-3d Stopped by the Room (2026-11-17). ");
  assert.ok(paragraph > 0, "P2c-3d paragraph");
  assert.ok(contract.indexOf("whatever the host run still does.\n\nP2c-3d ") > 0, "P2c-3d directly after P2c-3c");
  assert.equal(sha256(contract), conformance.contractSha256);
});

test(CASES[0], async () => {
  // The live shape: the credential is already expired at the start, in a Room that never grants a renewal.
  const room = await fakeRoom();
  const seen = [];
  const runtime = waitingRuntime(room, {waits: 1, onWait: () => seen.push(pair(entryOf(room.status.snapshot())))});
  await assert.rejects(runtime.initialize());
  assert.deepEqual(seen, [["stopped", "credential_expired"]]);
  const file = JSON.parse(await readFile(room.statusPath, "utf8"));
  assert.deepEqual(pair(file.memberships[MEMBER]), ["stopped", "credential_expired"]);
  assert.ok(file.memberships[MEMBER].lastErrorAt);
  assert.deepEqual(pair(file.rooms[ROOM]), ["stopped", "credential_expired"]);
});

test(CASES[1], async () => {
  const room = await fakeRoom({refusal: "credential_revoked"});
  const runtime = waitingRuntime(room);
  await assert.rejects(runtime.initialize(), (error) => error?.code === "credential_revoked");
  const file = JSON.parse(await readFile(room.statusPath, "utf8"));
  assert.deepEqual(pair(file.memberships[MEMBER]), ["stopped", "credential_revoked"]);
  assert.deepEqual(pair(file.rooms[ROOM]), ["stopped", "credential_revoked"]);
  // The channel's stop handler then writes its own code and the stop (channel.js); a restart of the retired account
  // ends on a plain error ("network"). Neither clears the Room's code.
  room.status.room(ROOM, MEMBER, {errorCode: "network"});
  room.status.room(ROOM, MEMBER, {connection: "stopped"});
  assert.deepEqual(pair(entryOf(room.status.snapshot())), ["stopped", "credential_revoked"]);
  await runtime.close();
});

test(CASES[2], async () => {
  // Several renewal waits in a Room that never grants one; a renewal discovery that fails on the way changes nothing.
  let asks = 0;
  const room = await fakeRoom({intentStatus: () => (++asks === 2 ? 503 : 200)});
  const perWait = [];
  const runtime = waitingRuntime(room, {waits: 5, onWait: () => perWait.push(pair(entryOf(room.status.snapshot())))});
  await assert.rejects(runtime.initialize());
  assert.equal(perWait.length, 5);
  assert.ok(asks >= 4, String(asks));
  assert.deepEqual(perWait, Array(5).fill(["stopped", "credential_expired"]));
  const first = room.writes.findIndex((snapshot) => entryOf(snapshot)?.connection === "stopped");
  assert.ok(first >= 0);
  for (const snapshot of room.writes.slice(first)) assert.deepEqual(pair(entryOf(snapshot)), ["stopped", "credential_expired"]);
  // The host restarts the account in the same gateway: the new runtime's start and its retries write `connecting`
  // and `reconnecting` (and the channel's stop handler its own code); the membership stays stopped with its code
  // until the Room answers again.
  room.status.room(ROOM, MEMBER, {connection: "connecting"});
  room.status.room(ROOM, MEMBER, {connection: "reconnecting", errorCode: "http_503"});
  room.status.room(ROOM, MEMBER, {errorCode: "network"});
  room.status.room(ROOM, MEMBER, {errorCode: ""});
  assert.deepEqual(pair(entryOf(room.status.snapshot())), ["stopped", "credential_expired"]);
  const restarted = waitingRuntime(room, {waits: 3, onWait: () => perWait.push(pair(entryOf(room.status.snapshot())))});
  await assert.rejects(restarted.initialize());
  assert.deepEqual(perWait.slice(5), Array(3).fill(["stopped", "credential_expired"]));
  for (const snapshot of room.writes.slice(first)) {
    assert.ok(!["connecting", "reconnecting"].includes(entryOf(snapshot).connection), JSON.stringify(entryOf(snapshot)));
    assert.equal(entryOf(snapshot).lastErrorCode, "credential_expired");
  }
  const file = JSON.parse(await readFile(room.statusPath, "utf8"));
  assert.deepEqual(pair(file.memberships[MEMBER]), ["stopped", "credential_expired"]);
});

test(CASES[3], async () => {
  // The Room grants the renewal at the third wait; a sibling membership of the same gateway and Room is connected.
  let waited = 0;
  const room = await fakeRoom({grant: () => waited >= 3});
  room.status.room(ROOM, SIBLING, {connected: true, registered: true});
  const sibling = structuredClone(entryOf(room.status.snapshot(), SIBLING));
  const perWait = [];
  const runtime = waitingRuntime(room, {waits: 10, onWait: (n) => {
    waited = n;
    const snapshot = room.status.snapshot();
    perWait.push([...pair(entryOf(snapshot)), snapshot.rooms[ROOM].connection]);
    assert.deepEqual(entryOf(snapshot, SIBLING), sibling);
  }});
  try {
    const session = await runtime.initialize();
    assert.equal(session.sessionId, "fresh-session");
    assert.deepEqual(perWait, Array(3).fill(["stopped", "credential_expired", "stopped"]));
    const snapshot = room.status.snapshot();
    // The normal path: registered on the renewed credential, its connection changes only now.
    assert.equal(entryOf(snapshot).connection, "connected");
    assert.ok(entryOf(snapshot).lastConnectedAt);
    assert.equal(snapshot.rooms[ROOM].connection, "connected");
    assert.deepEqual(entryOf(snapshot, SIBLING), sibling);
    for (const written of room.writes) {
      const entry = entryOf(written, SIBLING);
      if (entry) assert.deepEqual(entry, sibling);
    }
    assert.notEqual((await loadState(room.stateFile)).credential, "expired-base");
  } finally {
    await runtime.close();
  }
});
