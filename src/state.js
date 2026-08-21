import {randomUUID} from "node:crypto";
import {open, readFile, rename, mkdir, chmod, lstat, link, unlink} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {homedir} from "node:os";

export function defaultStateDirectory() {
  return `${homedir()}/.openclaw/synthetic-sociality-room/accounts`;
}

export async function loadState(path) {
  const stat = await import("node:fs/promises").then((fs) => fs.lstat(path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Room state path must be a regular file");
  if (stat.nlink > 1) throw new Error("Room state file must not be hard-linked");
  if ((stat.mode & 0o077) !== 0) throw new Error("Room state file permissions must be 0600");
  const value = JSON.parse(await readFile(path, "utf8"));
  validateState(value);
  return value;
}

const stateWrites = new Map();

export function saveState(path, value) {
  const key = resolve(path);
  const previous = stateWrites.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => replaceState(path, value));
  stateWrites.set(key, operation);
  return operation.finally(() => {
    if (stateWrites.get(key) === operation) stateWrites.delete(key);
  });
}

async function replaceState(path, value) {
  await assertStateTargetNotHardLinked(path);
  const temporary = await createTemporaryState(path, value);
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function saveNewState(path, value) {
  const temporary = await createTemporaryState(path, value);
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("This Room membership is already paired on this OpenClaw host");
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await chmod(path, 0o600);
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertStateTargetNotHardLinked(path) {
  try {
    const stat = await lstat(path);
    if (stat.nlink > 1) throw new Error("Room state file must not be hard-linked");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function createTemporaryState(path, value) {
  validateState(value);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Room state directory must be a real directory");
  await chmod(directory, 0o700);
}

export function validateState(value) {
  if (!value || value.version !== 1) throw new Error("Unsupported Room state version");
  for (const field of ["baseUrl", "roomId", "membershipId", "credential", "clientInstanceId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Room state is missing ${field}`);
  }
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error("Room state cursor is invalid");
  if (value.epochSessionRoutingInitialized !== undefined && typeof value.epochSessionRoutingInitialized !== "boolean") {
    throw new Error("Room epoch session routing marker is invalid");
  }
  if (value.legacySessionEpochId !== undefined && (
    typeof value.legacySessionEpochId !== "string" || value.legacySessionEpochId.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.legacySessionEpochId)
  )) {
    throw new Error("Room legacy session epoch is invalid");
  }
  if (value.rotateCurrentEpochSession !== undefined && typeof value.rotateCurrentEpochSession !== "boolean") {
    throw new Error("Room current epoch rotation marker is invalid");
  }
  if (value.messagePayloadDialect !== undefined && !["v1", "v2"].includes(value.messagePayloadDialect)) {
    throw new Error("Room message payload dialect is invalid");
  }
  if (value.messagePayloadCapabilities !== undefined && (
    !Array.isArray(value.messagePayloadCapabilities)
    || !value.messagePayloadCapabilities.every((item) => typeof item === "string")
  )) throw new Error("Room message payload capabilities are invalid");
  if (value.deliveryIntents !== undefined && (
    !value.deliveryIntents || typeof value.deliveryIntents !== "object" || Array.isArray(value.deliveryIntents)
  )) throw new Error("Room delivery intents are invalid");
  for (const [key, intent] of Object.entries(value.deliveryIntents ?? {})) validateDeliveryIntent(key, intent, value);
  if (value.terminalEvidence !== undefined && (
    !value.terminalEvidence || typeof value.terminalEvidence !== "object" || Array.isArray(value.terminalEvidence)
  )) throw new Error("Room terminal evidence ledger is invalid");
  for (const [key, evidence] of Object.entries(value.terminalEvidence ?? {})) {
    const seq = Number(key);
    if (!Number.isSafeInteger(seq) || seq < 1 || !evidence || evidence.sourceSeq !== seq || !String(evidence.sourceEventId ?? "")) {
      throw new Error("Room terminal evidence entry is invalid");
    }
    if (!["posted", "skipped", "cancelled", "superseded", "ignored"].includes(evidence.status)) {
      throw new Error("Room terminal evidence status is invalid");
    }
    if (evidence.status === "posted" ? !String(evidence.canonicalEventId ?? "") : !String(evidence.reason ?? "")) {
      throw new Error("Room terminal evidence proof is invalid");
    }
  }
}

function validCanonicalTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function validFrozenPost(intent) {
  const post = intent?.post;
  const identity = intent?.identity;
  const legacy = intent?.version === 1;
  if (!post || typeof post !== "object" || !identity) return false;
  if (post.body !== identity.body || post.idempotencyKey !== intent.messageIdempotencyKey) return false;
  if (!Number.isSafeInteger(post.observedSeq) || post.observedSeq < 0) return false;
  if (!legacy || identity.postObservedSeq !== undefined) {
    if (post.observedSeq !== identity.postObservedSeq) return false;
  }
  if (identity.topicId ? post.topicId !== identity.topicId : post.topicId !== undefined) return false;
  if (!legacy || identity.postObservedEpochId !== undefined) {
    if (identity.postObservedEpochId ? post.observedEpochId !== identity.postObservedEpochId : post.observedEpochId !== undefined) return false;
  } else if (post.observedEpochId !== undefined && typeof post.observedEpochId !== "string") return false;
  if (identity.sourceEpochId && post.observedEpochId !== identity.sourceEpochId) return false;
  if (intent.messagePayloadDialect === "v2" ? post.logicalContributionId !== intent.logicalContributionId : post.logicalContributionId !== undefined) return false;
  if (identity.replyToId ? JSON.stringify(post.respondsTo) !== JSON.stringify([identity.replyToId]) : post.respondsTo !== undefined) return false;
  if (identity.nextRecipient ? JSON.stringify(post.recipientSelectors) !== JSON.stringify([{kind: "membership", membershipId: identity.nextRecipient}]) : post.recipientSelectors !== undefined) return false;
  if (identity.cycle) {
    if (post.cycleId !== identity.cycle.cycleId || post.attemptId !== identity.cycle.attemptId || post.cycleGeneration !== identity.cycle.generation) return false;
  } else if (post.cycleId !== undefined || post.attemptId !== undefined || post.cycleGeneration !== undefined) return false;
  if (intent.turn?.turnId ? post.turnId !== intent.turn.turnId : post.turnId !== undefined) return false;
  return post.contributionType === (identity.nextRecipient ? "question" : "claim");
}

function validateDeliveryIntent(key, intent, state) {
  if (!key || !intent || typeof intent !== "object" || ![1, 2].includes(intent.version)) {
    throw new Error("Room delivery intent version is invalid");
  }
  if (!["selected", "preparing", "delivery_pending", "lifecycle_pending", "posted", "quarantined", "lifecycle_blocked", "superseded"].includes(intent.status)) {
    throw new Error("Room delivery intent status is invalid");
  }
  if (!["v1", "v2"].includes(intent.messagePayloadDialect)) throw new Error("Room delivery intent dialect is invalid");
  const identity = intent.identity;
  if (!identity || identity.roomId !== state.roomId || typeof identity.body !== "string" || typeof identity.sourceEventId !== "string") {
    throw new Error("Room delivery intent identity is invalid");
  }
  // Canonical source-event delivery slots must be inseparably bound. Older
  // dispatcher/proactive keys remain loadable for compatibility, but the
  // historical fence scans and rejects any such pending alias before ack.
  if (intent.version === 2 && key.endsWith(":final") && key !== `${identity.sourceEventId}:final`) {
    throw new Error("Room delivery intent key is not bound to its source event");
  }
  if (identity.sourceEpochId !== undefined && (
    typeof identity.sourceEpochId !== "string" || identity.sourceEpochId.length > 512 || /[\u0000-\u001f\u007f]/.test(identity.sourceEpochId)
  )) throw new Error("Room delivery source epoch is invalid");
  if (identity.cycle !== null && identity.cycle !== undefined && (
    typeof identity.cycle.cycleId !== "string" || !identity.cycle.cycleId
    || typeof identity.cycle.attemptId !== "string" || !identity.cycle.attemptId
    || !Number.isSafeInteger(identity.cycle.generation) || identity.cycle.generation < 0
  )) throw new Error("Room delivery cycle identity is invalid");
  if (intent.version === 2 && (
    !intent.binding
    || intent.binding.roomId !== state.roomId
    || intent.binding.membershipId !== state.membershipId
    || intent.binding.clientInstanceId !== state.clientInstanceId
  )) throw new Error("Room delivery intent binding is invalid");
  if (intent.post !== undefined && !validFrozenPost(intent)) throw new Error("Room frozen post is invalid");
  if (intent.deliveryState === "delivery_pending" && !validFrozenPost(intent)) throw new Error("Room pending delivery requires an exact frozen post");
  if (intent.canonicalMessage !== undefined && (
    !intent.canonicalMessage
    || typeof intent.canonicalMessage.id !== "string" || !intent.canonicalMessage.id
    || !Number.isSafeInteger(intent.canonicalMessage.seq) || intent.canonicalMessage.seq < 1
    || !validCanonicalTimestamp(intent.canonicalMessage.ts)
  )) throw new Error("Room canonical delivery receipt is invalid");
  if (intent.version === 2 && intent.canonicalMessage !== undefined && identity.cycle && (
    !intent.lifecycleRequest
    || intent.lifecycleRequest.kind !== "cycle"
    || intent.lifecycleRequest.cycleId !== identity.cycle.cycleId
    || intent.lifecycleRequest.attemptId !== identity.cycle.attemptId
    || intent.lifecycleRequest.payload?.generation !== identity.cycle.generation
    || intent.lifecycleRequest.payload?.action !== "contribute"
    || intent.lifecycleRequest.payload?.eventId !== intent.canonicalMessage.id
  )) throw new Error("Room cycle lifecycle request is not bound to its canonical receipt");
  if (intent.version === 2 && intent.canonicalMessage !== undefined && !identity.cycle && intent.turn && (
    !intent.lifecycleRequest
    || intent.lifecycleRequest.kind !== "turn"
    || intent.lifecycleRequest.turnId !== intent.turn.turnId
    || intent.lifecycleRequest.observedSeq !== intent.canonicalMessage.seq
    || intent.lifecycleRequest.sourceEventId !== identity.sourceEventId
    || intent.lifecycleRequest.idempotencyKey !== intent.finishIdempotencyKey
  )) throw new Error("Room turn lifecycle request is not bound to its canonical receipt");
  if (intent.receipt !== undefined && (
    !intent.canonicalMessage || intent.receipt?.eventId !== intent.canonicalMessage.id
  )) throw new Error("Room delivery receipt does not match its canonical event");
  if (intent.deliveryState !== undefined && !["selected", "delivery_pending", "posted", "quarantined", "superseded"].includes(intent.deliveryState)) {
    throw new Error("Room delivery state is invalid");
  }
  if (intent.version === 2) {
    const expectedDeliveryState = {
      selected: "selected",
      delivery_pending: "delivery_pending",
      lifecycle_pending: "posted",
      posted: "posted",
      quarantined: "quarantined",
      lifecycle_blocked: "posted",
      superseded: "superseded",
    }[intent.status];
    if (!expectedDeliveryState || intent.deliveryState !== expectedDeliveryState) {
      throw new Error("Room delivery status and delivery state are inconsistent");
    }
  }
  if (intent.deliveryState === "posted" && (
    !intent.canonicalMessage
    || typeof intent.canonicalMessage.id !== "string" || !intent.canonicalMessage.id
    || !Number.isSafeInteger(intent.canonicalMessage.seq) || intent.canonicalMessage.seq < 1
    || !validCanonicalTimestamp(intent.canonicalMessage.ts)
  )) throw new Error("posted Room delivery intent requires a complete canonical receipt");
  if (intent.lifecycleState !== undefined && !["not_started", "pending", "complete", "not_required", "blocked"].includes(intent.lifecycleState)) {
    throw new Error("Room lifecycle state is invalid");
  }
  if (intent.lifecycleAttempts !== undefined && (!Number.isSafeInteger(intent.lifecycleAttempts) || intent.lifecycleAttempts < 0 || intent.lifecycleAttempts > 3)) {
    throw new Error("Room lifecycle attempt count is invalid");
  }
}
