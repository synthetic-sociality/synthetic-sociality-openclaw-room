// Contract L1 and L1o: the OpenClaw device link.
//
// A person links this OpenClaw installation to their Harness as a local
// device of kind `openclaw`: the gateway dials out to the Harness over one
// WebSocket and carries the person's OpenClaw seats as channels, each bridged
// to this gateway's own loopback WebSocket. No inbound port, no Tailscale, no
// tunnel. The wire is fixed by the L1 specification (pinned in the contract
// section "L1 — Device link") and the Harness side `openclaw-link.ts`; the
// contract section "L1o — OpenClaw device link" states the OpenClaw rules.
// This module holds:
//
// - the token, URL, label and signature rules (L1-1 … L1-3, L1o-2), pure;
// - the link record in the fenced store (L1-9, L1-10, L1o-3);
// - the pairing confirmation (L1-2), run by `openclaw-room-link` and, while a
//   first link is pending, by the gateway;
// - the local Gateway connection (L1o-5) and the channel projection (L1o-6);
// - the gateway-side link service (L1-4 … L1-8): one outbound WebSocket per
//   installation, only while linked.
//
// Nothing here logs, prints or stores the token, the pairing secret, the
// private key or the local Gateway credential outside the fenced store; every
// value that reaches a status, log or exception is a fixed code or an id.
import {createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as signBytes} from "node:crypto";
import {chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmdirSync, unlinkSync, writeSync} from "node:fs";
import http from "node:http";
import https from "node:https";
import {hostname} from "node:os";
import {dirname, join} from "node:path";
import {assertStateDirectoryPath, openClawStateDirectory} from "./state.js";
import {STORE_DIRECTORY_NAME, rememberSecretValues, scrubbingLogger} from "./secret-isolation.js";
import {WebSocketRefused, connectWebSocket} from "./link-socket.js";
import {ROOM_CONNECTOR_PROVENANCE} from "./release-provenance.js";

export const TOKEN_PREFIX = "twoc1.";
export const MAX_TOKEN_LENGTH = 4096;
export const EXPIRY_SKEW_SECONDS = 60;
export const LABEL_LIMIT = 120;
export const CONFIRMATION_BODY_LIMIT = 4096;
export const CONNECT_SUFFIX = "/local-devices/connect";
export const CONFIRMATION_SUFFIX = "/local-devices/pairing-confirmations";
export const LINK_FILE = "link.json";
// Contract L1-9: a (re-)link waits here until its 201; link.json changes only then.
export const LINK_PENDING_FILE = "link-pending.json";
export const LINK_LOCK_FILE = "link.lock";
export const LINK_SCHEMA = "synthetic-sociality-room-link-v1";
// Contract L1-5: fallbacks when authentication-complete carries no (valid)
// limits. The OpenClaw relay advertises maxDataBytes, openTimeoutMs and
// maxChannels (openclaw-link.ts); the other two take their fallbacks.
export const FALLBACK_LIMITS = Object.freeze({
  maxFrameBytes: 6_291_456,
  maxDataBytes: 3_145_728,
  openTimeoutMs: 15_000,
  maxChannels: 4,
  keepaliveMs: 25_000,
});
export const LIMIT_RANGES = Object.freeze({
  maxFrameBytes: [1024, 8_388_608],
  maxDataBytes: [1024, 8_388_608],
  openTimeoutMs: [1000, 60_000],
  maxChannels: [1, 16],
  keepaliveMs: [1000, 300_000],
});
// Server messages up to the schema maximum carrier plus 1 KiB (>= 6 MiB + 1 KiB).
export const CLIENT_MAX_MESSAGE_BYTES = 8_388_608 + 1024;
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const RECORD_POLL_MS = 2_000;
// Contract L1-8: the reconnect schedule of P2c-3a (runtime.js reconnectDelayMs).
export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_CAP_MS = 15_000;
const BACKOFF_JITTER_LOW = 0.8;
// Contract L1o-5: the OpenClaw gateway this plugin runs in.
export const DEFAULT_LOCAL_GATEWAY_PORT = 18789;
export const LOCAL_GATEWAY_HOST = "127.0.0.1";
export const GATEWAY_PROTOCOL = 4;
// The gateway's pre-connect frame cap (MAX_PREAUTH_PAYLOAD_BYTES).
const GATEWAY_PREAUTH_BYTES = 64 * 1024;
// Contract L1o-6: the projection.
export const ADMITTED_METHODS = Object.freeze(["sessions.list", "chat.history", "chat.send", "chat.abort"]);
export const MAX_PENDING_REQUESTS = 64;
export const LIST_LIMIT_MAX = 200;
export const LIST_LIMIT_DEFAULT = 50;
const STRING_PARAM_MAX = 512;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const METHOD_REFUSAL_MESSAGE = "This method is not available over the link.";
// Contract "Link features" (LF-1 to LF-7): what a channel admits beyond
// L1o-6 when the Harness advertises `limits.openclawLinkFeatures: 1`.
export const LINK_FEATURES = Object.freeze(["create", "archive", "attachments", "approvals"]);
export const LINK_FEATURE_METHODS = Object.freeze({
  create: Object.freeze(["sessions.create"]),
  archive: Object.freeze(["sessions.patch"]),
  attachments: Object.freeze(["chat.send"]),
  approvals: Object.freeze(["exec.approval.list", "plugin.approval.list", "exec.approval.resolve", "plugin.approval.resolve"]),
});
export const LINK_FEATURE_EVENTS = Object.freeze({
  approvals: Object.freeze(["exec.approval.requested", "plugin.approval.requested", "exec.approval.resolved", "plugin.approval.resolved"]),
});
export const APPROVALS_SCOPE = "operator.approvals";
export const MAX_APPROVAL_ENTRIES = 32;
export const APPROVAL_STRING_MAX = 32768;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 716800;
const APPROVAL_ID_MAX = 128;
const DEFAULT_DECISIONS = Object.freeze(["allow-once", "allow-always", "deny"]);
const APPROVAL_REQUEST_STRINGS = ["sessionKey", "parentSessionKey", "parent", "commandPreview", "command", "title", "description", "toolName", "tool"];
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const MIME_TYPE = /^[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+$/;
const FILE_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f/\\]/;
const PADDED_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_SECRET = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);
// Contract L1-1: plain http/ws only to a loopback host, and only in a test build.
let allowLoopbackPlain = false;
export function allowLoopbackPlainForTests(value) {
  allowLoopbackPlain = Boolean(value);
}

export const STOP = "stop";
export const RECONNECT = "reconnect";

// A refusal with a fixed code; the message never holds a secret.
export class LinkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// `reason`, when set, is the open-failure reason that overrides the one the
// code maps to (contract: open-failure reason), e.g. `open_timeout`.
export class LocalGatewayError extends Error {
  constructor(code, reason = "") {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}

class ProtocolError extends Error {}

function isoNow(clock = Date.now) {
  return new Date(clock()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTime(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) throw new Error("not an ISO-8601 UTC time");
  const parsed = Date.parse(value.replace(/(\.\d{3})\d*Z$/, "$1Z"));
  if (!Number.isFinite(parsed)) throw new Error("not an ISO-8601 UTC time");
  return parsed;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// --- L1-1, L1o-2: token and URLs -------------------------------------------------

export function parseToken(raw, {now = Date.now()} = {}) {
  const text = String(raw ?? "").trim();
  if (!text) throw new LinkError("link_token_invalid", "no link token was entered");
  if (text.length > MAX_TOKEN_LENGTH) throw new LinkError("link_token_invalid", "the link token is too long");
  if (!text.startsWith(TOKEN_PREFIX)) {
    throw new LinkError("link_token_invalid", "this is not an OpenClaw link token (it must start with twoc1.); create one on your OpenClaw card");
  }
  const body = text.slice(TOKEN_PREFIX.length);
  if (!body || !BASE64URL.test(body)) throw new LinkError("link_token_invalid", "the link token is not valid base64url");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.from(body, "base64url")));
  } catch {
    throw new LinkError("link_token_invalid", "the link token cannot be decoded");
  }
  if (!isObject(payload)) throw new LinkError("link_token_invalid", "the link token cannot be decoded");
  if (payload.v !== 1) throw new LinkError("link_token_unsupported", "this link token version is not supported; update the plugin");
  const fields = {};
  for (const name of ["audience", "deviceId", "pairingSecret", "expiresAt"]) {
    const value = payload[name];
    if (typeof value !== "string" || !value) throw new LinkError("link_token_invalid", `the link token has no ${name}`);
    fields[name] = value;
  }
  if (!UUID4.test(fields.deviceId)) throw new LinkError("link_token_invalid", "the link token has an invalid deviceId");
  if (!PAIRING_SECRET.test(fields.pairingSecret)) throw new LinkError("link_token_invalid", "the link token has an invalid pairing secret");
  let expires;
  try {
    expires = parseTime(fields.expiresAt);
  } catch {
    throw new LinkError("link_token_invalid", "the link token has an invalid expiry");
  }
  deriveUrls(fields.audience, fields.deviceId);
  if (expires - now < -EXPIRY_SKEW_SECONDS * 1000) {
    throw new LinkError("link_pairing_expired", "the link token has expired; create a new one on your OpenClaw card");
  }
  return fields;
}

// [connect URL, confirmation URL] from the token audience (L1-1).
export function deriveUrls(audience, deviceId) {
  const invalid = () => new LinkError("link_token_invalid", "the link token has an invalid audience");
  if (typeof audience !== "string" || audience.length > 200 || audience !== audience.trim()
    || [...audience].some((ch) => ch.charCodeAt(0) < 0x21 || ch.charCodeAt(0) === 0x7f)) throw invalid();
  let parts;
  try {
    parts = new URL(audience);
  } catch {
    throw invalid();
  }
  const host = parts.hostname.toLowerCase();
  let socketScheme;
  if (parts.protocol === "https:") socketScheme = "wss:";
  else if (parts.protocol === "http:" && allowLoopbackPlain && LOOPBACK_HOSTS.has(host)) socketScheme = "ws:";
  else throw new LinkError("link_token_invalid", "the link token's server address must use https");
  if (!host || parts.search || parts.hash || audience.includes("?") || audience.includes("#")
    || parts.username || parts.password || !parts.pathname.endsWith(CONNECT_SUFFIX)) throw invalid();
  if (!UUID4.test(String(deviceId ?? ""))) throw new LinkError("link_token_invalid", "the link token has an invalid deviceId");
  const base = parts.pathname.slice(0, -CONNECT_SUFFIX.length);
  const connect = `${socketScheme}//${parts.host}${parts.pathname}?deviceId=${deviceId}`;
  const confirmation = `${parts.protocol}//${parts.host}${base}${CONFIRMATION_SUFFIX}`;
  return [connect, confirmation];
}

export function serverHost(audience) {
  try {
    return new URL(audience).host;
  } catch {
    return "";
  }
}

// --- L1-2, L1-3: label, keys, signature input ---------------------------------------

function utf16Length(text) {
  return text.length;
}

// Machine name and OpenClaw profile, trimmed, within the spec limits (L1o-2).
export function deviceLabel(node = hostname(), profile = process.env.OPENCLAW_PROFILE) {
  const raw = `${node || ""} · OpenClaw ${String(profile ?? "").trim() || "default"}`;
  const cleaned = [...raw].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch)).join("");
  let label = cleaned.split(/\s+/u).filter(Boolean).join(" ");
  while (label && utf16Length(label) > LABEL_LIMIT) label = label.slice(0, -1).trimEnd();
  return label || "OpenClaw";
}

// ECMAScript JSON.stringify bytes of an object built in key order (L1-3).
export function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function pairingProofBytes(deviceId, pairingSecret, label, spkiBase64) {
  return jsonBytes({version: 1, deviceId, pairingSecret, deviceLabel: label, publicKeySpkiBase64: spkiBase64});
}

export function handshakeProofBytes(challenge) {
  return jsonBytes({
    version: challenge.version,
    handshakeId: challenge.handshakeId,
    connectionId: challenge.connectionId,
    deviceId: challenge.deviceId,
    audience: challenge.audience,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  });
}

export function newPrivateSeed() {
  return randomBytes(32);
}

function privateKey(seed) {
  return createPrivateKey({key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8"});
}

export function publicSpkiDer(seed) {
  return createPublicKey(privateKey(seed)).export({format: "der", type: "spki"});
}

export function publicSpkiBase64(seed) {
  return publicSpkiDer(seed).toString("base64");
}

export function fingerprint(seed) {
  return createHash("sha256").update(publicSpkiDer(seed)).digest("hex");
}

export function sign(seed, data) {
  return signBytes(null, data, privateKey(seed)).toString("base64");
}

// --- L1-9, L1-10, L1o-3: the link record in the fenced store ----------------------------

// The plugin's fenced store (P2c-1): <OPENCLAW_STATE_DIR>/synthetic-sociality-room.
export function linkDirectory(options) {
  return join(openClawStateDirectory(options), STORE_DIRECTORY_NAME);
}

export function linkPath(options) {
  return join(linkDirectory(options), LINK_FILE);
}

export function pendingPath(path = linkPath()) {
  return join(dirname(path), LINK_PENDING_FILE);
}

function seedOf(record) {
  const text = String(record?.privateKeyBase64 ?? "");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new Error("invalid link key");
  const seed = Buffer.from(text, "base64");
  if (seed.length !== 32) throw new Error("invalid link key");
  return seed;
}

function remember(record) {
  if (isObject(record)) rememberSecretValues([record.privateKeyBase64, record.pairingSecret]);
}

const RECORD_STATES = new Set(["active", "pending", "refused", "expired"]);

// Every field the link code reads, checked on load.
export function validateRecord(record) {
  if (!isObject(record) || record.schema !== LINK_SCHEMA) throw new Error("unsupported link record");
  if (!RECORD_STATES.has(record.state)) throw new Error("link record state is invalid");
  for (const key of ["deviceId", "audience", "deviceLabel", "privateKeyBase64", "publicKeySpkiBase64", "fingerprintSha256"]) {
    if (typeof record[key] !== "string" || !record[key]) throw new Error(`link record lacks ${key}`);
  }
  if (!UUID4.test(record.deviceId) || !/^[0-9a-f]{64}$/.test(record.fingerprintSha256)) throw new Error("link record identity is invalid");
  seedOf(record);
  if (record.state === "pending") {
    if (typeof record.pairingSecret !== "string" || !PAIRING_SECRET.test(record.pairingSecret)) throw new Error("pending link record lacks its pairing secret");
    parseTime(String(record.expiresAt ?? ""));
  } else if ("pairingSecret" in record) {
    throw new Error("only a pending link record holds a pairing secret");
  }
  return record;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ensureLinkDirectory(directory) {
  assertStateDirectoryPath(directory);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("the link store must be a real directory");
  chmodSync(directory, 0o700);
  return directory;
}

// The link record, or null when not linked. Throws on an unreadable record.
export function readLink(path = linkPath()) {
  const stat = lstatOrNull(path);
  if (!stat) return null;
  const parent = lstatOrNull(dirname(path));
  if (stat.isSymbolicLink() || !stat.isFile() || !parent || parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("the link record must be a regular file in a regular directory");
  }
  chmodSync(path, 0o600);
  const record = JSON.parse(readFileSync(path, "utf8"));
  remember(record);
  return validateRecord(record);
}

function stableJson(record) {
  return JSON.stringify(record, Object.keys(record ?? {}).sort());
}

export function recordDigest(record) {
  return record ? createHash("sha256").update(stableJson(record)).digest("hex") : "";
}

// Write the record 0600 inside the fenced store, atomically (L1-10).
export function writeLink(record, path = linkPath()) {
  const directory = ensureLinkDirectory(dirname(path));
  remember(record);
  const temporary = join(directory, `.link-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record, Object.keys(record).sort(), 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return path;
}

// The record without its secrets, for display.
export function publicView(record) {
  const view = {};
  for (const key of ["state", "deviceId", "deviceLabel", "fingerprintSha256", "audience", "createdAt", "confirmedAt", "expiresAt"]) {
    if (record?.[key]) view[key] = record[key];
  }
  return view;
}

// Delete the local key, record and any pending re-link (L1-9); the deleted
// record's public view, or null when nothing was linked. No network.
export function deleteLink(path = linkPath()) {
  const pending = pendingPath(path);
  let pendingView = {};
  const pendingStat = lstatOrNull(pending);
  if (pendingStat) {
    try {
      pendingView = publicView(readLink(pending) ?? {});
    } catch {
      pendingView = {};
    }
    if (pendingStat.isDirectory() && !pendingStat.isSymbolicLink()) {
      // A hand-made directory in its place does not block unlink; one with
      // content is left as it is (never a recursive delete) and reported.
      try {
        rmdirSync(pending);
      } catch {
        pendingView = {pendingNotRemoved: true};
      }
    } else {
      unlinkSync(pending);
    }
    pendingView.pendingOnly = true;
  }
  let record = {};
  try {
    record = readLink(path) ?? {};
  } catch {
    record = {};
  }
  if (!lstatOrNull(path)) return Object.keys(pendingView).length ? pendingView : null;
  unlinkSync(path);
  const view = publicView(record);
  if (pendingView.pendingNotRemoved) view.pendingNotRemoved = true;
  return view;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

// Serialize confirmation between the CLI and the gateway. `fn` runs only
// when the lock is held; without it, `fn` is not run and null is returned.
export async function withLinkLock(path, fn, {blocking = true} = {}) {
  const directory = ensureLinkDirectory(dirname(path));
  const lock = join(directory, LINK_LOCK_FILE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let holder = 0;
      try { holder = Number(readFileSync(lock, "utf8").trim()); } catch {}
      if (!pidAlive(holder)) {
        try { unlinkSync(lock); } catch {}
        continue;
      }
      if (!blocking || attempt >= 200) return null;
      await delay(50);
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch {}
  }
}

export function pendingRecord(token, {label = deviceLabel(), seed = newPrivateSeed(), clock = Date.now} = {}) {
  return {
    schema: LINK_SCHEMA,
    state: "pending",
    deviceId: token.deviceId,
    audience: token.audience,
    deviceLabel: label,
    privateKeyBase64: Buffer.from(seed).toString("base64"),
    publicKeySpkiBase64: publicSpkiBase64(seed),
    fingerprintSha256: fingerprint(seed),
    pairingSecret: token.pairingSecret,
    expiresAt: token.expiresAt,
    createdAt: isoNow(clock),
  };
}

// --- P11b-3: the link's User-Agent and the site's bot protection ------------------------

// Every link request to the Harness origin names the link product and its
// version, never the runtime library's default (Cloudflare's Browser
// Integrity Check refuses that with 403 `error code: 1010`). The loopback
// requests to the local Gateway are unchanged.
export function linkUserAgent(version = ROOM_CONNECTOR_PROVENANCE.version) {
  return `openclaw-room-link/${String(version || ROOM_CONNECTOR_PROVENANCE.version)}`;
}

// A 403 from the site's bot protection rather than from the Harness: the
// 1010 body, or a Cloudflare 403 without the Harness JSON error.
export function blockedBySiteProtection(status, headers = {}, text = "") {
  if (status !== 403) return false;
  const body = String(text ?? "");
  if (body.includes("error code: 1010")) return true;
  const header = (name) => {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value.join(",") : String(value ?? "");
  };
  const cloudflare = /cloudflare/iu.test(header("server")) || Boolean(header("cf-ray"));
  if (!cloudflare) return false;
  try {
    const parsed = JSON.parse(body);
    return !(isObject(parsed) && typeof parsed.error === "string" && parsed.error);
  } catch {
    return true;
  }
}

// --- L1-2: pairing confirmation ---------------------------------------------------------

// 404: the token is spent, expired or invalid; never retried.
export class ConfirmationRefused extends Error {}

export class ConfirmationRetry extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function confirmationBody(record) {
  const seed = seedOf(record);
  const proof = pairingProofBytes(record.deviceId, record.pairingSecret, record.deviceLabel, record.publicKeySpkiBase64);
  const body = jsonBytes({
    version: 1,
    deviceId: record.deviceId,
    pairingSecret: record.pairingSecret,
    deviceLabel: record.deviceLabel,
    publicKeySpkiBase64: record.publicKeySpkiBase64,
    signatureBase64: sign(seed, proof),
  });
  if (body.length > CONFIRMATION_BODY_LIMIT) throw new LinkError("link_pairing_refused", "the pairing confirmation would exceed 4096 bytes");
  return body;
}

// One POST, no redirect, no proxy, no cookie, no Authorization, the link's
// own User-Agent (P11b-3): {status, headers, payload}.
export function postJson(url, body, {timeoutMs = 15_000, userAgent = linkUserAgent()} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const request = (secure ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (secure ? 443 : 80),
      path: target.pathname,
      method: "POST",
      agent: false,
      headers: {"Content-Type": "application/json", Accept: "application/json", "Content-Length": String(body.length), "User-Agent": userAgent},
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        if (size < 65_536) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => resolve({status: response.statusCode ?? 0, headers: response.headers, payload: Buffer.concat(chunks).subarray(0, 65_536)}));
      response.on("error", () => reject(new Error("response")));
    });
    const timer = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
    timer.unref?.();
    request.on("error", (error) => reject(error));
    request.on("close", () => clearTimeout(timer));
    request.end(body);
  });
}

// POST the signed confirmation once. 201 → the server's view.
export async function sendConfirmation(record, {post = postJson, version} = {}) {
  const [, url] = deriveUrls(record.audience, record.deviceId);
  let status;
  let headers;
  let payload;
  try {
    ({status, headers, payload} = await post(url, confirmationBody(record), {userAgent: linkUserAgent(version)}));
  } catch (error) {
    if (error instanceof LinkError) throw error;
    throw new ConfirmationRetry("link_connection_lost");
  }
  // P11b-3: refused by the site's bot protection before the Harness; stays pending.
  if (blockedBySiteProtection(status, headers, Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? ""))) {
    throw new ConfirmationRetry("link_blocked_by_site_protection");
  }
  if (status === 404) throw new ConfirmationRefused();
  // A redirect is answered as the refusal it is, never followed (L1-1).
  if (status >= 300 && status < 400) throw new ConfirmationRetry("link_route_refused");
  if (status !== 201) {
    let dispatcher = "";
    try { dispatcher = String(JSON.parse(payload.toString("utf8"))?.error ?? ""); } catch {}
    if ([400, 401, 403].includes(status) && ["device_id_required", "bad_path", "no_route", "sign_in_required"].includes(dispatcher)) {
      throw new ConfirmationRetry("link_route_refused");
    }
    throw new ConfirmationRetry("link_pairing_unavailable");
  }
  let view;
  try {
    view = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new ConfirmationRetry("link_pairing_unavailable");
  }
  if (!isObject(view) || view.deviceId !== record.deviceId || view.state !== "active" || view.fingerprintSha256 !== record.fingerprintSha256) {
    throw new ConfirmationRefused();
  }
  return view;
}

function retire(record, state, path) {
  // The spent pairing secret leaves the store. A working link stays as it
  // was; without one, the refused or expired first link is recorded.
  try { unlinkSync(pendingPath(path)); } catch {}
  let current;
  try {
    current = readLink(path);
  } catch {
    // An unreadable link.json is left as it is.
    return;
  }
  if (current?.state === "active") return;
  const {pairingSecret: _secret, expiresAt: _expires, ...retired} = record;
  writeLink({...retired, state}, path);
}

// One confirmation attempt for the pending (re-)link: {state, code}. state is
// `active`, `pending` (retry later), `refused`, `expired`, or `none` when
// nothing is pending. link.json is replaced only after the 201, so a failed
// re-link leaves a working link as it was (L1-9).
export async function confirmPending({path = linkPath(), now = Date.now, sender = sendConfirmation, blocking = true,
  prober = sender === sendConfirmation ? probeActive : null} = {}) {
  const result = await withLinkLock(path, async () => {
    const record = readLink(pendingPath(path));
    if (!record) return {state: "none", code: ""};
    if (now() >= parseTime(String(record.expiresAt))) {
      retire(record, "expired", path);
      return {state: "expired", code: "link_pairing_expired"};
    }
    let view;
    try {
      view = await sender(record);
    } catch (error) {
      // P11b-3: after a lost 201 the server holds the device active and
      // answers a repeated confirmation 404; a signed connect with the
      // pending key that completes proves it, and the link becomes active.
      if (error instanceof ConfirmationRefused && prober && await prober(record).catch(() => false)) {
        view = {};
      } else if (error instanceof ConfirmationRefused) {
        retire(record, "refused", path);
        return {state: "refused", code: "link_pairing_refused"};
      } else if (error instanceof ConfirmationRetry) {
        return {state: "pending", code: error.code};
      } else {
        return {state: "pending", code: "link_pairing_unavailable"};
      }
    }
    const {pairingSecret: _secret, expiresAt: _expires, ...active} = record;
    writeLink({...active, state: "active", confirmedAt: String(view?.confirmedAt || isoNow(now))}, path);
    unlinkSync(pendingPath(path));
    return {state: "active", code: ""};
  }, {blocking});
  return result ?? {state: "pending", code: "link_pending"};
}

// Drop a pending re-link (its pairing secret leaves the store).
export async function discardPending(path = linkPath()) {
  await withLinkLock(path, () => {
    try { unlinkSync(pendingPath(path)); } catch {}
  });
}

// --- L1o-5: the local Gateway --------------------------------------------------------------

function loopbackLiteral(host) {
  const value = String(host ?? "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

// {host, port, auth} of the gateway this plugin runs in (L1o-5). Throws a
// LocalGatewayError with `local_gateway_auth_unavailable` when there is no
// loopback endpoint or no non-interactive shared credential.
export function resolveLocalGateway(cfg, env = process.env) {
  const unavailable = () => new LocalGatewayError("local_gateway_auth_unavailable");
  let gateway;
  try {
    gateway = isObject(cfg?.gateway) ? cfg.gateway : {};
  } catch {
    throw unavailable();
  }
  const port = gateway.port ?? DEFAULT_LOCAL_GATEWAY_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw unavailable();
  let host = LOCAL_GATEWAY_HOST;
  const bind = gateway.bind;
  if (bind === "tailnet") throw unavailable();
  if (bind === "custom") {
    if (!loopbackLiteral(gateway.customBindHost)) throw unavailable();
    host = String(gateway.customBindHost).trim().toLowerCase().replace(/^\[|\]$/g, "");
  } else if (bind !== undefined && !["loopback", "lan", "auto"].includes(bind)) {
    throw unavailable();
  }
  const auth = isObject(gateway.auth) ? gateway.auth : {};
  const configuredToken = auth.token;
  const configuredPassword = auth.password;
  const envToken = String(env?.OPENCLAW_GATEWAY_TOKEN ?? "");
  const envPassword = String(env?.OPENCLAW_GATEWAY_PASSWORD ?? "");
  const mode = auth.mode ?? (configuredToken !== undefined || envToken ? "token" : configuredPassword !== undefined || envPassword ? "password" : undefined);
  let credential;
  if (mode === "token") {
    if (configuredToken !== undefined && typeof configuredToken !== "string") throw unavailable();
    const token = configuredToken || envToken;
    if (!token) throw unavailable();
    credential = {token};
  } else if (mode === "password") {
    if (configuredPassword !== undefined && typeof configuredPassword !== "string") throw unavailable();
    const password = configuredPassword || envPassword;
    if (!password) throw unavailable();
    credential = {password};
  } else if (mode === "none") {
    credential = undefined;
  } else {
    throw unavailable();
  }
  if (credential) rememberSecretValues(Object.values(credential));
  return {host, port, auth: credential};
}

// LF-5 (a): `approvals` asks operator.approvals as well.
export function gatewayConnectRequest(id, auth, version, {approvals = false} = {}) {
  const params = {
    minProtocol: GATEWAY_PROTOCOL,
    maxProtocol: GATEWAY_PROTOCOL,
    client: {id: "gateway-client", displayName: "Tokenwerk link", version: String(version || "0.0.0"), platform: process.platform, mode: "backend"},
    role: "operator",
    scopes: approvals ? ["operator.read", "operator.write", APPROVALS_SCOPE] : ["operator.read", "operator.write"],
    caps: [],
  };
  if (auth) params.auth = {...auth};
  params.userAgent = `synthetic-sociality-room-openclaw/${String(version || "0.0.0")}`;
  return {type: "req", id, method: "connect", params};
}

function hostUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

// One new gateway connection for one channel (L1o-5): {socket, early,
// approvals}, where `early` holds messages that arrived with the hello and
// `approvals` says the gateway granted operator.approvals. With `approvals`
// the connect asks that scope, and a refused connect is sent once more
// without it on a new connection (LF-5 (a)). Throws LocalGatewayError.
export async function openLocalGateway(options = {}) {
  if (!options.approvals) return openGatewayOnce(options, false);
  try {
    return await openGatewayOnce(options, true);
  } catch (error) {
    if (!(error instanceof LocalGatewayError && error.connectRefused)) throw error;
    return openGatewayOnce(options, false);
  }
}

async function openGatewayOnce({cfg, env = process.env, maxDataBytes = FALLBACK_LIMITS.maxDataBytes, timeoutMs = FALLBACK_LIMITS.openTimeoutMs,
  version = "", connect = connectWebSocket} = {}, approvals) {
  const {host, port, auth} = resolveLocalGateway(cfg, env);
  let socket;
  try {
    socket = await connect(`ws://${hostUrl(host)}:${port}/`, {maxMessageBytes: Math.max(maxDataBytes, GATEWAY_PREAUTH_BYTES), timeoutMs});
  } catch (error) {
    const status = error instanceof WebSocketRefused ? error.status : 0;
    const timedOut = error instanceof WebSocketRefused && status === 0 && error.reason === "timeout";
    throw new LocalGatewayError(status === 401 || status === 403 || (status >= 300 && status < 400) ? "local_gateway_refused" : "local_gateway_unavailable",
      timedOut ? "open_timeout" : "");
  }
  return await new Promise((resolve, reject) => {
    const id = `link-connect-${randomUUID()}`;
    const early = [];
    let sent = false;
    let settled = false;
    let granted = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      if (error) {
        socket.off("message", onMessage);
        socket.terminate();
        reject(error);
        return;
      }
      resolve({socket, early, approvals: granted, release: () => socket.off("message", onMessage)});
    };
    // A refusal after the connect was sent is a refused connect (LF-5 (a)).
    const refused = () => Object.assign(new LocalGatewayError("local_gateway_refused"), {connectRefused: sent});
    const onMessage = (text, binary) => {
      if (settled) {
        if (!binary) early.push(text);
        return;
      }
      if (binary) return finish(new LocalGatewayError("local_gateway_unavailable"));
      let frame;
      try { frame = JSON.parse(text); } catch { return; }
      if (frame?.type === "event" && frame.event === "connect.challenge") {
        if (!sent) {
          sent = true;
          socket.send(JSON.stringify(gatewayConnectRequest(id, auth, version, {approvals})));
        }
        return;
      }
      if (frame?.type === "res" && frame.id === id) {
        if (frame.ok === true && frame.payload?.type === "hello-ok") {
          const scopes = frame.payload.auth?.scopes;
          granted = approvals && Array.isArray(scopes) && scopes.includes(APPROVALS_SCOPE);
          return finish();
        }
        const code = String(frame.error?.code ?? "");
        finish(code === "UNAVAILABLE" ? new LocalGatewayError("local_gateway_unavailable") : refused());
      }
    };
    const onClose = (code) => finish(code === 1008 || code === 4401 || code === 4403 ? refused() : new LocalGatewayError("local_gateway_unavailable"));
    const timer = setTimeout(() => finish(new LocalGatewayError("local_gateway_unavailable", "open_timeout")), timeoutMs);
    timer.unref?.();
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.start();
  });
}

// --- L1-5, L1-8: limits, the close table, the backoff ---------------------------------------

export function readLimits(complete) {
  const advertised = isObject(complete) ? complete.limits : undefined;
  const limits = {...FALLBACK_LIMITS};
  let used = false;
  if (isObject(advertised)) {
    for (const [name, [low, high]] of Object.entries(LIMIT_RANGES)) {
      const value = advertised[name];
      if (Number.isSafeInteger(value) && value >= low && value <= high) {
        limits[name] = value;
        used = true;
      }
    }
  }
  return {limits, source: used ? "advertised" : "fallback"};
}

// Contract, open-failure reason: a Harness that accepts `reason` in
// openclaw-open-failed advertises `limits.openFailedReason: 1`. Any other
// value or none (an older Harness with a strict schema) means no `reason`.
export function readOpenFailedReason(complete) {
  const advertised = isObject(complete) ? complete.limits : undefined;
  return isObject(advertised) && advertised.openFailedReason === 1;
}

// The closed list of the contract, in its order.
export const OPEN_FAILED_REASONS = Object.freeze(["local_gateway_refused", "local_gateway_auth_unavailable", "local_gateway_unavailable",
  "link_blocked_by_site_protection", "channel_limit", "open_timeout", "unknown"]);

// LF-1: a Harness that reads link features advertises
// `limits.openclawLinkFeatures: 1`; any other value or none means 0.2.85.
export function readLinkFeatures(complete) {
  const advertised = isObject(complete) ? complete.limits : undefined;
  return isObject(advertised) && advertised.openclawLinkFeatures === 1;
}

// One code of the closed list for a failed local open; never upstream text.
export function openFailedReasonFor(error) {
  if (!(error instanceof LocalGatewayError)) return "unknown";
  const reason = error.reason || error.code;
  return OPEN_FAILED_REASONS.includes(reason) ? reason : "unknown";
}

// The fixed close table of contract L1-8: [status code, action].
export function closeOutcome(code, reason = "") {
  if (code === 1008) {
    if (reason === "revoked" || reason === "authentication-failed") return ["link_revoked", STOP];
    if (reason === "replaced") return ["link_replaced", STOP];
    return ["link_protocol_error", RECONNECT];
  }
  if (code === 1009) return ["link_frame_too_large", RECONNECT];
  return ["link_connection_lost", RECONNECT];
}

// Contract L1-8: the P2c-3a schedule, in [0.8 d, d] with d ≤ 15 s.
export function backoffDelayMs(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(Math.trunc(Number(attempt) || 0), 16)));
  return ceiling * (BACKOFF_JITTER_LOW + (1 - BACKOFF_JITTER_LOW) * random());
}

// --- L1o-6: the projection --------------------------------------------------------------------

function refusal(id, code, message) {
  return JSON.stringify({type: "res", id, ok: false, error: {code, message}});
}

const INVALID = Symbol("invalid");

function optionalString(params, key, {max = STRING_PARAM_MAX, nonEmpty = true} = {}) {
  if (!(key in params) || params[key] === undefined) return undefined;
  const value = params[key];
  if (typeof value !== "string" || value.length > max || (nonEmpty && !value)) return INVALID;
  return value;
}

function requiredString(params, key, options) {
  const value = optionalString(params, key, options);
  return value === undefined ? INVALID : value;
}

function optionalInteger(params, key, minimum) {
  if (!(key in params) || params[key] === undefined) return undefined;
  const value = params[key];
  return Number.isSafeInteger(value) && value >= minimum ? value : INVALID;
}

function optionalBoolean(params, key) {
  if (!(key in params) || params[key] === undefined) return undefined;
  return typeof params[key] === "boolean" ? params[key] : INVALID;
}

function listLimit(params) {
  const value = optionalInteger(params, "limit", 1);
  if (value === INVALID) return INVALID;
  return value === undefined ? LIST_LIMIT_DEFAULT : Math.min(value, LIST_LIMIT_MAX);
}

function assemble(entries) {
  const result = {};
  for (const [key, value] of entries) {
    if (value === INVALID) return null;
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const PROJECTORS = {
  "sessions.list": (params) => assemble([
    ["limit", listLimit(params)],
    ["offset", optionalInteger(params, "offset", 0)],
    ["search", optionalString(params, "search", {max: 200, nonEmpty: false})],
    ["agentId", optionalString(params, "agentId")],
    ["includeDerivedTitles", optionalBoolean(params, "includeDerivedTitles")],
    ["includeLastMessage", optionalBoolean(params, "includeLastMessage")],
  ]),
  "chat.history": (params) => assemble([
    ["sessionKey", requiredString(params, "sessionKey")],
    ["agentId", optionalString(params, "agentId")],
    ["limit", listLimit(params)],
    ["offset", optionalInteger(params, "offset", 0)],
  ]),
  "chat.send": (params) => assemble([
    ["sessionKey", requiredString(params, "sessionKey")],
    ["agentId", optionalString(params, "agentId")],
    ["message", typeof params.message === "string" ? params.message : INVALID],
    ["idempotencyKey", requiredString(params, "idempotencyKey", {max: 128})],
  ]),
  "chat.abort": (params) => assemble([
    ["sessionKey", requiredString(params, "sessionKey")],
    ["agentId", optionalString(params, "agentId")],
    ["runId", optionalString(params, "runId")],
  ]),
};

// --- Link features LF-3 to LF-6 --------------------------------------------------------------------

// LF-6: the attachments of chat.send, validated exactly; undefined when absent.
function attachmentsParam(params) {
  if (!("attachments" in params) || params.attachments === undefined) return undefined;
  const rows = params.attachments;
  if (!Array.isArray(rows) || rows.length > MAX_ATTACHMENTS) return INVALID;
  const kept = [];
  let bytes = 0;
  for (const row of rows) {
    if (!isObject(row)) return INVALID;
    const keys = Object.keys(row);
    if (keys.length !== 4 || !["type", "mimeType", "fileName", "content"].every((key) => Object.hasOwn(row, key))) return INVALID;
    const {type, mimeType, fileName, content} = row;
    if (type !== "image" && type !== "file") return INVALID;
    if (typeof mimeType !== "string" || mimeType.length > 128 || !MIME_TYPE.test(mimeType)) return INVALID;
    if (type === "image" && !IMAGE_MIME_TYPES.has(mimeType)) return INVALID;
    if (typeof fileName !== "string" || !fileName || fileName.length > 256 || FILE_NAME_FORBIDDEN.test(fileName)) return INVALID;
    if (typeof content !== "string" || !PADDED_BASE64.test(content)) return INVALID;
    const decoded = Buffer.from(content, "base64");
    // Canonical: re-encoding gives the same text (no stray padding bits).
    if (decoded.toString("base64") !== content) return INVALID;
    bytes += decoded.length;
    if (bytes > MAX_ATTACHMENT_BYTES) return INVALID;
    kept.push({type, mimeType, fileName, content});
  }
  return kept;
}

function decisionList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : INVALID;
}

// LF-5 (b): one approval request reduced to the named keys, or null when it
// is not forwarded (an invalid id, a kept string over 32768 characters or of
// another type, a malformed number or decision list). Nothing is ever cut.
function reduceApproval(row) {
  if (!isObject(row) || typeof row.id !== "string" || !row.id || row.id.length > APPROVAL_ID_MAX || !isObject(row.request)) return null;
  const request = {};
  for (const key of APPROVAL_REQUEST_STRINGS) {
    const value = row.request[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > APPROVAL_STRING_MAX) return null;
    request[key] = value;
  }
  const out = {id: row.id};
  for (const [target, source, key, read] of [
    [out, row, "createdAtMs", Number.isFinite], [out, row, "expiresAtMs", Number.isFinite], [out, row, "allowedDecisions", null],
    [request, row.request, "allowedDecisions", null], [request, row.request, "expiresAtMs", Number.isFinite],
  ]) {
    const value = source[key];
    if (value === undefined) continue;
    if (read ? !read(value) : decisionList(value) === INVALID) return null;
    target[key] = read ? value : [...value];
  }
  out.request = request;
  return out;
}

const APPROVAL_KIND = (name) => name.slice(0, name.indexOf("."));

// The link-feature state of one channel (LF-3 to LF-5): the announced
// features, the session keys the gateway returned on it, its served sessions
// and its approval entries. Everything is per channel and ends with it.
export class LinkFeatureState {
  constructor({clock = Date.now} = {}) {
    this.features = [];
    this.clock = clock;
    this.keys = new Set();
    this.served = new Set();
    this.entries = new Map();
  }

  announce(features) {
    this.features = LINK_FEATURES.filter((name) => features.includes(name));
  }

  has(name) {
    return this.features.includes(name);
  }

  // The feature that admits `method` on this channel, if announced.
  admits(method) {
    return LINK_FEATURES.find((name) => this.has(name) && LINK_FEATURE_METHODS[name].includes(method));
  }

  // LF-4: equal to a served session, or nested under one after ":".
  belongs(key) {
    if (typeof key !== "string" || !key) return false;
    for (const served of this.served) {
      if (key === served || key.startsWith(`${served}:`)) return true;
    }
    return false;
  }

  belongsRequest(request) {
    return this.belongs(request.sessionKey) || this.belongs(request.parentSessionKey) || this.belongs(request.parent);
  }

  // LF-5 (c): an entry is forgotten once its expiry passes.
  prune() {
    const now = this.clock();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) this.entries.delete(id);
    }
  }

  record(kind, reduced) {
    this.entries.set(reduced.id, {
      kind,
      state: "pending",
      decisions: reduced.request.allowedDecisions ?? reduced.allowedDecisions ?? [...DEFAULT_DECISIONS],
      expiresAt: reduced.request.expiresAtMs ?? reduced.expiresAtMs,
    });
  }

  // LF-5 (b), (c): a requested event's payload to forward, or null.
  requested(kind, payload) {
    const reduced = reduceApproval(payload);
    if (!reduced || !this.belongsRequest(reduced.request)) return null;
    this.prune();
    if (this.entries.has(reduced.id) || this.entries.size >= MAX_APPROVAL_ENTRIES) return null;
    this.record(kind, reduced);
    return reduced;
  }

  // LF-5 (d): a resolved event's payload to forward, or null; ends the entry.
  resolved(kind, payload) {
    if (!isObject(payload) || typeof payload.id !== "string") return null;
    this.prune();
    const entry = this.entries.get(payload.id);
    if (!entry || entry.kind !== kind) return null;
    this.entries.delete(payload.id);
    const out = {id: payload.id};
    if (typeof payload.decision === "string") out.decision = payload.decision;
    return out;
  }

  // LF-5 (e): the channel's own rows of a list answer, as a bare array.
  replay(kind, payload) {
    const rows = Array.isArray(payload) ? payload
      : [payload?.requests, payload?.pending, payload?.approvals].find((value) => Array.isArray(value)) ?? [];
    this.prune();
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      const reduced = reduceApproval(row);
      if (!reduced || seen.has(reduced.id) || !this.belongsRequest(reduced.request)) continue;
      const entry = this.entries.get(reduced.id);
      if (entry) {
        if (entry.kind !== kind || entry.state !== "pending") continue;
      } else {
        if (this.entries.size >= MAX_APPROVAL_ENTRIES) continue;
        this.record(kind, reduced);
      }
      seen.add(reduced.id);
      out.push(reduced);
    }
    return out;
  }

  // LF-5 (f): pending again after the gateway's ok false, if still answered.
  reopen(kind, id) {
    const entry = this.entries.get(id);
    if (entry && entry.kind === kind && entry.state === "answered") entry.state = "pending";
  }

  learnKey(key) {
    if (typeof key === "string" && key) this.keys.add(key);
  }

  forget() {
    this.entries.clear();
    this.served.clear();
    this.keys.clear();
  }

  // A request of an announced feature method: the same shape as projectRequest.
  project(id, method, params) {
    const invalid = {refuse: refusal(id, "invalid_params", "The parameters are not valid for this method."), id};
    if (!isObject(params)) return invalid;
    const forward = (projected, extra = {}) => ({forward: JSON.stringify({type: "req", id, method, params: projected}), id, method, ...extra});
    if (method === "sessions.create") {
      const projected = assemble([["agentId", optionalString(params, "agentId")]]);
      return projected ? forward(projected) : invalid;
    }
    if (method === "sessions.patch") {
      if (typeof params.key !== "string" || !this.keys.has(params.key) || params.archived !== true) return invalid;
      return forward({key: params.key, archived: true});
    }
    const kind = APPROVAL_KIND(method);
    if (method.endsWith(".approval.list")) return forward({});
    // *.approval.resolve: exactly id and decision, for a pending entry here.
    const keys = Object.keys(params);
    if (keys.length !== 2 || typeof params.id !== "string" || typeof params.decision !== "string") return invalid;
    this.prune();
    const entry = this.entries.get(params.id);
    if (!entry || entry.kind !== kind || entry.state !== "pending" || !entry.decisions.includes(params.decision)) return invalid;
    return forward({id: params.id, decision: params.decision}, {
      approvalId: params.id,
      commit: () => { entry.state = "answered"; },
    });
  }
}

// One server request: {forward, id, method} for the gateway, {refuse} for an
// answer from the device itself, or {invalid: true} for data that is not a
// request object. With a channel's LinkFeatureState the link features of that
// channel are admitted too, and `commit` (when present) runs once the request
// is forwarded.
export function projectRequest(text, features) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return {invalid: true};
  }
  if (!isObject(frame) || frame.type !== "req" || typeof frame.id !== "string" || !REQUEST_ID.test(frame.id) || typeof frame.method !== "string") {
    return {invalid: true};
  }
  const {id, method} = frame;
  const params = frame.params === undefined ? {} : frame.params;
  if (features && !Object.hasOwn(PROJECTORS, method) && features.admits(method)) return features.project(id, method, params);
  if (!Object.hasOwn(PROJECTORS, method)) return {refuse: refusal(id, "method_not_allowed", METHOD_REFUSAL_MESSAGE), id};
  const projected = isObject(params) ? PROJECTORS[method](params) : null;
  if (!projected) return {refuse: refusal(id, "invalid_params", "The parameters are not valid for this method."), id};
  let commit;
  if (features) {
    if (method === "chat.send" && features.has("attachments")) {
      const attachments = attachmentsParam(params);
      if (attachments === INVALID) return {refuse: refusal(id, "invalid_params", "The parameters are not valid for this method."), id};
      if (attachments !== undefined) projected.attachments = attachments;
    }
    // LF-4: an admitted chat.history or chat.send serves its session.
    if (method === "chat.history" || method === "chat.send") commit = () => features.served.add(projected.sessionKey);
  }
  return {forward: JSON.stringify({type: "req", id, method, params: projected}), id, method, ...(commit ? {commit} : {})};
}

function projectError(error) {
  const out = {
    code: typeof error?.code === "string" && ERROR_CODE.test(error.code) ? error.code : "gateway_error",
    message: typeof error?.message === "string" && error.message ? error.message.slice(0, 1000) : "The gateway refused the request.",
  };
  if (typeof error?.retryable === "boolean") out.retryable = error.retryable;
  if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0) out.retryAfterMs = error.retryAfterMs;
  return out;
}

// One gateway message for the server, or null when it is dropped. `pending`
// holds the ids of this channel's forwarded requests (a Map to what was
// forwarded, or a Set); a response consumes its id. With the channel's
// LinkFeatureState, responses teach it session keys, list answers become the
// channel's own rows (LF-5 (e)) and approval events pass as LF-5 says.
export function projectGatewayMessage(text, pending, features) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(frame)) return null;
  if (frame.type === "res" && typeof frame.id === "string" && pending.has(frame.id)) {
    const sent = typeof pending.get === "function" ? pending.get(frame.id) : undefined;
    pending.delete(frame.id);
    const out = {type: "res", id: frame.id, ok: frame.ok === true};
    if (out.ok) {
      if (frame.payload !== undefined) out.payload = frame.payload;
    } else {
      out.error = projectError(frame.error);
    }
    if (features && isObject(sent)) projectFeatureResponse(out, frame, sent, features);
    return JSON.stringify(out);
  }
  if (frame.type === "event" && frame.event === "chat") {
    const out = {type: "event", event: "chat"};
    if (frame.payload !== undefined) out.payload = frame.payload;
    if (Number.isSafeInteger(frame.seq)) out.seq = frame.seq;
    return JSON.stringify(out);
  }
  if (frame.type === "event" && features?.has("approvals") && LINK_FEATURE_EVENTS.approvals.includes(frame.event)) {
    const kind = APPROVAL_KIND(frame.event);
    const payload = frame.event.endsWith(".requested") ? features.requested(kind, frame.payload) : features.resolved(kind, frame.payload);
    if (!payload) return null;
    const out = {type: "event", event: frame.event, payload};
    if (Number.isSafeInteger(frame.seq)) out.seq = frame.seq;
    return JSON.stringify(out);
  }
  return null;
}

function projectFeatureResponse(out, frame, sent, features) {
  const {method} = sent;
  if (out.ok && method === "sessions.list" && Array.isArray(frame.payload?.sessions)) {
    for (const row of frame.payload.sessions) if (isObject(row)) features.learnKey(row.key);
  } else if (out.ok && method === "sessions.create" && isObject(frame.payload)) {
    features.learnKey(frame.payload.key);
  } else if (out.ok && method.endsWith(".approval.list") && features.has("approvals")) {
    out.payload = features.replay(APPROVAL_KIND(method), frame.payload);
  } else if (!out.ok && method.endsWith(".approval.resolve") && sent.approvalId !== undefined) {
    features.reopen(APPROVAL_KIND(method), sent.approvalId);
  }
}

// --- L1-6, L1o-4, L1o-6: channels ---------------------------------------------------------------

function frame(type, channelId, data) {
  const value = {version: 1, type, channelId};
  if (data !== undefined) value.data = data;
  return value;
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

class LinkChannel {
  constructor(bridge, id) {
    this.bridge = bridge;
    this.id = id;
    this.local = null;
    this.open = false;
    this.ended = false;
    // Forwarded request id -> {method, approvalId} (LF-5 (f) needs both).
    this.pending = new Map();
    this.queue = [];
    this.queuedBytes = 0;
    // LF-1: the channel's link-feature state, only with the capability.
    this.features = bridge.linkFeatures ? new LinkFeatureState() : null;
  }

  async run() {
    const {limits} = this.bridge;
    const opening = Promise.resolve().then(() => this.bridge.localOpener(limits, this.features ? {approvals: true} : {}));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LocalGatewayError("local_gateway_unavailable", "open_timeout")), limits.openTimeoutMs);
      timer.unref?.();
    });
    let opened;
    try {
      opened = await Promise.race([opening, timeout]);
    } catch (error) {
      opening.then((late) => late?.socket?.terminate(), () => {});
      if (this.ended) return;
      this.bridge.channelError(error instanceof LocalGatewayError ? error.code : "local_gateway_unavailable");
      this.bridge.end(this, "openclaw-open-failed", openFailedReasonFor(error));
      return;
    } finally {
      clearTimeout(timer);
    }
    if (this.ended) {
      opened.socket.terminate();
      return;
    }
    this.local = opened.socket;
    opened.release?.();
    this.local.on("message", (message, binary) => this.fromLocal(message, binary));
    this.local.on("close", (code) => {
      if (code === 1009) this.bridge.channelError("channel_data_too_large");
      this.bridge.end(this, "openclaw-close");
    });
    this.open = true;
    // L1o-5: opened once the gateway's hello-ok arrived; LF-2: with the
    // capability it names the features this channel admits.
    const openedFrame = frame("openclaw-opened", this.id);
    if (this.features) {
      this.features.announce(opened.approvals === true ? LINK_FEATURES : LINK_FEATURES.filter((name) => name !== "approvals"));
      openedFrame.features = [...this.features.features];
    }
    this.bridge.send(openedFrame);
    for (const message of opened.early ?? []) this.fromLocal(message, false);
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const text of queued) this.writeLocal(text);
  }

  fromServer(data) {
    const result = projectRequest(data, this.features ?? undefined);
    if (result.invalid) {
      this.bridge.channelError("channel_request_invalid");
      this.bridge.end(this, "openclaw-close");
      return;
    }
    if (result.refuse) {
      this.bridge.channelError("channel_method_refused");
      this.toServer(result.refuse);
      return;
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS && !this.pending.has(result.id)) {
      this.bridge.channelError("channel_method_refused");
      this.toServer(refusal(result.id, "too_many_requests", "Too many requests are waiting on this channel."));
      return;
    }
    this.pending.set(result.id, {method: result.method, approvalId: result.approvalId});
    result.commit?.();
    if (!this.open) {
      const size = byteLength(result.forward);
      if (this.queuedBytes + size > 4 * this.bridge.limits.maxDataBytes) {
        this.bridge.channelError("channel_buffer_overflow");
        this.bridge.end(this, "openclaw-close");
        return;
      }
      this.queuedBytes += size;
      this.queue.push(result.forward);
      return;
    }
    this.writeLocal(result.forward);
  }

  writeLocal(text) {
    if (this.ended || !this.local) return;
    if (this.local.bufferedAmount + byteLength(text) > 4 * this.bridge.limits.maxDataBytes) {
      this.bridge.channelError("channel_buffer_overflow");
      this.bridge.end(this, "openclaw-close");
      return;
    }
    this.local.send(text);
  }

  fromLocal(message, binary) {
    if (this.ended) return;
    if (binary) {
      this.bridge.channelError("channel_binary");
      this.bridge.end(this, "openclaw-close");
      return;
    }
    if (byteLength(message) > this.bridge.limits.maxDataBytes) {
      this.bridge.channelError("channel_data_too_large");
      this.bridge.end(this, "openclaw-close");
      return;
    }
    const projected = projectGatewayMessage(message, this.pending, this.features ?? undefined);
    if (projected !== null) this.toServer(projected);
  }

  toServer(text) {
    if (this.ended) return;
    if (byteLength(text) > this.bridge.limits.maxDataBytes || !this.bridge.send(frame("openclaw-frame", this.id, text), {channel: true})) {
      this.bridge.channelError("channel_data_too_large");
      this.bridge.end(this, "openclaw-close");
    }
  }

  closeLocal() {
    const local = this.local;
    this.local = null;
    this.open = false;
    // LF-5 (c): the channel's entries end with it.
    this.features?.forget();
    if (local) {
      try { local.close(1000); } catch {}
    }
  }
}

// The channels of one authenticated device socket (L1-6, L1o-4).
export class LinkBridge {
  constructor(socket, limits, localOpener, {onChange = () => {}, onChannelError = () => {}, openFailedReason = false, linkFeatures = false} = {}) {
    this.socket = socket;
    this.limits = limits;
    this.localOpener = localOpener;
    this.openFailedReason = openFailedReason;
    this.linkFeatures = linkFeatures;
    this.channels = new Map();
    this.onChange = onChange;
    this.onChannelError = onChannelError;
  }

  channelError(code) {
    this.onChannelError(code);
  }

  send(value, {channel = false} = {}) {
    const text = JSON.stringify(value);
    if (byteLength(text) > this.limits.maxFrameBytes) {
      if (channel) return false;
      throw new ProtocolError("oversize control frame");
    }
    this.socket.send(text);
    return true;
  }

  // openclaw-open-failed, with `reason` only when the Harness advertised it.
  openFailedFrame(channelId, reason) {
    const value = frame("openclaw-open-failed", channelId);
    if (this.openFailedReason) value.reason = OPEN_FAILED_REASONS.includes(reason) ? reason : "unknown";
    return value;
  }

  // End a channel from this side, telling the server once.
  end(channel, kind, reason) {
    if (channel.ended) return;
    channel.ended = true;
    if (this.channels.get(channel.id) === channel) {
      this.channels.delete(channel.id);
      this.onChange();
    }
    try { this.send(kind === "openclaw-open-failed" ? this.openFailedFrame(channel.id, reason) : frame(kind, channel.id)); } catch {}
    channel.closeLocal();
  }

  handle(message, binary) {
    if (binary) throw new ProtocolError("binary frame");
    let value;
    try {
      value = JSON.parse(message);
    } catch {
      throw new ProtocolError("not JSON");
    }
    if (!isObject(value)) throw new ProtocolError("not an object");
    const {version, type, channelId} = value;
    if (version !== 1) throw new ProtocolError("version");
    if (!["openclaw-open", "openclaw-frame", "openclaw-close"].includes(type)) throw new ProtocolError("type");
    if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) throw new ProtocolError("channelId");
    const channel = this.channels.get(channelId);
    if (type === "openclaw-open") {
      if (channel) {
        // A duplicate open ends that channel.
        this.channelError("channel_duplicate");
        this.end(channel, "openclaw-close");
        return;
      }
      if (this.channels.size >= this.limits.maxChannels) {
        this.channelError("channel_cap");
        this.send(this.openFailedFrame(channelId, "channel_limit"));
        return;
      }
      const opened = new LinkChannel(this, channelId);
      this.channels.set(channelId, opened);
      this.onChange();
      opened.run().catch(() => this.end(opened, "openclaw-close"));
      return;
    }
    if (type === "openclaw-frame") {
      const {data} = value;
      if (typeof data !== "string") throw new ProtocolError("data");
      if (!channel) {
        // An unknown channel is ended.
        this.channelError("channel_unknown");
        this.send(frame("openclaw-close", channelId));
        return;
      }
      if (byteLength(data) > this.limits.maxDataBytes) {
        this.channelError("channel_data_too_large");
        this.end(channel, "openclaw-close");
        return;
      }
      channel.fromServer(data);
      return;
    }
    // openclaw-close: the server ended the channel; no echo.
    if (channel) {
      channel.ended = true;
      this.channels.delete(channelId);
      this.onChange();
      channel.closeLocal();
    }
  }

  closeAll() {
    const channels = [...this.channels.values()];
    this.channels.clear();
    for (const channel of channels) {
      channel.ended = true;
      channel.closeLocal();
    }
    this.onChange();
  }
}

// --- L1-4 … L1-8: the gateway-side link service ----------------------------------------------------

const HANDSHAKE_FIELDS = ["handshakeId", "connectionId", "deviceId", "audience", "nonce", "expiresAt"];

// L1-4: the proof for one challenge, or "protocol" for a malformed challenge
// and "mismatch" for a challenge naming another device or audience.
function handshakeProof(value, record, seed, version) {
  if (!isObject(value) || value.type !== "authentication-challenge" || value.version !== 1
    || !HANDSHAKE_FIELDS.every((name) => typeof value[name] === "string")) return "protocol";
  // L1o-7: a challenge for another device is not answered.
  if (value.audience !== record.audience || value.deviceId !== record.deviceId) return "mismatch";
  const proof = {version: 1};
  for (const name of HANDSHAKE_FIELDS) proof[name] = value[name];
  proof.signatureBase64 = sign(seed, handshakeProofBytes(value));
  proof.pluginVersion = version;
  return proof;
}

// P11b-3: one signed L1-4 connect with the pending key, closed right after
// authentication-complete. True only when the handshake completed.
export async function probeActive(record, {connect = connectWebSocket, timeoutMs = HANDSHAKE_TIMEOUT_MS, version = ROOM_CONNECTOR_PROVENANCE.version} = {}) {
  let socket;
  try {
    const [url] = deriveUrls(record.audience, record.deviceId);
    const seed = seedOf(record);
    socket = await connect(url, {headers: {"User-Agent": linkUserAgent(version)}, maxMessageBytes: CLIENT_MAX_MESSAGE_BYTES, timeoutMs});
    return await new Promise((resolve) => {
      let phase = "challenge";
      const finish = (value) => {
        clearTimeout(timer);
        resolve(value);
        socket.close(1000);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      socket.on("close", () => finish(false));
      socket.on("message", (message, binary) => {
        let value;
        try {
          if (binary) throw new Error("binary");
          value = JSON.parse(message);
        } catch {
          finish(false);
          return;
        }
        if (phase === "challenge") {
          const proof = handshakeProof(value, record, seed, version);
          if (!isObject(proof)) {
            finish(false);
            return;
          }
          socket.send(JSON.stringify(proof));
          phase = "complete";
          return;
        }
        finish(isObject(value) && value.type === "authentication-complete" && value.version === 1);
      });
      socket.start();
    });
  } catch {
    socket?.terminate();
    return false;
  }
}

// One outbound device socket for this installation while it is linked (L1-4).
export class LinkService {
  constructor({pluginVersion = "", status = null, recordPath = linkPath(), localOpener, connect = connectWebSocket, sender = sendConfirmation,
    backoff = (attempt) => backoffDelayMs(attempt), pollMs = RECORD_POLL_MS, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    logger, clock = Date.now} = {}) {
    this.pluginVersion = pluginVersion;
    this.status = status;
    this.recordPath = recordPath;
    this.localOpener = localOpener ?? ((limits, {approvals = false} = {}) => openLocalGateway({maxDataBytes: limits.maxDataBytes, timeoutMs: limits.openTimeoutMs,
      version: pluginVersion, approvals}));
    this.connect = connect;
    this.sender = sender;
    this.backoff = backoff;
    this.pollMs = pollMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.logger = scrubbingLogger(logger);
    this.clock = clock;
    this.attempt = 0;
    this.delays = [];
    this.link = {state: "not_linked", code: "", deviceId: "", channels: 0, limits: "fallback", lastConnectedAt: null, lastChannelErrorCode: ""};
    this.reported = false;
    this.bridge = null;
    this.stopped = false;
    this.wakers = new Set();
    this.endSession = null;
  }

  // Status (L1-11): codes only. Written once the installation has a link.
  set(fields) {
    const changed = Object.entries(fields).some(([key, value]) => this.link[key] !== value);
    Object.assign(this.link, fields);
    if (!changed || !this.status) return;
    if (!this.reported && this.link.state === "not_linked") return;
    this.reported = true;
    try {
      this.status.setLink({...this.link});
    } catch {
      // Status is diagnostics only.
    }
  }

  snapshot() {
    return {...this.link};
  }

  stop() {
    this.stopped = true;
    this.endSession?.(["link_stopped", STOP]);
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, ms));
      timer.unref?.();
      this.wakers.add(wake);
    });
  }

  // {record, pending, digest}. A corrupt pending file never hides a valid
  // link.json: it reads as null with its own digest, so a change is noticed.
  current() {
    let record;
    try {
      record = readLink(this.recordPath);
    } catch {
      return {record: null, pending: null, digest: "unreadable"};
    }
    const pendingFile = pendingPath(this.recordPath);
    try {
      const pending = readLink(pendingFile);
      return {record, pending, digest: `${recordDigest(record)}:${recordDigest(pending)}`};
    } catch {
      return {record, pending: null, digest: `${recordDigest(record)}:bad:${badFileDigest(pendingFile)}`};
    }
  }

  linkDigest() {
    try {
      return recordDigest(readLink(this.recordPath));
    } catch {
      return "unreadable";
    }
  }

  async waitForChange(digest, ms) {
    let waited = 0;
    while (!this.stopped && (ms === undefined || waited < ms)) {
      const step = ms === undefined ? this.pollMs : Math.min(this.pollMs, ms - waited);
      await this.sleep(step);
      waited += step;
      if (this.current().digest !== digest) return;
    }
  }

  async waitForLinkChange(digest, ms) {
    let waited = 0;
    while (!this.stopped && (ms === undefined || waited < ms)) {
      const step = ms === undefined ? this.pollMs : Math.min(this.pollMs, ms - waited);
      await this.sleep(step);
      waited += step;
      if (this.linkDigest() !== digest) return;
    }
  }

  nextDelay() {
    const value = this.backoff(this.attempt);
    this.attempt += 1;
    this.delays.push(value);
    return value;
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.step();
      } catch (error) {
        if (this.stopped) break;
        // Never end silently; one failure never stops the gateway.
        this.logger?.warn?.(`Room link service failed (${error?.name ?? "Error"}); retrying`);
        this.set({state: "reconnecting", code: "link_service_error", channels: 0});
        await this.sleep(this.nextDelay());
      }
    }
  }

  async step() {
    const {record, pending, digest} = this.current();
    if (digest === "unreadable") {
      this.set({state: "stopped", code: "link_store_unreadable", channels: 0});
      await this.waitForChange(digest);
      return;
    }
    if (record?.state === "active") {
      // A pending re-link is confirmed by the CLI; this link serves on.
      this.set({deviceId: record.deviceId});
      await this.serveRecord(record);
      return;
    }
    if (!pending && digest.includes(":bad:")) {
      this.set({state: "stopped", code: "link_store_unreadable", channels: 0});
      await this.waitForChange(digest);
      return;
    }
    if (pending) {
      // A first link the CLI could not confirm in time: retried here until
      // its token expires.
      this.set({state: "pending", code: "link_pending", deviceId: pending.deviceId});
      const result = await confirmPending({path: this.recordPath, blocking: false, sender: this.sender, now: this.clock});
      if (result.state === "active") {
        this.attempt = 0;
        return;
      }
      if (result.state === "pending") {
        this.set({code: result.code || "link_pending"});
        await this.waitForChange(this.current().digest, this.nextDelay());
      }
      return;
    }
    if (!record) {
      this.attempt = 0;
      this.set({state: "not_linked", code: "", deviceId: "", channels: 0});
      await this.waitForChange(digest);
      return;
    }
    this.set({state: "stopped", deviceId: record.deviceId, code: record.state === "expired" ? "link_pairing_expired" : "link_pairing_refused"});
    await this.waitForChange(digest);
  }

  async serveRecord(record) {
    const digest = recordDigest(record);
    const [code, action] = await this.connectOnce(record, digest);
    if (this.stopped) return;
    if (action === STOP) {
      this.set({state: "stopped", code, channels: 0});
      this.logger?.warn?.(`Room link stopped: ${code}`);
      await this.waitForLinkChange(digest);
      this.attempt = 0;
      return;
    }
    if (code === "link_record_changed") {
      this.attempt = 0;
      return;
    }
    this.set({state: "reconnecting", code, channels: 0});
    await this.waitForLinkChange(digest, this.nextDelay());
  }

  // One device socket, from upgrade to close: [status code, action].
  async connectOnce(record, digest) {
    this.set({state: "connecting"});
    let url;
    let seed;
    try {
      [url] = deriveUrls(record.audience, record.deviceId);
      seed = seedOf(record);
    } catch {
      return ["link_store_unreadable", STOP];
    }
    let socket;
    try {
      socket = await this.connect(url, {
        headers: {"User-Agent": linkUserAgent(this.pluginVersion)},
        maxMessageBytes: CLIENT_MAX_MESSAGE_BYTES,
        timeoutMs: this.handshakeTimeoutMs,
      });
    } catch (error) {
      const status = error instanceof WebSocketRefused ? error.status : 0;
      // P11b-3: the site's bot protection refused the upgrade; reconnect.
      if (error instanceof WebSocketRefused && blockedBySiteProtection(status, error.headers, error.body)) return ["link_blocked_by_site_protection", RECONNECT];
      // A redirect is never followed.
      const refused = [400, 401, 403, 404].includes(status) || (status >= 300 && status < 400);
      return [refused ? "link_route_refused" : "link_connection_lost", RECONNECT];
    }
    if (this.stopped) {
      socket.terminate();
      return ["link_stopped", STOP];
    }
    try {
      return await this.session(socket, record, seed, digest);
    } finally {
      this.bridge?.closeAll();
      this.bridge = null;
      this.endSession = null;
      try { socket.close(1000); } catch {}
      this.set({channels: 0});
    }
  }

  session(socket, record, seed, digest) {
    return new Promise((resolve) => {
      let phase = "challenge";
      let lastInbound = this.clock();
      let settled = false;
      const timers = [];
      const done = (outcome) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearInterval(timer);
        resolve(outcome);
      };
      this.endSession = (outcome) => {
        done(outcome);
        socket.close(1000);
      };
      const protocolError = () => {
        done(["link_protocol_error", RECONNECT]);
        socket.close(1008, "protocol-error");
      };
      const handshake = setTimeout(() => {
        done(["link_handshake_timeout", RECONNECT]);
        socket.terminate();
      }, this.handshakeTimeoutMs);
      handshake.unref?.();
      timers.push(handshake);
      const serve = (limits) => {
        clearTimeout(handshake);
        const keepalive = limits.keepaliveMs;
        const ping = setInterval(() => {
          if (this.clock() - lastInbound > 2 * keepalive) {
            // A silent peer gets no close handshake: drop the socket.
            done(["link_keepalive_timeout", RECONNECT]);
            socket.terminate();
            return;
          }
          socket.ping();
        }, keepalive);
        ping.unref?.();
        timers.push(ping);
        const watch = setInterval(() => {
          if (this.linkDigest() !== digest) {
            done(["link_record_changed", RECONNECT]);
            socket.close(1000);
          }
        }, this.pollMs);
        watch.unref?.();
        timers.push(watch);
      };
      socket.on("pong", () => {
        lastInbound = this.clock();
      });
      socket.on("message", (message, binary) => {
        if (settled) return;
        lastInbound = this.clock();
        if (phase === "serving") {
          try {
            this.bridge.handle(message, binary);
          } catch (error) {
            if (error instanceof ProtocolError) {
              protocolError();
            } else {
              done(["link_connection_lost", RECONNECT]);
              socket.terminate();
            }
          }
          return;
        }
        let value;
        try {
          if (binary) throw new Error("binary");
          value = JSON.parse(message);
        } catch {
          protocolError();
          return;
        }
        if (phase === "challenge") {
          // L1-4: one proof per socket, echoing the challenge.
          const proof = handshakeProof(value, record, seed, this.pluginVersion);
          if (proof === "protocol") {
            protocolError();
            return;
          }
          if (proof === "mismatch") {
            done(["link_audience_mismatch", RECONNECT]);
            socket.close(1000);
            return;
          }
          socket.send(JSON.stringify(proof));
          phase = "complete";
          return;
        }
        if (!isObject(value) || value.type !== "authentication-complete" || value.version !== 1) {
          protocolError();
          return;
        }
        const {limits, source} = readLimits(value);
        this.attempt = 0;
        this.set({state: "connected", code: "", limits: source, lastConnectedAt: isoNow(this.clock), channels: 0});
        this.bridge = new LinkBridge(socket, limits, this.localOpener, {
          onChange: () => this.set({channels: this.bridge ? this.bridge.channels.size : 0}),
          onChannelError: (code) => this.set({lastChannelErrorCode: code}),
          openFailedReason: readOpenFailedReason(value),
          linkFeatures: readLinkFeatures(value),
        });
        phase = "serving";
        serve(limits);
      });
      socket.on("close", (code, reason) => done(closeOutcome(code, reason)));
      socket.start();
    });
  }
}

// A change marker for an unreadable file: bounded, no symlink followed.
function badFileDigest(path) {
  const hash = createHash("sha256");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return hash.update(`irregular:${stat.mode & 0o170000}`).digest("hex");
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      readSync(fd, buffer, 0, buffer.length, 0);
      return hash.update(`${stat.size}:`).update(buffer).digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return hash.update(`unreadable:${error?.code ?? "error"}`).digest("hex");
  }
}

// --- L1o-3: one service per gateway process -------------------------------------------------------

let activeService = null;

// Start the link service of this gateway once; never throws.
export function startRoomLink({pluginVersion, status, config, logger, env = process.env} = {}) {
  if (activeService) return activeService;
  try {
    const service = new LinkService({
      pluginVersion,
      status,
      logger,
      localOpener: (limits, {approvals = false} = {}) => openLocalGateway({cfg: typeof config === "function" ? config() : config, env,
        maxDataBytes: limits.maxDataBytes, timeoutMs: limits.openTimeoutMs, version: pluginVersion, approvals}),
    });
    activeService = service;
    service.run().catch(() => {}).finally(() => {
      if (activeService === service) activeService = null;
    });
    return service;
  } catch {
    logger?.warn?.("Room link could not start: link_service_error");
    return null;
  }
}

export function stopRoomLink() {
  const service = activeService;
  activeService = null;
  service?.stop();
}
