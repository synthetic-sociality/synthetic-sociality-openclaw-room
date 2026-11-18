// Contract P2c-3e (OpenClaw 0.2.89, 2026-11-17): one recovery budget per installation, so a bad network does not
// multiply into a request storm. Live fault (17 Nov, Paula deleg_550548f5): the Mac128 path to the Room dropped TLS;
// each binding recovered on its own schedule, 8-10 memberships per installation, and between 12:51 and 14:53Z one
// installation logged 357 heartbeat warnings and 210 re-registrations.
// The same four cases as the Hermes connector (conformance parityP2c3eCases). Fake Room and a fake clock only
// (node:test mock timers for setTimeout and Date); nothing leaves the process.
import assert from "node:assert/strict";
import test, {mock} from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setImmediate as turn} from "node:timers/promises";
import {LocalStatus} from "../src/local-status.js";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import * as runtimeModule from "../src/runtime.js";
import {saveState} from "../src/state.js";

const CASES = [
  "RRB-01 a persistent network failure across many memberships starts at most 6 registrations in any 60 seconds per installation",
  "RRB-02 a membership's recovery delay grows across consecutive failed registrations and heartbeats and resets only after an accepted heartbeat",
  "RRB-03 an HTTP 429 delays that membership at least by its Retry-After",
  "RRB-04 heartbeats of current sessions are never delayed by the budget, and a membership stopped by the Room does not use it",
  "RRB-05 a 429 on a heartbeat of a current session is retried after Retry-After and, while the lease holds, is not counted as a failure",
];
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const ROOM = "p2c3eroom000001";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const quiet = {info() {}, warn() {}, error() {}, debug() {}};
// The real clock, kept before the mock replaces the global: the fake clock waits 1 ms of it per step.
const realSetTimeout = globalThis.setTimeout;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}});

// One gateway installation: a status file shared by every account, one state file per membership, and a fake Room
// whose answer for each contact `answer(contact)` decides (a Response, or a thrown error for a lost connection).
// Every contact is logged with the fake clock's time.
async function installation(members, answer) {
  const directory = await mkdtemp(join(tmpdir(), "oc-p2c3e-"));
  const status = new LocalStatus(join(directory, "status.json"), {version: "0.2.89", hostLabel: "test"});
  const contacts = [];
  const byCredential = new Map();
  const accounts = [];
  for (const membershipId of members) {
    const stateFile = join(directory, "accounts", `${membershipId}.json`);
    const credential = `credential-${membershipId}`;
    byCredential.set(credential, membershipId);
    await saveState(stateFile, {version: 1, baseUrl: "https://room.example/api", roomId: ROOM, membershipId,
      clientInstanceId: `instance-${membershipId}`, credential, credentialExpiresAt: "2030-01-01T00:00:00Z",
      cursor: 0, terminalEvidence: {}, deliveryIntents: {}});
    accounts.push({accountId: membershipId, stateFile, enabled: true});
  }
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const membershipId = byCredential.get(init.headers.Authorization?.slice(7)) ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    let kind = "other";
    if (path.endsWith("/connector/sessions")) kind = "register";
    else if (path.endsWith("/heartbeat")) kind = "heartbeat";
    else if (path.endsWith("/credential-renewal-intent")) kind = "renewal";
    else if (path.endsWith("/activity")) kind = "activity";
    else if (path.endsWith("/connector/enrollments")) kind = "listing";
    else if (path.endsWith("/state")) kind = "state";
    const contact = {kind, membershipId, at: Date.now()};
    contacts.push(contact);
    const scripted = await answer(contact);
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    if (kind === "register") return json({sessionId: `session-${membershipId}-${contacts.length}`, heartbeatIntervalSeconds: 15, capabilities: []});
    if (kind === "heartbeat") return json({});
    if (kind === "renewal") return json({request: null});
    if (kind === "activity") return json({acceptedStreamSeq: body.streamSeq});
    if (kind === "listing") return json({enrollments: []});
    if (kind === "state") return json({roomId: ROOM, roster: []});
    return json({code: "not_found"}, 404);
  };
  const runtimes = new Map(accounts.map((account) => [account.accountId,
    new OpenClawRoomRuntime(account, {fetchImpl, status, logger: quiet, waitForRenewal: true})]));
  return {directory, status, contacts, runtimes};
}

// The fake clock: advance by `milliseconds` in steps, letting the real file I/O of the runtimes finish between them.
async function advance(milliseconds, step = 100) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += step) {
    mock.timers.tick(step);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
    for (let index = 0; index < 3; index += 1) await turn();
  }
}

// The most registration starts in any 60 s window (each start opens one window).
function busiestWindow(times, windowMs = 60_000) {
  let most = 0;
  for (const start of times) most = Math.max(most, times.filter((at) => at >= start && at < start + windowMs).length);
  return most;
}

const network = () => new TypeError("fetch failed", {cause: Object.assign(new Error("SSL routines::unexpected eof while reading"), {code: "ECONNRESET"})});

async function withClock(body) {
  runtimeModule.resetRecoveryBudgets?.();
  mock.timers.enable({apis: ["setTimeout", "Date"], now: Date.parse("2026-11-17T12:51:00Z")});
  const stop = new AbortController();
  const started = [];
  try {
    return await body({stop, started, t0: Date.now()});
  } finally {
    stop.abort(new Error("test over"));
    mock.timers.reset();
    await Promise.allSettled(started);
  }
}

async function closeAll(room) {
  for (const runtime of room.runtimes.values()) await runtime.close().catch(() => {});
}

test("conformance parityP2c3eCases carries the five shared cases, each a test of this suite, and the contract carries P2c-3e", () => {
  assert.deepEqual(conformance.parityP2c3eCases, CASES);
  assert.ok(contract.includes("\nP2c-3e Recovery budget (2026-11-17). All memberships of one connector installation share one recovery budget: across\n"), "P2c-3e paragraph");
  assert.ok(contract.indexOf("The per-Room summary follows the membership entries (P2c-4).\n\nP2c-3e ") > 0, "P2c-3e directly after P2c-3d");
  assert.ok(contract.indexOf("does not use it.\n\nP2c-3f Request discipline") > 0, "P2c-3f follows P2c-3e");
  // Paula's final text (common brief Addendum 1): a 429 to a registration and a 429 to a heartbeat differ.
  assert.ok(contract.includes("An HTTP 429 answer to a registration\ndelays that membership's next registration at least by its `Retry-After` (or `retryAfterSeconds`); an HTTP 429 answer\nto a heartbeat of a current session is retried after its `Retry-After` and does not count as a failed heartbeat unless\nthe lease expires first."), "P2c-3e final text");
  assert.equal(sha256(contract), conformance.contractSha256);
});

test(CASES[0], async (t) => {
  // Twelve memberships of one gateway start while the Room cannot be reached (TLS drops, every contact), for six
  // minutes of fake time.
  const members = Array.from({length: 12}, (_, index) => `storm${String(index).padStart(10, "0")}`);
  const room = await installation(members, () => network());
  await withClock(async ({stop, started, t0}) => {
    for (const runtime of room.runtimes.values()) started.push(runtime.initialize(stop.signal).catch(() => {}));
    await advance(6 * 60_000);
    const starts = room.contacts.filter((contact) => contact.kind === "register").map((contact) => contact.at - t0);
    const perMinute = Array.from({length: 6}, (_, minute) => starts.filter((at) => at >= minute * 60_000 && at < (minute + 1) * 60_000).length);
    t.diagnostic(`registration starts: ${starts.length} in 6 min, per minute ${perMinute.join(",")}, busiest 60 s window ${busiestWindow(starts)}`);
    assert.ok(busiestWindow(starts) <= 6, `busiest 60 s window ${busiestWindow(starts)} > 6 (per minute ${perMinute.join(",")})`);
    // Over the budget waits instead of failing: the budget is used, and every membership keeps trying.
    assert.ok(starts.length >= 30, String(starts.length));
    for (const membershipId of members) assert.ok(room.contacts.some((contact) => contact.kind === "register" && contact.membershipId === membershipId), membershipId);
    await closeAll(room);
  });
});

test(CASES[1], async (t) => {
  // One membership, connected. Then its session is lost (heartbeat 404) and three registrations fail (503); the fourth
  // is accepted; the next two heartbeats on the new session fail (503); the third is accepted; one more fails.
  const MEMBER = "growth000000001";
  const script = {register: ["ok", 503, 503, 503, "ok"], heartbeat: [404, 503, 503, "ok", 503]};
  const room = await installation([MEMBER], ({kind}) => {
    const next = script[kind]?.shift();
    if (next === undefined || next === "ok") return null;
    return json({code: next === 404 ? "not_found" : "unavailable"}, next);
  });
  await withClock(async ({stop, t0}) => {
    const runtime = room.runtimes.get(MEMBER);
    await runtime.initialize(stop.signal);
    await advance(3 * 60_000);
    const recovery = room.contacts.filter((contact) => contact.kind === "register" || contact.kind === "heartbeat");
    const times = recovery.map((contact) => `${contact.kind}@${((contact.at - t0) / 1000).toFixed(1)}`);
    t.diagnostic(times.join(" "));
    // register(ok) hb(404)+register(503) register(503) register(503) register(ok) hb(503) hb(503) hb(ok) hb(503)
    const kinds = recovery.slice(0, 10).map((contact) => contact.kind);
    assert.deepEqual(kinds, ["register", "heartbeat", "register", "register", "register", "register", "heartbeat", "heartbeat", "heartbeat", "heartbeat"]);
    const at = recovery.map((contact) => contact.at);
    const gap = (index) => at[index + 1] - at[index];
    // The P2c-3a schedule (base 1, 2, 4, 8, 15 s, factor 0.8-1.0) over the failed registrations ...
    assert.ok(gap(2) >= 800 && gap(2) <= 1_100, `first retry ${gap(2)}`);
    assert.ok(gap(3) >= 1_600 && gap(3) <= 2_100, `second retry ${gap(3)}`);
    assert.ok(gap(4) >= 3_200 && gap(4) <= 4_100, `third retry ${gap(4)}`);
    // ... the accepted registration is not a reset: the next heartbeat follows at its interval (12 s), and the failed
    // heartbeats of the same outage continue the schedule (8 s, then 15 s), not 1 s again.
    // (The accepted registration saves the state file; that real I/O may let the fake clock run on, so only a lower
    // bound here.)
    assert.ok(gap(5) >= 11_900, `heartbeat interval ${gap(5)}`);
    assert.ok(gap(6) >= 6_400 && gap(6) <= 8_100, `after the first failed heartbeat on the new session ${gap(6)}`);
    assert.ok(gap(7) >= 12_000 && gap(7) <= 15_100, `after the second ${gap(7)}`);
    // Only the accepted heartbeat resets it: the next failure waits the first step again.
    assert.ok(gap(8) >= 11_900 && gap(8) <= 12_200, `heartbeat interval ${gap(8)}`);
    assert.ok(at.length > 10, "a retry follows the last failed heartbeat");
    assert.ok(gap(9) >= 800 && gap(9) <= 1_100, `after the accepted heartbeat ${gap(9)}`);
    await closeAll(room);
  });
});

test(CASES[2], async (t) => {
  // A: its registration answers 429 with the Room's retryAfterSeconds detail and no header (a proxy dropped it).
  // B: its heartbeat answers 429 with Retry-After: 30. C: a sibling registering normally.
  const A = "limitedbody0001", B = "limitedhead0001", C = "unlimited000001";
  let bHeartbeats = 0;
  let aRegistrations = 0;
  const room = await installation([A, B, C], ({kind, membershipId}) => {
    if (membershipId === A && kind === "register" && ++aRegistrations === 1) {
      return json({code: "rate_limited", message: "rate limit exceeded", retryable: true, details: {retryAfterSeconds: 40}}, 429);
    }
    if (membershipId === B && kind === "heartbeat" && ++bHeartbeats === 1) {
      return json({code: "rate_limited", retryable: true, details: {retryAfterSeconds: 30}}, 429, {"Retry-After": "30"});
    }
    return null;
  });
  await withClock(async ({stop, started, t0}) => {
    for (const runtime of room.runtimes.values()) started.push(runtime.initialize(stop.signal).catch(() => {}));
    await advance(2 * 60_000);
    const of = (membershipId, kind) => room.contacts.filter((contact) => contact.membershipId === membershipId && contact.kind === kind).map((contact) => contact.at - t0);
    t.diagnostic(`A register ${of(A, "register")}; B heartbeat ${of(B, "heartbeat")}; C register ${of(C, "register")}`);
    const aStarts = of(A, "register");
    assert.ok(aStarts.length >= 2, "A registers again");
    assert.ok(aStarts[1] - aStarts[0] >= 40_000, `A waited ${aStarts[1] - aStarts[0]} ms after retryAfterSeconds 40`);
    const bBeats = of(B, "heartbeat");
    assert.ok(bBeats.length >= 2, "B heartbeats again");
    assert.ok(bBeats[1] - bBeats[0] >= 30_000, `B waited ${bBeats[1] - bBeats[0]} ms after Retry-After 30`);
    // That membership only: C registered once, at the start with A, and heartbeats at its interval.
    assert.equal(of(C, "register").length, 1);
    assert.ok(Math.abs(of(C, "register")[0] - aStarts[0]) <= 1_000, "C started with A");
    const cBeats = of(C, "heartbeat");
    assert.ok(cBeats.length >= 8, String(cBeats.length));
    await closeAll(room);
  });
});

test(CASES[3], async (t) => {
  // One gateway: CURRENT holds an accepted session; eight memberships cannot reach the Room and recover; STOPPED's
  // credential expired (the Room answers credential_expired; P2c-3d), it waits for a renewal the Room never grants.
  const CURRENT = "current00000001", STOPPED = "stopped00000001";
  const storm = Array.from({length: 8}, (_, index) => `stormb${String(index).padStart(9, "0")}`);
  const room = await installation([CURRENT, STOPPED, ...storm], ({kind, membershipId}) => {
    if (storm.includes(membershipId)) return network();
    if (membershipId === STOPPED && kind === "register") return json({code: "credential_expired"}, 401);
    return null;
  });
  // P2c-3d: this gateway already reported STOPPED as stopped by the Room before the start.
  room.status.room(ROOM, STOPPED, {connection: "stopped", errorCode: "credential_expired"});
  await withClock(async ({stop, started, t0}) => {
    await room.runtimes.get(CURRENT).initialize(stop.signal);
    for (const membershipId of [STOPPED, ...storm]) started.push(room.runtimes.get(membershipId).initialize(stop.signal).catch(() => {}));
    await advance(4 * 60_000);
    const of = (filter) => room.contacts.filter(filter).map((contact) => contact.at - t0);
    const beats = of((contact) => contact.membershipId === CURRENT && contact.kind === "heartbeat");
    const stoppedStarts = of((contact) => contact.membershipId === STOPPED && contact.kind === "register");
    const budgeted = of((contact) => contact.kind === "register" && contact.membershipId !== STOPPED);
    t.diagnostic(`CURRENT heartbeats ${beats.length}; STOPPED registrations ${stoppedStarts}; budgeted starts ${budgeted.length}, busiest window ${busiestWindow(budgeted)}`);
    // Never delayed: one heartbeat every 12 s (0.8 of 15 s), all through the storm.
    assert.ok(beats.length >= 19, String(beats.length));
    for (let index = 1; index < beats.length; index += 1) {
      assert.ok(beats[index] - beats[index - 1] <= 12_200, `heartbeat ${index} after ${beats[index] - beats[index - 1]} ms`);
    }
    // The installation's budget holds for everyone else ...
    assert.ok(busiestWindow(budgeted) <= 6, `busiest window ${busiestWindow(budgeted)}`);
    // ... and STOPPED registered while it was full (seven starts in one 60 s window with STOPPED's), so it is outside it;
    assert.ok(busiestWindow([...budgeted, ...stoppedStarts].sort((a, b) => a - b)) >= 7, "STOPPED registered while the budget was full");
    // its attempts follow each 30 s renewal wait and never wait for a slot.
    assert.ok(stoppedStarts.length >= 7, String(stoppedStarts));
    for (let index = 1; index < stoppedStarts.length; index += 1) {
      const gap = stoppedStarts[index] - stoppedStarts[index - 1];
      assert.ok(gap >= 30_000 && gap <= 31_000, `STOPPED retry ${index} after ${gap} ms`);
    }
    const entry = room.status.snapshot().memberships[STOPPED];
    assert.deepEqual([entry.connection, entry.lastErrorCode], ["stopped", "credential_expired"]);
    await closeAll(room);
  });
});

test(CASES[4], async (t) => {
  // A: a current session (lease 45 s from each accepted contact, the Room's fallback); its heartbeat answers 429 twice,
  // once with Retry-After: 5, once with only the Room's retryAfterSeconds 5; then accepted; then a 503.
  // B: its heartbeat answers 429 with Retry-After: 20 until the lease (45 s after the last accepted heartbeat) expires.
  const A = "ratelimitedhb01", B = "ratelimitedhb02";
  const scripts = {[A]: ["ok", "429h", "429d", "ok", 503], [B]: ["ok", "429l", "429l", "429l", "ok"]};
  const room = await installation([A, B], ({kind, membershipId}) => {
    if (kind !== "heartbeat") return null;
    const runtime = room.runtimes.get(membershipId);
    const entry = room.status.snapshot().memberships[membershipId];
    // What this membership made of the previous answer, seen at the next contact.
    seen[membershipId].push({step: runtime.recoveryStep, connection: entry?.connection});
    const next = scripts[membershipId].shift();
    if (next === undefined || next === "ok") return null;
    if (next === "429h") return json({code: "rate_limited", retryable: true}, 429, {"Retry-After": "5"});
    if (next === "429d") return json({code: "rate_limited", retryable: true, details: {retryAfterSeconds: 5}}, 429);
    if (next === "429l") return json({code: "rate_limited", retryable: true, details: {retryAfterSeconds: 20}}, 429, {"Retry-After": "20"});
    return json({code: "unavailable"}, next);
  });
  const seen = {[A]: [], [B]: []};
  await withClock(async ({stop, t0}) => {
    await room.runtimes.get(A).initialize(stop.signal);
    await room.runtimes.get(B).initialize(stop.signal);
    await advance(2 * 60_000);
    const beats = (membershipId) => room.contacts.filter((contact) => contact.membershipId === membershipId && contact.kind === "heartbeat").map((contact) => contact.at - t0);
    const a = beats(A), b = beats(B);
    t.diagnostic(`A heartbeats ${a}; seen ${JSON.stringify(seen[A].slice(0, 6))}`);
    t.diagnostic(`B heartbeats ${b}; seen ${JSON.stringify(seen[B].slice(0, 6))}`);
    // A: hb ok, 429 (header), 429 (detail), ok, 503, retry.
    assert.ok(a.length >= 6, String(a));
    // Each 429 is retried after its Retry-After (5 s), not later than the first schedule step would add.
    assert.ok(a[2] - a[1] >= 5_000 && a[2] - a[1] <= 5_200, `after the 429 with Retry-After ${a[2] - a[1]}`);
    assert.ok(a[3] - a[2] >= 5_000 && a[3] - a[2] <= 5_200, `after the 429 with retryAfterSeconds ${a[3] - a[2]}`);
    // While the lease holds a 429 is not a failed heartbeat: the step stays, the membership stays connected.
    assert.deepEqual(seen[A][2], {step: 0, connection: "connected"}, "after the first 429");
    assert.deepEqual(seen[A][3], {step: 0, connection: "connected"}, "after the second 429");
    // The 503 that follows is the outage's first failure: the first step (0.8-1 s).
    assert.ok(a[5] - a[4] >= 800 && a[5] - a[4] <= 1_100, `after the 503 ${a[5] - a[4]}`);
    assert.deepEqual(seen[A][5], {step: 1, connection: "reconnecting"}, "after the 503");
    // B: hb ok at 12 s (lease to 57 s), 429 at 24 s and 44 s within the lease; the 429 at 64 s comes after it expired.
    assert.ok(b.length >= 5, String(b));
    assert.ok(b[2] - b[1] >= 20_000 && b[3] - b[2] >= 20_000, `B retries ${b[2] - b[1]}, ${b[3] - b[2]}`);
    assert.deepEqual(seen[B][2], {step: 0, connection: "connected"}, "B after the first 429");
    assert.deepEqual(seen[B][3], {step: 0, connection: "connected"}, "B after the second 429, lease still held");
    // Lease expired: the normal recovery path (a failed heartbeat, the step advances), still after its Retry-After.
    assert.ok(b[3] - b[0] > 45_000, "the third 429 comes after the lease");
    assert.deepEqual(seen[B][4], {step: 1, connection: "reconnecting"}, "B after the 429 past the lease");
    assert.ok(b[4] - b[3] >= 20_000, `B retry after the expired lease ${b[4] - b[3]}`);
    await closeAll(room);
  });
});

// Paula's OP-12 finding O-RRB05-01 (common brief Addendum 2): a heartbeat 429's Retry-After holds for every presence
// caller of that membership, not only the loop that received it.
test(`${CASES[4].slice(0, 6)} cross-path: after a heartbeat 429 with Retry-After no presence caller of that membership heartbeats before the deadline; a sibling is not delayed`, async (t) => {
  const A = "crosspathhb0001", S = "crosspathsib001";
  // A's heartbeats: 429 Retry-After 30 (sent by the long-poll presence), then 429 with only retryAfterSeconds 20 (sent by
  // the timer loop), then accepted.
  const script = ["429h", "429d"];
  const room = await installation([A, S], ({kind, membershipId}) => {
    if (kind !== "heartbeat" || membershipId !== A) return null;
    const next = script.shift();
    if (next === "429h") return json({code: "rate_limited", retryable: true}, 429, {"Retry-After": "30"});
    if (next === "429d") return json({code: "rate_limited", retryable: true, details: {retryAfterSeconds: 20}}, 429);
    return null;
  });
  await withClock(async ({stop, t0}) => {
    const a = room.runtimes.get(A);
    await a.initialize(stop.signal);
    await room.runtimes.get(S).initialize(stop.signal);
    const until = async (ms) => advance(Math.max(0, t0 + ms - Date.now()));
    // The long-poll presence (the read path's caller) sends A's heartbeat at 1 s: 429, Retry-After 30 (deadline 31 s).
    await until(1_000);
    await a.maintainPresenceResilient(stop.signal, {heartbeat: true});
    // Paula's probe: the next long-poll presence 1 s later, and again at 20 s; the timer loop's heartbeat is due at 12 s.
    await until(2_000);
    await a.maintainPresenceResilient(stop.signal, {heartbeat: true});
    await until(20_000);
    await a.maintainPresenceResilient(stop.signal, {heartbeat: true});
    // The timer loop sends the next heartbeat at or after 31 s: 429, retryAfterSeconds 20 (deadline 20 s later).
    await until(40_000);
    const beats = () => room.contacts.filter((contact) => contact.membershipId === A && contact.kind === "heartbeat").map((contact) => contact.at - t0);
    const second = beats()[1];
    // The long-poll presence just after it, and 10 s later, sends nothing.
    await a.maintainPresenceResilient(stop.signal, {heartbeat: true});
    await until(second + 10_000);
    await a.maintainPresenceResilient(stop.signal, {heartbeat: true});
    await until(90_000);
    const heard = beats();
    const sibling = room.contacts.filter((contact) => contact.membershipId === S && contact.kind === "heartbeat").map((contact) => contact.at - t0);
    t.diagnostic(`A heartbeats ${heard}; S heartbeats ${sibling}`);
    assert.equal(heard[0], 1_000);
    assert.ok(heard[1] >= 31_000 && heard[1] <= 31_200, `second heartbeat at ${heard[1]}, deadline 31000 (Retry-After 30)`);
    assert.ok(heard[2] - heard[1] >= 20_000 && heard[2] - heard[1] <= 20_200, `third after ${heard[2] - heard[1]}, deadline 20000 (retryAfterSeconds 20)`);
    // While leased, neither 429 was a failed heartbeat (RRB-05 unchanged).
    assert.equal(a.recoveryStep, 0);
    assert.equal(room.status.snapshot().memberships[A].connection, "connected");
    // The sibling heartbeats every 12 s throughout.
    assert.ok(sibling.length >= 7, String(sibling));
    for (let index = 1; index < sibling.length; index += 1) assert.ok(sibling[index] - sibling[index - 1] <= 12_200, `sibling ${index}`);
    await closeAll(room);
  });
});
