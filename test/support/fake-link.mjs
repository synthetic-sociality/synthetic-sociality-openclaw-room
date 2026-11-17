// Fakes for the device link tests (contract L1, L1o), loopback only: a
// Harness device ingress (pairing confirmation, signed handshake, openclaw-*
// frames, as sociality-room-bff openclaw-link.ts and the device ingress) and
// an OpenClaw gateway (connect.challenge, connect with the shared token,
// hello-ok, requests and events, as host 2026.7.1-2 protocol 4).
import http from "node:http";
import {createHash, createPublicKey, randomUUID, verify} from "node:crypto";
import {acceptWebSocket} from "../../src/link-socket.js";

const PATH = "/tokenwerk/room/v1/local-devices";

export async function waitFor(predicate, {timeoutMs = 4000, stepMs = 10, label = "condition"} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export function makeToken({audience, deviceId = randomUUID(), pairingSecret = "S".repeat(43), expiresAt = new Date(Date.now() + 600_000).toISOString(), v = 1, prefix = "twoc1.", extra = {}}) {
  return `${prefix}${Buffer.from(JSON.stringify({v, audience, deviceId, pairingSecret, expiresAt, ...extra}), "utf8").toString("base64url")}`;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function verifySignature(spkiBase64, bytes, signatureBase64) {
  try {
    const key = createPublicKey({key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki"});
    return verify(null, bytes, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

// The Harness side. `confirmation(request)` returns {status, body} for a
// pairing confirmation; `connectStatus` refuses the upgrade with that status.
// `verifyProofs` refuses a proof that the confirmed key does not verify.
// `edge(request)` stands in front of both (a site's bot protection): it
// returns {status, headers, text} to answer instead of the Harness, or null.
export async function fakeHarness({limits = {maxDataBytes: 4096, openTimeoutMs: 2000, maxChannels: 2}, confirmation, connectStatus = 0,
  connectHeaders = {}, challenge = (fields) => fields, autoPong = true, completeExtra = {}, edge, verifyProofs = false} = {}) {
  const sockets = new Set();
  const state = {confirmations: [], upgrades: [], devices: [], keys: new Map(), connectStatus, connectHeaders, edge, edged: [], verifyProofs};
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry = {method: request.method, url: request.url, headers: request.headers, raw};
      const blocked = state.edge?.(request) ?? null;
      if (blocked) {
        state.edged.push({kind: "http", headers: request.headers});
        response.writeHead(blocked.status, blocked.headers ?? {});
        response.end(blocked.text ?? "");
        return;
      }
      state.confirmations.push(entry);
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      entry.body = body;
      const decided = confirmation?.(entry, state) ?? null;
      if (decided) {
        response.writeHead(decided.status, {"content-type": "application/json", ...(decided.headers ?? {})});
        response.end(decided.body === undefined ? "{}" : JSON.stringify(decided.body));
        return;
      }
      if (request.url !== `${PATH}/pairing-confirmations` || request.method !== "POST" || !body) {
        response.writeHead(404).end("{}");
        return;
      }
      state.keys.set(body.deviceId, body.publicKeySpkiBase64);
      response.writeHead(201, {"content-type": "application/json"});
      response.end(JSON.stringify({deviceId: body.deviceId, state: "active", fingerprintSha256: entry.fingerprint ?? fingerprintOf(body.publicKeySpkiBase64),
        confirmedAt: "2026-11-16T10:00:00Z"}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const blocked = state.edge?.(request) ?? null;
    if (blocked) {
      state.edged.push({kind: "upgrade", headers: request.headers});
      const text = blocked.text ?? "";
      const headers = Object.entries(blocked.headers ?? {}).map(([key, value]) => `${key}: ${value}\r\n`).join("");
      socket.end(`HTTP/1.1 ${blocked.status} Forbidden\r\n${headers}Content-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      return;
    }
    state.upgrades.push({url: request.url, headers: request.headers});
    if (state.connectStatus) {
      const headers = Object.entries(state.connectHeaders).map(([key, value]) => `${key}: ${value}\r\n`).join("");
      socket.end(`HTTP/1.1 ${state.connectStatus} Refused\r\n${headers}Content-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (url.pathname !== `${PATH}/connect`) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(request, socket, head, {autoPong});
    const deviceId = url.searchParams.get("deviceId");
    const device = {ws, deviceId, frames: [], proofs: [], pings: 0, closed: null, authenticated: false};
    state.devices.push(device);
    const fields = challenge({
      version: 1, type: "authentication-challenge", handshakeId: randomUUID(), connectionId: randomUUID(), deviceId,
      audience: state.audience, nonce: "N".repeat(43), expiresAt: new Date(Date.now() + 15_000).toISOString(),
    });
    device.challenge = fields;
    ws.on("ping", () => { device.pings += 1; });
    ws.on("close", (code, reason) => { device.closed = {code, reason}; });
    ws.on("message", (text) => {
      let value;
      try { value = JSON.parse(text); } catch { value = {raw: text}; }
      if (!device.authenticated) {
        device.proofs.push(value);
        const input = Buffer.from(JSON.stringify({version: fields.version, handshakeId: fields.handshakeId, connectionId: fields.connectionId,
          deviceId: fields.deviceId, audience: fields.audience, nonce: fields.nonce, expiresAt: fields.expiresAt}), "utf8");
        device.proofVerified = verifySignature(state.keys.get(deviceId) ?? "", input, value.signatureBase64 ?? "");
        if (state.verifyProofs && !device.proofVerified) {
          // As the device ingress: a key the server does not hold active.
          ws.close(1008, "authentication-failed");
          return;
        }
        device.authenticated = true;
        const complete = {version: 1, type: "authentication-complete", ...completeExtra};
        if (limits) complete.limits = limits;
        ws.send(JSON.stringify(complete));
        return;
      }
      device.frames.push(value);
    });
    device.send = (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value));
    device.open = (channelId = randomUUID()) => {
      device.send({version: 1, type: "openclaw-open", channelId});
      return channelId;
    };
    device.request = (channelId, request) => device.send({version: 1, type: "openclaw-frame", channelId, data: JSON.stringify(request)});
    device.waitFrame = (predicate, options) => waitFor(() => device.frames.find(predicate), {label: "device frame", ...options});
    device.channelFrames = (channelId) => device.frames.filter((frame) => frame.channelId === channelId);
    ws.start();
    ws.send(JSON.stringify(fields));
  });
  const port = await listen(server);
  state.port = port;
  state.audience = `http://127.0.0.1:${port}${PATH}/connect`;
  state.server = server;
  state.close = () => closeServer(server, sockets);
  state.waitDevice = (count = 1, options) => waitFor(() => state.devices.filter((device) => device.authenticated).length >= count
    && state.devices.filter((device) => device.authenticated)[count - 1], {label: "device", ...options});
  return state;
}

function fingerprintOf(spkiBase64) {
  return createHash("sha256").update(Buffer.from(String(spkiBase64 ?? ""), "base64")).digest("hex");
}

// The OpenClaw gateway side. `respond(request, connection)` returns the
// response frame (or null for none); by default an echo of method and params.
// `grantScopes(requested)` returns the scopes hello-ok lists (by default
// operator.read and operator.write); a connect asking `refuseScope` is refused.
export async function fakeGateway({token = "gateway-token-0123456789abcdef", password, respond, upgradeStatus = 0, upgradeHeaders = {}, maxMessageBytes,
  grantScopes = () => ["operator.read", "operator.write"], refuseScope} = {}) {
  const sockets = new Set();
  const state = {connections: [], upgrades: [], token};
  const server = http.createServer((request, response) => response.writeHead(426).end());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    state.upgrades.push({url: request.url, headers: request.headers});
    if (upgradeStatus) {
      const headers = Object.entries(upgradeHeaders).map(([key, value]) => `${key}: ${value}\r\n`).join("");
      socket.end(`HTTP/1.1 ${upgradeStatus} Refused\r\n${headers}Content-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    const ws = acceptWebSocket(request, socket, head, {maxMessageBytes});
    const connection = {ws, connect: null, requests: [], closed: null, messages: []};
    state.connections.push(connection);
    ws.on("close", (code) => { connection.closed = {code}; });
    ws.on("message", (text) => {
      connection.messages.push(text);
      const frame = JSON.parse(text);
      if (frame.method === "connect" && !connection.connect) {
        connection.connect = frame;
        const auth = frame.params?.auth ?? {};
        const requested = Array.isArray(frame.params?.scopes) ? frame.params.scopes : [];
        const accepted = (password !== undefined ? auth.password === password : token === null ? !frame.params?.auth : auth.token === token)
          && !(refuseScope && requested.includes(refuseScope));
        if (!accepted) {
          ws.send(JSON.stringify({type: "res", id: frame.id, ok: false, error: {code: "INVALID_REQUEST", message: "unauthorized"}}));
          ws.close(1008, "unauthorized");
          return;
        }
        ws.send(JSON.stringify({type: "res", id: frame.id, ok: true, payload: {type: "hello-ok", protocol: 4, server: {version: "2026.7.1-2", connId: "c1"},
          features: {methods: [], events: []}, snapshot: {}, auth: {role: "operator", scopes: grantScopes(requested)},
          policy: {maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000}}}));
        // A tick and a presence event, both of which the link drops.
        ws.send(JSON.stringify({type: "event", event: "tick", payload: {ts: 1}}));
        ws.send(JSON.stringify({type: "event", event: "presence", payload: {entries: []}}));
        return;
      }
      connection.requests.push(frame);
      const reply = respond ? respond(frame, connection) : {type: "res", id: frame.id, ok: true, payload: {method: frame.method, params: frame.params}};
      if (reply) ws.send(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
    connection.send = (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value));
    ws.start();
    ws.send(JSON.stringify({type: "event", event: "connect.challenge", payload: {nonce: "gateway-nonce", ts: Date.now()}}));
  });
  const port = await listen(server);
  state.port = port;
  state.close = () => closeServer(server, sockets);
  state.config = (extra = {}) => ({gateway: {port, auth: password !== undefined ? {mode: "password", password} : token === null ? {mode: "none"} : {mode: "token", token}, ...extra}});
  return state;
}

// A redirect target that counts every request it gets.
export async function redirectTarget() {
  const sockets = new Set();
  const state = {hits: 0};
  const server = http.createServer((request, response) => {
    state.hits += 1;
    response.writeHead(201).end("{}");
  });
  server.on("upgrade", (request, socket) => {
    state.hits += 1;
    socket.destroy();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  state.port = await listen(server);
  state.url = `http://127.0.0.1:${state.port}/elsewhere`;
  state.close = () => closeServer(server, sockets);
  return state;
}
