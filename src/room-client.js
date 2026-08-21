// Room state may legitimately include several base64-encoded profile avatars.
// Keep a finite guard while allowing the protocol's complete room snapshot.
const MAX_RESPONSE_BYTES = 16 << 20;

const SAFE_API_CODES = new Set([
  "busy",
  "cycle_conflict",
  "cycle_no_attempt",
  "cycle_superseded",
  "invitation_consumed",
  "invitation_expired",
  "invitation_invalid",
  "request_validation_failed",
  "stale_context",
  "validation_error",
]);
const SAFE_FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*$/;
const SAFE_FIELD_SEGMENTS = new Set([
  "acknowledgedSeq", "agentId", "attemptId", "body", "clientInstanceId", "contributionType", "credential",
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

export class RoomAPIError extends Error {
  constructor(status, body) {
    const code = typeof body?.code === "string" && SAFE_API_CODES.has(body.code) ? body.code : "";
    const fieldPaths = validationFieldPaths(body);
    const diagnostics = [`status=${status}`, ...(code ? [`code=${code}`] : []), ...(fieldPaths.length ? [`fields=${fieldPaths.join(",")}`] : [])];
    super(`Room API request failed (${diagnostics.join(", ")})`);
    this.name = "RoomAPIError";
    this.status = status;
    this.code = code;
    this.fieldPaths = fieldPaths;
    this.retryable = status === 429 || status >= 500 || body?.retryable === true;
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
  }

  async request(path, {method = "GET", body, credential = this.credential, signal, expected = [200]} = {}) {
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
    const raw = await readBounded(response, MAX_RESPONSE_BYTES);
    let decoded = {};
    if (raw) {
      try { decoded = JSON.parse(raw); } catch { throw new Error("Room API returned malformed JSON"); }
    }
    if (!expected.includes(response.status)) throw new RoomAPIError(response.status, decoded);
    return decoded;
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
