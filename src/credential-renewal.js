import {createHash, randomBytes} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {RoomAPIError} from "./room-client.js";
import {loadState, saveState} from "./state.js";
import {intentSettled} from "./terminal-states.js";
import {reconcileRoomAck, roomAckAheadMessage} from "./recovery.js";

const secret = () => randomBytes(32).toString("base64url");
const phases = ["requested", "prepared", "redeemed", "swapped", "confirmed"];
const fail = () => { throw new Error("Room credential renewal evidence mismatch; retain private journal for review"); };
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const seq = (n) => Number.isSafeInteger(n) && n >= 0;
const MISMATCH = "Room credential renewal evidence mismatch; retain private journal for review";

// Contract P2c-3i (ACK-AHEAD-07): the journal was closed without a credential.
// The owner request expired before it was issued; nothing was swapped. The
// state records the reason and a new owner Renew is needed.
export class RenewalClosed extends Error {
  constructor(reason) {
    super(`owner renewal journal closed: ${reason}; a new owner Renew is needed`);
    this.name = "RenewalClosed";
    this.reason = reason;
    this.code = `renewal_${reason}`;
  }
}

// Contract P2c-3j: the base credential has expired (its stored expiry passed,
// or the Room refused it as credential_expired: `refusedByRoom`).
export function baseCredentialExpired(state, {refusedByRoom = false, nowMs = Date.now()} = {}) {
  const expiresAt = Date.parse(state?.credentialExpiresAt ?? "");
  return refusedByRoom === true || (Number.isFinite(expiresAt) && expiresAt <= nowMs);
}

export function renewalBlocked(state, account = {}, {baseExpired = false} = {}) {
  if (account.enabled === false || state.enabled === false || state.revoked === true) return true;
  // Contract P2c-3j: an expired base never waits for work that needs a valid
  // credential to finish (nor does a journal that began on an expired base:
  // after the swap the state carries the replacement's expiry); that work is
  // kept unchanged and resumes after the renewal.
  if (baseExpired || state.credentialRotation?.baseExpired === true) return false;
  // Quarantine, skipped replies and completed evidence behind an acknowledgement
  // gap are inert journals, not active writers. Preserve them across the exchange
  // (contract P2c-3h: the shared settled set).
  return Object.values(state.deliveryIntents ?? {}).some((intent) => !intentSettled(intent));
}

// Contract P2c-3j: after a confirmed renewal, lifecycle work blocked only
// because the Room refused the credential as expired is reopened once for
// automatic retry with a fresh attempt budget. Anything else stays as it is.
function reopenExpiredLifecycles(intents) {
  const next = {};
  for (const [key, intent] of Object.entries(intents ?? {})) {
    if (intent?.status === "lifecycle_blocked" && intent.lifecycleState === "blocked"
      && intent.lifecycleErrorCode === "credential_expired" && intent.deliveryState === "posted" && intent.canonicalMessage) {
      const reopened = {...intent, status: "lifecycle_pending", lifecycleState: "pending", lifecycleAutomaticRetry: true, lifecycleAttempts: 0};
      delete reopened.lifecycleError;
      delete reopened.lifecycleErrorCode;
      delete reopened.lifecycleFailedAt;
      next[key] = reopened;
    } else {
      next[key] = intent;
    }
  }
  return next;
}

function identity(value, expected) {
  for (const field of ["roomId", "membershipId", "displayName", "identityVersion"]) {
    if (value?.[field] !== expected[field]) fail();
  }
}

// The acknowledgement was reconciled with the local cursor before
// (reconcileDelivery, contract P2c-3i); delivered stays exact.
function delivery(value, expected) {
  identity(value, expected);
  if (value?.deliveredSeq !== expected.deliveredSeq) fail();
}

// Contract P2c-3i: a renewal answer's acknowledgement meets the local cursor
// only here. A Room ahead is adopted on a copy the caller persists; a Room
// behind, a non-integer value or delivered below it is the one conflict.
function reconcileDelivery(value, state) {
  // A delivered below the local cursor is below the Room's acknowledgement too: the helper's conflict.
  if (!seq(value?.deliveredSeq)) fail();
  const next = structuredClone(state);
  const result = reconcileRoomAck(next, value.acknowledgedSeq, {delivered: value.deliveredSeq, conflict: MISMATCH});
  return {result, next};
}

function member(snapshot, expected) {
  if (snapshot?.roomId !== expected.roomId || !Array.isArray(snapshot.roster)) fail();
  const matches = snapshot.roster.filter((item) => item.membershipId === expected.membershipId);
  if (matches.length !== 1) fail();
  return {...matches[0], roomId: snapshot.roomId};
}

export function validateRenewalJournal(journal, state) {
  if (!journal || journal.version !== 1 || !phases.includes(journal.phase)) fail();
  for (const key of ["requestId", "grantSecret", "replacementCredential"]) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(journal[key] ?? "")
      || Buffer.from(journal[key], "base64url").toString("base64url") !== journal[key]) fail();
  }
  if (!journal.baseCredential || journal.clientInstanceId !== state.clientInstanceId
    || journal.expected?.roomId !== state.roomId || journal.expected?.membershipId !== state.membershipId
    || !journal.expected.displayName || !positive(journal.expected.identityVersion)
    || !positive(journal.baseCredentialGeneration) || journal.localCursor !== state.cursor) fail();
  if (state.credential !== (phases.indexOf(journal.phase) >= 3 ? journal.replacementCredential : journal.baseCredential)) fail();
  if (journal.phase !== "requested" && !journal.grantId) fail();
}

/** Called only under the runtime's binding lifecycle gate, outside a model turn.
 * Every secret exists in durable private state before it is used on the wire.
 * Only a confirmed replacement may erase the recovery journal.
 */
export async function renewCredential({state, stateFile, account, client, signal, logger, refusedByRoom = false}) {
  const baseExpired = baseCredentialExpired(state, {refusedByRoom});
  if (renewalBlocked(state, account, {baseExpired})) return false;
  const persist = async (next) => {
    // Refuse a concurrent external writer instead of overwriting its cursors.
    if (!isDeepStrictEqual(await loadState(stateFile), state)) fail();
    await saveState(stateFile, next);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  };
  let journal = state.credentialRotation;
  if (!journal) {
    const discovered = await client.credentialRenewalIntent(state, signal);
    if (!discovered || typeof discovered !== "object" || !("request" in discovered)) fail();
    if (discovered.request === null) return false;
    const request = discovered.request;
    if (request?.state !== "owner_requested" || request.roomId !== state.roomId
      || request.membershipId !== state.membershipId || !positive(request.identityVersion)
      || !request.displayName || !positive(request.baseCredentialGeneration)
      || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= Date.now()) fail();
    const {result, next} = reconcileDelivery(request, state);
    journal = {
      version: 1, phase: "requested", requestId: request.requestId,
      grantSecret: secret(), replacementCredential: secret(), baseCredential: state.credential,
      clientInstanceId: state.clientInstanceId, baseCredentialGeneration: request.baseCredentialGeneration,
      localCursor: next.cursor, baseExpired,
      expected: {roomId: state.roomId, membershipId: state.membershipId,
        displayName: request.displayName, identityVersion: request.identityVersion,
        deliveredSeq: request.deliveredSeq, acknowledgedSeq: request.acknowledgedSeq},
    };
    validateRenewalJournal(journal, next);
    const prepared = {...next, credentialRotation: journal};
    delete prepared.renewalClosed;
    await persist(prepared);
    if (result.adopted) logger?.warn?.(roomAckAheadMessage(state.roomId, result, "renewal preflight"));
  }
  validateRenewalJournal(journal, state);
  const base = {...state, credential: journal.baseCredential};
  const replacement = {...state, credential: journal.replacementCredential};
  const update = async (fields, stateFields = {}) => {
    journal = {...journal, ...fields};
    await persist({...state, ...stateFields, credentialRotation: journal});
  };
  // Contract P2c-3i: reconcile before any comparison; on adoption the journal's
  // expected and local cursors follow the Room.
  const reconcile = async (value, where) => {
    const {result, next} = reconcileDelivery(value, state);
    if (!result.adopted) return;
    journal = {...journal, localCursor: next.cursor, expected: {...journal.expected,
      acknowledgedSeq: next.cursor, deliveredSeq: Math.max(journal.expected.deliveredSeq ?? 0, value.deliveredSeq)}};
    await persist({...next, credentialRotation: journal});
    logger?.warn?.(roomAckAheadMessage(state.roomId, result, where));
  };
  // ACK-AHEAD-07: an expired owner request closes the journal (base credential
  // unchanged), records the reason and is not retried.
  const close = async (reason) => {
    if (!["requested", "prepared"].includes(journal.phase) || state.credential !== journal.baseCredential) fail();
    const closed = {...state, renewalClosed: {reason, requestId: journal.requestId, closedAt: new Date().toISOString()}};
    delete closed.credentialRotation;
    await persist(closed);
    throw new RenewalClosed(reason);
  };
  const closeExpiredAnswer = async (answer) => {
    if (answer.requestId !== journal.requestId || answer.roomId !== state.roomId
      || (answer.membershipId !== undefined && answer.membershipId !== state.membershipId)) fail();
    await close("owner_request_expired");
  };
  // Only request and redeem own an unactivated journal. A matching refusal on
  // verify, confirm, ordinary registration or /state cannot undo a replacement.
  const beforeActivation = async (request) => {
    try {
      return await request;
    } catch (error) {
      if (error instanceof RoomAPIError && error.renewalReason) await close(error.renewalReason);
      throw error;
    }
  };
  if (journal.phase === "requested") {
    if (!seq(journal.expected.deliveredSeq)) {
      // A legacy journal lacks a delivery snapshot. Discovery only shows the
      // current owner request. If absent or newer, query our exact request
      // below before deciding that our journal is terminal.
      const discovery = await client.credentialRenewalIntent(base, signal);
      if (!discovery || !Object.hasOwn(discovery, "request")) fail();
      const current = discovery.request;
      if (current !== null && current?.requestId === journal.requestId) {
        if (current.state === "expired") await closeExpiredAnswer(current);
        identity(current, journal.expected);
        if (current.baseCredentialGeneration !== journal.baseCredentialGeneration) fail();
        await reconcile(current, "renewal preflight");
        await update({expected: {...journal.expected, deliveredSeq: current.deliveredSeq, acknowledgedSeq: state.cursor}});
      }
    }
    const requested = await beforeActivation(client.requestCredentialRenewal(base, {
      requestId: journal.requestId,
      grantSecretHash: createHash("sha256").update(journal.grantSecret).digest("hex"),
      clientInstanceId: state.clientInstanceId,
    }, signal));
    if (requested?.state === "expired") await closeExpiredAnswer(requested);
    identity(requested, journal.expected);
    if (requested.requestId !== journal.requestId || requested.baseCredentialGeneration !== journal.baseCredentialGeneration
      || !["issued", "redeemed"].includes(requested.state) || !requested.grantId) fail();
    await reconcile(requested, "renewal request");
    if (!seq(journal.expected.deliveredSeq)) {
      await update({expected: {...journal.expected, deliveredSeq: requested.deliveredSeq, acknowledgedSeq: state.cursor}});
    }
    delivery(requested, journal.expected);
    await update({phase: "prepared", grantId: requested.grantId});
  }
  if (journal.phase === "prepared") {
    const redeemed = await beforeActivation(client.redeemCredentialRenewal(base, journal.grantId, {
      grantSecret: journal.grantSecret, replacementCredential: journal.replacementCredential,
    }, signal));
    await reconcile(redeemed, "renewal redeem");
    delivery(redeemed, journal.expected);
    if (redeemed.grantId !== journal.grantId) fail();
    await update({phase: "redeemed"});
  }
  if (journal.phase === "redeemed") {
    const verified = await client.verifyCredentialRenewal(replacement, journal.grantId, signal);
    await reconcile(verified, "renewal verify");
    delivery(verified, journal.expected);
    if (verified.grantId !== journal.grantId || !Number.isFinite(Date.parse(verified.credentialExpiresAt))) fail();
    await update({phase: "swapped"}, {credential: journal.replacementCredential, credentialExpiresAt: verified.credentialExpiresAt});
  }
  if (journal.phase === "swapped") {
    const event = await client.confirmCredentialRenewal(replacement, journal.grantId, signal);
    if (event?.type !== "credential.renewed" || !event.id
      || event.payload?.membershipId !== state.membershipId
      || event.payload?.credentialGeneration !== journal.baseCredentialGeneration + 1
      || !Number.isFinite(Date.parse(event.payload.credentialExpiresAt))) fail();
    await update({phase: "confirmed", confirmationEventId: event.id}, {credentialExpiresAt: event.payload.credentialExpiresAt});
  }
  // Contract P15-2 (PR80-O-004): credential discovery is a background watcher; it waits while participation is paused.
  const active = member(await client.roomState(replacement, signal, {background: true}), journal.expected);
  await reconcile(active, "renewal active state");
  delivery(active, journal.expected);
  const finished = {...state, displayName: journal.expected.displayName, identityVersion: journal.expected.identityVersion,
    deliveryIntents: reopenExpiredLifecycles(state.deliveryIntents)};
  delete finished.credentialRotation;
  await persist(finished);
  return true;
}
