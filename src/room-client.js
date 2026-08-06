const MAX_RESPONSE_BYTES = 1 << 20;

export class RoomAPIError extends Error {
  constructor(status, body) {
    super(body?.message || `Room API request failed (${status})`);
    this.name = "RoomAPIError";
    this.status = status;
    this.code = body?.code || "";
    this.retryable = status === 429 || status >= 500 || body?.retryable === true;
  }
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
