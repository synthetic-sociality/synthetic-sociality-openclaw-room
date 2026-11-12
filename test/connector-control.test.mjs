// Contract P17 (shared with Hermes 1.0.104): owner connector control
// ("Reconnect agent" / "Restart agent"). Two Room accounts (Aura and Claw)
// run in one gateway process, as on the owner's Mac, against an in-process
// fake Room. A restart never reaches a real gateway: the supervisor request
// goes to a simulated subprocess fixture, a fake `openclaw` executable in a
// temp directory that records its argv. No test uses a real credential.
import assert from "node:assert/strict";
import test, {afterEach, mock} from "node:test";
import {spawn} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {LocalStatus} from "../src/local-status.js";
import {loadState, saveState} from "../src/state.js";

// Absent before 0.2.79: the cases then fail on their assertions.
const control = await import("../src/connector-control.js").catch(() => null);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

export const CASES = [
  "P17-01 registration carries installation identity, connector version and the control capability",
  "P17-02 a malformed or absent connectorControl is ignored and never breaks the loop",
  "P17-03 a command is claimed once across the bindings of one installation and a 409 is ignored",
  "P17-04 an active dispatch refuses control with work_in_progress",
  "P17-05 a pending renewal refuses control with work_in_progress",
  "P17-06 an unfinished delivery intent in another Room refuses control with work_in_progress",
  "P17-07 the fence blocks a new dispatch while the guard runs",
  "P17-08 reconnect reloads each binding once and keeps one live binding per enabled Room",
  "P17-09 after a reconnect a turn in a sibling Room is accepted",
  "P17-10 restart persists its receipt before the supervisor request with a fixed argv",
  "P17-11 a supervisor failure reports supervisor_unavailable and restores service",
  "P17-12 the restarted process reports completion or mismatch once and control leaves state files unchanged",
];

const BASE = "https://room.example/api";
const quiet = {info: () => {}, warn: () => {}, error: () => {}};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json"}});

async function eventually(check, {timeoutMs = 5_000, message = "condition not reached"} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake Room server for every Room of the gateway; one fetch for all accounts.
function fakeRoom() {
  const room = {
    calls: [], registrations: [], heartbeats: [], claims: [], reports: [], posts: [], unexpected: [],
    control: null, // the connectorControl answered to snapshot sessions, or a raw value
    controlRooms: null, // roomIds that receive it (null: all)
    claimAnswer: null, // (call) => Response | undefined
    claimGate: null, // a promise a claim waits for
    claimedBy: new Map(),
    grant: false, // the Room grants connector.control.v1 (R2-3 declaration)
    declarations: [],
    declarationAnswer: null,
    events: new Map(),
    wakers: new Set(),
    sessions: 0,
  };
  room.addEvent = (roomId, event) => {
    const list = room.events.get(roomId) ?? [];
    list.push(event);
    room.events.set(roomId, list);
    for (const wake of room.wakers) wake();
  };
  const controlFor = (roomId) => (room.control === null || (room.controlRooms && !room.controlRooms.includes(roomId)))
    ? {} : {connectorControl: typeof room.control === "function" ? room.control(roomId) : room.control};
  const command = (commandId, state) => ({commandId, action: "reconnect", state, code: null,
    requestedAt: "2026-11-12T08:00:00Z", expiresAt: "2026-11-12T08:02:00Z"});
  room.fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const roomId = decodeURIComponent(path.match(/^\/rooms\/([^/]+)/)?.[1] ?? "");
    const call = {path, method, body, roomId, authorization: init.headers?.Authorization, at: Date.now()};
    room.calls.push(call);
    if (method === "POST" && path === `/rooms/${roomId}/connector/sessions`) {
      room.sessions += 1;
      const sessionId = `s-${roomId}-${room.sessions}`;
      room.registrations.push({...call, sessionId});
      return json({sessionId, heartbeatIntervalSeconds: 60,
        capabilities: ["events.long_poll", ...(room.grant ? ["connector.control.v1"] : [])], ...controlFor(roomId)});
    }
    if (method === "PUT" && /\/connector\/sessions\/[^/]+\/installation$/.test(path)) {
      room.declarations.push({...call, sessionId: path.split("/")[5]});
      return room.declarationAnswer?.(call) ?? json({accepted: true});
    }
    if (path.endsWith("/heartbeat")) {
      room.heartbeats.push(call);
      return json({sessionId: path.split("/")[5], ...controlFor(roomId)});
    }
    let match = path.match(/\/connector\/sessions\/([^/]+)\/control\/([^/]+)\/claim$/);
    if (match && method === "POST") {
      const [, sessionId, commandId] = match;
      room.claims.push({...call, sessionId, commandId});
      if (room.claimGate) await room.claimGate;
      const answered = room.claimAnswer?.({...call, sessionId, commandId});
      if (answered) return answered;
      const holder = room.claimedBy.get(commandId);
      if (holder && holder !== sessionId) return json({code: "control_claimed"}, 409);
      room.claimedBy.set(commandId, sessionId);
      return json({command: command(commandId, "claimed")});
    }
    match = path.match(/\/connector\/sessions\/([^/]+)\/control\/([^/]+)\/report$/);
    if (match && method === "POST") {
      const [, sessionId, commandId] = match;
      room.reports.push({...call, sessionId, commandId});
      const answered = room.reportAnswer?.({...call, sessionId, commandId});
      if (answered) return answered;
      return json({command: command(commandId, body?.phase)});
    }
    if (path.endsWith("/activity")) return json({acceptedStreamSeq: 1}, 202);
    if (path.endsWith("/events")) {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const page = () => ({activeEpochId: "ep-1", activeEpochStartsAtSeq: 1,
        events: (room.events.get(roomId) ?? []).filter((event) => event.seq > after)});
      if (page().events.length || !parsed.searchParams.has("waitSeconds")) return json(page());
      await new Promise((resolve, reject) => {
        const wake = () => { room.wakers.delete(wake); resolve(); };
        room.wakers.add(wake);
        init.signal?.addEventListener("abort", () => { room.wakers.delete(wake); reject(init.signal.reason ?? new Error("aborted")); }, {once: true});
      });
      return json(page());
    }
    if (path.endsWith("/state")) {
      return json({headSeq: (room.events.get(roomId) ?? []).at(-1)?.seq ?? 0, activeEpoch: {id: "ep-1", startsAtSeq: 1},
        activeTopic: {title: "Test"}, roster: [
          {membershipId: "owner", displayName: "Owner", role: "human_owner", status: "active"},
          {membershipId: `member-${roomId}`, displayName: roomId, role: "participant_agent", status: "active"},
        ], rules: []});
    }
    if (path.endsWith("/policy")) return json({policy: {coordinationMode: "open"}});
    if (path.endsWith("/acknowledgements")) return json({acknowledgedSeq: body?.acknowledgedSeq ?? 0});
    if (path.endsWith("/artifacts")) return json({items: []});
    if (path.endsWith("/turns/request")) return json({turnId: `t-${roomId}`, state: "granted", holderMembershipId: `member-${roomId}`}, 202);
    if (path.endsWith("/messages") && method === "POST") {
      room.posts.push(call);
      return json({id: `msg-${roomId}-${room.posts.length}`, seq: 1000 + room.posts.length, ts: new Date().toISOString()}, 201);
    }
    if (path.endsWith("/turns/finish")) return json({turnId: `t-${roomId}`, state: "finished"});
    if (path.includes("/connector/enrollments")) return json([]);
    room.unexpected.push(call);
    return json({code: "not_found"}, 404);
  };
  return room;
}

const humanMessage = (roomId, seq) => ({id: `ev-${roomId}-${seq}`, seq, ts: new Date().toISOString(), type: "message.posted",
  actorRole: "human_owner", actorId: "owner", payload: {body: `Hello ${roomId}`, epochId: "ep-1",
    resolvedRecipientMembershipIds: [`member-${roomId}`]}});

// One gateway: a Room state directory with accounts/<id>.json and status.json.
async function gateway({disabled = true, fetchRoom = fakeRoom(), extra = []} = {}) {
  const home = await mkdtemp(join(tmpdir(), "openclaw-room-p17-"));
  const store = join(home, "synthetic-sociality-room");
  await mkdir(join(store, "accounts"), {recursive: true, mode: 0o700});
  const statusPath = join(store, "status.json");
  const status = new LocalStatus(statusPath, {plugin: "openclaw", version: packageJson.version, hostLabel: "test-host", logger: quiet});
  const accounts = [];
  const files = {};
  for (const [accountId, roomId] of [["aura", "room-a"], ["claw", "room-c"], ...(disabled ? [["old", "room-o"]] : [])]) {
    const stateFile = join(store, "accounts", `${accountId}.json`);
    await saveState(stateFile, {version: 1, baseUrl: BASE, roomId, membershipId: `member-${roomId}`,
      credential: `fixture-credential-${roomId}`, clientInstanceId: "client-mac", identityVersion: 2, cursor: 0,
      ...(accountId === "old" ? {enabled: false} : {})});
    files[accountId] = stateFile;
    accounts.push({accountId, stateFile, baseUrl: BASE, enabled: accountId !== "old", configured: true, agentId: accountId});
  }
  // Further stored bindings (R2): {accountId, roomId, baseUrl, enabled, running, stored}.
  for (const item of extra) {
    const stateFile = join(store, "accounts", `${item.accountId}.json`);
    const baseUrl = item.baseUrl ?? BASE;
    const stored = {version: 1, baseUrl, roomId: item.roomId, membershipId: `member-${item.roomId}`,
      credential: `fixture-credential-${item.roomId}`, clientInstanceId: "client-mac", identityVersion: 2, cursor: 0,
      ...(item.enabled === false ? {enabled: false} : {}), ...(item.stored ?? {})};
    // Written as stored on disk (an unfinished intent of any shape counts).
    await writeFile(stateFile, `${JSON.stringify(stored)}\n`, {mode: 0o600});
    files[item.accountId] = stateFile;
    accounts.push({accountId: item.accountId, stateFile, baseUrl, enabled: item.enabled !== false, configured: true,
      agentId: item.accountId, running: item.running === true});
  }
  const loads = [];
  const runtimes = {};
  for (const account of accounts.filter((item) => item.enabled && item.running !== false)) {
    runtimes[account.accountId] = new OpenClawRoomRuntime(account, {fetchImpl: fetchRoom.fetchImpl, logger: quiet, status, waitForRenewal: true});
  }
  const gw = {home, store, statusPath, status, accounts, files, loads, runtimes, room: fetchRoom, readers: [], spawned: []};
  gw.configure = (options = {}) => control?.configureConnectorControl?.({
    accounts: () => accounts,
    loadState: async (path) => { loads.push(path); return loadState(path); },
    reconnectWaitMs: 5_000,
    ...options,
  });
  gw.configure();
  gw.start = async () => {
    for (const runtime of Object.values(runtimes)) await runtime.initialize();
  };
  // A listener per enabled account, as the channel's account loop runs it.
  gw.listen = (accountId) => {
    const abort = new AbortController();
    const turns = runtimes[accountId].assignedTurns(abort.signal);
    // A pending read rejects when its listener stops; the cases await the turns they expect.
    const reader = {accountId, abort, turns, next: () => { const item = turns.next(); item.catch(() => {}); return item; }};
    gw.readers.push(reader);
    return reader;
  };
  gw.close = async () => {
    for (const reader of gw.readers) reader.abort.abort();
    for (const reader of gw.readers) await reader.turns.return?.().catch(() => {});
    for (const runtime of Object.values(runtimes)) await runtime.close().catch(() => {});
  };
  gw.command = (commandId, action, state = "requested") => ({commandId, action, state,
    requestedAt: "2026-11-12T08:00:00Z", expiresAt: "2026-11-12T08:02:00Z"});
  gw.phases = (commandId) => fetchRoom.reports.filter((report) => report.commandId === commandId).map((report) => report.body.phase);
  return gw;
}

// The --json answer of `openclaw gateway restart --safe --json` (host
// 2026.7.1-2 lifecycle-yIOsvBfe.js:221-229; status restart-DJLfBy-X.js:107).
const hostAnswer = (result) => JSON.stringify({ok: true, result,
  message: result === "deferred" ? "safe restart requested; gateway will restart after active work drains" : "safe restart requested; gateway will restart momentarily",
  preflight: {safe: result !== "deferred", counts: {totalActive: result === "deferred" ? 1 : 0}, blockers: [], summary: "fixture"},
  restart: {ok: true, pid: 4242, signal: "SIGUSR1", delayMs: 0, reason: "gateway.restart.safe", mode: "emit", coalesced: result === "coalesced"}}, null, 2);

// The simulated supervisor: a fake `openclaw` that records its argv and the
// status file it saw when it was asked, prints `stdout` (by default the host's
// accepted answer), optionally hangs, then exits with `exitCode`.
async function fakeSupervisor(gw, exitCode = 0, {stdout = hostAnswer("scheduled"), hangSeconds = 0} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-p17-supervisor-"));
  const binary = join(directory, "openclaw");
  const argvFile = join(directory, "argv.txt");
  const seenStatus = join(directory, "status-at-request.json");
  const answer = join(directory, "answer.txt");
  await writeFile(answer, stdout);
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncp '${gw.statusPath}' '${seenStatus}' 2>/dev/null\n`
    + `${hangSeconds ? `sleep ${hangSeconds}\n` : ""}cat '${answer}'\nexit ${exitCode}\n`, {mode: 0o700});
  await chmod(binary, 0o700);
  const calls = [];
  const children = [];
  const spawner = (command, argv, options) => {
    calls.push({command, argv: [...argv], options: {...options, env: undefined}});
    const child = spawn(command, argv, options);
    const record = {child, exited: false, signal: null};
    child.on("exit", (code, signal) => { record.exited = true; record.code = code; record.signal = signal; });
    children.push(record);
    return child;
  };
  return {directory, binary, argvFile, seenStatus, calls, children, spawner};
}

const fileBytes = async (files) => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([id, path]) => [id, await readFile(path, "utf8")])));

const open = [];
afterEach(async () => {
  for (const gw of open.splice(0)) await gw.close();
  await control?.connectorControlTest?.reset?.();
});
async function started(options) {
  const gw = await gateway(options);
  open.push(gw);
  await gw.start();
  return gw;
}

test(CASES[0], async () => {
  const gw = await started();
  const bodies = gw.room.registrations.map((item) => item.body);
  assert.equal(bodies.length, 2);
  const installation = JSON.parse(await readFile(join(gw.store, "installation.json"), "utf8"));
  assert.match(installation.installationId, /^openclaw-inst-[0-9a-f]{32}$/);
  assert.equal((await stat(join(gw.store, "installation.json"))).mode & 0o777, 0o600);
  for (const body of bodies) {
    assert.ok(body.capabilities.includes("connector.control.v1"));
    assert.equal(body.metadata.installationId, installation.installationId);
    assert.equal(body.metadata.connectorVersion, packageJson.version);
    assert.equal(body.metadata.runtimeName, "OpenClaw");
  }
  // Read on start, never rotated: a later runtime reports the same id.
  await control?.connectorControlTest?.reset?.();
  const again = new OpenClawRoomRuntime(gw.accounts[0], {fetchImpl: gw.room.fetchImpl, logger: quiet, status: gw.status});
  await gw.runtimes.aura.close();
  await again.initialize();
  assert.equal(gw.room.registrations.at(-1).body.metadata.installationId, installation.installationId);
  assert.deepEqual(JSON.parse(await readFile(join(gw.store, "installation.json"), "utf8")), installation);
  await again.close();
});

test(CASES[1], async () => {
  const gw = await started();
  const malformed = ["restart", 7, ["restart"], {commandId: 5, action: "restart"}, {commandId: "c-1", action: "rm -rf /"},
    {commandId: "", action: "reconnect", state: "requested"}, {action: "reconnect", state: "requested"}, null];
  for (const value of malformed) {
    gw.room.control = value === null ? null : value;
    await gw.runtimes.aura.maintainPresence();
    await gw.runtimes.claw.maintainPresence();
  }
  await settle();
  assert.equal(gw.room.claims.length, 0);
  assert.equal(gw.room.reports.length, 0);
  // The loop goes on: the next heartbeat is sent and the session is kept.
  const before = gw.room.heartbeats.length;
  gw.room.control = null;
  await gw.runtimes.aura.maintainPresence();
  assert.equal(gw.room.heartbeats.length, before + 1);
  // The fixture would otherwise make every case pass with no implementation.
  assert.ok(gw.room.registrations[0].body.capabilities.includes("connector.control.v1"));
});

test(CASES[2], async () => {
  const gw = await started();
  gw.room.control = gw.command("cmd-once", "reconnect");
  await gw.runtimes.aura.maintainPresence();
  await gw.runtimes.claw.maintainPresence();
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => gw.phases("cmd-once").includes("completed"), {message: "reconnect never completed"});
  assert.equal(gw.room.claims.filter((claim) => claim.commandId === "cmd-once").length, 1);
  // A command another process claimed: 409 control_claimed is ignored quietly.
  gw.room.claimedBy.set("cmd-other", "s-elsewhere");
  gw.room.control = gw.command("cmd-other", "restart");
  await gw.runtimes.claw.maintainPresence();
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => gw.room.claims.some((claim) => claim.commandId === "cmd-other"), {message: "no claim"});
  await settle();
  assert.equal(gw.room.claims.filter((claim) => claim.commandId === "cmd-other").length, 1);
  assert.deepEqual(gw.phases("cmd-other"), []);
  // A closed command (409 control_closed) is ignored the same way.
  gw.room.claimAnswer = ({commandId}) => commandId === "cmd-closed" ? json({code: "control_closed"}, 409) : undefined;
  gw.room.control = gw.command("cmd-closed", "reconnect");
  await gw.runtimes.aura.maintainPresence();
  await settle();
  assert.deepEqual(gw.phases("cmd-closed"), []);
  const heartbeats = gw.room.heartbeats.length;
  await gw.runtimes.claw.maintainPresence();
  assert.equal(gw.room.heartbeats.length, heartbeats + 1);
});

async function refusedWith(gw, commandId, action = "reconnect") {
  const registrations = gw.room.registrations.length;
  gw.room.control = gw.command(commandId, action);
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => gw.phases(commandId).length, {message: "no report"});
  await settle();
  assert.deepEqual(gw.phases(commandId), ["refused"]);
  const report = gw.room.reports.find((item) => item.commandId === commandId);
  assert.equal(report.body.code, "work_in_progress");
  // Refused at once: no reconnect, no restart, the fence is lifted.
  assert.equal(gw.room.registrations.length, registrations);
  assert.equal(control?.connectorControl?.fenced?.(), false);
}

test(CASES[3], async () => {
  const gw = await started();
  // A turn handed to the model and not yet settled.
  gw.runtimes.claw.pendingEvent = humanMessage("room-c", 4);
  await refusedWith(gw, "cmd-dispatch", "restart");
  gw.runtimes.claw.pendingEvent = null;
  // A claimed cycle attempt held alive while its model run is in flight.
  gw.runtimes.aura.attemptLeases.set("ev-room-a-9", {stopped: false, sourceEvent: humanMessage("room-a", 9)});
  await refusedWith(gw, "cmd-attempt");
  gw.runtimes.aura.attemptLeases.clear();
});

test(CASES[4], async () => {
  const gw = await started();
  gw.runtimes.claw.state.credentialRotation = {phase: "requested", grantId: "g-1"};
  await refusedWith(gw, "cmd-renewal", "restart");
  delete gw.runtimes.claw.state.credentialRotation;
});

test(CASES[5], async () => {
  const gw = await started();
  // Claw's Room holds a parked reply; the command arrives through Aura's Room.
  gw.runtimes.claw.state.deliveryIntents = {"ev-room-c-3:final": {version: 2, status: "delivery_pending", deliveryState: "delivery_pending"}};
  await refusedWith(gw, "cmd-intent");
  // A plain quarantined delivery is not work in progress.
  gw.runtimes.claw.state.deliveryIntents = {"ev-room-c-3:final": {version: 2, status: "quarantined", deliveryState: "quarantined"}};
  gw.room.control = gw.command("cmd-quarantined", "reconnect");
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => gw.phases("cmd-quarantined").length, {message: "no report"});
  assert.equal(gw.phases("cmd-quarantined")[0], "reconnecting");
});

test(CASES[6], async () => {
  const gw = await started();
  const reader = gw.listen("aura");
  let delivered = null;
  const first = reader.next().then((item) => { delivered = item; return item; });
  first.catch(() => {});
  await eventually(() => gw.room.calls.some((call) => call.roomId === "room-a" && call.path.endsWith("/events")), {message: "no read"});
  let releaseClaim;
  gw.room.claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  gw.room.claimAnswer = () => json({code: "control_closed"}, 409);
  gw.room.control = gw.command("cmd-fence", "reconnect");
  await gw.runtimes.claw.maintainPresence();
  await eventually(() => gw.room.claims.length === 1, {message: "no claim"});
  // A new event arrives while the claim (and then the guard) is open.
  gw.room.addEvent("room-a", humanMessage("room-a", 1));
  await settle(300);
  assert.equal(delivered, null, "no dispatch starts while the fence is up");
  assert.equal(control?.connectorControl?.fenced?.(), true);
  releaseClaim();
  const turn = await first;
  assert.equal(turn.value.sourceEventId, "ev-room-a-1");
  assert.equal(control?.connectorControl?.fenced?.(), false);
});

test(CASES[7], async () => {
  const gw = await started();
  const disabledBefore = await readFile(gw.files.old, "utf8");
  const live = Object.fromEntries(Object.entries(gw.runtimes).map(([id, runtime]) => [id, {state: runtime.state, client: runtime.client}]));
  gw.listen("aura").next();
  gw.listen("claw").next();
  await eventually(() => ["room-a", "room-c"].every((roomId) => gw.room.calls.some((call) => call.roomId === roomId && call.path.endsWith("/events"))), {message: "listeners not reading"});
  const registrations = gw.room.registrations.length;
  const reads = gw.room.calls.filter((call) => call.path.endsWith("/events")).length;
  gw.loads.length = 0;
  gw.room.control = gw.command("cmd-reconnect", "reconnect");
  await gw.runtimes.claw.maintainPresence();
  await eventually(() => gw.phases("cmd-reconnect").includes("completed"), {message: "reconnect never completed"});
  assert.deepEqual(gw.phases("cmd-reconnect"), ["reconnecting", "completed"]);
  const completed = gw.room.reports.find((item) => item.body.phase === "completed");
  assert.deepEqual(completed.body.inventory, {before: {bindings: 3, enabled: 2, disabled: 1}, after: {bindings: 3, enabled: 2, disabled: 1}, match: true});
  // Each binding's state file was read once.
  for (const path of Object.values(gw.files)) assert.equal(gw.loads.filter((item) => item === path).length, 1, path);
  // Every enabled Room registered again; the disabled one was not contacted.
  const again = gw.room.registrations.slice(registrations).map((item) => item.roomId).sort();
  assert.deepEqual(again, ["room-a", "room-c"]);
  assert.equal(gw.room.calls.filter((call) => call.roomId === "room-o").length, 0);
  assert.equal(await readFile(gw.files.old, "utf8"), disabledBefore);
  // One live state object and client per account, shared by receive and send.
  for (const [id, runtime] of Object.entries(gw.runtimes)) {
    assert.equal(runtime.state, live[id].state);
    assert.equal(runtime.client, live[id].client);
  }
  // The listeners read again after the reconnect.
  await eventually(() => ["room-a", "room-c"].every((roomId) => gw.room.calls.filter((call) => call.roomId === roomId && call.path.endsWith("/events")).length >= 2), {message: "listeners did not resume"});
  assert.ok(gw.room.calls.filter((call) => call.path.endsWith("/events")).length > reads);
});

test(CASES[8], async () => {
  const gw = await started();
  gw.listen("aura").next();
  const claw = gw.listen("claw");
  const turn = claw.next();
  await eventually(() => gw.room.calls.some((call) => call.roomId === "room-c" && call.path.endsWith("/events")), {message: "no read"});
  gw.room.control = gw.command("cmd-sibling", "reconnect");
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => gw.phases("cmd-sibling").includes("completed"), {message: "reconnect never completed"});
  gw.room.addEvent("room-c", humanMessage("room-c", 1));
  const {value} = await turn;
  assert.equal(value.sourceEventId, "ev-room-c-1");
  const sent = await gw.runtimes.claw.postAndFinish({roomId: "room-c", text: "Reply from Claw", idempotencyKey: "ev-room-c-1:final",
    sourceEventId: "ev-room-c-1", sourceEpochId: "ep-1"});
  assert.ok(sent.eventId, "the sibling Room accepted the reply");
  const post = gw.room.posts.find((call) => call.roomId === "room-c");
  assert.equal(post.authorization, "Bearer fixture-credential-room-c");
});

test(CASES[9], async () => {
  const gw = await started();
  const supervisor = await fakeSupervisor(gw, 0);
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner, restartGraceMs: 60_000});
  gw.room.control = gw.command("cmd-restart", "restart");
  await gw.runtimes.aura.maintainPresence();
  await eventually(async () => (await readFile(supervisor.argvFile, "utf8").catch(() => "")).length > 0, {message: "supervisor never asked"});
  assert.deepEqual((await readFile(supervisor.argvFile, "utf8")).trim().split("\n"), ["gateway", "restart", "--safe", "--json"]);
  assert.equal(supervisor.calls.length, 1);
  assert.equal(supervisor.calls[0].command, supervisor.binary);
  assert.deepEqual(supervisor.calls[0].argv, ["gateway", "restart", "--safe", "--json"]);
  assert.ok(!supervisor.calls[0].options.shell);
  assert.deepEqual(gw.phases("cmd-restart"), ["restarting"]);
  // The receipt was in status.json when the supervisor was asked.
  const seen = await eventually(async () => readFile(supervisor.seenStatus, "utf8").catch(() => ""), {message: "no status copy"});
  const receipt = JSON.parse(seen).connectorControl;
  assert.equal(receipt.commandId, "cmd-restart");
  assert.equal(receipt.action, "restart");
  assert.equal(receipt.phase, "restarting");
  assert.equal(receipt.pid, process.pid);
  assert.ok(receipt.startedAt && receipt.requestedAt);
  assert.deepEqual(receipt.before.counts, {bindings: 3, enabled: 2, disabled: 1});
  assert.equal(receipt.before.bindings.length, 3);
  assert.ok(!seen.includes("fixture-credential"), "the receipt holds no credential");
  assert.equal((await stat(gw.statusPath)).mode & 0o777, 0o600);
});

test(CASES[10], async () => {
  const gw = await started();
  gw.listen("aura").next();
  gw.listen("claw").next();
  await eventually(() => ["room-a", "room-c"].every((roomId) => gw.room.calls.some((call) => call.roomId === roomId && call.path.endsWith("/events"))), {message: "listeners not reading"});
  for (const [commandId, supervisor] of [["cmd-exit", await fakeSupervisor(gw, 3, {stdout: ""})], ["cmd-missing", {binary: join(gw.home, "no-such-openclaw"), spawner: undefined, argvFile: ""}]]) {
    gw.configure({binary: supervisor.binary, ...(supervisor.spawner ? {spawner: supervisor.spawner} : {}), restartGraceMs: 60_000});
    const registrations = gw.room.registrations.length;
    gw.room.control = gw.command(commandId, "restart");
    await gw.runtimes.aura.maintainPresence();
    await eventually(() => gw.phases(commandId).includes("failed"), {message: `${commandId}: failure never reported`});
    const failed = gw.room.reports.find((item) => item.commandId === commandId && item.body.phase === "failed");
    assert.equal(failed.body.code, "supervisor_unavailable");
    // Service restored: every enabled Room registered again and reads again.
    await eventually(() => gw.room.registrations.slice(registrations).map((item) => item.roomId).sort().join() === "room-a,room-c", {message: "not reconnected"});
    const reads = gw.room.calls.filter((call) => call.path.endsWith("/events")).length;
    await eventually(() => gw.room.calls.filter((call) => call.path.endsWith("/events")).length > reads || gw.room.wakers.size >= 2, {message: "listeners did not resume"});
    const receipt = JSON.parse(await readFile(gw.statusPath, "utf8")).connectorControl;
    assert.equal(receipt.commandId, commandId);
    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.code, "supervisor_unavailable");
    assert.equal(control?.connectorControl?.fenced?.(), false);
  }
  gw.room.addEvent("room-c", humanMessage("room-c", 1));
});

test(CASES[11], async () => {
  // The first process: asks the simulated supervisor and is then "replaced".
  const gw = await started();
  const supervisor = await fakeSupervisor(gw, 0);
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner, restartGraceMs: 60_000});
  const stateBefore = await fileBytes(gw.files);
  gw.room.control = gw.command("cmd-new-process", "restart");
  await gw.runtimes.aura.maintainPresence();
  await eventually(async () => (await readFile(supervisor.seenStatus, "utf8").catch(() => "")).length > 0, {message: "supervisor never asked"});
  assert.deepEqual(await fileBytes(gw.files), stateBefore, "control changed no account state file");
  await gw.close();
  open.splice(open.indexOf(gw), 1);
  await control?.connectorControlTest?.reset?.();

  // The new process: a receipt from another pid in status.json.
  const receiptFile = JSON.parse(await readFile(gw.statusPath, "utf8"));
  receiptFile.connectorControl.pid = 999_999;
  await writeFile(gw.statusPath, JSON.stringify(receiptFile), {mode: 0o600});
  const next = async ({mutate} = {}) => {
    if (mutate) await mutate();
    const status = new LocalStatus(gw.statusPath, {plugin: "openclaw", version: packageJson.version, hostLabel: "test-host", logger: quiet});
    const runtimes = Object.fromEntries(gw.accounts.filter((item) => item.enabled).map((account) => [account.accountId,
      new OpenClawRoomRuntime(account, {fetchImpl: gw.room.fetchImpl, logger: quiet, status, waitForRenewal: true})]));
    gw.configure({binary: supervisor.binary, spawner: supervisor.spawner, restartGraceMs: 60_000});
    return {status, runtimes, close: async () => { for (const runtime of Object.values(runtimes)) await runtime.close(); }};
  };
  gw.room.control = gw.command("cmd-new-process", "restart", "restarting");
  const second = await next();
  try {
    await second.runtimes.aura.initialize();
    await second.runtimes.claw.initialize();
    await eventually(() => gw.phases("cmd-new-process").includes("completed"), {message: "completion never reported"});
    await second.runtimes.claw.maintainPresence();
    await second.runtimes.aura.maintainPresence();
    await settle();
    assert.deepEqual(gw.phases("cmd-new-process"), ["restarting", "completed"]);
    const completed = gw.room.reports.find((item) => item.body.phase === "completed");
    assert.deepEqual(completed.body.inventory, {before: {bindings: 3, enabled: 2, disabled: 1}, after: {bindings: 3, enabled: 2, disabled: 1}, match: true});
    assert.equal(JSON.parse(await readFile(gw.statusPath, "utf8")).connectorControl.phase, "reported");
    // A receipt never causes a second restart or claim.
    assert.equal(supervisor.calls.length, 1);
    assert.equal(gw.room.claims.filter((claim) => claim.commandId === "cmd-new-process").length, 1);
  } finally {
    await second.close();
    await control?.connectorControlTest?.reset?.();
  }

  // A third process whose stored inventory changed since the restart request.
  receiptFile.connectorControl.commandId = "cmd-mismatch";
  await writeFile(gw.statusPath, JSON.stringify(receiptFile), {mode: 0o600});
  gw.room.control = gw.command("cmd-mismatch", "restart", "restarting");
  const third = await next({mutate: async () => {
    const changed = await loadState(gw.files.claw);
    changed.cursor = 41;
    await saveState(gw.files.claw, changed);
  }});
  try {
    await third.runtimes.aura.initialize();
    await eventually(() => gw.phases("cmd-mismatch").length, {message: "mismatch never reported"});
    const report = gw.room.reports.find((item) => item.commandId === "cmd-mismatch");
    assert.equal(report.body.phase, "failed");
    assert.equal(report.body.code, "inventory_mismatch");
    assert.equal(report.body.inventory.match, false);
  } finally {
    await third.close();
  }
});

// ---- R2 remedies (OP12-R1 findings; CONTRACT-R2.md) ----

const unfinishedIntent = {deliveryIntents: {"ev-stored-1:final": {version: 2, status: "delivery_pending", deliveryState: "delivery_pending"}}};
const receiptNow = async (gw) => JSON.parse(await readFile(gw.statusPath, "utf8")).connectorControl;
// Polling that does not depend on (possibly mocked) timers.
async function spin(check, {timeoutMs = 5_000, message = "condition not reached"} = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("B-F002 a disabled binding with an unfinished intent refuses reconnect and restart", async () => {
  const gw = await started({extra: [{accountId: "expired", roomId: "room-x", enabled: false, stored: {...unfinishedIntent, revokedReason: "credential_expired"}}]});
  const supervisor = await fakeSupervisor(gw, 0);
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner});
  await refusedWith(gw, "cmd-disabled-reconnect", "reconnect");
  await refusedWith(gw, "cmd-disabled-restart", "restart");
  assert.equal(supervisor.calls.length, 0, "the supervisor is never asked");
});

test("B-F002 an enabled account that is not running with an unfinished intent refuses control", async () => {
  const gw = await started({disabled: false, extra: [{accountId: "idle", roomId: "room-i", enabled: true, running: false, stored: unfinishedIntent}]});
  assert.equal(gw.runtimes.idle, undefined);
  await refusedWith(gw, "cmd-idle-reconnect", "reconnect");
  await refusedWith(gw, "cmd-idle-restart", "restart");
  // The guard reads, never writes, the stored binding.
  assert.ok((await readFile(gw.files.idle, "utf8")).includes("delivery_pending"));
});

test("B-F004 an accepted deferred restart keeps the fence and the restarting receipt until the new incarnation completes", async () => {
  const gw = await started();
  gw.listen("aura").next();
  gw.listen("claw").next();
  await eventually(() => ["room-a", "room-c"].every((roomId) => gw.room.calls.some((call) => call.roomId === roomId && call.path.endsWith("/events"))), {message: "listeners not reading"});
  const supervisor = await fakeSupervisor(gw, 0, {stdout: hostAnswer("deferred")});
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner});
  const registrations = gw.room.registrations.length;
  mock.timers.enable({apis: ["setTimeout", "setInterval", "Date"], now: Date.now()});
  try {
    gw.room.control = gw.command("cmd-deferred", "restart");
    await gw.runtimes.aura.maintainPresence();
    await spin(() => supervisor.children[0]?.exited, {message: "the host CLI never answered"});
    await spin(async () => (await receiptNow(gw))?.phase === "restarting");
    assert.equal(control?.connectorControl?.fenced?.(), true);
    // The host defers for 280 s (another channel's work); nothing gives up.
    for (let second = 0; second < 280; second += 10) {
      mock.timers.tick(10_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(control?.connectorControl?.fenced?.(), true, `fence held at ${second + 10} s`);
    }
  } finally {
    mock.timers.reset();
  }
  await settle(200);
  assert.deepEqual(gw.phases("cmd-deferred"), ["restarting"], "no failed report");
  assert.equal((await receiptNow(gw)).phase, "restarting");
  assert.equal(control?.connectorControl?.fenced?.(), true);
  assert.equal(gw.room.registrations.length, registrations, "no listener was resumed");

  // The new gateway incarnation comes up and completes, exactly once.
  await gw.close();
  open.splice(open.indexOf(gw), 1);
  await control?.connectorControlTest?.reset?.();
  gw.room.control = gw.command("cmd-deferred", "restart", "restarting");
  const status = new LocalStatus(gw.statusPath, {plugin: "openclaw", version: packageJson.version, hostLabel: "test-host", logger: quiet});
  const next = gw.accounts.filter((item) => item.enabled).map((account) =>
    new OpenClawRoomRuntime(account, {fetchImpl: gw.room.fetchImpl, logger: quiet, status, waitForRenewal: true}));
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner});
  try {
    for (const runtime of next) await runtime.initialize();
    await eventually(() => gw.phases("cmd-deferred").includes("completed"), {message: "completion never reported"});
    for (const runtime of next) await runtime.maintainPresence();
    await settle();
    assert.deepEqual(gw.phases("cmd-deferred"), ["restarting", "completed"]);
    assert.equal(supervisor.calls.length, 1);
  } finally {
    for (const runtime of next) await runtime.close();
  }
});

test("B-F004 a hung host CLI is killed, the receipt is restart_unconfirmed, the fence held and nothing reported", async () => {
  const gw = await started();
  const supervisor = await fakeSupervisor(gw, 0, {hangSeconds: 30});
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner, supervisorTimeoutMs: 400});
  gw.room.control = gw.command("cmd-hang", "restart");
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => supervisor.children[0]?.exited, {message: "the hung CLI was not killed"});
  assert.ok(supervisor.children[0].signal, "ended by a signal");
  await eventually(async () => (await receiptNow(gw))?.phase === "restart_unconfirmed", {message: "receipt not restart_unconfirmed"});
  await settle(300);
  assert.deepEqual(gw.phases("cmd-hang"), ["restarting"]);
  assert.equal(control?.connectorControl?.fenced?.(), true);
});

test("B-F004 only an explicit error, a spawn error or a non-zero exit without an accepted status is supervisor_unavailable", async () => {
  const gw = await started();
  // A non-zero exit that still carries an accepted status: accepted.
  const coalesced = await fakeSupervisor(gw, 1, {stdout: hostAnswer("coalesced")});
  gw.configure({binary: coalesced.binary, spawner: coalesced.spawner});
  gw.room.control = gw.command("cmd-coalesced", "restart");
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => coalesced.children[0]?.exited, {message: "no answer"});
  await settle(300);
  assert.deepEqual(gw.phases("cmd-coalesced"), ["restarting"]);
  assert.equal((await receiptNow(gw)).phase, "restarting");
  assert.equal(control?.connectorControl?.fenced?.(), true);
  // An explicit error answer: supervisor_unavailable, then service restored.
  await control?.connectorControlTest?.reset?.();
  const second = await started();
  const refused = await fakeSupervisor(second, 1, {stdout: JSON.stringify({ok: false, error: "gateway unreachable"})});
  second.configure({binary: refused.binary, spawner: refused.spawner});
  const registrations = second.room.registrations.length;
  second.room.control = second.command("cmd-error", "restart");
  await second.runtimes.claw.maintainPresence();
  await eventually(() => second.phases("cmd-error").includes("failed"), {message: "no failure report"});
  assert.equal(second.room.reports.find((item) => item.body.phase === "failed" && item.commandId === "cmd-error").body.code, "supervisor_unavailable");
  await eventually(() => second.room.registrations.length >= registrations + 2, {message: "service not restored"});
  await eventually(() => control?.connectorControl?.fenced?.() === false, {message: "fence not lifted"});
});

async function acceptedRestart(gw, commandId) {
  const supervisor = await fakeSupervisor(gw, 0, {stdout: hostAnswer("deferred")});
  gw.configure({binary: supervisor.binary, spawner: supervisor.spawner});
  gw.room.control = gw.command(commandId, "restart");
  await gw.runtimes.aura.maintainPresence();
  await eventually(() => supervisor.children[0]?.exited, {message: "the host CLI never answered"});
  await eventually(async () => (await receiptNow(gw))?.phase === "restarting", {message: "no restarting receipt"});
  await settle();
  gw.room.control = gw.command(commandId, "restart", "restarting");
  return supervisor;
}

test("B-F005 a presence fallback or a re-attached account of the same incarnation never completes or resumes", async () => {
  const gw = await started();
  gw.listen("aura").next();
  await eventually(() => gw.room.calls.some((call) => call.roomId === "room-a" && call.path.endsWith("/events")), {message: "listener not reading"});
  await acceptedRestart(gw, "cmd-same-incarnation");
  const reads = () => gw.room.calls.filter((call) => call.roomId === "room-a" && call.path.endsWith("/events")).length;
  const readsBefore = reads();
  // A heartbeat-only fallback runtime of this gateway registers during restarting.
  const fallback = new OpenClawRoomRuntime(gw.accounts[0], {fetchImpl: gw.room.fetchImpl, logger: quiet, status: gw.status, controlRole: "fallback"});
  // A host channel restart of one account (same process, same plugin load).
  await gw.runtimes.claw.close();
  const reattached = new OpenClawRoomRuntime(gw.accounts[1], {fetchImpl: gw.room.fetchImpl, logger: quiet, status: gw.status, waitForRenewal: true});
  try {
    await fallback.initialize();
    await reattached.initialize();
    await fallback.maintainPresence();
    await reattached.maintainPresence();
    await settle(300);
    assert.deepEqual(gw.phases("cmd-same-incarnation"), ["restarting"], "no completion from the same incarnation");
    assert.equal((await receiptNow(gw)).phase, "restarting");
    assert.equal(control?.connectorControl?.fenced?.(), true);
    assert.ok(gw.runtimes.aura.controlPause, "the drained listener stays drained");
    assert.equal(reads(), readsBefore, "the drained listener did not read again");
  } finally {
    await fallback.close();
    await reattached.close();
  }
});

test("B-F005 the host's in-process restart starts a new incarnation that completes once", async () => {
  const gw = await started();
  await acceptedRestart(gw, "cmd-in-process");
  const receipt = await receiptNow(gw);
  assert.match(receipt.incarnation ?? "", /^[A-Za-z0-9._:-]{8,128}$/);
  // The host closes the gateway (gateway_stop) and starts it again in this process.
  control?.connectorControl?.gatewayStopped?.();
  await gw.close();
  open.splice(open.indexOf(gw), 1);
  assert.notEqual(control?.connectorControl?.incarnation, receipt.incarnation);
  assert.equal(control?.connectorControl?.fenced?.(), false, "the new incarnation is not fenced");
  const next = gw.accounts.filter((item) => item.enabled).map((account) =>
    new OpenClawRoomRuntime(account, {fetchImpl: gw.room.fetchImpl, logger: quiet, status: gw.status, waitForRenewal: true}));
  try {
    for (const runtime of next) await runtime.initialize();
    await eventually(() => gw.phases("cmd-in-process").includes("completed"), {message: "completion never reported"});
    for (const runtime of next) await runtime.maintainPresence();
    await settle();
    assert.deepEqual(gw.phases("cmd-in-process"), ["restarting", "completed"]);
    assert.equal((await receiptNow(gw)).phase, "reported");
  } finally {
    for (const runtime of next) await runtime.close();
  }
});

test("R2-1 the registry, fence and incarnation live on globalThis and a re-imported module shares them", async () => {
  const holder = globalThis[Symbol.for("synthetic-sociality-room.connector-control.v1")];
  assert.ok(holder, "a process-global holder exists");
  const again = await import(`../src/connector-control.js?reimport=${Date.now()}`);
  assert.equal(again.connectorControl, control?.connectorControl);
  assert.equal(again.connectorControl, holder);
  control.connectorControl.raiseFence();
  try {
    assert.equal(again.connectorControl.fenced(), true);
  } finally {
    control.connectorControl.liftFence();
  }
});

test("R2-3 a registration granted connector.control.v1 declares the installation's memberships and origins", async () => {
  const room = fakeRoom();
  room.grant = true;
  const gw = await gateway({fetchRoom: room, extra: [{accountId: "elsewhere", roomId: "room-e", baseUrl: "https://other.example/api", enabled: true, running: false}]});
  open.push(gw);
  room.declarationAnswer = (call) => (call.roomId === "room-c" ? json({code: "not_found"}, 404) : undefined);
  await gw.start();
  await eventually(() => room.declarations.length >= 2, {message: "no declaration"});
  const installationId = JSON.parse(await readFile(join(gw.store, "installation.json"), "utf8")).installationId;
  for (const declaration of room.declarations) {
    const registration = room.registrations.find((item) => item.roomId === declaration.roomId);
    assert.equal(declaration.sessionId, registration.sessionId);
    assert.equal(declaration.body.installationId, installationId);
    assert.match(declaration.body.incarnation, /^[A-Za-z0-9._:-]{8,128}$/);
    assert.deepEqual([...declaration.body.memberships].sort(), ["member-room-a", "member-room-c", "member-room-o"]);
    assert.deepEqual(declaration.body.origins, [
      {origin: "https://other.example", bindings: 1, enabled: 1},
      {origin: "https://room.example", bindings: 3, enabled: 2},
    ]);
    assert.ok(!JSON.stringify(declaration.body).includes("fixture-credential"));
  }
  assert.equal(new Set(room.declarations.map((item) => item.body.incarnation)).size, 1);
  // A 404 is not fatal: both accounts are connected and heartbeat.
  await gw.runtimes.claw.maintainPresence();
  assert.ok(room.heartbeats.some((call) => call.roomId === "room-c"));
  // Not granted: no declaration.
  const plain = await started();
  await settle();
  assert.equal(plain.room.declarations.length, 0);
});
