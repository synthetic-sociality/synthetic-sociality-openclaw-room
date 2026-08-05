import {randomUUID} from "node:crypto";
import {RoomClient, RoomAPIError} from "./room-client.js";
import {loadState, saveState} from "./state.js";

const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, {once: true});
});

export class OpenClawRoomRuntime {
  constructor(account, {fetchImpl = globalThis.fetch, logger = null} = {}) {
    this.account = account;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.closed = false;
    this.connectorSession = null;
    this.initializeTask = null;
    this.state = null;
    this.client = null;
    this.heartbeatAbort = new AbortController();
    this.presenceRunId = `openclaw-presence:${randomUUID()}`;
    this.presenceStreamSeq = 0;
    this.pendingPresence = null;
    this.activityRunId = null;
    this.activityStreamSeq = 0;
  }

  async initialize(signal) {
    if (this.connectorSession && this.client && this.state) return this.connectorSession;
    if (this.initializeTask) return this.initializeTask;
    this.initializeTask = this.initializeOnce(signal);
    try {
      return await this.initializeTask;
    } finally {
      this.initializeTask = null;
    }
  }

  async initializeOnce(signal) {
    this.state = await waitForState(this.account.stateFile, signal);
    if (this.account.baseUrl && this.state.baseUrl !== this.account.baseUrl) throw new Error("Configured Room origin does not match private reconnect state");
    this.client = new RoomClient({baseUrl: this.state.baseUrl, credential: this.state.credential, fetchImpl: this.fetchImpl});
    this.connectorSession = await this.client.register(this.state, {
      clientInstanceId: this.state.clientInstanceId,
      contractVersion: 1,
      capabilities: ["events.long_poll", "activity.relay"],
      metadata: {
        runtimeName: "OpenClaw",
        runtimeVersion: "2026.7.1-2",
        hostLabel: this.account.accountId,
        transport: "long_poll",
        modelDescriptor: "host-selected",
      },
    }, signal);
    await this.publishPresence(signal);
    if (this.activityError) this.logger?.warn?.(`Room activity signal unavailable: ${String(this.activityError)}`);
    else this.logger?.info?.("Room activity signal established");
    this.runHeartbeat();
    return this.connectorSession;
  }

  async *assignedTurns(signal) {
    await this.initialize(signal);
    while (!signal.aborted && !this.closed) {
      const page = await retry(() => this.client.readEvents(this.state, this.state.cursor, {wait: 20, signal}), signal);
      // Long-poll completion is an independent liveness clock. Maintaining
      // presence here prevents a failed timer task from leaving a locally
      // green but remotely expired connector.
      await retry(() => this.maintainPresence(signal), signal);
      for (const event of page.events ?? []) {
        if (event.seq <= this.state.cursor) continue;
        if (!isAssignedMessage(event, this.state.membershipId)) {
          await this.ackEvent(event);
          continue;
        }
        this.pendingEvent = event;
        await this.markContextAcknowledged(event, signal);
        yield normalizeEvent(event, this.state.roomId);
      }
    }
  }

  async ack(eventId) {
    const pending = this.pendingEvent;
    if (!pending || pending.id !== eventId) throw new Error("Room event acknowledgement is out of order");
    await this.ackEvent(pending);
  }

  async ackEvent(event) {
    const cursor = await this.client.acknowledge(this.state, event.seq);
    this.state.cursor = cursor.acknowledgedSeq ?? event.seq;
    await saveState(this.account.stateFile, this.state);
    if (this.pendingEvent?.id === event.id) this.pendingEvent = null;
  }

  async postAndFinish({roomId, text, replyToId, idempotencyKey, signal, sourceEventId}) {
    if (roomId !== this.state.roomId) throw new Error("Outbound Room does not match connector membership");
    const body = String(text ?? "").trim();
    if (!body) throw new Error("OpenClaw produced an empty Room response");
    await this.markTurnPreparing(sourceEventId, signal);
    const state = await this.client.roomState(this.state, signal);
    const topicId = state.activeTopic?.id ?? null;
    const requestKey = safeKey(`${idempotencyKey}:request`);
    const turn = await this.client.requestTurn(this.state, {
      observedSeq: state.headSeq,
      idempotencyKey: requestKey,
      ...(topicId ? {topicId} : {}),
    }, signal);
    const granted = await this.waitForGrant(turn, signal);
    const fresh = await this.client.roomState(this.state, signal);
    const message = await this.client.postMessage(this.state, {
      turnId: granted.turnId,
      observedSeq: fresh.headSeq,
      idempotencyKey: safeKey(`${idempotencyKey}:message`),
      ...(topicId ? {topicId} : {}),
      ...(fresh.activeEpoch?.id ? {observedEpochId: fresh.activeEpoch.id} : {}),
      ...(replyToId ? {respondsTo: [replyToId]} : {}),
      contributionType: "claim",
      body,
    }, signal);
    await this.client.finishTurn(this.state, {
      turnId: granted.turnId,
      observedSeq: message.seq,
      idempotencyKey: safeKey(`${idempotencyKey}:finish`),
    }, signal);
    await this.markTurnPosted(sourceEventId, message.id, signal);
    return {eventId: message.id, sentAt: Date.parse(message.ts) || Date.now()};
  }

  async waitForGrant(initial, signal) {
    if (initial.state === "granted") return initial;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(750, signal);
      const state = await this.client.roomState(this.state, signal);
      if (state.activeTurn?.holderMembershipId === this.state.membershipId) return state.activeTurn;
    }
    throw new Error("Room turn was not granted before the lease deadline");
  }

  runHeartbeat() {
    const interval = Math.max(5, Number(this.connectorSession.heartbeatIntervalSeconds) || 15) * 800;
    const loop = async () => {
      while (!this.closed && !this.heartbeatAbort.signal.aborted) {
        await sleep(interval, this.heartbeatAbort.signal);
        await retry(() => this.maintainPresence(this.heartbeatAbort.signal), this.heartbeatAbort.signal);
      }
    };
    this.heartbeatTask = loop().catch((error) => {
      if (!this.closed && !this.heartbeatAbort.signal.aborted) {
        this.heartbeatError = error;
        this.logger?.error?.(`Room heartbeat loop stopped: ${String(error)}`);
      }
    });
  }

  async maintainPresence(signal) {
    await this.client.heartbeat(this.state, this.connectorSession.sessionId, signal);
    await this.publishPresence(signal);
  }

  async publishPresence(signal) {
    // The connector-session heartbeat is durable reachability evidence. The
    // separate activity heartbeat is deliberately ephemeral and is what the
    // Room UI uses for its truthful live signal. Keep an unconfirmed frame so
    // a lost response retries the exact immutable sequence instead of creating
    // a gap in the relay.
    const activity = this.pendingPresence ?? {
      version: 1,
      kind: "heartbeat",
      runId: this.presenceRunId,
      streamSeq: this.presenceStreamSeq + 1,
    };
    this.pendingPresence = activity;
    try {
      await this.client.publishActivity(this.state, activity, signal);
      this.presenceStreamSeq = activity.streamSeq;
      this.pendingPresence = null;
      this.activityError = null;
    } catch (error) {
      // Activity is a non-canonical presentation relay. Its temporary absence
      // must never disconnect the canonical Room connector or stop polling.
      this.activityError = error;
    }
  }

  async publishActivityFrame({kind, status, sourceEventId, sourceSeq, delivery, textDelta, canonicalEventId}, signal) {
    // Presentation-only relay frames. Any failure is deliberately swallowed:
    // the UI activity pane is best-effort and must never block canonical work.
    // Each event run gets its own runId + streamSeq sequence starting at 1,
    // matching the Hermes bridge scope semantics: the relay requires strictly
    // increasing, gap-free streamSeq per runId and rejects cross-run interleaving.
    if (!this.activityRunId) this.activityRunId = `openclaw-activity:${randomUUID()}`;
    if (this.activityStreamSeq === undefined) this.activityStreamSeq = 0;
    const frame = {
        version: 1,
        kind,
        runId: this.activityRunId,
        streamSeq: this.activityStreamSeq + 1,
        ...(sourceEventId ? {sourceEventId} : {}),
        ...(sourceSeq ? {sourceSeq} : {}),
        ...(status ? {status} : {}),
        ...(delivery ? {delivery} : {}),
        ...(textDelta ? {textDelta} : {}),
        ...(canonicalEventId ? {canonicalEventId} : {}),
    };
    try {
      const receipt = await this.client.publishActivity(this.state, frame, signal);
      this.activityStreamSeq = receipt.acceptedStreamSeq ?? frame.streamSeq;
      this.activityError = null;
      this.logger?.info?.(`[activity] published kind=${frame.kind} seq=${frame.streamSeq} status=${frame.status ?? ""} accepted=${receipt.acceptedStreamSeq}`);
    } catch (error) {
      this.activityError = error;
      this.logger?.warn?.(`[activity] publish failed kind=${kind} frame=${JSON.stringify(frame)}: ${String(error).slice(0, 120)}`);
    }
  }

  async markTurnReading(sourceEventId, signal) {
    await this.publishActivityFrame({kind: "lifecycle", status: "reading_shared_room", sourceEventId}, signal);
  }

  async markContextAcknowledged(event, signal) {
    await this.publishActivityFrame({kind: "context_acknowledged", sourceEventId: event.id, sourceSeq: event.seq}, signal);
  }

  async markTurnPreparing(sourceEventId, signal) {
    await this.publishActivityFrame({kind: "lifecycle", status: "preparing_response", sourceEventId}, signal);
  }

  async markTurnPosted(sourceEventId, canonicalEventId, signal) {
    await this.publishActivityFrame({kind: "terminal", status: "posted", sourceEventId, canonicalEventId}, signal);
  }

  async close() {
    this.closed = true;
    this.heartbeatAbort.abort();
    await this.heartbeatTask?.catch(() => {});
  }
}

async function waitForState(path, signal) {
  while (true) {
    try { return await loadState(path); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await sleep(750, signal);
    }
  }
}

export function createRoomClient(account, dependencies) {
  return new OpenClawRoomRuntime(account, dependencies);
}

export function isAssignedMessage(event, membershipId) {
  if (event.type !== "message.posted" || event.actorId === membershipId) return false;
  const actorRole = String(event.actorRole ?? "");
  if (actorRole === "human" || actorRole.startsWith("human_") || actorRole === "room_master" || actorRole === "admin") return true;
  const payload = eventPayload(event.payload);
  const selectors = payload.recipientSelectors ?? [];
  return selectors.some((selector) => selector.membershipId === membershipId || selector.kind === "everyone");
}

function normalizeEvent(event, roomId) {
  const payload = eventPayload(event.payload);
  const actorRole = String(event.actorRole ?? "");
  const normalized = {
    id: event.id,
    sourceEventId: event.id,
    roomId,
    senderId: event.actorId,
    senderName: payload.actorDisplayName || payload.displayName || event.actorRole || "Room participant",
    senderKind: actorRole === "human" || actorRole.startsWith("human_") ? "human" : "agent",
    text: String(payload.body ?? payload.text ?? "").trim(),
    occurredAt: Date.parse(event.ts) || Date.now(),
    raw: event,
  };
  if (!normalized.text) throw new Error(`Canonical message ${event.id} has no body`);
  return normalized;
}

function eventPayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const decoded = JSON.parse(String(value || "{}"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
  } catch { return {}; }
}

async function retry(operation, signal) {
  let delay = 500;
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (signal?.aborted || attempt >= 5 || (error instanceof RoomAPIError && !error.retryable)) throw error;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

function safeKey(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 112);
  return normalized.length >= 12 ? normalized : `openclaw-${randomUUID()}`;
}
