// Owner 2026-11-12, "re-invite a removed agent": the Room server re-admits the existing membership with fresh
// credentials, so the claimed enrollment names an account this gateway already holds. The connector replaces that
// account's state only when it is stale (revoked, or its credential expired) and inert (no delivery intent, no
// credential rotation, no terminal evidence other than posted/skipped/superseded/ignored/cancelled); an active
// account, or a stale one that holds evidence, keeps its state file byte for byte. Parity with Hermes 1.0.104.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime, resetEnrollmentLineages} from "../src/runtime.js";
import {connectorControl} from "../src/connector-control.js";
import {loadState, saveState} from "../src/state.js";

const SOURCE = {
  version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
  credential: "secret-1", identityVersion: 3, clientInstanceId: "client-1", cursor: 5,
};
const STORED = {
  version: 1, baseUrl: "https://room.example/api", roomId: "room-2", membershipId: "member-2",
  credential: "secret-old", credentialExpiresAt: "2099-01-01T00:00:00Z", identityVersion: 3,
  clientInstanceId: "client-1", cursor: 12,
};

async function claim(stored, {liveRuntime = false, listing = [{invitationId: "invite-9", roomId: "room-2"}]} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-readmission-"));
  const sourceFile = join(directory, "default.json");
  const staleFile = join(directory, "member-2.json");
  await saveState(sourceFile, SOURCE);
  await saveState(staleFile, stored);
  const sourceBefore = await readFile(sourceFile);
  const before = await readFile(staleFile);
  const activations = [];
  const claims = [];
  const runtime = new OpenClawRoomRuntime(
    {accountId: "default", stateFile: sourceFile, baseUrl: SOURCE.baseUrl},
    {activateEnrollment: async (activation) => { activations.push({activation, persisted: await loadState(activation.stateFile)}); }},
  );
  runtime.state = {...SOURCE};
  resetEnrollmentLineages();
  runtime.client = {
    connectorEnrollments: async () => listing.map((item) => ({...item})),
    claimConnectorEnrollment: async (_state, invitationId) => (claims.push(invitationId), {
      roomId: "room-2", membershipId: "member-2", credential: "secret-fresh",
      credentialExpiresAt: "2026-12-12T00:00:00Z", identityVersion: 3, headSeq: 40,
    }),
  };
  let closed = 0;
  let old = null;
  if (liveRuntime) {
    old = {account: {stateFile: staleFile}, closed: false, close: async () => { closed += 1; old.closed = true; }};
    connectorControl.runtimes.add(old);
  }
  try {
    const activated = await runtime.acceptConnectorEnrollments();
    return {activated, activations, staleFile, before, closed, claims,
      sourceUnchanged: Buffer.compare(sourceBefore, await readFile(sourceFile)) === 0};
  } finally {
    if (old) connectorControl.runtimes.delete(old);
  }
}

test("a revoked account of a re-admitted membership is replaced with the fresh credential", async () => {
  const result = await claim({...STORED, revoked: true});
  assert.equal(result.activated.length, 1);
  const persisted = await loadState(result.staleFile);
  assert.equal(persisted.credential, "secret-fresh");
  assert.equal(persisted.membershipId, "member-2");
  assert.equal(persisted.revoked, undefined);
  assert.equal(persisted.cursor, 40);
  assert.equal(persisted.clientInstanceId, "client-1");
  assert.equal(result.activations.length, 1, "activated once through the hot reload");
  assert.equal(result.sourceUnchanged, true, "the sibling account is untouched");
});

test("an account whose credential expired is replaced", async () => {
  const result = await claim({...STORED, credentialExpiresAt: "2026-01-01T00:00:00Z"});
  assert.equal((await loadState(result.staleFile)).credential, "secret-fresh");
  assert.equal(result.activations.length, 1);
});

test("a live runtime of the stale account is closed before its state is replaced", async () => {
  const result = await claim({...STORED, revoked: true}, {liveRuntime: true});
  assert.equal(result.closed, 1);
  assert.equal((await loadState(result.staleFile)).credential, "secret-fresh");
});

test("an active account is never replaced", async () => {
  const result = await claim({...STORED});
  assert.deepEqual(result.activated, []);
  assert.deepEqual(result.activations, []);
  assert.equal(Buffer.compare(result.before, await readFile(result.staleFile)), 0);
});

test("a stale account that holds evidence keeps its state file", async () => {
  const intents = {"v1-9": {version: 1, status: "selected", messagePayloadDialect: "v1", identity: {roomId: "room-2", body: "x", sourceEventId: "v1-9"}}};
  for (const stored of [
    {...STORED, revoked: true, deliveryIntents: intents},
    {...STORED, revoked: true, terminalEvidence: {9: {status: "failed", sourceSeq: 9, sourceEventId: "evt-9", reason: "model_error"}}},
    {...STORED, revoked: true, deliveryIntents: {"v1-9": {...intents["v1-9"], status: "quarantined"}}},
  ]) {
    let result;
    try {
      result = await claim(stored);
    } catch (error) {
      // A fixture shape the state validator refuses is a test fault, not a product refusal.
      throw new Error(`fixture rejected: ${error.message}`);
    }
    assert.deepEqual(result.activations, []);
    assert.equal(Buffer.compare(result.before, await readFile(result.staleFile)), 0);
  }
});

// OP-12 R5 B-F009/B-F010: the listed Room decides before the claim, so an ineligible account never consumes the
// invitation (the server membership stays removed) and its state file stays byte for byte.
async function assertNotClaimed(stored, options) {
  const result = await claim(stored, options);
  assert.deepEqual(result.claims, [], "the enrollment must not be claimed");
  assert.deepEqual(result.activations, []);
  assert.equal(Buffer.compare(result.before, await readFile(result.staleFile)), 0);
}

test("B-F009 a stale account holding debt is never claimed", async () => {
  const intents = {"v1-9": {version: 1, status: "selected", messagePayloadDialect: "v1", identity: {roomId: "room-2", body: "x", sourceEventId: "v1-9"}}};
  await assertNotClaimed({...STORED, revoked: true, deliveryIntents: intents});
});

test("B-F009 an active account is never claimed", async () => {
  await assertNotClaimed({...STORED});
});

test("B-F009 a listing without a valid roomId is never claimed", async () => {
  for (const listing of [[{invitationId: "invite-9"}], [{invitationId: "invite-9", roomId: ""}], [{invitationId: "invite-9", roomId: 7}]]) {
    await assertNotClaimed({...STORED, revoked: true}, {listing});
  }
});

test("B-F010 failed terminal evidence is evidence; settled evidence and an expired credential still adopt", async () => {
  await assertNotClaimed({...STORED, revoked: true, terminalEvidence: {9: {status: "failed", sourceSeq: 9, sourceEventId: "evt-9", reason: "model_error"}}});
  for (const stored of [
    {...STORED, revoked: true, terminalEvidence: {9: {status: "posted", sourceSeq: 9, sourceEventId: "evt-9", canonicalEventId: "ev-9"}}},
    {...STORED, credentialExpiresAt: "2026-01-01T00:00:00Z"},
  ]) {
    const result = await claim(stored);
    assert.deepEqual(result.claims, ["invite-9"]);
    assert.equal((await loadState(result.staleFile)).credential, "secret-fresh");
    assert.equal(result.activations.length, 1);
  }
});
