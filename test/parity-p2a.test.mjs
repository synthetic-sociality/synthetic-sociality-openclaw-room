// Shared conformance cases for parity release P2a (delivery contract section
// "P2a — Equal access after missed turns"). Case names are identical in the
// Hermes and OpenClaw conformance.json files.
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
const {createRoomChannel} = await import("../src/channel.js");
const {OpenClawRoomRuntime, isAssignedEvent} = await import("../src/runtime.js");
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
function roomRuntime(events, {membershipId = "zurie", cursor, mode = "coordinated", start, claim} = {}) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId, credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.starts = [];
  runtime.client = {
    readEvents: async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: 2900,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => ({headSeq: events.at(-1).seq, activeEpoch: {id: "epoch-z", startsAtSeq: 2900}, activeTopic: {title: "Coding"}, roster: ROSTER, rules: []}),
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
    text: `question ${n}`, occurredAt: n, raw: {}, cycleAttempt: null,
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
  let status = {};
  const ctx = {
    account: {accountId: "default", stateFile: join(home, "p2a-01.json")}, accountId: "default", cfg: {},
    abortSignal: new AbortController().signal, getStatus: () => status, setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: () => {}, error: () => {}},
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
