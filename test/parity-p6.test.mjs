// Shared conformance cases for parity release P6 (delivery contract section
// "P6 — Clean start and bounds", and P5-2). The case names are identical in
// the Hermes and OpenClaw conformance.json files. Owner, ISSUE-015/016:
// "/start-discussion should also reset the tokens in the room". No test uses
// a real credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {createHash} from "node:crypto";
import {chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir} from "node:fs/promises";
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
const {
  CYCLE_DOCUMENT_SOURCE_CACHE, CYCLE_DOCUMENT_SOURCE_TIMEOUT_MS, GUIDANCE_CHARACTER_LIMIT, OpenClawRoomRuntime,
  boundedGuidance, canonicalRoomContext, epochConversationId, knownEpochStart, savedGuidance, validateActiveEpochPage,
} = await import("../src/runtime.js");
const {resolvedRoomAccounts} = await import("../src/account-discovery.js");
const {runRecoveryCli} = await import("../src/recovery-cli.js");
const {rotationRequestPath} = await import("../src/epoch-rotation.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p6-"));
after(() => rm(home, {recursive: true, force: true}));

const BRIEF_TEXT = "Debate brief, owner's attachment." + " Position A holds that the evidence is decisive.".repeat(450);
const PEER_TEXT = "Peer appendix: the counter-study of 2025.";
const OLD_TEXT = "Earlier discussion's document: the rejected plan.";
const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
  {membershipId: "paula", displayName: "Paula", role: "participant_agent", status: "active"},
];
const manifest = (artifactId) => ({artifactId, versionId: "v1", name: `${artifactId}.md`, mediaType: "text/markdown", sha256: "c".repeat(64)});
const artifact = (artifactId, text) => ({artifactId, visibility: "room_shared",
  currentVersion: {versionId: "v1", name: `${artifactId}.md`, mediaType: "text/markdown", sha256: "c".repeat(64), extractionStatus: "ready", extractedText: text}});
const ARTIFACTS = {brief: artifact("brief", BRIEF_TEXT), peer: artifact("peer", PEER_TEXT), old: artifact("old", OLD_TEXT)};

// The discussion before the active one (epoch-z starts at seq 41).
const OLD = {id: "m-30", seq: 30, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Earlier discussion: the rejected plan.", epochId: "epoch-y", attachments: [manifest("old")]}};
const START = {id: "start-z", seq: 41, type: "discussion.started", actorRole: "human_owner", actorId: "owner-tj",
  payload: {epoch: {id: "epoch-z", startsAtSeq: 41, topic: {title: "Debate"}}}};
const SOURCE = {id: "m-src", seq: 42, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Debate: is the evidence decisive? Brief attached.", epochId: "epoch-z", attachments: [manifest("brief")]}};
const GAP = Array.from({length: 157}, (_, index) => ({id: `sys-${43 + index}`, seq: 43 + index, type: "discussion.cycle_started",
  actorRole: "system", actorId: "room_coordinator", payload: {cycleId: `cycle-${43 + index}`}}));
const contribution = (seq, actorId = "paula", attachments) => ({id: `m-${seq}`, seq, type: "message.posted", actorRole: "participant_agent",
  actorId, payload: {body: `Contribution ${seq}.`, epochId: "epoch-z", resolvedRecipientMembershipIds: ["zurie"], ...(attachments ? {attachments} : {})}});
const readyFor = (seq, sourceEventId, cycleId = "cycle-1") => ({id: `ready-${seq}`, seq, type: "discussion.cycle_attempt_ready", actorRole: "system",
  actorId: "room_coordinator", payload: {cycleId, epochId: "epoch-z", generation: 1, membershipId: "zurie", round: 1, sourceEventId}});
const claimed = (sourceEventId = "m-src", cycleId = "cycle-1") => ({attempt: {id: "attempt-1", round: 1, membershipId: "zurie"},
  cycle: {id: cycleId, generation: 1, totalTurns: 1, sourceEventId, budgets: {totalTurns: 16, perAgentTurns: 8}}});
const count = (text, part) => text.split(part).length - 1;

// The turn the runtime hands to OpenClaw for the last event of `events`.
async function turnFor(events, options = {}) {
  const {claim = claimed(), readEvents, runtime: existing, state = {}, rules = []} = options;
  // An explicit undefined start is a missing start, not the default.
  const startsAt = Object.hasOwn(options, "startsAt") ? options.startsAt : 41;
  const pageStartsAt = Object.hasOwn(options, "pageStartsAt") ? options.pageStartsAt : startsAt;
  const runtime = existing ?? new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  const last = events.at(-1);
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: last.seq - 1, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "", ...state};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.reads = [];
  const read = readEvents ?? (async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: pageStartsAt,
    events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}));
  runtime.client = {
    readEvents: async (session, afterSeq, options) => { runtime.reads.push(afterSeq); return read(session, afterSeq, options); },
    roomState: async () => ({headSeq: last.seq, activeEpoch: {id: "epoch-z", startsAtSeq: startsAt}, activeTopic: {title: "Debate"}, roster: ROSTER, rules}),
    roomPolicy: async () => ({policy: {coordinationMode: claim ? "coordinated" : "open"}}),
    listArtifacts: async () => ({items: []}),
    getArtifact: async (_session, artifactId) => structuredClone(ARTIFACTS[artifactId] ?? {}),
    startDiscussionCycle: async () => { throw new Error("no cycle start in this suite"); },
    claimDiscussionAttempt: async () => structuredClone(claim),
    acknowledge: async (_state, seq) => { options.acks?.push(seq); return {acknowledgedSeq: seq}; },
    acknowledgePeerContribution: async () => ({}),
  };
  if (options.topic !== undefined) {
    const roomState = runtime.client.roomState;
    runtime.client.roomState = async (...args) => {
      const value = await roomState(...args);
      if (options.topic === null) delete value.activeTopic;
      else value.activeTopic = options.topic;
      return value;
    };
  }
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

const casesOf = (key) => Object.entries(conformance[key] ?? {});
async function testSources() {
  const directory = new URL("./", import.meta.url);
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
}

test("conformance P6 and P5 case names resolve to tests in this suite", async () => {
  const sources = await testSources();
  for (const [key, prefix, size] of [["parityP6Cases", "P6", 10], ["parityP5Cases", "P5", 3]]) {
    const cases = casesOf(key);
    assert.equal(cases.length, size, key);
    cases.forEach(([id, name], index) => {
      assert.equal(id, `${prefix}-${String(index + 1).padStart(2, "0")}`);
      assert.ok(name.startsWith(`${id} `), id);
      assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
    });
  }
  assert.equal(conformance.parityP6Contract, "docs/delivery-lifecycle-contract-v1.md#p6--clean-start-and-bounds-2026-10-04");
});

test("P6-01 a new discussion runs in a new host session and no block holds an event from before its start", async () => {
  const kept = {epochId: "epoch-y", producedAt: "2026-10-03T20:00:00Z", reason: "superseded", sourceEventId: "m-30", sourceSeq: 30,
    text: "Kept reply from the earlier discussion."};
  const base = [OLD, START, SOURCE, contribution(43), ...GAP.slice(1, 12)];
  for (const [label, event, claim] of [
    ["cycle source before the start", readyFor(70, "m-30"), claimed("m-30")],
    ["turn source in the epoch", readyFor(70, "m-43"), claimed("m-30")],
    ["open Room message", {...contribution(70, "owner-tj"), actorRole: "human_owner"}, null],
  ]) {
    const {turn} = await turnFor([...base, event], {claim, state: {keptReply: {...kept}, missedSources: [{sourceEventId: "m-30", sourceSeq: 30}]}});
    for (const earlier of ["rejected plan", OLD_TEXT, "Kept reply from the earlier discussion", "#30 "]) {
      assert.equal(count(turn.text, earlier), 0, `${label}: ${earlier}`);
    }
    assert.match(turn.text, /Contribution 43\./, label);
    assert.equal(turn.conversationId, epochConversationId("room-1", "epoch-z"), label);
  }
  // A new discussion: a new host session; the earlier one is not reused.
  assert.notEqual(epochConversationId("room-1", "epoch-z"), epochConversationId("room-1", "epoch-y"));
  assert.equal(epochConversationId("room-1", "epoch-z"),
    `room-1:epoch:${createHash("sha256").update("epoch-z").digest("hex").slice(0, 32)}`);
});

test("P6-02 an epoch without a start gives a prompt without earlier events and the turn proceeds", async () => {
  for (const startsAt of [0, undefined, null, -3]) {
    const kept = {epochId: "epoch-z", producedAt: "2026-10-03T20:00:00Z", reason: "superseded", sourceEventId: "m-42", sourceSeq: 42, text: "Kept text."};
    // An open entry and one the Room named and that was offered (L1-13).
    const missed = [{sourceEventId: "m-src", sourceSeq: 42}, {sourceEventId: "m-40", sourceSeq: 0, offered: true}];
    // Seq 170: nothing earlier is in the loaded page of 50 (P6-07 covers that).
    const events = [OLD, START, SOURCE, contribution(43), readyFor(170, "m-43")];
    const {turn, runtime} = await turnFor(events, {startsAt, state: {keptReply: {...kept}, missedSources: structuredClone(missed)}});
    for (const earlier of ["rejected plan", "Brief attached", "Contribution 43.", "Kept text.", BRIEF_TEXT, OLD_TEXT, "Missed earlier"]) {
      assert.equal(count(turn.text, earlier), 0, `${startsAt}: ${earlier.slice(0, 30)}`);
    }
    assert.equal(runtime.logs.filter((line) => line.includes("code epoch_start_unknown")).length, 1, runtime.logs.join("\n"));
    // Only the page for the current event; no scan below it.
    assert.ok(runtime.reads.every((after) => after >= 120), JSON.stringify(runtime.reads));
    // Neither offered nor cleared.
    assert.deepEqual(runtime.state.keptReply, kept);
    assert.deepEqual(runtime.state.missedSources, missed);
  }
  // Page metadata: a valid id without a start is processed with the start
  // unknown; a missing id, or a start of another shape, still fails closed.
  for (const startsAt of [undefined, null, 0, -3]) {
    assert.deepEqual(validateActiveEpochPage({activeEpochId: "epoch-z", activeEpochStartsAtSeq: startsAt}), {id: "epoch-z", startsAtSeq: 0});
  }
  // Round 2 (contract P6-2): every other start shape is unknown as well.
  for (const startsAt of [1.5, "10", true, [41]]) {
    assert.deepEqual(validateActiveEpochPage({activeEpochId: "epoch-z", activeEpochStartsAtSeq: startsAt}), {id: "epoch-z", startsAtSeq: 0});
  }
  for (const page of [{activeEpochStartsAtSeq: 10}, {activeEpochId: "", activeEpochStartsAtSeq: 10}]) {
    assert.throws(() => validateActiveEpochPage(page), /active epoch/i);
  }
});

async function stateFileFor(name, extra = {}) {
  const directory = join(home, `rotation-${name}`);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const file = join(directory, "account.json");
  await writeFile(file, `${JSON.stringify({version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie",
    credential: "fixture-credential", clientInstanceId: "client-1", cursor: 7, epochSessionRoutingInitialized: true,
    legacySessionEpochId: "epoch-z", ...extra})}\n`);
  await chmod(file, 0o600);
  return file;
}

test("P6-03 rotate-current-epoch-session is a dry run without --yes and with it authorises one fresh epoch session", async () => {
  const file = await stateFileFor("main");
  const before = await readFile(file);
  const lines = [];
  assert.equal(await runRecoveryCli(["rotate-current-epoch-session", "--state", file], {write: (line) => lines.push(line)}), 0);
  assert.match(lines.join("\n"), /Dry run\./);
  assert.match(lines.join("\n"), /legacy Room session/);
  assert.deepEqual(await readFile(file), before, "a dry run changes nothing");
  await assert.rejects(stat(rotationRequestPath(file)), {code: "ENOENT"});

  lines.length = 0;
  assert.equal(await runRecoveryCli(["rotate-current-epoch-session", "--state", file, "--yes"], {write: (line) => lines.push(line)}), 0);
  assert.deepEqual(await readFile(file), before, "the command never writes the state a running connector owns");
  assert.equal((await stat(rotationRequestPath(file))).mode & 0o777, 0o600);
  lines.length = 0;
  await runRecoveryCli(["rotate-current-epoch-session", "--state", file], {write: (line) => lines.push(line)});
  assert.match(lines.join("\n"), /already authorized/);
  assert.equal(lines.join("\n").includes("fixture-credential"), false);

  // Consumed once, at the next start, with Hermes' semantics.
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: file, baseUrl: "https://room.example/api"});
  runtime.state = JSON.parse(await readFile(file, "utf8"));
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line)};
  await runtime.consumeEpochSessionRotation();
  await assert.rejects(stat(rotationRequestPath(file)), {code: "ENOENT"});
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([stored.epochSessionRoutingInitialized, stored.legacySessionEpochId, stored.rotateCurrentEpochSession], [false, "", true]);
  // The current epoch then routes to its epoch session, not the legacy one.
  const {turn} = await turnFor([START, SOURCE, readyFor(44, "m-src")], {state: {
    epochSessionRoutingInitialized: false, legacySessionEpochId: "", rotateCurrentEpochSession: true}});
  assert.equal(turn.conversationId, epochConversationId("room-1", "epoch-z"));
  const legacy = await turnFor([START, SOURCE, readyFor(44, "m-src")], {state: {
    epochSessionRoutingInitialized: false, legacySessionEpochId: "", rotateCurrentEpochSession: false}});
  assert.equal(legacy.turn.conversationId, "room-1");

  // A request for another membership is left in place and logged by code.
  const other = await stateFileFor("other");
  await writeFile(rotationRequestPath(other), JSON.stringify({version: 1, roomId: "room-1", membershipId: "paula", clientInstanceId: "client-1"}), {mode: 0o600});
  const otherRuntime = new OpenClawRoomRuntime({accountId: "t", stateFile: other, baseUrl: "https://room.example/api"});
  otherRuntime.state = JSON.parse(await readFile(other, "utf8"));
  otherRuntime.logs = [];
  otherRuntime.logger = {info: (line) => otherRuntime.logs.push(line), warn: (line) => otherRuntime.logs.push(line)};
  const otherBefore = await readFile(other);
  await otherRuntime.consumeEpochSessionRotation();
  assert.deepEqual(await readFile(other), otherBefore);
  assert.ok((await stat(rotationRequestPath(other))).isFile());
  assert.ok(otherRuntime.logs.some((line) => line.includes("code rotation_request_invalid")), otherRuntime.logs.join("\n"));
});

test("P6-04 the Room guidance is cut by the one shared rule at 3,000 characters", () => {
  const vectors = conformance.parityP6GuidanceVector;
  assert.deepEqual(vectors.map((vector) => vector.name), ["cut", "drop", "fit", "one", "edges"]);
  assert.equal(GUIDANCE_CHARACTER_LIMIT, 3_000);
  for (const vector of vectors) {
    // Contract P6-4 edges: rule shapes, the trimmed set, a lone surrogate.
    const rules = vector.roomRules ?? vector.rules.map((text) => ({enforcement: "guidance", text}));
    const rendered = (vector.roomRules ? savedGuidance(vector.roomRules).lines : boundedGuidance(vector.rules)).join("\n");
    assert.equal(Array.from(rendered).length, vector.codePoints, vector.name);
    assert.equal(createHash("sha256").update(rendered, "utf8").digest("hex"), vector.sha256, vector.name);
    // No lone surrogate reaches the prompt: it is U+FFFD there (the UTF-8
    // digest alone cannot tell, as Node encodes a lone surrogate as U+FFFD).
    assert.ok(rendered.isWellFormed(), vector.name);
    // The prompt carries exactly that text.
    const context = canonicalRoomContext({title: "Room", rules}, []);
    assert.ok(context.includes(`${rendered}\n`), vector.name);
  }
  // A private briefing of about 1,700 characters passes whole.
  const briefing = "Briefing. ".repeat(170).trim();
  assert.ok(canonicalRoomContext({rules: [{enforcement: "guidance", text: briefing}]}, []).includes(`- ${briefing}\n`));
});

test("P5-02 a slow or unresolvable cycle source costs at most one bounded lookup per cycle and never delays a turn beyond the bound", {timeout: 20_000}, async () => {
  assert.equal(CYCLE_DOCUMENT_SOURCE_TIMEOUT_MS, 10_000);
  const events = [START, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const scanReads = (runtime, seq) => runtime.reads.filter((afterSeq) => afterSeq > 40 && afterSeq < seq - 50).length;
  // Unresolvable: one lookup for the cycle, then remembered.
  const first = await turnFor([...events, readyFor(230, "m-229")], {claim: claimed("m-gone")});
  assert.ok(scanReads(first.runtime, 230) > 0);
  assert.equal(first.runtime.logs.filter((line) => line.includes("code cycle_source_unresolved")).length, 1);
  const second = await turnFor([...events, readyFor(231, "m-229")], {claim: claimed("m-gone"), runtime: first.runtime});
  assert.equal(scanReads(second.runtime, 231), 0);
  assert.match(second.turn.text, /Contribution 229\./);
  assert.equal(second.runtime.logs.filter((line) => line.includes("code cycle_source_unresolved")).length, 0);

  // Slow: a scan read that never answers (and ignores the abort) holds the
  // turn at most for the bound; a timeout is not remembered, so the next turn
  // tries again under the same bound, and every scan read is aborted.
  const withSource = [START, SOURCE, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const hanging = (afterSeq) => afterSeq > 40 && afterSeq < 180;
  let served = [];
  // Each hanging read listens for its abort, as fetch does (a composite
  // AbortSignal.any without a listener is not a faithful stand-in for fetch),
  // and still never settles, so the race is what ends the wait.
  const aborts = [];
  const read = async (_state, afterSeq, options) => {
    if (hanging(afterSeq)) {
      options?.signal?.addEventListener("abort", () => aborts.push(options.signal.reason?.name), {once: true});
      return new Promise(() => {});
    }
    return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 41, events: served.filter((item) => item.seq > afterSeq).slice(0, 100)};
  };
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.cycleDocumentSourceTimeoutMs = 200;
  const started = Date.now();
  served = [...withSource, readyFor(230, "m-229")];
  const slow = await turnFor(served, {readEvents: read, runtime});
  assert.ok(Date.now() - started < 1_500, String(Date.now() - started));
  assert.equal(count(slow.turn.text, BRIEF_TEXT), 0);
  assert.ok(runtime.logs.some((line) => line.includes("code cycle_source_unresolved") && line.includes("reason TimeoutError")), runtime.logs.join("\n"));
  served = [...withSource, readyFor(231, "m-229")];
  const restarted = Date.now();
  const again = await turnFor(served, {readEvents: read, runtime});
  assert.ok(Date.now() - restarted < 1_500, String(Date.now() - restarted));
  assert.equal(again.runtime.reads.filter(hanging).length, 1, "one bounded attempt per turn");
  // Aborted by the bound itself (TimeoutError), not by the turn's own signal.
  assert.deepEqual(aborts, ["TimeoutError", "TimeoutError"], "the bound aborts the scan's reads");
});

test("the cycle-source cache is keyed per cycle and source", async () => {
  // OP-12 P5 review: two cycles of one Room, each with its own source
  // outside the loaded page.
  const other = {...SOURCE, id: "m-src2", seq: 43, payload: {body: "Second brief.", epochId: "epoch-z", attachments: [manifest("peer")]}};
  const events = [START, SOURCE, other, ...GAP.slice(1), ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const first = await turnFor([...events, readyFor(230, "m-229")]);
  assert.equal(count(first.turn.text, BRIEF_TEXT), 1);
  const second = await turnFor([...events, readyFor(231, "m-229", "cycle-2")], {claim: claimed("m-src2", "cycle-2"), runtime: first.runtime});
  assert.equal(count(second.turn.text, PEER_TEXT), 1);
  assert.equal(count(second.turn.text, BRIEF_TEXT), 0);
});

test("the cycle-source scan and cache respect the epoch floor", async () => {
  // OP-12 P5 review note 2: a cache hit must respect the floor.
  const events = [OLD, START, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const {turn} = await turnFor([...events, readyFor(230, "m-229")], {claim: claimed("m-30")});
  assert.equal(count(turn.text, OLD_TEXT), 0);
  const withSource = [START, SOURCE, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const first = await turnFor([...withSource, readyFor(230, "m-229")]);
  const [key] = first.runtime.cycleSourceEvents.keys();
  first.runtime.cycleSourceEvents.set(key, {floor: 1, event: OLD});
  const later = await turnFor([...withSource, readyFor(231, "m-229")], {runtime: first.runtime});
  assert.equal(count(later.turn.text, OLD_TEXT), 0);
  assert.equal(count(later.turn.text, BRIEF_TEXT), 1);
  first.runtime.cycleSourceEvents.set(key, {floor: 41, event: OLD});
  const below = await turnFor([...withSource, readyFor(232, "m-229")], {runtime: first.runtime});
  assert.equal(count(below.turn.text, OLD_TEXT), 0);
});

test("the cycle-source cache is bounded", async () => {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1"};
  runtime.client = {readEvents: async (_state, afterSeq) => ({events: afterSeq < 100 ? [{...SOURCE, seq: 100}] : []})};
  for (let index = 0; index < CYCLE_DOCUMENT_SOURCE_CACHE + 5; index += 1) {
    const found = await runtime.cycleDocumentSource({cycle: {id: `cycle-${index}`, sourceEventId: "m-src"}}, [], {seq: 150}, 41);
    assert.equal(found?.id, "m-src");
  }
  assert.equal(runtime.cycleSourceEvents.size, CYCLE_DOCUMENT_SOURCE_CACHE);
  assert.ok(runtime.cycleSourceEvents.has(`cycle-${CYCLE_DOCUMENT_SOURCE_CACHE + 4}\0m-src`));
});

test("a cycle source that is a human command beyond the page is found by the scan", async () => {
  // OP-12 P5 review: "cycle source types messages only" survived.
  const command = {id: "cmd-42", seq: 42, type: "human.command", actorRole: "human_owner", actorId: "owner-tj",
    payload: {command: {command: "debate"}, visibleText: "/debate", epochId: "epoch-z", attachments: [manifest("brief")]}};
  const events = [START, command, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const {turn, runtime} = await turnFor([...events, readyFor(230, "m-229")], {claim: claimed("cmd-42")});
  assert.equal(runtime.logs.filter((line) => line.includes("cycle_source_unresolved")).length, 0, runtime.logs.join("\n"));
  assert.equal(count(turn.text, BRIEF_TEXT), 1);
});

test("a turn source found by the scan keeps its own attachments", async () => {
  // OP-12 P5 review: "scanned turn source's attachments dropped" survived.
  const answered = contribution(150, "paula", [manifest("peer")]);
  const events = [START, SOURCE, ...GAP.slice(0, 100), answered, ...GAP.slice(108), ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const {turn} = await turnFor([...events, readyFor(230, "m-150")]);
  assert.equal(count(turn.text, PEER_TEXT), 1);
  assert.equal(count(turn.text, BRIEF_TEXT), 1);
});

test("a cycle source is never applied outside a cycle", async () => {
  // OP-12 P5 review: "cycle source applied outside a cycle" survived. An open
  // Room message after a cycle turn on the same runtime carries its own
  // attachments only.
  const withSource = [START, SOURCE, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const cycleTurn = await turnFor([...withSource, readyFor(230, "m-229")]);
  assert.equal(count(cycleTurn.turn.text, BRIEF_TEXT), 1);
  const open = {...contribution(231, "owner-tj", [manifest("peer")]), actorRole: "human_owner",
    payload: {body: "Open note.", epochId: "epoch-z", cycleId: "", attachments: [manifest("peer")]}};
  const {turn} = await turnFor([...withSource, open], {claim: null, runtime: cycleTurn.runtime});
  assert.equal(count(turn.text, PEER_TEXT), 1);
  assert.equal(count(turn.text, BRIEF_TEXT), 0);
});

// ---- Round 2 (OP-12 P6 reviews; PROMPTS-20261004-parity-P6-r2) ----

const HANDOVER = {sourceEpochOrdinal: 1, coveredThroughSeq: 40, revision: 1, reviewStatus: "human_reviewed", digest: "e".repeat(64),
  sections: {goal: "Decide how to disclose a diagnosis.", openQuestions: ["Who tells the family?"]},
  sourceRefs: [{kind: "event", eventId: "evt-40", seq: 40}]};
const START_H = {...START, payload: {...START.payload, handover: HANDOVER}};
const openNote = (seq) => ({id: `m-${seq}`, seq, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Open note.", epochId: "epoch-z"}});

test("P5-03 a failed or timed-out cycle-source lookup is tried again on the next turn and the brief returns", async () => {
  // Turn 1 has the source on its loaded page; then the Room moves on, turn 2's
  // lookup meets one Room error, and on turn 3 the brief is back.
  const early = [START, SOURCE, ...Array.from({length: 6}, (_, index) => contribution(43 + index)), readyFor(49, "m-48")];
  const first = await turnFor(early);
  assert.equal(count(first.turn.text, BRIEF_TEXT), 1);
  const later = [START, SOURCE, ...GAP.slice(7), ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  let failures = 1;
  const scanRange = (afterSeq) => afterSeq > 40 && afterSeq < 180;
  const read = (events) => async (_state, afterSeq) => {
    if (scanRange(afterSeq) && failures > 0) {
      failures -= 1;
      throw Object.assign(new Error("Room unavailable"), {name: "RoomAPIError"});
    }
    return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 41, events: events.filter((item) => item.seq > afterSeq).slice(0, 100)};
  };
  const turn2 = [...later, readyFor(230, "m-229")];
  const second = await turnFor(turn2, {runtime: first.runtime, readEvents: read(turn2)});
  assert.equal(count(second.turn.text, BRIEF_TEXT), 0);
  assert.ok(second.runtime.logs.some((line) => line.includes("cycle_source_unresolved") && line.includes("reason RoomAPIError")));
  const turn3 = [...later, readyFor(231, "m-229")];
  const third = await turnFor(turn3, {runtime: first.runtime, readEvents: read(turn3)});
  assert.equal(count(third.turn.text, BRIEF_TEXT), 1, "the brief is back on the next turn");
  // Found, then remembered: no further scan.
  const turn4 = [...later, readyFor(232, "m-229")];
  const fourth = await turnFor(turn4, {runtime: first.runtime, readEvents: read(turn4)});
  assert.equal(fourth.runtime.reads.filter(scanRange).length, 0);
  assert.equal(count(fourth.turn.text, BRIEF_TEXT), 1);
});

test("P6-05 a turn with the start unknown keeps nothing per epoch, so a later turn has the handover and the discussion start", async () => {
  const claim = claimed("start-z");
  const first = await turnFor([START_H, SOURCE, readyFor(60, "start-z")], {claim, startsAt: 0});
  assert.equal(count(first.turn.text, "Decide how to disclose a diagnosis."), 0);
  assert.equal(count(first.turn.text, "[Discussion started by"), 0);
  const second = await turnFor([START_H, SOURCE, readyFor(61, "start-z")], {claim, startsAt: 41, runtime: first.runtime});
  assert.equal(count(second.turn.text, "Decide how to disclose a diagnosis."), 1);
  assert.equal(count(second.turn.text, "[Discussion started by"), 1);
});

test("P6-06 the start is known only as an integer of at least 1 from the Room state, and a disagreeing page never stops a turn", async () => {
  for (const value of [undefined, null, 0, -3, 1.5, "41", "abc", true, false, [41], {seq: 41}, Number.NaN, 2 ** 53]) {
    assert.equal(knownEpochStart(value), 0, String(value));
  }
  for (const [value, known] of [[41, 41], [41.0, 41], [1, 1], [2 ** 53 - 1, 2 ** 53 - 1]]) assert.equal(knownEpochStart(value), known);
  const events = [OLD, START, SOURCE, contribution(43), openNote(70)];
  for (const startsAt of ["41", true, 1.5, [41], "abc"]) {
    const {turn, runtime} = await turnFor(events, {claim: null, startsAt});
    assert.equal(count(turn.text, "Contribution 43."), 0, String(startsAt));
    assert.equal(runtime.logs.filter((line) => line.includes("code epoch_start_unknown")).length, 1, String(startsAt));
  }
  // Page and Room state disagree: the Room state wins, the turn proceeds.
  for (const pageStartsAt of [0, 1.5, "41", 30]) {
    const {turn, runtime} = await turnFor(events, {claim: null, startsAt: 41, pageStartsAt});
    assert.equal(count(turn.text, "Contribution 43."), 1, String(pageStartsAt));
    assert.equal(count(turn.text, "rejected plan"), 0, String(pageStartsAt));
    assert.equal(runtime.logs.filter((line) => line.includes("epoch_start_unknown")).length, 0);
  }
  const {turn, runtime} = await turnFor(events, {claim: null, startsAt: 0, pageStartsAt: 41});
  assert.equal(count(turn.text, "Contribution 43."), 0);
  assert.equal(runtime.logs.filter((line) => line.includes("code epoch_start_unknown")).length, 1);
});

test("P6-07 with the start unknown the turn still renders its current item from the loaded page", async () => {
  const answered = contribution(43, "paula", [manifest("peer")]);
  const {turn, runtime} = await turnFor([OLD, START, SOURCE, answered, readyFor(70, "m-43")], {claim: claimed("m-43"), startsAt: 0});
  assert.equal(count(turn.text, "Contribution 43."), 1);
  assert.equal(count(turn.text, PEER_TEXT), 1);
  for (const earlier of ["rejected plan", OLD_TEXT, "Brief attached", BRIEF_TEXT]) assert.equal(count(turn.text, earlier), 0, earlier);
  assert.equal(turn.senderName, "Paula");
  assert.ok(runtime.logs.some((line) => line.includes("code epoch_start_unknown")));
  // Outside the loaded page of 50: no current item.
  const far = await turnFor([OLD, START, SOURCE, answered, readyFor(170, "m-43")], {claim: claimed("m-43"), startsAt: 0});
  assert.equal(count(far.turn.text, "Contribution 43."), 0);
});

test("P6-08 an unresolvable or hanging turn source costs one bounded scan per turn and never blocks a turn", {timeout: 20_000}, async () => {
  const events = [START, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const scanRange = (afterSeq) => afterSeq > 40 && afterSeq < 180;
  // The cycle's own source is on the page, so only the turn source is scanned.
  const first = await turnFor([...events, readyFor(230, "m-gone")], {claim: claimed("m-229")});
  assert.ok(first.runtime.reads.filter(scanRange).length > 0);
  const second = await turnFor([...events, readyFor(231, "m-gone")], {claim: claimed("m-229"), runtime: first.runtime});
  assert.equal(second.runtime.reads.filter(scanRange).length, 0, "not_found is remembered");
  // Hanging: at most the bound per turn; the next turn may scan again.
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.cycleDocumentSourceTimeoutMs = 200;
  let served = [];
  const read = async (_state, afterSeq) => {
    if (scanRange(afterSeq)) return new Promise(() => {});
    return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 41, events: served.filter((item) => item.seq > afterSeq).slice(0, 100)};
  };
  for (const seq of [230, 231]) {
    served = [...events, readyFor(seq, "m-slow")];
    const started = Date.now();
    const turn = await turnFor(served, {claim: claimed("m-229"), readEvents: read, runtime});
    assert.ok(Date.now() - started < 1_500, String(Date.now() - started));
    assert.equal(turn.runtime.reads.filter(scanRange).length, 1, `one bounded scan on turn ${seq}`);
    assert.ok(turn.runtime.logs.some((line) => line.includes("cycle source unavailable") && line.includes("timed out")), turn.runtime.logs.join("\n"));
  }
});

test("a caller's abort during the cycle-source lookup is rethrown and remembers nothing", async () => {
  // OP-12 P6 review R13.
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {roomId: "room-1"};
  runtime.logger = {warn: () => {}, info: () => {}};
  const controller = new AbortController();
  runtime.client = {readEvents: async () => {
    controller.abort();
    throw Object.assign(new Error("aborted"), {name: "AbortError"});
  }};
  await assert.rejects(runtime.cycleDocumentSource({cycle: {id: "cycle-1", sourceEventId: "m-src"}}, [], {seq: 150}, 41, controller.signal),
    {name: "AbortError"});
  assert.equal(runtime.cycleSourceEvents.size, 0);
});

test("a remembered cycle source counts only for the same epoch start", async () => {
  // OP-12 P6 review R14: the floor value alone (the remembered event itself
  // lies above the current floor).
  const withSource = [START, SOURCE, ...GAP, ...Array.from({length: 30}, (_, index) => contribution(200 + index))];
  const first = await turnFor([...withSource, readyFor(230, "m-229")]);
  const [key] = first.runtime.cycleSourceEvents.keys();
  first.runtime.cycleSourceEvents.set(key, {floor: 30, event: {...SOURCE, payload: {...SOURCE.payload, attachments: [manifest("old")]}}});
  const later = await turnFor([...withSource, readyFor(231, "m-229")], {runtime: first.runtime});
  assert.ok(later.runtime.reads.some((afterSeq) => afterSeq > 40 && afterSeq < 180), "scanned again");
  assert.equal(count(later.turn.text, OLD_TEXT), 0);
  assert.equal(count(later.turn.text, BRIEF_TEXT), 1);
});

test("the open-exchange preamble does not count against the guidance bound", async () => {
  // OP-12 P6 review R21.
  const preamble = await readFile(new URL("./fixtures/open-exchange-preamble/v1.txt", import.meta.url), "utf8");
  const long = "g".repeat(2_990);
  const {preamble: found, lines} = savedGuidance([{enforcement: "guidance", text: preamble}, {enforcement: "guidance", text: long}]);
  assert.ok(found.length > 100);
  assert.deepEqual(lines, [`- ${long}`]);
  const context = canonicalRoomContext({rules: [{enforcement: "guidance", text: preamble}, {enforcement: "guidance", text: long}]}, []);
  assert.ok(context.includes(`- ${long}\n`));
});

async function rotationRuntime(name, request, extra = {}) {
  const file = await stateFileFor(name, extra);
  if (request !== undefined) {
    await writeFile(rotationRequestPath(file), typeof request === "string" ? request : JSON.stringify(request), {mode: 0o600});
  }
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: file, baseUrl: "https://room.example/api"});
  runtime.state = JSON.parse(await readFile(file, "utf8"));
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line)};
  return {file, runtime};
}

const VALID_REQUEST = {version: 1, roomId: "room-1", membershipId: "zurie", clientInstanceId: "client-1", requestedAt: "2026-10-04T10:00:00.000Z"};

test("a rotation request for another Room, client or membership, a symlink or an oversize one is refused and left in place", async () => {
  // OP-12 P6 review R26, R27, R28, R31.
  const cases = [
    ["room", {...VALID_REQUEST, roomId: "room-2"}],
    ["client", {...VALID_REQUEST, clientInstanceId: "client-2"}],
    ["member", {...VALID_REQUEST, membershipId: "paula"}],
    // Valid JSON within the first 4096 bytes, then padding: only the size
    // bound refuses it (OP-12 P6 review R31).
    ["oversize", `${JSON.stringify(VALID_REQUEST)}${" ".repeat(5_000)}`],
  ];
  for (const [name, request] of cases) {
    const {file, runtime} = await rotationRuntime(`refused-${name}`, request);
    const before = await readFile(file);
    await runtime.consumeEpochSessionRotation();
    assert.deepEqual(await readFile(file), before, name);
    assert.ok((await stat(rotationRequestPath(file))).isFile(), name);
    assert.ok(runtime.logs.some((line) => line.includes("code rotation_request_invalid")), name);
  }
  // A symlink to a valid request is not followed.
  const {file, runtime} = await rotationRuntime("refused-symlink");
  const target = join(home, "rotation-target.request");
  await writeFile(target, JSON.stringify(VALID_REQUEST), {mode: 0o600});
  await symlink(target, rotationRequestPath(file));
  const before = await readFile(file);
  await runtime.consumeEpochSessionRotation();
  assert.deepEqual(await readFile(file), before);
  assert.ok(runtime.logs.some((line) => line.includes("code rotation_request_invalid")));
});

test("a rotation whose state write fails changes nothing in memory and keeps the request", async () => {
  // OP-12 P6 review R24.
  const {file, runtime} = await rotationRuntime("persist-fails", VALID_REQUEST);
  const before = structuredClone(runtime.state);
  runtime.persistState = async () => { throw Object.assign(new Error("disk full"), {code: "ENOSPC"}); };
  await runtime.consumeEpochSessionRotation();
  assert.deepEqual(runtime.state, before);
  assert.ok((await stat(rotationRequestPath(file))).isFile());
  assert.ok(runtime.logs.some((line) => line.includes("code rotation_request_failed")));
});

test("the connector consumes a rotation request when it starts", async () => {
  // OP-12 P6 review R25: through initializeOnce, not by calling the consumer.
  const {file} = await rotationRuntime("at-start", VALID_REQUEST, {stateRevision: 2});
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: file, baseUrl: "https://room.example/api"});
  runtime.logger = {info: () => {}, warn: () => {}, error: () => {}};
  runtime.renewAccess = async () => false;
  runtime.registerConnector = async () => { runtime.connectorSession = {sessionId: "s"}; };
  runtime.repairPendingLifecycles = async () => {};
  runtime.publishPresence = async () => {};
  runtime.runHeartbeat = () => {};
  runtime.reportStatus = () => {};
  await runtime.initializeOnce(undefined);
  await assert.rejects(stat(rotationRequestPath(file)), {code: "ENOENT"});
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual([stored.epochSessionRoutingInitialized, stored.legacySessionEpochId, stored.rotateCurrentEpochSession], [false, "", true]);
  runtime.closed = true;
});

test("the rotation request is no account, is written atomically and can be cancelled", async () => {
  // OP-12 P6 review finding 1.
  const previous = process.env.OPENCLAW_STATE_DIR;
  const stateDir = join(home, "openclaw-state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    const accounts = join(stateDir, "synthetic-sociality-room", "accounts");
    await mkdir(accounts, {recursive: true, mode: 0o700});
    const file = join(accounts, "zurie.json");
    await writeFile(file, `${JSON.stringify({version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie",
      credential: "fixture-credential", clientInstanceId: "client-1", cursor: 7})}\n`, {mode: 0o600});
    await chmod(file, 0o600);
    const before = resolvedRoomAccounts({});
    assert.ok(before.some((account) => account?.stateFile === file), JSON.stringify(before));
    const lines = [];
    await runRecoveryCli(["rotate-current-epoch-session", "--account", "zurie", "--yes"], {write: (line) => lines.push(line)});
    assert.ok(rotationRequestPath(file).endsWith(".rotate-epoch-session.request"));
    assert.equal(rotationRequestPath(file).endsWith(".json"), false);
    assert.deepEqual(resolvedRoomAccounts({}), before, "the request is not taken for an account");
    assert.deepEqual((await readdir(accounts)).sort(), ["zurie.json", "zurie.json.rotate-epoch-session.request"], "no temporary file is left");
    assert.equal((await stat(rotationRequestPath(file))).mode & 0o777, 0o600);
    lines.length = 0;
    await runRecoveryCli(["rotate-current-epoch-session", "--account", "zurie", "--cancel"], {write: (line) => lines.push(line)});
    await assert.rejects(stat(rotationRequestPath(file)), {code: "ENOENT"});
    assert.match(lines.join("\n"), /removed/);
    lines.length = 0;
    await runRecoveryCli(["rotate-current-epoch-session", "--account", "zurie", "--cancel"], {write: (line) => lines.push(line)});
    assert.match(lines.join("\n"), /nothing changed/);
    await assert.rejects(runRecoveryCli(["rotate-current-epoch-session", "--account", "zurie", "--yes", "--cancel"], {write: () => {}}),
      /exclude each other/);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
});

test("P6-09 the Room state's activeTopic is authoritative and a cleared brief is gone on the next turn", async () => {
  const brief = "Brief: the owner's framing of the debate.";
  const start = {...START, payload: {epoch: {...START.payload.epoch, topic: {title: "Old title", description: brief}}}};
  const events = [start, SOURCE, contribution(43)];
  let {turn} = await turnFor([...events, openNote(60)], {claim: null, topic: {title: "Disclosure", description: brief}});
  assert.ok(turn.text.includes(`Current discussion: Disclosure\n${brief}`));
  for (const description of ["", null, undefined]) {
    for (const [label, event, claim] of [["open note", openNote(60), null], ["presented start", readyFor(60, "start-z"), claimed("start-z")]]) {
      ({turn} = await turnFor([...events, event], {claim, topic: {title: "Disclosure", description}}));
      assert.equal(count(turn.text, brief), 0, `${label} ${description}`);
      assert.equal(count(turn.text, "Old title"), 0, `${label} ${description}`);
      assert.ok(turn.text.includes("Current discussion: Disclosure"), `${label} ${description}`);
    }
  }
  // A cleared title too: no "Current discussion" line and nothing from the start.
  ({turn} = await turnFor([...events, readyFor(60, "start-z")], {claim: claimed("start-z"), topic: {title: "", description: ""}}));
  for (const gone of ["Current discussion", "Old title", brief]) assert.equal(count(turn.text, gone), 0, gone);
  // No activeTopic at all: the start event's topic is used.
  ({turn} = await turnFor([...events, readyFor(60, "start-z")], {claim: claimed("start-z"), topic: null}));
  assert.equal(count(turn.text, brief) > 0, true);
  assert.equal(count(turn.text, "Old title") > 0, true);
});

test("P6-10 a topic.changed event is acknowledged without model work", async () => {
  const changed = {id: "topic-60", seq: 60, type: "topic.changed", actorRole: "human_owner", actorId: "owner-tj",
    payload: {change: "description", epochId: "epoch-z"}};
  for (const claim of [null, claimed()]) {
    const acks = [];
    const next = claim ? readyFor(61, "m-src") : openNote(61);
    const {turn} = await turnFor([START, SOURCE, changed, next], {claim, acks, state: {cursor: 59}});
    assert.equal(turn.id, next.id, "the topic change itself is no turn");
    assert.ok(acks.includes(60), JSON.stringify(acks));
  }
});
