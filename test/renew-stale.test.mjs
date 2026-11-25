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

test("RENEW-STALE-01 grant_expired", async () => {
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

test("RENEW-STALE-02 fresh_intent", async () => {
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

test("RENEW-STALE-03 rejected_or_not_found", async () => {
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

test("RENEW-STALE-04 retryable_failure", async () => {
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

test("legacy missing delivery snapshot and a null discovery still resolve the saved request by ID", async () => {
  const {runtime, stateFile, journal} = await fixture("Networks", "requested");
  delete runtime.state.credentialRotation.expected.deliveredSeq;
  await saveState(stateFile, runtime.state);
  let probes = 0;
  runtime.client = {
    credentialRenewalIntent: async () => ({request: null}),
    requestCredentialRenewal: async (_, body) => {
      assert.equal(body.requestId, journal.requestId);
      probes++;
      throw expired();
    }
  };
  assert.equal(await runtime.renewAccess(), false);
  assert.equal(probes, 1);
  assert.equal((await loadState(stateFile)).renewalClosed.reason, "grant_expired");
});

test("a lost confirm reply must never roll a swapped credential back to the base", async () => {
  const {runtime, journal, stateFile} = await fixture("Networks", "prepared");
  runtime.state.credentialRotation.phase = "swapped";
  runtime.state.credential = journal.replacementCredential;
  await saveState(stateFile, runtime.state);
  runtime.client = {confirmCredentialRenewal: async () => {throw expired();}};
  await assert.rejects(runtime.renewAccess(), RoomAPIError);
  const saved = await loadState(stateFile);
  assert.equal(saved.credential, journal.replacementCredential);
  assert.equal(saved.credentialRotation.phase, "swapped");
  assert.equal(saved.renewalClosed, undefined);
});

test("stale renewal settles despite a frozen post, then normal delivery recovers its original receipt", async () => {
  const sibling = await fixture("neighbour", "requested");
  delete sibling.runtime.state.credentialRotation;
  await saveState(sibling.stateFile, sibling.runtime.state);
  const healthyBefore = await loadState(sibling.stateFile);
  for (const [roomId, phase, terminalState] of [["Networks", "requested", "expired"], ["Kabeltracker", "prepared", "rejected"]]) {
    const {runtime, stateFile, journal, expected, state} = await fixture(roomId, phase);
    const event = {id:"old-source", seq:3224};
    const key = "old-source:final";
    const post = {observedSeq:3224, idempotencyKey:"old-message-key", logicalContributionId:"old-logical-id",
      observedEpochId:"epoch-1", contributionType:"claim", body:"Frozen answer"};
    const intent = {version:2, status:"delivery_pending", deliveryState:"delivery_pending", lifecycleState:"not_started",
      identity:{roomId, body:post.body, replyToId:"", sourceEventId:event.id, sourceEpochId:"epoch-1",
        coordinationMode:"open", nextRecipient:"", initialObservedSeq:3224, postObservedSeq:3224, postObservedEpochId:"epoch-1", initialEpochId:"epoch-1", cycle:null},
      binding:{roomId, membershipId:state.membershipId, clientInstanceId:state.clientInstanceId},
      messagePayloadDialect:"v2", messageIdempotencyKey:post.idempotencyKey, logicalContributionId:post.logicalContributionId, post};
    runtime.state.deliveryIntents[key] = intent;
    await saveState(stateFile, runtime.state);
    runtime.state = await loadState(stateFile);
    const before = structuredClone(runtime.state.deliveryIntents);
    let answer = "issued", reads = 0;
    runtime.client = {
      credentialRenewalRequest: async (session, id) => {
        reads++;
        assert.equal(session.credential,journal.baseCredential);
        assert.equal(id,journal.requestId);
        return {...expected,requestId:id,grantId:journal.grantId,state:answer,baseCredentialGeneration:3};
      },
    };
    assert.equal(await runtime.renewAccess(),false);
    assert.deepEqual((await loadState(stateFile)).credentialRotation,journal,"an active grant must not swap under a pending post");
    answer = terminalState;
    await runtime.renewAccess();
    const settled = await loadState(stateFile);
    assert.equal(reads,2);
    assert.equal(settled.credentialRotation,undefined);
    assert.deepEqual(settled.deliveryIntents,before);
    assert.equal(settled.membershipId,state.membershipId);
    assert.equal(settled.credential,state.credential);
    const resumed = new OpenClawRoomRuntime(runtime.account);
    resumed.state = settled;
    const existing = {id:"existing-post",seq:3225,ts:"2026-08-17T00:00:00Z"};
    let requests = 0;
    resumed.client = {
      roomState: async () => ({headSeq:3225,activeEpoch:{id:"epoch-1"}}),
      postMessage: async (_, payload) => {
        requests++;
        assert.deepEqual(payload,post);
        return existing; // server returns the canonical receipt for this key
      },
    };
    assert.equal(await resumed.recoverPendingDelivery(event),true);
    assert.equal(requests,1);
    assert.equal((await loadState(stateFile)).deliveryIntents[key].canonicalMessage.id,existing.id);
    await resumed.recoverPendingDelivery(event);
    assert.equal(requests,1,"a recorded receipt never re-posts");
  }
  assert.deepEqual(await loadState(sibling.stateFile),healthyBefore);
});
