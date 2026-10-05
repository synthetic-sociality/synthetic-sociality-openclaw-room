// Parity P7a "Stay connected": contract P2c-3a, P2c-3b, P2c-3c, P2c-6 and the
// P2c-4 additions (conformance parityP7aCases; Hermes implements the same names).
//
// The Room server restart of 2026-10-04 22:16Z (FINDING-20261004-reconnect-
// after-server-restart): every Zurie channel exited ("Room event page active
// epoch metadata is invalid", then "Room API request failed (status=502)" on
// the start path) and waited for the host's "auto-restart attempt N/10".
//
// Waits are recorded through setTimeout (patched for a case, keyed by the
// calling function in the stack) and compressed to 1 ms. The modules are read
// as namespaces so that this file also runs against an older release.
import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ISOLATED_HOST_CONFIG} from "./support/isolated-host.mjs";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(join(tmpdir(), "openclaw-room-p7a-"));
process.env.HOME = home;
const runtimeModule = await import("../src/runtime.js");
const clientModule = await import("../src/room-client.js");
const statusModule = await import("../src/local-status.js");
const stateModule = await import("../src/state.js");
const channelModule = await import("../src/channel.js");
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const {OpenClawRoomRuntime} = runtimeModule;
const {RoomAPIError} = clientModule;
const ID = "synthetic-sociality-room";
const CAP_MS = 15_000;

const realSetTimeout = globalThis.setTimeout;
function compressTimers() {
  const waits = [];
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 500) {
      waits.push({ms: milliseconds, stack: String(new Error().stack)});
      return realSetTimeout(callback, 1, ...args);
    }
    return realSetTimeout(callback, milliseconds, ...args);
  };
  return {
    of: (name) => waits.filter((wait) => wait.stack.includes(name)).map((wait) => wait.ms),
    restore: () => { globalThis.setTimeout = realSetTimeout; },
  };
}
const pause = (milliseconds) => new Promise((resolve) => realSetTimeout(resolve, milliseconds));

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json", ...headers}});
const badGateway = (headers = {}) => new Response("<html><body>502 Bad Gateway</body></html>", {status: 502, headers: {"content-type": "text/html", ...headers}});

// A Room at the HTTP level: the registration answers from a script, then 200.
async function startRuntime(registerAnswers, {status} = {}) {
  const directory = await mkdtemp(join(home, "state-"));
  const stateFile = join(directory, "default.json");
  await stateModule.saveState(stateFile, {version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "fixture-credential", clientInstanceId: "client-1", cursor: 0});
  const calls = {register: 0};
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    status,
    fetchImpl: async (url) => {
      if (url.endsWith("/connector/sessions")) {
        calls.register += 1;
        const answer = registerAnswers.shift();
        if (answer instanceof Error) throw answer;
        if (answer) return answer;
        return json({sessionId: "session-1", heartbeatIntervalSeconds: 60, capabilities: []});
      }
      if (url.endsWith("/activity")) return json({acceptedStreamSeq: 1}, 202);
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  runtime.runHeartbeat = () => {};
  return {runtime, calls};
}

// The event runtime of the parity suites, with a stubbed Room client.
const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
];
const message = (seq, body) => ({id: `message0000${seq}`, seq, ts: "2026-10-05T09:49:00Z", type: "message.posted",
  actorRole: "human_owner", actorId: "owner-tj", payload: {body, epochId: "epoch-z"}});
function roomRuntime(events) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: events[0].seq - 1, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.persistState = async () => {};
  runtime.client = {
    readEvents: async (_state, afterSeq) => ({activeEpochId: "epoch-z", activeEpochStartsAtSeq: 1,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => ({headSeq: events.at(-1).seq, activeEpoch: {id: "epoch-z", startsAtSeq: 1}, activeTopic: {title: "Coding"}, roster: ROSTER, rules: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "open"}}),
    listArtifacts: async () => ({items: []}),
    acknowledge: async (_state, seq) => ({acknowledgedSeq: seq}),
    acknowledgePeerContribution: async () => ({}),
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  return runtime;
}

const leaseIn = (milliseconds) => new Date(Date.now() + milliseconds).toISOString();
const baseMs = (step, capMs = CAP_MS) => Math.min(capMs, 1000 * 2 ** step);
function assertOnSchedule(wait, step, all, capMs = CAP_MS) {
  assert.ok(wait >= 0.8 * baseMs(step, capMs) - 1e-6 && wait <= baseMs(step, capMs) + 1e-6, `step ${step}: ${all}`);
}
const html = (status) => new Response(`<html><body>${status} from the edge</body></html>`, {status, headers: {"content-type": "text/html"}});
const page = (events, extra = {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 1}) => ({...extra, events});

test("conformance P7a case names resolve to tests in this suite", async () => {
  const {readdir} = await import("node:fs/promises");
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  const cases = Object.entries(conformance.parityP7aCases ?? {});
  assert.equal(cases.length, 16);
  cases.forEach(([id, name], index) => {
    assert.equal(id, `P7a-${String(index + 1).padStart(2, "0")}`);
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
  });
  assert.equal(conformance.parityP7aContract, "docs/delivery-lifecycle-contract-v1.md#p2c--secrets-late-replies-self-recovery-2026-10-02");
});

test("the P7a schedule and web reading names are the shared values", () => {
  assert.deepEqual(conformance.parityP7aReconnectSchedule, {
    firstSeconds: runtimeModule.RECONNECT_FIRST_MS / 1000, capSeconds: runtimeModule.RECONNECT_CAP_MS / 1000,
    jitterFactor: [runtimeModule.RECONNECT_JITTER_LOW, 1.0], retryAfter5xxMaxSeconds: runtimeModule.RECONNECT_CAP_MS / 1000,
    retryAfter429MaxSeconds: clientModule.RETRY_AFTER_MAXIMUM_SECONDS,
    attemptRenewalCapSeconds: new OpenClawRoomRuntime({accountId: "x", stateFile: join(home, "x.json")}).attemptRenewalRetryMs / 1000,
    inactiveRecheckSeconds: runtimeModule.INACTIVE_RECHECK_MS / 1000,
  });
  assert.deepEqual(conformance.parityP7aWebReadToolNames, [...statusModule.WEB_READ_TOOL_NAMES]);
  const runtime = new OpenClawRoomRuntime({accountId: "x", stateFile: join(home, "y.json")});
  assert.equal(runtime.reconnectInitialMs, 1_000);
  assert.equal(runtime.reconnectMaxMs, 15_000);
});

test("the P2c-3a schedule bounds, and Retry-After parsing as Hermes", () => {
  const {reconnectDelayMs} = runtimeModule;
  const low = () => 0;
  const high = () => 1;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((step) => reconnectDelayMs(step, {random: high})), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.deepEqual([0, 1, 2, 3, 4].map((step) => reconnectDelayMs(step, {random: low})), [800, 1600, 3200, 6400, 12000]);
  assert.equal(reconnectDelayMs(0, {retryAfterSeconds: 300, status: 502, random: low}), 15000);
  assert.equal(reconnectDelayMs(0, {retryAfterSeconds: 120, status: 429, random: low}), 120000);
  assert.equal(reconnectDelayMs(4, {retryAfterSeconds: 2, status: 503, random: high}), 15000);
  assert.equal(reconnectDelayMs(9, {capMs: 5000, random: high}), 5000);
  const {parseRetryAfter} = clientModule;
  assert.equal(parseRetryAfter("300"), 120);
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter(""), 0);
  assert.equal(parseRetryAfter("soon"), 0);
  assert.equal(parseRetryAfter("-4"), 0);
  assert.equal(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString(), Date.now()) <= 60, true);
});

test("P7a-01 the server answers 502 for a while, then 200: connected again within the cap after the first 200, without a channel exit", async () => {
  const {runtime, calls} = await startRuntime([badGateway(), badGateway(), json({}, 502), badGateway(), badGateway(), badGateway()]);
  const timers = compressTimers();
  try {
    const session = await runtime.initialize();
    assert.equal(session.sessionId, "session-1");
  } finally {
    timers.restore();
    await runtime.close();
  }
  assert.equal(calls.register, 7);
  const waits = timers.of("initializeRetrying");
  assert.equal(waits.length, 6);
  assert.ok(waits[0] <= 1000, String(waits));
  // The first 200 is answered at the next attempt, at most the cap later.
  assert.ok(waits.every((wait) => wait <= CAP_MS), String(waits));
});

test("P7a-02 a malformed event page once, then a valid one: retried inside the connector", async () => {
  const events = [message(41, "After the restart.")];
  const runtime = roomRuntime(events);
  let reads = 0;
  const readEvents = runtime.client.readEvents;
  runtime.client.readEvents = async (...args) => {
    reads += 1;
    if (reads === 1) return {events: []}; // during the server's shutdown: no active epoch metadata
    return readEvents(...args);
  };
  const controller = new AbortController();
  const timers = compressTimers();
  let turn;
  try {
    const turns = runtime.assignedTurns(controller.signal);
    turn = await turns.next();
    controller.abort();
    await turns.return();
  } finally {
    timers.restore();
  }
  assert.equal(turn.done, false);
  assert.equal(turn.value.sourceEventId ?? turn.value.id, "message000041");
  assert.ok(reads >= 2, String(reads));
  const waits = timers.of("assignedTurns");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 1000, String(waits));
});

test("P7a-03 a 5xx with Retry-After 300: the next attempt within the cap", async () => {
  const {runtime, calls} = await startRuntime([badGateway({"retry-after": "300"}), json({message: "unavailable"}, 503, {"retry-after": "300"})]);
  const timers = compressTimers();
  try {
    await runtime.initialize();
  } finally {
    timers.restore();
    await runtime.close();
  }
  assert.equal(calls.register, 3);
  const waits = timers.of("initializeRetrying");
  assert.equal(waits.length, 2);
  assert.ok(waits.every((wait) => wait <= CAP_MS), String(waits));
  // The event read honours a 5xx Retry-After up to the cap as well.
  const runtime2 = roomRuntime([message(41, "x")]);
  let reads = 0;
  runtime2.client.readEvents = async () => {
    reads += 1;
    if (reads === 1) throw new RoomAPIError(503, {}, {retryAfter: 120});
    return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 1, events: []};
  };
  const timers2 = compressTimers();
  try {
    await runtime2.readEventsResilient(40);
  } finally {
    timers2.restore();
  }
  assert.ok(timers2.of("readEventsResilient").every((wait) => wait <= CAP_MS));
});

test("P7a-04 a 429 with Retry-After: the 120 s bound is kept", async () => {
  const {runtime} = await startRuntime([json({message: "slow down"}, 429, {"retry-after": "30"}), json({message: "slow down"}, 429, {"retry-after": "300"})]);
  const timers = compressTimers();
  try {
    await runtime.initialize();
  } finally {
    timers.restore();
    await runtime.close();
  }
  const waits = timers.of("initializeRetrying");
  assert.equal(waits.length, 2);
  assert.equal(waits[0], 30_000);
  assert.equal(waits[1], 120_000);
});

test("P7a-05 a muted membership is inactive, not retried on the seconds schedule, and active again after the slow re-check", async () => {
  // RECEIPT-20261004-parity-P6 §4: muted memberships answered 401
  // connector_not_active on the enrollment listing; the connector registered
  // again every 3 to 16 s.
  const directory = await mkdtemp(join(home, "status-"));
  const path = join(directory, "status.json");
  const runtime = roomRuntime([message(41, "x")]);
  delete runtime.maintainPresence;
  runtime.publishPresence = async () => {};
  runtime.status = new statusModule.LocalStatus(path, {version: "test", hostLabel: "h"});
  runtime.inactiveRecheckMs = 300;
  const room = {status: "muted", registrations: 0, heartbeats: 0, enrollments: 0, stateReads: 0};
  Object.assign(runtime.client, {
    heartbeat: async () => { room.heartbeats += 1; return {leaseExpiresAt: "2099-01-01T00:00:00Z"}; },
    register: async () => { room.registrations += 1; return {sessionId: `session-${room.registrations}`, capabilities: []}; },
    connectorEnrollments: async () => {
      room.enrollments += 1;
      if (room.status === "muted") throw new RoomAPIError(401, {code: "connector_not_active", retryable: true});
      return [];
    },
    roomState: async () => {
      room.stateReads += 1;
      return {roster: [{membershipId: "zurie", status: room.status}]};
    },
  });
  const started = Date.now();
  while (Date.now() - started < 1000) {
    await runtime.maintainPresence();
    await pause(50);
  }
  const muted = {...room};
  const statusMuted = JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  room.status = "active";
  await pause(350);
  await runtime.maintainPresence();
  await runtime.maintainPresence();
  const statusActive = JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  assert.equal(muted.registrations, 0); // no registration again
  assert.ok(muted.heartbeats > 5, String(muted.heartbeats)); // the session and heartbeat continue
  assert.equal(muted.enrollments, 1); // no listing while muted
  assert.ok(muted.stateReads <= 1 + 1000 / 300 + 1, String(muted.stateReads)); // one read, then the slow re-check
  assert.deepEqual([statusMuted.connection, statusMuted.lastErrorCode], ["inactive", "connector_not_active"]);
  assert.ok(room.enrollments >= 2); // active again: the listing resumes
  assert.equal(statusActive.connection, "connected");
});

test("P7a-06 more than 10 consecutive failures: still retrying, every wait within the schedule and its jitter", async () => {
  const network = () => Object.assign(new TypeError("fetch failed"), {cause: {code: "ECONNREFUSED"}});
  const {runtime, calls} = await startRuntime(Array.from({length: 12}, network));
  const timers = compressTimers();
  try {
    await runtime.initialize();
  } finally {
    timers.restore();
    await runtime.close();
  }
  assert.equal(calls.register, 13);
  const waits = timers.of("initializeRetrying");
  assert.equal(waits.length, 12);
  assert.ok(waits.every((wait) => wait <= CAP_MS), String(waits));
  // Each wait lies in [0.8, 1.0] of its base 1, 2, 4, 8, 15, 15, ... s.
  waits.forEach((wait, index) => assertOnSchedule(wait, index, waits));
  // The factor is drawn, not fixed: twelve waits never all sit on their base.
  assert.ok(waits.some((wait, index) => wait < baseMs(index) - 1e-6), String(waits));
});

test("P7a-07 a transient attempt-renewal failure is retried within 1 s and never past the lease", async () => {
  // ISSUE-023: on the overloaded VPS a renewal answer was late; the next try
  // came only 5 s later.
  const runtime = roomRuntime([message(41, "x")]);
  delete runtime.startAttemptLease;
  const attempt = {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: leaseIn(60_000)}};
  let claims = 0;
  runtime.client.claimDiscussionAttempt = async () => {
    claims += 1;
    if (claims <= 3) throw new RoomAPIError(503, {});
    return {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: leaseIn(60_000)}};
  };
  const timers = compressTimers();
  try {
    runtime.startAttemptLease({id: "message000041", seq: 41}, attempt);
    const deadline = Date.now() + 5000;
    while (claims < 4 && Date.now() < deadline) await pause(1);
  } finally {
    await runtime.stopAttemptLease("message000041");
    timers.restore();
  }
  assert.ok(claims >= 4, String(claims));
  const retries = timers.of("renewAttemptLease");
  // three retries after the failures, then the ordinary renewal timer
  assert.ok(retries.length >= 3, String(retries));
  assert.ok(retries[0] <= 1000, String(retries));
  assert.ok(retries.slice(0, 3).every((wait) => wait <= 5000), String(retries));

  // Never past the lease: with 300 ms left, the retry waits at most that.
  const short = roomRuntime([message(41, "x")]);
  delete short.startAttemptLease;
  short.client.claimDiscussionAttempt = async () => { throw new RoomAPIError(503, {}); };
  const delays = [];
  const schedule = short.scheduleAttemptRenewal.bind(short);
  short.scheduleAttemptRenewal = (lease, retryDelayMs = 0) => { if (retryDelayMs) delays.push(retryDelayMs); return schedule(lease, retryDelayMs); };
  const lease = {sourceEvent: {id: "e", seq: 1}, cycleAttempt: {cycle: {id: "c", generation: 1}, attempt: {id: "a", membershipId: "zurie", leaseExpiresAt: leaseIn(300)}},
    timer: null, inflight: null, stopped: false, superseded: false, reason: ""};
  await short.renewAttemptLease(lease);
  lease.stopped = true;
  if (lease.timer) clearTimeout(lease.timer);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] <= 300, String(delays));
});

test("P7a-08 the status records the reconnect time, the outage length and a coded dispatch-wait reason", async () => {
  const directory = await mkdtemp(join(home, "status-"));
  const path = join(directory, "status.json");
  const status = new statusModule.LocalStatus(path, {version: "test", hostLabel: "h"});
  const {runtime} = await startRuntime([badGateway(), badGateway()], {status});
  const timers = compressTimers();
  try {
    await runtime.initialize();
  } finally {
    timers.restore();
    await runtime.close();
  }
  const entry = JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  assert.notEqual(entry.lastReconnectedAt, null);
  assert.ok(entry.lastOutageSeconds >= 0);
  assert.equal(entry.lastConnectedAt, entry.lastReconnectedAt);

  // The outage length; a heartbeat that survived is not a reconnect.
  const direct = new statusModule.LocalStatus(join(directory, "direct.json"), {version: "test", hostLabel: "h"});
  direct.room("room-2", "member-2", {connected: true, registered: true});
  direct.room("room-2", "", {connection: "reconnecting", errorCode: "http_502"});
  await pause(300);
  direct.room("room-2", "", {connected: true, registered: true});
  const first = JSON.parse(await readFile(join(directory, "direct.json"), "utf8")).rooms["room-2"];
  assert.ok(first.lastOutageSeconds >= 0.3, String(first.lastOutageSeconds));
  direct.room("room-2", "", {connection: "reconnecting", errorCode: "network"});
  direct.room("room-2", "", {connected: true});
  const second = JSON.parse(await readFile(join(directory, "direct.json"), "utf8")).rooms["room-2"];
  assert.equal(second.lastReconnectedAt, first.lastReconnectedAt);
  assert.equal(second.lastOutageSeconds, first.lastOutageSeconds);

  // The coded dispatch-wait reason: the second event arrived while the first
  // host run still held the session.
  statusModule.resetLocalStatusWriters();
  const stateFile = join(directory, "gate.json");
  const runs = [];
  let second2;
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () {
      yield {id: "e-1", sourceEventId: "e-1", respondsToId: "e-1", roomId: "room-g", conversationId: "room-g:c", senderId: "human-1",
        senderName: "Owner", senderKind: "human", text: "first", occurredAt: Date.now(), raw: {seq: 1}};
      yield second2;
    },
    markTurnReading: async () => {},
    recordSkipped: async () => {},
    ack: async () => {},
    close: async () => {},
  };
  const channel = channelModule.createRoomChannel({makeClient: () => client});
  const controller = new AbortController();
  let current = {running: false};
  const ctx = {
    account: {accountId: "gate", stateFile}, accountId: "gate", abortSignal: controller.signal, cfg: ISOLATED_HOST_CONFIG,
    getStatus: () => current, setStatus: (next) => { current = next; }, log: {info: () => {}, warn: () => {}, error: () => {}},
    channelRuntime: {
      inbound: {run: async ({raw}) => {
        runs.push(raw.id);
        if (raw.id === "e-1") {
          await pause(20);
          second2 = {id: "e-2", sourceEventId: "e-2", respondsToId: "e-2", roomId: "room-g", conversationId: "room-g:c", senderId: "human-1",
            senderName: "Owner", senderKind: "human", text: "second", occurredAt: Date.now() - 10, raw: {seq: 2}};
          await pause(20);
        }
      }},
      routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "gate", sessionKey: "s", mainSessionKey: "m"})},
    },
  };
  await channel.plugin.gateway.startAccount(ctx);
  const gate = JSON.parse(await readFile(channelModule.roomStatusPath(ISOLATED_HOST_CONFIG), "utf8")).rooms["room-g"];
  assert.deepEqual(runs, ["e-1", "e-2"]);
  assert.equal(gate.lastGateWaitReason, "host_run_busy");
  assert.ok(gate.lastGateWaitSeconds >= 0);
});

test("P7a-09 web reading is reported from the host's own tool selection, unknown when the host cannot report it", async () => {
  statusModule.resetLocalStatusWriters();
  const api = {config: ISOLATED_HOST_CONFIG, logger: {warn: () => {}}};
  // Only the gateway's own registration writes the status (noteWebRead).
  channelModule.roomToolCallPolicy(api)({toolName: "web_fetch", params: {}}, {sessionKey: `agent:main:${ID}:group:room-1:epoch:abc`});
  const policy = channelModule.roomToolCallPolicy(api, {noteWebRead: true});
  const path = channelModule.roomStatusPath(ISOLATED_HOST_CONFIG);
  channelModule.roomLocalStatus(api.logger, ISOLATED_HOST_CONFIG).setLoaded(true);
  // OpenClaw 2026.7.1-2 gives a channel plugin no resolved tool list: unknown.
  let written = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([written.webRead, written.webReadTools], ["unknown", []]);
  // A web tool in another channel's session, and a non-web tool in a Room turn, change nothing.
  assert.equal(policy({toolName: "web_fetch", params: {url: "https://example.org"}}, {sessionKey: "agent:main:telegram:group:x"}), undefined);
  assert.equal(policy({toolName: "memory_search", params: {}}, {sessionKey: `agent:main:${ID}:group:room-1:epoch:abc`}), undefined);
  written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.webRead, "unknown");
  // The host names a web reading tool in a Room turn: available, names only.
  assert.equal(policy({toolName: "web_fetch", params: {url: "https://example.org/page"}}, {sessionKey: `agent:main:${ID}:group:room-1:epoch:abc`}), undefined);
  written = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([written.webRead, written.webReadTools], ["available", ["web_fetch"]]);
  assert.ok(!JSON.stringify(written).includes("example.org"));
});

test("the P2c-3a failed contacts are exactly the listed ones; a programming error fails closed", () => {
  const {transientRoomFailure} = runtimeModule;
  const network = Object.assign(new TypeError("fetch failed"), {cause: Object.assign(new Error("connect ECONNREFUSED"), {code: "ECONNREFUSED"})});
  const reset = Object.assign(new TypeError("fetch failed"), {cause: Object.assign(new Error("other side closed"), {code: "UND_ERR_SOCKET"})});
  const retried = [network, reset, new RoomAPIError(502, {}), new RoomAPIError(429, {}),
    new clientModule.RoomResponseError(), new RoomAPIError(409, {code: "stale_context", retryable: true}),
    Object.assign(new Error("timed out"), {name: "TimeoutError"})];
  const closed = [
    new TypeError("Cannot read properties of undefined (reading 'network')"), new TypeError("terminated"),
    new TypeError("fetch failed"), Object.assign(new TypeError("fetch failed"), {cause: {code: "UND_ERR_ABORTED"}}),
    Object.assign(new Error("This operation was aborted"), {name: "AbortError"}),
    new RoomAPIError(401, {code: "credential_revoked", retryable: true}), new RoomAPIError(401, {code: "credential_expired"}),
    new RoomAPIError(403, {code: "validation_error"}), new RoomAPIError(404, {}), new Error("plain"),
    Object.assign(new Error("ENOSPC: no space left on device"), {code: "ENOSPC", syscall: "write"}),
  ];
  retried.forEach((error, index) => assert.equal(transientRoomFailure(error), true, `retried ${index}`));
  closed.forEach((error, index) => assert.equal(transientRoomFailure(error), false, `closed ${index}`));
});

test("P7a-10 an HTML 403 once and an HTML 404 once on the event read, on the heartbeat and on a post: the loop continues, the post stays retryable, no quarantine", async () => {
  // The event read: an edge error page is a failed contact, never a Room answer.
  const reads = roomRuntime([message(41, "x")]);
  const answers = [html(403), html(404)];
  reads.client = new clientModule.RoomClient({baseUrl: "https://room.example/api", credential: "fixture-credential",
    fetchImpl: async () => answers.shift() ?? json(page([message(41, "x")]))});
  const timers = compressTimers();
  let read;
  try {
    read = await reads.readEventsResilient(40);
  } finally {
    timers.restore();
  }
  assert.equal(read.events[0].seq, 41);
  assert.equal(timers.of("readEventsResilient").length, 2);

  // The heartbeat: the loop and the session stay; no registration.
  const beats = roomRuntime([message(41, "x")]);
  delete beats.maintainPresence;
  beats.publishPresence = async () => {};
  const room = {heartbeats: 0, registrations: 0};
  const heartbeatAnswers = [html(403), html(404)];
  beats.client = new clientModule.RoomClient({baseUrl: "https://room.example/api", credential: "fixture-credential", fetchImpl: async (url) => {
    if (url.includes("/heartbeat")) {
      const answer = heartbeatAnswers.shift();
      if (answer) return answer;
      room.heartbeats += 1;
      return json({leaseExpiresAt: "2099-01-01T00:00:00Z"});
    }
    if (url.endsWith("/connector/sessions")) { room.registrations += 1; return json({sessionId: "s2", capabilities: []}); }
    if (url.includes("/connector/enrollments")) return json([]);
    throw new Error(`Unexpected request: ${url}`);
  }});
  beats.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.01};
  beats.heartbeatMinimumSeconds = 0.01;
  const heartbeatTimers = compressTimers();
  try {
    beats.runHeartbeat();
    const deadline = Date.now() + 5000;
    while (room.heartbeats < 3 && Date.now() < deadline) await pause(5);
  } finally {
    await beats.close();
    heartbeatTimers.restore();
  }
  assert.ok(room.heartbeats >= 3, String(room.heartbeats));
  assert.equal(beats.heartbeatError, undefined);
  assert.equal(room.registrations, 0);

  // The post: an edge error page leaves the reply retryable, never quarantined.
  const client = new clientModule.RoomClient({baseUrl: "https://room.example/api", credential: "fixture-credential",
    fetchImpl: async () => answers.length ? answers.shift() : html(413)});
  for (const status of [403, 404, 413]) {
    answers.push(html(status));
    const error = await client.request("/rooms/room-1/messages", {method: "POST", body: {}, expected: [201]}).catch((caught) => caught);
    const outcome = runtimeModule.classifyPostRefusal(error, {identity: {}, post: {}});
    assert.equal(outcome.outcome, "retryable", `${status}: ${JSON.stringify(outcome)}`);
    assert.equal(runtimeModule.transientRoomFailure(error), true, String(status));
  }
});

test("P7a-11 an invalid page on the context read of a turn, once: the turn is not lost, the channel does not end, the page is not processed", async () => {
  const runtime = roomRuntime([message(41, "After the restart.")]);
  const readEvents = runtime.client.readEvents;
  let contextReads = 0;
  runtime.client.readEvents = async (state, after, options = {}) => {
    if (!options.wait) {
      contextReads += 1;
      // During the server's shutdown: no active epoch metadata, not a list of events.
      if (contextReads === 1) return {events: [message(40, "Never processed."), "garbage"]};
    }
    return readEvents(state, after, options);
  };
  const controller = new AbortController();
  const timers = compressTimers();
  let turn;
  try {
    const turns = runtime.assignedTurns(controller.signal);
    turn = await turns.next();
    controller.abort();
    await turns.return();
  } finally {
    timers.restore();
  }
  assert.equal(turn.done, false);
  assert.equal(turn.value.sourceEventId ?? turn.value.id, "message000041");
  assert.ok(contextReads >= 2, String(contextReads));
  assert.ok(!JSON.stringify(turn.value).includes("Never processed."));
  const waits = timers.of("assignedTurns");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 1000, String(waits));
});

test("P7a-12 a partial outage, the event read succeeds and a later contact fails every time, or every heartbeat fails: the waits grow to the cap and the registrations stay at one", async () => {
  // OP-12 N1: event read 200, Room state 503 for ever.
  const runtime = roomRuntime([message(41, "x")]);
  const room = {registrations: 0, heartbeats: 0};
  Object.assign(runtime.client, {
    register: async () => { room.registrations += 1; return {sessionId: `session-${room.registrations}`, capabilities: []}; },
    heartbeat: async () => { room.heartbeats += 1; return {}; },
    connectorEnrollments: async () => [],
    roomState: async () => { throw new RoomAPIError(503, {}); },
  });
  await runtime.registerConnector();
  const controller = new AbortController();
  const timers = compressTimers();
  try {
    const turns = runtime.assignedTurns(controller.signal);
    const next = turns.next().catch(() => null);
    const deadline = Date.now() + 10_000;
    while (timers.of("assignedTurns").length < 7 && Date.now() < deadline) await pause(2);
    controller.abort();
    await next;
  } finally {
    timers.restore();
  }
  const waits = timers.of("assignedTurns").slice(0, 7);
  assert.equal(waits.length, 7);
  waits.forEach((wait, index) => assertOnSchedule(wait, index, waits));
  delete runtime.maintainPresence;
  runtime.publishPresence = async () => {};
  await runtime.maintainPresence();
  assert.deepEqual([room.registrations, room.heartbeats], [1, 1]);

  // Every heartbeat fails while the Room would accept a registration.
  const beats = roomRuntime([message(41, "x")]);
  delete beats.maintainPresence;
  beats.publishPresence = async () => {};
  const counts = {registrations: 0, heartbeats: 0};
  Object.assign(beats.client, {
    register: async () => { counts.registrations += 1; return {sessionId: "s", capabilities: []}; },
    heartbeat: async () => { counts.heartbeats += 1; throw new RoomAPIError(502, {}); },
    connectorEnrollments: async () => [],
  });
  await beats.registerConnector();
  beats.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 0.01};
  beats.heartbeatMinimumSeconds = 0.01;
  const heartbeatTimers = compressTimers();
  try {
    beats.runHeartbeat();
    const deadline = Date.now() + 10_000;
    while (heartbeatTimers.of("").length < 7 && Date.now() < deadline) await pause(2);
  } finally {
    await beats.close();
    heartbeatTimers.restore();
  }
  const retries = heartbeatTimers.of("").slice(0, 7);
  assert.equal(retries.length, 7, String(retries));
  retries.forEach((wait, index) => assertOnSchedule(wait, index, retries));
  assert.equal(counts.registrations, 1);
});

test("P7a-13 a transient failure of the attempt settle and of the acknowledgement after a host run: retried on the schedule inside the connector, the connection stays, the source is acknowledged when the Room answers", async () => {
  const runtime = roomRuntime([message(41, "x")]);
  const event = message(41, "x");
  let settles = 0;
  let acks = 0;
  runtime.client.completeDiscussionAttempt = async () => {
    settles += 1;
    if (settles <= 2) throw new RoomAPIError(502, {});
    return {};
  };
  runtime.client.acknowledge = async (_state, seq) => {
    acks += 1;
    if (acks === 1) throw new clientModule.RoomResponseError("edge page", {status: 503});
    if (acks === 2) throw Object.assign(new TypeError("fetch failed"), {cause: {code: "ECONNRESET"}});
    return {acknowledgedSeq: seq};
  };
  const attempt = {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: leaseIn(60_000)}};
  const timers = compressTimers();
  try {
    await runtime.settleDiscussionAttempt(attempt, "pass");
    runtime.pendingEvent = event;
    await runtime.recordSkipped(event.id, "model_no_visible_reply");
    await runtime.ack(event.id);
  } finally {
    timers.restore();
  }
  assert.equal(attempt.settled, true);
  assert.equal(settles, 3);
  assert.equal(acks, 3);
  assert.equal(runtime.state.cursor, 41);
  const waits = timers.of("retryContact");
  assert.equal(waits.length, 4, String(waits));
  assert.ok(waits[0] <= 1000 && waits[2] <= 1000, String(waits));
});

test("P7a-14 the status tells the truth: inactive only while muted and otherwise up, stopped and reconnecting win, a revoked credential shows stopped with credential_revoked, connected after an unmute or a new runtime", async () => {
  const directory = await mkdtemp(join(home, "status-"));
  const path = join(directory, "status.json");
  const status = new statusModule.LocalStatus(path, {version: "test", hostLabel: "h"});
  const read = async () => JSON.parse(await readFile(path, "utf8")).rooms["room-1"];
  const seen = [];
  const note = async () => { const entry = await read(); seen.push([entry.connection, entry.lastErrorCode]); };
  status.room("room-1", "member-1", {connected: true, registered: true}); await note();
  status.room("room-1", "", {connection: "inactive", inactive: true, errorCode: "connector_not_active"}); await note();
  status.room("room-1", "", {connected: true}); await note(); // a heartbeat while muted
  status.room("room-1", "", {connection: "reconnecting", errorCode: "network"}); await note();
  status.room("room-1", "", {connected: true}); await note(); // up again, still muted
  status.room("room-1", "", {errorCode: "credential_revoked"});
  status.room("room-1", "", {connection: "stopped"}); await note();
  status.room("room-1", "", {connected: true, registered: true}); await note(); // a new runtime registers
  status.room("room-1", "", {connection: "inactive", inactive: true, errorCode: "connector_not_active"});
  status.room("room-1", "", {inactive: false, connection: "connected", errorCode: ""}); await note(); // unmuted
  assert.deepEqual(seen, [
    ["connected", ""], ["inactive", "connector_not_active"], ["inactive", "connector_not_active"],
    ["reconnecting", "network"], ["inactive", "network"], ["stopped", "credential_revoked"],
    ["connected", "credential_revoked"], ["connected", ""],
  ]);
});

test("P7a-15 a failed heartbeat is retried on the schedule, not at the heartbeat interval, and its step returns to the first after a successful heartbeat", async () => {
  const runtime = roomRuntime([message(41, "x")]);
  delete runtime.maintainPresence;
  runtime.publishPresence = async () => {};
  const script = [false, false, true, false, true];
  let beats = 0;
  Object.assign(runtime.client, {
    heartbeat: async () => {
      beats += 1;
      if (script[beats - 1] === false) throw new RoomAPIError(503, {});
      return {};
    },
    connectorEnrollments: async () => [],
  });
  runtime.connectorSession = {sessionId: "s", heartbeatIntervalSeconds: 60};
  const timers = compressTimers();
  try {
    runtime.runHeartbeat();
    const deadline = Date.now() + 5000;
    while (beats < script.length + 1 && Date.now() < deadline) await pause(2);
  } finally {
    await runtime.close();
    timers.restore();
  }
  const waits = timers.of("").slice(0, 6);
  const interval = 60 * 800;
  // interval, fail -> step 0, fail -> step 1, success -> interval, fail -> step 0 again, success -> interval
  assert.equal(waits[0], interval, String(waits));
  assertOnSchedule(waits[1], 0, waits);
  assertOnSchedule(waits[2], 1, waits);
  assert.equal(waits[3], interval, String(waits));
  assertOnSchedule(waits[4], 0, waits);
  assert.equal(waits[5], interval, String(waits));
});

test("P7a-16 the attempt renewal and the re-claim before a post retry on the schedule capped at 5 s at the call", async () => {
  // The renewal: six transient failures with a long lease.
  const runtime = roomRuntime([message(41, "x")]);
  delete runtime.startAttemptLease;
  let claims = 0;
  runtime.client.claimDiscussionAttempt = async () => {
    claims += 1;
    if (claims <= 6) throw new RoomAPIError(503, {});
    return {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: leaseIn(600_000)}};
  };
  const attempt = () => ({cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie", leaseExpiresAt: leaseIn(600_000)}});
  const timers = compressTimers();
  try {
    runtime.startAttemptLease({id: "message000041", seq: 41}, attempt());
    const deadline = Date.now() + 5000;
    while (claims < 7 && Date.now() < deadline) await pause(1);
  } finally {
    await runtime.stopAttemptLease("message000041");
    timers.restore();
  }
  const renewals = timers.of("renewAttemptLease").slice(0, 6);
  assert.equal(renewals.length, 6, String(renewals));
  renewals.forEach((wait, index) => assertOnSchedule(wait, index, renewals, 5000));

  // The re-claim before a post: the same schedule and cap.
  const reclaim = roomRuntime([message(41, "x")]);
  let reclaims = 0;
  reclaim.client.claimDiscussionAttempt = async () => {
    reclaims += 1;
    if (reclaims <= 6) throw new RoomAPIError(503, {});
    return attempt();
  };
  const held = attempt();
  reclaim.attemptLeases.set("message000041", {sourceEvent: {id: "message000041", seq: 41}, cycleAttempt: held, timer: null,
    inflight: null, stopped: false, superseded: false, reason: ""});
  const intent = {identity: {sourceEventId: "message000041", cycle: {cycleId: "cycle-1", attemptId: "attempt-1"}}};
  const timers2 = compressTimers();
  let reason;
  try {
    reason = await reclaim.attemptAuthorityLost(intent);
  } finally {
    timers2.restore();
  }
  assert.equal(reason, "");
  const waits = timers2.of("attemptAuthorityLost").slice(0, 6);
  assert.equal(waits.length, 6, String(waits));
  waits.forEach((wait, index) => assertOnSchedule(wait, index, waits, 5000));
});

test("the scan loop's schedule returns to its first step after a full pass, never after an accepted registration", async () => {
  const runtime = roomRuntime([message(41, "x")]);
  const script = [false, false, false, true, false, false];
  let reads = 0;
  let registrations = 0;
  const roomState = runtime.client.roomState;
  runtime.client.register = async () => { registrations += 1; return {sessionId: `s-${registrations}`, capabilities: []}; };
  runtime.client.roomState = async (...args) => {
    reads += 1;
    if (script[reads - 1] === false) {
      // A registration accepted meanwhile (another loop) resets nothing here.
      await runtime.registerConnector();
      throw new RoomAPIError(503, {});
    }
    return roomState(...args);
  };
  const controller = new AbortController();
  const timers = compressTimers();
  try {
    const turns = runtime.assignedTurns(controller.signal);
    const first = await turns.next(); // three failures, then a full pass with the turn
    assert.equal(first.done, false);
    const second = turns.next().catch(() => null);
    const deadline = Date.now() + 5000;
    while (timers.of("assignedTurns").length < 5 && Date.now() < deadline) await pause(2);
    controller.abort();
    await second;
  } finally {
    timers.restore();
  }
  const waits = timers.of("assignedTurns").slice(0, 5);
  assert.equal(waits.length, 5, String(waits));
  [0, 1, 2].forEach((step) => assertOnSchedule(waits[step], step, waits));
  // After the full pass: the first step again, then the second.
  assertOnSchedule(waits[3], 0, waits);
  assertOnSchedule(waits[4], 1, waits);
  assert.ok(registrations >= 5);
});
