// Parity P8 "Idle cadence": contract section P8 (conformance parityP8Cases;
// Hermes implements the same names).
//
// An idle installation with several Rooms in two join lineages runs for
// simulated minutes on a fake clock: setTimeout, clearTimeout and Date follow
// it, and no test waits in real time beyond letting file I/O finish. The Room
// is a fetch double that records each call with its simulated time. The
// modules are read as namespaces so that this file also runs against an older
// release. No test uses a real credential or talks to a live Room.
import assert from "node:assert/strict";
import test, {after, afterEach} from "node:test";
import {registerHooks, createRequire, syncBuiltinESMExports} from "node:module";
import {existsSync, readFileSync} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/reply-payload": "export const isReplyPayloadNonTerminalToolErrorWarning = () => false;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

// File I/O of the runtime finishes within a few real milliseconds on tmpfs.
const scratchRoot = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
const home = await mkdtemp(join(scratchRoot, "openclaw-room-p8-"));
process.env.HOME = home;
after(() => rm(home, {recursive: true, force: true}));
const runtimeModule = await import("../src/runtime.js");
const clientModule = await import("../src/room-client.js");
const statusModule = await import("../src/local-status.js");
const stateModule = await import("../src/state.js");
const recoveryModule = await import("../src/recovery.js");
const discoveryModule = await import("../src/account-discovery.js");
const conformance = JSON.parse(readFileSync(new URL("../conformance.json", import.meta.url), "utf8"));
const {OpenClawRoomRuntime} = runtimeModule;
const fsModule = createRequire(import.meta.url)("node:fs");

const BASE = "https://room.example/api";
const LEASE = "2099-01-01T00:00:00Z";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const real = {setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate, Date: globalThis.Date};

class VirtualClock {
  constructor(start = 1_790_000_000_000) {
    this.start = start;
    this.now = start;
    this.timers = [];
    this.order = 0;
    this.activity = 0;
  }

  install() {
    const clock = this;
    globalThis.setTimeout = (callback, milliseconds, ...args) => clock.schedule(Number(milliseconds) || 0, () => callback(...args));
    globalThis.clearTimeout = (handle) => {
      if (handle && typeof handle === "object" && "cancelled" in handle) handle.cancelled = true;
      else real.clearTimeout(handle);
    };
    class VirtualDate extends real.Date {
      constructor(...args) {
        if (args.length === 0) super(clock.now);
        else super(...args);
      }

      static now() {
        return clock.now;
      }
    }
    globalThis.Date = VirtualDate;
  }

  uninstall() {
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
    globalThis.Date = real.Date;
  }

  at(milliseconds) {
    return this.start + milliseconds;
  }

  schedule(milliseconds, callback) {
    this.activity += 1;
    const entry = {when: this.now + Math.max(0, milliseconds), order: this.order++, callback, cancelled: false,
      unref() { return this; }, ref() { return this; }, hasRef() { return false; }, refresh() { return this; }};
    this.timers.push(entry);
    return entry;
  }

  cancelFor(entry) {
    return () => { entry.cancelled = true; };
  }

  // Lets every task run until it waits on the clock (or on a few ms of I/O).
  async settle() {
    let quiet = 0;
    let seen = -1;
    for (let round = 0; round < 200 && quiet < 6; round += 1) {
      for (let index = 0; index < 30; index += 1) await new Promise((resolve) => real.setImmediate(resolve));
      await new Promise((resolve) => real.setTimeout(resolve, 1));
      quiet = this.activity === seen ? quiet + 1 : 0;
      seen = this.activity;
    }
  }

  async runUntil(milliseconds) {
    const end = this.at(milliseconds);
    for (;;) {
      await this.settle();
      this.timers = this.timers.filter((entry) => !entry.cancelled);
      let next = null;
      for (const entry of this.timers) {
        if (!next || entry.when < next.when || (entry.when === next.when && entry.order < next.order)) next = entry;
      }
      if (!next || next.when > end) {
        this.now = Math.max(this.now, end);
        await this.settle();
        return;
      }
      this.timers.splice(this.timers.indexOf(next), 1);
      this.now = Math.max(this.now, next.when);
      next.callback();
    }
  }
}

let installed = null;
afterEach(() => {
  installed?.uninstall();
  installed = null;
});

function clockFor() {
  const clock = new VirtualClock();
  clock.install();
  installed = clock;
  return clock;
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json"}});

// The Room as idle connectors see it; every call recorded with its time and
// the Room of the credential that made it.
function idleRoom(clock, {interval = 15} = {}) {
  const room = {calls: [], heartbeatAnswers: new Map(), pending: new Map(), muted: new Set(), claims: new Map(), sessions: 0, interval};
  room.fetch = async (url, init = {}) => {
    clock.activity += 1;
    const {pathname, searchParams} = new URL(url);
    const path = pathname.replace(/^\/api/, "");
    const who = String(init.headers?.Authorization ?? "").replace(/^Bearer credential-/, "");
    const method = init.method ?? "GET";
    const record = (route) => room.calls.push({at: clock.now - clock.start, route, room: who});
    if (method === "POST" && /\/connector\/sessions$/.test(path)) {
      record("register");
      room.sessions += 1;
      return json({sessionId: `session-${room.sessions}`, heartbeatIntervalSeconds: room.interval, leaseExpiresAt: LEASE, capabilities: []});
    }
    if (/\/heartbeat$/.test(path)) {
      record("heartbeat");
      const script = room.heartbeatAnswers.get(who);
      if (script?.length) {
        const [value, status = 200] = script.shift();
        return json(value, status);
      }
      return json({leaseExpiresAt: LEASE});
    }
    if (path === "/connector/enrollments") {
      record("enrollments");
      if (room.muted.has(who)) return json({code: "connector_not_active", message: "an active connector session is required", retryable: true}, 401);
      const key = searchParams.get("clientInstanceId");
      const pending = room.pending.get(key) ?? [];
      room.pending.set(key, []);
      return json(pending);
    }
    if (/^\/connector\/enrollments\/[^/]+\/claim$/.test(path)) {
      record("claim");
      return json(room.claims.get(decodeURIComponent(path.split("/")[3])));
    }
    if (/\/state$/.test(path)) {
      record("state");
      return json({roster: [{membershipId: `member-${who}`, status: room.muted.has(who) ? "muted" : "active"}],
        activeEpoch: {id: "epoch-1", startsAtSeq: 1}});
    }
    if (/\/activity$/.test(path)) {
      const body = JSON.parse(init.body);
      record(`activity:${body.kind}`);
      return json({acceptedStreamSeq: body.streamSeq}, 202);
    }
    if (/\/events$/.test(path)) {
      record("events");
      const wait = (Number(searchParams.get("waitSeconds")) || 0) * SECOND;
      await new Promise((resolve, reject) => {
        const entry = clock.schedule(wait, resolve);
        init.signal?.addEventListener("abort", () => { entry.cancelled = true; reject(init.signal.reason ?? new Error("aborted")); }, {once: true});
      });
      return json({activeEpochId: "epoch-1", activeEpochStartsAtSeq: 1, events: []});
    }
    if (/\/credential-renewal-intent$/.test(path)) {
      record("renewal");
      return json({request: null});
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  room.times = (route, who, {since = -Infinity, until = Infinity} = {}) => room.calls
    .filter((call) => call.route === route && (who === undefined || call.room === who) && call.at >= since && call.at < until)
    .map((call) => call.at);
  room.rooms = (route, {since = -Infinity, until = Infinity} = {}) => room.calls
    .filter((call) => call.route === route && call.at >= since && call.at < until).map((call) => call.room);
  return room;
}

async function accountState(directory, id, lineage, extra = {}) {
  const stateFile = join(directory, `${id}.json`);
  await stateModule.saveState(stateFile, {
    version: 1, baseUrl: BASE, roomId: id, membershipId: `member-${id}`, credential: `credential-${id}`,
    clientInstanceId: lineage, cursor: 0, stateRevision: 2, receiveLedger: {}, deliveredCursor: 0,
    appliedRecoveryClosures: {}, epochSessionRoutingInitialized: true, legacySessionEpochId: "",
    credentialExpiresAt: LEASE, ...extra,
  });
  return stateFile;
}

// Idle runtimes of two lineages (a1, a2, a3 and b1, b2), each running its event loop.
async function idleInstallation(clock, room, {status, accounts = [["a1", "lineage-A"], ["a2", "lineage-A"], ["a3", "lineage-A"], ["b1", "lineage-B"], ["b2", "lineage-B"]], activations = []} = {}) {
  runtimeModule.resetEnrollmentLineages?.();
  const directory = await mkdtemp(join(home, "accounts-"));
  const runtimes = new Map();
  const loops = new Map();
  const controller = new AbortController();
  for (const [id, lineage] of accounts) {
    const stateFile = await accountState(directory, id, lineage);
    const runtime = new OpenClawRoomRuntime({accountId: id, stateFile, baseUrl: BASE}, {
      fetchImpl: room.fetch, status,
      activateEnrollment: async (activation) => { activations.push({...activation, at: clock.now - clock.start}); },
    });
    runtimes.set(id, runtime);
    loops.set(id, runtime.assignedTurns(controller.signal).next().then(() => ({ended: "done"}), (error) => ({ended: error})));
  }
  // Every runtime started (registered, heartbeat loop on, first long poll
  // waiting) before simulated time moves; its file I/O takes real time.
  const deadline = real.Date.now() + 10_000;
  while (real.Date.now() < deadline && !([...runtimes.values()].every((runtime) => runtime.heartbeatTask)
    && room.calls.filter((call) => call.route === "events").length >= runtimes.size)) await clock.settle();
  assert.ok([...runtimes.values()].every((runtime) => runtime.heartbeatTask), "every runtime started");
  return {
    runtimes, loops, directory,
    stop: async () => {
      controller.abort();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
      clock.uninstall();
      await Promise.race([Promise.all(loops.values()), new Promise((resolve) => real.setTimeout(resolve, 200))]);
    },
  };
}

const gaps = (times) => times.slice(1).map((time, index) => time - times[index]);

test("conformance P8 case names resolve to tests in this suite; constants pinned", async () => {
  const cases = Object.entries(conformance.parityP8Cases ?? {});
  assert.equal(cases.length, 7);
  const source = readFileSync(new URL(import.meta.url), "utf8");
  cases.forEach(([id, name], index) => {
    assert.equal(id, `P8-${String(index + 1).padStart(2, "0")}`);
    assert.ok(name.startsWith(`${id} `), id);
    assert.ok(source.includes(`test(${JSON.stringify(name)}`), name);
  });
  assert.equal(conformance.parityP8Contract, "docs/delivery-lifecycle-contract-v1.md#p8--idle-cadence-2026-10-08");
  assert.deepEqual(conformance.parityP8Constants, {
    heartbeatMaximumSeconds: runtimeModule.HEARTBEAT_MAXIMUM_SECONDS,
    enrollmentListingIntervalSeconds: runtimeModule.ENROLLMENT_LISTING_INTERVAL_MS / 1000,
    enrollmentPollAfterBoundsSeconds: [runtimeModule.ENROLLMENT_POLL_AFTER_MIN_SECONDS, runtimeModule.ENROLLMENT_POLL_AFTER_MAX_SECONDS],
    renewalIntentHealthySeconds: runtimeModule.RENEWAL_INTENT_HEALTHY_MS / 1000,
    renewalExpiryHorizonSeconds: runtimeModule.RENEWAL_EXPIRY_HORIZON_MS / 1000,
    idleActivityFrameSeconds: runtimeModule.IDLE_ACTIVITY_FRAME_MS / 1000,
    connectedAtWriteSeconds: statusModule.CONNECTED_AT_WRITE_MS / 1000,
  });
});

test("P8-01 an idle session sends exactly one heartbeat per interval, the interval of the latest session answer, at most 60 s", async () => {
  {
    const clock = clockFor();
    const room = idleRoom(clock);
    const installation = await idleInstallation(clock, room);
    await clock.runUntil(11 * MINUTE);
    await installation.stop();
    for (const id of ["a1", "a2", "a3", "b1", "b2"]) {
      const beats = room.times("heartbeat", id, {since: MINUTE, until: 11 * MINUTE});
      // 15 s from the session answer, sent at 0.8 of it: 12 s; none after a
      // long-poll return (every 20 s).
      assert.equal(beats.length, 50, `${id}: ${beats.slice(0, 8)}`);
      assert.deepEqual([...new Set(gaps(beats))], [12 * SECOND], id);
    }
  }
  // An instructed 120 s is used as 60 s; a later answer's 20 s takes effect.
  const clock = clockFor();
  const room = idleRoom(clock, {interval: 120});
  room.heartbeatAnswers.set("c1", [[{leaseExpiresAt: LEASE}], [{leaseExpiresAt: LEASE}], [{leaseExpiresAt: LEASE, heartbeatIntervalSeconds: 20}]]);
  const installation = await idleInstallation(clock, room, {accounts: [["c1", "lineage-C"]]});
  await clock.runUntil(6 * MINUTE);
  await installation.stop();
  const beats = [room.times("register", "c1")[0], ...room.times("heartbeat", "c1")];
  const steps = gaps(beats);
  assert.deepEqual(steps.slice(0, 3), [48 * SECOND, 48 * SECOND, 48 * SECOND], String(steps));
  assert.deepEqual([...new Set(steps.slice(3, 8))], [16 * SECOND], String(steps));
  assert.ok(Math.max(...steps) <= 60 * SECOND);
});

test("P8-02 N Rooms of one join lineage make one listing per interval; two lineages in one process make two", async () => {
  {
    const clock = clockFor();
    const room = idleRoom(clock);
    const installation = await idleInstallation(clock, room);
    await clock.runUntil(11 * MINUTE);
    await installation.stop();
    const window = {since: MINUTE + 12 * SECOND, until: 11 * MINUTE + 12 * SECOND};
    const listed = room.rooms("enrollments", window);
    assert.equal(listed.filter((id) => id.startsWith("a")).length, 10, String(listed));
    assert.equal(listed.filter((id) => id.startsWith("b")).length, 10, String(listed));
    for (const lineage of ["a", "b"]) {
      const times = room.calls.filter((call) => call.route === "enrollments" && call.room.startsWith(lineage)
        && call.at >= window.since && call.at < window.until).map((call) => call.at);
      assert.ok(gaps(times).every((gap) => gap >= MINUTE), String(times));
    }
    // The listing comes round every account of the lineage.
    assert.deepEqual(new Set(listed.filter((id) => id.startsWith("a"))), new Set(["a1", "a2", "a3"]));
    assert.deepEqual(new Set(listed.filter((id) => id.startsWith("b"))), new Set(["b1", "b2"]));
    // After the start: at the first heartbeat (or long-poll return), with that account.
    for (const id of ["a1", "a2", "a3", "b1", "b2"]) {
      assert.equal(room.times("enrollments", id)[0], room.times("heartbeat", id)[0], id);
    }
  }
  // After a registration again (a heartbeat 404), at once, with that account.
  const clock = clockFor();
  const room = idleRoom(clock);
  room.heartbeatAnswers.set("a2", [...Array(20).fill([{leaseExpiresAt: LEASE}]), [{code: "not_found", message: "room or object not found"}, 404]]);
  const installation = await idleInstallation(clock, room);
  await clock.runUntil(8 * MINUTE);
  await installation.stop();
  const again = room.times("register", "a2")[1];
  assert.ok(again !== undefined);
  assert.ok(room.times("enrollments", "a2").includes(again), `${again}: ${room.times("enrollments", "a2")}`);
  // The listing answer as an object: pollAfterSeconds is the interval, bounded.
  assert.deepEqual(runtimeModule.enrollmentListing?.({enrollments: [], rooms: [], pollAfterSeconds: 120}), {enrollments: [], pollAfterMs: 120_000});
  assert.deepEqual(runtimeModule.enrollmentListing?.({enrollments: [], pollAfterSeconds: 1}), {enrollments: [], pollAfterMs: 15_000});
  assert.deepEqual(runtimeModule.enrollmentListing?.({enrollments: [], pollAfterSeconds: 9999}), {enrollments: [], pollAfterMs: 300_000});
  assert.deepEqual(runtimeModule.enrollmentListing?.([{invitationId: "i"}]), {enrollments: [{invitationId: "i"}], pollAfterMs: null});
  for (const malformed of [{rooms: []}, {enrollments: {}}, null, "x"]) assert.equal(runtimeModule.enrollmentListing?.(malformed), null);
});

test("P8-03 a newly approved Room is claimed at the next listing; a mute is seen at the listing made with that Room's credential; revoked and lost sessions are seen at the heartbeat as before", async () => {
  const clock = clockFor();
  const room = idleRoom(clock);
  const directory = await mkdtemp(join(home, "status-p8-03-"));
  const status = new statusModule.LocalStatus(join(directory, "status.json"), {version: "test", hostLabel: "h",
    clock: () => clock.now, schedule: (milliseconds, callback) => clock.cancelFor(clock.schedule(milliseconds, callback))});
  const activations = [];
  const installation = await idleInstallation(clock, room, {status, activations});
  await clock.runUntil(200 * SECOND);
  // The owner approves a new Room for lineage A, and mutes a2.
  room.pending.set("lineage-A", [{invitationId: "invite-new"}]);
  room.claims.set("invite-new", {roomId: "a4", membershipId: "member-a4", credential: "credential-a4", headSeq: 0});
  room.muted.add("a2");
  // A lost session (b1) and a revoked credential (b2) at their next heartbeat.
  room.heartbeatAnswers.set("b1", [[{code: "not_found", message: "room or object not found"}, 404]]);
  room.heartbeatAnswers.set("b2", [[{code: "credential_revoked", message: "revoked"}, 401]]);
  await clock.runUntil(600 * SECOND);
  const written = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
  const b2Loop = await Promise.race([installation.loops.get("b2"), new Promise((resolve) => real.setTimeout(() => resolve({ended: "running"}), 50))]);
  await installation.stop();
  const lineageA = room.calls.filter((call) => call.route === "enrollments" && call.room[0] === "a");
  const claim = room.times("claim", undefined, {since: 200 * SECOND})[0];
  const firstAfter = lineageA.find((call) => call.at >= 200 * SECOND);
  // Claimed at the lineage's next listing, within one interval, and that
  // listing is the lineage's one per interval.
  assert.equal(claim, firstAfter.at);
  assert.ok(claim - 200 * SECOND <= MINUTE);
  const before = Math.max(...lineageA.filter((call) => call.at < claim).map((call) => call.at));
  assert.ok(claim - before >= MINUTE, `${before} -> ${claim}`);
  assert.deepEqual(activations.map((item) => [item.accountId, item.at]), [["member-a4", claim]]);
  // The mute is seen at the listing made with a2's credential (its turn of the
  // lineage), and the other accounts keep the lineage's listing.
  const mutedListing = room.times("enrollments", "a2", {since: 200 * SECOND})[0];
  assert.ok(mutedListing - 200 * SECOND <= 4 * MINUTE, String(mutedListing));
  assert.equal(written.rooms.a2.connection, "inactive");
  assert.deepEqual(room.times("enrollments", "a2", {since: mutedListing + 1}), []);
  assert.ok(room.times("enrollments", "a1", {since: mutedListing + 1}).length + room.times("enrollments", "a3", {since: mutedListing + 1}).length > 0);
  // The lost session registers again at its heartbeat, at once.
  const lostAt = room.times("heartbeat", "b1", {since: 200 * SECOND})[0];
  assert.ok(lostAt - 200 * SECOND <= 12 * SECOND);
  assert.equal(room.times("register", "b1", {since: lostAt})[0], lostAt);
  // The revoked credential ends b2's loops at its heartbeat.
  const revokedAt = room.times("heartbeat", "b2", {since: 200 * SECOND})[0];
  assert.ok(revokedAt - 200 * SECOND <= 12 * SECOND);
  assert.deepEqual(room.times("heartbeat", "b2", {since: revokedAt + 1}), []);
  assert.equal(b2Loop.ended?.code, "credential_revoked");
});

test("P8-04 a healthy binding asks for the renewal intent once per 300 s; with a rotation journal, an expired credential or an expiry within 24 h it asks at the present cadence", async () => {
  const clock = clockFor();
  const directory = await mkdtemp(join(home, "renewal-"));
  const asks = new Map();
  const fetchImpl = async (url, init) => {
    const who = String(init.headers?.Authorization ?? "").replace(/^Bearer credential-/, "");
    if (url.includes("/credential-renewal-intent")) {
      asks.set(who, [...(asks.get(who) ?? []), clock.now - clock.start]);
      return json({request: null});
    }
    if (url.endsWith("/connector/sessions")) return json({code: "credential_expired", message: "expired"}, 401);
    throw new Error(`Unexpected request: ${url}`);
  };
  const soon = new Date(clock.now + 3_600_000).toISOString();
  const kinds = {healthy: {}, "no-expiry": {credentialExpiresAt: undefined}, unparsable: {credentialExpiresAt: "next spring"}, soon: {credentialExpiresAt: soon}};
  const passes = [];
  for (const [id, extra] of Object.entries(kinds)) {
    const stateFile = await accountState(directory, id, "lineage-R", extra);
    const runtime = new OpenClawRoomRuntime({accountId: id, stateFile, baseUrl: BASE}, {fetchImpl});
    runtime.state = await stateModule.loadState(stateFile);
    runtime.client = new clientModule.RoomClient({baseUrl: BASE, credential: runtime.state.credential, fetchImpl});
    passes.push(runtime);
  }
  // A rotation journal: every pass goes on to the renewal (here it stops on the journal's checks).
  const rotationFile = await accountState(directory, "rotation", "lineage-R");
  const rotation = new OpenClawRoomRuntime({accountId: "rotation", stateFile: rotationFile, baseUrl: BASE}, {fetchImpl});
  rotation.state = {...(await stateModule.loadState(rotationFile)), credentialRotation: {version: 1, phase: "requested"}};
  rotation.client = new clientModule.RoomClient({baseUrl: BASE, credential: rotation.state.credential, fetchImpl});
  const rotationAttempts = [];
  // An expired credential: the start waits for the renewal (the existing 30 s).
  const expiredFile = await accountState(directory, "expired", "lineage-R");
  const expired = new OpenClawRoomRuntime({accountId: "expired", stateFile: expiredFile, baseUrl: BASE}, {
    fetchImpl, waitForRenewal: true,
    renewalWait: (milliseconds, signal) => new Promise((resolve, reject) => {
      const entry = clock.schedule(milliseconds, resolve);
      signal?.addEventListener("abort", () => { entry.cancelled = true; reject(signal.reason); }, {once: true});
    }),
  });
  const expiredStart = expired.initialize().catch(() => {});
  // The event loop's pass every 20 s (an idle long poll).
  for (let at = 0; at <= 660 * SECOND; at += 20 * SECOND) {
    await clock.runUntil(at);
    for (const runtime of passes) await runtime.renewAccess();
    await rotation.renewAccess().then(() => rotationAttempts.push("no"), () => rotationAttempts.push(clock.now - clock.start));
  }
  await expired.close();
  clock.uninstall();
  await Promise.race([expiredStart, new Promise((resolve) => real.setTimeout(resolve, 200))]);
  for (const id of ["healthy", "no-expiry", "unparsable"]) {
    // Healthy (an absent or unparsable expiry too): at most once per 300 s.
    assert.deepEqual(asks.get(id), [0, 300 * SECOND, 600 * SECOND], id);
  }
  // The present cadence: 30 s, checked at each 20 s pass (every 40 s).
  assert.equal(asks.get("soon").length, 17, String(asks.get("soon")));
  assert.ok(gaps(asks.get("soon")).every((gap) => gap === 40 * SECOND));
  assert.ok(asks.get("expired").length >= 21, String(asks.get("expired")));
  assert.ok(gaps(asks.get("expired")).every((gap) => gap <= 30 * SECOND));
  assert.equal(rotationAttempts.filter((item) => item !== "no").length, 34);
});

test("P8-05 an idle session posts an activity frame no more often than half the announced freshness, and the registration and turn frames are unchanged", async () => {
  {
    const clock = clockFor();
    const room = idleRoom(clock);
    const installation = await idleInstallation(clock, room);
    await clock.runUntil(11 * MINUTE);
    await installation.stop();
    const half = runtimeModule.IDLE_ACTIVITY_FRAME_MS ?? 20_000;
    assert.equal(half, 20 * SECOND);
    assert.equal(runtimeModule.idleActivityFrameIntervalMs?.(), 20 * SECOND);
    for (const id of ["a1", "a2", "a3", "b1", "b2"]) {
      const frames = room.times("activity:heartbeat", id);
      // The registration frame, with the registration.
      assert.equal(frames[0], room.times("register", id)[0]);
      const steps = gaps(frames);
      assert.ok(steps.length > 0);
      // Never more often than the half (20 s), never further apart than the
      // half plus one heartbeat interval (15 s).
      assert.ok(Math.min(...steps) >= half, `${id}: ${steps}`);
      assert.ok(Math.max(...steps) <= half + 15 * SECOND, `${id}: ${steps}`);
    }
  }
  // Turn frames are posted at once, whatever the idle schedule.
  const clock = clockFor();
  const room = idleRoom(clock);
  const installation = await idleInstallation(clock, room, {accounts: [["t1", "lineage-T"]]});
  await clock.runUntil(5 * SECOND);
  const runtime = installation.runtimes.get("t1");
  await runtime.publishActivityFrame({kind: "context_acknowledged", sourceEventId: "evt-1", sourceSeq: 7});
  await runtime.publishActivityFrame({kind: "lifecycle", status: "preparing_response", sourceEventId: "evt-1", sourceSeq: 7});
  await runtime.publishActivityFrame({kind: "terminal", status: "completed", sourceEventId: "evt-1", sourceSeq: 7});
  await installation.stop();
  assert.deepEqual(room.calls.filter((call) => call.route.startsWith("activity:") && call.at === 5 * SECOND).map((call) => call.route),
    ["activity:context_acknowledged", "activity:lifecycle", "activity:terminal"]);
});

test("P8-06 status.json is not rewritten for heartbeats alone within 60 s; any other change is written at once", async () => {
  const clock = clockFor();
  const room = idleRoom(clock);
  const directory = await mkdtemp(join(home, "status-p8-06-"));
  const path = join(directory, "status.json");
  const status = new statusModule.LocalStatus(path, {version: "test", hostLabel: "h",
    clock: () => clock.now, schedule: (milliseconds, callback) => clock.cancelFor(clock.schedule(milliseconds, callback))});
  const writes = [];
  const write = status.write.bind(status);
  status.write = () => { writes.push(clock.now - clock.start); return write(); };
  const installation = await idleInstallation(clock, room, {status});
  await clock.runUntil(10 * MINUTE);
  const window = writes.filter((at) => at >= MINUTE && at < 10 * MINUTE);
  // Heartbeats alone (5 Rooms, 5 a minute each): at most one write a minute.
  assert.ok(window.length >= 8 && window.length <= 9, String(window));
  assert.ok(gaps(window).every((gap) => gap === MINUTE), String(window)); // updatedAt at most 60 s old
  // Every other change at once: a Room's connection and its error code.
  const count = writes.length;
  status.room("a1", "member-a1", {connection: "reconnecting", errorCode: "network"});
  assert.equal(writes.length, count + 1);
  let entry = JSON.parse(readFileSync(path, "utf8")).rooms.a1;
  assert.deepEqual([entry.connection, entry.lastErrorCode], ["reconnecting", "network"]);
  status.room("a1", "member-a1", {connection: "connected", errorCode: ""});
  entry = JSON.parse(readFileSync(path, "utf8")).rooms.a1;
  assert.deepEqual([entry.connection, entry.lastErrorCode], ["connected", ""]);
  await clock.runUntil(11 * MINUTE);
  // A clean stop writes the newest values.
  status.setLoaded(false);
  const stopped = JSON.parse(readFileSync(path, "utf8"));
  const memory = status.snapshot();
  await installation.stop();
  assert.equal(stopped.pluginLoaded, false);
  assert.deepEqual(Object.fromEntries(Object.entries(stopped.rooms).map(([id, item]) => [id, item.lastConnectedAt])),
    Object.fromEntries(Object.entries(memory.rooms).map(([id, item]) => [id, item.lastConnectedAt])));
});

test("P8-07 the state file is neither parsed nor written while unchanged across heartbeats; a change made by another process (CLI, recovery tool) is picked up at the next tick", async () => {
  const reads = [];
  const original = fsModule.readFileSync;
  let clock = null;
  fsModule.readFileSync = function readFileSync(path, ...args) {
    reads.push({path: String(path), at: clock ? clock.now - clock.start : -1});
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    // The recovery journal, read in the event loop.
    clock = clockFor();
    const room = idleRoom(clock);
    const installation = await idleInstallation(clock, room, {accounts: [["j1", "lineage-J"]]});
    const stateFile = installation.runtimes.get("j1").account.stateFile;
    const journal = recoveryModule.journalPath(stateFile);
    fsModule.writeFileSync(journal, "{\"not\": \"a record\"}\n", {mode: 0o600});
    await clock.runUntil(10 * MINUTE);
    const idle = reads.filter((item) => item.path === journal && item.at >= MINUTE);
    // The recovery tool appends a record.
    fsModule.appendFileSync(journal, "{\"still\": \"not a record\"}\n");
    const appended = clock.now - clock.start;
    await clock.runUntil(11 * MINUTE);
    const afterAppend = reads.filter((item) => item.path === journal && item.at >= appended);
    await installation.stop();
    clock = null;
    assert.deepEqual(idle, [], "nine minutes of event-loop passes: no read of an unchanged journal");
    assert.equal(afterAppend.length, 1);
    assert.ok(afterAppend[0].at - appended <= 20 * SECOND);

    // The account state files, read by the presence fallback's reconcile (every 10 s).
    const stateDirectory = await mkdtemp(join(home, "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDirectory;
    const accounts = join(stateDirectory, "synthetic-sociality-room", "accounts");
    fsModule.mkdirSync(accounts, {recursive: true, mode: 0o700});
    const files = [];
    for (const id of ["r1", "r2"]) files.push(await accountState(accounts, id, "lineage-F"));
    const reconcile = () => discoveryModule.resolvedRoomAccounts({channels: {"synthetic-sociality-room": {}}});
    const first = reconcile();
    assert.deepEqual(first.filter((account) => files.includes(account.stateFile)).map((account) => account.enabled), [true, true]);
    reads.length = 0;
    for (let index = 0; index < 30; index += 1) reconcile();
    const unchanged = reads.filter((item) => files.includes(item.path)).length;
    // The CLI (or a renewal) replaces r1's state: revoked.
    await stateModule.saveState(files[0], {...JSON.parse(original.call(fsModule, files[0], "utf8")), revoked: true});
    reads.length = 0;
    const changed = reconcile();
    const readAfterChange = reads.filter((item) => files.includes(item.path)).map((item) => item.path);
    delete process.env.OPENCLAW_STATE_DIR;
    assert.equal(unchanged, 0, "thirty reconciles of unchanged files: no read");
    assert.ok(readAfterChange.length >= 1 && readAfterChange.every((path) => path === files[0]), String(readAfterChange));
    assert.equal(changed.find((account) => account.stateFile === files[0])?.enabled, false);
  } finally {
    fsModule.readFileSync = original;
    syncBuiltinESMExports();
    delete process.env.OPENCLAW_STATE_DIR;
  }
});
