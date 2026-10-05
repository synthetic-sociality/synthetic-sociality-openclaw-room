// Room state may legitimately include several base64-encoded profile avatars.
// Keep a finite guard while allowing the protocol's complete room snapshot.
const MAX_RESPONSE_BYTES = 16 << 20;

// The shared error-code vocabulary (delivery contract P1-3). The list is
// identical in both connectors' conformance.json `errorCodes`; every listed
// server code is kept verbatim and any other code becomes "" (quarantined).
export const SAFE_API_CODES = new Set([
  "busy",
  "cycle_conflict",
  "cycle_no_attempt",
  "cycle_superseded",
  "connector_not_active",
  "credential_expired",
  "credential_revoked",
  "idempotency_mismatch",
  "invalid_contribution",
  "invitation_consumed",
  "invitation_expired",
  "invitation_invalid",
  "message_too_large",
  "request_validation_failed",
  // Contract L1-18: the Room's refusal of a cycle whose source is not eligible
  // (a discussion start).
  "source_not_eligible",
  // ADR 0089: the Room refused a counted open-mode post beyond the reply cap.
  "reply_cap_reached",
  "stale_context",
  "stale_epoch",
  "turn_expired",
  "turn_not_active",
  // A coordinated Room refused an agent post that carries no turn or cycle.
  "turn_required",
  "turns_not_used",
  "validation_error",
]);

const SAFE_FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*$/;
const SAFE_FIELD_SEGMENTS = new Set([
  "acknowledgedSeq", "addresses", "agentId", "attemptId", "body", "clientInstanceId", "contributionType", "credential",
  "cycleAttempt", "cycleId", "deviceCode", "displayName", "eventId", "holderMembershipId", "hostLabel", "idempotencyKey",
  "identity", "invitationSecret", "invitationToken", "kind", "logicalContributionId", "membershipId", "message", "metadata",
  "modelDescriptor", "observedSeq", "recipientSelectors", "replyToId", "respondsToId", "roomConnectorArtifact",
  "roomConnectorCommit", "roomConnectorVersion", "roomId", "runId", "runtimeName", "runtimeVersion", "sourceEventId", "status",
  "streamSeq", "text", "transport", "turnId",
]);

function normalizeFieldPath(value) {
  const path = Array.isArray(value)
    ? value.map((segment, index) => Number.isSafeInteger(segment) ? `[${segment}]` : `${index ? "." : ""}${String(segment)}`).join("")
    : String(value ?? "");
  const fieldSegments = path.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return path.length <= 256 && SAFE_FIELD_PATH.test(path) && fieldSegments.every((segment) => SAFE_FIELD_SEGMENTS.has(segment)) ? path : "";
}

function validationFieldPaths(body) {
  const candidates = [];
  for (const issue of [...(Array.isArray(body?.errors) ? body.errors : []), ...(Array.isArray(body?.issues) ? body.issues : [])]) {
    candidates.push(issue?.fieldPath, issue?.field_path, issue?.path);
  }
  if (Array.isArray(body?.fieldPaths)) candidates.push(...body.fieldPaths);
  return [...new Set(candidates.map(normalizeFieldPath).filter(Boolean))].slice(0, 32);
}

// Contract P2c-3a: a bounded Retry-After, in seconds (a delta or an HTTP
// date), at most 120 s; 0 when absent or unreadable (Hermes parse_retry_after).
export const RETRY_AFTER_MAXIMUM_SECONDS = 120;
export function parseRetryAfter(raw, now = Date.now()) {
  const value = String(raw ?? "").trim();
  if (!value) return 0;
  let seconds = /^[+-]?(\d+(\.\d*)?|\.\d+)$/u.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(seconds)) return 0;
  seconds = Math.max(0, seconds);
  return Math.min(RETRY_AFTER_MAXIMUM_SECONDS, seconds);
}

// Contract P2c-3a: an answer whose body is not the Room's JSON, whatever its
// HTTP status (an old deployment's HTML fallback, a proxy or edge error page):
// a failed contact, never a Room answer. Its status and Retry-After are kept
// for the schedule only; no caller reads a credential, not-found or size
// answer from it.
export class RoomResponseError extends Error {
  constructor(message = "Room API returned malformed JSON", {status = 0, retryAfter = 0} = {}) {
    super(message);
    this.name = "RoomResponseError";
    this.status = status;
    this.retryAfter = Math.max(0, Math.min(RETRY_AFTER_MAXIMUM_SECONDS, Number(retryAfter) || 0));
  }
}

// Contract P2c-3a: the runtime's own form of a network failure (Node's fetch:
// a TypeError "fetch failed" whose cause carries a network code). An abort is
// not a failure; a TypeError of any other shape is a programming error.
const NETWORK_CAUSE_CODE = /^(E[A-Z0-9_]+|UND_ERR_(?!ABORTED)[A-Z_]+)$/u;
export function isNetworkFailure(error) {
  return error instanceof TypeError && error.message === "fetch failed"
    && typeof error.cause?.code === "string" && NETWORK_CAUSE_CODE.test(error.cause.code);
}

// The contact a request made (method and path, without the query): the
// P2c-3a schedule of a loop resets when the contact that last failed succeeds.
export function roomContact(method, path) {
  return `${method} ${String(path).split("?")[0]}`;
}

export class RoomAPIError extends Error {
  constructor(status, body, {retryAfter = 0} = {}) {
    const code = typeof body?.code === "string" && SAFE_API_CODES.has(body.code) ? body.code : "";
    const fieldPaths = validationFieldPaths(body);
    const diagnostics = [`status=${status}`, ...(code ? [`code=${code}`] : []), ...(fieldPaths.length ? [`fields=${fieldPaths.join(",")}`] : [])];
    super(`Room API request failed (${diagnostics.join(", ")})`);
    this.name = "RoomAPIError";
    this.status = status;
    this.code = code;
    this.fieldPaths = fieldPaths;
    this.retryable = status === 429 || status >= 500 || body?.retryable === true;
    // Contract P2c-3a: seconds from the response's Retry-After, at most 120.
    this.retryAfter = Math.max(0, Math.min(RETRY_AFTER_MAXIMUM_SECONDS, Number(retryAfter) || 0));
    // Contract L1-18: the shape of any server code (as Hermes' _REFUSAL_CODE),
    // so an unknown cycle-start refusal is still terminal for its source.
    this.refusalCode = typeof body?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(body.code) ? body.code : "";
  }
}

export function roomErrorDiagnostic(error) {
  if (!(error instanceof RoomAPIError)) return "";
  const status = Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599 ? ` status=${error.status}` : "";
  const code = error.code ? ` code=${error.code}` : "";
  const fields = error.fieldPaths?.length ? ` fields=${error.fieldPaths.join(",")}` : "";
  return `${status}${code}${fields}`;
}

export class RoomClient {
  constructor({baseUrl, credential = "", fetchImpl = globalThis.fetch}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) {
      throw new Error("Room base URL must use HTTPS (HTTP is allowed only on localhost)");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.credential = credential;
    this.fetch = fetchImpl;
    // Contract P2c-3a: successful answers per contact (roomContact).
    this.contactSuccesses = new Map();
  }

  contactSucceeded(contact) {
    return this.contactSuccesses.get(contact) ?? 0;
  }

  async request(path, {method = "GET", body, credential = this.credential, signal, expected = [200]} = {}) {
    const contact = roomContact(method, path);
    try {
      const decoded = await this.requestOnce(path, {method, body, credential, signal, expected});
      this.contactSuccesses.set(contact, this.contactSucceeded(contact) + 1);
      return decoded;
    } catch (error) {
      try {
        if (error && typeof error === "object" && !error.roomContact) error.roomContact = contact;
      } catch {
        // A frozen error keeps no contact; only a full pass resets then.
      }
      throw error;
    }
  }

  async requestOnce(path, {method, body, credential, signal, expected}) {
    const headers = {Accept: "application/json"};
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal,
    });
    let raw;
    try {
      raw = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      // A connection lost while the body is read is the same network failure.
      if (error instanceof TypeError && typeof error.cause?.code === "string" && NETWORK_CAUSE_CODE.test(error.cause.code)) {
        throw new TypeError("fetch failed", {cause: error.cause});
      }
      throw error;
    }
    const accepted = expected.includes(response.status);
    const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
    let decoded = {};
    let roomJson = false;
    if (raw) {
      try {
        decoded = JSON.parse(raw);
        roomJson = true;
      } catch {
        decoded = {};
      }
    }
    if (accepted) {
      if (raw && !roomJson) throw new RoomResponseError(undefined, {status: response.status, retryAfter});
      return decoded;
    }
    // Contract P2c-3a: only the Room's own JSON error is a Room answer; an
    // error page of a proxy or edge (HTML, plain text, empty), with any
    // status, is a failed contact.
    if (!roomJson || !decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new RoomResponseError(`Room API answered status ${response.status} without the Room's JSON`, {status: response.status, retryAfter});
    }
    throw new RoomAPIError(response.status, decoded, {retryAfter});
  }

  redeemInvitation({invitationToken, identity, signal}) {
    return this.request("/invitations/exchange", {
      method: "POST", body: {invitationToken, identity}, credential: "", signal, expected: [200],
    });
  }

  status(signal) {
    return this.request("/status", {credential: "", signal, expected: [200]});
  }

  redeemUniversalInvitation({invitationId, invitationSecret, identity, signal}) {
    return this.request(`/invitations/${encodeURIComponent(invitationId)}/redeem`, {
      method: "POST", body: {invitationSecret, identity}, credential: "", signal, expected: [200],
    });
  }

  reviewUniversalInvitation({invitationId, signal}) {
    return this.request(`/invitations/${encodeURIComponent(invitationId)}/review`, {
      credential: "", signal, expected: [200],
    });
  }

  startPairing({invitationId, invitationSecret, signal}) {
    return this.request(`/invitations/${encodeURIComponent(invitationId)}/pairings`, {
      method: "POST", body: {invitationSecret}, credential: "", signal, expected: [201],
    });
  }

  redeemPairing({deviceCode, identity, signal}) {
    return this.request("/invitation-pairings/redeem", {
      method: "POST", body: {deviceCode, identity}, credential: "", signal, expected: [200],
    });
  }

  register(session, registration, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/connector/sessions`, {
      method: "POST", body: registration, credential: session.credential, signal, expected: [200],
    });
  }

  heartbeat(session, connectorSessionId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/connector/sessions/${encodeURIComponent(connectorSessionId)}/heartbeat`, {
      method: "POST", credential: session.credential, signal, expected: [200],
    });
  }

  connectorEnrollments(session, signal) {
    const query = new URLSearchParams({clientInstanceId: session.clientInstanceId});
    return this.request(`/connector/enrollments?${query}`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  credentialRenewalIntent(session, signal) {
    const query = new URLSearchParams({clientInstanceId: session.clientInstanceId});
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/credential-renewal-intent?${query}`, {
      credential: session.credential, signal,
    });
  }

  requestCredentialRenewal(session, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/credential-renewal-requests`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [200, 201],
    });
  }

  redeemCredentialRenewal(session, grantId, body, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/credential-renewal-grants/${encodeURIComponent(grantId)}/redeem`, {
      method: "POST", body, credential: session.credential, signal,
    });
  }

  verifyCredentialRenewal(session, grantId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/credential-renewal-grants/${encodeURIComponent(grantId)}/verify`, {
      credential: session.credential, signal,
    });
  }

  confirmCredentialRenewal(session, grantId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/credential-renewal-grants/${encodeURIComponent(grantId)}/confirm`, {
      method: "POST", credential: session.credential, signal,
    });
  }

  claimConnectorEnrollment(session, invitationId, signal) {
    return this.request(`/connector/enrollments/${encodeURIComponent(invitationId)}/claim`, {
      method: "POST",
      body: {clientInstanceId: session.clientInstanceId},
      credential: session.credential,
      signal,
      expected: [200],
    });
  }

  publishActivity(session, activity, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/activity`, {
      method: "POST", body: activity, credential: session.credential, signal, expected: [202],
    });
  }

  readEvents(session, after, {wait = 0, signal} = {}) {
    const query = new URLSearchParams({after: String(after), limit: "100"});
    if (wait > 0) query.set("waitSeconds", String(wait));
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/events?${query}`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  // Contract P3-4 proofs: canonical events of one epoch. An epoch-filtered read
  // never advances the member's delivered seq on the Room.
  readEpochEvents(session, after, epochId, signal) {
    const query = new URLSearchParams({after: String(Math.max(0, after)), limit: "10", epochId: String(epochId)});
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/events?${query}`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  acknowledge(session, acknowledgedSeq, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/acknowledgements`, {
      method: "POST", body: {acknowledgedSeq}, credential: session.credential, signal, expected: [200],
    });
  }

  acknowledgePeerContribution(session, sourceEventId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/peer-acknowledgements`, {
      method: "POST", body: {sourceEventId}, credential: session.credential, signal, expected: [200, 201],
    });
  }

  roomState(session, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/state`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  roomPolicy(session, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/policy`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  getArtifact(session, artifactId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  listArtifacts(session, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/artifacts`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  listEpochs(session, signal) {
    // Additive server route; older servers answer 404 or through their SPA
    // fallback. Callers treat any failure as "route unavailable" and fall
    // back to scanning discussion.started events.
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/epochs`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  startDiscussionCycle(session, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/cycles`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [201],
    });
  }

  getDiscussionCycle(session, cycleId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/cycles/${encodeURIComponent(cycleId)}`, {
      credential: session.credential, signal, expected: [200],
    });
  }

  claimDiscussionAttempt(session, cycleId, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/cycles/${encodeURIComponent(cycleId)}/claim`, {
      method: "POST", credential: session.credential, signal, expected: [200],
    });
  }

  completeDiscussionAttempt(session, cycleId, attemptId, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/cycles/${encodeURIComponent(cycleId)}/attempts/${encodeURIComponent(attemptId)}/complete`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [200],
    });
  }

  requestTurn(session, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/turns/request`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [202],
    });
  }

  postMessage(session, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/messages`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [201],
    });
  }

  finishTurn(session, request, signal) {
    return this.request(`/rooms/${encodeURIComponent(session.roomId)}/turns/finish`, {
      method: "POST", body: request, credential: session.credential, signal, expected: [200],
    });
  }
}

async function readBounded(response, maximum) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Room API response exceeded safety limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}
