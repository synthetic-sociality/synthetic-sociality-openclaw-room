import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes, createHash} from "node:crypto";
import {mkdtemp, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {renewCredential} from "../src/credential-renewal.js";
import {loadState, saveState} from "../src/state.js";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {RoomClient} from "../src/room-client.js";

async function fixture() {
  const stateFile = join(await mkdtemp(join(tmpdir(), "oc-renew-")), "state.json");
  const state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    clientInstanceId: "instance-1", credential: "expired-base", credentialExpiresAt: "2020-01-01T00:00:00Z",
    cursor: 7, terminalEvidence: {}, deliveryIntents: {}, installationId: "keep-installation"};
  await saveState(stateFile, state);
  const request = {roomId: state.roomId, membershipId: state.membershipId, displayName: "An agent",
    identityVersion: 2, baseCredentialGeneration: 1, requestId: randomBytes(32).toString("base64url"),
    deliveredSeq: 9, acknowledgedSeq: 7,
    state: "owner_requested", expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const proof = {...request, grantId: "grant-1", deliveredSeq: 9, acknowledgedSeq: 7,
    credentialExpiresAt: "2030-01-01T00:00:00Z"};
  let issued, replacement, confirmed = false;
  const calls = [];
  const client = {
    credentialRenewalIntent: async () => { calls.push("discover"); return {request: confirmed ? null : request}; },
    roomState: async (session) => {
      // Real server authority: expired base is forbidden on ordinary /state.
      assert.notEqual(session.credential, "expired-base");
      assert.equal(session.credential, replacement);
      assert.equal(confirmed, true);
      return {roomId: state.roomId, roster: [proof]};
    },
    requestCredentialRenewal: async (session, body) => {
      const durable = (await loadState(stateFile)).credentialRotation;
      assert.equal(body.requestId, durable.requestId);
      assert.equal(body.clientInstanceId, durable.clientInstanceId);
      assert.equal(body.grantSecretHash, createHash("sha256").update(durable.grantSecret).digest("hex"));
      assert.equal(session.credential, "expired-base");
      if (issued) assert.deepEqual(body, issued);
      issued = body; calls.push("request");
      return {...request, state: "issued", grantId: "grant-1"};
    },
    redeemCredentialRenewal: async (session, grantId, body) => {
      assert.equal(grantId, "grant-1");
      const durable = (await loadState(stateFile)).credentialRotation;
      assert.equal(body.replacementCredential, durable.replacementCredential);
      assert.equal(body.grantSecret, durable.grantSecret);
      if (replacement) assert.equal(body.replacementCredential, replacement);
      replacement = body.replacementCredential; calls.push("redeem"); return proof;
    },
    verifyCredentialRenewal: async (session) => {
      assert.equal(session.credential, replacement); calls.push("verify"); return proof;
    },
    confirmCredentialRenewal: async (session) => {
      assert.equal((await loadState(stateFile)).credential, replacement);
      assert.equal(session.credential, replacement); calls.push("confirm"); confirmed = true;
      return {id: "event-1", type: "credential.renewed", payload: {membershipId: state.membershipId, credentialGeneration: 2, credentialExpiresAt: proof.credentialExpiresAt}};
    },
  };
  return {state, stateFile, request, proof, client, calls};
}

test("owner renewal preserves instance, membership and replay gap; journals before I/O and scrubs after confirmation", async () => {
  const f = await fixture();
  assert.equal(await renewCredential(f), true);
  assert.equal(f.state.cursor, 7);
  assert.equal(f.state.clientInstanceId, "instance-1");
  assert.equal(f.state.installationId, "keep-installation");
  assert.equal(f.state.membershipId, "member-1");
  assert.equal(f.state.displayName, "An agent");
  assert.equal(f.state.credentialRotation, undefined);
  assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(f.state, await loadState(f.stateFile));
  assert.equal(await renewCredential(f), false);
  assert.equal(f.calls.filter((call) => call === "confirm").length, 1);
});

for (const method of ["roomState", "requestCredentialRenewal", "redeemCredentialRenewal", "verifyCredentialRenewal", "confirmCredentialRenewal"]) {
  test(`lost ${method} reply resumes the exact private journal`, async () => {
    const f = await fixture();
    const original = f.client[method];
    let fail = true;
    f.client[method] = async (...args) => {
      const response = await original(...args);
      if (fail) { fail = false; throw new Error("reply lost"); }
      return response;
    };
    await assert.rejects(renewCredential(f), /reply lost/);
    const journal = (await loadState(f.stateFile)).credentialRotation;
    assert.ok(journal);
    f.state = await loadState(f.stateFile);
    assert.equal(await renewCredential(f), true);
    assert.equal(f.state.credential, journal.replacementCredential);
    assert.equal(f.state.credentialRotation, undefined);
  });
}

test("failed final state verification retains confirmed journal and replacement", async () => {
  const f = await fixture();
  const original = f.client.roomState;
  let n = 0;
  f.client.roomState = async (...args) => { if (++n === 1) throw new Error("lost final state"); return original(...args); };
  await assert.rejects(renewCredential(f), /lost final/);
  assert.equal(f.state.credentialRotation.phase, "confirmed");
  assert.equal(await renewCredential(f), true);
  assert.equal(f.calls.filter((call) => call === "confirm").length, 1);
});

for (const mutation of [
  (f) => { f.request.membershipId = "someone-else"; },
  (f) => { f.proof.identityVersion = 999; },
  (f) => { f.proof.acknowledgedSeq = 8; },
  (f) => { f.request.expiresAt = "2020-01-01T00:00:00Z"; },
  (f) => { delete f.request.deliveredSeq; },
  (f) => { f.request.acknowledgedSeq = 8; },
]) {
  test("rejects wrong identity, cursor or expired intent", async () => {
    const f = await fixture(); mutation(f);
    await assert.rejects(renewCredential(f), /evidence mismatch/);
    assert.equal(f.state.credential, "expired-base");
    assert.ok(!f.calls.includes("confirm"));
  });
}

for (const disabled of [{account: {enabled: false}}, {state: {revoked: true}}, {state: {enabled: false}}]) {
  test("never clears intentional disablement or revocation", async () => {
    const f = await fixture();
    if (disabled.state) Object.assign(f.state, disabled.state);
    f.account = disabled.account;
    assert.equal(await renewCredential(f), false);
    assert.deepEqual(f.calls, []);
  });
}

for (const lost of [null, "requestCredentialRenewal", "redeemCredentialRenewal", "verifyCredentialRenewal", "confirmCredentialRenewal", "roomState"]) {
  test(`quarantine and gap evidence survive renewal, lost reply=${lost}`, async () => {
    const f = await fixture();
    f.state.quarantined = true;
    f.state.deliveryIntents = {"source-8:final": {
      version: 2, status: "quarantined", deliveryState: "quarantined", lifecycleState: "not_started",
      messagePayloadDialect: "v1",
      identity: {roomId: "room-1", sourceEventId: "source-8", body: "retained draft"},
      binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "instance-1"},
    }};
    f.state.terminalEvidence = {"9": {sourceSeq: 9, sourceEventId: "source-9", status: "ignored", reason: "technical"}};
    await saveState(f.stateFile, f.state);
    const before = structuredClone(f.state);
    if (lost) {
      const original = f.client[lost];
      let fail = true;
      f.client[lost] = async (...args) => {
        const result = await original(...args);
        if (fail) { fail = false; throw new Error("lost reply"); }
        return result;
      };
      await assert.rejects(renewCredential(f), /lost reply/);
      f.state = await loadState(f.stateFile);
    }
    assert.equal(await renewCredential(f), true);
    for (const key of ["quarantined", "deliveryIntents", "terminalEvidence", "cursor", "clientInstanceId", "membershipId"])
      assert.deepEqual(f.state[key], before[key]);
    assert.equal(f.state.credentialRotation, undefined);
    assert.ok(f.calls.includes("confirm"));
  });
}

test("external state writer prevents renewal overwriting local cursor", async () => {
  const f = await fixture();
  await saveState(f.stateFile, {...f.state, cursor: 8});
  await assert.rejects(renewCredential(f), /evidence mismatch/);
  assert.equal((await loadState(f.stateFile)).cursor, 8);
});

for (const legacy of ["none", "bound-v1", "unbound-v1", "stale-binding-v1"]) {
test(`renewed runtime scans past quarantine and never replays on restart (${legacy})`, async () => {
  const f = await fixture();
  f.state.epochSessionRoutingInitialized = true;
  f.state.legacySessionEpochId = "epoch-1";
  f.state.deliveryIntents = {"source-8:final": {
    version: 2, status: "quarantined", deliveryState: "quarantined", lifecycleState: "not_started",
    messagePayloadDialect: "v1",
    identity: {roomId: "room-1", sourceEventId: "source-8", body: "isolated draft"},
    binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "instance-1"},
  }};
  if (legacy !== "none") {
    const intent = f.state.deliveryIntents["source-8:final"];
    intent.version = 1;
    delete intent.deliveryState;
    if (legacy === "unbound-v1") delete intent.binding;
    if (legacy === "stale-binding-v1") intent.binding.clientInstanceId = "previous-instance";
  }
  await saveState(f.stateFile, f.state);
  const quarantine = structuredClone(f.state.deliveryIntents);
  const maintenance = new OpenClawRoomRuntime({stateFile: f.stateFile});
  maintenance.state = f.state;
  maintenance.client = f.client;
  maintenance.pendingEvent = {id: "source-8", seq: 8};
  assert.equal(await maintenance.renewAccess(), true);
  assert.equal(maintenance.pendingEvent, null);
  await maintenance.close();
  const events = [
    {id: "source-8", seq: 8, type: "message.posted", actorRole: "human_owner", payload: {body: "old", epochId: "epoch-1"}},
    {id: "source-9", seq: 9, type: "credential.renewed", payload: {}},
    {id: "source-10", seq: 10, type: "message.posted", actorRole: "human_owner", payload: {body: "new", epochId: "epoch-1"}},
  ];
  for (const restarted of [false, true]) {
    const runtime = new OpenClawRoomRuntime({stateFile: f.stateFile});
    runtime.state = await loadState(f.stateFile);
    runtime.initialize = async () => {};
    runtime.renewAccess = async () => false;
    runtime.maintainPresence = async () => {};
    const reads = [], dispatched = [];
    const controller = new AbortController();
    runtime.client = {
      readEvents: async (_state, cursor) => {
        reads.push(cursor);
        const page = events.filter((e) => e.seq > cursor).slice(0, 1);
        if (!page.length) controller.abort();
        return {activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: page};
      },
      acknowledge: async () => { throw new Error("must not acknowledge across isolated source 8"); },
    };
    runtime.markContextAcknowledged = async (event) => { dispatched.push(event.id); };
    runtime.prepareCycleAttempt = async () => null;
    runtime.sharedRoomContext = async () => "canonical context";
    const iterator = runtime.assignedTurns(controller.signal);
    const result = await iterator.next();
    if (!restarted) {
      assert.equal(result.value.sourceEventId, "source-10");
      assert.deepEqual(dispatched, ["source-10"]);
      // A caller completes the new turn independently of the old gap.
      await runtime.recordTerminalEvidence(events[2], "skipped", {reason: "explicit_pass"});
      await runtime.ackEvent(events[2]);
      assert.equal(runtime.pendingEvent, null);
      assert.equal((await iterator.next()).done, true);
    } else {
      assert.equal(result.done, true);
      assert.deepEqual(dispatched, []);
    }
    assert.deepEqual(reads, [7, 8, 9, 10]);
    assert.equal(runtime.state.cursor, 7);
    assert.deepEqual(runtime.state.deliveryIntents, quarantine);
    assert.ok(runtime.state.terminalEvidence["9"]);
    assert.ok(runtime.state.terminalEvidence["10"]);
    await runtime.close();
  }
});
}

test("optional HTML discovery cannot kill runtime or invoke a model", async () => {
  const f = await fixture();
  const runtime = new OpenClawRoomRuntime({stateFile: f.stateFile});
  runtime.state = f.state;
  runtime.client = new RoomClient({baseUrl: f.state.baseUrl, fetchImpl: async () => new Response("<html>old app</html>")});
  assert.equal(await runtime.renewAccess(), false);
  assert.equal(runtime.state.credential, "expired-base");
  assert.equal(runtime.state.credentialRotation, undefined);
  await runtime.close();
});

test("binding gate drains outbound work before renewal; active delivered turn defers it", async () => {
  const f = await fixture();
  const runtime = new OpenClawRoomRuntime({stateFile: f.stateFile});
  runtime.state = f.state; runtime.client = f.client;
  let release;
  const blocked = runtime.withBindingOperation(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const renewal = runtime.renewAccess();
  await Promise.resolve();
  assert.deepEqual(f.calls, []);
  release(); await blocked; assert.equal(await renewal, true);
  runtime.lastRenewalCheck = 0; runtime.pendingEvent = {id: "in-flight"};
  const previous = f.calls.length;
  assert.equal(await runtime.renewAccess(), false);
  assert.equal(f.calls.length, previous);
  await runtime.close();
});

test("HTTP renewal methods bind the exact public route, instance and credential; claim accepts server 201", async () => {
  const captured = [];
  const client = new RoomClient({baseUrl: "https://room.example/api", fetchImpl: async (url, init) => {
    captured.push({url, init});
    return new Response("{}", {status: url.endsWith("/credential-renewal-requests") ? 201 : 200});
  }});
  const base = {roomId: "room-1", clientInstanceId: "instance-1", credential: "old"};
  const replacement = {...base, credential: "new"};
  await client.credentialRenewalIntent(base);
  await client.requestCredentialRenewal(base, {requestId: "request", grantSecretHash: "hash", clientInstanceId: base.clientInstanceId});
  await client.redeemCredentialRenewal(base, "grant", {grantSecret: "secret", replacementCredential: "new"});
  await client.verifyCredentialRenewal(replacement, "grant");
  await client.confirmCredentialRenewal(replacement, "grant");
  assert.equal(captured[0].url, "https://room.example/api/rooms/room-1/credential-renewal-intent?clientInstanceId=instance-1");
  assert.deepEqual(captured.map((c) => c.init.headers.Authorization), ["Bearer old", "Bearer old", "Bearer old", "Bearer new", "Bearer new"]);
  assert.deepEqual(captured.map((c) => c.init.method), ["GET", "POST", "POST", "GET", "POST"]);
  assert.equal(JSON.parse(captured[1].init.body).clientInstanceId, "instance-1");
  assert.equal(captured[4].url, "https://room.example/api/rooms/room-1/credential-renewal-grants/grant/confirm");
  assert.ok(captured.every((c) => c.init.redirect === "error"));
});

test("enabled expired native account keeps renewal-only discovery alive and hot-registers its replacement", async () => {
  const f = await fixture();
  let offered = false, waits = 0, registrations = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const session = {...f.state, credential: init.headers.Authorization?.slice(7)};
    const body = init.body && JSON.parse(init.body);
    let response, status = 200;
    if (path.endsWith("/credential-renewal-intent")) response = {request: offered ? f.request : null};
    else if (path.endsWith("/credential-renewal-requests")) { response = await f.client.requestCredentialRenewal(session, body); status = 201; }
    else if (path.endsWith("/redeem")) response = await f.client.redeemCredentialRenewal(session, "grant-1", body);
    else if (path.endsWith("/verify")) response = await f.client.verifyCredentialRenewal(session);
    else if (path.endsWith("/confirm")) { response = await f.client.confirmCredentialRenewal(session); offered = false; }
    else if (path.endsWith("/state")) response = await f.client.roomState(session);
    else if (path.endsWith("/connector/sessions")) {
      registrations++;
      if (session.credential === "expired-base") { response = {code: "credential_expired"}; status = 401; }
      else response = {sessionId: "fresh-session", heartbeatIntervalSeconds: 15, capabilities: []};
    } else if (path.endsWith("/activity")) response = {acceptedStreamSeq: body.streamSeq};
    else throw new Error("Unexpected route");
    return new Response(JSON.stringify(response), {status});
  };
  const runtime = new OpenClawRoomRuntime({stateFile: f.stateFile, enabled: true}, {
    fetchImpl, waitForRenewal: true,
    renewalWait: async (milliseconds) => { assert.equal(milliseconds, 30_000); offered = true; waits++; },
  });
  try {
    const registered = await runtime.initialize();
    assert.equal(registered.sessionId, "fresh-session");
    assert.equal(waits, 1); assert.equal(registrations, 2);
    assert.equal(runtime.state.credentialRotation, undefined);
    assert.equal(runtime.state.cursor, 7);
    assert.equal(runtime.state.clientInstanceId, "instance-1");
  } finally { await runtime.close(); }
});
