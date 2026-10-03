// Shared conformance cases for parity release P2a (delivery contract section
// "P2a — Equal access after missed turns"). Case names are identical in the
// Hermes and OpenClaw conformance.json files.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
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
const {createRoomChannel} = await import("../src/channel.js");
const {OpenClawRoomRuntime, isAssignedEvent, serverMissedSource} = await import("../src/runtime.js");
const {validateState} = await import("../src/state.js");
const {RoomAPIError} = await import("../src/room-client.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p2a-"));
after(() => rm(home, {recursive: true, force: true}));
// The P1a-01 deny-list: connector-authored text never carries these.
const DENY = ["consensus", "common ground", "synthes", "otherwise pass", "only if", "meaningful", "manufacture", "do not repeat", "force", "agree"];

const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
  {membershipId: "paula", displayName: "Paula", role: "participant_agent", status: "active"},
];
const ts = (seq) => `2026-10-02T09:${String(49 + Math.floor((seq - 2964) / 10)).padStart(2, "0")}:${String((seq * 7) % 60).padStart(2, "0")}Z`;
const message = (seq, actorId, actorRole, body, extra = {}) => ({id: `message0000${seq}`, seq, ts: ts(seq), type: "message.posted",
  actorRole, actorId, payload: {body, epochId: "epoch-z", ...extra}});
const readyFor = (seq, sourceEventId, membershipId = "zurie") => ({id: `attemptready${seq}`, seq, ts: ts(seq),
  type: "discussion.cycle_attempt_ready", actorRole: "system", actorId: "room_coordinator",
  payload: {cycleId: `cycle-${seq}`, epochId: "epoch-z", generation: 1, membershipId, round: 1, sourceEventId}});

// A runtime for membership `membershipId` over `events`, with a Room that
// answers the given operations; returns the runtime and its turn iterator.
function roomRuntime(events, {membershipId = "zurie", cursor, mode = "coordinated", start, claim, epochStartsAtSeq = 2900} = {}) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId, credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.starts = [];
  runtime.client = {
    readEvents: async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: epochStartsAtSeq,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => ({headSeq: events.at(-1).seq, activeEpoch: {id: "epoch-z", startsAtSeq: epochStartsAtSeq}, activeTopic: {title: "Coding"}, roster: ROSTER, rules: []}),
    roomPolicy: async () => ({policy: {coordinationMode: mode}}),
    listArtifacts: async () => ({items: []}),
    startDiscussionCycle: async (_state, request) => {
      runtime.starts.push(structuredClone(request));
      if (start) return start(request);
      return {cycle: {id: "cycle-new", generation: 1}};
    },
    claimDiscussionAttempt: async (_state, cycleId) => {
      if (claim) return claim(cycleId);
      return {attempt: {id: `attempt-${cycleId}`, round: 1, membershipId}, cycle: {id: cycleId, generation: 1, totalTurns: 0, budgets: {totalTurns: 4, perAgentTurns: 2}}};
    },
    acknowledge: async (_state, seq) => ({acknowledgedSeq: seq}),
    acknowledgePeerContribution: async () => ({}),
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  return runtime;
}

async function nextTurn(turns) {
  const {value, done} = await turns.next();
  assert.equal(done, false, "a turn is yielded");
  return value;
}

test("conformance P2a case names resolve to tests in this suite", async () => {
  const cases = Object.entries(conformance.parityP2aCases ?? {});
  assert.equal(cases.length, 6);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const [id, name] of cases) {
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
  }
});

test("P2a-01 a host wait the connector cannot observe is bounded and falls back", async () => {
  // OpenClaw waits on the host only for the inbound run it started, which the
  // host reports by settling. A host that exposes no session-release signal
  // (no session busy, stale or task API) still gets every turn at once.
  const events = [1, 2].map((n) => ({
    id: `event-${n}`, sourceEventId: `event-${n}`, respondsToId: `event-${n}`, roomId: "room-1", epochId: "epoch-1",
    conversationId: "room-1:epoch:x", senderId: "human-1", senderName: "Owner", senderKind: "human",
    text: `question ${n}`, occurredAt: Date.now() - 1_500, raw: {seq: 40 + n}, cycleAttempt: null,
  }));
  const runs = [];
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { yield* events; },
    markTurnReading: async () => {},
    postAndFinish: async ({sourceEventId}) => ({eventId: `posted-${sourceEventId}`, sentAt: 1}),
    settleDiscussionAttempt: async () => {},
    recordSkipped: async () => {},
    ack: async () => {},
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  const info = [];
  let status = {};
  const ctx = {
    account: {accountId: "default", stateFile: join(home, "p2a-01.json")}, accountId: "default", cfg: ISOLATED_HOST_CONFIG,
    abortSignal: new AbortController().signal, getStatus: () => status, setStatus: (next) => { status = next; },
    log: {info: (line) => info.push(line), warn: () => {}, error: () => {}},
    channelRuntime: {
      // Only what OpenClaw's inbound contract requires: no session-busy API.
      inbound: {run: async ({raw, adapter}) => {
        runs.push(raw.id);
        const turn = adapter.resolveTurn(adapter.ingest(raw));
        await turn.delivery.deliver({text: `answer to ${raw.id}`});
      }},
      routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
      session: {resolveStorePath: () => join(home, "session-store"), recordInboundSession: async () => {}},
      reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
    },
  };
  const started = Date.now();
  await Promise.race([
    channel.plugin.gateway.startAccount(ctx),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the channel waited on the host without bound")), 2_000).unref()),
  ]);
  assert.deepEqual(runs, ["event-1", "event-2"]);
  assert.ok(Date.now() - started < 2_000);
  // Diagnostics: each turn logs entering and leaving the host run, with
  // room, seq and seconds.
  for (const seq of [41, 42]) {
    assert.equal(info.filter((line) => new RegExp(`^\\[default\\] Room room-1 seq ${seq} dispatched to the host after waiting (1\\.[5-9]|[2-9])\\.?\\d*s since the Room event; later Room events wait for this run$`, "u").test(line)).length, 1, info.join("\n"));
    assert.equal(info.filter((line) => new RegExp(`^\\[default\\] Room room-1 seq ${seq} host run ended after \\d+\\.\\ds$`, "u").test(line)).length, 1, info.join("\n"));
  }
  // No source reads a host session-task internal it cannot rely on.
  for (const file of ["channel.js", "runtime.js"]) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /_session_tasks|_session_task_is_stale|_track_session_task|sessionBusy|isSessionReleased/u, file);
  }
});

test("P2a-03 a missed source is offered once as a procedural fact and then cleared", async () => {
  // The owner's @Zurie 2964 is refused before the model runs (cycle start
  // refused); five newer messages follow; Zurie's next turn (attempt 2970,
  // sourced from Paula's 2969) states the miss as a fact, once.
  const mention = message(2964, "owner-tj", "human_owner", "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
  const newer = [2965, 2966, 2967, 2968].map((seq) => message(seq, seq % 2 ? "paula" : "owner-tj", seq % 2 ? "participant_agent" : "human_owner",
    `Note ${seq}.`, {resolvedRecipientMembershipIds: ["paula"]}));
  const paula = message(2969, "paula", "participant_agent", "Zurie, over to you.", {resolvedRecipientMembershipIds: ["zurie"]});
  const ready = readyFor(2970, paula.id);
  const later = message(2971, "paula", "participant_agent", "And again.", {resolvedRecipientMembershipIds: ["zurie"]});
  const ready2 = readyFor(2972, later.id);
  const events = [mention, ...newer, paula, ready, later, ready2];
  const runtime = roomRuntime(events, {cursor: 2963, start: (request) => {
    if (request.sourceEventId === mention.id) throw new RoomAPIError(409, {code: "cycle_conflict"});
    return {cycle: {id: "cycle-new", generation: 1}};
  }});
  const snapshots = [];
  const persist = runtime.persistState.bind(runtime);
  runtime.persistState = async () => { await persist(); snapshots.push(structuredClone(runtime.state.missedSources ?? null)); };
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const first = await nextTurn(turns);
  assert.equal(first.sourceEventId, ready.id);
  const fact = "Missed earlier: #2964 TJE, 09:49 UTC; 5 newer messages since.";
  const facts = first.text.slice(first.text.indexOf("[Room turn facts]"), first.text.indexOf("[/Room turn facts]"));
  assert.ok(facts.includes(`\n${fact}\n`), first.text);
  assert.equal(first.text.split("Missed earlier").length - 1, 1);
  // Facts only: number, speaker, time, count; nothing connector-authored to act on.
  assert.deepEqual(DENY.filter((word) => fact.toLowerCase().includes(word)), []);
  // Recorded durably, then cleared durably before the turn reached the host.
  assert.deepEqual(snapshots.find((item) => item?.length), [{sourceEventId: mention.id, sourceSeq: 2964}]);
  assert.equal(snapshots.at(-1), null);
  assert.equal(runtime.state.missedSources, undefined);
  // The next turn does not repeat it.
  runtime.state.cursor = ready.seq;
  runtime.state.terminalEvidence[String(ready.seq)] = {status: "skipped", sourceEventId: ready.id, sourceSeq: ready.seq,
    canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: "model_no_visible_reply"};
  const second = await nextTurn(turns);
  assert.equal(second.sourceEventId, ready2.id);
  assert.doesNotMatch(second.text, /Missed earlier/u);
  controller.abort();
  await turns.return();

  // An unclaimed attempt (cycle_no_attempt) is a miss of its source too.
  const unclaimed = roomRuntime([mention, readyFor(2965, mention.id), paula, ready], {cursor: 2963, claim: (cycleId) => {
    if (cycleId === "cycle-2965") throw new RoomAPIError(409, {code: "cycle_no_attempt"});
    return {attempt: {id: `attempt-${cycleId}`, round: 1, membershipId: "zurie"}, cycle: {id: cycleId, generation: 1, totalTurns: 0, budgets: {totalTurns: 4, perAgentTurns: 2}}};
  }});
  const controller2 = new AbortController();
  const turns2 = unclaimed.assignedTurns(controller2.signal);
  const turn = await nextTurn(turns2);
  controller2.abort();
  await turns2.return();
  assert.equal(turn.sourceEventId, ready.id);
  assert.match(turn.text, /\nMissed earlier: #2964 TJE, 09:49 UTC; 1 newer message since\.\n/u);

  // Shared table: a missed source before the current discussion is not
  // offered (missed #2900, epoch starts at 2950, turn 3000), and cleared.
  const before = message(2900, "owner-tj", "human_owner", "Before the restart.");
  const late = message(2999, "paula", "participant_agent", "Zurie, your turn.", {resolvedRecipientMembershipIds: ["zurie"]});
  const floored = roomRuntime([before, late, readyFor(3000, late.id)], {cursor: 2999, epochStartsAtSeq: 2950});
  floored.state.missedSources = [{sourceEventId: before.id, sourceSeq: 2900}];
  const controller3 = new AbortController();
  const turns3 = floored.assignedTurns(controller3.signal);
  const floorTurn = await nextTurn(turns3);
  controller3.abort();
  await turns3.return();
  assert.equal(floorTurn.sourceEventId, "attemptready3000");
  assert.doesNotMatch(floorTurn.text, /Missed earlier/u);
  assert.equal(floored.state.missedSources, undefined);
});

test("P2a-04 a coordinated ask without retry starts a cycle for its target", async () => {
  const ask = (seq, targets, extra = {}) => ({id: `command0000${seq}`, seq, ts: ts(seq), type: "human.command", actorRole: "human_owner",
    actorId: "owner-tj", payload: {epochId: "epoch-z", command: {command: "ask", arguments: {instruction: "Your view, Zurie?"},
      resolvedTargetMembershipIds: targets, targetSelectors: [{kind: "membership", membershipId: targets[0]}], ...extra}}});
  for (const mode of ["coordinated", "open"]) {
    const command = ask(2980, ["zurie"]);
    const runtime = roomRuntime([command, readyFor(2981, command.id)], {cursor: 2979, mode});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    const turn = await nextTurn(turns);
    controller.abort();
    await turns.return();
    assert.equal(runtime.starts.length, 1, mode);
    assert.equal(runtime.starts[0].sourceEventId, command.id, mode);
    assert.deepEqual(runtime.starts[0].roster.map((member) => member.membershipId), ["zurie"], mode);
    assert.equal(turn.sourceEventId, "attemptready2981", mode);
  }
  // Only its targets are assigned; an ask with a server cycle is not restarted.
  assert.equal(isAssignedEvent(ask(2982, ["zurie"]), "zurie"), true);
  assert.equal(isAssignedEvent(ask(2982, ["zurie"]), "paula"), false);
  const withCycle = ask(2983, ["zurie"]);
  withCycle.payload.cycleId = "cycle-server";
  assert.equal(isAssignedEvent(withCycle, "zurie"), false);
  // retryUnavailable keeps working the same way.
  const retry = ask(2984, ["zurie"]);
  retry.payload.command.arguments.retryUnavailable = true;
  assert.equal(isAssignedEvent(retry, "zurie"), true);
});

// Contract L1-13 (P4, Room server joint-772ca32, R2): the Room may name the
// member's oldest missed source on an attempt-ready event.
test("L1-16 a missed source named by the Room replaces the local record and is offered once within the epoch floor", async () => {
  const mention = message(2964, "owner-tj", "human_owner", "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
  const named = message(2966, "owner-tj", "human_owner", "And this one?", {resolvedRecipientMembershipIds: ["zurie"]});
  const newer = [2967, 2968].map((seq) => message(seq, "paula", "participant_agent", `Note ${seq}.`, {resolvedRecipientMembershipIds: ["paula"]}));
  const paula = message(2969, "paula", "participant_agent", "Zurie, over to you.", {resolvedRecipientMembershipIds: ["zurie"]});
  const withField = (ready, missedSourceEventId) => ({...ready, payload: {...ready.payload, missedSourceEventId}});
  async function turnFor(ready, missedSources, extraEvents = [], options = {}) {
    const runtime = roomRuntime([mention, named, ...newer, paula, ...extraEvents, ready], {cursor: ready.seq - 1, ...options});
    if (missedSources) runtime.state.missedSources = structuredClone(missedSources);
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    const turn = await nextTurn(turns);
    controller.abort();
    await turns.return();
    return {turn, runtime};
  }
  const local = [{sourceEventId: mention.id, sourceSeq: 2964}];
  const marked = [{sourceEventId: named.id, sourceSeq: 0, offered: true}];
  // The Room's field replaces the local record, which is cleared.
  const first = await turnFor(withField(readyFor(2970, paula.id), named.id), local);
  const fact = first.turn.text.match(/\nMissed earlier: [^\n]*\n/u)?.[0] ?? "";
  assert.match(fact, /^\nMissed earlier: #2966 TJE, /u, first.turn.text);
  assert.match(fact, /; 3 newer messages since\.\n$/u);
  assert.equal(first.turn.text.split("Missed earlier").length - 1, 1);
  assert.deepEqual(first.runtime.state.missedSources, marked);
  assert.deepEqual(DENY.filter((word) => fact.toLowerCase().includes(word)), []);
  // Offered once: a later event repeating the field offers nothing.
  const again = await turnFor(withField(readyFor(2970, paula.id), named.id), marked);
  assert.doesNotMatch(again.turn.text, /Missed earlier/u);
  assert.deepEqual(again.runtime.state.missedSources, marked);
  // An attempt-ready event without the field ends that memory.
  const cleared = await turnFor(readyFor(2970, paula.id), marked);
  assert.doesNotMatch(cleared.turn.text, /Missed earlier/u);
  assert.equal(cleared.runtime.state.missedSources, undefined);
  // Without the field the local record is offered as before (P2a-3).
  const plain = await turnFor(readyFor(2970, paula.id), local);
  assert.match(plain.turn.text, /\nMissed earlier: #2964 TJE, /u);
  // The epoch floor: a named source before the active discussion is not offered.
  const before = message(2900, "owner-tj", "human_owner", "Before the restart.");
  const late = message(2999, "paula", "participant_agent", "Zurie, your turn.", {resolvedRecipientMembershipIds: ["zurie"]});
  const floored = roomRuntime([before, late, withField(readyFor(3000, late.id), before.id)], {cursor: 2999, epochStartsAtSeq: 2950});
  const controller = new AbortController();
  const turns = floored.assignedTurns(controller.signal);
  const floorTurn = await nextTurn(turns);
  controller.abort();
  await turns.return();
  assert.doesNotMatch(floorTurn.text, /Missed earlier/u);
  // A field equal to the attempt's own source is no missed source.
  assert.equal(serverMissedSource({sourceEventId: "a", missedSourceEventId: "a"}), "");
  assert.equal(serverMissedSource({sourceEventId: "a", missedSourceEventId: "b"}), "b");
  // The mark is durable and validated with the state.
  const state = structuredClone(first.runtime.state);
  validateState(state);
  state.missedSources = [{...marked[0], offered: "yes"}];
  assert.throws(() => validateState(state), /missed sources/u);

  // OP-12 P4 r1 item 2: a failed read leaves the Room's source unmarked.
  const direct = roomRuntime([named, paula], {cursor: 2969});
  direct.client.readEvents = async () => { throw new Error("network"); };
  assert.deepEqual(await direct.missedSourceFacts({seq: 2970}, [named], ROSTER, 2900, new Set(), undefined, named.id),
    {facts: [], offered: [], mark: ""});
  // OP-12 P4 r1 item 5: the epoch floor also holds for a source on the current page.
  assert.deepEqual(await direct.missedSourceFacts({seq: 3000}, [before], ROSTER, 2950, new Set(), undefined, before.id),
    {facts: [], offered: [before.id], mark: before.id});
  direct.state.missedSources = [{sourceEventId: before.id, sourceSeq: 0}];
  assert.deepEqual(await direct.missedSourceFacts({seq: 3000}, [before], ROSTER, 2950, new Set(), undefined),
    {facts: [], offered: [before.id], mark: ""});
});

// OP-12 P4 r1 (OpenClaw item 2, Hermes H1): a transient failure while offering
// leaves the Room's source unmarked, so a later turn offers it.
test("L1-19 a source the Room names as missed is remembered as offered only after its offer succeeded", async () => {
  const named = message(2966, "owner-tj", "human_owner", "And this one?", {resolvedRecipientMembershipIds: ["zurie"]});
  const newer = [2967, 2968, 2969].map((seq) => message(seq, "paula", "participant_agent", `Note ${seq}.`));
  const runtime = roomRuntime([named, ...newer], {cursor: 2969});
  const read = runtime.client.readEvents;
  runtime.client.readEvents = async () => { throw new Error("network"); };
  let result = await runtime.missedSourceFacts({seq: 2970}, [named], ROSTER, 2900, new Set(), undefined, named.id);
  assert.deepEqual(result, {facts: [], offered: [], mark: ""});
  await runtime.clearMissedSources(result.offered, {mark: result.mark, attemptReady: true});
  assert.equal(runtime.state.missedSources, undefined);
  // The next turn, with the Room still naming it: offered, then marked.
  runtime.client.readEvents = read;
  result = await runtime.missedSourceFacts({seq: 2970}, [named], ROSTER, 2900, new Set(), undefined, named.id);
  assert.equal(result.facts.length, 1);
  assert.match(result.facts[0], /^Missed earlier: #2966 /u);
  await runtime.clearMissedSources(result.offered, {mark: result.mark, attemptReady: true});
  assert.deepEqual(runtime.state.missedSources, [{sourceEventId: named.id, sourceSeq: 0, offered: true}]);
});

// Owner request 2026-10-03 (contract L1-16 to L1-18).
test("L1-22 a discussion start in a coordinated Room starts no cycle and is acknowledged", async () => {
  const start = {id: "start00002964", seq: 2964, ts: ts(2964), type: "discussion.started", actorRole: "human_owner", actorId: "owner-tj",
    payload: {epoch: {id: "epoch-z", startsAtSeq: 2900, topic: {title: "Coding"}}}};
  const mention = message(2965, "owner-tj", "human_owner", "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
  for (const mode of ["coordinated", "open"]) {
    const runtime = roomRuntime([start, mention, readyFor(2966, mention.id)], {cursor: 2963, mode});
    const evidence = [];
    const record = runtime.recordTerminalEvidence.bind(runtime);
    runtime.recordTerminalEvidence = async (event, status, options) => {
      evidence.push([event.seq, status, options?.reason]);
      return record(event, status, options);
    };
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    const turn = await nextTurn(turns);
    controller.abort();
    await turns.return();
    // No cycle from the start; the first human message carries the topic.
    assert.ok(runtime.starts.every((request) => request.sourceEventId !== start.id), mode);
    assert.ok(runtime.state.cursor >= 2964, `${mode}: the start is acknowledged`);
    assert.match(turn.text, /Current discussion: Coding/u, mode);
    assert.deepEqual(evidence.find(([seq]) => seq === 2964), [2964, "ignored", "discussion_start_not_a_trigger"], mode);
  }
});

test("L1-23 every human role, including human_member and agent_owner, is a cycle source", async () => {
  for (const role of ["human", "human_owner", "human_member", "human_admin", "agent_owner"]) {
    const guest = message(2964, "guest-1", role, "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
    const runtime = roomRuntime([guest, readyFor(2965, guest.id)], {cursor: 2963, mode: "coordinated"});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    await nextTurn(turns);
    controller.abort();
    await turns.return();
    assert.deepEqual(runtime.starts.map((request) => request.sourceEventId), [guest.id], role);
  }
  // "human_" exactly, never any role that only starts with "human" (r2 item 11).
  for (const role of ["participant_agent", "room_master", "humanoid", "human-owner"]) {
    const peer = message(2964, "paula", role, "Plain note.", {});
    const runtime = roomRuntime([peer, message(2965, "owner-tj", "human_owner", "@Zurie?", {resolvedRecipientMembershipIds: ["zurie"]}),
      readyFor(2966, "message00002965")], {cursor: 2963, mode: "coordinated"});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    await nextTurn(turns);
    controller.abort();
    await turns.return();
    assert.ok(!runtime.starts.some((request) => request.sourceEventId === peer.id), role);
  }
});

test("L1-24 a non-retryable 4xx cycle-start refusal with an unknown code is skipped and acknowledged, never a stopped channel", async () => {
  for (const [code, status] of [["source_not_eligible", 409], ["a_code_no_list_names", 422]]) {
    const mention = message(2964, "owner-tj", "human_owner", "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
    const later = message(2965, "owner-tj", "human_owner", "@Zurie and this?", {resolvedRecipientMembershipIds: ["zurie"]});
    const runtime = roomRuntime([mention, later, readyFor(2966, later.id)], {cursor: 2963, start: (request) => {
      if (request.sourceEventId === mention.id) throw new RoomAPIError(status, {code, retryable: false});
      return {cycle: {id: "cycle-new", generation: 1}};
    }});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    const turn = await nextTurn(turns);
    controller.abort();
    await turns.return();
    assert.equal(turn.sourceEventId, "attemptready2966", code);
    assert.ok(runtime.state.cursor >= 2964, `${code}: acknowledged`);
  }
  const {isCycleStartRefusal} = await import("../src/runtime.js");
  // OP-12 P4 r2 C1: the refusal code is bounded to 64 characters, as in Hermes.
  const sixtyFour = `a${"b".repeat(63)}`;
  assert.equal(new RoomAPIError(409, {code: sixtyFour}).refusalCode, sixtyFour);
  assert.equal(new RoomAPIError(409, {code: `${sixtyFour}c`}).refusalCode, "");
  assert.equal(new RoomAPIError(409, {code: "Upper_case"}).refusalCode, "");
  assert.equal(isCycleStartRefusal(new RoomAPIError(409, {code: `${sixtyFour}c`, retryable: false})), false);
  assert.equal(isCycleStartRefusal(new RoomAPIError(422, {code: "a_code_no_list_names", retryable: false})), true);
  for (const [code, status, retryable] of [["a_code_no_list_names", 422, true], ["a_code_no_list_names", 429, false],
    ["busy", 409, false], ["credential_renewal_pending", 409, false], ["Not A Code", 409, false]]) {
    assert.equal(isCycleStartRefusal(new RoomAPIError(status, {code, retryable})), false, `${code} ${status} ${retryable}`);
  }
});

test("L1-25 a 401 or 403 cycle-start refusal is a session failure, never a skipped source, and a skipped human command stays a missed source", async () => {
  const mention = message(2964, "owner-tj", "human_owner", "@Zurie your view?", {resolvedRecipientMembershipIds: ["zurie"]});
  // 401 and 403, whatever the code: thrown (the session path), never skipped or acknowledged.
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [401, "a_code_no_list_names"]]) {
    const runtime = roomRuntime([mention, readyFor(2965, mention.id)], {cursor: 2963, start: () => {
      throw new RoomAPIError(status, {code, retryable: false});
    }});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    await assert.rejects(nextTurn(turns), RoomAPIError, `${status} ${code}`);
    controller.abort();
    assert.equal(runtime.state.cursor, 2963, `${status} ${code}: not acknowledged`);
    assert.equal(runtime.state.terminalEvidence?.["2964"], undefined, `${status} ${code}: not skipped`);
  }
  // Every other refusal stays terminal for its source (404, 409 room_closed).
  for (const [status, code] of [[404, "not_found"], [409, "room_closed"]]) {
    const later = message(2965, "owner-tj", "human_owner", "@Zurie and this?", {resolvedRecipientMembershipIds: ["zurie"]});
    const runtime = roomRuntime([mention, later, readyFor(2966, later.id)], {cursor: 2963, start: (request) => {
      if (request.sourceEventId === mention.id) throw new RoomAPIError(status, {code, retryable: false});
      return {cycle: {id: "cycle-new", generation: 1}};
    }});
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    const turn = await nextTurn(turns);
    controller.abort();
    await turns.return();
    assert.equal(turn.sourceEventId, "attemptready2966", code);
    assert.ok(runtime.state.cursor >= 2964, `${code}: acknowledged`);
  }
  // A skipped human command stays a missed source and is offered.
  const ask = {id: "command00002965", seq: 2965, ts: ts(2965), type: "human.command", actorRole: "human_owner", actorId: "owner-tj",
    payload: {epochId: "epoch-z", command: {command: "ask", arguments: {instruction: "Your view, Zurie?"},
      resolvedTargetMembershipIds: ["zurie"], targetSelectors: [{kind: "membership", membershipId: "zurie"}]}}};
  const paula = message(2966, "paula", "participant_agent", "Zurie, over to you.", {resolvedRecipientMembershipIds: ["zurie"]});
  const runtime = roomRuntime([ask, paula, readyFor(2967, paula.id)], {cursor: 2964, start: (request) => {
    if (request.sourceEventId === ask.id) throw new RoomAPIError(409, {code: "source_not_eligible", retryable: false});
    return {cycle: {id: "cycle-new", generation: 1}};
  }});
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const turn = await nextTurn(turns);
  controller.abort();
  await turns.return();
  assert.match(turn.text, /\nMissed earlier: #2965 TJE, /u, turn.text);
  const {MISSED_SOURCE_EVENT_TYPES} = await import("../src/runtime.js");
  assert.equal(MISSED_SOURCE_EVENT_TYPES.has("discussion.started"), false);
});
