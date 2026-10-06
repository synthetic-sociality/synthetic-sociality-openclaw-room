// Contract P2c-4: machine-readable local status for the host watchdog.
//
// One status.json per installation, next to the accounts directory, mode 0600,
// replaced atomically. The schema is the delivery contract appendix "Local
// status file (P2c-4)", identical in Hermes. It never holds a credential,
// renewal secret, message body, reply text or prompt: every value is a fixed
// code, an identifier, a number or a time.
import {randomUUID} from "node:crypto";
import {chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

export const STATUS_SCHEMA = "synthetic-sociality-room-status-v1";
const CONNECTION_STATES = new Set(["connecting", "connected", "reconnecting", "inactive", "stopped"]);
// Contract P2c-6: the tool names that count as web reading (Hermes
// WEB_READ_TOOL_NAMES, the same list).
export const WEB_READ_TOOL_NAMES = Object.freeze(["browser", "browser_navigate", "web_extract", "web_fetch", "web_search"]);
// Contract P2c-4 (ISSUE-023): why a dispatch waited on the host.
export const GATE_WAIT_REASONS = new Set(["", "host_run_busy", "host_session_unobservable", "held_by_moderator"]);
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function code(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return CODE.test(text) ? text : "unknown_error";
}

export class LocalStatus {
  constructor(path, {plugin = "openclaw", version, hostLabel, logger} = {}) {
    this.path = path;
    this.logger = logger;
    this.failed = false;
    this.data = {
      schema: STATUS_SCHEMA,
      plugin,
      version: String(version ?? ""),
      pluginLoaded: true,
      hostLabel: String(hostLabel ?? ""),
      pid: process.pid,
      startedAt: now(),
      updatedAt: now(),
      secretStore: "isolated",
      secretStoreReasons: [],
      secretIsolationEnforced: false,
      webRead: "unknown",
      webReadTools: [],
      documentTool: "unknown",
      rooms: {},
    };
    // Contract P2c-3a: when the current outage of a Room began (process
    // memory only; never written).
    this.outageStarted = new Map();
    // Contract P2c-3b: Rooms whose membership is inactive (muted), and each
    // Room's own connection state under that mark (P2c-4).
    this.inactive = new Set();
    this.connection = new Map();
  }

  // Contract P2c-6: a web reading tool the host itself named in a Room turn.
  // OpenClaw 2026.7.1-2 gives a channel plugin no resolved tool list, so the
  // value stays "unknown" until such a call; it is never "unavailable" here.
  noteWebReadTool(toolName) {
    const name = String(toolName ?? "");
    if (!WEB_READ_TOOL_NAMES.includes(name) || this.data.webReadTools.includes(name)) return;
    this.data.webRead = "available";
    this.data.webReadTools = [...this.data.webReadTools, name].sort();
    this.write();
  }

  // Contract P7d-6: OpenClaw cannot see the Room-turn tool selection; the
  // value stays "unknown" until a Room session calls the document tool.
  setDocumentTool(value) {
    const next = value === "available" ? "available" : "unknown";
    if (this.data.documentTool === next) return;
    this.data.documentTool = next;
    this.write();
  }

  snapshot() {
    return structuredClone(this.data);
  }

  setSecretStore(value, reasons = [], {enforced = false} = {}) {
    const reachable = value === "reachable";
    this.data.secretStore = reachable ? "reachable" : "isolated";
    this.data.secretStoreReasons = reachable ? reasons.map(code).filter(Boolean) : [];
    this.data.secretIsolationEnforced = Boolean(enforced);
    this.write();
  }

  setLoaded(loaded) {
    this.data.pluginLoaded = Boolean(loaded);
    this.write();
  }

  // Update one Room entry; write only when something changed.
  room(roomId, membershipId = "", {connection, errorCode, connected = false, registered = false, inactive,
    gateWaitSeconds, gateWaitReason, ledger} = {}) {
    if (!roomId) return;
    const entry = this.data.rooms[roomId] ??= {
      membershipId: String(membershipId ?? ""),
      connection: "connecting",
      lastConnectedAt: null,
      lastErrorCode: "",
      lastErrorAt: null,
      lastGateWaitSeconds: 0,
      lastGateWaitAt: null,
      lastGateWaitReason: "",
      lastReconnectedAt: null,
      lastOutageSeconds: 0,
      acknowledgedSeq: 0,
      holeSeqs: [],
      quarantinedSeqs: [],
      ledgerCode: "",
    };
    const before = JSON.stringify(entry);
    if (membershipId) entry.membershipId = String(membershipId);
    const key = String(roomId);
    // Contract P2c-4: `connection` is the connection's own state, with
    // `inactive` shown over `connected` only while the membership is muted
    // (P2c-3b); `stopped` and `reconnecting` win over it. A stop or a new
    // registration (a new runtime, an unmute) ends the inactive mark.
    if (inactive === true) this.inactive.add(key);
    else if (inactive === false || connection === "stopped" || (connected && registered)) this.inactive.delete(key);
    let state = this.connection.get(key) ?? entry.connection;
    if (connection === "inactive") state = "connected";
    else if (CONNECTION_STATES.has(connection)) state = connection;
    // Contract P2c-3a: the first failure of an outage starts it.
    if (connection === "reconnecting" && !this.outageStarted.has(key)) this.outageStarted.set(key, performance.now());
    else if (connection === "stopped" || connection === "inactive") this.outageStarted.delete(key);
    if (connected) {
      state = "connected";
      entry.lastConnectedAt = now();
      const started = this.outageStarted.get(key);
      this.outageStarted.delete(key);
      if (started !== undefined && registered) {
        // Re-established by an accepted registration after a failure; a
        // heartbeat that survived ends the outage only.
        entry.lastReconnectedAt = entry.lastConnectedAt;
        entry.lastOutageSeconds = Math.round(Math.max(0, performance.now() - started) / 100) / 10;
      }
    }
    this.connection.set(key, state);
    entry.connection = state === "connected" && this.inactive.has(key) ? "inactive" : state;
    if (errorCode !== undefined) {
      entry.lastErrorCode = code(errorCode);
      if (entry.lastErrorCode) entry.lastErrorAt = now();
    }
    if (ledger) {
      // Contract P3-3: holes and quarantines as codes and seqs only.
      entry.acknowledgedSeq = Number(ledger.acknowledgedSeq) || 0;
      entry.holeSeqs = (ledger.holeSeqs ?? []).map(Number).slice(0, 32);
      entry.quarantinedSeqs = (ledger.quarantinedSeqs ?? []).map(Number).slice(0, 32);
      entry.ledgerCode = code(ledger.ledgerCode ?? "");
    }
    if (gateWaitSeconds !== undefined) {
      entry.lastGateWaitSeconds = Math.round(Math.max(0, Number(gateWaitSeconds) || 0) * 10) / 10;
      entry.lastGateWaitAt = now();
      entry.lastGateWaitReason = GATE_WAIT_REASONS.has(gateWaitReason) ? gateWaitReason : "";
    }
    if (JSON.stringify(entry) !== before) this.write();
  }

  write() {
    this.data.updatedAt = now();
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const directory = dirname(this.path);
    const temporary = join(directory, `.status-${randomUUID()}.tmp`);
    try {
      // Contract P3-5: create the state's directory 0700 when it is missing,
      // never a filesystem root or a top-level directory (P2a-5).
      if (!existsSync(directory)) {
        if (resolve(directory).split(/[\\/]+/u).filter(Boolean).length < 2) throw Object.assign(new Error("top-level"), {code: "EPERM"});
        mkdirSync(directory, {recursive: true, mode: 0o700});
        chmodSync(directory, 0o700);
      }
      if (!statSync(directory).isDirectory()) return false;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (!this.failed) {
        this.failed = true;
        this.logger?.warn?.(`Room local status could not be written: ${error?.code ?? "error"}`);
      }
      return false;
    }
    this.failed = false;
    return true;
  }
}

const writers = new Map();

// One writer per status file in this process, shared by its accounts.
export function localStatusFor(path, options) {
  let writer = writers.get(path);
  if (!writer) {
    writer = new LocalStatus(path, options);
    writers.set(path, writer);
  }
  return writer;
}

export function resetLocalStatusWriters() {
  writers.clear();
}

