// Shared conformance case for parity release P5 (delivery contract section
// "P5 — Cycle documents"). The case name is identical in the Hermes and
// OpenClaw conformance.json files. Incident (Showroom, 2026-10-03
// 21:25-21:32Z): a brief attached to the message that started a debate reached
// the debaters only on the turns whose attempt named that message; on every
// other turn they saw the library catalog only. No test uses a real credential
// or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
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
const {ARTIFACT_CONTEXT_CHARACTER_LIMIT, OpenClawRoomRuntime, isAssignedMessage} = await import("../src/runtime.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p5-"));
after(() => rm(home, {recursive: true, force: true}));

const BRIEF_TEXT = "Debate brief, owner's attachment." + " Position A holds that the evidence is decisive.".repeat(450);
const PEER_TEXT = "Peer appendix: the counter-study of 2025.";
const OPEN_TEXT = "Open Room note: minutes of the last meeting.";
const DOCUMENTS = "[Room-shared document context";
const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
  {membershipId: "paula", displayName: "Paula", role: "participant_agent", status: "active"},
];
const manifest = (artifactId) => ({artifactId, versionId: "v1", name: `${artifactId}.md`, mediaType: "text/markdown", sha256: "c".repeat(64)});
const artifact = (artifactId, text) => ({artifactId, visibility: "room_shared",
  currentVersion: {versionId: "v1", name: `${artifactId}.md`, mediaType: "text/markdown", sha256: "c".repeat(64), extractionStatus: "ready", extractedText: text}});
const ARTIFACTS = {brief: artifact("brief", BRIEF_TEXT), peer: artifact("peer", PEER_TEXT), open: artifact("open", OPEN_TEXT)};

const START = {id: "start-z", seq: 41, type: "discussion.started", actorRole: "human_owner", actorId: "owner-tj",
  payload: {epoch: {id: "epoch-z", startsAtSeq: 41, topic: {title: "Debate"}}}};
const SOURCE = {id: "m-src", seq: 42, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Debate: is the evidence decisive? Brief attached.", epochId: "epoch-z", attachments: [manifest("brief")]}};
// Room traffic between the source message and the debate (cycle and activity
// events, no messages), so that later turns no longer load the source with
// their recent events and resolve it by the bounded scan.
const GAP = Array.from({length: 157}, (_, index) => ({id: `sys-${43 + index}`, seq: 43 + index, type: "discussion.cycle_started",
  actorRole: "system", actorId: "room_coordinator", payload: {cycleId: `cycle-${43 + index}`}}));
const contribution = (seq, actorId = "paula", attachments) => ({id: `m-${seq}`, seq, type: "message.posted", actorRole: "participant_agent",
  actorId, payload: {body: `Contribution ${seq}.`, epochId: "epoch-z", resolvedRecipientMembershipIds: ["zurie"], ...(attachments ? {attachments} : {})}});
const readyFor = (seq, sourceEventId) => ({id: `ready-${seq}`, seq, type: "discussion.cycle_attempt_ready", actorRole: "system",
  actorId: "room_coordinator", payload: {cycleId: "cycle-1", epochId: "epoch-z", generation: 1, membershipId: "zurie", round: 1, sourceEventId}});
// The claim response as Room server 772ca32 returns it: {attempt, cycle}.
const claimed = (sourceEventId = "m-src") => ({attempt: {id: "attempt-1", round: 1, membershipId: "zurie"},
  cycle: {id: "cycle-1", generation: 1, totalTurns: 1, sourceEventId, budgets: {totalTurns: 16, perAgentTurns: 8}}});

// The turn the runtime hands to OpenClaw for the last event of `events`.
async function turnFor(events, {claim = claimed(), artifacts = ARTIFACTS, readEvents, runtime: existing} = {}) {
  const runtime = existing ?? new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  const last = events.at(-1);
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: last.seq - 1, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.reads = [];
  const read = readEvents ?? (async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: 41,
    events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}));
  runtime.client = {
    readEvents: async (state, afterSeq, options) => { runtime.reads.push(afterSeq); return read(state, afterSeq, options); },
    roomState: async () => ({headSeq: last.seq, activeEpoch: {id: "epoch-z", startsAtSeq: 41}, activeTopic: {title: "Debate"}, roster: ROSTER, rules: []}),
    roomPolicy: async () => ({policy: {coordinationMode: claim ? "coordinated" : "open"}}),
    listArtifacts: async () => ({items: []}),
    getArtifact: async (_session, artifactId) => structuredClone(artifacts[artifactId] ?? {}),
    startDiscussionCycle: async () => { throw new Error("no cycle start in this suite"); },
    claimDiscussionAttempt: async () => structuredClone(claim),
    acknowledge: async (_state, seq) => ({acknowledgedSeq: seq}),
    acknowledgePeerContribution: async () => ({}),
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const {value, done} = await turns.next();
  controller.abort();
  await turns.return();
  assert.equal(done, false, "a turn is yielded");
  return {turn: value, runtime};
}

function* debate(turns) {
  const events = [START, SOURCE, ...GAP];
  let previous = "m-src";
  for (let turn = 1; turn <= turns; turn += 1) {
    const ready = readyFor(197 + 3 * turn, previous);
    events.push(ready);
    yield [turn, [...events]];
    events.push(contribution(198 + 3 * turn, turn % 2 ? "paula" : "zurie"));
    previous = events.at(-1).id;
    // An audience remark (a message, no attachment) between turns.
    events.push({id: `m-${199 + 3 * turn}`, seq: 199 + 3 * turn, type: "message.posted", actorRole: "human_member", actorId: "guest-1",
      payload: {body: "Noted.", epochId: "epoch-z"}});
  }
}

const count = (text, part) => text.split(part).length - 1;
// Reads below the loaded page (seq - 50) and above the epoch start read (40)
// are the bounded scan's.
const scanReads = (runtime, seq) => runtime.reads.filter((after) => after > 40 && after < seq - 50).length;
const documentsBlock = (text) => {
  const start = text.indexOf(DOCUMENTS);
  return start < 0 ? "" : text.slice(start, text.indexOf("[/Room-shared document context]", start));
};

test("conformance P5 case names resolve to tests in this suite", async () => {
  const cases = Object.entries(conformance.parityP5Cases ?? {});
  assert.equal(cases.length, 2);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  cases.forEach(([id, name], index) => {
    assert.equal(id, `P5-${String(index + 1).padStart(2, "0")}`);
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
  });
  assert.equal(conformance.parityP5Contract, "docs/delivery-lifecycle-contract-v1.md#p5--cycle-documents-2026-10-03");
});

test("P5-01 every turn of a cycle carries the cycle source's attachments once, then the turn source's, within the limits", async () => {
  // Sixteen turns: the brief is in every turn's context, exactly once, read
  // by the bounded scan once the source has left the loaded page (OpenClaw
  // loads the 50 events before the turn).
  const scanned = [];
  for (const [turn, events] of debate(16)) {
    const {turn: dispatched, runtime} = await turnFor(events);
    if (scanReads(runtime, events.at(-1).seq)) scanned.push(turn);
    assert.equal(count(dispatched.text, BRIEF_TEXT), 1, `turn ${turn}`);
    assert.equal(count(dispatched.text, "Artifact/version: brief / v1"), 1, `turn ${turn}`);
  }
  assert.equal(scanned.length, 16, JSON.stringify(scanned));

  // A peer message with its own attachment: both, the cycle source first; the
  // source is on the loaded page, so nothing is scanned.
  const ready = readyFor(44, "m-43");
  let {turn, runtime} = await turnFor([START, SOURCE, contribution(43, "paula", [manifest("peer")]), ready]);
  assert.equal(scanReads(runtime, 44), 0);
  let block = documentsBlock(turn.text);
  assert.deepEqual([count(block, BRIEF_TEXT), count(block, PEER_TEXT)], [1, 1]);
  assert.ok(block.indexOf(BRIEF_TEXT) < block.indexOf(PEER_TEXT));
  // The same exact version attached again is rendered once.
  ({turn} = await turnFor([START, SOURCE, contribution(43, "paula", [manifest("brief"), manifest("peer")]), ready]));
  assert.deepEqual([count(turn.text, BRIEF_TEXT), count(turn.text, PEER_TEXT)], [1, 1]);

  // Limits unchanged: 8 attachments, 64,000 characters, the cycle source's
  // first and the turn source's cut at the limit.
  const many = Array.from({length: 8}, (_, index) => manifest(`doc-${index}`));
  const library = Object.fromEntries(many.map((item, index) => [item.artifactId, artifact(item.artifactId, `Document ${index}.`)]));
  const crowded = {...SOURCE, payload: {...SOURCE.payload, attachments: many}};
  ({turn} = await turnFor([START, crowded, contribution(43, "paula", [manifest("peer")]), ready], {artifacts: {...ARTIFACTS, ...library}}));
  assert.equal(count(documentsBlock(turn.text), "Document: "), 8);
  assert.match(turn.text, /Document 7\./);
  assert.doesNotMatch(turn.text, new RegExp(PEER_TEXT));
  ({turn} = await turnFor([START, SOURCE, contribution(43, "paula", [manifest("peer")]), ready],
    {artifacts: {...ARTIFACTS, brief: artifact("brief", "x".repeat(70_000))}}));
  const rendered = `${documentsBlock(turn.text)}[/Room-shared document context]`;
  // The bound as before P5 (its accounting leaves out one separator).
  assert.ok(rendered.length <= ARTIFACT_CONTEXT_CHARACTER_LIMIT + 2, String(rendered.length));
  assert.match(rendered, /x…/);
  assert.doesNotMatch(turn.text, new RegExp(PEER_TEXT));

  // Unresolvable cycle source (outside the scan bound, or a Room error): the
  // turn proceeds without it and one coded line says so.
  ({turn, runtime} = await turnFor([START, contribution(43, "paula", [manifest("peer")]), ready], {claim: claimed("m-gone")}));
  assert.match(turn.text, new RegExp(PEER_TEXT));
  assert.doesNotMatch(turn.text, /Debate brief/);
  assert.equal(runtime.logs.filter((line) => line.includes("code cycle_source_unresolved")).length, 1, runtime.logs.join("\n"));
  const late = readyFor(220, "m-219");
  const busy = [START, SOURCE, ...GAP, ...Array.from({length: 20}, (_, index) => contribution(200 + index)), late];
  ({turn, runtime} = await turnFor(busy, {readEvents: async (_state, afterSeq) => {
    if (afterSeq > 40 && afterSeq < 150) throw new Error("Room unavailable");
    return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 41, events: busy.filter((item) => item.seq > afterSeq).slice(0, 100)};
  }}));
  assert.doesNotMatch(turn.text, /Debate brief/);
  assert.match(turn.text, /Contribution 219\./);
  assert.ok(runtime.logs.some((line) => line.includes("code cycle_source_unresolved") && line.includes("reason Error")), runtime.logs.join("\n"));

  // Outside a cycle (open Room, no claimed attempt): its own attachments only.
  const human = {id: "m-221", seq: 221, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
    payload: {body: "Notes attached.", epochId: "epoch-z", attachments: [manifest("open")]}};
  ({turn} = await turnFor([START, SOURCE, human], {claim: null}));
  block = documentsBlock(turn.text);
  assert.deepEqual([count(block, OPEN_TEXT), count(block, BRIEF_TEXT)], [1, 0]);
});

test("the cycle source is read once per cycle", async () => {
  const events = [START, SOURCE, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const first = await turnFor([...events, readyFor(230, "m-229")]);
  assert.ok(scanReads(first.runtime, 230) > 0);
  const second = await turnFor([...events, readyFor(230, "m-229"), readyFor(231, "m-229")], {runtime: first.runtime});
  assert.equal(scanReads(second.runtime, 231), 0);
  assert.equal(count(second.turn.text, BRIEF_TEXT), 1);
});

// OP-12 P4 r3 finding 4: "human_" exactly at each of the two role sites, each
// on its own (the shared P2a test covers the two together).
test("isAssignedMessage reads only human and human_ roles as human", () => {
  const event = (actorRole) => ({type: "message.posted", actorId: "someone", actorRole, payload: {body: "Hello room"}});
  for (const role of ["humanoid", "human-owner", "humans"]) assert.equal(isAssignedMessage(event(role), "zurie"), false, role);
  for (const role of ["human", "human_member", "agent_owner"]) assert.equal(isAssignedMessage(event(role), "zurie"), true, role);
});

test("a message from a role that only starts with human never starts a cycle", async () => {
  for (const role of ["humanoid", "human-owner"]) {
    const addressed = {id: "m-60", seq: 60, type: "message.posted", actorRole: role, actorId: "someone",
      payload: {body: "@Zurie?", epochId: "epoch-z", resolvedRecipientMembershipIds: ["zurie"]}};
    const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
    runtime.state = {roomId: "room-1", membershipId: "zurie"};
    const starts = [];
    runtime.client = {roomPolicy: async () => ({policy: {coordinationMode: "coordinated"}})};
    runtime.ensureDiscussionCycle = async (event) => { starts.push(event.id); return {cycle: {id: "c"}}; };
    assert.equal(await runtime.prepareCycleAttempt(addressed, undefined), null, role);
    assert.deepEqual(starts, [], role);
  }
});
