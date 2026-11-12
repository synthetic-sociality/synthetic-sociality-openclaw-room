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
import {basename, dirname, join, resolve} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {loadState} from "./state.js";
import {RoomAPIError, RoomResponseError} from "./room-client.js";
import {resolveOpenClawBinary} from "./activation.js";

export const CONTROL_CAPABILITY = "connector.control.v1";
// OpenClaw 2026.7.1-2: `openclaw gateway restart --safe` asks the running
// gateway (RPC gateway.restart.request) for a restart after its active work
// drains (register-service-commands-CPkm3CFI.js:72, lifecycle-yIOsvBfe.js:209-235,
// restart-DJLfBy-X.js:96-139). Fixed argv; nothing from a Room payload.
export const RESTART_ARGV = Object.freeze(["gateway", "restart", "--safe"]);
const INSTALLATION_ID = /^openclaw-inst-[0-9a-f]{32}$/;
const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTIONS = new Set(["reconnect", "restart"]);
const OFFERED_STATES = new Set(["requested", "claimed", "reconnecting", "restarting"]);
// A delivery intent that is no longer work: terminal, or plainly quarantined.
const SETTLED_INTENTS = new Set(["posted", "superseded", "skipped", "quarantined"]);

const DEFAULTS = Object.freeze({
  accounts: null,
  loadState,
  spawner: spawn,
  binary: null,
  reconnectWaitMs: 90_000,
  drainWaitMs: 30_000,
  supervisorTimeoutMs: 60_000,
  restartGraceMs: 240_000,
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

const installationIds = new Map();

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
    this.clear();
  }

  clear() {
    this.generation += 1;
    this.options = {...DEFAULTS};
    this.runtimes = new Set();
    this.seen = new Set();
    this.fence = null;
    this.run = null;
    this.queued = null;
    this.drained = new Set();
    this.restartWait = null;
    this.after = null; // {commandId, task}
    this.reportingAfter = false;
  }

  configure(options = {}) {
    this.options = {...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))};
  }

  // The channel's account list (every binding of the gateway, enabled or not).
  setAccounts(accounts) {
    if (typeof accounts === "function") this.options.accounts = accounts;
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
    // P17-6: a runtime that started after the supervisor request belongs to
    // the restarted gateway (the host's in-process restart keeps the pid).
    if (this.restartWait && !this.drained.has(runtime)) this.restartWait.resolve(true);
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
      if (receipt.phase === "restarting") this.reportAfterRestart(runtime).catch(() => {});
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

  workInProgress() {
    return [...this.runtimes].some((runtime) => {
      try {
        return runtime.controlWorkInProgress?.() === true;
      } catch {
        return true;
      }
    });
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
    // P17-3: the fence from the claim on.
    this.raiseFence();
    try {
      try {
        await runtime.client.claimConnectorControl(runtime.state, sessionId, command.commandId, this.timeoutSignal());
      } catch (error) {
        // 409 control_claimed / control_closed (a sibling or another process
        // has it, or it ended), 404 or an old server: ignored quietly.
        if (!finalAnswer(error)) this.seen.delete(command.commandId);
        runtime.logger?.info?.(`Room connector control not claimed code=${answerCode(error)}`);
        return;
      }
      if (this.generation !== generation) return;
      const base = {commandId: command.commandId, action: command.action, requestedAt: command.requestedAt, claimedAt: now()};
      this.writeReceipt(runtime, {...base, phase: "claimed"});
      // P17-3: installation-wide guard; refuse at once, no waiting.
      if (this.workInProgress()) {
        this.writeReceipt(runtime, {...base, phase: "refused", code: "work_in_progress", completedAt: now()});
        this.liftFence();
        await this.report(runtime, sessionId, command.commandId, {phase: "refused", code: "work_in_progress"});
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

  // P17-6: the supported lifecycle only: the resolved `openclaw` binary with a
  // fixed argv, never a shell. Resolves with the exit code; rejects on a
  // spawn error or when it does not finish in time.
  requestSupervisor() {
    const binary = this.options.binary || resolveOpenClawBinary();
    return new Promise((resolveExit, reject) => {
      let child;
      try {
        child = this.options.spawner(binary, [...RESTART_ARGV], {detached: true, stdio: "ignore", env: process.env, shell: false, windowsHide: true});
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => reject(new Error("supervisor request timed out")), this.options.supervisorTimeoutMs);
      timer.unref?.();
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolveExit(Number.isInteger(code) ? code : 1); });
      child.unref?.();
    });
  }

  async restart(runtime, sessionId, base, generation) {
    await this.report(runtime, sessionId, base.commandId, {phase: "restarting"});
    const runtimes = this.liveRuntimes();
    const before = await this.inventory(runtimes, new Map());
    const startedAt = now();
    // The receipt is durable before the supervisor is asked.
    const persisted = this.writeReceipt(runtime, {...base, phase: "restarting", startedAt, pid: process.pid, before});
    // Clean drain: the listeners stop as on a disconnect; the fence is held.
    await Promise.all(runtimes.map((item) => item.suspendForControl(this.options.drainWaitMs)));
    this.drained = new Set(this.runtimes);
    let failed = !persisted;
    if (!failed) {
      try {
        failed = (await this.requestSupervisor()) !== 0;
      } catch {
        failed = true;
      }
    }
    if (this.generation !== generation) return;
    if (!failed) {
      // The gateway restarts after its own active-work deferral: a new
      // process (or, in the host's fallback, new runtimes in this one)
      // reports completion. Not restarted in time: the request failed.
      this.restartWait = deferred();
      const observed = await Promise.race([this.restartWait.promise, delay(this.options.restartGraceMs).then(() => false)]);
      this.restartWait = null;
      if (observed !== false || this.generation !== generation) return;
      // The host stopped every drained runtime: its restart is under way
      // (a re-imported plugin reports from the new runtimes).
      if (runtimes.length && runtimes.every((item) => item.closed)) return;
      failed = true;
    }
    runtime.logger?.warn?.("Room connector restart unavailable: supervisor_unavailable; reconnecting instead");
    this.writeReceipt(runtime, {...base, phase: "failed", code: "supervisor_unavailable", startedAt, completedAt: now(), pid: process.pid,
      before: {counts: before.counts}});
    const first = await this.report(runtime, sessionId, base.commandId, {phase: "failed", code: "supervisor_unavailable"});
    // Service is restored by a reconnect (no separate report).
    this.drained = new Set();
    const outcome = await this.reconnectAll(runtimes, {suspended: true});
    if (this.generation !== generation) return;
    this.liftFence();
    await this.waitRegistered(runtimes, outcome.since);
    // The Room accepts a restart failure only after a re-registration.
    if (!first.ok && first.code === "control_transition_invalid" && !runtime.closed && runtime.connectorSession?.sessionId) {
      await this.report(runtime, runtime.connectorSession.sessionId, base.commandId, {phase: "failed", code: "supervisor_unavailable"});
    }
  }

  // P17-7: before any listener of the restarted gateway starts, the after
  // inventory is computed from the state files, once.
  async beforeStart(runtime) {
    const receipt = this.receipt(runtime);
    if (receipt?.phase !== "restarting" || !receipt.before || this.drained.has(runtime)) return;
    if (this.after?.commandId !== receipt.commandId) {
      this.after = {commandId: receipt.commandId, task: this.inventory([], new Map())};
    }
    await this.after.task.catch(() => null);
  }

  registered(runtime) {
    const receipt = this.receipt(runtime);
    if (receipt?.phase !== "restarting" || this.drained.has(runtime)) return;
    this.reportAfterRestart(runtime).catch(() => {});
  }

  // P17-7: on the first authenticated registration of a snapshot binding of
  // the restarted gateway: completed (match) or failed / inventory_mismatch.
  async reportAfterRestart(runtime) {
    if (this.reportingAfter || this.drained.has(runtime)) return;
    const receipt = this.receipt(runtime);
    if (receipt?.phase !== "restarting" || !receipt.before) return;
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

export const connectorControl = new ConnectorControl();

export function configureConnectorControl(options) {
  connectorControl.configure(options);
}

export const connectorControlTest = {
  reset: async () => {
    connectorControl.restartWait?.resolve("cancelled");
    connectorControl.liftFence();
    connectorControl.clear();
    installationIds.clear();
  },
};
