// Shared conformance cases for parity release P3 (delivery contract section
// "P3 — Ledger, recovery and holes"). Case names are identical in the Hermes
// and OpenClaw conformance.json files. Fixtures follow the live Aura account
// shapes (key set and intent shapes only, no values) and the two documented
// holes. No test uses a real credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {registerHooks} from "node:module";
import {ISOLATED_HOST_CONFIG} from "./support/isolated-host.mjs";

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

const home = await mkdtemp(join(tmpdir(), "openclaw-room-p3-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const {roomStatusPath, roomToolCallPolicy} = await import("../src/channel.js");
const {OpenClawRoomRuntime} = await import("../src/runtime.js");
const {RoomAPIError, RoomTransportError} = await import("../src/room-client.js");
const {loadState, migrateStateFile, saveState, validateState} = await import("../src/state.js");
const recovery = await import("../src/recovery.js");
const {runRecoveryCli} = await import("../src/recovery-cli.js");
const {LocalStatus} = await import("../src/local-status.js");
const isolation = await import("../src/secret-isolation.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CYCLE = "cyb1cd6c68e7df2";
const ATTEMPT_READY = {id: "ev379", seq: 379, type: "discussion.cycle_attempt_ready", epoch: "epoch-old",
  payload: {cycleId: CYCLE, generation: 1, membershipId: "member-1"}};
const OWNER_MESSAGE = {id: "ev383", seq: 383, type: "message.posted", epoch: "epoch-old", actorRole: "human_owner",
  payload: {body: "a message body that never reaches an audit record"}};
const SECRET = `room-cred-TEST-${"0f1e2d3c".repeat(4)}`;

// The read-only Room routes a closure uses, plus the acknowledgement.
function proofRoom({active = "epoch-new", cycleState = "interrupted", cycleGeneration = 1, events = [ATTEMPT_READY, OWNER_MESSAGE]} = {}) {
  const room = {reads: [], acks: []};
  Object.assign(room, {
    listEpochs: async () => { room.reads.push("epochs"); return {epochs: [
      {id: "epoch-old", startsAtSeq: 300, status: active === "epoch-old" ? "active" : "closed"},
      {id: "epoch-new", startsAtSeq: 500, status: active === "epoch-new" ? "active" : "closed"}]}; },
    readEpochEvents: async (_state, after, epochId) => { room.reads.push(["events", after, epochId]);
      return {events: events.filter((item) => item.seq > after && item.epoch === epochId).slice(0, 10).map((item) => ({...item})), deliveredSeq: 990}; },
    roomState: async () => { room.reads.push("state"); return {activeEpoch: {id: active, startsAtSeq: 500}}; },
    getDiscussionCycle: async (_state, cycleId) => { room.reads.push(["cycle", cycleId]); return {id: CYCLE, state: cycleState, generation: cycleGeneration}; },
    acknowledge: async (_state, seq) => { room.acks.push(seq); return {acknowledgedSeq: seq}; },
  });
  return room;
}
const adapterFor = (room) => ({
  listEpochs: () => room.listEpochs(), epochEvents: (after, epochId) => room.readEpochEvents(null, after, epochId),
  roomState: () => room.roomState(), getDiscussionCycle: (id) => room.getDiscussionCycle(null, id),
});

// An account state with the live Aura key set and intent shapes. The intents
// are produced by the connector's own send path against a fake Room (posted,
// superseded, quarantined, skipped), plus legacy v1 `selected` intents.
async function auraShapedState({cursor = 1107, terminal = 40} = {}) {
  const base = {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1", credential: SECRET,
    credentialExpiresAt: "2030-01-01T00:00:00Z", identityVersion: 1, clientInstanceId: "client-1", cursor,
    messagePayloadCapabilities: ["message.logical_contribution.v1"], messagePayloadDialect: "v2",
    deliveryIntents: {}, terminalEvidence: {}, legacySessionEpochId: "epoch-new",
    epochSessionRoutingInitialized: true, rotateCurrentEpochSession: false,
  };
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile: join(home, "unused-shape.json"), baseUrl: base.baseUrl});
  runtime.state = base;
  runtime.persistState = async () => {};
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  let posts = 0;
  let refusal = null;
  runtime.client = {
    roomState: async () => ({headSeq: 1200, activeEpoch: {id: "epoch-new", startsAtSeq: 500}}),
    roomPolicy: async () => ({policy: {coordinationMode: refusal ? "coordinated" : "open"}}),
    requestTurn: async () => ({state: "granted", turnId: "turn-1"}),
    finishTurn: async () => ({}),
    postMessage: async () => {
      if (refusal) throw new RoomAPIError(409, {code: refusal, retryable: false});
      posts += 1;
      return {id: `posted${posts}`, seq: 1200 + posts, ts: "2026-10-01T10:00:00Z"};
    },
  };
  const send = async (source, code) => {
    refusal = code;
    runtime.pendingEvent = null;
    await runtime.postAndFinish({roomId: "room-1", text: `reply to ${source}`, replyToId: "", idempotencyKey: `${source}:final`, sourceEventId: source})
      .catch(() => {});
  };
  await send("q-394", "validation_error");
  for (let index = 0; index < terminal; index += 1) await send(`posted-${index}`, index % 5 === 4 ? "turn_expired" : (index % 7 === 6 ? "reply_cap_reached" : null));
  for (const legacy of ["v1-144", "v1-524"]) {
    base.deliveryIntents[legacy] = {version: 1, status: "selected", messagePayloadDialect: "v1",
      identity: {roomId: "room-1", body: `legacy ${legacy}`, sourceEventId: legacy}};
  }
  return base;
}

// Paula's shape: ack 378, 379 quarantined (cycle_superseded), evidence 380-382.
function paulaState() {
  const evidence = Object.fromEntries([380, 381, 382].map((seq) => [String(seq), {status: "ignored", sourceEventId: `ev${seq}`, sourceSeq: seq,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "not_addressed"}]));
  return {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1", credential: SECRET,
    clientInstanceId: "client-1", cursor: 378, deliveredCursor: 382, stateRevision: 2, appliedRecoveryClosures: {},
    terminalEvidence: evidence,
    receiveLedger: {"379": {eventId: "ev379", status: "quarantined"},
      ...Object.fromEntries([380, 381, 382].map((seq) => [String(seq), {eventId: `ev${seq}`, status: "ignored"}]))},
    deliveryIntents: {"ev379:final": {version: 2, status: "quarantined", deliveryState: "quarantined", lifecycleState: "not_started",
      deliveryErrorCode: "cycle_superseded", identity: {roomId: "room-1", body: "kept", replyToId: "", sourceEventId: "ev379", cycle: null,
        resolveRecipientMentions: false}, binding: {roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1"},
      messagePayloadDialect: "v2", logicalContributionId: "lc", requestIdempotencyKey: "r", messageIdempotencyKey: "m", finishIdempotencyKey: "f"}},
  };
}

// Claude's shape: ack 382, nothing for 383, evidence 384-385.
function claudeState() {
  const evidence = Object.fromEntries([384, 385].map((seq) => [String(seq), {status: "ignored", sourceEventId: `ev${seq}`, sourceSeq: seq,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "not_addressed"}]));
  return {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1", credential: SECRET,
    clientInstanceId: "client-1", cursor: 382, deliveredCursor: 385, stateRevision: 2, appliedRecoveryClosures: {},
    terminalEvidence: evidence, deliveryIntents: {},
    receiveLedger: Object.fromEntries([384, 385].map((seq) => [String(seq), {eventId: `ev${seq}`, status: "ignored"}])),
  };
}

async function account(state, name = "account") {
  const directory = await mkdtemp(join(home, `${name}-`));
  const accounts = join(directory, "synthetic-sociality-room", "accounts");
  await mkdir(accounts, {recursive: true, mode: 0o700});
  const file = join(accounts, "member-1.json");
  await saveState(file, state);
  return file;
}

function cli(args, room) {
  const lines = [];
  return runRecoveryCli(args, {write: (line) => lines.push(line), makeClient: () => room})
    .then((code) => ({code, out: lines.join("\n")}), (error) => ({code: 1, out: lines.join("\n"), error: String(error.message)}));
}

function runtimeFor(state, stateFile, room) {
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"});
  runtime.state = state;
  runtime.client = room;
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  return runtime;
}

test("conformance P3 case names resolve to tests in this suite", async () => {
  const cases = Object.entries(conformance.parityP3Cases ?? {});
  assert.equal(cases.length, 9);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const [id, name] of cases) {
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
  }
  assert.equal(conformance.parityP3TerminalIntentRetention, recovery.TERMINAL_INTENT_RETENTION);
  // The audit record is byte-compatible with Hermes: a shared vector.
  const proven = {eventId: "ev379", eventType: "discussion.cycle_attempt_ready", eventEpochId: "epoch-old", proof: {activeEpochId: "epoch-new",
    eventEpochStatus: "closed", cycleId: CYCLE, cycleState: "interrupted", cycleGeneration: 1, eventGeneration: 1, deliveredSeq: 990,
    fetchedAt: "2026-10-03T00:00:00Z"}};
  const record = recovery.buildRecord({connector: "shared/vector", roomId: "bjqiu9u7dwqptlq", membershipId: "member-1", clientInstanceId: "inst-1",
    seq: 379, reason: "cycle_terminal", evidenceRef: `cycle:${CYCLE}`, proven,
    prior: {kind: "quarantine", intentKey: "jyj0e25ev0a5hn8", lastErrorCode: "cycle_superseded"}, operator: "owner — tjé"});
  record.recordedAt = "2026-10-03T00:00:01Z";
  record.recordDigest = recovery.recordDigest(record);
  assert.equal(record.confirmToken, "311dfde5099d1d36");
  assert.equal(record.recordDigest, "c91b6942a3039f95738450503b6c4c8dd63909c066eefeedabb164ca4f9026ed");
});

test("P3-01 every event read above the acknowledgement has a ledger entry before it is processed", async () => {
  const stateFile = await account(claudeState(), "ledger");
  const state = await loadState(stateFile);
  state.receiveLedger = {};
  state.terminalEvidence = {};
  state.cursor = 4;
  state.deliveredCursor = 4;
  state.epochSessionRoutingInitialized = true;
  state.legacySessionEpochId = "epoch-1";
  const event = {id: "source-5", seq: 5, type: "message.posted", actorId: "human-1", actorRole: "human_owner", payload: {body: "Question", epochId: "epoch-1"}};
  const runtime = runtimeFor(state, stateFile, {readEvents: async () => ({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: [event]}),
    // The delivery fence reads the Room state's start (P7c-7).
    roomState: async () => ({activeEpoch: {id: "epoch-1", startsAtSeq: 1}})});
  runtime.connectorSession = {sessionId: "s"};
  const order = [];
  runtime.persistState = async () => { order.push(["persist", structuredClone(runtime.state.receiveLedger ?? {})]); };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.recoverPostedEvidence = async () => false;
  runtime.recoverPendingDelivery = async () => false;
  runtime.markContextAcknowledged = async () => { order.push(["processing", structuredClone(runtime.state.receiveLedger ?? {})]); };
  runtime.prepareCycleAttempt = async () => null;
  runtime.sharedRoomContext = async () => "";
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  await turns.next();
  controller.abort();
  assert.deepEqual(order[0], ["persist", {"5": {eventId: "source-5", status: "received"}}]);
  assert.ok(order.findIndex(([kind]) => kind === "processing") > 0, "processing follows the durable entry");
  assert.equal(runtime.state.deliveredCursor, 5);
  // The entry ends in its terminal outcome, then is pruned with the ack.
  runtime.pendingEvent = event;
  runtime.client.acknowledge = async (_s, seq) => ({acknowledgedSeq: seq});
  await runtime.recordTerminalEvidence(event, "skipped", {reason: "model_no_visible_reply"});
  assert.equal(runtime.state.receiveLedger["5"].status, "skipped");
  await runtime.ackEvent(event);
  assert.deepEqual([runtime.state.cursor, runtime.state.receiveLedger], [5, {}]);
  validateState(runtime.state);
});

test("P3-02 an older state file is upgraded once, in place, without data loss and with a copy of the original", async () => {
  const original = await auraShapedState();
  const stateFile = await account(original, "migrate");
  const before = await readFile(stateFile);
  const loaded = await loadState(stateFile);
  const result = await migrateStateFile(stateFile, loaded, {now: new Date("2026-10-03T01:02:03Z")});
  assert.equal(result.migrated, true);
  // The original bytes are kept beside the file, 0600, not a *.json name.
  assert.equal(result.backup, `${stateFile}.pre-0.2.61-20261003T010203Z.bak`);
  assert.deepEqual(await readFile(result.backup), before);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.ok(!result.backup.endsWith(".json"));
  const migrated = JSON.parse(await readFile(stateFile, "utf8"));
  // Every original field is unchanged except the pruned terminal intents.
  for (const [key, value] of Object.entries(original)) {
    if (key === "deliveryIntents") continue;
    assert.deepEqual(migrated[key], value, key);
  }
  assert.deepEqual(migrated.receiveLedger, {});
  assert.equal(migrated.deliveredCursor, original.cursor);
  assert.deepEqual(migrated.appliedRecoveryClosures, {});
  assert.equal(migrated.stateRevision, 2);
  assert.equal(migrated.version, 1, "0.2.60 still accepts the file format");
  const keys = Object.keys(migrated.deliveryIntents);
  const originalKeys = Object.keys(original.deliveryIntents);
  const terminalKeys = originalKeys.filter((key) => recovery.isTerminalIntent(original.deliveryIntents[key]));
  assert.ok(terminalKeys.length > 32, "the fixture has more terminal intents than the retention");
  // Kept: every non-terminal intent (quarantined, delivery pending, v1
  // selected) and the newest 32 terminal ones, byte-equal; pruned: the oldest.
  assert.deepEqual(keys, originalKeys.filter((key) => !terminalKeys.slice(0, terminalKeys.length - 32).includes(key)));
  for (const kept of ["q-394:final", "v1-144", "v1-524", "posted-6:final", "posted-39:final"]) assert.ok(keys.includes(kept), kept);
  assert.equal(original.deliveryIntents["posted-6:final"].deliveryState, "delivery_pending");
  assert.deepEqual(result.pruned, terminalKeys.slice(0, terminalKeys.length - 32));
  for (const key of keys) assert.deepEqual(migrated.deliveryIntents[key], original.deliveryIntents[key], key);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  // Idempotent: a second run changes nothing and writes no second copy.
  const settled = await readFile(stateFile);
  const again = await migrateStateFile(stateFile, await loadState(stateFile));
  assert.equal(again.migrated, false);
  assert.deepEqual(await readFile(stateFile), settled);
  assert.equal((await readdir(dirname(stateFile))).filter((name) => name.includes(".pre-0.2.61-")).length, 1);
  // Evidence above the cursor seeds the ledger and the delivered frontier.
  const withEvidence = await auraShapedState({cursor: 10, terminal: 0});
  withEvidence.terminalEvidence = {"12": {status: "ignored", sourceEventId: "e12", sourceSeq: 12, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "x"}};
  const evidenceFile = await account(withEvidence, "migrate-evidence");
  const seeded = (await migrateStateFile(evidenceFile, await loadState(evidenceFile))).state;
  assert.deepEqual([seeded.receiveLedger, seeded.deliveredCursor], [{"12": {eventId: "e12", status: "ignored"}}, 12]);
  assert.equal(recovery.ledgerReport(seeded).holeSeqs.join(","), "11");
});

test("P3-02 an older state file is upgraded once, in place, without data loss and with a copy of the original (at initialize)", async () => {
  // The runtime migrates during initialize, before registration.
  const original = await auraShapedState();
  const stateFile = await account(original, "initialize");
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"});
  const order = [];
  runtime.renewAccess = async () => { order.push(["renew", runtime.state.stateRevision]); return false; };
  runtime.registerConnector = async () => { order.push(["register", runtime.state.stateRevision]); runtime.connectorSession = {sessionId: "s"}; return runtime.connectorSession; };
  runtime.repairPendingLifecycles = async () => {};
  runtime.publishPresence = async () => {};
  runtime.runHeartbeat = () => {};
  runtime.logger = {info: (line) => order.push(["log", line]), warn: () => {}, error: () => {}};
  await runtime.initialize();
  assert.deepEqual(order.filter(([kind]) => kind !== "log"), [["renew", 2], ["register", 2]]);
  assert.ok(order.some(([kind, line]) => kind === "log" && /Room state upgraded to revision 2/.test(line)));
  const onDisk = await loadState(stateFile);
  assert.equal(onDisk.stateRevision, 2);
  assert.equal((await readdir(dirname(stateFile))).filter((name) => name.includes(".pre-0.2.61-")).length, 1);
  await runtime.close?.();
});

test("P3-03 terminal intents beyond the newest 32 are pruned and quarantined or open intents never are", async () => {
  const state = await auraShapedState({terminal: 45});
  state.deliveryIntents["lifecycle:final"] = {status: "lifecycle_pending", deliveryState: "posted", lifecycleState: "pending"};
  const terminalKeys = Object.keys(state.deliveryIntents).filter((key) => recovery.isTerminalIntent(state.deliveryIntents[key]));
  const pruned = recovery.pruneTerminalIntents(state);
  assert.deepEqual(pruned, terminalKeys.slice(0, terminalKeys.length - 32));
  assert.equal(Object.values(state.deliveryIntents).filter(recovery.isTerminalIntent).length, 32);
  for (const kept of ["q-394:final", "v1-144", "lifecycle:final", "posted-6:final", "posted-44:final"]) assert.ok(state.deliveryIntents[kept], kept);
  assert.deepEqual(recovery.pruneTerminalIntents(state), []);
  // The acknowledgement path applies the same rule.
  const stateFile = await account(paulaState(), "prune-ack");
  const live = await loadState(stateFile);
  for (let index = 0; index < 40; index += 1) {
    const old = structuredClone(live.deliveryIntents["ev379:final"]);
    delete old.deliveryErrorCode;
    live.deliveryIntents[`old-${index}:final`] = {...old, status: "superseded", deliveryState: "superseded", lifecycleState: "not_required",
      supersededReason: "turn_expired", identity: {...old.identity, sourceEventId: `old-${index}`}};
  }
  live.terminalEvidence["379"] = {status: "ignored", sourceEventId: "ev379", sourceSeq: 379, canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "x"};
  const runtime = runtimeFor(live, stateFile, {acknowledge: async (_s, seq) => ({acknowledgedSeq: seq})});
  await runtime.ackEvent({id: "ev379", seq: 379});
  assert.equal(runtime.state.cursor, 382);
  assert.equal(Object.values(runtime.state.deliveryIntents).filter(recovery.isTerminalIntent).length, 32);
  assert.ok(runtime.state.deliveryIntents["ev379:final"], "a quarantined intent is never pruned");
});

test("P3-04 a hole is reported as a code, logged once and never closed by the connector", async () => {
  const directory = await mkdtemp(join(home, "hole-"));
  const statusFile = join(directory, "status.json");
  const runtime = runtimeFor(claudeState(), join(directory, "member-1.json"), {});
  runtime.status = new LocalStatus(statusFile, {plugin: "openclaw", version: "test", hostLabel: "h"});
  const before = JSON.stringify(runtime.state);
  runtime.reportLedger();
  runtime.reportLedger();
  assert.equal(runtime.logs.filter((line) => line.includes("ack_hole seq 383")).length, 1);
  const entry = JSON.parse(await readFile(statusFile, "utf8")).rooms["room-1"];
  assert.deepEqual([entry.acknowledgedSeq, entry.holeSeqs, entry.quarantinedSeqs, entry.ledgerCode], [382, [383], [], "ack_hole"]);
  assert.equal(JSON.stringify(runtime.state), before, "nothing is closed or changed");
  const paula = recovery.ledgerReport(paulaState());
  assert.deepEqual([paula.holeSeqs, paula.quarantinedSeqs, paula.ledgerCode], [[], [379], "quarantine_held"]);
});

test("P3-05 recovery list is read-only and shows holes, quarantines and stuck intents", async () => {
  const state = paulaState();
  state.deliveryIntents["v1-144"] = {version: 1, status: "selected", messagePayloadDialect: "v1", identity: {roomId: "room-1", body: "legacy", sourceEventId: "v1-144"}};
  const stateFile = await account(state, "list");
  const before = await readFile(stateFile);
  const {code, out} = await cli(["list", "--state", stateFile], proofRoom());
  assert.equal(code, 0);
  assert.deepEqual(await readFile(stateFile), before);
  assert.ok(!existsSync(recovery.journalPath(stateFile)));
  assert.match(out, new RegExp(`state: ${stateFile.replaceAll("/", "\\/")}`));
  assert.match(out, /acknowledged 378/);
  assert.match(out, /quarantines: 379/);
  assert.match(out, /stuck intent ev379:final: source seq 379, quarantined, cycle_superseded/);
  assert.match(out, /stuck intent v1-144/);
  assert.ok(!out.includes(SECRET));
});

test("P3-06 a recovery closure is a dry run until applied with its token and acknowledges through the normal path", async () => {
  const room = proofRoom();
  const stateFile = await account(paulaState(), "close");
  const before = await readFile(stateFile);
  const args = ["close", "--state", stateFile, "--seq", "379", "--reason", "cycle_terminal", "--evidence", `cycle:${CYCLE}`, "--operator", "owner-tje"];
  const dry = await cli(args, room);
  assert.equal(dry.code, 0, dry.error);
  const token = dry.out.split("--confirm ").at(-1).trim();
  assert.equal(token.length, 16);
  assert.ok(!existsSync(recovery.journalPath(stateFile)), "a dry run writes nothing");
  const wrong = await cli([...args, "--apply", "--confirm", "0".repeat(16)], room);
  assert.equal(wrong.code, 1);
  assert.match(wrong.error, /confirmation token does not match/);
  const applied = await cli([...args, "--apply", "--confirm", token], room);
  assert.equal(applied.code, 0, applied.error);
  assert.deepEqual(await readFile(stateFile), before, "the CLI never writes the state");
  const journal = recovery.journalPath(stateFile);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  const [record] = recovery.readRecords(journal);
  assert.deepEqual(Object.keys(record).sort(), ["clientInstanceId", "confirmToken", "connector", "evidenceRef", "eventEpochId", "eventId", "eventType",
    "membership", "operator", "priorState", "proof", "reason", "recordDigest", "recordedAt", "room", "seq", "verb", "version"].sort());
  assert.deepEqual([record.seq, record.eventId, record.reason, record.operator, record.confirmToken], [379, "ev379", "cycle_terminal", "owner-tje", token]);
  assert.deepEqual(record.priorState, {kind: "quarantine", intentKey: "ev379:final", lastErrorCode: "cycle_superseded"});
  const text = await readFile(journal, "utf8");
  assert.ok(!text.includes(SECRET) && !text.includes("body"));
  assert.ok(room.reads.filter((read) => Array.isArray(read) && read[0] === "events").every((read) => read[2] === "epoch-old"));
  await writeFile(journal, text.replace("owner-tje", "someone-else"));
  assert.deepEqual(recovery.readRecords(journal), [], "an altered line is not a record");
  await writeFile(journal, text);

  // The running connector applies it through the normal ack path.
  const runtime = runtimeFor(await loadState(stateFile), stateFile, room);
  await runtime.applyRecoveryClosures();
  await runtime.applyRecoveryClosures();
  assert.deepEqual(room.acks, [382]);
  assert.equal(runtime.state.cursor, 382);
  assert.equal(runtime.state.deliveryIntents["ev379:final"].deliveryState, "quarantined", "the quarantined intent is kept");
  assert.equal(runtime.state.appliedRecoveryClosures["379"].recordDigest, record.recordDigest);
  assert.equal(runtime.logs.filter((line) => line.includes("recovery closure applied")).length, 1);
  assert.equal((await loadState(stateFile)).cursor, 382);

  // Claude's hole: epoch_closed, evidence epoch:<the epoch of 383>.
  const claudeRoom = proofRoom();
  const claudeFile = await account(claudeState(), "close-hole");
  const claudeArgs = ["close", "--state", claudeFile, "--seq", "383", "--reason", "epoch_closed", "--evidence", "epoch:epoch-old", "--operator", "owner-tje"];
  const claudeDry = await cli(claudeArgs, claudeRoom);
  assert.equal(claudeDry.code, 0, claudeDry.error);
  const claudeToken = claudeDry.out.split("--confirm ").at(-1).trim();
  assert.equal((await cli([...claudeArgs, "--apply", "--confirm", claudeToken], claudeRoom)).code, 0);
  assert.equal(recovery.readRecords(recovery.journalPath(claudeFile))[0].priorState.kind, "hole");
  const claudeRuntime = runtimeFor(await loadState(claudeFile), claudeFile, claudeRoom);
  await claudeRuntime.applyRecoveryClosures();
  assert.deepEqual([claudeRoom.acks, claudeRuntime.state.cursor], [[385], 385]);
});

test("P3-07 a recovery closure is refused without the Room's proof that the event is terminal for this member", async () => {
  const cases = [
    [proofRoom({cycleState: "running"}), 379, "cycle_terminal", `cycle:${CYCLE}`, "not_proven"],
    [proofRoom({cycleGeneration: 1}), 379, "cycle_superseded", `cycle:${CYCLE}`, "not_proven"],
    [proofRoom(), 379, "cycle_terminal", "cycle:another", "evidence_mismatch"],
    [proofRoom({active: "epoch-old"}), 383, "epoch_closed", "epoch:epoch-old", "not_proven"],
    [proofRoom(), 383, "epoch_closed", "epoch:epoch-new", "evidence_mismatch"],
    [proofRoom(), 383, "cycle_terminal", "cycle:x", "not_proven"],
    [proofRoom({events: [{...ATTEMPT_READY, payload: {...ATTEMPT_READY.payload, membershipId: "other"}}]}), 379, "cycle_terminal", `cycle:${CYCLE}`, "not_for_member"],
    [proofRoom({events: []}), 379, "cycle_terminal", `cycle:${CYCLE}`, "event_not_found"],
    [proofRoom(), 379, "made_up", `cycle:${CYCLE}`, "unknown_reason"],
  ];
  for (const [room, seq, reason, evidence, code] of cases) {
    await assert.rejects(recovery.serverProof(adapterFor(room), "member-1", seq, reason, evidence), (error) => error.code === code, code);
  }
  assert.equal((await recovery.serverProof(adapterFor(proofRoom({cycleGeneration: 2})), "member-1", 379, "cycle_superseded", `cycle:${CYCLE}`)).proof.cycleGeneration, 2);
  for (const [state, seq, code] of [[paulaState(), 378, "already_acknowledged"], [paulaState(), 380, "not_closable"], [claudeState(), 390, "not_closable"]]) {
    assert.throws(() => recovery.priorState(state, seq), (error) => error.code === code, code);
  }
  // The CLI refuses without proof; the connector refuses a record whose proof
  // no longer holds and changes nothing.
  const refused = proofRoom({cycleState: "running"});
  const stateFile = await account(paulaState(), "refuse");
  const result = await cli(["close", "--state", stateFile, "--seq", "379", "--reason", "cycle_terminal", "--evidence", `cycle:${CYCLE}`, "--operator", "o"], refused);
  assert.equal(result.code, 1);
  assert.match(result.error, /not_proven/);
  const proven = await recovery.serverProof(adapterFor(proofRoom()), "member-1", 379, "cycle_terminal", `cycle:${CYCLE}`);
  recovery.appendRecord(recovery.journalPath(stateFile), recovery.seal(recovery.buildRecord({connector: "openclaw/test", roomId: "room-1",
    membershipId: "member-1", clientInstanceId: "client-1", seq: 379, reason: "cycle_terminal", evidenceRef: `cycle:${CYCLE}`, proven,
    prior: {kind: "quarantine", intentKey: "ev379:final", lastErrorCode: "cycle_superseded"}, operator: "o"})));
  const runtime = runtimeFor(await loadState(stateFile), stateFile, refused);
  await runtime.applyRecoveryClosures();
  assert.ok(runtime.logs.some((line) => /recovery closure for seq 379 not applied: not_proven/.test(line)));
  assert.deepEqual([refused.acks, runtime.state.cursor, runtime.state.appliedRecoveryClosures], [[], 378, {}]);
  assert.equal(runtime.state.receiveLedger["379"].status, "quarantined");

  // A sealed record for another binding (client instance, membership, Room)
  // is never applied to this account.
  for (const [field, value] of [["clientInstanceId", "other-instance"], ["membership", "member-2"], ["room", "room-2"]]) {
    const file = await account(paulaState(), `mismatch-${field}`);
    const record = recovery.buildRecord({connector: "openclaw/test", roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1",
      seq: 379, reason: "cycle_terminal", evidenceRef: `cycle:${CYCLE}`, proven,
      prior: {kind: "quarantine", intentKey: "ev379:final", lastErrorCode: "cycle_superseded"}, operator: "o"});
    record[field] = value;
    record.confirmToken = recovery.confirmToken(record);
    recovery.appendRecord(recovery.journalPath(file), recovery.seal(record));
    const room = proofRoom();
    const other = runtimeFor(await loadState(file), file, room);
    await other.applyRecoveryClosures();
    assert.deepEqual([room.acks, other.state.appliedRecoveryClosures, other.state.cursor], [[], {}, 378], field);
  }

  // P3 final review: a mark counts as recorded only for its own record. A mark
  // with another digest plus a valid record runs the proof again.
  for (const [cycleState, applied] of [["interrupted", true], ["running", false]]) {
    const staleFile = await account({...paulaState(), appliedRecoveryClosures: {"379": {recordDigest: "0".repeat(64), appliedAt: "2026-10-03T00:00:00Z"}}}, `stale-${cycleState}`);
    const current = recovery.seal(recovery.buildRecord({connector: "openclaw/test", roomId: "room-1", membershipId: "member-1", clientInstanceId: "client-1",
      seq: 379, reason: "cycle_terminal", evidenceRef: `cycle:${CYCLE}`, proven,
      prior: {kind: "quarantine", intentKey: "ev379:final", lastErrorCode: "cycle_superseded"}, operator: "o"}));
    recovery.appendRecord(recovery.journalPath(staleFile), current);
    const staleRoom = proofRoom({cycleState});
    const staleRuntime = runtimeFor(await loadState(staleFile), staleFile, staleRoom);
    await staleRuntime.applyRecoveryClosures();
    assert.ok(staleRoom.reads.some((read) => Array.isArray(read) && read[0] === "cycle"), `${cycleState}: the proof was checked again`);
    if (applied) assert.deepEqual([staleRoom.acks, staleRuntime.state.appliedRecoveryClosures["379"].recordDigest], [[382], current.recordDigest]);
    else assert.deepEqual([staleRoom.acks, staleRuntime.state.cursor], [[], 378]);
  }

  // OP-12 P3 F3: a transient error is retried at the next iteration (logged
  // once); a final Room error retires only that record (logged once).
  const sealed = recovery.seal(recovery.buildRecord({connector: "openclaw/test", roomId: "room-1", membershipId: "member-1",
    clientInstanceId: "client-1", seq: 379, reason: "cycle_terminal", evidenceRef: `cycle:${CYCLE}`, proven,
    prior: {kind: "quarantine", intentKey: "ev379:final", lastErrorCode: "cycle_superseded"}, operator: "o"}));
  const flakyFile = await account(paulaState(), "flaky");
  recovery.appendRecord(recovery.journalPath(flakyFile), sealed);
  const flaky = proofRoom();
  const failures = [new RoomAPIError(503, {code: "", retryable: true}), new RoomTransportError(Object.assign(new Error("connect ETIMEDOUT"), {code: "ETIMEDOUT"}))];
  const cycle = flaky.getDiscussionCycle;
  flaky.getDiscussionCycle = async (...args) => { if (failures.length) throw failures.shift(); return cycle(...args); };
  const flakyRuntime = runtimeFor(await loadState(flakyFile), flakyFile, flaky);
  for (let round = 0; round < 3; round += 1) await flakyRuntime.applyRecoveryClosures();
  assert.deepEqual([flaky.acks, flakyRuntime.state.cursor], [[382], 382]);
  assert.equal(flakyRuntime.logs.filter((line) => line.includes("not applied yet (retrying)")).length, 1, flakyRuntime.logs.join(" | "));
  const finalFile = await account(paulaState(), "final");
  recovery.appendRecord(recovery.journalPath(finalFile), sealed);
  const broken = proofRoom();
  broken.getDiscussionCycle = async () => { throw new RoomAPIError(404, {code: "not_found"}); };
  const brokenRuntime = runtimeFor(await loadState(finalFile), finalFile, broken);
  await brokenRuntime.applyRecoveryClosures();
  await brokenRuntime.applyRecoveryClosures();
  assert.equal(brokenRuntime.logs.filter((line) => /recovery closure for seq 379 not applied: http_404/.test(line)).length, 1);
  assert.deepEqual([broken.acks, brokenRuntime.state.appliedRecoveryClosures], [[], {}]);

  // OP-12 P3 delta: a local write failure (ENOSPC once) is retried; the
  // evidence is written at the next iteration and the acknowledgement moves.
  const diskFile = await account(paulaState(), "enospc");
  recovery.appendRecord(recovery.journalPath(diskFile), sealed);
  const diskRoom = proofRoom();
  const diskRuntime = runtimeFor(await loadState(diskFile), diskFile, diskRoom);
  let full = true;
  const persist = diskRuntime.persistState.bind(diskRuntime);
  diskRuntime.persistState = async () => {
    if (full) {
      full = false;
      delete diskRuntime.state.terminalEvidence["379"];
      throw Object.assign(new Error("no space left on device"), {code: "ENOSPC", syscall: "write"});
    }
    return persist();
  };
  await diskRuntime.applyRecoveryClosures();
  assert.deepEqual(diskRoom.acks, []);
  assert.ok(diskRuntime.state.appliedRecoveryClosures["379"], "the mark is set before the evidence");
  await diskRuntime.applyRecoveryClosures();
  assert.deepEqual([diskRoom.acks, diskRuntime.state.cursor], [[382], 382]);
  assert.equal(diskRuntime.logs.filter((line) => line.includes("not applied yet (retrying): local_write_failed")).length, 1, diskRuntime.logs.join(" | "));
  // A mark that reached disk without its evidence (then a restart) heals too.
  const markedFile = await account({...paulaState(), appliedRecoveryClosures: {"379": {recordDigest: sealed.recordDigest, appliedAt: "2026-10-03T00:00:00Z"}}}, "marked");
  recovery.appendRecord(recovery.journalPath(markedFile), sealed);
  const markedRoom = proofRoom();
  const restarted = runtimeFor(await loadState(markedFile), markedFile, markedRoom);
  await restarted.applyRecoveryClosures();
  assert.deepEqual([markedRoom.acks, restarted.state.cursor], [[382], 382]);
  assert.equal((await loadState(markedFile)).cursor, 382);

  // An undecodable line or a record whose proof is not an object is skipped;
  // the valid record still applies (as Hermes).
  const notObject = {...sealed, proof: "not-an-object"};
  notObject.recordDigest = recovery.recordDigest(notObject);
  const messyFile = await account(paulaState(), "messy");
  await writeFile(recovery.journalPath(messyFile), Buffer.concat([
    Buffer.from('{"version":1,"verb":"close","operator":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n'),
    Buffer.from(`${JSON.stringify(notObject)}\n`), Buffer.from([0xc3, 0x28, 0x0a]), Buffer.from(`${"[".repeat(200000)}\n`), Buffer.from(`${recovery.canonical(sealed)}\n`),
  ]), {mode: 0o600});
  assert.deepEqual(recovery.readRecords(recovery.journalPath(messyFile)).map((item) => item.recordDigest), [sealed.recordDigest]);
  assert.throws(() => recovery.confirmToken(notObject), /proof must be an object/);
});

test("P3-08 the status file is written next to the state in use and its directory is created 0700", async () => {
  // Aura: OPENCLAW_STATE_DIR elsewhere, accounts under ~/.openclaw.
  const accounts = join(home, "aura-home", ".openclaw", "synthetic-sociality-room", "accounts");
  const cfg = {channels: {"synthetic-sociality-room": {baseUrl: "https://room.example/api", stateFile: join(accounts, "hpaey501k5fmc3n.json")}}};
  const path = roomStatusPath(cfg);
  assert.equal(path, join(home, "aura-home", ".openclaw", "synthetic-sociality-room", "status.json"));
  assert.equal(roomStatusPath({}), join(home, "openclaw", "synthetic-sociality-room", "status.json"));
  // A state file outside an accounts/ layout: its own directory.
  const custom = {channels: {"synthetic-sociality-room": {baseUrl: "https://room.example/api", stateFile: join(home, "elsewhere", "room-state.json")}}};
  assert.equal(roomStatusPath(custom), join(home, "elsewhere", "status.json"));
  const status = new LocalStatus(path, {plugin: "openclaw", version: "test", hostLabel: "h"});
  assert.equal(status.write(), true);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // Never a filesystem root or a top-level directory (P2a-5).
  assert.equal(new LocalStatus("/p3-status-test/status.json", {plugin: "openclaw", version: "x", hostLabel: "h"}).write(), false);
  assert.ok(!existsSync("/p3-status-test"));
});

test("P3-09 a known path argument is resolved whatever its shape and denied tools count as isolated", async () => {
  const stateDir = join(home, "openclaw");
  const store = join(stateDir, "synthetic-sociality-room");
  const policy = roomToolCallPolicy({config: ISOLATED_HOST_CONFIG, logger: {warn: () => {}}});
  // From the state directory, a bare directory name; inside the store, a bare file name.
  assert.equal(policy({toolName: "grep", params: {path: "synthetic-sociality-room", pattern: "x"}}, {workspaceDir: stateDir})?.block, true);
  assert.equal(policy({toolName: "read", params: {path: "status.json"}}, {workspaceDir: store})?.block, true);
  assert.equal(policy({toolName: "read", params: {file: "member-1.json"}}, {workspaceDir: join(store, "accounts")})?.block, true);
  assert.equal(policy({toolName: "read", params: {path: "notes.md"}}, {workspaceDir: join(stateDir, "workspace")}), undefined);
  // Denied shell tools with fenced file tools: isolated (P3-7, P2c-1).
  assert.deepEqual(isolation.storeReachability(ISOLATED_HOST_CONFIG, [store], {stateDir}), []);
  assert.deepEqual(isolation.storeReachability({tools: {fs: {workspaceOnly: true}}}, [store], {stateDir}), ["host_shell_tools", "remote_command_tool"]);
});
