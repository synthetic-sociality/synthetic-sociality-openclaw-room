// Parity P7c "Moderated debate and own voice": contract section P7c and the
// P2c-3a / P2c-4 additions (conformance parityP7cCases; Hermes implements the
// same names). Room server hold-signal-47320f7 (deployed 2026-10-05):
// moderated interruption (ADR 0008 addendum 2026-10-04), moderator steering,
// the hold signal and the ISSUE-023 follow-ups. No test uses a real
// credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {createHash} from "node:crypto";
import {link, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
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
  canonicalRoomContext, guidanceCarriesNoStatusSentence, normalizeEvent, positiveWordLimit, roomTurnFacts, statusErrorCode, wordBoundFact,
  transientRoomFailure, uncodedContactFailure,
} = runtimeModule;
const {RoomAPIError, RoomClient, RoomRequestError, RoomTransportError} = await import("../src/room-client.js");
const {GATE_WAIT_REASONS, LocalStatus} = await import("../src/local-status.js");
const {readRoomHistory, registerRoomHistoryTool, resetHistoryScanCache} = await import("../src/history.js");
const {defaultStateDirectory, saveState} = await import("../src/state.js");
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
const roundOne = (sourceEventId = "m-42") => {
  const answer = claimed(sourceEventId);
  answer.attempt.round = 1;
  answer.cycle.totalTurns = 0;
  return answer;
};
const count = (text, part) => text.split(part).length - 1;
// The one log line of a stop (runtime.failClosedOnRequestError).
const STOP_LINE = "Room request refused by the runtime before any I/O code=request_not_formed; the channel stops";
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// A bound against a hang only; no outcome depends on it (an unref'd timer).
const hangGuard = (milliseconds = 120_000) => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("hang")), milliseconds).unref());

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

// P7c-4: the turn of each kind the four frame shapes of P7c-09 do not build,
// with a marker that shows the kind was rendered.
async function turnKinds(rules) {
  const kind = async (events, options, prepare = () => {}) => {
    const runtime = runtimeFor(events, {rules, ...options});
    prepare(runtime);
    const turns = await scan(runtime, events);
    assert.equal(turns.length, 1, "one turn");
    return turns[0];
  };
  const commandTurn = async (name) => {
    const source = {...ASK, id: "cmd-46", seq: 46, payload: {...ASK.payload, command: {command: name, arguments: {instruction: "Your view?"}}}};
    const turn = await kind([START, HUMAN, PEER, source, ready(52, "cmd-46")], {claim: claimed("cmd-46")});
    assert.equal(turn.respondsToId, "", "decided as a command-source turn");
    return turn;
  };
  const summary = ready(55, "term-54", {phase: "summary", phaseInstruction: "Write the closing summary."});
  const kept = {sourceEventId: "m-42", sourceSeq: 42, epochId: "epoch-z", producedAt: "2026-10-05T09:52:30Z", reason: "turn_expired",
    text: "My kept earlier reply."};
  return {
    "response round": {turn: await kind([START, HUMAN, PEER, INTERJECTION, responseReady(51)], {claim: claimed("m-50")}),
      marker: `${RESPONSE_INSTRUCTION}`},
    "closing summary": {turn: await kind([START, HUMAN, PEER, summary], {claim: claimed()}), marker: "Write the closing summary."},
    // The command is not a message: no current item; the frame ends with the turn facts.
    "ask cycle": {turn: await commandTurn("ask"), marker: "[Room turn facts]\nDiscussion phase: follow_up; round 2;"},
    "summarize cycle": {turn: await commandTurn("summarize"), marker: "[Room turn facts]\nDiscussion phase: follow_up; round 2;"},
    "kept reply offered": {turn: await kind([START, HUMAN, PEER, ready(50, "m-43")], {claim: claimed("m-43")},
      (runtime) => { runtime.state.keptReply = structuredClone(kept); }), marker: "\nMy kept earlier reply.\n"},
    "missed source offered": {turn: await kind([START, HUMAN, PEER, ready(50, "m-43")], {claim: claimed("m-43")},
      (runtime) => { runtime.state.missedSources = [{sourceEventId: "m-42", sourceSeq: 42}]; }), marker: "Missed earlier: #42 TJE"},
    "discussion start as the current item": {turn: await kind([START, HUMAN, PEER, ready(50, "start-z")], {claim: claimed("start-z")}),
      marker: "\nDebate\n[/Discussion started by "},
    // The phases the plugin itself names besides follow_up and summary
    // (cyclePhaseInstruction): opening and initial_greeting, in round 1 (OP-12
    // P7c r3 B2, N2 a-round1); a word bound frozen in the cycle (N2 a-wordbound).
    "opening": {turn: await kind([START, HUMAN, PEER, ready(46, "m-42", {phase: "opening", round: 1})], {claim: roundOne()}),
      marker: "Discussion phase: opening; round 1;"},
    "initial greeting": {turn: await kind([START, HUMAN, PEER, ready(46, "m-42", {phase: "initial_greeting", round: 1})],
      {claim: roundOne()}), marker: "Discussion phase: initial_greeting; round 1;"},
    "word bound frozen in the cycle": {turn: await kind([START, HUMAN, PEER, ready(46, "m-42")],
      {claim: claimed("m-42", {budgets: {totalTurns: 6, perAgentTurns: 3, maxContributionWords: 120}})},
    ), marker: wordBoundFact(120, WORD_BOUND_CYCLE_SOURCE)},
  };
}

function postRuntime(post =async () => ({id: "posted-6", seq: 6, ts: "2026-10-05T10:00:00Z"})) {
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
  assert.equal(cases.length, 24);
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
  // Another member with the agent's display name is never marked (by actorId only).
  const namesake = {id: "m-45", seq: 45, type: "message.posted", actorRole: "participant_agent", actorId: "zurie-2",
    payload: {body: "Same name, another member.", epochId: "epoch-z"}};
  const events = [START, HUMAN, PEER, OWN, namesake];
  const client = {
    roomState: async () => ({headSeq: 45, activeEpoch: {id: "epoch-z", ordinal: 2, startsAtSeq: 41},
      roster: [...ROSTER, {membershipId: "zurie-2", displayName: "Zurie", role: "participant_agent", status: "active"}]}),
    readEvents: async (_session, afterSeq) => ({events: events.filter((item) => item.seq > afterSeq), headSeq: 45}),
    listEpochs: async () => ({epochs: [{id: "epoch-z", ordinal: 2, startsAtSeq: 41, status: "active"}]}),
  };
  // Through the registered tool and its own session resolver, over the saved
  // state the runtime uses (not a hand-made session).
  const accounts = defaultStateDirectory();
  await mkdir(accounts, {recursive: true, mode: 0o700});
  await saveState(join(accounts, "t.json"), {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie",
    credential: "fixture-credential", clientInstanceId: "client-1", cursor: 0});
  const tools = [];
  registerRoomHistoryTool({registerTool: (tool) => tools.push(tool)}, {makeClient: () => client});
  const history = JSON.parse((await tools[0].execute("call-1", {})).content[0].text);
  assert.equal(history.success, true, JSON.stringify(history));
  assert.deepEqual(Object.fromEntries(history.messages.map((entry) => [entry.seq, entry.actor])), {42: "TJE", 43: "Paula", 44: "Zurie (you)", 45: "Zurie"});
  await rm(join(accounts, "t.json"));
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
  // Every frame a model can get (cyclePrompt): a cycle turn, a direct human.command
  // turn, an open-Room message turn and a message turn with a claimed attempt.
  // The sentence once and byte-exact without the guidance; not added when the
  // guidance carries it. An open-Room message turn through the scan as well.
  const command = {id: "cmd-47", seq: 47, type: "human.command", actorRole: "human_owner", actorId: "owner-tj",
    payload: {command: {command: "ask", arguments: {instruction: "Your view?"}}, visibleText: "/ask"}};
  const keptBlock = "[Your own earlier reply]\nMy kept earlier reply.\n[/Your own earlier reply]";
  const shapes = {
    "cycle turn": [ready(46, "m-42"), claimed()],
    "direct human.command turn": [command, null],
    "open-Room message turn": [HUMAN, null],
    "message turn with a claimed attempt": [HUMAN, claimed()],
    // OP-12 P7c r3 N2: the message shape in round 1 (phase opening, a-s4-opening)
    // and an open-Room message turn that offers a kept reply (a-open-kept).
    "message turn with a claimed round-1 attempt": [HUMAN, roundOne(), "", "Discussion phase: opening; round 1;"],
    "open-Room message turn offering a kept reply": [HUMAN, null, keptBlock, keptBlock],
  };
  for (const [label, [event, attempt, kept = "", marker = ""]] of Object.entries(shapes)) {
    const frame = (carried) => normalizeEvent(event, "room-1", attempt, "", "epoch-z", "", 0, null, "", null, [], kept,
      {guidanceCarriesNoStatus: carried}).text;
    assert.ok(frame(false).includes(marker), `${label}: ${frame(false)}`);
    assert.equal(count(frame(false), SENTENCE), 1, label);
    assert.ok(frame(false).split("\n\n").includes(SENTENCE), `${label}: a paragraph of its own, byte-exact`);
    assert.equal(count(frame(true), SENTENCE), 0, `${label}: not added when the guidance carries it`);
  }
  const openEvents = [START, HUMAN];
  const openTurn = (await scan(runtimeFor(openEvents, {policy: {coordinationMode: "open"}}), openEvents))
    .find((turn) => turn.raw.id === HUMAN.id);
  assert.ok(openTurn, "the open-Room message is a turn");
  assert.equal(openTurn.cycleAttempt ?? null, null);
  assert.equal(count(openTurn.text, SENTENCE), 1, "open-Room message turn through the scan");
  // The turn kinds the shapes above do not build (OP-12 P7c r2 B1, N6), each
  // through the scan: what normalizeEvent and cyclePrompt vary the frame by is
  // the event type, the claimed attempt, the Room's phase and phaseInstruction,
  // the kind of the cycle source (message, command, discussion start,
  // unresolved) and the optional blocks (word bound, missed source, kept reply).
  for (const carried of [false, true]) {
    for (const [label, {turn, marker}] of Object.entries(await turnKinds(carried ? [{enforcement: "guidance", text: SENTENCE}] : []))) {
      assert.ok(turn.text.includes(marker), `${label}: ${turn.text}`);
      assert.equal(count(turn.text, SENTENCE), 1, `${label} (guidance carries it: ${carried})`);
      assert.equal(turn.text.split("\n\n").includes(SENTENCE), !carried, `${label}: a paragraph of its own unless the guidance carries it`);
    }
  }
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
    assert.ok(error instanceof RoomRequestError, error?.name);
    assert.equal(error.code, "request_not_formed");
    return true;
  });
  assert.equal(fetches, 0);
  // Never a failed contact: the scan's classifier does not retry it.
  const runtime = runtimeFor([HUMAN]);
  runtime.client.readEvents = async () => client.request("/rooms/room-1/events");
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  try {
    await assert.rejects(Promise.race([turns.next(), pause(5_000).then(() => { throw new Error("retried"); })]),
      (error) => error instanceof RoomRequestError);
  } finally {
    // A scan that retried ends here too, so the file goes on (OP-12 P7c r3 N1).
    controller.abort();
  }
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
    // The sentence without its final full stop (OP-12 P7c r2 N6, d5).
    stored.text.replace("is based on.", "is based on"),
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
  // Also (OP-12 P7c r2 N2, N3, as Hermes) a URL without a scheme or with a
  // broken IPv6 bracket and a scheme other than http or https: the plugin's own
  // error, whose text and fields never quote the URL (the parser's error keeps
  // it as input).
  let fetches = 0;
  // The scheme check is an allow-list (OP-12 P7c r3 N2, l2, as Hermes): ftp,
  // file, ws and wss are refused as well.
  for (const baseUrl of ["https://room.example:port/api", "room.example/api", "//room.example/api", "http://[::1/api",
    "foo://room.example/api", "ftp://room.example/api", "file://room.example/api", "ws://room.example/api",
    "wss://room.example/api", "FTP://room.example/api"]) {
    assert.throws(() => new RoomClient({baseUrl, credential: "credential",
      fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }}), (error) => {
      assert.ok(!(error instanceof RoomTransportError), error?.name);
      assert.ok(error instanceof RoomRequestError, `${baseUrl}: ${error?.name}`);
      assert.equal(error.code, "request_not_formed");
      assert.equal(error.cause, undefined);
      assert.ok(!`${error.message} ${JSON.stringify(error)} ${error.stack}`.includes("example"), baseUrl);
      return true;
    });
  }
  assert.equal(fetches, 0);
  // The start loop meets it when the channel makes its client: it fails closed.
  const starting = runtimeFor([HUMAN]);
  const startPath = join(await mkdtemp(join(home, "url-")), "status.json");
  starting.status = new LocalStatus(startPath, {version: "test", hostLabel: "host"});
  let starts = 0;
  starting.initializeOnce = async () => { starts += 1; return new RoomClient({baseUrl: "room.example/api", credential: "credential"}); };
  // A start loop that retried fails here with a message instead of hanging the
  // file (OP-12 P7c r3 N1): a second try rejects, and the runtime is closed.
  let watch;
  const startRetried = new Promise((_resolve, reject) => {
    watch = setInterval(() => { if (starts > 1) reject(new Error("start: retried")); }, 5);
  });
  try {
    await assert.rejects(Promise.race([starting.initializeRetrying(undefined), startRetried, hangGuard()]),
      (error) => error instanceof RoomRequestError);
  } finally {
    clearInterval(watch);
    await starting.close();
  }
  assert.equal(starts, 1, "not retried");
  await pause(20);
  const startEntry = JSON.parse(await readFile(startPath, "utf8")).rooms["room-1"];
  assert.deepEqual([startEntry.connection, startEntry.lastErrorCode], ["stopped", "request_not_formed"]);
  // A host outside Latin-1 is not refused: the URL parser writes it in
  // punycode and fetch is called with it (Hermes: http.client refuses its Host header).
  const hosts = [];
  const idn = new RoomClient({baseUrl: "https://例.example/api", credential: "credential",
    fetchImpl: async (url) => { hosts.push(new URL(url).hostname); return new Response("{}", {status: 200}); }});
  await idn.request("/rooms/room-1/state");
  assert.deepEqual(hosts, ["xn--fsq.example"]);
  // The other side (OP-12 P7c r3 N1, as Hermes): a Room URL that worked still
  // forms: an upper-case scheme, leading white space, a Latin-1 host, http and https.
  for (const baseUrl of ["https://room.example/api", "HTTPS://room.example/api", "Https://Room.Example/API",
    "  https://room.example/api", "\thttp://127.0.0.1:8787/api", "HTTP://127.0.0.1:8787/api", "https://räume.example/api"]) {
    const formed = [];
    const client = new RoomClient({baseUrl, credential: "credential",
      fetchImpl: async (url) => { formed.push(url); return new Response("{}", {status: 200}); }});
    await client.request("/rooms/room-1/state");
    assert.equal(formed.length, 1, `${JSON.stringify(baseUrl)}: formed and fetched`);
  }
  // A port fetch blocks (the Fetch standard's bad ports) is refused before any
  // I/O as well: the plugin's own error, not a failed contact (OP-12 N8).
  const blocked = new RoomClient({baseUrl: "http://127.0.0.1:6000/api", credential: "credential",
    fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }});
  await assert.rejects(blocked.request("/rooms/room-1/state"), (error) => error instanceof RoomRequestError && error.code === "request_not_formed");
  assert.equal(fetches, 0);
  const open = new RoomClient({baseUrl: "http://127.0.0.1:6001/api", credential: "credential",
    fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }});
  await open.request("/rooms/room-1/state");
  assert.equal(fetches, 1, "a port that is not blocked is contacted");
});

test("P7c-21 a credential the runtime refuses in a header is never in an error, a log line or the status, and the loop fails closed", async () => {
  // The runtime's own message would quote the header value; the plugin raises
  // its own error with a fixed message and code request_not_formed instead.
  const secret = "fixture-secret-7Q2";
  // A line break or NUL inside the value (a trailing one is trimmed by the runtime);
  // a DEL or another control character fetch refuses only when it dispatches (OP-12 P7c r2 N2).
  for (const credential of [`${secret}\nX-Injected: 1`, `${secret}\rX-Injected: 1`, `${secret}\u0000X`, `${secret}\u007fX`, `${secret}\u0001X`]) {
    let fetches = 0;
    const client = new RoomClient({baseUrl: "https://room.example/api", credential,
      fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }});
    let thrown = null;
    try { await client.request("/rooms/room-1/state"); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof RoomRequestError, JSON.stringify(credential));
    assert.equal(thrown.code, "request_not_formed");
    assert.equal(thrown.cause, undefined);
    for (const text of [thrown.message, String(thrown), thrown.stack, JSON.stringify(thrown)]) assert.ok(!text.includes(secret));
    // The loop: the event read fails closed; the status and the logs carry the code only.
    const directory = await mkdtemp(join(home, "refused-"));
    const path = join(directory, "status.json");
    const runtime = runtimeFor([HUMAN]);
    // The state holds the refused credential, as it does live (a log line printing it would leak it).
    runtime.state.credential = credential;
    runtime.status = new LocalStatus(path, {version: "test", hostLabel: "host"});
    runtime.client.readEvents = async () => client.request("/rooms/room-1/events");
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    let ended = null;
    // The refusal comes before any I/O; a loop that retried would wait out
    // the guard (OP-12 P7c r4 deferred 2: 20 s, not 120 s).
    try { await Promise.race([turns.next(), hangGuard(20_000)]); } catch (error) { ended = error; }
    controller.abort();
    assert.ok(ended instanceof RoomRequestError, String(ended?.name));
    assert.equal(fetches, 0);
    await pause(20);
    const status = await readFile(path, "utf8");
    const entry = JSON.parse(status).rooms["room-1"];
    assert.deepEqual([entry.connection, entry.lastErrorCode], ["stopped", "request_not_formed"]);
    assert.ok(!status.includes(secret));
    assert.ok(runtime.logs.includes(STOP_LINE), runtime.logs.join("\n"));
    assert.ok(!runtime.logs.join("\n").includes(secret));
    // Every other loop that can meet the refused request first fails closed
    // as well (OP-12 P7c r2 B2): the start loop when the channel starts, and
    // the heartbeat loop (a credential renewed after the start); not retried.
    for (const loop of ["start", "heartbeat"]) {
      const loopPath = join(directory, `${loop}.json`);
      const looping = runtimeFor([HUMAN]);
      looping.state.credential = credential;
      looping.status = new LocalStatus(loopPath, {version: "test", hostLabel: "host"});
      looping.reconnectInitialMs = 1;
      looping.reconnectMaxMs = 2;
      let tries = 0;
      const refused = async () => { tries += 1; return client.request("/rooms/room-1/connectors", {method: "POST", body: {}}); };
      let run;
      if (loop === "start") {
        looping.initializeOnce = refused;
        run = looping.initializeRetrying(undefined);
      } else {
        looping.heartbeatMinimumSeconds = 0.001;
        looping.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.001};
        looping.maintainPresence = refused;
        looping.runHeartbeat();
        run = looping.heartbeatTask;
      }
      const retried = new Promise((_resolve, reject) => {
        const timer = setInterval(() => { if (tries > 1) { clearInterval(timer); reject(new Error("retried")); } }, 5);
        timer.unref();
      });
      let failure = null;
      try { await Promise.race([run, retried, hangGuard()]); } catch (error) { failure = error; }
      // A loop that retried ends with the runtime, so the file goes on (OP-12 P7c r3 N1).
      if (tries > 1) await looping.close();
      assert.equal(tries, 1, `${loop}: not retried`);
      if (loop === "start") assert.ok(failure instanceof RoomRequestError, `${loop}: ${failure?.name}`);
      else assert.ok(looping.heartbeatAbort.signal.aborted && looping.heartbeatError instanceof RoomRequestError, loop);
      assert.equal(fetches, 0);
      await pause(20);
      const loopStatus = await readFile(loopPath, "utf8");
      const loopEntry = JSON.parse(loopStatus).rooms["room-1"];
      assert.deepEqual([loopEntry.connection, loopEntry.lastErrorCode], ["stopped", "request_not_formed"], loop);
      assert.ok(looping.logs.includes(STOP_LINE), `${loop}: ${looping.logs.join("\n")}`);
      assert.ok(!loopStatus.includes(secret) && !looping.logs.join("\n").includes(secret), loop);
      await looping.close();
    }
  }
  // The channel writes statusErrorCode(error) when it ends (src/channel.js): the
  // plugin's own code, never network.
  assert.equal(statusErrorCode(new RoomRequestError()), "request_not_formed");
  // The other side (OP-12 P7c r3 B1): a credential fetch sends is formed and
  // sent: a trailing line feed, spaces at both ends, a tab inside, é, ÿ, U+0080.
  for (const credential of [`${secret}\n`, `  ${secret}  `, `${secret}\tX`, `${secret}é`, `${secret}ÿ`, `${secret}\u0080X`]) {
    let fetches = 0;
    const client = new RoomClient({baseUrl: "https://room.example/api", credential,
      fetchImpl: async () => { fetches += 1; return new Response("{}", {status: 200}); }});
    await client.request("/rooms/room-1/state");
    assert.equal(fetches, 1, `${JSON.stringify(credential)}: formed and sent`);
  }
});

test("P7c-24 the header check refuses a credential exactly when the running runtime refuses the header it would send (OpenClaw fetch, Hermes http.client)", {timeout: 120_000}, async () => {
  // OP-12 P7c r3 N4: the pre-check is a copy of the runtime's rule; this holds it
  // to the running runtime. Every code point 0x00-0xFF and a few above, alone,
  // inside, first and last in the credential: real fetch to a loopback listener
  // (sent or refused), against the client with real fetch (sent or RoomRequestError).
  const {createServer} = await import("node:http");
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {"content-type": "application/json"});
    response.end("{}");
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const points = [...Array(0x100).keys(), 0x100, 0x2019, 0x3042, 0xd800, 0xfeff, 0xfffd, 0xffff];
  const outcomes = {sent: 0, refused: 0};
  const disagreements = [];
  try {
    for (const point of points) {
      const character = String.fromCharCode(point);
      for (const value of [character, `a${character}b`, `${character}ab`, `ab${character}`]) {
        const runtime = await fetch(`http://127.0.0.1:${port}/x`, {headers: {Authorization: `Bearer ${value}`}})
          .then(async (response) => { await response.arrayBuffer(); return "sent"; }, () => "refused");
        const client = new RoomClient({baseUrl: `http://127.0.0.1:${port}/api`, credential: value});
        const plugin = await client.request("/rooms/room-1/state")
          .then(() => "sent", (error) => (error instanceof RoomRequestError ? "refused" : `failed ${error?.name}`));
        outcomes[runtime] += 1;
        if (plugin !== runtime) disagreements.push(`U+${point.toString(16).padStart(4, "0")} in ${JSON.stringify(value)}: fetch ${runtime}, plugin ${plugin}`);
      }
    }
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  assert.deepEqual(disagreements, []);
  assert.ok(outcomes.sent > 0 && outcomes.refused > 0, JSON.stringify(outcomes));
});

test("P7c-22 held_by_moderator only for cycle_no_attempt while the Room state holds the refused cycle, and never the holder's name or membership id", async () => {
  const hold = {cycleId: "cycle-1", holderMembershipId: "holder-7k", holderDisplayName: "Thorsten", startedAt: "2026-10-05T10:00:00Z",
    expiresAt: "2026-10-05T10:00:45Z"};
  const superseded = () => { throw new RoomAPIError(409, {code: "cycle_superseded"}); };
  const {cycleId: _omitted, ...withoutCycle} = hold;
  const cases = {
    "hold of this cycle": [{activeHold: hold}, undefined, "held_by_moderator"],
    "empty object": [{activeHold: {}}, undefined, ""],
    "hold of another cycle": [{activeHold: {...hold, cycleId: "cycle-other"}}, undefined, ""],
    "hold without a cycle": [{activeHold: withoutCycle}, undefined, ""],
    "cycle_superseded during the hold": [{activeHold: hold}, superseded, ""],
    "no hold": [{activeHold: null}, undefined, ""],
    // A truthy activeHold that is not an object names no cycle (as Hermes, OP-12 P7c r2 N5).
    ...Object.fromEntries(["cycle-1", true, 1, ["cycle-1"], [hold]].map((value) => [`activeHold ${JSON.stringify(value)}`,
      [{activeHold: value}, undefined, ""]])),
  };
  const events = [START, HUMAN, PEER, INTERJECTION, responseReady(51)];
  for (const [label, [state, claim, reason]] of Object.entries(cases)) {
    const directory = await mkdtemp(join(home, "hold-exact-"));
    const path = join(directory, "status.json");
    const runtime = runtimeFor(events, {state, claim: claim ?? (() => null)});
    runtime.state.cursor = 50;
    runtime.status = new LocalStatus(path, {version: "test", hostLabel: "host"});
    runtime.reportStatus({connected: true});
    assert.deepEqual(await scan(runtime, events), [], label);
    assert.equal(runtime.calls.claims, 1, label);
    await pause(20);
    const text = await readFile(path, "utf8");
    assert.equal(JSON.parse(text).rooms["room-1"]?.lastGateWaitReason ?? "", reason, label);
    assert.ok(!text.includes("holder-7k") && !text.includes("Thorsten"), label);
  }
  // P2c-4: a renewal of a turn the agent holds is a later successful claim of
  // that Room: it clears the reason (OP-12 P7c r2 N6, p1).
  const directory = await mkdtemp(join(home, "hold-renewal-"));
  const path = join(directory, "status.json");
  const runtime = runtimeFor(events, {state: {activeHold: hold}, claim: () => null});
  runtime.state.cursor = 50;
  runtime.status = new LocalStatus(path, {version: "test", hostLabel: "host"});
  runtime.reportStatus({connected: true});
  await scan(runtime, events);
  const reason = async () => { await pause(20); return JSON.parse(await readFile(path, "utf8")).rooms["room-1"]?.lastGateWaitReason ?? ""; };
  assert.equal(await reason(), "held_by_moderator");
  runtime.client.claimDiscussionAttempt = async () => cycleAttempt();
  const renewed = await runtime.claimHeldAttempt({cycleAttempt: cycleAttempt(), sourceEvent: {id: "ready-5", seq: 5}}, undefined, "attempt_renewal_failed");
  assert.ok(renewed.refreshed, JSON.stringify(renewed));
  assert.equal(await reason(), "");
});

test("P7c-23 a timeout, a DNS failure, a connection reset or a refused connection on a request or on the event read is a failed contact and retried, never the connector's own request_not_formed", {timeout: 240_000}, async () => {
  // OP-12 P7c r3 B1 (Hermes; the same case here): a stop needs a gateway
  // restart, so a transient failure must never be taken for a request the
  // runtime refused to form. Each kind Node's fetch distinguishes, real
  // (loopback listeners, this process's resolver), through the real client on
  // a request and on the event read: a failed contact (never RoomRequestError,
  // status code network); the start, heartbeat and scan loops retry it.
  const faults = await transientFaults();
  try {
    for (const [kind, marker] of Object.entries(faults.kinds)) {
      for (const contact of ["register", "events", "heartbeat"]) {
        const error = await faults.fail(kind, contact).then(() => null, (caught) => caught);
        assert.ok(error && !(error instanceof RoomRequestError), `${kind} ${contact}: ${error?.name}`);
        assert.ok(transientRoomFailure(error) && uncodedContactFailure(error), `${kind} ${contact}: a failed contact`);
        assert.equal(statusErrorCode(error), "network", `${kind} ${contact}`);
        assert.ok(marker(error), `${kind} ${contact}: the failure is of this kind (${error?.name} ${error?.cause?.name} ${error?.cause?.code})`);
      }
      // The start loop: the registration fails once with the kind, then is accepted.
      const starting = runtimeFor([HUMAN]);
      const startStatuses = recordedStatuses(starting);
      Object.assign(starting, {reconnectInitialMs: 1, reconnectMaxMs: 2});
      let starts = 0;
      starting.initializeOnce = async () => { starts += 1; return starts === 1 ? faults.fail(kind, "register") : "started"; };
      assert.equal(await Promise.race([starting.initializeRetrying(undefined), hangGuard()]), "started", kind);
      assert.equal(starts, 2, `${kind}: retried`);
      await starting.close();
      // The heartbeat loop: two heartbeats fail with the kind, the loop goes on.
      const beating = runtimeFor([HUMAN]);
      const beatStatuses = recordedStatuses(beating);
      Object.assign(beating, {reconnectInitialMs: 1, reconnectMaxMs: 2, heartbeatMinimumSeconds: 0.001});
      beating.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.001};
      let beats = 0;
      beating.maintainPresence = async () => { beats += 1; if (beats <= 2) await faults.fail(kind, "heartbeat"); };
      beating.runHeartbeat();
      const deadline = Date.now() + 120_000;
      while (beats < 4 && !beating.heartbeatAbort.signal.aborted && Date.now() < deadline) await pause(5);
      assert.ok(beats >= 4 && !beating.heartbeatAbort.signal.aborted && !beating.heartbeatError, `${kind}: the heartbeat loop goes on`);
      await beating.close();
      // The scan: the event read fails once with the kind, then the page is read
      // and its turn handed on.
      const scanning = runtimeFor([START, HUMAN, PEER, ready(46, "m-42")]);
      const scanStatuses = recordedStatuses(scanning);
      Object.assign(scanning, {reconnectInitialMs: 1, reconnectMaxMs: 2});
      const page = scanning.client.readEvents;
      let reads = 0;
      scanning.client.readEvents = async (...args) => { reads += 1; return reads === 1 ? faults.fail(kind, "events") : page(...args); };
      const controller = new AbortController();
      const turns = scanning.assignedTurns(controller.signal);
      const turn = await Promise.race([turns.next(), hangGuard()]);
      controller.abort();
      await turns.return();
      assert.equal(turn.done, false, `${kind}: the scan goes on`);
      assert.ok(reads >= 2, `${kind}: read again`);
      await scanning.close();
      for (const [loop, statuses] of [["start", startStatuses], ["heartbeat", beatStatuses], ["scan", scanStatuses]]) {
        assert.equal(statuses.filter(([connection, code]) => connection === "reconnecting" && code === "network").length,
          loop === "heartbeat" ? 2 : 1, `${kind} ${loop}: ${JSON.stringify(statuses)}`);
        assert.ok(!statuses.some((entry) => entry.includes("stopped") || entry.includes("request_not_formed")), `${kind} ${loop}`);
      }
    }
  } finally {
    faults.close();
  }
});

// P7c-23: the transient failures of a Room contact, real: a peer that accepts
// and never answers (timed out by the runtime's own timeout, and by a bounded
// signal the caller passes, as the renewal and the cycle-source lookup do), a
// peer that reads the request and resets the connection, a closed port; a DNS
// failure as this process's resolver gives it. Each kind with its own mark.
async function transientFaults() {
  const net = await import("node:net");
  const dns = (await import("node:dns")).default;
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const held = new Set();
  const stall = net.createServer((socket) => { held.add(socket); socket.on("error", () => {}); });
  const reset = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/\r\ncontent-length:\s*(\d+)/iu.exec(received.subarray(0, end).toString("latin1"))?.[1] ?? 0);
      // The whole request was read; then a reset, not a close.
      if (received.length - end - 4 >= length) socket.resetAndDestroy();
    });
  });
  const ports = {stall: await listen(stall), reset: await listen(reset)};
  const closed = net.createServer();
  ports.closed = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const timedOut = (error) => error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
  const causeCode = (codes) => (error) => error instanceof RoomTransportError && codes.includes(error.cause?.code);
  const kinds = {
    "timeout of the runtime": (error) => error instanceof RoomTransportError && timedOut(error),
    "timeout of a bounded signal": (error) => !(error instanceof RoomTransportError) && timedOut(error),
    "DNS failure": causeCode(["ENOTFOUND"]),
    "connection reset": causeCode(["ECONNRESET", "UND_ERR_SOCKET"]),
    "connection refused": causeCode(["ECONNREFUSED"]),
  };
  const fail = async (kind, contact) => {
    // OP-12 P7c r4 deferred 3: a port closed right before this connect, so
    // no other process can have taken it in between.
    if (kind === "connection refused") {
      const fresh = net.createServer();
      ports.closed = await listen(fresh);
      await new Promise((resolve) => fresh.close(resolve));
    }
    const port = kind.startsWith("timeout") ? ports.stall : kind === "connection reset" ? ports.reset : ports.closed;
    const host = kind === "DNS failure" ? "localhost" : "127.0.0.1";
    const fetchImpl = kind === "timeout of the runtime"
      ? (url, init) => globalThis.fetch(url, {...init, signal: AbortSignal.timeout(200)})
      : globalThis.fetch;
    const client = new RoomClient({baseUrl: `http://${host}:${port}/api`, credential: "fixture-credential", fetchImpl});
    const signal = kind === "timeout of a bounded signal" ? AbortSignal.timeout(200) : undefined;
    const session = {roomId: "room-1", credential: "fixture-credential", clientInstanceId: "client-1"};
    const lookup = dns.lookup;
    if (kind === "DNS failure") {
      dns.lookup = (hostname, options, callback) => {
        const done = typeof options === "function" ? options : callback;
        process.nextTick(done, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`),
          {code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname}));
      };
    }
    try {
      if (contact === "register") await client.register(session, {transport: "poll"}, signal);
      else if (contact === "heartbeat") await client.heartbeat(session, "s", signal);
      else await client.readEvents(session, 40, {signal});
    } finally {
      dns.lookup = lookup;
    }
    throw new Error(`${kind}: the ${contact} did not fail`);
  };
  return {
    kinds, fail,
    close: () => { for (const socket of held) socket.destroy(); stall.close(); reset.close(); },
  };
}

// Every {connection, errorCode} pair a runtime's loops report, in order.
function recordedStatuses(runtime) {
  const statuses = [];
  const report = runtime.reportStatus.bind(runtime);
  runtime.reportStatus = (fields) => { statuses.push([fields?.connection, fields?.errorCode]); return report(fields); };
  return statuses;
}

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

// OP-12 P7c OpenClaw review N12: tests for the surviving mutations c, q2, q4, q6.
test("reply names come only from the messages kept for the context", () => {
  // A reply to a message of an earlier discussion and to the current item: both
  // are outside the context read, so both are named by their event id.
  const earlier = {id: "m-30", seq: 30, type: "message.posted", actorRole: "participant_agent", actorId: "paula",
    payload: {body: "From an earlier discussion."}};
  const current = {...HUMAN, id: "m-48", seq: 48};
  const reply = {id: "m-46", seq: 46, type: "message.posted", actorRole: "participant_agent", actorId: "paula",
    payload: {body: "I answer both.", respondsTo: ["m-30", "m-48"]}};
  const rendered = canonicalRoomContext({roster: ROSTER}, [earlier, START, HUMAN, reply, current], "m-48", {}, 41, null, "zurie");
  assert.ok(rendered.includes("#46 Paula (reply to canonical event m-30, canonical event m-48): I answer both."), rendered);
  assert.ok(!rendered.includes("From an earlier discussion."));
});

test("a failed Room state read after a refused claim is swallowed and the event is acknowledged", async () => {
  const events = [START, HUMAN, PEER, INTERJECTION, responseReady(51)];
  let refused = false;
  const runtime = runtimeFor(events, {claim: () => { refused = true; return null; }});
  const read = runtime.client.roomState;
  runtime.client.roomState = async (...args) => {
    if (refused) throw new Error("state read failed");
    return read(...args);
  };
  runtime.state.cursor = 50;
  assert.deepEqual(await scan(runtime, events), []);
  assert.equal(runtime.calls.claims, 1);
  assert.deepEqual(runtime.calls.acks, [51]);
});

test("a command source older than the loaded page is found by the cycle-source lookup and posts without respondsTo", async () => {
  const older = Array.from({length: 70}, (_, index) => ({id: `m-${46 + index}`, seq: 46 + index, type: "message.posted",
    actorRole: "human_owner", actorId: "owner-tj", payload: {body: `Message ${46 + index}.`, epochId: "epoch-z"}}));
  const events = [START, HUMAN, ASK, ...older, ready(120, "cmd-45")];
  const {turn} = await turnText(events, {claim: claimed("cmd-45")});
  assert.equal(turn.respondsToId, "");
});

test("a fenced message of an earlier discussion is acknowledged at once, before the next event is handled", async () => {
  const old = {id: "m-20", seq: 20, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
    payload: {body: "A message of the earlier discussion.", resolvedRecipientMembershipIds: ["zurie"]}};
  // No event in between that is acknowledged before its own state read (a
  // discussion start is, and its cumulative acknowledgement would cover 20).
  const events = [old, HUMAN];
  const runtime = runtimeFor(events, {pageStartsAt: 0, policy: {coordinationMode: "open"}});
  runtime.state.cursor = 19;
  // The first Room state read after the fenced message was superseded is the
  // fence read of the next event: the fenced message is acknowledged by then.
  let superseded = false;
  let acknowledgedAtNextRead = null;
  const supersede = runtime.supersedeHistoricalEvent.bind(runtime);
  runtime.supersedeHistoricalEvent = async (event, ...rest) => {
    const result = await supersede(event, ...rest);
    if (event.seq === 20) superseded = true;
    return result;
  };
  const read = runtime.client.roomState;
  runtime.client.roomState = async (...args) => {
    if (superseded && acknowledgedAtNextRead === null) acknowledgedAtNextRead = [...runtime.calls.acks];
    return read(...args);
  };
  await scan(runtime, events);
  assert.ok(superseded, "the earlier message was fenced");
  assert.deepEqual(acknowledgedAtNextRead, [20]);
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
