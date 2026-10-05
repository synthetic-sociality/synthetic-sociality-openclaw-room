// Parity P7c "Moderated debate and own voice": contract section P7c and the
// P2c-3a / P2c-4 additions (conformance parityP7cCases; Hermes implements the
// same names). Room server hold-signal-47320f7 (deployed 2026-10-05):
// moderated interruption (ADR 0008 addendum 2026-10-04), moderator steering,
// the hold signal and the ISSUE-023 follow-ups. No test uses a real
// credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {createHash} from "node:crypto";
import {link, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p7c-"));
process.env.HOME = home;
after(() => rm(home, {recursive: true, force: true}));
const runtimeModule = await import("../src/runtime.js");
const {
  OpenClawRoomRuntime, ROOM_NO_SYSTEM_STATUS_INSTRUCTION, WORD_BOUND_CYCLE_SOURCE, WORD_BOUND_POLICY_SOURCE, activeTopic,
  canonicalRoomContext, guidanceCarriesNoStatusSentence, positiveWordLimit, roomTurnFacts, wordBoundFact,
} = runtimeModule;
const {RoomAPIError, RoomClient, RoomTransportError} = await import("../src/room-client.js");
const {GATE_WAIT_REASONS, LocalStatus} = await import("../src/local-status.js");
const {readRoomHistory, resetHistoryScanCache} = await import("../src/history.js");
const channelModule = await import("../src/channel.js");
const {writeRotationRequest, rotationRequestPath} = await import("../src/epoch-rotation.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const SENTENCE = conformance.parityP7cNoStatusSentence;
// The Room server's instruction for a response turn, verbatim (hold-signal-47320f7
// server/application/cycles/moderation.go:27-30).
const RESPONSE_INSTRUCTION = "The moderator has intervened; the message this turn answers is the moderator's. Respond to it first: "
  + "acknowledge it briefly, then answer it. If the moderator's point is unclear to you, ask one short clarifying "
  + "question instead of guessing. The discussion then continues in the direction the moderator set.";
const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
  {membershipId: "paula", displayName: "Paula", role: "participant_agent", status: "active"},
];
const START = {id: "start-z", seq: 41, type: "discussion.started", actorRole: "human_owner", actorId: "owner-tj",
  payload: {epoch: {id: "epoch-z", startsAtSeq: 41, topic: {title: "Debate"}}}};
const HUMAN = {id: "m-42", seq: 42, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Should the doctor disclose the diagnosis?", epochId: "epoch-z"}};
const PEER = {id: "m-43", seq: 43, type: "message.posted", actorRole: "participant_agent", actorId: "paula",
  payload: {body: "Disclosure first, then support.", epochId: "epoch-z"}};
const OWN = {id: "m-44", seq: 44, type: "message.posted", actorRole: "participant_agent", actorId: "zurie",
  payload: {body: "My own earlier point.", epochId: "epoch-z", respondsTo: ["m-43"]}};
const ASK = {id: "cmd-45", seq: 45, type: "human.command", actorRole: "human_owner", actorId: "owner-tj",
  payload: {epochId: "epoch-z", command: {command: "ask", arguments: {instruction: "Your view?"}}, visibleText: "/ask"}};
const INTERJECTION = {id: "m-50", seq: 50, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Please also consider the family's view.", epochId: "epoch-z"}};
const ADDRESSED = {...INTERJECTION, payload: {...INTERJECTION.payload, resolvedRecipientMembershipIds: ["zurie"]}};
const ready = (seq, sourceEventId, extra = {}) => ({id: `ready-${seq}`, seq, type: "discussion.cycle_attempt_ready", actorRole: "system",
  actorId: "room_coordinator", payload: {cycleId: "cycle-1", epochId: "epoch-z", generation: 1, membershipId: "zurie", round: 2, sourceEventId, ...extra}});
const responseReady = (seq, sourceEventId = "m-50") => ready(seq, sourceEventId, {phase: "response", phaseInstruction: RESPONSE_INSTRUCTION});
const claimed = (sourceEventId = "m-42", extra = {}) => ({attempt: {id: "attempt-1", round: 2, membershipId: "zurie", leaseExpiresAt: "2099-01-01T00:00:00Z"},
  cycle: {id: "cycle-1", generation: 1, totalTurns: 2, sourceEventId, budgets: {totalTurns: 6, perAgentTurns: 3}, ...extra}});
const count = (text, part) => text.split(part).length - 1;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runtimeFor(events, options = {}) {
  const {claim = claimed(), rules = [], policy = {}, state = {}, client = {}} = options;
  // An explicit undefined start is a missing start, not the default.
  const startsAt = Object.hasOwn(options, "startsAt") ? options.startsAt : 41;
  const pageStartsAt = Object.hasOwn(options, "pageStartsAt") ? options.pageStartsAt : startsAt;
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: events[0].seq - 1, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.calls = {claims: 0, starts: [], acks: [], stateReads: 0};
  runtime.client = {
    readEvents: async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: pageStartsAt,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => { runtime.calls.stateReads += 1; return {headSeq: events.at(-1).seq, activeEpoch: {id: "epoch-z", startsAtSeq: startsAt},
      activeTopic: {title: "Debate"}, roster: ROSTER, rules, activeHold: null, ...state}; },
    roomPolicy: async () => ({policy: {coordinationMode: "coordinated", ...policy}}),
    listArtifacts: async () => ({items: []}),
    getArtifact: async () => ({}),
    startDiscussionCycle: async (_state, request) => { runtime.calls.starts.push(request); return {id: "cycle-active", sourceEventId: "m-42"}; },
    claimDiscussionAttempt: async () => {
      runtime.calls.claims += 1;
      const answer = typeof claim === "function" ? claim(runtime.calls.claims) : structuredClone(claim);
      if (!answer) throw new RoomAPIError(409, {code: "cycle_no_attempt", retryable: true});
      return answer;
    },
    acknowledge: async (_state, seq) => { runtime.calls.acks.push(seq); return {acknowledgedSeq: seq}; },
    acknowledgePeerContribution: async () => ({}),
    ...client,
  };
  runtime.persistState = async () => {};
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  // Terminal evidence is pruned once acknowledged; keep what was recorded.
  runtime.evidence = {};
  const record = runtime.recordTerminalEvidence.bind(runtime);
  runtime.recordTerminalEvidence = async (event, status, fields = {}) => {
    runtime.evidence[event.seq] = {status, reason: fields.reason ?? ""};
    return record(event, status, fields);
  };
  return runtime;
}

// Every turn the scan yields for `events`, until it has read past the last one.
async function scan(runtime, events) {
  const last = events.at(-1).seq;
  let drained;
  const isDrained = new Promise((resolve) => { drained = resolve; });
  const read = runtime.client.readEvents;
  runtime.client.readEvents = async (state, afterSeq, options) => {
    if (afterSeq >= last) {
      drained("drained");
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal.reason), {once: true}));
    }
    return read(state, afterSeq, options);
  };
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const yielded = [];
  for (;;) {
    const next = await Promise.race([turns.next(), isDrained, pause(10_000).then(() => "timeout")]);
    if (next === "drained" || next === "timeout" || next.done || yielded.length > 20) break;
    yielded.push(next.value);
    // The host run is over: the channel records the outcome and acknowledges.
    await runtime.recordSkipped(next.value.id);
    await runtime.ack(next.value.id);
  }
  controller.abort();
  await turns.return().catch(() => {});
  return yielded;
}

async function turnText(events, options = {}) {
  const runtime = runtimeFor(events, options);
  const turns = await scan(runtime, events);
  assert.equal(turns.length, 1, "one turn");
  return {turn: turns[0], runtime};
}

function postRuntime(post = async () => ({id: "posted-6", seq: 6, ts: "2026-10-05T10:00:00Z"})) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", cursor: 4, messagePayloadDialect: "v2", deliveryIntents: {}, terminalEvidence: {}};
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.persistState = async () => {};
  runtime.logger = {info: () => {}, warn: () => {}, error: () => {}};
  runtime.posts = [];
  runtime.completions = [];
  runtime.client = {
    roomState: async () => ({headSeq: 5, activeEpoch: {id: "epoch-z"}}),
    roomPolicy: async () => ({policy: {coordinationMode: "coordinated"}}),
    claimDiscussionAttempt: async () => cycleAttempt(),
    postMessage: async (_state, request) => { runtime.posts.push(structuredClone(request)); return post(request); },
    completeDiscussionAttempt: async (_state, _cycle, _attempt, request) => { runtime.completions.push(request.action); return {}; },
  };
  runtime.pendingEvent = {id: "ready-5", seq: 5};
  return runtime;
}
const cycleAttempt = () => ({cycle: {id: "cycle-1", generation: 1},
  attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()}});
const postFor = (runtime, text, replyToId = "m-42", attempt = cycleAttempt()) => runtime.postAndFinish({
  roomId: "room-1", text, replyToId, idempotencyKey: "ready-5:final", sourceEventId: "ready-5", cycleAttempt: attempt});

test("conformance P7c case names resolve to tests in this suite", async () => {
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  const cases = Object.entries(conformance.parityP7cCases ?? {});
  assert.equal(cases.length, 20);
  cases.forEach(([id, name], index) => {
    assert.equal(id, `P7c-${String(index + 1).padStart(2, "0")}`);
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.reduce((total, source) => total + count(source, `test(${JSON.stringify(name)},`), 0), 1, name);
  });
  assert.equal(conformance.parityP7cContract, "docs/delivery-lifecycle-contract-v1.md#p7c--moderated-debate-and-own-voice-2026-10-05");
});

test("the shared P7c texts are the connector constants", () => {
  assert.equal(ROOM_NO_SYSTEM_STATUS_INSTRUCTION, SENTENCE);
  const bound = conformance.parityP7cWordBound;
  assert.deepEqual([WORD_BOUND_CYCLE_SOURCE, WORD_BOUND_POLICY_SOURCE], [bound.cycle, bound.policy]);
  assert.equal(wordBoundFact(90, bound.policy), bound.format.replace("{N}", "90").replace("{source}", bound.policy));
  assert.ok(GATE_WAIT_REASONS.has("held_by_moderator"));
});

test("P7c-01 a reply in work when a human posts is posted, and a post the Room accepts with writtenBeforeEventId is an ordinary success", async () => {
  // The Room took the human message as an interjection: POST /cycles answers
  // the active cycle; nothing is claimed from it.
  const events = [START, HUMAN, PEER, INTERJECTION];
  const runtime = runtimeFor(events);
  runtime.state.cursor = 49;
  assert.deepEqual(await scan(runtime, events), []);
  assert.deepEqual(runtime.calls.starts.map((request) => request.sourceEventId), ["m-50"]);
  assert.equal(runtime.calls.claims, 0);
  assert.equal(runtime.evidence[50].reason, "coordination_handled_without_model");
  assert.deepEqual(runtime.calls.acks, [50]);
  // The reply in work is posted; the Room's receipt (writtenBeforeEventId on
  // the canonical event) is an ordinary success.
  const poster = postRuntime(async () => ({id: "posted-6", seq: 6, ts: "2026-10-05T10:00:00Z", payload: {writtenBeforeEventId: "m-50"}}));
  const result = await postFor(poster, "My point, written before the question.");
  assert.equal(result.superseded, undefined);
  assert.deepEqual(poster.posts.map((post) => post.body), ["My point, written before the question."]);
  assert.deepEqual(poster.completions, ["contribute"]);
  assert.equal(poster.state.keptReply, undefined);
});

test("P7c-02 a response turn shows the human message as the current item and the Room's instruction verbatim, whether the message addressed the agent or everyone", async () => {
  const texts = {};
  for (const [label, message] of [["for all", INTERJECTION], ["addressed", ADDRESSED]]) {
    const events = [START, HUMAN, PEER, message, responseReady(51)];
    texts[label] = (await turnText(events, {claim: claimed()})).turn.text;
  }
  for (const [label, text] of Object.entries(texts)) {
    assert.ok(text.includes("\n\n#50 TJE: Please also consider the family's view.\n\n"), label);
    assert.ok(text.includes(`[Room phase instruction — server-provided]\n${RESPONSE_INSTRUCTION}\n[/Room phase instruction — server-provided]`), label);
    assert.ok(text.includes("Discussion phase: response; round 2;"), label);
    assert.equal(count(text, "moderator"), count(RESPONSE_INSTRUCTION, "moderator"), label);
  }
  assert.equal(texts["for all"], texts.addressed);
});

test("P7c-03 after the response round a regular turn continues from the human message with the remaining budget", async () => {
  const events = [START, HUMAN, PEER, INTERJECTION, ready(53, "m-50")];
  const {turn} = await turnText(events, {claim: claimed("m-42", {totalTurns: 3})});
  assert.ok(turn.text.includes("\n\n#50 TJE: Please also consider the family's view."));
  assert.ok(turn.text.includes("Discussion phase: follow_up; round 2; turn 4 of 6; turns remaining after this one: 2"));
  assert.ok(!turn.text.includes("[Room phase instruction"));
});

test("P7c-04 a response turn announced while a model run is in progress is answered after that run", async () => {
  // OpenClaw reads no events while a model run holds the yield. The response
  // turn the Room announces during that run is read and answered after it.
  const events = [START, HUMAN, PEER, ready(46, "m-42")];
  const runtime = runtimeFor(events, {claim: claimed()});
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const first = await turns.next();
  assert.equal(first.value.raw.id, "ready-46");
  await runtime.recordSkipped(first.value.id);
  await runtime.ack(first.value.id);
  // The run is in progress: the Room appends the human message and the response turn.
  events.push(INTERJECTION, responseReady(51));
  const reads = runtime.client.readEvents;
  let readsDuringRun = 0;
  runtime.client.readEvents = async (...args) => { readsDuringRun += 1; return reads(...args); };
  await pause(50);
  assert.equal(readsDuringRun, 0, "no read while the run holds the yield");
  const second = await Promise.race([turns.next(), pause(10_000).then(() => ({value: null}))]);
  controller.abort();
  await turns.return().catch(() => {});
  assert.equal(second.value?.raw.id, "ready-51");
  assert.equal(runtime.calls.claims, 2);
  assert.equal(second.value.respondsToId, "m-50");
});

test("P7c-05 with moderator steering off the refused reply is kept and the human message seeds the next cycle", async () => {
  const poster = postRuntime(async () => { throw new RoomAPIError(409, {code: "cycle_superseded", retryable: false}); });
  assert.deepEqual(await postFor(poster, "Written before the moderator spoke."), {superseded: true, reason: "cycle_superseded"});
  assert.equal(poster.state.keptReply.text, "Written before the moderator spoke.");
  assert.equal(poster.state.keptReply.reason, "cycle_superseded");
  // The human message is offered to POST /cycles and seeds the next cycle.
  const events = [START, HUMAN, PEER, INTERJECTION];
  const runtime = runtimeFor(events, {policy: {moderatorSteering: false}});
  runtime.state.cursor = 49;
  await scan(runtime, events);
  assert.deepEqual(runtime.calls.starts.map((request) => request.sourceEventId), ["m-50"]);
});

test("P7c-06 a turn whose source is a human command posts without respondsTo, a turn whose source is a message names it", async () => {
  const command = await turnText([START, HUMAN, PEER, ASK, ready(52, "cmd-45")], {claim: claimed("cmd-45")});
  assert.equal(command.turn.respondsToId, "");
  const message = await turnText([START, HUMAN, PEER, ASK, ready(52, "m-43")], {claim: claimed("cmd-45")});
  assert.equal(message.turn.respondsToId, "m-43");
  // The wire: no respondsTo without a reply target.
  const poster = postRuntime();
  await postFor(poster, "My answer.", command.turn.respondsToId);
  const named = postRuntime();
  await postFor(named, "My answer.", message.turn.respondsToId);
  assert.deepEqual([Object.hasOwn(poster.posts[0], "respondsTo"), named.posts[0].respondsTo], [false, ["m-43"]]);
});

test("P7c-07 the shared transcript vector renders byte-identically and marks the agent's own entries, also in the closing-summary turn and in the tools", async () => {
  const vector = conformance.parityP7cTranscriptVector;
  const rendered = canonicalRoomContext(vector.state, vector.events, vector.currentEventId, {}, 0, null, vector.membershipId);
  const transcript = rendered.split("Recent canonical transcript:\n")[1].split("\n[/Canonical Room context]")[0];
  assert.equal(transcript, vector.transcript);
  assert.ok(!canonicalRoomContext(vector.state, vector.events, vector.currentEventId).includes("(you)"));
  // A normal turn and the closing-summary turn of the Room carry the mark.
  const summary = ready(55, "term-54", {phase: "summary", phaseInstruction: "You are Zurie in this Room. Write the closing summary."});
  for (const [label, event] of [["turn", ready(55, "m-42")], ["closing summary", summary]]) {
    const {turn} = await turnText([START, HUMAN, PEER, OWN, event], {claim: claimed()});
    assert.ok(turn.text.includes("#44 Zurie (you) (reply to Paula): My own earlier point."), label);
    assert.ok(turn.text.includes("#43 Paula: Disclosure first, then support."), label);
  }
  // The history tool.
  resetHistoryScanCache();
  const events = [START, HUMAN, PEER, OWN];
  const client = {
    roomState: async () => ({headSeq: 44, activeEpoch: {id: "epoch-z", ordinal: 2, startsAtSeq: 41}, roster: ROSTER}),
    readEvents: async (_session, afterSeq) => ({events: events.filter((item) => item.seq > afterSeq), headSeq: 44}),
    listEpochs: async () => ({epochs: [{id: "epoch-z", ordinal: 2, startsAtSeq: 41, status: "active"}]}),
  };
  const history = await readRoomHistory({client, session: {roomId: "room-1", membershipId: "zurie", baseUrl: "https://room.example/api"}});
  assert.deepEqual(Object.fromEntries(history.messages.map((entry) => [entry.seq, entry.actor])), {42: "TJE", 43: "Paula", 44: "Zurie (you)"});
});

test("P7c-08 the word bound reads At most N words per response with its source and there is no line without a bound", async () => {
  assert.ok(roomTurnFacts({policyWordLimit: 120}).includes(
    "\nAt most 120 words per response (Room policy maxContributionWords); there is no minimum.\n"));
  const {turn} = await turnText([START, HUMAN, PEER, ready(46, "m-42")],
    {claim: claimed("m-42", {budgets: {totalTurns: 6, perAgentTurns: 3, maxContributionWords: 80}})});
  assert.ok(turn.text.includes("At most 80 words per response (Room policy maxContributionWords, as frozen for this discussion cycle); there is no minimum."));
  for (const value of [0, null, -5, 12.5, "100", true, undefined]) {
    assert.equal(positiveWordLimit(value), 0, String(value));
    assert.ok(!roomTurnFacts({policyWordLimit: value}).includes("words per response"), String(value));
  }
  assert.equal(positiveWordLimit(100.0), 100);
  assert.ok(!turn.text.includes("Word limit"));
});

test("P7c-09 the ISSUE-031 sentence is in the frame exactly once, also when the Room guidance carries it, and a reply about missing access is posted unchanged", async () => {
  const frames = {
    "without guidance": await turnText([START, HUMAN, PEER, ready(46, "m-42")]),
    "guidance carries it": await turnText([START, HUMAN, PEER, ready(46, "m-42")], {rules: [
      {enforcement: "guidance", text: "Speak plainly."}, {enforcement: "guidance", text: SENTENCE}]}),
    "guidance carries it among other text": await turnText([START, HUMAN, PEER, ready(46, "m-42")], {rules: [
      {enforcement: "guidance", text: `Be brief.\n\n${SENTENCE}\n\nUse plain words.`}]}),
  };
  for (const [label, {turn}] of Object.entries(frames)) assert.equal(count(turn.text, SENTENCE), 1, label);
  // Not a filter: a reply about missing access is posted unchanged, and the
  // status file holds no message body.
  const body = "I have no internet access, so I answer from the brief.";
  const directory = await mkdtemp(join(home, "status-"));
  const status = new LocalStatus(join(directory, "status.json"), {version: "test", hostLabel: "host"});
  const poster = postRuntime();
  poster.status = status;
  poster.reportStatus({connected: true});
  await postFor(poster, body);
  assert.deepEqual(poster.posts.map((post) => post.body), [body]);
  await pause(20);
  const text = await readFile(join(directory, "status.json"), "utf8");
  assert.ok(!text.includes("internet"));
  assert.ok(text.includes("webRead"));
});

test("P7c-10 a claim refused during a hold is dropped with held_by_moderator, a repeated announcement is answered once, and a claimed turn renews through the hold", async () => {
  const hold = {cycleId: "cycle-1", holderMembershipId: "owner-tj", holderDisplayName: "Thorsten", startedAt: "2026-10-05T10:00:00Z",
    expiresAt: "2026-10-05T10:00:45Z", latestExpiresAt: "2026-10-05T10:03:00Z"};
  const directory = await mkdtemp(join(home, "hold-"));
  const path = join(directory, "status.json");
  const first = responseReady(51);
  // Refused, refused again (a second hold before the re-announced claim), then claimed: answered once.
  const events = [START, HUMAN, PEER, INTERJECTION, first, {...first, id: "ready-51-hold-1", seq: 52}, {...first, id: "ready-51-hold-2", seq: 53}];
  const answers = {1: null, 2: null, 3: claimed()};
  const runtime = runtimeFor(events, {claim: (n) => structuredClone(answers[n] ?? null), state: {activeHold: hold}});
  runtime.state.cursor = 50;
  runtime.status = new LocalStatus(path, {version: "test", hostLabel: "host"});
  const read = runtime.client.readEvents;
  // First the two refused announcements only (the page ends at seq 52).
  runtime.client.readEvents = async (...args) => {
    const page = await read(...args);
    return {...page, events: page.events.filter((item) => item.seq <= 52)};
  };
  const refused = await scan(runtime, events.slice(0, 6));
  assert.deepEqual(refused, []);
  await pause(20);
  const entry = JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  assert.deepEqual([entry.lastGateWaitReason, entry.lastGateWaitSeconds], ["held_by_moderator", 0]);
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes("Thorsten") && !text.includes("family"));
  runtime.client.readEvents = read;
  const turns = await scan(runtime, events);
  assert.deepEqual(turns.map((turn) => turn.raw.id), ["ready-51-hold-2"]);
  assert.equal(runtime.calls.claims, 3, "one claim per announcement, no retry loop");
  assert.deepEqual(runtime.calls.acks, [51, 52, 53]);
  // The later claim of that Room succeeded: the reason is cleared (P2c-4).
  await pause(20);
  const cleared = JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  assert.deepEqual([cleared.lastGateWaitReason, cleared.lastGateWaitSeconds], ["", 0]);
  // Only cycle_no_attempt is a hold refusal: cycle_superseded during a hold records no reason.
  const supersededPath = join(directory, "superseded.json");
  const superseded = runtimeFor([START, HUMAN, PEER, INTERJECTION, first], {state: {activeHold: hold},
    claim: () => { throw new RoomAPIError(409, {code: "cycle_superseded"}); }});
  superseded.state.cursor = 50;
  superseded.status = new LocalStatus(supersededPath, {version: "test", hostLabel: "host"});
  assert.deepEqual(await scan(superseded, [START, HUMAN, PEER, INTERJECTION, first]), []);
  assert.equal(superseded.calls.claims, 1);
  await pause(20);
  const rooms = await readFile(supersededPath, "utf8").then((raw) => JSON.parse(raw).rooms ?? {}, () => ({}));
  assert.equal(rooms["room-1"]?.lastGateWaitReason ?? "", "");
  // A turn already claimed keeps renewing through a hold (the Room renews it as before).
  const renewing = postRuntime();
  let renewals = 0;
  renewing.client.claimDiscussionAttempt = async () => { renewals += 1; return cycleAttempt(); };
  const attempt = cycleAttempt();
  attempt.attempt.leaseExpiresAt = new Date(Date.now() + 3_000).toISOString();
  renewing.startAttemptLease({id: "ready-5", seq: 5}, attempt);
  await pause(1_300);
  await postFor(renewing, "Answer after the hold.", "m-42", attempt);
  assert.ok(renewals >= 2, String(renewals));
  assert.equal(renewing.posts.length, 1);
});

test("P7c-11 a claim refused after the agent timed out is dropped without retry and without a hold reason, and no time line is rendered", async () => {
  const directory = await mkdtemp(join(home, "timeout-"));
  const path = join(directory, "status.json");
  const events = [START, HUMAN, PEER, ready(51, "m-43")];
  const runtime = runtimeFor(events, {claim: null});
  runtime.state.cursor = 50;
  runtime.status = new LocalStatus(path, {version: "test", hostLabel: "host"});
  runtime.reportStatus({connected: true});
  assert.deepEqual(await scan(runtime, events), []);
  assert.equal(runtime.calls.claims, 1);
  assert.deepEqual(runtime.calls.acks, [51]);
  await pause(20);
  assert.equal(JSON.parse(await readFile(path, "utf8")).rooms["room-1"].lastGateWaitReason, "");
  // No time line: the Room does not send the turn's end (P7c-6).
  const {turn} = await turnText([START, HUMAN, PEER, ready(46, "m-42")],
    {claim: claimed("m-42", {budgets: {totalTurns: 6, perAgentTurns: 3, maxDuration: 1_800_000_000_000}})});
  for (const words of ["seconds after", "turn timeout", "Room turn time", "1800"]) assert.ok(!turn.text.includes(words), words);
});

test("P7c-12 an unknown discussion start brings no earlier entry into the Room-context tool or a turn", async () => {
  const earlier = {id: "m-30", seq: 30, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
    payload: {body: "Earlier discussion: the rejected plan.", epochId: "epoch-y"}};
  for (const startsAt of [undefined, null, 0, -1, "41", [41], {n: 41}, 41.5, true]) {
    const {turn} = await turnText([earlier, START, HUMAN, PEER, ready(46, "m-42")], {startsAt, pageStartsAt: 41});
    assert.ok(!turn.text.includes("rejected plan"), String(startsAt));
    assert.ok(!turn.text.includes("#43 Paula"), String(startsAt));
  }
});

test("P7c-13 a prior-epoch lifecycle terminal on a page whose start is unknown is ignored and acknowledged, and the channel keeps running", async () => {
  const terminal = {id: "term-42", seq: 42, type: "discussion.cycle_terminal", actorRole: "system", actorId: "room_coordinator",
    payload: {cycleId: "cycle-0", state: "interrupted", reason: "epoch_superseded", epochId: "epoch-y"}};
  for (const pageStartsAt of [undefined, 0, "41", null]) {
    const events = [START, terminal, PEER, ready(46, "m-43")];
    const runtime = runtimeFor(events, {pageStartsAt, client: {listEpochs: async () => { throw new Error("no catalog read"); }}});
    runtime.state.cursor = 41;
    const turns = await scan(runtime, events);
    assert.deepEqual(turns.map((turn) => turn.raw.id), ["ready-46"], String(pageStartsAt));
    assert.deepEqual(runtime.evidence[42], {status: "ignored", reason: "prior_epoch_lifecycle"});
    assert.ok(runtime.calls.acks.includes(42));
  }
});

test("P7c-14 with the Room state's start known and the page's start missing, 0 or lower, a message of an earlier discussion is never handed to the model", async () => {
  const old = {id: "m-20", seq: 20, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
    payload: {body: "A message of the earlier discussion.", resolvedRecipientMembershipIds: ["zurie"]}};
  for (const pageStartsAt of [undefined, 0, 12]) {
    const events = [old, START, HUMAN];
    const runtime = runtimeFor(events, {pageStartsAt, policy: {coordinationMode: "open"}});
    runtime.state.cursor = 19;
    const turns = await scan(runtime, events);
    assert.ok(!turns.some((turn) => turn.raw.id === "m-20"), String(pageStartsAt));
    assert.ok(!Object.hasOwn(runtime.evidence, 20) || runtime.evidence[20].status === "superseded", String(pageStartsAt));
    assert.ok(runtime.calls.starts.every((request) => request.sourceEventId !== "m-20"));
    assert.ok(runtime.calls.acks.includes(20));
  }
});

test("P7c-15 a lost session after six failed heartbeats is registered again within 1 s", async () => {
  // OpenClaw registers in the same pass that reads the Room's lost-session
  // answer: no wait between them, whatever failed before.
  const runtime = runtimeFor([HUMAN]);
  delete runtime.maintainPresence;
  runtime.publishPresence = async () => {};
  runtime.acceptConnectorEnrollments = async () => [];
  runtime.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.01};
  runtime.heartbeatMinimumSeconds = 0.01;
  const log = [];
  let beats = 0;
  runtime.client.heartbeat = async () => {
    beats += 1;
    log.push("heartbeat failed");
    if (beats <= 6) throw new RoomAPIError(502, {code: "", retryable: true});
    throw new RoomAPIError(404, {code: "not_found"});
  };
  runtime.registerConnector = async () => { log.push("register"); runtime.connectorSession = {sessionId: "s2", heartbeatIntervalSeconds: 60}; };
  const waits = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 5) { waits.push({ms: milliseconds, at: log.length}); return realSetTimeout(callback, 1, ...args); }
    return realSetTimeout(callback, milliseconds, ...args);
  };
  try {
    runtime.runHeartbeat();
    const deadline = Date.now() + 5_000;
    while (!log.includes("register") && Date.now() < deadline) await pause(5);
  } finally {
    await runtime.close();
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(log.slice(0, 8), [...Array(7).fill("heartbeat failed"), "register"]);
  assert.ok(!waits.some((wait) => wait.at === 7), "no wait between the lost-session answer and the registration");
  assert.ok(waits.filter((wait) => wait.at === 6).some((wait) => wait.ms >= 8_000), "the outage had grown the schedule");
});

test("P7c-16 a revocation seen by the heartbeat ends the open event stream at once and the status stays stopped with credential_revoked when the stream then fails", async () => {
  const outcomes = {};
  for (const code of ["credential_revoked", "credential_expired"]) {
    const runtime = runtimeFor([HUMAN]);
    runtime.state.cursor = 42;
    delete runtime.maintainPresence;
    runtime.publishPresence = async () => {};
    runtime.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.01};
    runtime.heartbeatMinimumSeconds = 0.01;
    let reads = 0;
    Object.assign(runtime.client, {
      // The long poll stays open; once aborted it ends with the runtime's
      // network error, which the real client passes on unchanged while its
      // own signal is aborted (room-client.js transportFailure).
      readEvents: (_state, _after, {signal} = {}) => {
        reads += 1;
        const failure = () => Object.assign(new TypeError("fetch failed"), {cause: {code: "ECONNRESET"}});
        if (signal?.aborted) return Promise.reject(failure());
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(failure()), {once: true}));
      },
      heartbeat: async () => { throw new RoomAPIError(401, {code, message: "refused"}); },
      connectorEnrollments: async () => [],
    });
    runtime.initialize = async () => { runtime.runHeartbeat(); return runtime.connectorSession; };
    const channel = channelModule.createRoomChannel({makeClient: (_account, {status}) => { runtime.status = status; return runtime; }});
    const controller = new AbortController();
    let hostStatus = {};
    const run = channel.plugin.gateway.startAccount({
      account: {accountId: "p7c-16", stateFile: runtime.account.stateFile}, accountId: "p7c-16",
      abortSignal: controller.signal, cfg: ISOLATED_HOST_CONFIG, channelRuntime: {},
      getStatus: () => hostStatus, setStatus: (next) => { hostStatus = next; },
      log: {info: () => {}, warn: () => {}, error: () => {}},
    }).then(() => null, (error) => error);
    const ended = await Promise.race([run, pause(5_000).then(() => "still running")]);
    if (ended === "still running") { controller.abort(); await run; }
    await pause(50);
    const entry = JSON.parse(await readFile(channelModule.roomStatusPath(ISOLATED_HOST_CONFIG), "utf8")).rooms["room-1"];
    outcomes[code] = [ended === "still running" ? ended : "ended", reads, entry.connection, entry.lastErrorCode];
  }
  assert.deepEqual(outcomes, {
    credential_revoked: ["ended", 1, "stopped", "credential_revoked"],
    credential_expired: ["ended", 1, "stopped", "credential_expired"],
  });
});

test("P7c-17 a request the runtime refuses to form is the connector's own error, never a failed contact, and no request leaves the host", async () => {
  // A credential with a line break: the runtime refuses the header before any
  // I/O; the plugin's fetch is never called and the error is not a transport failure.
  let fetches = 0;
  const client = new RoomClient({baseUrl: "https://room.example/api", credential: "credential\nX-Injected: 1",
    fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }});
  await assert.rejects(client.request("/rooms/room-1/state"), (error) => {
    assert.ok(!(error instanceof RoomTransportError), error?.name);
    assert.equal(error?.name, "TypeError");
    return true;
  });
  assert.equal(fetches, 0);
  // Never a failed contact: the scan's classifier does not retry it.
  const runtime = runtimeFor([HUMAN]);
  runtime.client.readEvents = async () => client.request("/rooms/room-1/events");
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  await assert.rejects(Promise.race([turns.next(), pause(5_000).then(() => { throw new Error("retried"); })]),
    (error) => error?.name === "TypeError");
  controller.abort();
  assert.equal(fetches, 0);
});

test("P7c-18 with the stored Showroom guidance of Harness b70aff3e as the Room rules the frame does not add the ISSUE-031 sentence again, with one character of it changed it does", async () => {
  // Source: Harness b70aff3e0ff1fe04a4be12e1d90c22a13aba2e57,
  // packages/client/ui-sociality-room/src/client/policy-mode-texts.ts (Showroom
  // principle, POLICY_MODE_COMMON_TEXT and style, joined by blank lines as
  // policy-modes.ts modeGuidanceText stores them).
  const stored = conformance.parityP7cShowroomGuidance;
  assert.ok(stored.source.includes("b70aff3e0ff1fe04a4be12e1d90c22a13aba2e57"));
  assert.equal(createHash("sha256").update(stored.text, "utf8").digest("hex"), stored.sha256);
  const frame = async (text) => (await turnText([START, HUMAN, PEER, ready(46, "m-42")],
    {rules: [{enforcement: "guidance", text}]})).turn.text;
  const showroom = await frame(stored.text);
  assert.equal(count(showroom, SENTENCE), 1);
  assert.ok(showroom.includes("- Debate for an audience"));
  // Paragraph breaks inside the sentence and white space around it are tolerated.
  // A tab inside a run that holds a line feed is part of that break.
  const broken = stored.text.replace(" If you cannot read", "\n\nIf you cannot read").replace(" You may say", "\r\n  You may say")
    .replace(" model or", "\t\n\tmodel or");
  assert.ok(guidanceCarriesNoStatusSentence([broken]));
  const brokenFrame = await frame(broken);
  assert.equal(count(brokenFrame, SENTENCE), 0, "the Room's own wording only, not added again");
  assert.ok(brokenFrame.includes("\n\nIf you cannot read"));
  // One character changed: the frame adds the sentence.
  for (const changed of [stored.text.replace("system status.", "system status!"), stored.text.replace("Say nothing", "say nothing"),
    stored.text.replace("tools, access", "tools,  access"),
    // A tab or a lone carriage return is not a paragraph break (no line feed).
    stored.text.replace("tools, access", "tools,\taccess"), stored.text.replace("tools, access", "tools,\raccess")]) {
    assert.ok(!guidanceCarriesNoStatusSentence([changed]));
    assert.equal(count(await frame(changed), SENTENCE), 1);
  }
});

test("P7c-19 a command-source turn whose attempt is renewed by a fresh claim answer before the post posts without respondsTo, a message-source turn names its source", async () => {
  // OpenClaw decides the fact when it builds the turn (respondsToId); a renewal
  // never touches the turn. The renewal here is answered by a fresh object.
  const results = {};
  for (const [label, source] of [["command", "cmd-45"], ["message", "m-43"]]) {
    const {turn} = await turnText([START, HUMAN, PEER, ASK, ready(52, source)], {claim: claimed("cmd-45")});
    const poster = postRuntime();
    let renewals = 0;
    poster.client.claimDiscussionAttempt = async () => { renewals += 1; return cycleAttempt(); };
    const attempt = cycleAttempt();
    const lease = poster.startAttemptLease({id: "ready-5", seq: 5}, attempt);
    assert.equal(await poster.renewAttemptLease(lease), true);
    assert.equal(renewals, 1);
    await postFor(poster, "My answer.", turn.respondsToId, attempt);
    await poster.stopAttemptLease("ready-5");
    results[label] = [Object.hasOwn(poster.posts[0], "respondsTo"), poster.posts[0].respondsTo ?? null];
  }
  assert.deepEqual(results, {command: [false, null], message: [true, ["m-43"]]});
});

test("P7c-20 a Room URL the runtime refuses to form is the connector's own error, never a failed contact, and no request leaves the host", async () => {
  // A port that is not a number: the URL parser refuses it before any I/O
  // (OpenClaw parses the Room URL when the client is made); the plugin's fetch
  // is never called and the error is not a transport failure.
  let fetches = 0;
  assert.throws(() => new RoomClient({baseUrl: "https://room.example:port/api", credential: "credential",
    fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }}), (error) => {
    assert.ok(!(error instanceof RoomTransportError), error?.name);
    assert.equal(error?.name, "TypeError");
    return true;
  });
  assert.equal(fetches, 0);
});

// P7c items 4 and 8: tests for mutations that survived the P6 round-2 and P7a
// round-3 reviews (REVIEW-20261004-parity-P6-r2.md finding 4,
// REVIEW-20261005-parity-P7a-r3-openclaw.md N4 s3).
test("the prompt start never falls back to the page start", async () => {
  const {turn} = await turnText([START, HUMAN, PEER, ready(46, "m-42")], {startsAt: undefined, pageStartsAt: 41});
  assert.ok(!turn.text.includes("#43 Paula"));
});

test("the turn-source memory is kept per source", async () => {
  const older = Array.from({length: 70}, (_, index) => ({id: `m-${42 + index}`, seq: 42 + index, type: "message.posted",
    actorRole: "human_owner", actorId: "owner-tj", payload: {body: `Message ${42 + index}.`, epochId: "epoch-z"}}));
  // Two turns of one connector: the first scans for m-43, the second for m-44.
  const events = [START, ...older, ready(120, "m-43"), ready(121, "m-44")];
  const runtime = runtimeFor(events);
  const turns = await scan(runtime, events);
  assert.deepEqual(turns.map((turn) => turn.raw.id), ["ready-120", "ready-121"]);
  assert.ok(turns[0].text.includes("#43 TJE: Message 43."));
  assert.ok(turns[1].text.includes("#44 TJE: Message 44."));
  assert.ok(!turns[1].text.split("[/Canonical Room context]")[1].includes("Message 43."));
});

test("the topic is trimmed as guidance is", () => {
  assert.deepEqual(activeTopic({activeTopic: {title: "\u0085﻿ Heat plan  ", description: "Brief \ud800 text　"}}),
    {title: "Heat plan", description: "Brief � text"});
});

test("the plugin's own response-size error is not a transport failure", async () => {
  const huge = "x".repeat(17 * 1024 * 1024);
  const client = new RoomClient({baseUrl: "https://room.example/api", credential: "c",
    fetchImpl: async () => new Response(huge, {status: 200, headers: {"content-type": "application/json"}})});
  await assert.rejects(client.request("/rooms/room-1/state"), (error) => {
    assert.ok(!(error instanceof RoomTransportError), error?.name);
    return true;
  });
});

test("the rotation request is written through a new file, never in place", async () => {
  const state = join(home, "rotation-state.json");
  await writeFile(state, "{}");
  const request = rotationRequestPath(state);
  const other = join(home, "linked-elsewhere.txt");
  await writeFile(other, "unchanged");
  await link(other, request);
  writeRotationRequest(state, {roomId: "room-1", membershipId: "zurie", clientInstanceId: "client-1"});
  assert.equal(await readFile(other, "utf8"), "unchanged");
  assert.notEqual(await readFile(request, "utf8"), "unchanged");
});
