// Owner 2026-11-12 re-admission and contract P18 (Hermes 1.0.105, OpenClaw 0.2.80).
//
// Which stored account a re-admission may replace (staleInertState), and the pending lifecycle work of a revoked
// account it may abandon first (abandonableEntries, abandonRevokedPendingWork). Same rules as the Hermes connector's
// _stale_inert_binding, _revocation_stopped and _abandonable_entries. OpenClaw keeps unfinished post-delivery
// lifecycle work as delivery intents with status lifecycle_pending or lifecycle_blocked; it has no inbox or
// pending_since ledger, so those intents are the only abandonable entries.
import {createHash} from "node:crypto";
import {closeSync, fchmodSync, fstatSync, fsyncSync, openSync, readSync, writeSync, constants as fs} from "node:fs";
import {dirname, join} from "node:path";
import {canonical, isTerminalIntent} from "./recovery.js";
import {loadState, saveState} from "./state.js";

// Terminal evidence and receive-ledger outcomes that carry no open or quarantined work.
export const SETTLED_EVIDENCE = new Set(["posted", "skipped", "superseded", "ignored", "cancelled"]);
// Reasons the Room server stops an account with; any other recorded reason is an operator's.
export const STALE_REASONS = new Set(["credential_revoked", "credential_expired"]);
// P18-2: the only delivery intents a revoked account's re-admission may abandon.
export const ABANDONABLE_INTENT_STATUSES = new Set(["lifecycle_pending", "lifecycle_blocked"]);
export const REVOCATION_ABANDONMENT_JOURNAL = "revocation-abandonment.jsonl";
const RECORD_EVIDENCE = ["auditId", "reason", "roomId", "membershipId", "installationId", "entry", "revocation"];

function credentialExpired(state, nowMs) {
  const expiresAt = Date.parse(state?.credentialExpiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function operatorStopped(state) {
  // An operator's disable (state enabled:false without a server revocation), or a revocation recorded with a
  // reason the server never gives, is never treated as the server's stop.
  if (state?.revoked !== true) return state?.enabled === false;
  return Boolean(state.revokedReason) && !STALE_REASONS.has(state.revokedReason);
}

/** P18-1 / R5 B-F010: the Room server stopped this account (revoked, or its credential expired). */
export function serverStopped(state, nowMs = Date.now()) {
  if (!state || operatorStopped(state)) return false;
  return state.revoked === true || credentialExpired(state, nowMs);
}

/**
 * P18-1 (H105-F001): an account whose pending work a re-admission may abandon. Narrower than serverStopped: the
 * Room revoked it (retired, never restarted). An account whose credential merely expired is the renewal case and
 * keeps its work; an operator-disabled account never qualifies.
 */
export function revocationStopped(state) {
  return Boolean(state) && state.revoked === true && !operatorStopped(state);
}

// Everything except abandonable intents and settled terminal intents that keeps an account non-replaceable.
function holdsOtherEvidence(state) {
  if (state.credentialRotation) return true;
  if (Object.keys(state.appliedRecoveryClosures ?? {}).length > 0) return true;
  if (Object.values(state.receiveLedger ?? {}).some((entry) => !SETTLED_EVIDENCE.has(entry?.status))) return true;
  return Object.values(state.terminalEvidence ?? {}).some((evidence) => !SETTLED_EVIDENCE.has(evidence?.status));
}

/**
 * Owner 2026-11-12, R5 B-F010, P18: an account state a re-admission may replace. Stale: server-stopped. Inert: no
 * credential rotation, no applied recovery closure, no unsettled receive-ledger entry or terminal evidence, and no
 * delivery intent other than a settled terminal one (contract P3-2: posted with its lifecycle done, superseded or
 * skipped), so replacing it loses no open work.
 * @param {object} state - A validated account state.
 * @param {number} [nowMs] - The clock.
 * @returns {boolean} Whether the stored state may be replaced by the fresh credential.
 */
export function staleInertState(state, nowMs = Date.now()) {
  if (!serverStopped(state, nowMs) || holdsOtherEvidence(state)) return false;
  return Object.values(state.deliveryIntents ?? {}).every(isTerminalIntent);
}

/**
 * P18-2: the abandonable lifecycle intents of a revoked account, or null when it is not revocation-stopped, holds
 * none, or holds anything else that is not settled.
 * @param {object} state - A validated account state.
 * @returns {Array<{kind: string, id: string, record: object}>|null} The entries, in key order.
 */
export function abandonableEntries(state) {
  if (!revocationStopped(state) || holdsOtherEvidence(state)) return null;
  const entries = [];
  for (const key of Object.keys(state.deliveryIntents ?? {}).sort()) {
    const intent = state.deliveryIntents[key];
    if (isTerminalIntent(intent)) continue;
    if (!ABANDONABLE_INTENT_STATUSES.has(intent?.status)) return null;
    entries.push({kind: "delivery_intent", id: key, record: structuredClone(intent)});
  }
  return entries.length ? entries : null;
}

function removeEntries(state, entries) {
  for (const entry of entries) delete state.deliveryIntents?.[entry.id];
}

function readJournal(file) {
  // Never follow a link; only a regular file counts. null when it cannot be read.
  let descriptor;
  try {
    descriptor = openSync(file, fs.O_RDONLY | fs.O_NOFOLLOW);
  } catch (error) {
    return error?.code === "ENOENT" ? Buffer.alloc(0) : null;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return null;
    const chunks = [];
    const buffer = Buffer.alloc(1 << 16);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

function journalRecords(bytes) {
  const records = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
    } catch {
      // A torn line is kept as written and ignored.
    }
  }
  return records;
}

/** H105-F007: every expected `recorded` entry reads back as an intact line carrying exactly the expected evidence. */
export function recordedIntact(file, records) {
  const bytes = readJournal(file);
  if (bytes === null) return false;
  const present = new Set(journalRecords(bytes).filter((record) => record.phase === "recorded")
    .map((record) => canonical(Object.fromEntries(RECORD_EVIDENCE.map((key) => [key, record[key] ?? null])))));
  return records.every((record) => present.has(canonical(Object.fromEntries(RECORD_EVIDENCE.map((key) => [key, record[key] ?? null])))));
}

/**
 * Append records to the P18 journal: opened without following a link, a regular file with one link, 0600, every
 * byte written, fsync of the file and its directory. A torn last line stays its own line (H105-F004, H105-F007).
 */
export function appendJournal(file, records) {
  if (!records.length) return;
  const descriptor = openSync(file, fs.O_RDWR | fs.O_APPEND | fs.O_CREAT | fs.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`revocation abandonment journal is not a private regular file: ${file}`);
    fchmodSync(descriptor, 0o600);
    let payload = Buffer.from(records.map((record) => `${canonical(record)}\n`).join(""), "utf8");
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      readSync(descriptor, last, 0, 1, info.size - 1);
      if (last[0] !== 0x0a) payload = Buffer.concat([Buffer.from("\n"), payload]);
    }
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(descriptor, payload, offset, payload.length - offset);
      if (!written) throw new Error(`revocation abandonment journal write made no progress: ${file}`);
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(dirname(file), fs.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * P18-3..5: record and remove the abandonable lifecycle intents of a revoked account. Every entry is appended to
 * the journal beside the account state before one state rewrite removes exactly those entries, and only while the
 * stored account is still the same membership holding exactly them; the journal then records `applied` or
 * `not_applied`. Deterministic audit ids keep a replay from appending a record twice. Fails closed: any journal
 * error leaves the state as stored. The caller closes a live runtime of the account first.
 * @param {string} stateFile - The account state file.
 * @param {object} held - The account state read for the decision.
 * @param {{logger?: object}} [options] - Diagnostics.
 * @returns {Promise<boolean>} True when the entries were removed.
 */
export async function abandonRevokedPendingWork(stateFile, held, {logger = null} = {}) {
  const entries = abandonableEntries(held);
  if (!entries) return false;
  const journal = join(dirname(stateFile), REVOCATION_ABANDONMENT_JOURNAL);
  const now = new Date().toISOString();
  const records = entries.map((entry) => ({
    phase: "recorded",
    auditId: createHash("sha256").update(canonical({roomId: held.roomId, membershipId: held.membershipId, entry}), "utf8").digest("hex"),
    reason: "abandoned_on_revocation",
    roomId: held.roomId,
    membershipId: held.membershipId,
    installationId: held.clientInstanceId,
    entry,
    revocation: {revoked: held.revoked === true, disabledReason: String(held.revokedReason ?? "")},
    abandonedAt: now,
  }));
  try {
    const existing = readJournal(journal);
    if (existing === null) throw new Error("revocation abandonment journal is unreadable");
    const known = new Set(journalRecords(existing).map((record) => `${record.auditId}\u0000${record.phase}`));
    appendJournal(journal, records.filter((record) => !known.has(`${record.auditId}\u0000recorded`)));
    if (!recordedIntact(journal, records)) throw new Error("revocation abandonment journal evidence could not be verified");
    const expected = canonical(entries);
    let stored;
    try { stored = await loadState(stateFile); } catch { stored = null; }
    if (!stored || stored.roomId !== held.roomId || stored.membershipId !== held.membershipId
      || canonical(abandonableEntries(stored)) !== expected) {
      appendJournal(journal, records.map((record) => ({phase: "not_applied", auditId: record.auditId, at: now, why: "stored_binding_changed"})));
      logger?.warn?.(`Room ${held.roomId}: the stored account changed before P18 abandonment; kept as stored`);
      return false;
    }
    removeEntries(stored, entries);
    await saveState(stateFile, stored);
    removeEntries(held, entries);
    try {
      appendJournal(journal, records.filter((record) => !known.has(`${record.auditId}\u0000applied`))
        .map((record) => ({phase: "applied", auditId: record.auditId, at: now})));
    } catch (error) {
      // P18-3: the stored account is the authority now; a missing outcome marker is not repaired after the fact.
      logger?.warn?.(`Room ${held.roomId}: P18 applied marker not written: ${error?.message ?? error}`);
    }
    logger?.info?.(`Room ${held.roomId}: abandoned ${entries.length} pending lifecycle entr${entries.length === 1 ? "y" : "ies"} of the revoked account (P18)`);
    return true;
  } catch (error) {
    logger?.warn?.(`Room ${held.roomId}: P18 abandonment failed closed: ${error?.message ?? error}`);
    return false;
  }
}
