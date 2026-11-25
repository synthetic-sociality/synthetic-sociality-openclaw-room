// Contract P3: ledger report, terminal-intent retention and audited recovery.
//
// Shared with Hermes (recovery.py): the same verbs, reasons, server proof,
// audit record keys, confirmation token and record digest. Nothing here writes
// a cursor, an acknowledgement, an intent or a quarantine. A closure is an
// append-only audit record; the running connector applies it through its
// normal acknowledgement path after re-checking the Room's proof.
//
// The record digest is an unkeyed sha256 and the operator name is not
// authenticated: anyone who can write the journal can write a well-formed
// record. Safety rests on the Room's proof being checked again when the record
// is applied (contract P3-4) and on the store fence that keeps agents out.
import {createHash} from "node:crypto";
import {closeSync, fchmodSync, fsyncSync, openSync, readFileSync, statSync, writeSync, constants as fs} from "node:fs";
import {isQuarantinedIntent, isTerminalEvidenceStatus, isTerminalIntent} from "./terminal-states.js";

// Contract P2c-3h: one terminal-state set per connector (terminal-states.js).
export {isQuarantinedIntent, isTerminalIntent};

export const REASONS = Object.freeze(["cycle_terminal", "cycle_superseded", "epoch_closed"]);
export const TERMINAL_CYCLE_STATES = new Set(["completed", "interrupted", "timed_out", "failed"]);
export const TERMINAL_INTENT_RETENTION = 32;
export const REPORT_LIMIT = 32;
export const CLOSURE_EVIDENCE_PREFIX = "recovery_closure:";
const TOKEN_EXCLUDED = new Set(["operator", "confirmToken", "recordedAt", "recordDigest"]);

export class RecoveryRefused extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RecoveryRefused";
    this.code = code;
  }
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Sorted keys, no whitespace: the same bytes as Hermes' json.dumps(sort_keys,
// separators=(",", ":"), ensure_ascii=False).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- ledger -------------------------------------------------------------------

function ledgerKeys(state) {
  const keys = new Set();
  for (const mapping of [state.receiveLedger, state.terminalEvidence]) {
    for (const key of Object.keys(mapping ?? {})) if (/^\d+$/.test(key)) keys.add(Number(key));
  }
  return keys;
}

// Holes and quarantines above the acknowledgement (contract P3-3).
export function ledgerReport(state) {
  const ack = Number(state.cursor) || 0;
  const keys = ledgerKeys(state);
  const delivered = Math.max(ack, Number(state.deliveredCursor) || 0, ...keys);
  const holes = [];
  for (let seq = ack + 1; seq <= delivered && holes.length < REPORT_LIMIT; seq += 1) if (!keys.has(seq)) holes.push(seq);
  const quarantined = Object.entries(state.receiveLedger ?? {})
    .filter(([seq, entry]) => entry?.status === "quarantined" && Number(seq) > ack)
    .map(([seq]) => Number(seq)).sort((a, b) => a - b).slice(0, REPORT_LIMIT);
  const code = holes.length ? "ack_hole" : (quarantined.length && quarantined[0] === ack + 1 ? "quarantine_held" : "");
  return {acknowledgedSeq: ack, deliveredSeq: delivered, holeSeqs: holes, quarantinedSeqs: quarantined, ledgerCode: code};
}

// Drop terminal intents beyond the newest `keep` (insertion order).
export function pruneTerminalIntents(state, keep = TERMINAL_INTENT_RETENTION) {
  const intents = state.deliveryIntents ?? {};
  const terminal = Object.keys(intents).filter((key) => isTerminalIntent(intents[key]));
  const pruned = keep > 0 ? terminal.slice(0, Math.max(0, terminal.length - keep)) : terminal;
  for (const key of pruned) delete intents[key];
  return pruned;
}

// Contract P2c-3i: the Room is the authority for the acknowledged frontier.
export const ROOM_ACK_AHEAD = "room_ack_ahead";
export const ACK_FRONTIER_MISMATCH = "ack_frontier_mismatch";

// The Room's acknowledgement is behind the local one, or not an integer.
export class AckFrontierConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "AckFrontierConflict";
    this.code = ACK_FRONTIER_MISMATCH;
  }
}

// Contract P2c-3i: the one place a Room acknowledgement meets a local cursor.
// `frontier` is the local value compared (default: the cursor; ackEvent passes
// its walked frontier). Equal: no change. Room ahead: adopted as a fence;
// every seq up to it without terminal evidence becomes "ignored" with reason
// room_ack_ahead (existing evidence is kept and the adopted range keeps its
// records until the next frontier advance prunes them), the cursor moves, the
// receive ledger and terminal intents are pruned. Room behind, a non-integer
// answer, or a `delivered` below the Room's acknowledgement: AckFrontierConflict,
// nothing changes. The caller persists and logs (roomAckAheadMessage).
export function reconcileRoomAck(state, roomAck, {frontier, delivered, eventIds = {},
  conflict = "Room acknowledgement exceeded the locally proven contiguous frontier"} = {}) {
  const local = Number.isSafeInteger(frontier) ? frontier : state.cursor;
  if (!Number.isSafeInteger(roomAck) || roomAck < local || roomAck < state.cursor) throw new AckFrontierConflict(conflict);
  if (delivered !== undefined && (!Number.isSafeInteger(delivered) || delivered < roomAck)) throw new AckFrontierConflict(conflict);
  if (roomAck === local) return {adopted: false, frontier: local, acknowledged: roomAck, seqs: []};
  const previous = state.cursor;
  const marked = [];
  state.terminalEvidence ??= {};
  for (let seq = previous + 1; seq <= roomAck; seq += 1) {
    const key = String(seq);
    const existing = state.terminalEvidence[key];
    if (existing && isTerminalEvidenceStatus(existing.status) && existing.sourceSeq === seq) continue;
    const known = state.receiveLedger?.[key]?.eventId || eventIds[key] || "";
    state.terminalEvidence[key] = {status: "ignored", sourceEventId: String(known || `${ROOM_ACK_AHEAD}:${seq}`), sourceSeq: seq,
      canonicalEventId: "", canonicalSeq: 0, canonicalTs: "", reason: ROOM_ACK_AHEAD};
    marked.push(seq);
  }
  state.cursor = roomAck;
  state.terminalEvidence = Object.fromEntries(Object.entries(state.terminalEvidence).filter(([seq]) => Number(seq) > previous));
  state.receiveLedger = Object.fromEntries(Object.entries(state.receiveLedger ?? {}).filter(([seq]) => Number(seq) > roomAck));
  pruneTerminalIntents(state);
  return {adopted: true, frontier: local, acknowledged: roomAck, seqs: marked};
}

// The one warning line per adoption (contract P2c-3i).
export function roomAckAheadMessage(roomId, result, where) {
  return `Room ${roomId} acknowledgement ahead of the local cursor adopted (${where}): frontier ${result.frontier}, Room ${result.acknowledged}, ${result.seqs.length} seqs ignored with reason ${ROOM_ACK_AHEAD} where no terminal evidence existed`;
}

// Intents that cannot progress by themselves: quarantined, or not terminal with
// an acknowledged source (v1 selected intents below the cursor block renewal).
export function stuckIntents(state) {
  const stuck = [];
  for (const [key, intent] of Object.entries(state.deliveryIntents ?? {})) {
    if (!intent || typeof intent !== "object" || isTerminalIntent(intent)) continue;
    const sourceEventId = String(intent.identity?.sourceEventId ?? "");
    const ledgerSeq = Object.entries(state.receiveLedger ?? {}).find(([, entry]) => entry?.eventId === sourceEventId)?.[0];
    const open = !ledgerSeq;
    if (isQuarantinedIntent(intent) || (open && sourceEventId)) {
      stuck.push({intentKey: key, sourceSeq: ledgerSeq ? Number(ledgerSeq) : 0,
        state: String(intent.status ?? intent.deliveryState ?? ""), lastErrorCode: String(intent.deliveryErrorCode ?? "")});
    }
  }
  return stuck;
}

// What a closure would close: a hole or a quarantine; else refused.
export function priorState(state, seq) {
  const ack = Number(state.cursor) || 0;
  if (seq <= ack) throw new RecoveryRefused("already_acknowledged", `seq ${seq} is at or below the acknowledgement ${ack}`);
  const entry = state.receiveLedger?.[String(seq)];
  if (entry?.status === "quarantined") {
    const found = Object.entries(state.deliveryIntents ?? {})
      .find(([, intent]) => isQuarantinedIntent(intent) && intent.identity?.sourceEventId === entry.eventId);
    return {kind: "quarantine", intentKey: found?.[0] ?? "", lastErrorCode: String(found?.[1]?.deliveryErrorCode ?? "")};
  }
  const keys = ledgerKeys(state);
  const top = Math.max(Number(state.deliveredCursor) || 0, ...keys, 0);
  if (!keys.has(seq) && seq < top) return {kind: "hole", intentKey: "", lastErrorCode: ""};
  throw new RecoveryRefused("not_closable", `seq ${seq} is neither a hole nor a quarantine (ledger ${entry?.status ?? "none"})`);
}

// --- server proof (read-only, the member's own credential) ------------------

// The Room's facts about the event at `seq`: its epoch, the event itself and
// the active epoch. `room` answers listEpochs(), epochEvents(after, epochId),
// roomState() and getDiscussionCycle(cycleId) for this member.
async function readProof(room, seq) {
  const listing = await room.listEpochs();
  const epochs = (Array.isArray(listing) ? listing : listing?.epochs ?? [])
    .filter((item) => item && Number.isSafeInteger(item.startsAtSeq)).sort((a, b) => a.startsAtSeq - b.startsAtSeq);
  const containing = epochs.filter((item) => item.startsAtSeq <= seq);
  if (!containing.length) throw new RecoveryRefused("event_not_found", `no discussion epoch contains seq ${seq}`);
  const epoch = containing.at(-1);
  const epochId = String(epoch.id ?? "");
  // An epoch-filtered read never moves the server's delivered seq.
  const page = await room.epochEvents(seq - 1, epochId);
  const event = (page?.events ?? []).find((item) => Number(item?.seq) === seq);
  if (!event) throw new RecoveryRefused("event_not_found", `the Room returned no event at seq ${seq}`);
  const state = await room.roomState();
  const activeEpochId = String(state?.activeEpoch?.id ?? "");
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const proof = {
    activeEpochId, eventEpochStatus: String(epoch.status ?? ""),
    cycleId: "", cycleState: "", cycleGeneration: 0, eventGeneration: 0,
    deliveredSeq: Number(page?.deliveredSeq) || 0, fetchedAt: now(),
  };
  const facts = {eventId: String(event.id ?? ""), eventType: String(event.type ?? ""), eventEpochId: epochId};
  return {facts, proof, payload};
}

const epochClosed = ({facts, proof}) => Boolean(facts.eventEpochId) && facts.eventEpochId !== proof.activeEpochId
  && proof.eventEpochStatus !== "active";

// The cycle the event names, read into the proof; "" when it names none or is
// another member's attempt. With an evidence reference (a closure) those, and
// a reference to another cycle, are refusals instead.
async function readCycle(room, membershipId, seq, read, evidenceRef = null) {
  const refuse = evidenceRef !== null;
  const cycleId = String(read.payload.cycleId ?? "");
  if (!cycleId) {
    if (refuse) throw new RecoveryRefused("not_proven", `seq ${seq} (${read.facts.eventType}) names no cycle`);
    return "";
  }
  if (refuse && evidenceRef !== `cycle:${cycleId}`) throw new RecoveryRefused("evidence_mismatch", `evidence must be cycle:${cycleId}`);
  const target = String(read.payload.membershipId ?? "");
  if (read.facts.eventType === "discussion.cycle_attempt_ready" && target && target !== membershipId) {
    if (refuse) throw new RecoveryRefused("not_for_member", `seq ${seq} is another member's attempt`);
    return "";
  }
  let cycle = await room.getDiscussionCycle(cycleId) ?? {};
  if (cycle.cycle && typeof cycle.cycle === "object") cycle = cycle.cycle;
  Object.assign(read.proof, {
    cycleId, cycleState: String(cycle.state ?? ""),
    cycleGeneration: Number(cycle.generation) || 0, eventGeneration: Number(read.payload.generation) || 0,
  });
  return cycleId;
}

const cycleTerminal = ({proof}) => TERMINAL_CYCLE_STATES.has(proof.cycleState);
const cycleSuperseded = ({proof}) => Boolean(proof.eventGeneration && proof.cycleGeneration > proof.eventGeneration);

export async function serverProof(room, membershipId, seq, reason, evidenceRef) {
  if (!REASONS.includes(reason)) throw new RecoveryRefused("unknown_reason", `reason must be one of ${REASONS.join(", ")}`);
  const read = await readProof(room, seq);
  const {facts, proof} = read;
  const epochId = facts.eventEpochId;
  if (reason === "epoch_closed") {
    if (evidenceRef !== `epoch:${epochId}`) throw new RecoveryRefused("evidence_mismatch", `evidence must be epoch:${epochId}`);
    if (!epochClosed(read)) throw new RecoveryRefused("not_proven", `epoch ${epochId || "?"} is still active`);
    return {...facts, proof};
  }
  const cycleId = await readCycle(room, membershipId, seq, read, evidenceRef);
  if (reason === "cycle_terminal" && !cycleTerminal(read)) {
    throw new RecoveryRefused("not_proven", `cycle ${cycleId} is ${proof.cycleState || "unknown"}, not terminal`);
  }
  if (reason === "cycle_superseded" && !cycleSuperseded(read)) {
    throw new RecoveryRefused("not_proven", `cycle ${cycleId} has no newer generation than the event`);
  }
  return {...facts, proof};
}

// Contract P2c-3h: what the Room proves about the event at `seq`, with the
// reads and the proof shape of a closure (P3-4): the trigger epoch_closed (or
// hole_epoch_closed for a hole, which only an epoch-closed proof frees),
// cycle_terminal or cycle_superseded, else "". Null when the Room has no
// such event.
export async function stuckProof(room, membershipId, seq, {hole = false} = {}) {
  let read;
  try {
    read = await readProof(room, seq);
  } catch (error) {
    if (error instanceof RecoveryRefused) return null;
    throw error;
  }
  const result = (trigger, evidenceRef = "") => ({...read.facts, trigger, evidenceRef, proof: read.proof});
  if (epochClosed(read)) return result(hole ? "hole_epoch_closed" : "epoch_closed", `epoch:${read.facts.eventEpochId}`);
  if (hole) return result("");
  const cycleId = await readCycle(room, membershipId, seq, read);
  if (cycleId && cycleTerminal(read)) return result("cycle_terminal", `cycle:${cycleId}`);
  if (cycleId && cycleSuperseded(read)) return result("cycle_superseded", `cycle:${cycleId}`);
  return result("");
}

// A Room adapter over the connector's RoomClient for one account state.
export function roomForState(client, state, signal) {
  return {
    listEpochs: () => client.listEpochs(state, signal),
    epochEvents: (after, epochId) => client.readEpochEvents(state, after, epochId, signal),
    // Contract P15-2 (PR80-O-004): recovery waits while participation is paused.
    roomState: () => client.roomState(state, signal, {background: true}),
    getDiscussionCycle: (cycleId) => client.getDiscussionCycle(state, cycleId, signal),
  };
}

// --- audit record -------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function confirmToken(record) {
  if (!isPlainObject(record?.proof)) throw new Error("audit record proof must be an object");
  const stable = Object.fromEntries(Object.entries(record).filter(([key]) => !TOKEN_EXCLUDED.has(key)));
  stable.proof = Object.fromEntries(Object.entries(record.proof).filter(([key]) => key !== "fetchedAt"));
  return sha256(canonical(stable)).slice(0, 16);
}

export function recordDigest(record) {
  return sha256(canonical(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "recordDigest"))));
}

export function buildRecord({connector, roomId, membershipId, clientInstanceId, seq, reason, evidenceRef, proven, prior, operator}) {
  const record = {
    version: 1, verb: "close", connector,
    room: roomId, membership: membershipId, clientInstanceId,
    seq, eventId: proven.eventId, eventType: proven.eventType,
    eventEpochId: proven.eventEpochId, reason, evidenceRef,
    proof: {...proven.proof}, priorState: {...prior},
    operator, confirmToken: "", recordedAt: "", recordDigest: "",
  };
  record.confirmToken = confirmToken(record);
  return record;
}

export function seal(record) {
  const sealed = {...record, recordedAt: now()};
  sealed.recordDigest = recordDigest(sealed);
  return sealed;
}

export function journalPath(stateFile) {
  return `${stateFile}.recovery-audit.jsonl`;
}

export function appendRecord(path, record) {
  const fd = openSync(path, fs.O_WRONLY | fs.O_APPEND | fs.O_CREAT | (fs.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${canonical(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Valid sealed records; a malformed or altered line is skipped.
export function readRecords(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    try {
      if (record?.version === 1 && record.verb === "close" && isPlainObject(record.proof) && isPlainObject(record.priorState)
        && record.recordDigest === recordDigest(record) && record.confirmToken === confirmToken(record)) records.push(record);
    } catch {
      // Contract P3-4: an unreadable record is skipped, never fatal.
    }
  }
  return records;
}

// Contract P8-6: the identity of a file (size, modification time in ns,
// inode, device), or null when it does not exist.
export function fileIdentity(path, stat = statSync) {
  let info;
  try {
    info = stat(path, {bigint: true});
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return `${info.size}:${info.mtimeNs}:${info.ino}:${info.dev}`;
}

const cachedRecords = new Map();

// Contract P8-6: readRecords without reading a journal that has not changed
// (an append by the recovery tool changes its size and modification time).
// The records are shared and must not be changed.
export function readRecordsCached(path) {
  const identity = fileIdentity(path);
  if (identity === null) {
    cachedRecords.delete(path);
    return [];
  }
  const cached = cachedRecords.get(path);
  if (cached?.identity === identity) return cached.records;
  const records = readRecords(path);
  if (fileIdentity(path) === identity) cachedRecords.set(path, {identity, records});
  else cachedRecords.delete(path);
  return records;
}

// The latest sealed closure per seq for exactly this account.
export function closuresFor(records, roomId, membershipId, clientInstanceId) {
  const found = new Map();
  for (const record of records) {
    if (record.room === roomId && record.membership === membershipId && record.clientInstanceId === clientInstanceId
      && Number.isSafeInteger(record.seq)) found.set(record.seq, record);
  }
  return found;
}

export function renderRecord(record) {
  return JSON.stringify(JSON.parse(canonical(record)), null, 2);
}

export function describe(report, stuck, write) {
  write(`  acknowledged ${report.acknowledgedSeq}, highest read ${report.deliveredSeq}, code ${report.ledgerCode || "-"}`);
  write(`  holes: ${report.holeSeqs.join(", ") || "none"}`);
  write(`  quarantines: ${report.quarantinedSeqs.join(", ") || "none"}`);
  if (!stuck.length) write("  stuck intents: none");
  for (const item of stuck) {
    write(`  stuck intent ${item.intentKey}: source seq ${item.sourceSeq || "?"}, ${item.state || "-"}, ${item.lastErrorCode || "-"}`);
  }
}
