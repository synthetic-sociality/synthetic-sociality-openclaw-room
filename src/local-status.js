// Contract P2c-4: machine-readable local status for the host watchdog.
//
// One status.json per installation, next to the accounts directory, mode 0600,
// replaced atomically. The schema is the delivery contract appendix "Local
// status file (P2c-4)", identical in Hermes. It never holds a credential,
// renewal secret, message body, reply text or prompt: every value is a fixed
// code, an identifier, a number or a time.
import {randomUUID} from "node:crypto";
import {closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync} from "node:fs";
import {dirname, join} from "node:path";

export const STATUS_SCHEMA = "synthetic-sociality-room-status-v1";
const CONNECTION_STATES = new Set(["connecting", "connected", "reconnecting", "stopped"]);
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
      rooms: {},
    };
  }

  snapshot() {
    return structuredClone(this.data);
  }

  setSecretStore(value) {
    this.data.secretStore = value === "reachable" ? "reachable" : "isolated";
    this.write();
  }

  setLoaded(loaded) {
    this.data.pluginLoaded = Boolean(loaded);
    this.write();
  }

  // Update one Room entry; write only when something changed.
  room(roomId, membershipId = "", {connection, errorCode, connected = false, gateWaitSeconds} = {}) {
    if (!roomId) return;
    const entry = this.data.rooms[roomId] ??= {
      membershipId: String(membershipId ?? ""),
      connection: "connecting",
      lastConnectedAt: null,
      lastErrorCode: "",
      lastErrorAt: null,
      lastGateWaitSeconds: 0,
      lastGateWaitAt: null,
    };
    const before = JSON.stringify(entry);
    if (membershipId) entry.membershipId = String(membershipId);
    if (CONNECTION_STATES.has(connection)) entry.connection = connection;
    if (connected) {
      entry.connection = "connected";
      entry.lastConnectedAt = now();
    }
    if (errorCode !== undefined) {
      entry.lastErrorCode = code(errorCode);
      if (entry.lastErrorCode) entry.lastErrorAt = now();
    }
    if (gateWaitSeconds !== undefined) {
      entry.lastGateWaitSeconds = Math.round(Math.max(0, Number(gateWaitSeconds) || 0) * 10) / 10;
      entry.lastGateWaitAt = now();
    }
    if (JSON.stringify(entry) !== before) this.write();
  }

  write() {
    this.data.updatedAt = now();
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const directory = dirname(this.path);
    const temporary = join(directory, `.status-${randomUUID()}.tmp`);
    try {
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

