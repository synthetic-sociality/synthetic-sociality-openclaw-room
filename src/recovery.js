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
import {closeSync, fchmodSync, fsyncSync, openSync, readFileSync, writeSync, constants as fs} from "node:fs";

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

export function isQuarantinedIntent(intent) {
  return intent?.status === "quarantined"
    && (intent.deliveryState === "quarantined" || (intent.version === 1 && intent.deliveryState === undefined));
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

// Posted with its lifecycle done, superseded or skipped (contract P3-2).
export function isTerminalIntent(intent) {
  if (!intent || typeof intent !== "object" || isQuarantinedIntent(intent)) return false;
  if (intent.deliveryState === "posted" && ["complete", "not_required"].includes(intent.lifecycleState)
    && ["posted", undefined].includes(intent.status)) return true;
  return ["superseded", "skipped"].includes(intent.deliveryState) && [intent.deliveryState, undefined].includes(intent.status);
}

// Drop terminal intents beyond the newest `keep` (insertion order).
export function pruneTerminalIntents(state, keep = TERMINAL_INTENT_RETENTION) {
  const intents = state.deliveryIntents ?? {};
  const terminal = Object.keys(intents).filter((key) => isTerminalIntent(intents[key]));
  const pruned = keep > 0 ? terminal.slice(0, Math.max(0, terminal.length - keep)) : terminal;
  for (const key of pruned) delete intents[key];
  return pruned;
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

// `room` answers listEpochs(), epochEvents(after, epochId), roomState() and
// getDiscussionCycle(cycleId) for this member.
export async function serverProof(room, membershipId, seq, reason, evidenceRef) {
  if (!REASONS.includes(reason)) throw new RecoveryRefused("unknown_reason", `reason must be one of ${REASONS.join(", ")}`);
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
  if (reason === "epoch_closed") {
    if (evidenceRef !== `epoch:${epochId}`) throw new RecoveryRefused("evidence_mismatch", `evidence must be epoch:${epochId}`);
    if (!epochId || epochId === activeEpochId || proof.eventEpochStatus === "active") {
      throw new RecoveryRefused("not_proven", `epoch ${epochId || "?"} is still active`);
    }
    return {...facts, proof};
  }
  const cycleId = String(payload.cycleId ?? "");
  if (!cycleId) throw new RecoveryRefused("not_proven", `seq ${seq} (${facts.eventType}) names no cycle`);
  if (evidenceRef !== `cycle:${cycleId}`) throw new RecoveryRefused("evidence_mismatch", `evidence must be cycle:${cycleId}`);
  const target = String(payload.membershipId ?? "");
  if (facts.eventType === "discussion.cycle_attempt_ready" && target && target !== membershipId) {
    throw new RecoveryRefused("not_for_member", `seq ${seq} is another member's attempt`);
  }
  let cycle = await room.getDiscussionCycle(cycleId) ?? {};
  if (cycle.cycle && typeof cycle.cycle === "object") cycle = cycle.cycle;
  Object.assign(proof, {
    cycleId, cycleState: String(cycle.state ?? ""),
    cycleGeneration: Number(cycle.generation) || 0, eventGeneration: Number(payload.generation) || 0,
  });
  if (reason === "cycle_terminal" && !TERMINAL_CYCLE_STATES.has(proof.cycleState)) {
    throw new RecoveryRefused("not_proven", `cycle ${cycleId} is ${proof.cycleState || "unknown"}, not terminal`);
  }
  if (reason === "cycle_superseded" && !(proof.eventGeneration && proof.cycleGeneration > proof.eventGeneration)) {
    throw new RecoveryRefused("not_proven", `cycle ${cycleId} has no newer generation than the event`);
  }
  return {...facts, proof};
}

// A Room adapter over the connector's RoomClient for one account state.
export function roomForState(client, state, signal) {
  return {
    listEpochs: () => client.listEpochs(state, signal),
    epochEvents: (after, epochId) => client.readEpochEvents(state, after, epochId, signal),
    roomState: () => client.roomState(state, signal),
    getDiscussionCycle: (cycleId) => client.getDiscussionCycle(state, cycleId, signal),
  };
}

// --- audit record -------------------------------------------------------------

export function confirmToken(record) {
  const stable = Object.fromEntries(Object.entries(record).filter(([key]) => !TOKEN_EXCLUDED.has(key)));
  stable.proof = Object.fromEntries(Object.entries(record.proof ?? {}).filter(([key]) => key !== "fetchedAt"));
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
    if (record?.version === 1 && record.verb === "close" && record.recordDigest === recordDigest(record)
      && record.confirmToken === confirmToken(record)) records.push(record);
  }
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
