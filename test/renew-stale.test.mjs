import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {RoomAPIError} from "../src/room-client.js";
import {loadState, saveState} from "../src/state.js";

const opaque = () => randomBytes(32).toString("base64url");
const error = (status, code, message, retryable = false) => new RoomAPIError(status, {code, message, retryable});
const expired = () => error(401, "unauthorized", "credential renewal grant expired");

// Reconstruct the actual 0.2.92 writer's save before request/redeem
// (fdd1e78, src/credential-renewal.js). No live account bytes are used.
async function fixture(roomId, phase) {
  const stateFile = join(await mkdtemp(join(tmpdir(), "oc-stale-")), "state.json");
  const binding = {roomId, membershipId: "aura-" + roomId, clientInstanceId: "aura-instance"};
  const expected = {roomId, membershipId: binding.membershipId, identityVersion: 3, displayName: "Aura",
    deliveredSeq: 3221, acknowledgedSeq: 3220};
  const journal = {version: 1, phase, requestId: opaque(), grantSecret: opaque(), replacementCredential: opaque(),
    baseCredential: "fixture-base", clientInstanceId: binding.clientInstanceId, baseCredentialGeneration: 3,
    localCursor: 3220, expected, ...(phase === "prepared" ? {grantId: "fixture-grant"} : {})};
  const state = {...binding, version: 1, baseUrl: "https://fixture.example", installationId: "aura-installation",
    stateRevision: 2, epochSessionRoutingInitialized: true, credential: journal.baseCredential,
    credentialExpiresAt: "2099-01-01T00:00:00Z", cursor: 3220, deliveredCursor: 3221,
    terminalEvidence: {"3221": {sourceEventId: "old-event", sourceSeq: 3221, status: "ignored",
      reason: "self_event", canonicalEventId: "", canonicalSeq: 0, canonicalTs: ""}},
    receiveLedger: {"3221": {eventId: "old-event", status: "ignored"}}, deliveryIntents: {}, credentialRotation: journal};
  await saveState(stateFile, state);
  const runtime = new OpenClawRoomRuntime({accountId: binding.membershipId, stateFile, baseUrl: state.baseUrl});
  runtime.state = await loadState(stateFile);
  const logs = [], statuses = [];
  runtime.logger = {warn: line => logs.push(line)};
  runtime.reportStatus = status => statuses.push(status);
  return {state, stateFile, journal, runtime, logs, statuses, expected};
}

test("RENEW-STALE-01", async () => {
  for (const [roomId, phase] of [["Networks","requested"],["Kabeltracker","prepared"]]) {
    const {state, stateFile, runtime, logs, statuses} = await fixture(roomId, phase);
    runtime.fetchImpl = async url => {
      assert.ok(url.endsWith(phase === "requested" ? "/credential-renewal-requests" : "/fixture-grant/redeem"));
      return Response.json({code:"unauthorized", message:"credential renewal grant expired", retryable:false}, {status:401});
    };
    let registrations = 0;
    runtime.registerConnector = async () => {
      registrations++;
      assert.equal(runtime.client.credential, state.credential);
      assert.equal((await loadState(stateFile)).credentialRotation, undefined);
    };
    runtime.repairPendingLifecycles = runtime.publishPresence = runtime.runHeartbeat = () => {};
    await runtime.initializeOnce();
    assert.equal(registrations, 1);
    const after = await loadState(stateFile);
    for (const key of ["roomId","membershipId","clientInstanceId","installationId","credential","cursor","terminalEvidence","receiveLedger"])
      assert.deepEqual(after[key], state[key]);
    assert.equal(after.renewalClosed.reason, "grant_expired");
    assert.equal(logs.filter(line => line.includes("renewal_grant_expired")).length, 1);
    assert.ok(statuses.some(status => status.errorCode === "renewal_grant_expired"));
  }
});

test("RENEW-STALE-02", async () => {
  const {runtime, stateFile, state, expected} = await fixture("Networks","prepared");
  runtime.client = {redeemCredentialRenewal: async () => {throw expired();}};
  await runtime.renewAccess();
  // Restart between the expired grant and a later owner intent.
  const restarted = new OpenClawRoomRuntime(runtime.account);
  restarted.state = await loadState(stateFile);
  const fresh = {...expected, requestId: opaque(), baseCredentialGeneration: 3, deliveredSeq:3222, acknowledgedSeq:3222,
    state:"owner_requested", expiresAt:"2099-02-01T00:00:00Z"};
  let replacement;
  restarted.client = {
    credentialRenewalIntent: async () => ({request:fresh}),
    requestCredentialRenewal: async (_, body) => {
      assert.equal(body.requestId, fresh.requestId);
      return {...fresh,state:"issued",grantId:"next"};
    },
    redeemCredentialRenewal: async (_, id, body) => {
      assert.equal(id,"next"); replacement=body.replacementCredential; return {...fresh,grantId:id};
    },
    verifyCredentialRenewal: async session => {
      assert.equal(session.credential,replacement);
      return {...fresh,grantId:"next",credentialExpiresAt:fresh.expiresAt};
    },
    confirmCredentialRenewal: async () => ({id:"event-1",type:"credential.renewed",payload:{
      membershipId:state.membershipId,credentialGeneration:4,credentialExpiresAt:fresh.expiresAt}}),
    roomState: async session => {
      assert.equal(session.credential,replacement);
      return {roomId:state.roomId,roster:[fresh]};
    }
  };
  assert.equal(await restarted.renewAccess(),true);
  const saved = await loadState(stateFile);
  assert.equal(saved.cursor,3222);
  assert.equal(saved.credentialRotation, undefined);
  assert.equal(saved.credential,replacement);
  assert.notEqual(saved.credential,state.credential);
  assert.deepEqual(saved.terminalEvidence["3221"],state.terminalEvidence["3221"]);
});

test("RENEW-STALE-03", async () => {
  for (const [status, code, message, reason] of [
    [404,"not_found","room or object not found","request_not_found"],
    [409,"idempotency_mismatch","credential renewal request was rejected","request_rejected"],
    [409,"idempotency_mismatch","credential renewal payload mismatch",null],
    [401,"credential_revoked","base credential was revoked",null],
    [401,"unauthorized","other unauthorized",null],
    [404,"not_found","other resource missing",null],
  ]) {
    const {runtime, stateFile, journal} = await fixture("Kabeltracker","requested");
    const refusal = error(status, code, message);
    runtime.client = {requestCredentialRenewal: async () => {throw refusal;}};
    if (reason) {
      assert.equal(await runtime.renewAccess(),false);
      assert.equal((await loadState(stateFile)).renewalClosed.reason, reason);
    } else {
      await assert.rejects(runtime.renewAccess(),e => e===refusal);
      assert.deepEqual((await loadState(stateFile)).credentialRotation,journal);
    }
  }
});

test("RENEW-STALE-04", async () => {
  const {runtime, stateFile, journal, logs, statuses} = await fixture("Networks","prepared");
  const outage = error(503, "internal", "temporary outage", true);
  let attempts = 0;
  runtime.client = {redeemCredentialRenewal: async () => {attempts++; throw outage;}};
  for (let i=0;i<3;i++) await assert.rejects(runtime.renewAccess(),e => e===outage);
  assert.equal(attempts,3);
  assert.equal(logs.length,1);
  assert.ok(statuses.some(status => status.errorCode === "renewal_retry"));
  assert.deepEqual((await loadState(stateFile)).credentialRotation,journal);
});
