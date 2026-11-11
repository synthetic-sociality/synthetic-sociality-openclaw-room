import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {saveState} from "../src/state.js";

// P16 (shared with Hermes 1.0.103): one live binding per Room. Hermes 1.0.101
// replaced its whole multi-Room state when one credential expired, detaching
// every sibling Room's send path from its listener. OpenClaw runs one runtime
// and one state object per Room account; these cases pin that it stays so.

export const CASES = [
  "P16-01 expiry of one binding keeps sibling receive and send on one live binding",
  "P16-02 revocation of one binding keeps sibling receive and send on one live binding",
  "P16-03 renewal of one binding keeps one live binding per Room",
  "P16-04 a stopped binding keeps its reason and posts nothing",
  "P16-05 a persisted revocation wins over a later expiry",
];
const HEADING = "P16 — One live binding per Room (2026-11-11)";
const ANCHOR = "p16--one-live-binding-per-room-2026-11-11";

async function stateFixture(roomId, membershipId, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), `openclaw-room-p16-${roomId}-`));
  const stateFile = join(directory, `${membershipId}.json`);
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId, membershipId,
    credential: `fixture-${roomId}`, clientInstanceId: `client-${roomId}`, cursor: 0, ...extra,
  });
  return stateFile;
}

function acceptingRoom() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, authorization: init?.headers?.Authorization});
    if (url.endsWith("/status")) return new Response(JSON.stringify({protocolCapabilities: []}), {status: 200});
    if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "s-b", heartbeatIntervalSeconds: 60}), {status: 200});
    if (url.endsWith("/heartbeat")) return new Response("{}", {status: 200});
    if (url.endsWith("/activity")) return new Response(JSON.stringify({acceptedStreamSeq: 1}), {status: 202});
    if (url.endsWith("/turns/request")) return new Response(JSON.stringify({turnId: "t1", state: "granted", holderMembershipId: "member-b"}), {status: 202});
    if (url.endsWith("/messages")) return new Response(JSON.stringify({id: "msg-b", seq: 5, ts: new Date().toISOString()}), {status: 201});
    if (url.endsWith("/turns/finish")) return new Response(JSON.stringify({turnId: "t1", state: "finished"}), {status: 200});
    if (url.endsWith("/policy")) return new Response(JSON.stringify({policy: {coordinationMode: "coordinated"}}), {status: 200});
    if (url.endsWith("/state")) return new Response(JSON.stringify({headSeq: 3, activeEpochId: "ep-1"}), {status: 200});
    throw new Error(`unexpected request: ${url}`);
  };
  return {calls, fetchImpl};
}

function refusingRoom(code) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/status")) return new Response(JSON.stringify({code: "request_validation_failed"}), {status: 400});
    if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({code, retryable: false}), {status: 401});
    throw new Error(`unexpected request: ${url}`);
  };
  return {calls, fetchImpl};
}

const quiet = {warn: () => {}, info: () => {}};

async function siblingSurvives(code) {
  const sibling = acceptingRoom();
  const siblingFile = await stateFixture("room-b", "member-b");
  const runtimeB = new OpenClawRoomRuntime({accountId: "member-b", stateFile: siblingFile, baseUrl: "https://room.example/api"},
    {fetchImpl: sibling.fetchImpl, logger: quiet});
  await runtimeB.initialize();
  const liveState = runtimeB.state;
  const liveClient = runtimeB.client;

  const ending = refusingRoom(code);
  const endingFile = await stateFixture("room-a", "member-a");
  const runtimeA = new OpenClawRoomRuntime({accountId: "member-a", stateFile: endingFile, baseUrl: "https://room.example/api"},
    {fetchImpl: ending.fetchImpl, logger: quiet});
  await assert.rejects(runtimeA.initialize(), (error) => error?.code === code);

  try {
    // Receive and send of the sibling Room still use its one live state object.
    assert.equal(runtimeB.state, liveState);
    assert.equal(runtimeB.client, liveClient);
    await runtimeB.postAndFinish({roomId: "room-b", text: "Hello from B", idempotencyKey: "ik-b"});
    const post = sibling.calls.find((call) => call.url.endsWith("/messages"));
    assert.ok(post, "the sibling Room's reply is posted");
    assert.equal(post.authorization, "Bearer fixture-room-b");
    assert.equal(runtimeB.state, liveState);
    // The ended Room posted nothing and the sibling's file was not rewritten by it.
    assert.ok(!ending.calls.some((url) => url.endsWith("/messages")));
    const siblingPersisted = JSON.parse(await readFile(siblingFile, "utf8"));
    assert.equal(siblingPersisted.roomId, "room-b");
    assert.equal(siblingPersisted.revoked, undefined);
  } finally {
    await runtimeB.close();
  }
  return JSON.parse(await readFile(endingFile, "utf8"));
}

test("P16 conformance names the shared clause and cases", async () => {
  const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.deepEqual(conformance.parityP16Cases, CASES);
  assert.equal(conformance.parityP16Contract, `docs/delivery-lifecycle-contract-v1.md#${ANCHOR}`);
  const headings = contract.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
  assert.equal(headings.filter((title) => title === HEADING).length, 1);
  const anchors = headings.map((title) => title.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-"));
  assert.ok(anchors.includes(ANCHOR));
  const section = contract.split(`## ${HEADING}`)[1].split("\n## ")[0];
  assert.deepEqual(section.split("\n").filter((line) => line.startsWith("- P16-0")).map((line) => line.slice(2)), CASES);
  for (const clause of ["- P16-1 ", "- P16-2 ", "- P16-3 "]) assert.ok(section.includes(clause));
});

test(CASES[0], async () => {
  const ended = await siblingSurvives("credential_expired");
  // Expiry is not retirement: the ended account can still be renewed.
  assert.equal(ended.revoked, undefined);
});

test(CASES[1], async () => {
  const ended = await siblingSurvives("credential_revoked");
  assert.equal(ended.revoked, true);
  assert.equal(ended.revokedReason, "credential_revoked");
});

// CASES[2] (renewal) is in test/credential-renewal.test.mjs, next to its fixture.

test(CASES[3], async () => {
  const stateFile = await stateFixture("room-a", "member-a");
  const first = refusingRoom("credential_revoked");
  const runtime = new OpenClawRoomRuntime({accountId: "member-a", stateFile, baseUrl: "https://room.example/api"},
    {fetchImpl: first.fetchImpl, logger: quiet});
  await assert.rejects(runtime.initialize(), (error) => error?.code === "credential_revoked");
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.revokedReason, "credential_revoked");
  assert.ok(!first.calls.some((url) => url.endsWith("/messages")));
  const again = refusingRoom("credential_revoked");
  const restarted = new OpenClawRoomRuntime({accountId: "member-a", stateFile, baseUrl: "https://room.example/api"},
    {fetchImpl: again.fetchImpl, logger: quiet});
  await assert.rejects(restarted.initialize(), /disabled, revoked or closed/);
  assert.equal(again.calls.length, 0);
});

test(CASES[4], async () => {
  const stateFile = await stateFixture("room-a", "member-a",
    {revoked: true, revokedReason: "credential_revoked", revokedAt: "2026-11-11T00:00:00.000Z"});
  const room = refusingRoom("credential_expired");
  const runtime = new OpenClawRoomRuntime({accountId: "member-a", stateFile, baseUrl: "https://room.example/api"},
    {fetchImpl: room.fetchImpl, logger: quiet});
  await assert.rejects(runtime.initialize(), /disabled, revoked or closed/);
  assert.equal(room.calls.length, 0);
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.revoked, true);
  assert.equal(persisted.revokedReason, "credential_revoked");
});
