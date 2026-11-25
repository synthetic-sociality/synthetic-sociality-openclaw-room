// Shared conformance cases for contract P2c-3h (stuck events never hold a
// cursor; paired with Hermes 1.0.117). Case names are identical in the Hermes
// and OpenClaw conformance.json files. Fixtures use the trace seqs of R&C-2
// (25 Nov 2026): Zurie 2654/2662 (epoch 21 closed, cycle cy2a958b47fa979,
// cycle_attempt_ready), Real 2933 and Wu 2987 (message.posted, epoch 22),
// Berlin 3223 (peer.acknowledged, epoch 22); the cursors sit one below. No test
// uses a real credential or talks to a live Room; the clock is node:test's.
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

const home = await mkdtemp(join(tmpdir(), "openclaw-room-p2c3h-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const {OpenClawRoomRuntime} = await import("../src/runtime.js");
const {RoomAPIError, RoomTransportError} = await import("../src/room-client.js");
const {loadState, saveState, validateState} = await import("../src/state.js");
const recovery = await import("../src/recovery.js");
const {LocalStatus} = await import("../src/local-status.js");
const {renewalBlocked} = await import("../src/credential-renewal.js");
const {storedWorkInProgress} = await import("../src/connector-control.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = [
  "STK-01 epoch_closed",
  "STK-02 cycle_terminal",
  "STK-03 cycle_superseded",
  "STK-04 age",
  "STK-05 hole_epoch_closed",
  "STK-06 inflight",
  "STK-07 retry_pending",
  "STK-08 under_24h",
  "STK-09 canonical_receipt",
  "STK-10 open_epoch_hole",
  "STK-11 reason_grammar",
  "STK-12 terminal_set_parity",
];
const P2C3H = "A Room event that the connector has quarantined never holds the member's acknowledgement frontier indefinitely. On every scan, a quarantined event at the frontier with no delivery attempt in flight becomes stuck when (a) the Room proves its epoch closed or its cycle terminal or superseded, or (b) it has been quarantined for at least 24 hours with no retry pending. A sequence at the frontier with no local evidence at all becomes stuck only under (a), with reason hole_epoch_closed; open-epoch holes still hold the frontier. Stuck is a terminal state: the connector writes terminal evidence \"stuck\" with reason stuck:<trigger>:<original code>, where trigger is one of epoch_closed, cycle_terminal, cycle_superseded, age or hole_epoch_closed and original code is the prior lastErrorCode or the literal none. It keeps the intent and event bytes unchanged as audited evidence; for hole_epoch_closed, where no local bytes exist, it persists the Room's epoch-closed proof bytes as that evidence. It replays nothing, deletes nothing, and then advances the frontier by the normal contiguous walk. A delivery with a complete canonical receipt is never stuck. The terminal-state set is defined once per connector and every terminal check (frontier walk, retention, renewal quiescence, owner-control fence) uses it. Local status reports stuckSeqs with reasons and counts; the connector reports execution failure code events_stuck with the count and last stuck sequence. Recovery verbs remain available as optional forensics.";
// The common brief's block, markers included (p2c3h.txt).
const P2C3H_BLOCK_SHA256 = "80258410ef966588e98c06d2dc7014ae7743588b7a02fee3c91badf860d93368";

const NOW = Date.parse("2026-11-25T02:00:00Z");
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const CYCLE = "cy2a958b47fa979";
const BINDING = {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"};
const EPOCHS = (active = "ep22") => [
  {id: "ep21", startsAtSeq: 2500, status: active === "ep21" ? "active" : "closed"},
  {id: "ep22", startsAtSeq: 2900, status: active === "ep22" ? "active" : "closed"},
];
const epochOf = (seq) => (seq >= 2900 ? "ep22" : "ep21");

// The Room's events at the trace seqs, by seq (the payload carries no body).
function roomEvent(seq, type, extra = {}) {
  const payload = type === "discussion.cycle_attempt_ready"
    ? {cycleId: CYCLE, generation: 1, membershipId: "member-1", attemptId: `at${seq}`}
    : type === "peer.acknowledged" ? {sourceEventId: `ev${seq - 1}`} : {epochId: epochOf(seq)};
  return {id: `ev${seq}`, seq, type, ts: iso(NOW - 48 * HOUR), payload, ...extra};
}

// The read-only Room routes a proof uses, plus the acknowledgement.
function fakeRoom({active = "ep22", events = [], cycle = {state: "running", generation: 1}, fail = null} = {}) {
  const room = {reads: [], acks: []};
  const step = async (kind) => {
    room.reads.push(kind);
    if (fail?.(kind)) throw new RoomTransportError("network unreachable");
  };
  Object.assign(room, {
    listEpochs: async () => { await step("epochs"); return {epochs: EPOCHS(active)}; },
    readEpochEvents: async (_state, afterSeq, epochId) => {
      await step("events");
      return {events: events.filter((item) => item.seq > afterSeq && epochOf(item.seq) === epochId).slice(0, 10).map((item) => structuredClone(item)),
        deliveredSeq: 3300};
    },
    roomState: async () => { await step("state"); return {activeEpoch: {id: active, startsAtSeq: active === "ep22" ? 2900 : 2500}}; },
    getDiscussionCycle: async (_state, cycleId) => { await step("cycle"); return {id: cycleId, ...cycle}; },
    acknowledge: async (_state, seq) => { room.acks.push(seq); return {acknowledgedSeq: seq}; },
  });
  return room;
}

function quarantined(eventId, code, {quarantinedAt, canonicalMessage} = {}) {
  return {version: 2, status: "quarantined", deliveryState: "quarantined", lifecycleState: "not_started", deliveryErrorCode: code,
    deliveryError: code ? `${code}: refused` : "", ...(quarantinedAt === undefined ? {} : {quarantinedAt}),
    ...(canonicalMessage ? {canonicalMessage} : {}),
    identity: {roomId: "room-1", body: "kept", replyToId: "", sourceEventId: eventId, cycle: null, resolveRecipientMentions: false},
    binding: {...BINDING}, messagePayloadDialect: "v2", logicalContributionId: "lc", requestIdempotencyKey: "r",
    messageIdempotencyKey: "m", finishIdempotencyKey: "f"};
}

const ignored = (seq) => ({status: "ignored", sourceEventId: `ev${seq}`, sourceSeq: seq,
  canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "not_assigned_or_technical"});

// cursor, quarantined [[seq, code, options]], evidence seqs (ignored).
function traceState({cursor, quarantine = [], evidence = []}) {
  const state = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    credential: `room-cred-TEST-${"5a".repeat(16)}`, clientInstanceId: "client-1", cursor, stateRevision: 2,
    appliedRecoveryClosures: {}, deliveryIntents: {}, terminalEvidence: {}, receiveLedger: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "ep22", rotateCurrentEpochSession: false,
  };
  for (const [seq, code, options] of quarantine) {
    state.deliveryIntents[`ev${seq}:final`] = quarantined(`ev${seq}`, code, options);
    state.receiveLedger[String(seq)] = {eventId: `ev${seq}`, status: "quarantined"};
  }
  for (const seq of evidence) {
    state.terminalEvidence[String(seq)] = ignored(seq);
    state.receiveLedger[String(seq)] = {eventId: `ev${seq}`, status: "ignored"};
  }
  state.deliveredCursor = Math.max(cursor, ...Object.keys(state.receiveLedger).map(Number));
  return state;
}

async function account(state, name) {
  const directory = await mkdtemp(join(home, `${name}-`));
  const accounts = join(directory, "synthetic-sociality-room", "accounts");
  await mkdir(accounts, {recursive: true, mode: 0o700});
  const file = join(accounts, "member-1.json");
  await saveState(file, state);
  return file;
}

async function runtimeFor(state, room, name) {
  const stateFile = await account(state, name);
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = await loadState(stateFile);
  runtime.client = room;
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.status = new LocalStatus(join(stateFile, "..", "..", "status.json"), {plugin: "openclaw", version: "test", hostLabel: "h"});
  runtime.statusFile = join(stateFile, "..", "..", "status.json");
  return runtime;
}

// One pass of the real scan loop: everything before the event read runs, the
// read itself ends the pass.
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

const stuckRecords = (runtime) => readFile(recovery.journalPath(runtime.account.stateFile), "utf8")
  .then((text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.verb === "stuck"), () => []);

function clock(t, at = NOW) {
  t.mock.timers.enable({apis: ["Date"], now: at});
  return (ms) => t.mock.timers.tick(ms);
}

// --- conformance -----------------------------------------------------------

test("P2c-3h conformance: shared case names, verified feature and the exact contract paragraph", async () => {
  assert.deepEqual(conformance.parityP2c3hCases, CASES);
  assert.match(String(conformance.verifiedFeatures?.stuckEvents ?? ""), /^0\.2\.92_p2c3h_/);
  assert.equal(conformance.stuckEventsRegression?.base, "9afd34c");
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const name of CASES) {
    assert.ok(sources.some((source) => source.includes(`test(${JSON.stringify(name)},`) || source.includes(`test(\`${name}`)), name);
  }
  assert.equal(createHash("sha256").update(`<<<P2c-3h\n${P2C3H}\nP2c-3h>>>\n`).digest("hex"), P2C3H_BLOCK_SHA256);
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  // The block's exact bytes, markers included, directly after P2c-3f (P2c-3g
  // is reserved by the batch-acks lane), byte-identical to the Hermes contract.
  assert.ok(contract.includes(`re-admission rules permit it.\n\n<<<P2c-3h\n${P2C3H}\nP2c-3h>>>\n\n<<<P2c-3i\n`));
  assert.equal(createHash("sha256").update(contract).digest("hex"), conformance.contractSha256);
});

// --- (a) the Room's proof ----------------------------------------------------

test("STK-01 epoch_closed", async (t) => {
  clock(t);
  // Zurie, Digital sovereignty: 2654 and 2662 quarantined in epoch 21 (closed).
  const state = traceState({cursor: 2653, quarantine: [[2654, "stale_context", {quarantinedAt: iso(NOW - 2 * HOUR)}], [2662, "", {quarantinedAt: iso(NOW - 2 * HOUR)}]],
    evidence: [2655, 2656, 2657, 2658, 2659, 2660, 2661, 2663, 2664]});
  const intentsBefore = structuredClone(state.deliveryIntents);
  const room = fakeRoom({events: [roomEvent(2654, "discussion.cycle_attempt_ready"), roomEvent(2662, "discussion.cycle_attempt_ready")]});
  const runtime = await runtimeFor(state, room, "zurie");
  await scanOnce(runtime);
  assert.deepEqual(room.acks, [2661, 2664], "2654 and then 2662 are stuck; the walk acknowledges the contiguous frontier");
  assert.equal(runtime.state.cursor, 2664);
  assert.deepEqual(runtime.state.deliveryIntents, intentsBefore, "the intents are kept unchanged");
  const records = await stuckRecords(runtime);
  assert.deepEqual(records.map((record) => [record.seq, record.eventId, record.reason]),
    [[2654, "ev2654", "stuck:epoch_closed:stale_context"], [2662, "ev2662", "stuck:epoch_closed:none"]]);
  for (const record of records) {
    assert.equal(record.proof.eventEpochStatus, "closed");
    assert.equal(record.proof.activeEpochId, "ep22");
    assert.equal(record.eventEpochId, "ep21");
    assert.equal(record.recordDigest, recovery.recordDigest(record));
  }
  assert.ok(!(await readFile(recovery.journalPath(runtime.account.stateFile), "utf8")).includes("room-cred-TEST"));
  assert.ok(room.reads.filter((read) => read === "events").length >= 2);
  // Local status: stuckSeqs with reasons and counts; execution failure events_stuck.
  runtime.reportLedger();
  const entry = JSON.parse(await readFile(runtime.statusFile, "utf8")).memberships["member-1"];
  assert.deepEqual(entry.stuckSeqs, [2654, 2662]);
  assert.deepEqual(entry.stuckReasons, {"2654": "stuck:epoch_closed:stale_context", "2662": "stuck:epoch_closed:none"});
  assert.equal(entry.stuckCount, 2);
  assert.deepEqual(entry.stuckCounts, {epoch_closed: 2});
  assert.deepEqual(entry.executionFailure, {layer: "runtime", code: "events_stuck", count: 2, lastSeq: 2662});
  assert.deepEqual(runtime.stuckExecutionFailure(), {layer: "runtime", code: "events_stuck", count: 2, lastSeq: 2662});
  assert.equal(runtime.logs.filter((line) => line.includes("events_stuck")).length, 2);
  validateState(await loadState(runtime.account.stateFile));
});

test("STK-01 epoch_closed: the wrong-seq guard frees nothing when the Room's event at the frontier is another event", async (t) => {
  clock(t);
  const state = traceState({cursor: 2653, quarantine: [[2654, "stale_context", {quarantinedAt: iso(NOW - 2 * HOUR)}], [2662, "", {quarantinedAt: iso(NOW - 2 * HOUR)}]],
    evidence: [2655, 2656, 2657, 2658, 2659, 2660, 2661]});
  // The Room's 2654 is not the quarantined source; 2662 (provable) is not at the frontier.
  const room = fakeRoom({events: [roomEvent(2654, "discussion.cycle_attempt_ready", {id: "ev-other"}), roomEvent(2662, "discussion.cycle_attempt_ready")]});
  const runtime = await runtimeFor(state, room, "zurie-guard");
  const before = JSON.stringify(runtime.state);
  await scanOnce(runtime);
  assert.deepEqual(room.acks, []);
  assert.equal(runtime.state.cursor, 2653);
  assert.equal(JSON.stringify(runtime.state), before);
  assert.deepEqual(await stuckRecords(runtime), []);
});

test("STK-02 cycle_terminal", async (t) => {
  clock(t);
  const state = traceState({cursor: 2932, quarantine: [[2933, "attempt_not_active", {quarantinedAt: iso(NOW - HOUR)}]], evidence: [2934]});
  const room = fakeRoom({events: [roomEvent(2933, "discussion.cycle_attempt_ready")], cycle: {state: "interrupted", generation: 1}});
  const runtime = await runtimeFor(state, room, "cycle-terminal");
  await runtime.applyStuckEvents();
  assert.deepEqual(room.acks, [2934]);
  const [record] = await stuckRecords(runtime);
  assert.deepEqual([record.seq, record.reason, record.proof.cycleId, record.proof.cycleState], [2933, "stuck:cycle_terminal:attempt_not_active", CYCLE, "interrupted"]);
  assert.equal(runtime.state.deliveryIntents["ev2933:final"].deliveryState, "quarantined");
});

test("STK-03 cycle_superseded", async (t) => {
  clock(t);
  const state = traceState({cursor: 2932, quarantine: [[2933, "cycle_superseded", {quarantinedAt: iso(NOW - HOUR)}]], evidence: [2934, 2935]});
  const room = fakeRoom({events: [roomEvent(2933, "discussion.cycle_attempt_ready")], cycle: {state: "running", generation: 3}});
  const runtime = await runtimeFor(state, room, "cycle-superseded");
  await runtime.applyStuckEvents();
  assert.deepEqual(room.acks, [2935]);
  const [record] = await stuckRecords(runtime);
  assert.deepEqual([record.seq, record.reason, record.proof.cycleGeneration, record.proof.eventGeneration], [2933, "stuck:cycle_superseded:cycle_superseded", 3, 1]);
});

// --- (b) age -------------------------------------------------------------------

const AGE_TRACES = [
  // Real 2933 quarantined since 12 Nov, Wu 2987 since 18 Nov, Berlin 3223 since 24 Nov (00:00Z).
  {name: "Real", seq: 2933, type: "message.posted", since: Date.parse("2026-11-12T09:00:00Z"), code: "validation_error"},
  {name: "Wu", seq: 2987, type: "message.posted", since: Date.parse("2026-11-18T15:30:00Z"), code: "stale_context"},
  {name: "Berlin", seq: 3223, type: "peer.acknowledged", since: Date.parse("2026-11-24T00:00:00Z"), code: ""},
];

for (const item of AGE_TRACES) {
  test(`STK-04 age: ${item.name} ${item.seq} (epoch 22 open) is stuck after 24 h and only ${item.seq} is freed`, async (t) => {
    clock(t);
    const state = traceState({cursor: item.seq - 1, quarantine: [[item.seq, item.code, {quarantinedAt: iso(item.since)}]], evidence: [item.seq + 1, item.seq + 2]});
    // Only the frontier is a candidate; the seqs above it already have evidence.
    const room = fakeRoom({events: [roomEvent(item.seq, item.type, {ts: iso(item.since)})]});
    const runtime = await runtimeFor(state, room, `age-${item.name}`);
    await runtime.applyStuckEvents();
    assert.deepEqual(room.acks, [item.seq + 2]);
    const records = await stuckRecords(runtime);
    assert.deepEqual(records.map((record) => [record.seq, record.eventId, record.reason]),
      [[item.seq, `ev${item.seq}`, `stuck:age:${item.code || "none"}`]]);
    assert.equal(records[0].quarantinedAt, iso(item.since));
    assert.equal(runtime.state.deliveryIntents[`ev${item.seq}:final`].quarantinedAt, iso(item.since), "the intent is kept unchanged");
  });

  test(`STK-04 age: migration of a pre-0.2.92 ${item.name} state: the first scan stamps the intent and it is stuck 24 h later`, async (t) => {
    const advance = clock(t);
    const state = traceState({cursor: item.seq - 1, quarantine: [[item.seq, item.code]], evidence: [item.seq + 1]});
    // The Room's event is days old: it is never the quarantine clock.
    const room = fakeRoom({events: [roomEvent(item.seq, item.type, {ts: iso(item.since)})]});
    const runtime = await runtimeFor(state, room, `migrate-${item.name}`);
    await scanOnce(runtime);
    assert.deepEqual(room.acks, []);
    assert.equal(runtime.state.cursor, item.seq - 1);
    assert.equal(runtime.state.deliveryIntents[`ev${item.seq}:final`].quarantinedAt, iso(NOW), "the first scan stamps the age clock");
    assert.equal((await loadState(runtime.account.stateFile)).deliveryIntents[`ev${item.seq}:final`].quarantinedAt, iso(NOW), "durably");
    advance(24 * HOUR - 60_000);
    await scanOnce(runtime);
    assert.deepEqual(room.acks, [], "under 24 h after the stamp");
    advance(60_000);
    await scanOnce(runtime);
    assert.deepEqual(room.acks, [item.seq + 1]);
    assert.equal(runtime.state.cursor, item.seq + 1, `the cursor leaves ${item.seq - 1}`);
    const [record] = await stuckRecords(runtime);
    assert.deepEqual([record.seq, record.reason, record.quarantinedAt, record.ageSource],
      [item.seq, `stuck:age:${item.code || "none"}`, iso(NOW), "quarantinedAt"]);
  });

  test(`STK-04 age: a pre-0.2.92 ${item.name} intent with its own recorded failure time is aged from that time`, async (t) => {
    clock(t);
    const state = traceState({cursor: item.seq - 1, quarantine: [[item.seq, item.code]], evidence: [item.seq + 1]});
    state.deliveryIntents[`ev${item.seq}:final`].lifecycleFailedAt = iso(item.since);
    const room = fakeRoom({events: [roomEvent(item.seq, item.type, {ts: iso(item.since)})]});
    const runtime = await runtimeFor(state, room, `failed-at-${item.name}`);
    await scanOnce(runtime);
    assert.deepEqual(room.acks, [item.seq + 1]);
    assert.equal(runtime.state.deliveryIntents[`ev${item.seq}:final`].quarantinedAt, undefined, "no stamp: the intent is kept unchanged");
    const [record] = await stuckRecords(runtime);
    assert.deepEqual([record.seq, record.reason, record.quarantinedAt, record.ageSource],
      [item.seq, `stuck:age:${item.code || "none"}`, iso(item.since), "lifecycleFailedAt"]);
  });
}

test("STK-04 age: a new quarantine is stamped on the intent", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile: join(home, "unused-stamp.json"), baseUrl: "https://room.example/api"});
  runtime.state = traceState({cursor: 10});
  runtime.state.messagePayloadDialect = "v2";
  runtime.persistState = async () => {};
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.client = {
    roomState: async () => ({headSeq: 20, activeEpoch: {id: "ep22", startsAtSeq: 1}}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    requestTurn: async () => ({state: "granted", turnId: "turn-1"}),
    finishTurn: async () => ({}),
    postMessage: async () => { throw new RoomAPIError(409, {code: "validation_error", retryable: false}); },
  };
  const before = Date.now();
  await runtime.postAndFinish({roomId: "room-1", text: "reply", replyToId: "", idempotencyKey: "ev11:final", sourceEventId: "ev11"}).catch(() => {});
  const intent = runtime.state.deliveryIntents["ev11:final"];
  assert.equal(intent.deliveryState, "quarantined");
  assert.ok(Date.parse(intent.quarantinedAt) >= before - 1000 && Date.parse(intent.quarantinedAt) <= Date.now() + 1000);
  validateState(runtime.state);
});

// --- holes -----------------------------------------------------------------

test("STK-05 hole_epoch_closed", async (t) => {
  clock(t);
  // 2701 has no ledger entry and no evidence; 2702-2703 are done; epoch 21 closed.
  const state = traceState({cursor: 2700, evidence: [2702, 2703]});
  const room = fakeRoom({events: [roomEvent(2701, "message.posted")]});
  const runtime = await runtimeFor(state, room, "hole-closed");
  await scanOnce(runtime);
  assert.deepEqual(room.acks, [2703]);
  const [record] = await stuckRecords(runtime);
  assert.deepEqual([record.seq, record.eventId, record.eventType, record.reason, record.priorState.kind], [2701, "ev2701", "message.posted", "stuck:hole_epoch_closed:none", "hole"]);
  // The Room's epoch-closed proof bytes are the persisted evidence.
  assert.deepEqual([record.proof.eventEpochStatus, record.proof.activeEpochId, record.eventEpochId], ["closed", "ep22", "ep21"]);
  assert.equal(record.proofSha256, createHash("sha256").update(recovery.canonical(record.proof)).digest("hex"));
  assert.equal(record.recordDigest, recovery.recordDigest(record));
});

test("STK-10 open_epoch_hole", async (t) => {
  const advance = clock(t);
  // 2931 is a hole in the open epoch 22: it still holds the frontier, also after a day.
  const state = traceState({cursor: 2930, evidence: [2932, 2933]});
  const room = fakeRoom({events: [roomEvent(2931, "message.posted")]});
  const runtime = await runtimeFor(state, room, "hole-open");
  const before = JSON.stringify(runtime.state);
  await scanOnce(runtime);
  const reads = room.reads.length;
  // Request discipline: no new proof read for the same frontier inside the probe interval.
  await scanOnce(runtime);
  assert.equal(room.reads.length, reads);
  advance(25 * HOUR);
  await scanOnce(runtime);
  assert.deepEqual(room.acks, []);
  assert.equal(JSON.stringify(runtime.state), before);
  assert.deepEqual(await stuckRecords(runtime), []);
  assert.deepEqual(recovery.ledgerReport(runtime.state).holeSeqs, [2931]);
});

// --- negative controls -----------------------------------------------------------

test("STK-06 inflight", async (t) => {
  clock(t);
  for (const mark of ["attemptLease", "inflightEvent", "pendingEvent"]) {
    const state = traceState({cursor: 2653, quarantine: [[2654, "stale_context", {quarantinedAt: iso(NOW - 48 * HOUR)}]], evidence: [2655]});
    const room = fakeRoom({events: [roomEvent(2654, "discussion.cycle_attempt_ready")]});
    const runtime = await runtimeFor(state, room, `inflight-${mark}`);
    const event = roomEvent(2654, "discussion.cycle_attempt_ready");
    if (mark === "attemptLease") runtime.attemptLeases.set("ev2654", {stop: async () => {}});
    if (mark === "inflightEvent") runtime.inflightEvent = event;
    if (mark === "pendingEvent") runtime.pendingEvent = event;
    await scanOnce(runtime);
    assert.deepEqual(room.acks, [], mark);
    assert.equal(runtime.state.cursor, 2653, mark);
    assert.deepEqual(await stuckRecords(runtime), [], mark);
  }
});

test("STK-07 retry_pending", async (t) => {
  clock(t);
  // (1) another unfinished delivery of the same source; (2) a sealed recovery
  // closure for the seq that the closure path is still retrying.
  const alias = traceState({cursor: 2932, quarantine: [[2933, "validation_error", {quarantinedAt: iso(NOW - 48 * HOUR)}]], evidence: [2934]});
  alias.deliveryIntents["ev2933:dispatch"] = {version: 1, status: "selected", messagePayloadDialect: "v1",
    identity: {roomId: "room-1", body: "legacy", sourceEventId: "ev2933"}};
  const aliasRoom = fakeRoom({events: [roomEvent(2933, "message.posted")]});
  const aliasRuntime = await runtimeFor(alias, aliasRoom, "retry-alias");
  await scanOnce(aliasRuntime);
  assert.deepEqual(aliasRoom.acks, []);
  assert.deepEqual(await stuckRecords(aliasRuntime), []);

  const closing = traceState({cursor: 2932, quarantine: [[2933, "validation_error", {quarantinedAt: iso(NOW - 48 * HOUR)}]], evidence: [2934]});
  const closingRoom = fakeRoom({events: [roomEvent(2933, "message.posted")], fail: () => true});
  const closingRuntime = await runtimeFor(closing, closingRoom, "retry-closure");
  const proven = {eventId: "ev2933", eventType: "message.posted", eventEpochId: "ep22", proof: {activeEpochId: "ep23", eventEpochStatus: "closed",
    cycleId: "", cycleState: "", cycleGeneration: 0, eventGeneration: 0, deliveredSeq: 3300, fetchedAt: iso(NOW)}};
  const record = recovery.seal(recovery.buildRecord({connector: "openclaw/test", roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1",
    seq: 2933, reason: "epoch_closed", evidenceRef: "epoch:ep22", proven, prior: {kind: "quarantine", intentKey: "ev2933:final", lastErrorCode: "validation_error"},
    operator: "owner"}));
  recovery.appendRecord(recovery.journalPath(closingRuntime.account.stateFile), record);
  // The scan runs the closure path first, then the stuck rule.
  await scanOnce(closingRuntime);
  assert.deepEqual(closingRoom.acks, []);
  assert.equal(closingRuntime.state.cursor, 2932);
  assert.deepEqual(await stuckRecords(closingRuntime), []);
});

test("STK-08 under_24h", async (t) => {
  const advance = clock(t);
  const state = traceState({cursor: 3222, quarantine: [[3223, "", {quarantinedAt: iso(NOW - 24 * HOUR + 60_000)}]], evidence: [3224]});
  // The Room's event is older than a day: the stamp, not the event, is the clock.
  const room = fakeRoom({events: [roomEvent(3223, "peer.acknowledged", {ts: iso(NOW - 72 * HOUR)})]});
  const runtime = await runtimeFor(state, room, "under-24h");
  await scanOnce(runtime);
  assert.deepEqual(room.acks, []);
  assert.deepEqual(await stuckRecords(runtime), []);
  advance(60_000);
  await scanOnce(runtime);
  assert.deepEqual(room.acks, [3224], "at 24 h it is stuck");

  // A pre-0.2.92 intent without a time of its own is not stuck on its first
  // scan, however old the Room's event is.
  const legacy = traceState({cursor: 3222, quarantine: [[3223, ""]], evidence: [3224]});
  const legacyRoom = fakeRoom({events: [roomEvent(3223, "peer.acknowledged", {ts: iso(NOW - 72 * HOUR)})]});
  const legacyRuntime = await runtimeFor(legacy, legacyRoom, "under-24h-legacy");
  await scanOnce(legacyRuntime);
  assert.deepEqual(legacyRoom.acks, []);
});

test("STK-09 canonical_receipt", async (t) => {
  clock(t);
  const receipt = {id: "posted-1", seq: 2700, ts: "2026-11-20T10:00:00Z"};
  const state = traceState({cursor: 2653, quarantine: [[2654, "stale_context", {quarantinedAt: iso(NOW - 48 * HOUR), canonicalMessage: receipt}]], evidence: [2655]});
  const room = fakeRoom({events: [roomEvent(2654, "discussion.cycle_attempt_ready")]});
  const runtime = await runtimeFor(state, room, "receipt");
  await scanOnce(runtime);
  assert.deepEqual(room.acks, []);
  assert.equal(runtime.state.cursor, 2653);
  assert.deepEqual(await stuckRecords(runtime), []);
});

// --- grammar and the one terminal set ---------------------------------------------

test("STK-11 reason_grammar", async () => {
  const terminal = await import("../src/terminal-states.js");
  assert.deepEqual([...terminal.STUCK_TRIGGERS], ["epoch_closed", "cycle_terminal", "cycle_superseded", "age", "hole_epoch_closed"]);
  assert.equal(terminal.stuckReason("epoch_closed", "stale_context"), "stuck:epoch_closed:stale_context");
  assert.equal(terminal.stuckReason("age", ""), "stuck:age:none");
  assert.equal(terminal.stuckReason("age", undefined), "stuck:age:none");
  assert.equal(terminal.stuckReason("hole_epoch_closed", "none"), "stuck:hole_epoch_closed:none");
  // A code outside the grammar (a separator, whitespace, too long) is reported as none.
  assert.equal(terminal.stuckReason("age", "a:b"), "stuck:age:none");
  assert.equal(terminal.stuckReason("age", "two words"), "stuck:age:none");
  assert.equal(terminal.stuckReason("age", "x".repeat(65)), "stuck:age:none");
  assert.throws(() => terminal.stuckReason("operator", "x"), /trigger/);
  assert.deepEqual(terminal.parseStuckReason("stuck:cycle_superseded:cycle_superseded"), {trigger: "cycle_superseded", code: "cycle_superseded"});
  for (const bad of ["stuck:age", "stuck:age:", "stuck:other:none", "stuck:age:a:b", "Stuck:age:none", "stuck:age:none ", "recovery_closure:epoch_closed"]) {
    assert.equal(terminal.parseStuckReason(bad), null, bad);
  }
  // State and the frontier walk accept stuck evidence only with a grammatical reason.
  const state = traceState({cursor: 2932, evidence: [2934]});
  state.terminalEvidence["2933"] = {status: "stuck", sourceEventId: "ev2933", sourceSeq: 2933, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "stuck:age:none"};
  state.receiveLedger["2933"] = {eventId: "ev2933", status: "stuck"};
  validateState(state);
  const bad = structuredClone(state);
  bad.terminalEvidence["2933"].reason = "stuck:age";
  assert.throws(() => validateState(bad), /terminal evidence/);
  const room = fakeRoom();
  const runtime = await runtimeFor(state, room, "grammar");
  await runtime.ackEvent({id: "ev2933", seq: 2933});
  assert.deepEqual(room.acks, [2934]);
});

test("STK-12 terminal_set_parity", async () => {
  const terminal = await import("../src/terminal-states.js");
  assert.deepEqual([...terminal.TERMINAL_EVIDENCE_STATUSES], ["posted", "skipped", "failed", "cancelled", "superseded", "ignored", "stuck"]);
  assert.deepEqual([...terminal.LEDGER_STATUSES], ["received", "quarantined", ...terminal.TERMINAL_EVIDENCE_STATUSES]);
  assert.deepEqual([...terminal.SETTLED_INTENT_STATUSES], ["posted", "superseded", "skipped", "quarantined"]);
  assert.equal(recovery.isTerminalIntent, terminal.isTerminalIntent, "retention uses the shared definition");
  assert.equal(recovery.isQuarantinedIntent, terminal.isQuarantinedIntent);

  // Every check consumes the one module; none keeps its own list.
  const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
  for (const name of ["runtime.js", "state.js", "recovery.js", "credential-renewal.js", "connector-control.js"]) {
    const source = await read(name);
    assert.match(source, /from "\.\/terminal-states\.js"/, name);
    assert.doesNotMatch(source, /\["posted", "skipped", "failed", "cancelled", "superseded", "ignored"/, name);
    assert.doesNotMatch(source, /\["posted", "superseded", "(quarantined|skipped)"/, name);
    assert.doesNotMatch(source, /new Set\(\["received", "quarantined"/, name);
  }

  // Frontier walk and state validation: every terminal evidence status passes, nothing else does.
  for (const status of [...terminal.TERMINAL_EVIDENCE_STATUSES, "quarantined", "received", "pending"]) {
    const member = terminal.TERMINAL_EVIDENCE_STATUSES.includes(status);
    const state = traceState({cursor: 2932, evidence: [2934]});
    state.terminalEvidence["2933"] = status === "posted"
      ? {status, sourceEventId: "ev2933", sourceSeq: 2933, canonicalEventId: "posted-1", canonicalSeq: 2990, canonicalTs: "2026-11-20T10:00:00Z", reason: ""}
      : {status, sourceEventId: "ev2933", sourceSeq: 2933, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "",
        reason: status === "stuck" ? "stuck:age:none" : "a_reason"};
    if (member) {
      validateState(state);
      const room = fakeRoom();
      const runtime = await runtimeFor(state, room, `walk-${status}`);
      await runtime.ackEvent({id: "ev2934", seq: 2934});
      assert.deepEqual(room.acks, [2934], status);
    } else {
      assert.throws(() => validateState(state), /terminal evidence/, status);
    }
  }

  // Renewal quiescence and the owner-control fence agree with the shared settled set.
  const statuses = ["selected", "preparing", "delivery_pending", "lifecycle_pending", "posted", "quarantined", "lifecycle_blocked", "superseded", "skipped"];
  for (const status of statuses) {
    for (const lifecycleState of [undefined, "not_started", "pending", "complete", "not_required", "blocked"]) {
      const intent = {status, lifecycleState};
      const state = {deliveryIntents: {k: intent}};
      const settled = terminal.intentSettled(intent);
      assert.equal(renewalBlocked(state), !settled, `renewal ${status}/${lifecycleState}`);
      assert.equal(storedWorkInProgress(state), !settled, `control ${status}/${lifecycleState}`);
    }
  }
  assert.equal(storedWorkInProgress({receiveLedger: {7: {eventId: "e", status: "stuck"}}}), false, "a stuck ledger entry is not work in progress");

  // Retention: a stuck event's intent stays quarantined and is never pruned.
  const kept = traceState({cursor: 2932, quarantine: [[2933, "validation_error", {quarantinedAt: iso(NOW - 48 * HOUR)}]]});
  assert.deepEqual(recovery.pruneTerminalIntents(kept, 0), []);
});
