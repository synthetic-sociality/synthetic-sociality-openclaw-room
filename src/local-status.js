// Contract P2c-4: machine-readable local status for the host watchdog.
//
// One status.json per installation, next to the accounts directory, mode 0600,
// replaced atomically. The schema is the delivery contract appendix "Local
// status file (P2c-4)", identical in Hermes. It never holds a credential,
// renewal secret, message body, reply text or prompt: every value is a fixed
// code, an identifier, a number or a time.
import {randomUUID} from "node:crypto";
import {chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

export const STATUS_SCHEMA = "synthetic-sociality-room-status-v1";
const CONNECTION_STATES = new Set(["connecting", "connected", "reconnecting", "inactive", "stopped"]);
// Contract P2c-4 (tkw-049): the `rooms` summary takes the membership whose
// connection is worst in this order, ties by the smallest membership id.
const CONNECTION_ORDER = ["stopped", "reconnecting", "connecting", "inactive", "connected"];
// Contract P2c-3d: the Room's answers that stop a membership until a renewal
// or re-admission succeeds.
const STOPPED_BY_ROOM = new Set(["credential_expired", "credential_revoked"]);
// Contract P2c-6: the tool names that count as web reading (Hermes
// WEB_READ_TOOL_NAMES, the same list).
export const WEB_READ_TOOL_NAMES = Object.freeze(["browser", "browser_navigate", "web_extract", "web_fetch", "web_search"]);
// Contract P2c-4 (ISSUE-023): why a dispatch waited on the host.
export const GATE_WAIT_REASONS = new Set(["", "host_run_busy", "host_session_unobservable", "held_by_moderator"]);
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
// Contract L1-11: the link states.
const LINK_STATES = new Set(["not_linked", "pending", "connecting", "connected", "reconnecting", "stopped"]);
const LINK_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Contract P8-5: a change of lastConnectedAt alone is written at most this
// often per installation; every other change is written at once.
export const CONNECTED_AT_WRITE_MS = 60_000;

function timer(milliseconds, callback) {
  const handle = setTimeout(callback, Math.max(0, milliseconds));
  handle.unref?.();
  return () => clearTimeout(handle);
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function validControlReceipt(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.commandId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.commandId)
    && typeof value.phase === "string" && CODE.test(value.phase));
}

function code(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return CODE.test(text) ? text : "unknown_error";
}

export class LocalStatus {
  constructor(path, {plugin = "openclaw", version, hostLabel, logger, clock = () => Date.now(), schedule = timer} = {}) {
    this.path = path;
    this.logger = logger;
    this.failed = false;
    // Contract P8-5: when the file was last written, and the pending write of
    // a lastConnectedAt-only change (its cancel function).
    this.clock = clock;
    this.schedule = schedule;
    this.writtenAt = null;
    this.pendingCancel = null;
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
      memberships: {},
    };
    // Contract P2c-4 (tkw-049): one entry per (Room, membership), keyed by
    // membership id; an entry whose membership is not known yet is kept
    // under "room:<roomId>" and never written to `memberships`.
    this.entries = new Map();
    // Contract P2c-3a: when the current outage of a membership began
    // (process memory only; never written).
    this.outageStarted = new Map();
    // Contract P2c-3b: memberships that are inactive (muted), and each
    // membership's own connection state under that mark (P2c-4).
    this.inactive = new Set();
    this.connection = new Map();
    // Contract P2c-4 (tkw-049 B01): the (Room, membership) pairs this process
    // retired with forget; a later write for one of them is ignored.
    this.retired = new Set();
    // Contract P17: the owner connector control receipt survives the process
    // (a restart reads it back); every other value starts fresh.
    try {
      const prior = JSON.parse(readFileSync(path, "utf8"))?.connectorControl;
      if (validControlReceipt(prior)) this.data.connectorControl = prior;
    } catch {
      // No earlier file, or not readable: no receipt.
    }
  }

  // Contract P17: codes, ids, counts, times and the non-secret binding
  // inventory only. True when it is durable in the file.
  setConnectorControl(receipt) {
    if (!validControlReceipt(receipt)) return false;
    this.data.connectorControl = structuredClone(receipt);
    return this.write();
  }

  connectorControlReceipt() {
    return this.data.connectorControl ? structuredClone(this.data.connectorControl) : null;
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

  // Contract L1-11 and L1o-8: the device link, codes only. Written when a
  // value changed; `updatedAt` is the time of that change.
  setLink(link) {
    const next = {
      state: LINK_STATES.has(link?.state) ? link.state : "stopped",
      code: code(link?.code),
      deviceId: typeof link?.deviceId === "string" && LINK_DEVICE_ID.test(link.deviceId) ? link.deviceId : "",
      channels: Number.isSafeInteger(link?.channels) && link.channels >= 0 ? link.channels : 0,
      limits: link?.limits === "advertised" ? "advertised" : "fallback",
      lastConnectedAt: typeof link?.lastConnectedAt === "string" && link.lastConnectedAt ? link.lastConnectedAt : null,
      lastChannelErrorCode: code(link?.lastChannelErrorCode),
    };
    const prior = this.data.link;
    if (prior && Object.keys(next).every((key) => prior[key] === next[key])) return true;
    this.data.link = {...next, updatedAt: now()};
    return this.write();
  }

  // The internal key of a (Room, membership): the membership id, or, while
  // no membership is known for that Room, a provisional "room:<roomId>".
  entryKey(roomId, membershipId) {
    if (membershipId) {
      const provisional = `room:${roomId}`;
      const adopted = this.entries.get(provisional);
      if (adopted && !this.entries.has(membershipId)) {
        // The provisional entry becomes the membership's own.
        this.entries.delete(provisional);
        adopted.membershipId = membershipId;
        this.entries.set(membershipId, adopted);
        this.data.memberships[membershipId] = adopted;
        for (const map of [this.outageStarted, this.connection]) {
          if (map.has(provisional)) map.set(membershipId, map.get(provisional));
          map.delete(provisional);
        }
        if (this.inactive.delete(provisional)) this.inactive.add(membershipId);
      }
      return membershipId;
    }
    // A value without a membership id belongs to the Room's only membership;
    // with several it is not attributed (null).
    const known = [...this.entries.entries()].filter(([, entry]) => entry.roomId === roomId);
    if (known.length > 1) return null;
    return known[0]?.[0] ?? `room:${roomId}`;
  }

  // Contract P2c-4 (tkw-049): the `rooms` entry, derived from that Room's
  // membership entries alone, never from the order of writes.
  summarize(roomId) {
    const entries = [...this.entries.values()].filter((entry) => entry.roomId === roomId).sort((a, b) =>
      CONNECTION_ORDER.indexOf(a.connection) - CONNECTION_ORDER.indexOf(b.connection)
      || (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0));
    if (!entries.length) return;
    const {roomId: _room, ...fields} = structuredClone(entries[0]);
    this.data.rooms[roomId] = {...fields, membershipIds: entries.map((entry) => entry.membershipId).filter(Boolean).sort()};
  }

  // Contract P2c-4: a binding replaced by another membership (a re-admission
  // under a new membership id) or removed drops its entry and marks; the Room
  // summary is recomputed from the remaining entries, or dropped with the last.
  // The membership stays retired: a late write for it, such as the old
  // channel's teardown, never recreates the entry or moves the summary.
  forget(roomId, membershipId) {
    const roomKey = String(roomId ?? "");
    const key = String(membershipId ?? "");
    if (!roomKey || !key) return;
    this.retired.add(JSON.stringify([roomKey, key]));
    if (this.entries.get(key)?.roomId !== roomKey) return;
    this.entries.delete(key);
    delete this.data.memberships[key];
    this.outageStarted.delete(key);
    this.connection.delete(key);
    this.inactive.delete(key);
    delete this.data.rooms[roomKey];
    this.summarize(roomKey);
    this.write();
  }

  // Update one membership's entry and its Room summary; write only when
  // something changed.
  room(roomId, membershipId = "", {connection, errorCode, connected = false, registered = false, inactive,
    gateWaitSeconds, gateWaitReason, ledger} = {}) {
    if (!roomId) return;
    const roomKey = String(roomId);
    if (membershipId && this.retired.has(JSON.stringify([roomKey, String(membershipId)]))) return;
    const key = this.entryKey(roomKey, String(membershipId ?? ""));
    if (key === null) return;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        roomId: roomKey,
        membershipId: key.startsWith("room:") ? "" : key,
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
      this.entries.set(key, entry);
      if (entry.membershipId) this.data.memberships[key] = entry;
    }
    // Contract P2c-3d: a membership the Room stopped stays stopped with its
    // code while it waits; only an accepted contact (`connected`) changes it.
    // A later start, retry or stop of the channel never writes over it.
    if (!connected && entry.connection === "stopped" && STOPPED_BY_ROOM.has(entry.lastErrorCode)) {
      if (connection !== "stopped") connection = undefined;
      if (errorCode !== undefined && !STOPPED_BY_ROOM.has(code(errorCode))) errorCode = undefined;
      inactive = undefined;
    }
    const unstamped = () => JSON.stringify([{...entry, lastConnectedAt: null}, {...this.data.rooms[roomKey], lastConnectedAt: null}]);
    const before = unstamped();
    const connectedBefore = entry.lastConnectedAt;
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
    this.summarize(roomKey);
    if (unstamped() !== before) this.write();
    else if (entry.lastConnectedAt !== connectedBefore) this.writeConnectedAt();
  }

  // Contract P8-5: a lastConnectedAt-only change, at most once per 60 s.
  writeConnectedAt() {
    if (this.pendingCancel) return; // already due; that write carries the newest value
    const wait = this.writtenAt === null ? 0 : CONNECTED_AT_WRITE_MS - (this.clock() - this.writtenAt);
    if (wait > 0) {
      this.pendingCancel = this.schedule(wait, () => {
        if (!this.pendingCancel) return;
        this.pendingCancel = null;
        // A deferred time alone never creates the directory again.
        if (existsSync(dirname(this.path))) this.write();
      });
      return;
    }
    this.write();
  }

  write() {
    // Contract P8-5: this write carries every pending value.
    this.writtenAt = this.clock();
    const cancel = this.pendingCancel;
    this.pendingCancel = null;
    try { cancel?.(); } catch {}
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

