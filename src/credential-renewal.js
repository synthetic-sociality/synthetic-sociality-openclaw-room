import {createHash, randomBytes} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {loadState, saveState} from "./state.js";

const secret = () => randomBytes(32).toString("base64url");
const phases = ["requested", "prepared", "redeemed", "swapped", "confirmed"];
const fail = () => { throw new Error("Room credential renewal evidence mismatch; retain private journal for review"); };
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const seq = (n) => Number.isSafeInteger(n) && n >= 0;

export function renewalBlocked(state, account = {}) {
  return account.enabled === false || state.enabled === false || state.revoked === true
    || Boolean(state.quarantined)
    || Object.keys(state.terminalEvidence ?? {}).length > 0
    || Object.values(state.deliveryIntents ?? {}).some((intent) => !["posted", "superseded"].includes(intent.status)
      || ["pending", "blocked"].includes(intent.lifecycleState));
}

function identity(value, expected) {
  for (const field of ["roomId", "membershipId", "displayName", "identityVersion"]) {
    if (value?.[field] !== expected[field]) fail();
  }
}

function delivery(value, expected) {
  identity(value, expected);
  for (const field of ["deliveredSeq", "acknowledgedSeq"]) {
    if (value?.[field] !== expected[field]) fail();
  }
}

function deliverySnapshot(request, state) {
  if (!seq(request?.deliveredSeq) || request.deliveredSeq < state.cursor
    || request.acknowledgedSeq !== state.cursor) fail();
  return {deliveredSeq: request.deliveredSeq, acknowledgedSeq: request.acknowledgedSeq};
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
export async function renewCredential({state, stateFile, account, client, signal}) {
  if (renewalBlocked(state, account)) return false;
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
    journal = {
      version: 1, phase: "requested", requestId: request.requestId,
      grantSecret: secret(), replacementCredential: secret(), baseCredential: state.credential,
      clientInstanceId: state.clientInstanceId, baseCredentialGeneration: request.baseCredentialGeneration,
      localCursor: state.cursor,
      expected: {roomId: state.roomId, membershipId: state.membershipId,
        displayName: request.displayName, identityVersion: request.identityVersion,
        ...deliverySnapshot(request, state)},
    };
    validateRenewalJournal(journal, state);
    await persist({...state, credentialRotation: journal});
  }
  validateRenewalJournal(journal, state);
  const base = {...state, credential: journal.baseCredential};
  const replacement = {...state, credential: journal.replacementCredential};
  const update = async (fields, stateFields = {}) => {
    journal = {...journal, ...fields};
    await persist({...state, ...stateFields, credentialRotation: journal});
  };
  if (journal.phase === "requested") {
    if (!seq(journal.expected.deliveredSeq)) {
      // Resume an older private preparation through renewal-only authority.
      // An expired base must never be granted or require ordinary /state.
      const current = (await client.credentialRenewalIntent(base, signal))?.request;
      identity(current, journal.expected);
      if (current.requestId !== journal.requestId || current.baseCredentialGeneration !== journal.baseCredentialGeneration) fail();
      await update({expected: {...journal.expected, ...deliverySnapshot(current, state)}});
    }
    const requested = await client.requestCredentialRenewal(base, {
      requestId: journal.requestId,
      grantSecretHash: createHash("sha256").update(journal.grantSecret).digest("hex"),
      clientInstanceId: state.clientInstanceId,
    }, signal);
    delivery(requested, journal.expected);
    if (requested.requestId !== journal.requestId || requested.baseCredentialGeneration !== journal.baseCredentialGeneration
      || !["issued", "redeemed"].includes(requested.state) || !requested.grantId) fail();
    await update({phase: "prepared", grantId: requested.grantId});
  }
  if (journal.phase === "prepared") {
    const redeemed = await client.redeemCredentialRenewal(base, journal.grantId, {
      grantSecret: journal.grantSecret, replacementCredential: journal.replacementCredential,
    }, signal);
    delivery(redeemed, journal.expected);
    if (redeemed.grantId !== journal.grantId) fail();
    await update({phase: "redeemed"});
  }
  if (journal.phase === "redeemed") {
    const verified = await client.verifyCredentialRenewal(replacement, journal.grantId, signal);
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
  const active = member(await client.roomState(replacement, signal), journal.expected);
  delivery(active, journal.expected);
  const finished = {...state, displayName: journal.expected.displayName, identityVersion: journal.expected.identityVersion};
  delete finished.credentialRotation;
  await persist(finished);
  return true;
}
