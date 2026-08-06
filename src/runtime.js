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
        if (!isAssignedEvent(event, this.state.membershipId)) {
          await this.ackEvent(event);
          continue;
        }
        const cycleAttempt = await this.prepareCycleAttempt(event, signal);
        if (cycleAttempt === false) {
          await this.ackEvent(event);
          continue;
        }
        this.pendingEvent = event;
        await this.markContextAcknowledged(event, signal);
        yield normalizeEvent(event, this.state.roomId, cycleAttempt || null);
      }
    }
  }

  async prepareCycleAttempt(event, signal) {
    const payload = eventPayload(event.payload);
    if (isHumanCycleSource(event)) {
      const cycle = await this.ensureDiscussionCycle(event, signal);
      if (!cycle) return false;
      return this.claimAssignedAttempt(cycle.id, signal);
    }
    if (!payload.cycleId) return null;
    return this.claimAssignedAttempt(String(payload.cycleId), signal);
  }

  async ensureDiscussionCycle(event, signal) {
    const state = await this.client.roomState(this.state, signal);
    if (!state.activeEpoch?.id) return null;
    let roster = (state.roster ?? []).filter((member) => member.status === "active" && ["participant_agent", "room_master"].includes(member.role));
    const payload = eventPayload(event.payload);
    const resolved = Array.isArray(payload.resolvedRecipientMembershipIds)
      ? new Set(payload.resolvedRecipientMembershipIds.map(String))
      : null;
    if (resolved) roster = roster.filter((member) => resolved.has(String(member.membershipId)));
    if (event.type === "human.command") {
      const policy = await this.client.roomPolicy(this.state, signal);
      const coordinator = String(policy.summaryCoordinatorMembershipId ?? "");
      roster = roster.filter((member, index) => String(member.membershipId) === coordinator || (!coordinator && index === 0));
    }
    if (!roster.some((member) => String(member.membershipId) === this.state.membershipId)) return null;
    const agents = roster.map((member) => ({membershipId: String(member.membershipId), displayName: String(member.displayName || "Agent")}));
    return this.client.startDiscussionCycle(this.state, {
      epochId: state.activeEpoch.id,
      sourceEventId: event.id,
      policyDigest: "0".repeat(64),
      researchDigest: "0".repeat(64),
      roster: agents,
      budgets: {totalTurns: 1, perAgentTurns: 1, maxContributionBytes: 1, maxCycleBytes: 1, maxDuration: 1, maxFollowUps: 0},
      idempotencyKey: safeKey(`openclaw-cycle:${event.id}`),
    }, signal);
  }

  async claimAssignedAttempt(cycleId, signal) {
    try {
      return await this.client.claimDiscussionAttempt(this.state, cycleId, signal);
    } catch (error) {
      if (error instanceof RoomAPIError && ["cycle_no_attempt", "cycle_superseded"].includes(error.code)) return false;
      throw error;
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

  async postAndFinish({roomId, text, replyToId, idempotencyKey, signal, sourceEventId, cycleAttempt = null}) {
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
    const nextRecipient = cycleAttempt ? nextCycleRecipient(cycleAttempt.cycle, this.state.membershipId) : "";
    const message = await this.client.postMessage(this.state, {
      turnId: granted.turnId,
      observedSeq: fresh.headSeq,
      idempotencyKey: safeKey(`${idempotencyKey}:message`),
      ...(topicId ? {topicId} : {}),
      ...(fresh.activeEpoch?.id ? {observedEpochId: fresh.activeEpoch.id} : {}),
      ...(replyToId ? {respondsTo: [replyToId]} : {}),
      ...(nextRecipient ? {recipientSelectors: [{kind: "membership", membershipId: nextRecipient}]} : {}),
      ...(cycleAttempt ? {
        cycleId: cycleAttempt.cycle.id,
        attemptId: cycleAttempt.attempt.id,
        cycleGeneration: cycleAttempt.cycle.generation,
      } : {}),
      contributionType: nextRecipient ? "question" : "claim",
      body,
    }, signal);
    if (cycleAttempt) {
      await this.client.completeDiscussionAttempt(this.state, cycleAttempt.cycle.id, cycleAttempt.attempt.id, {
        generation: cycleAttempt.cycle.generation,
        action: "contribute",
        eventId: message.id,
      }, signal);
      cycleAttempt.settled = true;
    }
    await this.client.finishTurn(this.state, {
      turnId: granted.turnId,
      observedSeq: message.seq,
      idempotencyKey: safeKey(`${idempotencyKey}:finish`),
    }, signal);
    await this.markTurnPosted(sourceEventId, message.id, signal);
    return {eventId: message.id, sentAt: Date.parse(message.ts) || Date.now()};
  }

  async passDiscussionAttempt(cycleAttempt, signal) {
    if (!cycleAttempt || cycleAttempt.settled) return null;
    try {
      const result = await this.client.completeDiscussionAttempt(
        this.state,
        cycleAttempt.cycle.id,
        cycleAttempt.attempt.id,
        {generation: cycleAttempt.cycle.generation, action: "pass"},
        signal,
      );
      cycleAttempt.settled = true;
      return result;
    } catch (error) {
      if (error instanceof RoomAPIError && error.code === "cycle_superseded") return null;
      throw error;
    }
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
  // The server-resolved membership list is authoritative for selectors such
  // as display_name. Reading it also keeps platform adapters independent from
  // the selector syntax used by the sender while preserving explicit routing:
  // unaddressed agent speech must never wake every connector implicitly.
  if (Array.isArray(payload.resolvedRecipientMembershipIds)) {
    return payload.resolvedRecipientMembershipIds.map(String).includes(String(membershipId));
  }
  const selectors = payload.recipientSelectors ?? [];
  return selectors.some((selector) => selector.membershipId === membershipId || selector.kind === "everyone");
}

export function isAssignedEvent(event, membershipId) {
  if (event?.type === "discussion.cycle_attempt_ready") {
    return String(eventPayload(event.payload).membershipId ?? "") === String(membershipId);
  }
  return isHumanCycleSource(event) || isAssignedMessage(event, membershipId);
}

function isHumanCycleSource(event) {
  const role = String(event?.actorRole ?? "");
  if (!(role === "human" || role.startsWith("human_"))) return false;
  if (event?.type === "message.posted") return true;
  const command = eventPayload(event?.payload).command;
  return event?.type === "human.command" && command?.command === "summarize";
}

function nextCycleRecipient(cycle, membershipId) {
  const roster = Array.isArray(cycle?.roster) ? cycle.roster : [];
  if (roster.length < 2) return "";
  if (Number(cycle?.followUps ?? 0) >= Number(cycle?.budgets?.maxFollowUps ?? 0)) return "";
  const start = roster.findIndex((agent) => String(agent.membershipId) === String(membershipId));
  for (let offset = 1; offset < roster.length; offset += 1) {
    const candidate = roster[(Math.max(start, 0) + offset) % roster.length];
    const progress = cycle?.progress?.[candidate.membershipId] ?? {};
    if (!progress.finished && Number(progress.turns ?? 0) < Number(cycle?.budgets?.perAgentTurns ?? 0)) return String(candidate.membershipId);
  }
  return "";
}

export function normalizeEvent(event, roomId, cycleAttempt = null) {
  const payload = eventPayload(event.payload);
  const actorRole = String(event.actorRole ?? "");
  const normalized = {
    id: event.id,
    // Delivery/idempotency identity must remain the unique canonical event.
    // A ready event separately retains the earlier causal source for respondsTo.
    sourceEventId: event.id,
    respondsToId: event.type === "discussion.cycle_attempt_ready"
      ? String(payload.sourceEventId || event.id)
      : event.id,
    roomId,
    senderId: event.actorId,
    senderName: payload.actorDisplayName || payload.displayName || event.actorRole || "Room participant",
    senderKind: actorRole === "human" || actorRole.startsWith("human_") ? "human" : "agent",
    text: cyclePrompt(event, payload, cycleAttempt),
    occurredAt: Date.parse(event.ts) || Date.now(),
    raw: event,
    cycleAttempt,
  };
  if (!normalized.text) throw new Error(`Canonical message ${event.id} has no body`);
  return normalized;
}

function cyclePrompt(event, payload, cycleAttempt) {
  if (event.type === "discussion.cycle_attempt_ready") {
    return "Continue the autonomous discussion from the shared canonical Room context. Add a meaningful new point; do not repeat prior contributions.";
  }
  if (event.type === "human.command") return "Wrap up this discussion now. Synthesize common ground, disagreements, unresolved questions, and attribute positions accurately.";
  const text = String(payload.body ?? payload.text ?? "").trim();
  if (!cycleAttempt) return text;
  const {attempt, cycle} = cycleAttempt;
  const finalTurn = Number(cycle.totalTurns ?? 0) + 1 >= Number(cycle.budgets?.totalTurns ?? Infinity);
  return [
    `[Autonomous Room discussion: round ${attempt.round}, turn ${Number(cycle.totalTurns ?? 0) + 1}/${cycle.budgets?.totalTurns}]`,
    text,
    finalTurn
      ? "This is the final budgeted turn. Briefly synthesize common ground, differences, and unresolved questions before concluding."
      : "Respond to the substance as yourself, advance the discussion, and directly engage the other participants when useful.",
  ].join("\n\n");
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
