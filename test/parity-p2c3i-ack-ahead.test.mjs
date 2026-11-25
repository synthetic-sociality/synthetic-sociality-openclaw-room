// Shared conformance cases for contract P2c-3i (a Room acknowledgement ahead of
// the local cursor is adopted, not a reconnect loop; paired with Hermes 1.0.118).
// Case names are identical in the Hermes and OpenClaw conformance.json files.
// Fixture: the Berlin trace in Digital sovereignty (duev8o1h936bl9f, 20-25 Nov
// 2026): acknowledged cursor 3220, terminal evidence only for 3221 (ignored),
// Room acknowledgedSeq 3222. Before the fix every acknowledgement of 3221 threw
// "exceeded the locally proven contiguous frontier". No test uses a real
// credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {createHash} from "node:crypto";
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

const home = await mkdtemp(join(tmpdir(), "openclaw-room-p2c3i-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const {OpenClawRoomRuntime} = await import("../src/runtime.js");
const {loadState, saveState} = await import("../src/state.js");
const {RenewalClosed, renewCredential} = await import("../src/credential-renewal.js");
const {AckFrontierConflict} = await import("../src/recovery.js");
const {randomBytes} = await import("node:crypto");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = [
  "ACK-AHEAD-01 adopt",
  "ACK-AHEAD-02 one_warning",
  "ACK-AHEAD-03 behind_errors",
  "ACK-AHEAD-04 non_int_errors",
  "ACK-AHEAD-05 restart_keeps_cursor",
  "ACK-AHEAD-06 renewal_resumes",
  "ACK-AHEAD-07 expired_intent_ends_cleanly",
];
const P2C3I = "The Room is the authority for the member's acknowledged frontier. A connector may only be behind it and catches up by adopting; only a connector ahead of the Room is an error. Wherever the connector meets the Room's acknowledgedSeq (the acknowledgement answer, a reconnect or replay, the scan, a restart, the credential-renewal preflight and each renewal verification), one reconciliation per connector applies: equal needs no change; an integer acknowledgedSeq above the local frontier (from an earlier instance, a fence or a lost state write) is adopted as a fence: every sequence up to and including it that has no terminal evidence is recorded as terminal \"ignored\" with reason room_ack_ahead, existing terminal evidence stays unchanged, the acknowledged cursor moves to acknowledgedSeq and is persisted, one warning is logged per room per adoption, and normal delivery continues from acknowledgedSeq + 1 with no retryable error, no reconnect and no renewal retry. An acknowledgedSeq below the local frontier, one that is missing or not an integer, or a delivered sequence below it or below the local read cursor, is the one conflict ack_frontier_mismatch and changes nothing. During a credential renewal the adoption also renews the journal's expected and protected cursors. An owner-initiated renewal whose request expired before it was issued closes its journal without changing the credential, records the reason and reports that a new owner Renew is needed; it is not retried. Reconciliation is per room and per membership and needs no owner action.";
// The card's block, markers included (handover/ackahead-p2c3i.txt).
const P2C3I_BLOCK_SHA256 = "917c297d29da2b2282106a459f6ae223561f00024c42f02b2ff5aea9c8fc6b2e";
const ROOM = "duev8o1h936bl9f";

const ignored = (seq, reason = "not_assigned_or_technical") => ({status: "ignored", sourceEventId: `ev${seq}`, sourceSeq: seq,
  canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason});

function berlinState(extra = {}) {
  return {
    version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId: "member-1",
    credential: `room-cred-TEST-${"5a".repeat(16)}`, clientInstanceId: "client-1", cursor: 3220, stateRevision: 2,
    appliedRecoveryClosures: {}, deliveryIntents: {}, deliveredCursor: 3221,
    terminalEvidence: {"3221": ignored(3221)},
    receiveLedger: {"3221": {eventId: "ev3221", status: "ignored"}},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "ep22", rotateCurrentEpochSession: false,
    ...extra,
  };
}

// The acknowledgement route only; `answer` builds the Room's reply for a requested seq.
function fakeRoom(answer) {
  const room = {acks: []};
  room.acknowledge = async (_state, seq) => { room.acks.push(seq); return answer(seq); };
  return room;
}
const roomMax = (held) => (seq) => ({acknowledgedSeq: Math.max(seq, held)});

async function account(state, name) {
  const directory = await mkdtemp(join(home, `${name}-`));
  const accounts = join(directory, "synthetic-sociality-room", "accounts");
  await mkdir(accounts, {recursive: true, mode: 0o700});
  const file = join(accounts, "member-1.json");
  await saveState(file, state);
  return file;
}

async function runtimeAt(stateFile, room) {
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = room;
  runtime.logs = [];
  const log = (level) => (line) => runtime.logs.push({level, line});
  runtime.logger = {info: log("info"), warn: log("warn"), error: log("error")};
  return runtime;
}

const runtimeFor = async (state, room, name) => runtimeAt(await account(state, name), room);
const warnings = (runtime) => runtime.logs.filter((item) => item.level !== "info");

// --- conformance -----------------------------------------------------------

test("P2c-3i conformance: shared case names and the exact contract paragraph after P2c-3h", async () => {
  assert.deepEqual(conformance.parityP2c3iCases, CASES);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const name of CASES) {
    assert.ok(sources.some((source) => source.includes(`test(${JSON.stringify(name)},`) || source.includes(`test(\`${name}`)), name);
  }
  assert.equal(createHash("sha256").update(`<<<P2c-3i\n${P2C3I}\nP2c-3i>>>\n`).digest("hex"), P2C3I_BLOCK_SHA256);
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.ok(contract.includes(`optional forensics.\nP2c-3h>>>\n\n<<<P2c-3i\n${P2C3I}\nP2c-3i>>>\n\n<<<P2c-3j\n`));
  assert.equal(contract.split("<<<P2c-3i").length, 2);
  assert.equal(createHash("sha256").update(contract).digest("hex"), conformance.contractSha256);
});

// --- cases -------------------------------------------------------------------

test("ACK-AHEAD-01 adopt", async (t) => {
  await t.test("the replayed 3221 acknowledgement adopts the Room's 3222 as a fence", async () => {
    const room = fakeRoom(roomMax(3222));
    const runtime = await runtimeFor(berlinState(), room, "adopt");
    const before = structuredClone(runtime.state.terminalEvidence["3221"]);
    runtime.pendingEvent = {id: "ev3221", seq: 3221};
    await runtime.ackEvent({id: "ev3221", seq: 3221});
    assert.deepEqual(room.acks, [3221]);
    assert.equal(runtime.state.cursor, 3222);
    assert.equal(runtime.state.terminalEvidence["3222"].status, "ignored");
    assert.equal(runtime.state.terminalEvidence["3222"].reason, "room_ack_ahead");
    assert.equal(runtime.state.terminalEvidence["3222"].sourceSeq, 3222);
    assert.deepEqual(runtime.state.terminalEvidence["3221"], before);
    assert.equal(runtime.pendingEvent, null);
    // Delivery continues from 3223: the next completion acknowledges it alone.
    runtime.state.terminalEvidence["3223"] = ignored(3223);
    await runtime.ackEvent({id: "ev3223", seq: 3223});
    assert.deepEqual(room.acks, [3221, 3223]);
    assert.equal(runtime.state.cursor, 3223);
  });
  await t.test("existing evidence inside the adopted range is kept", async () => {
    const room = fakeRoom(roomMax(3224));
    const state = berlinState();
    state.terminalEvidence["3223"] = ignored(3223, "self_event");
    state.receiveLedger["3222"] = {eventId: "ev3222", status: "received"};
    const runtime = await runtimeFor(state, room, "kept");
    await runtime.ackEvent({id: "ev3221", seq: 3221});
    assert.deepEqual(room.acks, [3221]);
    assert.equal(runtime.state.cursor, 3224);
    assert.deepEqual(runtime.state.terminalEvidence["3223"], ignored(3223, "self_event"));
    assert.equal(runtime.state.terminalEvidence["3222"].sourceEventId, "ev3222");
    for (const seq of ["3222", "3224"]) {
      assert.equal(runtime.state.terminalEvidence[seq].status, "ignored");
      assert.equal(runtime.state.terminalEvidence[seq].reason, "room_ack_ahead");
    }
  });
});

test("ACK-AHEAD-02 one_warning", async () => {
  const room = fakeRoom(roomMax(3222));
  const runtime = await runtimeFor(berlinState(), room, "warn");
  await runtime.ackEvent({id: "ev3221", seq: 3221});
  assert.equal(warnings(runtime).length, 1);
  assert.equal(warnings(runtime)[0].level, "warn");
  assert.match(warnings(runtime)[0].line, /room_ack_ahead/);
  assert.match(warnings(runtime)[0].line, new RegExp(ROOM));
  // The next polls replay the same events; nothing more is logged or sent.
  await runtime.ackEvent({id: "ev3221", seq: 3221});
  await runtime.ackEvent({id: "ev3222", seq: 3222}).catch(() => {});
  assert.equal(warnings(runtime).length, 1);
  assert.deepEqual(room.acks, [3221]);
  assert.equal(runtime.state.cursor, 3222);
});

test("ACK-AHEAD-03 behind_errors", async () => {
  const room = fakeRoom(() => ({acknowledgedSeq: 3220}));
  const runtime = await runtimeFor(berlinState(), room, "behind");
  await assert.rejects(runtime.ackEvent({id: "ev3221", seq: 3221}), /locally proven contiguous frontier/);
  assert.equal(runtime.state.cursor, 3220);
  assert.equal(runtime.state.terminalEvidence["3222"], undefined);
});

test("ACK-AHEAD-04 non_int_errors", async () => {
  for (const answer of [undefined, null, {}, {acknowledgedSeq: null}, {acknowledgedSeq: "3222"},
    {acknowledgedSeq: 3222.5}, {acknowledgedSeq: true}, {acknowledgedSeq: Number.MAX_SAFE_INTEGER + 2}]) {
    const room = fakeRoom(() => answer);
    const runtime = await runtimeFor(berlinState(), room, "nonint");
    await assert.rejects(runtime.ackEvent({id: "ev3221", seq: 3221}), /locally proven contiguous frontier/, JSON.stringify(answer));
    assert.equal(runtime.state.cursor, 3220);
    assert.equal(runtime.state.terminalEvidence["3222"], undefined);
  }
});

test("ACK-AHEAD-05 restart_keeps_cursor", async (t) => {
  await t.test("a restart after adoption keeps 3222 and acknowledges nothing again", async () => {
    const stateFile = await account(berlinState(), "restart");
    const first = await runtimeAt(stateFile, fakeRoom(roomMax(3222)));
    await first.ackEvent({id: "ev3221", seq: 3221});
    const saved = await loadState(stateFile);
    assert.equal(saved.cursor, 3222);
    assert.equal(saved.terminalEvidence["3222"].reason, "room_ack_ahead");
    assert.deepEqual(saved.terminalEvidence["3221"], ignored(3221));
    const room = fakeRoom(roomMax(3222));
    const second = await runtimeAt(stateFile, room);
    await second.ackEvent({id: "ev3221", seq: 3221});
    assert.deepEqual(room.acks, []);
    assert.equal(warnings(second).length, 0);
    assert.equal((await loadState(stateFile)).cursor, 3222);
  });
  await t.test("another membership's state is untouched", async () => {
    const mine = await account(berlinState(), "mine");
    const other = await account(berlinState({roomId: "room-other", membershipId: "member-2"}), "other");
    await (await runtimeAt(mine, fakeRoom(roomMax(3222)))).ackEvent({id: "ev3221", seq: 3221});
    assert.equal((await loadState(mine)).cursor, 3222);
    const untouched = await loadState(other);
    assert.equal(untouched.cursor, 3220);
    assert.equal(untouched.terminalEvidence["3222"], undefined);
  });
});

// --- r1: renewal (ACK-AHEAD-06/07) and the site matrix -------------------------

const REQUEST_ID = randomBytes(32).toString("base64url");

function berlinExpired() {
  return berlinState({credential: "expired-base", credentialExpiresAt: "2020-01-01T00:00:00Z", installationId: "inst-1"});
}

// One fake Room's renewal routes. `room` holds the answers ({ack, ackAfterConfirm,
// delivered, state, loseRequest}) and records the calls.
function renewalClient(room) {
  room.calls ??= [];
  const answer = () => ({roomId: ROOM, membershipId: "member-1", displayName: "Berlin", identityVersion: 3,
    baseCredentialGeneration: 1, requestId: REQUEST_ID,
    deliveredSeq: room.confirmed && room.deliveredAfterConfirm !== undefined ? room.deliveredAfterConfirm : room.delivered ?? 3222,
    acknowledgedSeq: room.confirmed && room.ackAfterConfirm !== undefined ? room.ackAfterConfirm : room.ack});
  return {
    credentialRenewalIntent: async () => {
      room.calls.push("discover");
      return {request: room.confirmed ? null : {...answer(), acknowledgedSeq: room.discoverAck ?? room.ack,
        state: "owner_requested", expiresAt: new Date(Date.now() + 60_000).toISOString()}};
    },
    requestCredentialRenewal: async () => {
      room.calls.push("request");
      if (room.loseRequest) { room.loseRequest = false; throw new Error("lost reply"); }
      if (room.state === "expired") return {roomId: ROOM, membershipId: "member-1", requestId: REQUEST_ID, state: "expired"};
      return {...answer(), state: "issued", grantId: "grant-1"};
    },
    redeemCredentialRenewal: async (_session, _grant, body) => {
      room.calls.push("redeem"); room.replacement = body.replacementCredential;
      return {...answer(), grantId: "grant-1"};
    },
    verifyCredentialRenewal: async () => {
      room.calls.push("verify");
      return {...answer(), grantId: "grant-1", credentialExpiresAt: "2099-01-01T00:00:00Z"};
    },
    confirmCredentialRenewal: async () => {
      room.calls.push("confirm"); room.confirmed = true;
      return {id: "event-1", type: "credential.renewed",
        payload: {membershipId: "member-1", credentialGeneration: 2, credentialExpiresAt: "2099-01-01T00:00:00Z"}};
    },
    roomState: async (session) => {
      assert.equal(room.confirmed, true, "an expired base never reads ordinary /state");
      assert.equal(session.credential, room.replacement);
      room.calls.push("state");
      return {roomId: ROOM, roster: [answer()]};
    },
    acknowledge: async (_state, seq) => ({acknowledgedSeq: Math.max(seq, room.ack)}),
  };
}

// Berlin's state file with an owner journal in phase requested: expected and
// local cursor 3220 (the request reply was lost while the Room said 3220).
async function berlinJournal(name) {
  const stateFile = await account(berlinExpired(), name);
  const state = await loadState(stateFile);
  const room = {ack: 3220, delivered: 3221, loseRequest: true};
  await assert.rejects(renewCredential({state, stateFile, client: renewalClient(room)}), /lost reply/);
  const saved = await loadState(stateFile);
  assert.equal(saved.credentialRotation.phase, "requested");
  assert.equal(saved.credentialRotation.localCursor, 3220);
  assert.equal(saved.credentialRotation.expected.acknowledgedSeq, 3220);
  return stateFile;
}

async function renew(stateFile, room) {
  const runtime = await runtimeAt(stateFile, renewalClient(room));
  const changed = await renewCredential({state: runtime.state, stateFile, client: runtime.client, logger: runtime.logger});
  return {runtime, changed};
}

test("ACK-AHEAD-06 renewal_resumes", async (t) => {
  await t.test("Berlin's owner journal at 3220 resumes and completes with the Room at 3222", async () => {
    const stateFile = await berlinJournal("renew06");
    const room = {ack: 3222};
    const {runtime, changed} = await renew(stateFile, room);
    assert.equal(changed, true);
    const saved = await loadState(stateFile);
    assert.equal(saved.credentialRotation, undefined);
    assert.equal(saved.credential, room.replacement);
    assert.equal(saved.cursor, 3222);
    assert.equal(saved.terminalEvidence["3222"].reason, "room_ack_ahead");
    assert.deepEqual(saved.terminalEvidence["3221"], ignored(3221));
    assert.deepEqual(room.calls, ["request", "redeem", "verify", "confirm", "state"]);
    assert.equal(warnings(runtime).filter((item) => /room_ack_ahead/.test(item.line)).length, 1);
  });
  await t.test("a Room behind the journal is still the one conflict", async () => {
    const stateFile = await berlinJournal("renew06b");
    await assert.rejects(renew(stateFile, {ack: 3219}), (error) => error instanceof AckFrontierConflict && error.code === "ack_frontier_mismatch");
    const saved = await loadState(stateFile);
    assert.equal(saved.cursor, 3220);
    assert.equal(saved.credentialRotation.phase, "requested");
  });
  await t.test("the runtime renews once and then has nothing to retry (no scan failure loop)", async () => {
    const stateFile = await berlinJournal("renew06c");
    const room = {ack: 3222};
    const runtime = await runtimeAt(stateFile, renewalClient(room));
    assert.equal(await runtime.renewAccess(), true);
    assert.equal(runtime.state.cursor, 3222);
    runtime.lastRenewalCheck = 0;
    assert.equal(await runtime.renewAccess(), false);
    assert.deepEqual(room.calls, ["request", "redeem", "verify", "confirm", "state", "discover"]);
  });
});

test("ACK-AHEAD-07 expired_intent_ends_cleanly", async (t) => {
  await t.test("an expired owner request closes the journal with its reason", async () => {
    const stateFile = await berlinJournal("renew07");
    const room = {ack: 3222, state: "expired"};
    await assert.rejects(renew(stateFile, room), (error) => error instanceof RenewalClosed && error.reason === "owner_request_expired"
      && /new owner Renew/.test(error.message));
    const saved = await loadState(stateFile);
    assert.equal(saved.credentialRotation, undefined);
    assert.equal(saved.renewalClosed.reason, "owner_request_expired");
    assert.equal(saved.renewalClosed.requestId, REQUEST_ID);
    assert.equal(saved.credential, "expired-base");
    assert.deepEqual(room.calls, ["request"]);
  });
  await t.test("the runtime ends cleanly, says a new owner Renew is needed, and does not retry", async () => {
    const stateFile = await berlinJournal("renew07b");
    const room = {ack: 3222, state: "expired", confirmed: true};
    const runtime = await runtimeAt(stateFile, renewalClient(room));
    assert.equal(await runtime.renewAccess(), false);
    assert.ok(warnings(runtime).some((item) => /new owner Renew is needed/.test(item.line)));
    for (let i = 0; i < 3; i += 1) {
      runtime.lastRenewalCheck = 0;
      assert.equal(await runtime.renewAccess(), false);
    }
    assert.deepEqual(room.calls, ["request", "discover", "discover", "discover"]);
  });
});

// ROOT-CAUSE RULE (r1): every site where a Room acknowledgement meets a local
// cursor. Local 3220, evidence 3221 (ignored), Room 3222: the same adoption
// everywhere; Room 3219: the same conflict code everywhere, nothing changes.
async function scanOnce(runtime) {
  const controller = new AbortController();
  runtime.connectorSession = {sessionId: "s"};
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.client.readEvents = async () => {
    controller.abort(new Error("end of test pass"));
    throw controller.signal.reason;
  };
  await assert.rejects(runtime.assignedTurns(controller.signal).next(), /end of test pass/);
}

const SITES = {
  live_ack: async (ack) => {
    const runtime = await runtimeFor(berlinState(), fakeRoom(() => ({acknowledgedSeq: ack})), "m-live");
    await runtime.ackEvent({id: "ev3221", seq: 3221});
    return runtime;
  },
  reconnect: async (ack) => {
    const runtime = await runtimeFor(berlinState(), fakeRoom(() => ({acknowledgedSeq: ack})), "m-reconnect");
    await scanOnce(runtime);
    return runtime;
  },
  renewal_preflight: async (ack) => {
    const stateFile = await account(berlinExpired(), "m-preflight");
    const room = {ack, delivered: 3222, loseRequest: true};
    const runtime = await runtimeAt(stateFile, renewalClient(room));
    try {
      await renewCredential({state: runtime.state, stateFile, client: runtime.client, logger: runtime.logger});
    } catch (error) {
      if (!/lost reply/.test(error.message)) throw error;
    }
    assert.equal(room.calls.at(-1), "request");
    return runtime;
  },
  renewal_active_state: async (ack) => {
    const stateFile = await berlinJournal("m-active");
    const {runtime} = await renew(stateFile, {ack: 3220, delivered: 3221, ackAfterConfirm: ack, deliveredAfterConfirm: 3222});
    return runtime;
  },
  stuck_scan: async (ack) => {
    const runtime = await runtimeFor(berlinState(), fakeRoom(() => ({acknowledgedSeq: ack})), "m-stuck");
    await runtime.applyStuckEvents();
    return runtime;
  },
  restart_load: async (ack) => {
    const stateFile = await account(berlinState(), "m-restart");
    const runtime = await runtimeAt(stateFile, fakeRoom(() => ({acknowledgedSeq: ack})));
    await runtime.ackEvent({id: "ev3221", seq: 3221});
    return runtimeAt(stateFile, runtime.client);
  },
};

test("P2c-3i site matrix: every site adopts a Room ahead the same way", async (t) => {
  for (const [site, run] of Object.entries(SITES)) {
    await t.test(site, async () => {
      const runtime = await run(3222);
      const saved = await loadState(runtime.account.stateFile);
      for (const state of [runtime.state, saved]) {
        assert.equal(state.cursor, 3222, site);
        assert.equal(state.terminalEvidence["3222"].reason, "room_ack_ahead", site);
        assert.deepEqual(state.terminalEvidence["3221"], ignored(3221), site);
      }
    });
  }
});

test("P2c-3i site matrix: every site reports a Room behind as the one conflict", async (t) => {
  for (const [site, run] of Object.entries(SITES)) {
    await t.test(site, async () => {
      let code = "";
      let runtime;
      try {
        runtime = await run(3219);
      } catch (error) {
        code = error?.code ?? "";
      }
      if (runtime) code = runtime.logs.some((item) => /ack_frontier_mismatch/.test(item.line)) ? "ack_frontier_mismatch" : code;
      assert.equal(code, "ack_frontier_mismatch", site);
    });
  }
});

// OP-12 r3 F1 parity column: a Room acknowledgement that is a string, a
// fraction or missing is the one conflict at every site, never adopted. (In
// JavaScript 3222.0 is the integer 3222, so the fraction is 3222.5.)
test("P2c-3i site matrix: every site reports a non-integer Room acknowledgement as the one conflict", async (t) => {
  for (const [site, run] of Object.entries(SITES)) {
    for (const value of ["3222", 3222.5, null]) {
      await t.test(`${site} ${JSON.stringify(value)}`, async () => {
        let code = "";
        let runtime;
        try {
          runtime = await run(value);
        } catch (error) {
          code = error?.code ?? "";
        }
        if (runtime) {
          code = runtime.logs.some((item) => /ack_frontier_mismatch/.test(item.line)) ? "ack_frontier_mismatch" : code;
          assert.equal(runtime.state.cursor, 3220, `${site} ${value}: nothing adopted`);
        }
        assert.equal(code, "ack_frontier_mismatch", `${site} ${value}`);
      });
    }
  }
});
