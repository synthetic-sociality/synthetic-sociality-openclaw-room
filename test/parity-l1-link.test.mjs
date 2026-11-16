// Contract L1 and L1o (OpenClaw 0.2.84): the OpenClaw device link. The L1
// case names are shared with Hermes; where they name a Hermes frame or the
// Hermes dashboard, OpenClaw reads them through the L1o translations (the
// openclaw-* frames, the gateway's own loopback connect). Everything runs on
// loopback: a fake Harness device ingress and a fake OpenClaw gateway.
import assert from "node:assert/strict";
import test from "node:test";
import {createHash, createPublicKey, randomUUID, verify} from "node:crypto";
import {lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import {
  ADMITTED_METHODS, FALLBACK_LIMITS, LINK_PENDING_FILE, LinkService, METHOD_REFUSAL_MESSAGE, allowLoopbackPlainForTests,
  backoffDelayMs, closeOutcome, confirmPending, deleteLink, deriveUrls, fingerprint, handshakeProofBytes, openLocalGateway,
  pairingProofBytes, parseToken, pendingPath, pendingRecord, projectRequest, publicSpkiBase64, readLimits, readLink, sign,
  startRoomLink, stopRoomLink, writeLink,
} from "../src/link.js";
import {runLinkCli} from "../src/link-cli.js";
import {LocalStatus} from "../src/local-status.js";
import {REDACTED, forgetSecrets, scrub, toolCallBlock} from "../src/secret-isolation.js";
import {fakeGateway, fakeHarness, makeToken, redirectTarget, waitFor} from "./support/fake-link.mjs";

allowLoopbackPlainForTests(true);

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GATEWAY_TOKEN = "gateway-token-0123456789abcdef";

async function scratch(name) {
  const root = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const store = join(root, "state", "synthetic-sociality-room");
  return {root, store, recordPath: join(store, "link.json"), statusPath: join(store, "status.json"), cleanup: () => rm(root, {recursive: true, force: true})};
}

// A first link made through the real confirmation against the fake Harness.
async function linked(harness, recordPath, options = {}) {
  const token = parseToken(makeToken({audience: harness.audience, ...options}));
  writeLink(pendingRecord(token, {label: "Mac test · OpenClaw default"}), pendingPath(recordPath));
  const result = await confirmPending({path: recordPath});
  assert.equal(result.state, "active");
  return readLink(recordPath);
}

function service(paths, gateway, overrides = {}) {
  const status = new LocalStatus(paths.statusPath, {version: "0.2.84", hostLabel: "test"});
  const logs = [];
  const logger = {info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line)};
  const instance = new LinkService({
    pluginVersion: "0.2.84",
    status,
    recordPath: paths.recordPath,
    localOpener: (limits) => openLocalGateway({cfg: gateway.config(), env: {}, maxDataBytes: limits.maxDataBytes, timeoutMs: limits.openTimeoutMs, version: "0.2.84"}),
    backoff: () => 30,
    pollMs: 25,
    logger,
    ...overrides,
  });
  const running = instance.run();
  return {instance, status, logs, stop: async () => { instance.stop(); await running; }};
}

function ttyInput(text) {
  const input = new PassThrough();
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (value) => input.raw.push(value);
  input.end(text);
  return input;
}

function sink() {
  const stream = new PassThrough();
  stream.text = "";
  stream.on("data", (chunk) => { stream.text += chunk; });
  return stream;
}

async function opened(device, channelId = device.open()) {
  await device.waitFrame((frame) => frame.channelId === channelId && ["openclaw-opened", "openclaw-open-failed"].includes(frame.type));
  return channelId;
}

test("L1-01 a link token is read at a hidden prompt and accepted only as v1 with every field, an https audience and an unexpired expiry", async () => {
  const audience = "https://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/connect";
  const now = Date.parse("2026-11-16T10:00:00Z");
  const good = parseToken(makeToken({audience, deviceId: "0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c", expiresAt: "2026-11-16T10:10:00.000Z", extra: {unknown: 1}}), {now});
  assert.deepEqual(Object.keys(good), ["audience", "deviceId", "pairingSecret", "expiresAt"]);
  const refused = (token, code) => assert.throws(() => parseToken(token, {now}), (error) => error.code === code, code);
  refused(makeToken({audience, v: 2}), "link_token_unsupported");
  refused(makeToken({audience, deviceId: "not-a-uuid"}), "link_token_invalid");
  refused(makeToken({audience, pairingSecret: "short"}), "link_token_invalid");
  refused(makeToken({audience, expiresAt: "tomorrow"}), "link_token_invalid");
  refused(makeToken({audience, prefix: "twh1."}), "link_token_invalid");
  refused(makeToken({audience: "https://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/connect?x=1"}), "link_token_invalid");
  refused(makeToken({audience: "https://rooms.tokenwerk.eu/tokenwerk/room/v1/other"}), "link_token_invalid");
  refused(makeToken({audience: "http://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/connect"}), "link_token_invalid");
  refused(`twoc1.${"A".repeat(5000)}`, "link_token_invalid");
  // Expired more than 60 s ago is refused; within the skew it is accepted.
  refused(makeToken({audience, expiresAt: "2026-11-16T09:58:59.000Z"}), "link_pairing_expired");
  assert.ok(parseToken(makeToken({audience, expiresAt: "2026-11-16T09:59:30.000Z"}), {now}));
  // Plain http only to a literal loopback address, and only in a test build.
  allowLoopbackPlainForTests(false);
  try {
    refused(makeToken({audience: "http://127.0.0.1:9/tokenwerk/room/v1/local-devices/connect"}), "link_token_invalid");
  } finally {
    allowLoopbackPlainForTests(true);
  }
  assert.deepEqual(deriveUrls(audience, good.deviceId), [
    `wss://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/connect?deviceId=${good.deviceId}`,
    "https://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/pairing-confirmations",
  ]);
  // The CLI reads it at a hidden prompt (echo off) and never from argv.
  const paths = await scratch("l1-01");
  const harness = await fakeHarness();
  try {
    const token = makeToken({audience: harness.audience});
    const output = sink();
    const errors = sink();
    const input = ttyInput(`${token}\ry\n`);
    assert.equal(await runLinkCli(["link"], {input, output, errors, path: paths.recordPath, label: "Mac test · OpenClaw default"}), 0);
    assert.deepEqual(input.raw, [true, false]);
    assert.ok(!output.text.includes(token) && !errors.text.includes(token));
    const argvErrors = sink();
    assert.equal(await runLinkCli([token], {input: ttyInput(""), output: sink(), errors: argvErrors, path: paths.recordPath}), 2);
    assert.match(argvErrors.text, /never put the link token on the command line/);
    assert.ok(!argvErrors.text.includes(token));
  } finally {
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-02 the pairing confirmation is sent to the derived URL with the signed body and only 201 links", async () => {
  const paths = await scratch("l1-02");
  let status = 200;
  // P11b-3: a 404 links only when a signed connect with the pending key completes; this ingress verifies proofs.
  const harness = await fakeHarness({confirmation: () => (status === 201 ? null : {status, body: {}}), verifyProofs: true});
  try {
    const token = parseToken(makeToken({audience: harness.audience}));
    writeLink(pendingRecord(token, {label: "Mac test · OpenClaw default"}), pendingPath(paths.recordPath));
    // 200 is not 201: still pending, retried.
    assert.deepEqual(await confirmPending({path: paths.recordPath}), {state: "pending", code: "link_pairing_unavailable"});
    assert.equal(readLink(paths.recordPath), null);
    status = 201;
    assert.deepEqual(await confirmPending({path: paths.recordPath}), {state: "active", code: ""});
    const record = readLink(paths.recordPath);
    assert.equal(record.state, "active");
    assert.ok(!("pairingSecret" in record));
    const sent = harness.confirmations.at(-1);
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/tokenwerk/room/v1/local-devices/pairing-confirmations");
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers.authorization, undefined);
    assert.ok(Buffer.byteLength(sent.raw) <= 4096);
    assert.deepEqual(Object.keys(sent.body), ["version", "deviceId", "pairingSecret", "deviceLabel", "publicKeySpkiBase64", "signatureBase64"]);
    assert.equal(sent.raw.split('"deviceId"').length - 1, 1);
    const key = createPublicKey({key: Buffer.from(sent.body.publicKeySpkiBase64, "base64"), format: "der", type: "spki"});
    assert.ok(verify(null, pairingProofBytes(sent.body.deviceId, sent.body.pairingSecret, sent.body.deviceLabel, sent.body.publicKeySpkiBase64),
      key, Buffer.from(sent.body.signatureBase64, "base64")));
    // 404: the token is spent (the signed connect with the pending key is
    // refused too); the pending record is retired, never retried.
    status = 404;
    const second = await scratch("l1-02b");
    try {
      writeLink(pendingRecord(parseToken(makeToken({audience: harness.audience}))), pendingPath(second.recordPath));
      assert.deepEqual(await confirmPending({path: second.recordPath}), {state: "refused", code: "link_pairing_refused"});
      assert.equal(readLink(second.recordPath).state, "refused");
      assert.equal(readLink(pendingPath(second.recordPath)), null);
    } finally {
      await second.cleanup();
    }
  } finally {
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-03 the signature inputs equal JavaScript JSON.stringify bytes for the shared vector", () => {
  const vector = conformance.parityL1SignatureVector;
  const seed = Buffer.from(vector.seedHex, "hex");
  assert.equal(publicSpkiBase64(seed), vector.publicKeySpkiBase64);
  assert.equal(fingerprint(seed), vector.fingerprintSha256);
  const p = vector.pairing;
  const pairing = pairingProofBytes(p.deviceId, p.pairingSecret, p.deviceLabel, p.publicKeySpkiBase64);
  const handshake = handshakeProofBytes(vector.handshake);
  assert.equal(sha256(pairing), vector.pairingInputSha256);
  assert.equal(sha256(handshake), vector.handshakeInputSha256);
  assert.equal(sign(seed, pairing), vector.pairingSignatureBase64);
  assert.equal(sign(seed, handshake), vector.handshakeSignatureBase64);
  assert.ok(pairing.includes(Buffer.from("Mac128 · Hermes claude </&>", "utf8")));
  // The seed is the PKCS#8 Ed25519 key the shared vector names.
  assert.equal(Buffer.concat([PKCS8_ED25519_PREFIX, seed]).length, 48);
});

test("L1-04 the connect handshake echoes the challenge in one signed proof and refuses a foreign audience", async () => {
  const paths = await scratch("l1-04");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  const running = [];
  try {
    const record = await linked(harness, paths.recordPath);
    const link = service(paths, gateway);
    running.push(link);
    const device = await harness.waitDevice();
    assert.equal(device.deviceId, record.deviceId);
    assert.equal(device.proofs.length, 1);
    const proof = device.proofs[0];
    assert.deepEqual(Object.keys(proof), ["version", "handshakeId", "connectionId", "deviceId", "audience", "nonce", "expiresAt", "signatureBase64", "pluginVersion"]);
    for (const name of ["handshakeId", "connectionId", "deviceId", "audience", "nonce", "expiresAt"]) assert.equal(proof[name], device.challenge[name]);
    assert.equal(proof.pluginVersion, "0.2.84");
    assert.ok(device.proofVerified);
    // P11b-3: the link's own User-Agent on the device socket.
    assert.equal(harness.upgrades[0].headers["user-agent"], "openclaw-room-link/0.2.84");
    await waitFor(() => link.instance.snapshot().state === "connected", {label: "connected"});
    await link.stop();
    // A challenge for another audience, or another device, is not answered.
    for (const foreign of [{audience: "https://other.example/tokenwerk/room/v1/local-devices/connect"}, {deviceId: randomUUID()}]) {
      const other = await fakeHarness({challenge: (fields) => ({...fields, ...foreign})});
      const otherPaths = await scratch("l1-04b");
      try {
        await linked(other, otherPaths.recordPath);
        const refusing = service(otherPaths, gateway);
        running.push(refusing);
        await waitFor(() => refusing.instance.snapshot().code === "link_audience_mismatch", {label: "audience mismatch"});
        const tried = other.devices[0];
        assert.equal(tried.proofs.length, 0);
        await waitFor(() => tried.closed, {label: "closed"});
        await refusing.stop();
      } finally {
        await other.close();
        await otherPaths.cleanup();
      }
    }
  } finally {
    for (const link of running) await link.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-05 limits are read from authentication-complete and fall back per value when absent", async () => {
  assert.deepEqual(readLimits({}), {limits: {...FALLBACK_LIMITS}, source: "fallback"});
  assert.deepEqual(readLimits({limits: {maxDataBytes: "1", maxChannels: 99, keepaliveMs: 1.5}}), {limits: {...FALLBACK_LIMITS}, source: "fallback"});
  // The OpenClaw relay advertises three values (openclaw-link.ts limits).
  assert.deepEqual(readLimits({limits: {maxDataBytes: 2048, openTimeoutMs: 5000, maxChannels: 3}}), {
    limits: {...FALLBACK_LIMITS, maxDataBytes: 2048, openTimeoutMs: 5000, maxChannels: 3}, source: "advertised",
  });
  const paths = await scratch("l1-05");
  const harness = await fakeHarness({limits: null});
  const gateway = await fakeGateway();
  let link;
  try {
    await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    await waitFor(() => link.instance.snapshot().state === "connected", {label: "connected"});
    assert.equal(link.instance.snapshot().limits, "fallback");
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-06 hermes-opened is sent when the local Gateway opens and frames pass verbatim both ways until close", async () => {
  // OpenClaw (L1o-4, L1o-6): openclaw-opened after the gateway's hello-ok;
  // admitted requests and their responses and chat events pass, projected.
  const paths = await scratch("l1-06");
  const harness = await fakeHarness();
  const gateway = await fakeGateway({respond: (frame, connection) => {
    connection.send({type: "event", event: "chat", payload: {runId: "r1", sessionKey: frame.params.sessionKey, seq: 0, state: "delta", deltaText: "Hi ✓"}, seq: 7});
    connection.send({type: "event", event: "agent", payload: {secretTool: true}});
    return {type: "res", id: frame.id, ok: true, payload: {messages: [{text: "ü </&>"}]}, extra: "dropped"};
  }});
  let link;
  try {
    await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    const channelId = await opened(device);
    assert.deepEqual(device.channelFrames(channelId)[0], {version: 1, type: "openclaw-opened", channelId});
    device.request(channelId, {type: "req", id: "h1", method: "chat.history", params: {sessionKey: "agent:main:main", limit: 5000, maxChars: 9, extra: true}});
    const response = await device.waitFrame((frame) => frame.type === "openclaw-frame" && JSON.parse(frame.data).type === "res");
    assert.deepEqual(Object.keys(response), ["version", "type", "channelId", "data"]);
    assert.deepEqual(JSON.parse(response.data), {type: "res", id: "h1", ok: true, payload: {messages: [{text: "ü </&>"}]}});
    const forwarded = gateway.connections[0].requests[0];
    assert.deepEqual(forwarded, {type: "req", id: "h1", method: "chat.history", params: {sessionKey: "agent:main:main", limit: 200}});
    const data = device.channelFrames(channelId).filter((frame) => frame.type === "openclaw-frame").map((frame) => JSON.parse(frame.data));
    // In order: the chat event first, then the response; tick, presence and agent dropped.
    assert.deepEqual(data.map((item) => item.type === "event" ? item.event : item.type), ["chat", "res"]);
    assert.deepEqual(data[0], {type: "event", event: "chat", payload: {runId: "r1", sessionKey: "agent:main:main", seq: 0, state: "delta", deltaText: "Hi ✓"}, seq: 7});
    // The connect exchange never reaches the server.
    assert.ok(!device.frames.some((frame) => String(frame.data ?? "").includes("hello-ok") || String(frame.data ?? "").includes(GATEWAY_TOKEN)));
    // The server closes the channel: the gateway connection closes, no echo.
    const before = device.frames.length;
    device.send({version: 1, type: "openclaw-close", channelId});
    await waitFor(() => gateway.connections[0].closed, {label: "gateway closed"});
    assert.equal(device.frames.slice(before).filter((frame) => frame.type === "openclaw-close").length, 0);
    // When the device socket closes, every gateway connection of it closes.
    const second = await opened(device);
    const third = await opened(device);
    assert.ok(second && third);
    device.ws.close(1001, "going away");
    await waitFor(() => gateway.connections.slice(1).every((connection) => connection.closed), {label: "all gateway connections closed"});
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-07 an oversize frame or a channel above the cap ends only that channel", async () => {
  const paths = await scratch("l1-07");
  const harness = await fakeHarness({limits: {maxDataBytes: 2048, openTimeoutMs: 2000, maxChannels: 2}});
  const gateway = await fakeGateway({respond: (frame) => frame.params.sessionKey === "big"
    ? {type: "res", id: frame.id, ok: true, payload: {text: "x".repeat(4096)}}
    : {type: "res", id: frame.id, ok: true, payload: {ok: 1}}});
  let link;
  try {
    await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    const first = await opened(device);
    const second = await opened(device);
    // Above the cap: refused with openclaw-open-failed, the others stay.
    const third = device.open();
    await device.waitFrame((frame) => frame.channelId === third && frame.type === "openclaw-open-failed");
    assert.equal(link.instance.snapshot().lastChannelErrorCode, "channel_cap");
    // A server data above maxDataBytes ends only that channel.
    device.request(first, {type: "req", id: "s1", method: "chat.send", params: {sessionKey: "a", message: "y".repeat(3000), idempotencyKey: "k1"}});
    await device.waitFrame((frame) => frame.channelId === first && frame.type === "openclaw-close");
    assert.equal(link.instance.snapshot().lastChannelErrorCode, "channel_data_too_large");
    // A gateway message above maxDataBytes ends only its channel too.
    device.request(second, {type: "req", id: "b1", method: "chat.history", params: {sessionKey: "big"}});
    await device.waitFrame((frame) => frame.channelId === second && frame.type === "openclaw-close");
    // The socket and a new channel still work: no crash, a clean refusal.
    const fourth = await opened(device);
    device.request(fourth, {type: "req", id: "ok1", method: "sessions.list", params: {}});
    const answer = await device.waitFrame((frame) => frame.channelId === fourth && frame.type === "openclaw-frame");
    assert.deepEqual(JSON.parse(answer.data), {type: "res", id: "ok1", ok: true, payload: {ok: 1}});
    assert.equal(device.closed, null);
    assert.equal(link.instance.snapshot().state, "connected");
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-08 an unknown channel ends that channel and an unknown type or version closes the socket", async () => {
  const paths = await scratch("l1-08");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    let device = await harness.waitDevice();
    const unknown = randomUUID();
    device.request(unknown, {type: "req", id: "u1", method: "sessions.list"});
    await device.waitFrame((frame) => frame.channelId === unknown && frame.type === "openclaw-close");
    assert.equal(link.instance.snapshot().lastChannelErrorCode, "channel_unknown");
    assert.equal(device.closed, null);
    for (const [index, bad] of [{version: 1, type: "hermes-open", channelId: randomUUID()}, {version: 2, type: "openclaw-open", channelId: randomUUID()}, "not json"].entries()) {
      device.send(bad);
      await waitFor(() => device.closed, {label: "socket closed"});
      assert.deepEqual(device.closed, {code: 1008, reason: "protocol-error"});
      // It reconnects (link_protocol_error is not a stop).
      device = await harness.waitDevice(index + 2);
    }
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-09 revoked and replaced stop the link and keep the key while a pending link retries until the token expires", async () => {
  const gateway = await fakeGateway();
  try {
    for (const [reason, code] of [["revoked", "link_revoked"], ["authentication-failed", "link_revoked"], ["replaced", "link_replaced"]]) {
      const paths = await scratch("l1-09");
      const harness = await fakeHarness();
      let link;
      try {
        const record = await linked(harness, paths.recordPath);
        link = service(paths, gateway);
        const device = await harness.waitDevice();
        device.ws.close(1008, reason);
        await waitFor(() => link.instance.snapshot().state === "stopped", {label: "stopped"});
        assert.equal(link.instance.snapshot().code, code);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(harness.upgrades.length, 1, "a stopped link does not reconnect");
        assert.equal(readLink(paths.recordPath).privateKeyBase64, record.privateKeyBase64);
      } finally {
        await link?.stop();
        await harness.close();
        await paths.cleanup();
      }
    }
    // A pending first link is retried by the gateway until its token expires.
    const paths = await scratch("l1-09p");
    const harness = await fakeHarness({confirmation: () => ({status: 503, body: {}})});
    let link;
    try {
      const expiresAt = new Date(Date.now() + 600).toISOString();
      writeLink(pendingRecord(parseToken(makeToken({audience: harness.audience, expiresAt}))), pendingPath(paths.recordPath));
      link = service(paths, gateway);
      await waitFor(() => harness.confirmations.length >= 2, {label: "retries"});
      assert.equal(link.instance.snapshot().state, "pending");
      await waitFor(() => link.instance.snapshot().code === "link_pairing_expired", {label: "expired"});
      assert.equal(link.instance.snapshot().state, "stopped");
      assert.equal(readLink(paths.recordPath).state, "expired");
      assert.equal(readLink(pendingPath(paths.recordPath)), null);
    } finally {
      await link?.stop();
      await harness.close();
      await paths.cleanup();
    }
  } finally {
    await gateway.close();
  }
});

test("L1-10 reconnects use bounded backoff with jitter and the device sends its own keepalive", async () => {
  const {reconnectDelayMs} = await import("../src/runtime.js");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const random of [0, 0.5, 0.999]) {
      const value = backoffDelayMs(attempt, () => random);
      assert.equal(value, reconnectDelayMs(attempt, {random: () => random}));
      const ceiling = Math.min(15_000, 1000 * 2 ** attempt);
      assert.ok(value >= 0.8 * ceiling && value <= ceiling);
    }
  }
  assert.equal(backoffDelayMs(0, () => 1), 1000);
  assert.equal(backoffDelayMs(20, () => 1), 15_000);
  // Lost connections back off on that schedule, attempt by attempt.
  const paths = await scratch("l1-10");
  const harness = await fakeHarness({limits: {maxDataBytes: 4096, openTimeoutMs: 2000, maxChannels: 2, keepaliveMs: 1000}});
  const gateway = await fakeGateway();
  const attempts = [];
  let link;
  try {
    await linked(harness, paths.recordPath);
    harness.connectStatus = 503;
    link = service(paths, gateway, {backoff: (attempt) => { attempts.push(attempt); return 20; }});
    await waitFor(() => attempts.length >= 3, {label: "backoff"});
    assert.deepEqual(attempts.slice(0, 3), [0, 1, 2]);
    assert.equal(link.instance.snapshot().code, "link_connection_lost");
    // Connected: the device pings every keepaliveMs on its own.
    harness.connectStatus = 0;
    const device = await harness.waitDevice();
    await waitFor(() => device.pings >= 1, {timeoutMs: 3000, label: "ping"});
    assert.equal(link.instance.attempt, 0, "a connection resets the backoff");
  } finally {
    await link?.stop();
    await harness.close();
    await paths.cleanup();
  }
  // A silent server (no pong, no message) is dropped after twice keepaliveMs.
  const silentPaths = await scratch("l1-10s");
  const silent = await fakeHarness({limits: {maxDataBytes: 4096, openTimeoutMs: 2000, maxChannels: 2, keepaliveMs: 1000}, autoPong: false});
  let quiet;
  try {
    await linked(silent, silentPaths.recordPath);
    const codes = [];
    quiet = service(silentPaths, gateway, {status: {setLink: (value) => codes.push(value.code)}});
    await waitFor(() => codes.includes("link_keepalive_timeout"), {timeoutMs: 6000, label: "keepalive timeout"});
  } finally {
    await quiet?.stop();
    await silent.close();
    await silentPaths.cleanup();
    await gateway.close();
  }
});

test("L1-11 unlink deletes the local key and record and leaves the server revoke to the Harness", async () => {
  const paths = await scratch("l1-11");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    const record = await linked(harness, paths.recordPath);
    writeLink(pendingRecord(parseToken(makeToken({audience: harness.audience}))), pendingPath(paths.recordPath));
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    const confirmations = harness.confirmations.length;
    const output = sink();
    assert.equal(await runLinkCli(["unlink"], {input: ttyInput(""), output, errors: sink(), path: paths.recordPath}), 0);
    assert.match(output.text, new RegExp(`device ${record.deviceId}`));
    assert.match(output.text, /until you revoke it on your OpenClaw card \(Settings > Plugins > OpenClaw > Link\)/);
    assert.equal(readLink(paths.recordPath), null);
    assert.deepEqual((await readdir(paths.store)).filter((name) => name.startsWith("link")), []);
    // No request reached the server for the unlink; the socket ends.
    assert.equal(harness.confirmations.length, confirmations);
    await waitFor(() => device.closed, {label: "socket closed"});
    await waitFor(() => link.instance.snapshot().state === "not_linked", {label: "not linked"});
    assert.equal(deleteLink(paths.recordPath), null);
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-12 the link key, pairing secret and local Gateway credential are not readable through agent tools and never appear in prompt, tool result, log or status", async () => {
  const paths = await scratch("l1-12");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    const token = makeToken({audience: harness.audience});
    const pairingSecret = parseToken(token).pairingSecret;
    const output = sink();
    const errors = sink();
    assert.equal(await runLinkCli(["link"], {input: ttyInput(`${token}\ry\n`), output, errors, path: paths.recordPath, label: "Mac test · OpenClaw default"}), 0);
    const record = readLink(paths.recordPath);
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    await opened(device);
    // The store is fenced: a file tool and a shell call on it are blocked.
    for (const [tool, params] of [["read", {path: paths.recordPath}], ["exec", {command: `cat ${paths.recordPath}`}], ["read", {path: pendingPath(paths.recordPath)}]]) {
      assert.ok(toolCallBlock(tool, params, [paths.store], {cwd: paths.root}), tool);
    }
    // Remembered for scrubbing: key, pairing secret and gateway token.
    for (const secret of [record.privateKeyBase64, pairingSecret, GATEWAY_TOKEN]) assert.equal(scrub(`x ${secret} y`), `x ${REDACTED} y`);
    // Never in the CLI output, the status file, a log line or a server frame.
    const statusText = await readFile(paths.statusPath, "utf8");
    const logText = link.logs.join("\n");
    const frames = JSON.stringify(device.frames);
    for (const secret of [record.privateKeyBase64, pairingSecret, GATEWAY_TOKEN, token]) {
      for (const [where, text] of [["stdout", output.text], ["stderr", errors.text], ["status", statusText], ["log", logText], ["frames", frames]]) {
        assert.ok(!text.includes(secret), `${where} holds a secret`);
      }
    }
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
    forgetSecrets();
  }
});

test("L1-13 link status is written to the status file as codes only, following the fixed close table", async () => {
  assert.deepEqual(closeOutcome(1008, "revoked"), ["link_revoked", "stop"]);
  assert.deepEqual(closeOutcome(1008, "authentication-failed"), ["link_revoked", "stop"]);
  assert.deepEqual(closeOutcome(1008, "replaced"), ["link_replaced", "stop"]);
  assert.deepEqual(closeOutcome(1008, "protocol-error"), ["link_protocol_error", "reconnect"]);
  assert.deepEqual(closeOutcome(1008, "anything"), ["link_protocol_error", "reconnect"]);
  assert.deepEqual(closeOutcome(1009, ""), ["link_frame_too_large", "reconnect"]);
  assert.deepEqual(closeOutcome(1006, ""), ["link_connection_lost", "reconnect"]);
  assert.deepEqual(closeOutcome(4000, "revoked"), ["link_connection_lost", "reconnect"]);
  const paths = await scratch("l1-13");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    const record = await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    await opened(device);
    await waitFor(async () => JSON.parse(await readFile(paths.statusPath, "utf8")).link?.channels === 1, {label: "status channels"});
    const status = JSON.parse(await readFile(paths.statusPath, "utf8")).link;
    assert.deepEqual(Object.keys(status), ["state", "code", "deviceId", "channels", "limits", "lastConnectedAt", "lastChannelErrorCode", "updatedAt"]);
    assert.deepEqual([status.state, status.code, status.deviceId, status.limits, status.lastChannelErrorCode], ["connected", "", record.deviceId, "advertised", ""]);
    assert.equal((await lstat(paths.statusPath)).mode & 0o777, 0o600);
    device.ws.close(1008, "revoked");
    await waitFor(async () => JSON.parse(await readFile(paths.statusPath, "utf8")).link?.code === "link_revoked", {label: "revoked status"});
    const stopped = JSON.parse(await readFile(paths.statusPath, "utf8")).link;
    assert.deepEqual([stopped.state, stopped.channels], ["stopped", 0]);
    // A value that is not a code is written as a code.
    const direct = new LocalStatus(join(paths.root, "direct", "status.json"), {version: "0.2.84"});
    direct.setLink({state: "connected", code: "Room said: a free text", deviceId: "not-an-id", channels: -1, limits: "x", lastChannelErrorCode: "x".repeat(80)});
    assert.deepEqual(direct.snapshot().link, {...direct.snapshot().link, state: "connected", code: "unknown_error", deviceId: "", channels: 0, limits: "fallback", lastChannelErrorCode: "unknown_error"});
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-14 the local Gateway is reached with the loopback dashboard's session token and a gated dashboard fails the open with a code", async () => {
  // OpenClaw (L1o-5): the gateway's own loopback WebSocket and shared token.
  const gateway = await fakeGateway();
  try {
    const {socket} = await openLocalGateway({cfg: gateway.config(), env: {}, version: "0.2.84"});
    socket.close(1000);
    const connect = gateway.connections[0].connect;
    assert.equal(gateway.upgrades[0].headers.host, `127.0.0.1:${gateway.port}`);
    assert.equal(gateway.upgrades[0].headers.origin, undefined);
    assert.deepEqual(connect.params, {
      minProtocol: 4, maxProtocol: 4,
      client: {id: "gateway-client", displayName: "Tokenwerk link", version: "0.2.84", platform: process.platform, mode: "backend"},
      role: "operator", scopes: ["operator.read", "operator.write"], caps: [], auth: {token: GATEWAY_TOKEN},
      userAgent: "synthetic-sociality-room-openclaw/0.2.84",
    });
    // The token from the environment when the configuration names none.
    const fromEnv = await openLocalGateway({cfg: {gateway: {port: gateway.port, auth: {mode: "token"}}}, env: {OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN}});
    fromEnv.socket.close(1000);
    const code = async (cfg, env = {}) => {
      try {
        const opened = await openLocalGateway({cfg, env, timeoutMs: 2000});
        opened.socket.close(1000);
        return "opened";
      } catch (error) {
        return error.code;
      }
    };
    const port = gateway.port;
    assert.equal(await code({gateway: {port, bind: "tailnet", auth: {mode: "token", token: GATEWAY_TOKEN}}}), "local_gateway_auth_unavailable");
    assert.equal(await code({gateway: {port, bind: "custom", customBindHost: "192.168.1.5", auth: {mode: "token", token: GATEWAY_TOKEN}}}), "local_gateway_auth_unavailable");
    assert.equal(await code({gateway: {port, auth: {mode: "token"}}}), "local_gateway_auth_unavailable");
    assert.equal(await code({gateway: {port, auth: {mode: "token", token: {source: "env", id: "X"}}}}), "local_gateway_auth_unavailable");
    assert.equal(await code({gateway: {port, auth: {mode: "trusted-proxy"}}}), "local_gateway_auth_unavailable");
    assert.equal(await code({gateway: {port, auth: {mode: "token", token: "wrong-token-0123456789"}}}), "local_gateway_refused");
    assert.equal(await code({gateway: {port: 1, auth: {mode: "token", token: GATEWAY_TOKEN}}}), "local_gateway_unavailable");
    // Through the link: such a channel fails its open with that code.
    const paths = await scratch("l1-14");
    const harness = await fakeHarness();
    let link;
    try {
      await linked(harness, paths.recordPath);
      link = service(paths, {config: () => ({gateway: {port, bind: "tailnet", auth: {mode: "token", token: GATEWAY_TOKEN}}})});
      const device = await harness.waitDevice();
      const channelId = device.open();
      await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-open-failed");
      assert.equal(link.instance.snapshot().lastChannelErrorCode, "local_gateway_auth_unavailable");
    } finally {
      await link?.stop();
      await harness.close();
      await paths.cleanup();
    }
  } finally {
    await gateway.close();
  }
});

test("L1-20 a failed re-link leaves the working link and its key unchanged", async () => {
  const paths = await scratch("l1-20");
  let status = 201;
  // P11b-3: the 404 re-link's signed connect is refused by an ingress that verifies proofs.
  const harness = await fakeHarness({confirmation: () => (status === 201 ? null : {status, body: {}}), verifyProofs: true});
  try {
    await linked(harness, paths.recordPath);
    const before = await readFile(paths.recordPath, "utf8");
    for (const [answer, expected] of [[404, /Your working link is unchanged/], [503, /Your working link is unchanged/]]) {
      status = answer;
      const output = sink();
      const token = makeToken({audience: harness.audience});
      assert.equal(await runLinkCli(["link"], {input: ttyInput(`${token}\ry\n`), output, errors: sink(), path: paths.recordPath, label: "Mac test · OpenClaw default"}), 1);
      assert.match(output.text, expected);
      assert.equal(await readFile(paths.recordPath, "utf8"), before);
      assert.equal(readLink(pendingPath(paths.recordPath)), null);
    }
    // Declined at the confirmation question: nothing is written.
    const output = sink();
    assert.equal(await runLinkCli(["link"], {input: ttyInput(`${makeToken({audience: harness.audience})}\rn\n`), output, errors: sink(), path: paths.recordPath}), 1);
    assert.match(output.text, /Nothing was written/);
    assert.equal(await readFile(paths.recordPath, "utf8"), before);
    // A confirmed re-link replaces it and says to revoke the old device.
    status = 201;
    const old = readLink(paths.recordPath);
    const replaced = sink();
    assert.equal(await runLinkCli(["link"], {input: ttyInput(`${makeToken({audience: harness.audience})}\ry\n`), output: replaced, errors: sink(), path: paths.recordPath}), 0);
    assert.notEqual(readLink(paths.recordPath).privateKeyBase64, old.privateKeyBase64);
    assert.match(replaced.text, new RegExp(`Revoke the old device ${old.deviceId}`));
  } finally {
    await harness.close();
    await paths.cleanup();
  }
});

test("L1-21 the pairing confirmation, the device socket and both local Gateway requests never follow a redirect", async () => {
  const target = await redirectTarget();
  const paths = await scratch("l1-21");
  const harness = await fakeHarness({confirmation: () => ({status: 302, headers: {location: target.url}})});
  const gateway = await fakeGateway({upgradeStatus: 302, upgradeHeaders: {location: target.url}});
  let link;
  try {
    writeLink(pendingRecord(parseToken(makeToken({audience: harness.audience}))), pendingPath(paths.recordPath));
    assert.deepEqual(await confirmPending({path: paths.recordPath}), {state: "pending", code: "link_route_refused"});
    // The device socket: an upgrade answered 302 is refused.
    const linkedHarness = await fakeHarness();
    try {
      const linkedPaths = await scratch("l1-21b");
      try {
        await linked(linkedHarness, linkedPaths.recordPath);
        linkedHarness.connectStatus = 302;
        linkedHarness.connectHeaders = {location: target.url};
        link = service(linkedPaths, gateway);
        await waitFor(() => link.instance.snapshot().code === "link_route_refused", {label: "route refused"});
        await link.stop();
      } finally {
        await linkedPaths.cleanup();
      }
    } finally {
      await linkedHarness.close();
    }
    // The local Gateway connection: an upgrade answered 302 is refused.
    await assert.rejects(openLocalGateway({cfg: gateway.config(), env: {}}), (error) => error.code === "local_gateway_refused");
    assert.equal(target.hits, 0);
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await target.close();
    await paths.cleanup();
  }
});

test("L1o per person: a link serves only the person who linked it, and one channel's replies never reach another", async () => {
  // Two installations (two people) on one machine, each with its own state
  // directory, link and gateway; one Harness.
  const harness = await fakeHarness();
  const gatewayA = await fakeGateway({token: "gateway-token-person-a-0123456789"});
  const gatewayB = await fakeGateway({token: "gateway-token-person-b-0123456789"});
  const pathsA = await scratch("person-a");
  const pathsB = await scratch("person-b");
  let linkA;
  let linkB;
  try {
    const recordA = await linked(harness, pathsA.recordPath);
    const recordB = await linked(harness, pathsB.recordPath);
    linkA = service(pathsA, gatewayA);
    linkB = service(pathsB, gatewayB);
    await harness.waitDevice(2);
    const deviceA = harness.devices.find((device) => device.deviceId === recordA.deviceId && device.authenticated);
    const deviceB = harness.devices.find((device) => device.deviceId === recordB.deviceId && device.authenticated);
    assert.ok(deviceA && deviceB);
    // Each signs with its own key only.
    assert.ok(deviceA.proofVerified && deviceB.proofVerified);
    assert.notEqual(recordA.privateKeyBase64, recordB.privateKeyBase64);
    // A's seat reaches A's gateway only.
    const channelA = await opened(deviceA);
    deviceA.request(channelA, {type: "req", id: "a1", method: "sessions.list", params: {}});
    await deviceA.waitFrame((frame) => frame.channelId === channelA && frame.type === "openclaw-frame");
    assert.equal(gatewayA.connections.length, 1);
    assert.equal(gatewayB.connections.length, 0);
    assert.equal(deviceB.frames.length, 0);
    // Two channels of A: a response and a chat event of one never reach the other.
    const channelA2 = await opened(deviceA);
    gatewayA.connections[0].send({type: "event", event: "chat", payload: {runId: "r", sessionKey: "s", seq: 1, state: "final"}});
    await deviceA.waitFrame((frame) => frame.channelId === channelA && frame.type === "openclaw-frame" && JSON.parse(frame.data).type === "event");
    deviceA.request(channelA2, {type: "req", id: "a1", method: "sessions.list", params: {}});
    await waitFor(() => deviceA.channelFrames(channelA2).filter((frame) => frame.type === "openclaw-frame").length === 1, {label: "channel 2 reply"});
    assert.equal(deviceA.channelFrames(channelA2).filter((frame) => frame.type === "openclaw-frame" && JSON.parse(frame.data).type === "event").length, 0);
    assert.equal(deviceA.channelFrames(channelA).filter((frame) => frame.type === "openclaw-frame" && JSON.parse(frame.data).type === "res").length, 1);
    // A challenge for B's device sent to A's socket is never answered by A.
    const crossed = await fakeHarness({challenge: (fields) => ({...fields, deviceId: recordB.deviceId})});
    const pathsC = await scratch("person-a-crossed");
    let linkC;
    try {
      await linked(crossed, pathsC.recordPath);
      linkC = service(pathsC, gatewayA);
      await waitFor(() => linkC.instance.snapshot().code === "link_audience_mismatch", {label: "mismatch"});
      assert.equal(crossed.devices[0].proofs.length, 0);
    } finally {
      await linkC?.stop();
      await crossed.close();
      await pathsC.cleanup();
    }
    // A Hermes token never links this OpenClaw.
    assert.throws(() => parseToken(makeToken({audience: harness.audience, prefix: "twh1."})), (error) => error.code === "link_token_invalid");
  } finally {
    await linkA?.stop();
    await linkB?.stop();
    await gatewayA.close();
    await gatewayB.close();
    await harness.close();
    await pathsA.cleanup();
    await pathsB.cleanup();
  }
});

test("L1o projection: only the four admitted methods reach the gateway, with their parameters reduced; anything else is answered by the device", async () => {
  assert.deepEqual(ADMITTED_METHODS, conformance.parityL1oAdmittedMethods);
  const refused = (text, code) => {
    const result = projectRequest(text);
    assert.equal(JSON.parse(result.refuse).error.code, code, text);
    return JSON.parse(result.refuse);
  };
  for (const method of ["connect", "config.apply", "exec.approvals.set", "chat.inject", "node.invoke", "sessions.delete", "agent", "__proto__", "toString"]) {
    assert.deepEqual(refused(JSON.stringify({type: "req", id: "r1", method, params: {}}), "method_not_allowed"),
      {type: "res", id: "r1", ok: false, error: {code: "method_not_allowed", message: METHOD_REFUSAL_MESSAGE}});
  }
  refused(JSON.stringify({type: "req", id: "r2", method: "chat.send", params: {sessionKey: "s", message: "m"}}), "invalid_params");
  refused(JSON.stringify({type: "req", id: "r3", method: "chat.history", params: {sessionKey: ""}}), "invalid_params");
  refused(JSON.stringify({type: "req", id: "r4", method: "chat.history", params: []}), "invalid_params");
  refused(JSON.stringify({type: "req", id: "r5", method: "sessions.list", params: {limit: 0}}), "invalid_params");
  refused(JSON.stringify({type: "req", id: "r6", method: "chat.abort", params: {sessionKey: "x".repeat(513)}}), "invalid_params");
  for (const text of ["nope", "[]", JSON.stringify({type: "res", id: "x"}), JSON.stringify({type: "req", id: "has space", method: "chat.send"}), JSON.stringify({type: "req", id: "x".repeat(129), method: "chat.send"})]) {
    assert.deepEqual(projectRequest(text), {invalid: true}, text);
  }
  const forward = (method, params) => JSON.parse(projectRequest(JSON.stringify({type: "req", id: "f", method, params})).forward).params;
  assert.deepEqual(forward("chat.send", {sessionKey: "s", message: "m", idempotencyKey: "k", attachments: [1], deliver: true, originatingChannel: "x", agentId: "main"}),
    {sessionKey: "s", agentId: "main", message: "m", idempotencyKey: "k"});
  assert.deepEqual(forward("sessions.list", {limit: 999, includeGlobal: true, search: "", archived: true}), {limit: 200, search: ""});
  assert.deepEqual(forward("sessions.list", undefined), {limit: 50});
  assert.deepEqual(forward("chat.abort", {sessionKey: "s", runId: "r", preserveSideRuns: true}), {sessionKey: "s", runId: "r"});
  // Through the link: a refused method never reaches the gateway; a frame
  // that is not a request ends that channel.
  const paths = await scratch("l1o-projection");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    await linked(harness, paths.recordPath);
    link = service(paths, gateway);
    const device = await harness.waitDevice();
    const channelId = await opened(device);
    device.request(channelId, {type: "req", id: "x1", method: "config.apply", params: {raw: "{}"}});
    const answer = await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-frame");
    assert.equal(JSON.parse(answer.data).error.code, "method_not_allowed");
    assert.equal(gateway.connections[0].requests.length, 0);
    assert.equal(link.instance.snapshot().lastChannelErrorCode, "channel_method_refused");
    device.send({version: 1, type: "openclaw-frame", channelId, data: "not a request"});
    await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-close");
    assert.equal(link.instance.snapshot().lastChannelErrorCode, "channel_request_invalid");
    assert.equal(device.closed, null);
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("L1o setup: openclaw-room-link links, reports its status and unlinks without printing a secret", async () => {
  const paths = await scratch("l1o-setup");
  const harness = await fakeHarness();
  try {
    const token = makeToken({audience: harness.audience});
    const output = sink();
    const errors = sink();
    assert.equal(await runLinkCli([], {input: ttyInput(`${token}\ry\n`), output, errors, path: paths.recordPath, label: "Mac test · OpenClaw default"}), 0);
    assert.match(errors.text, /Link token from your OpenClaw card \(Settings > Plugins > OpenClaw > Link\), input hidden: /);
    assert.match(output.text, new RegExp(`Server: 127\\.0\\.0\\.1:${harness.port}`));
    assert.match(output.text, /This OpenClaw: Mac test · OpenClaw default/);
    assert.match(output.text, /Linked: device /);
    const statusOut = sink();
    assert.equal(await runLinkCli(["status"], {input: ttyInput(""), output: statusOut, errors: sink(), path: paths.recordPath}), 0);
    const shown = JSON.parse(statusOut.text);
    assert.equal(shown.record.state, "active");
    assert.deepEqual(Object.keys(shown.record).sort(), ["audience", "confirmedAt", "createdAt", "deviceId", "deviceLabel", "fingerprintSha256", "state"]);
    const record = readLink(paths.recordPath);
    for (const secret of [record.privateKeyBase64, parseToken(token).pairingSecret, token]) {
      assert.ok(!output.text.includes(secret) && !errors.text.includes(secret) && !statusOut.text.includes(secret));
    }
    assert.equal(await runLinkCli(["unlink"], {input: ttyInput(""), output: sink(), errors: sink(), path: paths.recordPath}), 0);
    assert.equal(readLink(paths.recordPath), null);
    assert.equal(await runLinkCli(["rotate"], {input: ttyInput(""), output: sink(), errors: sink(), path: paths.recordPath}), 2);
  } finally {
    await harness.close();
    await paths.cleanup();
  }
});

test("L1o store: the link record and the pending re-link are 0600 in a 0700 fenced directory, and a symlink in their place is refused", async () => {
  const paths = await scratch("l1o-store");
  try {
    const token = parseToken(makeToken({audience: "https://rooms.tokenwerk.eu/tokenwerk/room/v1/local-devices/connect"}));
    writeLink(pendingRecord(token), pendingPath(paths.recordPath));
    assert.equal((await lstat(paths.store)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(paths.store, LINK_PENDING_FILE))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(paths.store)).filter((name) => name.endsWith(".tmp")), []);
    const elsewhere = join(paths.root, "elsewhere.json");
    await writeFile(elsewhere, "{}");
    await symlink(elsewhere, paths.recordPath);
    assert.throws(() => readLink(paths.recordPath), /regular file/);
    await rm(paths.recordPath);
    await mkdir(join(paths.root, "real"), {recursive: true});
    assert.equal(readLink(paths.recordPath), null);
  } finally {
    await paths.cleanup();
  }
});

test("L1o service: a link service failure never stops the gateway, and one service runs per gateway process", async () => {
  const paths = await scratch("l1o-service");
  const harness = await fakeHarness();
  const gateway = await fakeGateway();
  let link;
  try {
    await linked(harness, paths.recordPath);
    // A status sink that throws is diagnostics only: the link still connects.
    link = service(paths, gateway, {status: {setLink: () => { throw new Error("disk full"); }}});
    await harness.waitDevice();
    await waitFor(() => link.instance.snapshot().state === "connected", {label: "connected"});
    // startRoomLink never throws and starts one service per process (on an
    // empty store of its own: nothing is linked there).
    const prior = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = join(paths.root, "empty-state");
    try {
      const first = startRoomLink({pluginVersion: "0.2.84", config: () => { throw new Error("config gone"); }, status: null});
      const second = startRoomLink({pluginVersion: "0.2.84"});
      assert.ok(first);
      assert.equal(first, second);
      assert.equal(first.recordPath, join(paths.root, "empty-state", "synthetic-sociality-room", "link.json"));
      stopRoomLink();
    } finally {
      if (prior === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prior;
    }
  } finally {
    await link?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});
