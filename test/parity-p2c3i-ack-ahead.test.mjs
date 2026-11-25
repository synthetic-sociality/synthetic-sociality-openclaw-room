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

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = [
  "ACK-AHEAD-01 adopt",
  "ACK-AHEAD-02 one_warning",
  "ACK-AHEAD-03 behind_errors",
  "ACK-AHEAD-04 non_int_errors",
  "ACK-AHEAD-05 restart_keeps_cursor",
];
const P2C3I = "When the Room answers an acknowledgement with an acknowledgedSeq that is an integer greater than the frontier the connector acknowledged, the Room already holds that acknowledgement (from an earlier instance, a fence or a lost state write) and the connector adopts it as a fence instead of treating it as a mismatch. Every sequence up to and including acknowledgedSeq that has no terminal evidence is recorded as terminal \"ignored\" with reason room_ack_ahead; existing terminal evidence for those sequences stays unchanged. The connector moves its acknowledged cursor to acknowledgedSeq, persists it, logs one warning per room per adoption and continues normal delivery from acknowledgedSeq + 1; it raises no retryable error and does not reconnect, and a later equal answer logs nothing. An acknowledgedSeq below the frontier, or one that is missing or not an integer, remains the error ack_frontier_mismatch. Adoption is per room and per membership and needs no owner action.";
// The card's block, markers included (handover/ackahead-p2c3i.txt).
const P2C3I_BLOCK_SHA256 = "760f6be0bc71319c4e906545c00df4314c354e35f8927498407cd82da626d361";
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
  assert.ok(contract.includes(`optional forensics.\nP2c-3h>>>\n\n<<<P2c-3i\n${P2C3I}\nP2c-3i>>>\n\nP2c-4 Local status.`));
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
