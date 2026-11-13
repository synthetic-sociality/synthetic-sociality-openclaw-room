// Contract P17: owner connector control ("Reconnect agent" / "Restart agent").
//
// One controller per gateway process, shared by every Room account runtime of
// this installation (Aura and Claw run in one OpenClaw gateway). The Room
// offers a command in a register or heartbeat answer (`connectorControl`); the
// controller dedupes it per commandId, claims it once through the session of
// the binding that saw it, raises a fence, refuses at once when any binding has
// work in progress, and then reconnects every Room listener in process or asks
// the gateway's own supervisor for a safe restart. Control never edits cursors,
// journals, quarantined deliveries, recovery fences or credentials; it reads
// the stored binding inventory and writes only the status receipt.
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {closeSync, fsyncSync, openSync, readFileSync, writeSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {loadState} from "./state.js";
import {RoomAPIError, RoomResponseError} from "./room-client.js";
import {resolveOpenClawBinary} from "./activation.js";

export const CONTROL_CAPABILITY = "connector.control.v1";
// OpenClaw 2026.7.1-2: `openclaw gateway restart --safe` asks the running
// gateway (RPC gateway.restart.request) for a restart after its active work
// drains (register-service-commands-CPkm3CFI.js:72, lifecycle-yIOsvBfe.js:209-235,
// restart-DJLfBy-X.js:96-139). With --json it prints {ok, result, message,
// preflight, restart, warnings} (lifecycle-yIOsvBfe.js:221-229), result one of
// scheduled, deferred, coalesced (restart-DJLfBy-X.js:107); a failure throws,
// so the CLI exits non-zero. Fixed argv; nothing from a Room payload.
export const RESTART_ARGV = Object.freeze(["gateway", "restart", "--safe", "--json"]);
// R2-8: a request the host accepted (a restart is armed).
export const ACCEPTED_RESTART_STATUSES = Object.freeze(["scheduled", "deferred", "coalesced"]);
// R2-1: the process-wide controller (registry, fence, seen ids, receipt
// owner, incarnation) lives on globalThis; a re-imported module shares it.
export const CONTROL_HOLDER = Symbol.for("synthetic-sociality-room.connector-control.v1");
const STDOUT_LIMIT = 64 * 1024;
const INSTALLATION_ID = /^openclaw-inst-[0-9a-f]{32}$/;
const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTIONS = new Set(["reconnect", "restart"]);
const OFFERED_STATES = new Set(["requested", "claimed", "reconnecting", "restarting"]);
// A delivery intent that is no longer work: terminal, or plainly quarantined.
const SETTLED_INTENTS = new Set(["posted", "superseded", "skipped", "quarantined"]);

const DEFAULTS = Object.freeze({
  accounts: null,
  config: null, // the host's runtime config (gateway.reload.deferralTimeoutMs)
  loadState,
  spawner: spawn,
  binary: null,
  reconnectWaitMs: 90_000,
  drainWaitMs: 30_000,
  supervisorTimeoutMs: 60_000,
  requestTimeoutMs: 15_000,
});

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const delay = (milliseconds) => new Promise((resolveDelay) => {
  const timer = setTimeout(resolveDelay, milliseconds);
  timer.unref?.();
});

function deferred() {
  let resolveDeferred;
  const promise = new Promise((done) => { resolveDeferred = done; });
  return {promise, resolve: resolveDeferred};
}

export function untilSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, {once: true});
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolveWait(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

// P17-1: the Room state directory of the gateway (where status.json lives:
// the parent of `accounts/`, else the state file's own directory).
export function roomStateDirectory(stateFile) {
  const directory = dirname(resolve(String(stateFile)));
  return basename(directory) === "accounts" ? dirname(directory) : directory;
}

// R2-7: one opaque token per plugin load in a process: random value plus pid.
export function newIncarnation() {
  return `oc-${process.pid}-${randomBytes(12).toString("hex")}`;
}

function readInstallationId(path) {
  const value = JSON.parse(readFileSync(path, "utf8"))?.installationId;
  if (typeof value === "string" && INSTALLATION_ID.test(value)) return value;
  throw Object.assign(new Error("installation id is invalid"), {code: "EINVAL"});
}

// P17-1: one id per installation, `installation.json` beside status.json,
// created once (exclusive create, 0600), read on start, never rotated. Not a
// secret. "" when it cannot be read or created: the session is then not
// controllable (no id, no capability) and nothing else changes.
export function installationIdFor(directory) {
  if (!directory) return "";
  const key = resolve(directory);
  const installationIds = connectorControl.installationIds;
  if (installationIds.has(key)) return installationIds.get(key);
  const path = join(key, "installation.json");
  let id = "";
  try {
    id = readInstallationId(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const candidate = `openclaw-inst-${randomBytes(16).toString("hex")}`;
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeSync(fd, `${JSON.stringify({installationId: candidate})}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        id = candidate;
      } catch (createError) {
        if (createError?.code === "EEXIST") {
          try { id = readInstallationId(path); } catch { id = ""; }
        }
      }
    }
  }
  if (id) installationIds.set(key, id);
  return id;
}

export function deliveryIntentUnfinished(intent) {
  return !SETTLED_INTENTS.has(intent?.status) || ["pending", "blocked"].includes(intent?.lifecycleState);
}

// P17-4: the stored inventory of one binding. Ids, codes, counts and seqs
// only: never a credential, credential hash or renewal secret.
export function bindingInventory(account, state) {
  const accountId = String(account?.accountId ?? "");
  if (!state) return {accountId, stored: false, enabled: false, disabledReason: "state_unreadable"};
  const ledger = Object.entries(state.receiveLedger ?? {});
  const revoked = state.revoked === true;
  const enabled = account?.enabled !== false && state.enabled !== false && !revoked;
  const disabledReason = revoked ? String(state.revokedReason || "revoked")
    : account?.enabled === false ? "config_disabled" : state.enabled === false ? "state_disabled" : "";
  return {
    accountId,
    stored: true,
    roomId: String(state.roomId ?? ""),
    membershipId: String(state.membershipId ?? ""),
    baseUrl: String(state.baseUrl ?? ""),
    clientInstanceId: String(state.clientInstanceId ?? ""),
    identityVersion: state.identityVersion ?? null,
    enabled,
    disabledReason,
    revoked,
    cursor: Number.isSafeInteger(state.deliveredCursor) ? state.deliveredCursor : state.cursor,
    acknowledgedCursor: state.cursor,
    deliveryIntents: Object.entries(state.deliveryIntents ?? {})
      .map(([key, intent]) => [key, String(intent?.status ?? "")]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    inboxCount: ledger.length,
    pendingCount: ledger.filter(([, entry]) => entry?.status === "received").length,
    missedSourceCount: Array.isArray(state.missedSources) ? state.missedSources.length : 0,
    quarantinedSeqs: ledger.filter(([, entry]) => entry?.status === "quarantined").map(([seq]) => Number(seq)).sort((a, b) => a - b),
    headSeq: Number.isSafeInteger(state.headSeq) ? state.headSeq : null,
  };
}

// R2-2: stored work of a binding no listener runs (disabled, revoked but
// stored, or enabled and not running): a renewal journal or an unfinished
// delivery intent.
export function storedWorkInProgress(state) {
  return Boolean(state?.credentialRotation)
    || Object.values(state?.deliveryIntents ?? {}).some(deliveryIntentUnfinished)
    // P17-3 (Hermes parity, renewal.quiescent): an event read but not yet processed.
    || Object.values(state?.receiveLedger ?? {}).some((entry) => entry?.status === "received");
}

// The origin (scheme://host[:port]) of a Room base URL, or "".
export function roomOrigin(baseUrl) {
  try {
    const origin = new URL(String(baseUrl)).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

// R2-8: the host CLI's --json answer; null when there is none.
export function parseHostAnswer(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const start = raw.search(/^\{/m);
  const end = raw.lastIndexOf("}");
  if (start > 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // not JSON
    }
  }
  return null;
}

// R2-8b: the window the Room server allows the restart: the host's own
// safe-restart deferral bound plus a 300 s margin for the drain and the new
// process. Host 2026.7.1-2 restart-BF68zBs3.js:401-405: a non-number uses the
// default 300000 ms (:117); 0 or less waits indefinitely (the field's
// maximum, 86400, is sent; the server clamps it).
export const RESTART_MARGIN_SECONDS = 300;
export const DEFAULT_DEFERRAL_SECONDS = 300;
export function restartWithinSeconds(config) {
  let timeoutMs;
  try {
    timeoutMs = config?.gateway?.reload?.deferralTimeoutMs;
  } catch {
    timeoutMs = undefined;
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_DEFERRAL_SECONDS + RESTART_MARGIN_SECONDS;
  if (timeoutMs <= 0) return 86_400;
  return Math.min(86_400, Math.max(60, Math.floor(timeoutMs / 1000) + RESTART_MARGIN_SECONDS));
}

export function inventoryCounts(bindings) {
  const enabled = bindings.filter((binding) => binding.enabled).length;
  return {bindings: bindings.length, enabled, disabled: bindings.length - enabled};
}

// P17-2: a valid offer, or null (malformed: ignored, never an error).
export function parseControlCommand(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const {commandId, action, state} = raw;
  if (typeof commandId !== "string" || !COMMAND_ID.test(commandId)) return null;
  if (typeof action !== "string" || !ACTIONS.has(action)) return null;
  if (typeof state !== "string" || !OFFERED_STATES.has(state)) return null;
  const requestedAt = typeof raw.requestedAt === "string" && raw.requestedAt.length <= 64 ? raw.requestedAt : "";
  return {commandId, action, state, requestedAt};
}

// A Room answer that settles the request for good (404, 409, any other coded
// 4xx, or an old server's non-JSON answer); a network failure, 5xx or 429 may
// be retried at the next offer.
function finalAnswer(error) {
  if (error instanceof RoomAPIError) return error.status >= 400 && error.status < 500 && error.status !== 429;
  if (error instanceof RoomResponseError) return !(error.status >= 500 || error.status === 429);
  return false;
}
const answerCode = (error) => (error instanceof RoomAPIError ? error.refusalCode || error.code || `http_${error.status}` : String(error?.name ?? "error"));

class ConnectorControl {
  constructor() {
    this.generation = 0;
    this.scopeKnown = true;
    this.clear();
  }

  // A fresh process state (constructor; tests simulate a new process).
  clear() {
    this.generation += 1;
    this.options = {...DEFAULTS};
    this.runtimes = new Set();
    this.seen = new Set();
    this.fence = null;
    this.run = null;
    this.queued = null;
    this.acceptedRestart = null;
    this.after = null; // {commandId, task}
    this.reportingAfter = false;
    this.installationIds = new Map();
    this.incarnation = newIncarnation();
  }

  // R2-7: the host closed this gateway (gateway_stop runs on every close,
  // the in-process restart included: server.impl-qYPVZMND.js:2817-2822).
  // Whatever starts after it is the next incarnation; a restart this
  // incarnation armed has happened, so its fence ends with it.
  gatewayStopped() {
    this.incarnation = newIncarnation();
    const accepted = this.acceptedRestart;
    this.acceptedRestart = null;
    accepted?.resolve();
    this.liftFence();
  }

  configure(options = {}) {
    this.options = {...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))};
  }

  // The channel's account list (every binding of the gateway, enabled or not).
  setAccounts(accounts) {
    if (typeof accounts === "function") this.options.accounts = accounts;
  }

  // R2-8b: the host's runtime config, read when a restart is reported.
  setConfig(config) {
    if (typeof config === "function") this.options.config = config;
  }

  restartWindow() {
    let config;
    try {
      config = this.options.config?.();
    } catch {
      config = undefined;
    }
    return restartWithinSeconds(config);
  }

  fenced() {
    return Boolean(this.fence);
  }

  raiseFence() {
    if (!this.fence) this.fence = deferred();
  }

  liftFence() {
    const fence = this.fence;
    this.fence = null;
    fence?.resolve();
  }

  // P17-3: no new dispatch, turn claim or renewal starts while the fence is up.
  async fenceWait(signal) {
    while (this.fence) await untilSignal(this.fence.promise, signal);
  }

  attach(runtime) {
    this.runtimes.add(runtime);
  }

  detach(runtime) {
    this.runtimes.delete(runtime);
  }

  liveRuntimes() {
    return [...this.runtimes].filter((runtime) => !runtime.closed && runtime.state && runtime.connectorSession);
  }

  statusOf(runtime) {
    return runtime?.status ?? [...this.runtimes].find((item) => item.status)?.status ?? null;
  }

  receipt(runtime) {
    try {
      return this.statusOf(runtime)?.connectorControlReceipt?.() ?? null;
    } catch {
      return null;
    }
  }

  writeReceipt(runtime, receipt) {
    try {
      return this.statusOf(runtime)?.setConnectorControl?.(receipt) === true;
    } catch {
      return false;
    }
  }

  timeoutSignal() {
    return AbortSignal.timeout(this.options.requestTimeoutMs);
  }

  // P17-2: an offer from a register or heartbeat answer. Never throws.
  offer(runtime, raw) {
    const command = parseControlCommand(raw);
    if (!command || runtime?.closed) return;
    const receipt = this.receipt(runtime);
    if (receipt?.commandId === command.commandId) {
      // P17-7: a restart this installation already ran; report, never re-run.
      this.reportAfterRestart(runtime).catch(() => {});
      return;
    }
    if (this.seen.has(command.commandId) || command.state !== "requested") return;
    // A presence fallback (heartbeat only) executes control only when no
    // native runtime of this gateway is running.
    if (runtime.controlRole === "fallback" && [...this.runtimes].some((item) => item.controlRole !== "fallback" && !item.closed)) return;
    if (this.run) {
      this.queued = {runtime, raw};
      return;
    }
    this.seen.add(command.commandId);
    const generation = this.generation;
    this.run = this.execute(runtime, command, generation)
      .catch((error) => runtime.logger?.warn?.(`Room connector control failed: ${String(error?.name ?? "Error")}`))
      .finally(() => {
        if (this.generation !== generation) return;
        this.run = null;
        const next = this.queued;
        this.queued = null;
        if (next) this.offer(next.runtime, next.raw);
      });
  }

  listedAccounts() {
    try {
      return this.options.accounts?.() ?? [];
    } catch {
      return null;
    }
  }

  // R2-2: the guard over the whole process: every running binding's live
  // work, and every other stored binding (disabled, revoked but stored,
  // enabled and not running) read from its state file. null, or the code.
  async guard() {
    if (!this.scopeKnown) return "connector_scope_unknown";
    const live = this.liveRuntimes();
    for (const runtime of [...this.runtimes]) {
      try {
        if (runtime.controlWorkInProgress?.() === true) return "work_in_progress";
      } catch {
        return "work_in_progress";
      }
    }
    const listed = this.listedAccounts();
    if (listed === null) return "connector_scope_unknown";
    const running = new Set(live.map((runtime) => resolve(String(runtime.account.stateFile))));
    const seenFiles = new Set();
    for (const account of [...listed, ...[...this.runtimes].map((runtime) => runtime.account)]) {
      if (!account?.stateFile) continue;
      const file = resolve(String(account.stateFile));
      if (running.has(file) || seenFiles.has(file)) continue;
      seenFiles.add(file);
      const stored = await readStored(file);
      if (stored === undefined) continue; // never joined: no binding
      if (stored === null) return "connector_scope_unknown";
      if (storedWorkInProgress(stored)) return "work_in_progress";
    }
    return null;
  }

  // R2-3: every stored binding of the process (running: its live object).
  async storedBindings() {
    const bindings = [];
    const files = new Set();
    const live = this.liveRuntimes();
    for (const account of [...(this.listedAccounts() ?? []), ...live.map((runtime) => runtime.account)]) {
      if (!account?.stateFile) continue;
      const file = resolve(String(account.stateFile));
      if (files.has(file)) continue;
      files.add(file);
      const runtime = live.find((item) => resolve(String(item.account.stateFile)) === file);
      const state = runtime?.state ?? await readStored(file);
      if (!state) continue;
      bindings.push({membershipId: String(state.membershipId ?? ""), origin: roomOrigin(state.baseUrl),
        enabled: account.enabled !== false && state.enabled !== false && state.revoked !== true});
    }
    return bindings;
  }

  // R2-3: after a registration the Room granted connector.control.v1.
  async declare(runtime, installationId) {
    const sessionId = runtime.connectorSession?.sessionId;
    if (!sessionId || !installationId || !runtime.client?.declareConnectorInstallation) return;
    try {
      const bindings = await this.storedBindings();
      const own = roomOrigin(runtime.state?.baseUrl);
      const memberships = [...new Set(bindings.filter((item) => item.origin && item.origin === own && item.membershipId)
        .map((item) => item.membershipId))].sort();
      const origins = new Map();
      for (const item of bindings) {
        if (!item.origin) continue;
        const entry = origins.get(item.origin) ?? {origin: item.origin, bindings: 0, enabled: 0};
        entry.bindings += 1;
        if (item.enabled) entry.enabled += 1;
        origins.set(item.origin, entry);
      }
      const body = {installationId, incarnation: runtime.incarnation, memberships,
        origins: [...origins.values()].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0))};
      await runtime.client.declareConnectorInstallation(runtime.state, sessionId, body, this.timeoutSignal());
    } catch (error) {
      // 404/409 or an unreachable Room: never fatal.
      runtime.logger?.info?.(`Room connector installation declaration not accepted code=${answerCode(error)}`);
    }
  }

  async report(runtime, sessionId, commandId, body) {
    try {
      await runtime.client.reportConnectorControl(runtime.state, sessionId, commandId, body, this.timeoutSignal());
      return {ok: true, final: true, code: ""};
    } catch (error) {
      runtime.logger?.info?.(`Room connector control report ${body.phase} not accepted code=${answerCode(error)}`);
      return {ok: false, final: finalAnswer(error), code: answerCode(error)};
    }
  }

  async execute(runtime, command, generation) {
    const sessionId = runtime.connectorSession?.sessionId;
    if (!sessionId || !runtime.client?.claimConnectorControl) {
      this.seen.delete(command.commandId);
      return;
    }
    // A3 (Hermes parity, R2-3): declaration, then claim. The declaration of
    // this registration is answered (or failed) before the claim is sent.
    if (runtime.controlDeclaration) await runtime.controlDeclaration;
    if (this.generation !== generation || runtime.closed) {
      this.seen.delete(command.commandId);
      return;
    }
    // P17-3: the fence from the claim on.
    this.raiseFence();
    try {
      try {
        await runtime.client.claimConnectorControl(runtime.state, sessionId, command.commandId, this.timeoutSignal());
      } catch (error) {
        // 409 control_claimed / control_closed (a sibling or another process
        // has it, or it ended), 404 or an old server: ignored quietly. A
        // control_transition_invalid (the claim reached the Room before the
        // declaration) is asked again at the next offer, as Hermes does.
        if (!finalAnswer(error) || answerCode(error) === "control_transition_invalid") this.seen.delete(command.commandId);
        runtime.logger?.info?.(`Room connector control not claimed code=${answerCode(error)}`);
        return;
      }
      if (this.generation !== generation) return;
      const base = {commandId: command.commandId, action: command.action, requestedAt: command.requestedAt, claimedAt: now()};
      this.writeReceipt(runtime, {...base, phase: "claimed"});
      // P17-3, R2-2: process-wide guard; refuse at once, no waiting.
      const refusal = await this.guard();
      if (this.generation !== generation) return;
      if (refusal) {
        this.writeReceipt(runtime, {...base, phase: "refused", code: refusal, completedAt: now()});
        this.liftFence();
        await this.report(runtime, sessionId, command.commandId, {phase: "refused", code: refusal});
        return;
      }
      if (command.action === "reconnect") await this.reconnect(runtime, sessionId, base, generation);
      else await this.restart(runtime, sessionId, base, generation);
    } finally {
      if (this.generation === generation) this.liftFence();
    }
  }

  // P17-4: every binding of the gateway, enabled and disabled. A running
  // binding is read from its live object, any other from its state file once.
  async inventory(runtimes, fileStates) {
    const accounts = [];
    const files = new Set();
    let listed = [];
    try {
      listed = this.options.accounts?.() ?? [];
    } catch {
      listed = [];
    }
    for (const account of [...listed, ...runtimes.map((runtime) => runtime.account)]) {
      if (!account?.stateFile) continue;
      const file = resolve(String(account.stateFile));
      if (files.has(file)) continue;
      files.add(file);
      accounts.push(account);
    }
    const bindings = [];
    for (const account of accounts) {
      const file = resolve(String(account.stateFile));
      const running = runtimes.find((runtime) => resolve(String(runtime.account.stateFile)) === file);
      let state = running?.state ?? null;
      if (!running) {
        if (!fileStates.has(file)) fileStates.set(file, await this.options.loadState(account.stateFile).catch(() => null));
        state = fileStates.get(file);
      }
      bindings.push(bindingInventory(account, state));
    }
    bindings.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
    return {counts: inventoryCounts(bindings), bindings};
  }

  async waitRegistered(runtimes, since) {
    const deadline = Date.now() + this.options.reconnectWaitMs;
    for (;;) {
      if (runtimes.every((runtime) => runtime.closed || runtime.registeredAt >= since)) return true;
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
  }

  // P17-5: stop and await every Room listener, heartbeat and enrollment task,
  // reload each state file once, adopt it into the live object, start the
  // listeners again with a forced registration.
  async reconnectAll(runtimes, {suspended = false} = {}) {
    let drained = true;
    if (!suspended) drained = (await Promise.all(runtimes.map((runtime) => runtime.suspendForControl(this.options.drainWaitMs)))).every(Boolean);
    const fileStates = new Map();
    const before = await this.inventory(runtimes, fileStates);
    let reloaded = true;
    for (const runtime of runtimes) {
      try {
        await runtime.adoptReloadedState(await this.options.loadState(runtime.account.stateFile));
      } catch {
        reloaded = false;
      }
    }
    const after = await this.inventory(runtimes, fileStates);
    const since = Date.now();
    await Promise.all(runtimes.map((runtime) => runtime.resumeAfterControl()));
    return {before, after, match: isDeepStrictEqual(before.bindings, after.bindings), since, complete: drained && reloaded};
  }

  async reconnect(runtime, sessionId, base, generation) {
    await this.report(runtime, sessionId, base.commandId, {phase: "reconnecting"});
    const startedAt = now();
    this.writeReceipt(runtime, {...base, phase: "reconnecting", startedAt});
    const runtimes = this.liveRuntimes();
    const outcome = await this.reconnectAll(runtimes);
    if (this.generation !== generation) return;
    this.liftFence();
    const registered = await this.waitRegistered(runtimes, outcome.since);
    if (this.generation !== generation) return;
    const inventory = {before: outcome.before.counts, after: outcome.after.counts, match: outcome.match};
    const body = !outcome.match ? {phase: "failed", code: "inventory_mismatch", inventory}
      : !(registered && outcome.complete) ? {phase: "failed", code: "reconnect_incomplete", inventory}
        : {phase: "completed", inventory};
    this.writeReceipt(runtime, {...base, phase: body.phase, ...(body.code ? {code: body.code} : {}), startedAt, completedAt: now(),
      before: {counts: outcome.before.counts}, after: {counts: outcome.after.counts}, match: outcome.match});
    await this.report(runtime, sessionId, base.commandId, body);
  }

  // P17-6, R2-8: the supported lifecycle only: the resolved `openclaw`
  // binary with a fixed argv, never a shell. The outcome: accepted (the host
  // answered scheduled, deferred or coalesced), rejected (an explicit error
  // answer, a non-zero exit without an accepted status, a spawn error) or
  // unconfirmed (the CLI hung and was killed, or exited 0 without a status).
  requestSupervisor() {
    const binary = this.options.binary || resolveOpenClawBinary();
    return new Promise((resolveOutcome) => {
      let child;
      let settled = false;
      const done = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOutcome(outcome);
      };
      const timer = setTimeout(() => {
        try { child?.kill("SIGKILL"); } catch {}
        done({kind: "unconfirmed", reason: "timeout"});
      }, this.options.supervisorTimeoutMs);
      timer.unref?.();
      try {
        child = this.options.spawner(binary, [...RESTART_ARGV], {detached: true, stdio: ["ignore", "pipe", "ignore"], env: process.env, shell: false, windowsHide: true});
      } catch {
        done({kind: "rejected", reason: "spawn_error"});
        return;
      }
      let stdout = "";
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => { if (stdout.length < STDOUT_LIMIT) stdout += String(chunk).slice(0, STDOUT_LIMIT - stdout.length); });
      child.once("error", () => done({kind: "rejected", reason: "spawn_error"}));
      child.once("close", (code) => {
        const answer = parseHostAnswer(stdout);
        const status = typeof answer?.result === "string" ? answer.result : "";
        if (answer?.ok !== false && ACCEPTED_RESTART_STATUSES.includes(status)) done({kind: "accepted", status});
        else if (answer && (answer.ok === false || answer.error !== undefined)) done({kind: "rejected", reason: "host_error"});
        else if (code !== 0) done({kind: "rejected", reason: "exit_code"});
        else done({kind: "unconfirmed", reason: "no_status"});
      });
    });
  }

  async restart(runtime, sessionId, base, generation) {
    await this.report(runtime, sessionId, base.commandId, {phase: "restarting", restartWithinSeconds: this.restartWindow()});
    const runtimes = this.liveRuntimes();
    const before = await this.inventory(runtimes, new Map());
    const startedAt = now();
    // R2-7: the receipt holds the claim incarnation; it is durable before
    // the supervisor is asked.
    const receipt = {...base, phase: "restarting", startedAt, pid: process.pid, incarnation: this.incarnation, before};
    const persisted = this.writeReceipt(runtime, receipt);
    // Clean drain: the listeners stop as on a disconnect; the fence is held.
    await Promise.all(runtimes.map((item) => item.suspendForControl(this.options.drainWaitMs)));
    const outcome = persisted ? await this.requestSupervisor() : {kind: "rejected", reason: "receipt_unwritten"};
    if (this.generation !== generation) return;
    if (outcome.kind !== "rejected") {
      // R2-8: accepted, or possibly armed: keep the fence, the drained
      // listeners and the receipt; nothing is reported here. Completion is
      // the next incarnation's (P17-7); a server deadline ends it otherwise.
      if (outcome.kind === "accepted") this.writeReceipt(runtime, {...receipt, hostStatus: outcome.status, acceptedAt: now()});
      else {
        runtime.logger?.warn?.(`Room connector restart unconfirmed (${outcome.reason}); the fence stays until the gateway restarts`);
        this.writeReceipt(runtime, {...receipt, phase: "restart_unconfirmed", unconfirmedAt: now()});
      }
      this.acceptedRestart = deferred();
      await this.acceptedRestart.promise;
      return;
    }
    runtime.logger?.warn?.(`Room connector restart unavailable (${outcome.reason}): supervisor_unavailable; reconnecting instead`);
    this.writeReceipt(runtime, {...base, phase: "failed", code: "supervisor_unavailable", startedAt, completedAt: now(), pid: process.pid,
      incarnation: this.incarnation, before: {counts: before.counts}});
    const first = await this.report(runtime, sessionId, base.commandId, {phase: "failed", code: "supervisor_unavailable"});
    // Service is restored by a reconnect (no separate report).
    const restored = await this.reconnectAll(runtimes, {suspended: true});
    if (this.generation !== generation) return;
    this.liftFence();
    await this.waitRegistered(runtimes, restored.since);
    // The Room accepts a restart failure only after a re-registration.
    if (!first.ok && first.code === "control_transition_invalid" && !runtime.closed && runtime.connectorSession?.sessionId) {
      await this.report(runtime, runtime.connectorSession.sessionId, base.commandId, {phase: "failed", code: "supervisor_unavailable"});
    }
  }

  // P17-7: before any listener of the restarted gateway starts, the after
  // inventory is computed from the state files, once.
  async beforeStart(runtime) {
    const receipt = this.receipt(runtime);
    if (!this.completesRestart(runtime, receipt)) return;
    if (this.after?.commandId !== receipt.commandId) {
      this.after = {commandId: receipt.commandId, task: this.inventory([], new Map())};
    }
    await this.after.task.catch(() => null);
  }

  registered(runtime) {
    if (!this.completesRestart(runtime, this.receipt(runtime))) return;
    this.reportAfterRestart(runtime).catch(() => {});
  }

  // R2-7: only a different incarnation completes a restart; a presence
  // fallback, a channel restart or a re-attached account of the claiming
  // incarnation never does (and never resumes the drained listeners).
  completesRestart(runtime, receipt) {
    if (!receipt?.before || !["restarting", "restart_unconfirmed"].includes(receipt.phase)) return false;
    const incarnation = typeof runtime?.incarnation === "string" ? runtime.incarnation : "";
    return typeof receipt.incarnation === "string" && receipt.incarnation
      ? Boolean(incarnation) && receipt.incarnation !== incarnation
      : receipt.pid !== process.pid;
  }

  // P17-7: on the first authenticated registration of a snapshot binding of
  // the restarted gateway: completed (match) or failed / inventory_mismatch.
  async reportAfterRestart(runtime) {
    if (this.reportingAfter) return;
    const receipt = this.receipt(runtime);
    if (!this.completesRestart(runtime, receipt)) return;
    const snapshot = (receipt.before.bindings ?? []).some((binding) => binding.roomId === runtime.state?.roomId
      && binding.membershipId === runtime.state?.membershipId);
    const sessionId = runtime.connectorSession?.sessionId;
    if (!snapshot || !sessionId) return;
    this.reportingAfter = true;
    try {
      if (this.after?.commandId !== receipt.commandId) this.after = {commandId: receipt.commandId, task: this.inventory([], new Map())};
      const after = await this.after.task;
      const match = isDeepStrictEqual(receipt.before.bindings, after.bindings);
      const inventory = {before: receipt.before.counts, after: after.counts, match};
      const body = match ? {phase: "completed", inventory} : {phase: "failed", code: "inventory_mismatch", inventory};
      const result = await this.report(runtime, sessionId, receipt.commandId, body);
      // Accepted, or answered as closed or repeated: reported, never again.
      if (result.ok || result.final) {
        this.writeReceipt(runtime, {commandId: receipt.commandId, action: receipt.action, phase: "reported",
          requestedAt: receipt.requestedAt ?? "", claimedAt: receipt.claimedAt ?? "", startedAt: receipt.startedAt ?? "",
          reportedAt: now(), result: body.phase, ...(body.code ? {code: body.code} : {}),
          ...(result.ok ? {} : {reportCode: result.code}), before: {counts: receipt.before.counts}, after: {counts: after.counts}, match});
      }
    } finally {
      this.reportingAfter = false;
    }
  }
}

// undefined: no state file (never joined); null: unreadable; else the
// stored JSON as written (read only, never validated into or written back).
async function readStored(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function processController() {
  try {
    if (!globalThis[CONTROL_HOLDER]) {
      Object.defineProperty(globalThis, CONTROL_HOLDER, {value: new ConnectorControl(), configurable: false, enumerable: false, writable: false});
    }
    const holder = globalThis[CONTROL_HOLDER];
    if (holder && typeof holder.offer === "function") return holder;
  } catch {
    // fall through
  }
  // R2-1: no process-global holder: control refuses with connector_scope_unknown.
  const isolated = new ConnectorControl();
  isolated.scopeKnown = false;
  return isolated;
}

export const connectorControl = processController();

export function configureConnectorControl(options) {
  connectorControl.configure(options);
}

export const connectorControlTest = {
  reset: async () => {
    connectorControl.acceptedRestart?.resolve();
    connectorControl.liftFence();
    connectorControl.clear();
  },
};
