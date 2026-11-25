// Shared conformance cases for contract P2c-3j (an expired base credential
// never waits for work that needs a valid credential; paired with Hermes
// 1.0.118). Case names are identical in the Hermes and OpenClaw
// conformance.json files. Live finding (25 Nov 2026, Aura in Networks and
// Kabeltracker, OpenClaw 0.2.92): an owner Renew never started because
// renewalBlocked counted delivery_pending and lifecycle_blocked intents, and
// those could never drain without a valid credential. The intents are built by
// the real postAndFinish path; no real credential, no live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {createHash, randomBytes} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {registerHooks} from "node:module";

const sdkMocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/reply-payload": "export const isReplyPayloadNonTerminalToolErrorWarning = () => false;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sdkMocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(sdkMocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(join(tmpdir(), "openclaw-room-p2c3j-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const {OpenClawRoomRuntime} = await import("../src/runtime.js");
const {RoomAPIError, RoomTransportError} = await import("../src/room-client.js");
const {loadState, saveState} = await import("../src/state.js");
const {renewalBlocked} = await import("../src/credential-renewal.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = [
  "RENEW-INFLIGHT-01 delivery_pending",
  "RENEW-INFLIGHT-02 lifecycle_blocked",
  "RENEW-INFLIGHT-03 valid_credential_unchanged",
];
const P2C3J = "An expired base credential never waits for work that needs a valid credential to finish. When the base credential has expired (its stored expiry has passed, or the Room refused it as credential_expired), unfinished delivery intents and lifecycle work (delivery pending, lifecycle pending or blocked) do not block an owner-initiated renewal: the connector renews first and keeps every intent and its frozen bytes unchanged through the exchange. After the renewal is confirmed, delivery intents resume through their normal replay with the new credential, and lifecycle work that was blocked only because the Room refused the credential as expired is reopened once for automatic retry with a fresh attempt budget; work blocked for any other reason stays blocked, and quarantined work stays under P2c-3h. While the base credential is still valid, the existing quiescence rule is unchanged: unfinished work blocks renewal until it drains. A binding disabled for any other reason than credential expiry, a revoked binding or one under the owner-control fence never renews under this rule.";
// The card's block, markers included (handover/ackahead-p2c3j.txt).
const P2C3J_BLOCK_SHA256 = "12562226cb850af791e70a554e0156e4dee36ad73032a888dc2931e09ee4089d";
const ROOM = "room-aura";
const MEMBER = "member-aura";
const KEY = "source-8:final";
const TS = "2026-11-25T06:00:00Z";

function auraState(extra = {}) {
  return {
    version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId: MEMBER,
    credential: "expired-base", credentialExpiresAt: "2020-01-01T00:00:00Z", clientInstanceId: "client-1",
    cursor: 7, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {}, ...extra,
  };
}

// The real delivery path builds the in-flight intent Aura held.
async function withIntent(kind, code = "credential_expired") {
  const builder = new OpenClawRoomRuntime({accountId: "builder", stateFile: join(home, "unused.json"), baseUrl: "https://room.example/api"});
  builder.state = auraState();
  builder.markTurnPreparing = async () => {};
  builder.markTurnPosted = async () => {};
  builder.persistState = async () => {};
  builder.client = {
    roomState: async () => ({headSeq: 8, activeEpoch: {id: "epoch-1"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    postMessage: async () => {
      if (kind === "delivery_pending") throw new RoomTransportError("network unreachable");
      return {id: "posted-9", seq: 9, ts: TS};
    },
    completeDiscussionAttempt: async () => { throw new RoomAPIError(401, {code, retryable: false}); },
  };
  builder.pendingEvent = {id: "source-8", seq: 8};
  const request = {roomId: ROOM, text: "Frozen answer", replyToId: "human-8", idempotencyKey: KEY, sourceEventId: "source-8"};
  if (kind === "delivery_pending") {
    await assert.rejects(builder.postAndFinish(request));
  } else {
    await builder.postAndFinish({...request, cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}, settled: false}});
  }
  const intent = builder.state.deliveryIntents[KEY];
  assert.equal(intent.status, kind === "delivery_pending" ? "delivery_pending" : "lifecycle_blocked", "fixture intent");
  return builder.state;
}

// The renewal routes of one fake Room for an owner Renew (owner intent, grant, swap, confirm).
function renewalRoom() {
  const room = {calls: [], confirmed: false};
  const requestId = randomBytes(32).toString("base64url");
  const identity = {roomId: ROOM, membershipId: MEMBER, displayName: "Aura", identityVersion: 2,
    baseCredentialGeneration: 1, requestId, deliveredSeq: 9, acknowledgedSeq: 7};
  room.client = {
    credentialRenewalIntent: async () => {
      room.calls.push("discover");
      return {request: room.confirmed ? null : {...identity, state: "owner_requested", expiresAt: new Date(Date.now() + 60_000).toISOString()}};
    },
    requestCredentialRenewal: async () => { room.calls.push("request"); return {...identity, state: "issued", grantId: "grant-1"}; },
    redeemCredentialRenewal: async (_session, _grant, body) => {
      room.calls.push("redeem"); room.replacement = body.replacementCredential; return {...identity, grantId: "grant-1"};
    },
    verifyCredentialRenewal: async () => { room.calls.push("verify"); return {...identity, grantId: "grant-1", credentialExpiresAt: "2099-01-01T00:00:00Z"}; },
    confirmCredentialRenewal: async () => {
      room.calls.push("confirm"); room.confirmed = true;
      return {id: "event-1", type: "credential.renewed", payload: {membershipId: MEMBER, credentialGeneration: 2, credentialExpiresAt: "2099-01-01T00:00:00Z"}};
    },
    roomState: async (session) => {
      if (room.confirmed && session?.credential === room.replacement && room.calls.at(-1) === "confirm") {
        room.calls.push("state");
        return {roomId: ROOM, roster: [identity]};
      }
      return {headSeq: 8, activeEpoch: {id: "epoch-1"}};
    },
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
  };
  return room;
}

async function runtimeFor(state, room, name, {expiredByRoom = false} = {}) {
  const directory = await mkdtemp(join(home, `${name}-`));
  const accounts = join(directory, "synthetic-sociality-room", "accounts");
  await mkdir(accounts, {recursive: true, mode: 0o700});
  const stateFile = join(accounts, "member-aura.json");
  await saveState(stateFile, state);
  const runtime = new OpenClawRoomRuntime({accountId: "member-aura", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = room.client;
  runtime.credentialExpired = expiredByRoom;
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  return runtime;
}

// --- conformance -----------------------------------------------------------

test("P2c-3j conformance: shared case names and the exact contract paragraph after P2c-3i", async () => {
  assert.deepEqual(conformance.parityP2c3jCases, CASES);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const name of CASES) {
    assert.ok(sources.some((source) => source.includes(`test(${JSON.stringify(name)},`)), name);
  }
  assert.equal(createHash("sha256").update(`<<<P2c-3j\n${P2C3J}\nP2c-3j>>>\n`).digest("hex"), P2C3J_BLOCK_SHA256);
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.ok(contract.includes(`\nP2c-3i>>>\n\n<<<P2c-3j\n${P2C3J}\nP2c-3j>>>\n\nP2c-4 Local status.`));
  assert.equal(contract.split("<<<P2c-3j").length, 2);
  assert.equal(createHash("sha256").update(contract).digest("hex"), conformance.contractSha256);
});

// --- cases -------------------------------------------------------------------

test("RENEW-INFLIGHT-01 delivery_pending", async (t) => {
  for (const [label, extra, expiredByRoom] of [
    ["stored expiry passed", {}, false],
    ["the Room refused the credential as credential_expired", {credentialExpiresAt: "2099-01-01T00:00:00Z"}, true],
  ]) {
    await t.test(`renews first, then the frozen delivery resumes with the new credential (${label})`, async () => {
      const state = {...await withIntent("delivery_pending"), ...extra};
      const before = structuredClone(state.deliveryIntents[KEY]);
      const room = renewalRoom();
      const runtime = await runtimeFor(state, room, "inflight01", {expiredByRoom});
      assert.equal(await runtime.renewAccess(), true);
      const saved = await loadState(runtime.account.stateFile);
      assert.equal(saved.credential, room.replacement);
      assert.equal(saved.credentialRotation, undefined);
      assert.deepEqual(saved.deliveryIntents[KEY], before, "the intent and its frozen bytes are unchanged by the exchange");
      assert.deepEqual(room.calls, ["discover", "request", "redeem", "verify", "confirm", "state"]);
      // The registration on the renewed credential ends the Room's stop
      // (P2c-3d, registerConnector); then the normal replay resumes the intent:
      // the same frozen post, the new credential.
      runtime.credentialExpired = false;
      const posts = [];
      runtime.client = {...room.client, postMessage: async (session, body) => {
        posts.push({credential: session.credential, body: structuredClone(body)});
        return {id: "posted-9", seq: 9, ts: TS};
      }};
      assert.equal(await runtime.recoverPendingDelivery({id: "source-8", seq: 8}), true);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].credential, room.replacement);
      assert.equal(posts[0].body.idempotencyKey, before.post.idempotencyKey);
      assert.equal(posts[0].body.body, "Frozen answer");
      assert.equal(runtime.state.deliveryIntents[KEY].deliveryState, "posted");
    });
  }
});

test("RENEW-INFLIGHT-01 delivery_pending: a lost confirm reply resumes after the swap", async () => {
  const state = await withIntent("delivery_pending");
  const before = structuredClone(state.deliveryIntents[KEY]);
  const room = renewalRoom();
  const confirm = room.client.confirmCredentialRenewal;
  let lost = true;
  room.client.confirmCredentialRenewal = async (...args) => {
    if (lost) { lost = false; room.calls.push("confirm-lost"); throw new RoomTransportError("lost reply"); }
    return confirm(...args);
  };
  const runtime = await runtimeFor(state, room, "inflight01b");
  await assert.rejects(runtime.renewAccess(), RoomTransportError);
  const swapped = await loadState(runtime.account.stateFile);
  assert.equal(swapped.credentialRotation.phase, "swapped");
  assert.equal(swapped.credentialRotation.baseExpired, true);
  assert.equal(swapped.credentialExpiresAt, "2099-01-01T00:00:00Z", "after the swap the state carries the replacement's expiry");
  runtime.lastRenewalCheck = 0;
  assert.equal(await runtime.renewAccess(), true);
  const saved = await loadState(runtime.account.stateFile);
  assert.equal(saved.credentialRotation, undefined);
  assert.deepEqual(saved.deliveryIntents[KEY], before);
});

test("RENEW-INFLIGHT-02 lifecycle_blocked", async (t) => {
  await t.test("lifecycle blocked by credential_expired: renewal completes and the lifecycle retries once with the new credential", async () => {
    const state = await withIntent("lifecycle_blocked");
    const room = renewalRoom();
    const runtime = await runtimeFor(state, room, "inflight02");
    assert.equal(await runtime.renewAccess(), true);
    const saved = await loadState(runtime.account.stateFile);
    assert.equal(saved.credential, room.replacement);
    const intent = saved.deliveryIntents[KEY];
    assert.equal(intent.status, "lifecycle_pending");
    assert.equal(intent.lifecycleState, "pending");
    assert.equal(intent.lifecycleAutomaticRetry, true);
    assert.equal(intent.lifecycleAttempts, 0);
    assert.equal(intent.canonicalMessage.id, "posted-9");
    const completions = [];
    runtime.client = {...room.client, completeDiscussionAttempt: async (session, cycleId, attemptId, payload) => {
      completions.push({credential: session.credential, cycleId, attemptId, payload});
    }};
    await runtime.repairPendingLifecycles();
    assert.equal(completions.length, 1);
    assert.equal(completions[0].credential, room.replacement);
    assert.deepEqual([completions[0].cycleId, completions[0].attemptId, completions[0].payload.eventId], ["cycle-1", "attempt-1", "posted-9"]);
    assert.equal(runtime.state.deliveryIntents[KEY].lifecycleState, "complete");
  });
  await t.test("lifecycle blocked for another reason: renewal still completes, the intent stays blocked", async () => {
    const state = await withIntent("lifecycle_blocked", "cycle_conflict");
    const before = structuredClone(state.deliveryIntents[KEY]);
    const room = renewalRoom();
    const runtime = await runtimeFor(state, room, "inflight02b");
    assert.equal(await runtime.renewAccess(), true);
    assert.deepEqual((await loadState(runtime.account.stateFile)).deliveryIntents[KEY], before);
  });
});

test("RENEW-INFLIGHT-03 valid_credential_unchanged", async (t) => {
  await t.test("a valid credential: unfinished work still blocks renewal before discovery", async () => {
    for (const kind of ["delivery_pending", "lifecycle_blocked"]) {
      const state = {...await withIntent(kind), credential: "valid-base", credentialExpiresAt: "2099-01-01T00:00:00Z"};
      const room = renewalRoom();
      const runtime = await runtimeFor(state, room, "inflight03");
      assert.equal(renewalBlocked(runtime.state, runtime.account), true, kind);
      assert.equal(await runtime.renewAccess(), false, kind);
      assert.deepEqual(room.calls, [], kind);
      assert.equal((await loadState(runtime.account.stateFile)).credential, "valid-base");
    }
  });
  await t.test("expired but disabled or revoked: still blocked", async () => {
    const state = await withIntent("delivery_pending");
    assert.equal(renewalBlocked({...state, revoked: true}, {}, {baseExpired: true}), true);
    assert.equal(renewalBlocked({...state, enabled: false}, {}, {baseExpired: true}), true);
    assert.equal(renewalBlocked(state, {enabled: false}, {baseExpired: true}), true);
    assert.equal(renewalBlocked(state, {}, {baseExpired: true}), false);
  });
});
