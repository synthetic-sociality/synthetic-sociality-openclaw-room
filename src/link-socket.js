// Contract L1 and L1o: the WebSocket of the device link, without a dependency.
//
// A small RFC 6455 client (and, for tests, the server side of an accepted
// upgrade). The link needs what a browser-style WebSocket does not offer: its
// own pings (L1-5), a message size bound that closes with 1009 before the
// payload is buffered, no redirect (L1-1), no proxy, no Origin header. A
// refused upgrade reports its HTTP status; a 3xx is refused, never followed.
import {createHash, randomBytes} from "node:crypto";
import {EventEmitter} from "node:events";
import http from "node:http";
import https from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CLOSE_WAIT_MS = 2_000;
const decoder = new TextDecoder("utf-8", {fatal: true});

export function acceptKey(key) {
  return createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

// An upgrade that did not open: `status` is the HTTP status (0 when none).
export class WebSocketRefused extends Error {
  constructor(status, reason = "refused", {headers = {}, body = ""} = {}) {
    super(`websocket ${reason}${status ? ` (HTTP ${status})` : ""}`);
    this.status = status;
    this.reason = reason;
    // The refusal's headers and the first 4 KiB of its body (P11b-3: a site's
    // bot protection is told apart from the Harness by them).
    this.headers = headers;
    this.body = body;
  }
}

export class LinkSocket extends EventEmitter {
  constructor(socket, {role = "client", maxMessageBytes = 16 * 1024 * 1024, head, autoPong = true} = {}) {
    super();
    this.socket = socket;
    this.role = role;
    this.maxMessageBytes = maxMessageBytes;
    this.autoPong = autoPong;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.closed = false;
    this.closeSent = false;
    this.started = false;
    socket.setNoDelay?.(true);
    socket.on("error", () => {});
    socket.on("close", () => this.finish(1006, "", false));
    socket.pause();
  }

  // Messages flow only after the caller attached its listeners.
  start() {
    if (this.started) return this;
    this.started = true;
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.resume();
    if (this.buffer.length) queueMicrotask(() => this.receive(Buffer.alloc(0)));
    return this;
  }

  get bufferedAmount() {
    return this.socket.writableLength ?? 0;
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = chunk.length ? Buffer.concat([this.buffer, chunk]) : this.buffer;
    while (!this.closed && this.buffer.length >= 2) {
      const buffer = this.buffer;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2) !== 0) return this.fail(1009, "message too large");
        length = buffer.readUInt32BE(6);
        offset = 10;
      }
      if (buffer[0] & 0x70) return this.fail(1002, "reserved bits");
      if (masked !== (this.role === "server")) return this.fail(1002, "masking");
      const control = opcode >= 0x8;
      if (control && (length > 125 || !fin)) return this.fail(1002, "control frame");
      if (!control && this.fragmentBytes + length > this.maxMessageBytes) return this.fail(1009, "message too large");
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[maskAt + (index % 4)];
      this.buffer = buffer.subarray(offset + length);
      this.frame(fin, opcode, payload);
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentOpcode) return this.fail(1002, "interleaved message");
      if (fin) return this.deliver(opcode, payload);
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragmentOpcode) return this.fail(1002, "continuation");
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (!fin) return;
      const whole = Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = 0;
      return this.deliver(kind, whole);
    }
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      let reason = "";
      try { reason = decoder.decode(payload.subarray(2)); } catch {}
      if (!this.closeSent) this.sendClose(code === 1005 ? undefined : code, "");
      this.finish(code, reason, false);
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      if (this.autoPong) this.sendFrame(0xa, payload);
      this.emit("ping");
      return;
    }
    if (opcode === 0xa) {
      this.emit("pong");
      return;
    }
    this.fail(1002, "opcode");
  }

  deliver(opcode, payload) {
    if (opcode === 0x2) {
      this.emit("message", payload, true);
      return;
    }
    let text;
    try {
      text = decoder.decode(payload);
    } catch {
      return this.fail(1007, "invalid utf-8");
    }
    this.emit("message", text, false);
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const length = payload.length;
    const mask = this.role === "client";
    const header = Buffer.alloc(2 + (length > 65535 ? 8 : length > 125 ? 2 : 0) + (mask ? 4 : 0));
    header[0] = 0x80 | opcode;
    let offset = 2;
    if (length > 65535) {
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
      offset = 10;
    } else if (length > 125) {
      header[1] = 126;
      header.writeUInt16BE(length, 2);
      offset = 4;
    } else {
      header[1] = length;
    }
    let body = payload;
    if (mask) {
      header[1] |= 0x80;
      const key = randomBytes(4);
      key.copy(header, offset);
      body = Buffer.from(payload);
      for (let index = 0; index < body.length; index += 1) body[index] ^= key[index % 4];
    }
    this.socket.write(Buffer.concat([header, body]));
    return true;
  }

  send(text) {
    if (this.closeSent) return false;
    return this.sendFrame(0x1, Buffer.from(String(text), "utf8"));
  }

  sendBinary(bytes) {
    if (this.closeSent) return false;
    return this.sendFrame(0x2, Buffer.from(bytes));
  }

  ping() {
    if (this.closeSent) return false;
    return this.sendFrame(0x9, Buffer.alloc(0));
  }

  sendClose(code, reason = "") {
    if (this.closeSent) return;
    this.closeSent = true;
    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      const text = Buffer.from(String(reason), "utf8").subarray(0, 123);
      payload = Buffer.alloc(2 + text.length);
      payload.writeUInt16BE(code, 0);
      text.copy(payload, 2);
    }
    this.sendFrame(0x8, payload);
  }

  // A clean close: the peer's echo (or the socket's end) reports it.
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.sendClose(code, reason);
    this.localClose ??= {code, reason};
    const timer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS);
    timer.unref?.();
  }

  // A protocol failure of the peer: close with `code`, reported as local.
  fail(code, reason) {
    if (this.closed) return;
    this.sendClose(code, reason);
    this.finish(code, reason, true);
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS);
    timer.unref?.();
  }

  terminate() {
    this.socket.destroy();
    this.finish(1006, "", true);
  }

  finish(code, reason, local) {
    if (this.closed) return;
    this.closed = true;
    const own = this.localClose;
    // A close this side started is reported with its own code when the peer
    // only dropped the connection.
    if (own && code === 1006 && !local) this.emit("close", own.code, own.reason, true);
    else this.emit("close", code, reason, Boolean(local) || Boolean(own && code === own.code));
  }
}

// Open one WebSocket. Resolves an unstarted LinkSocket; call start() after
// attaching listeners.
export function connectWebSocket(url, {headers = {}, maxMessageBytes, timeoutMs = 15_000, autoPong = true} = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new WebSocketRefused(0, "invalid url"));
      return;
    }
    const secure = target.protocol === "wss:";
    if (!secure && target.protocol !== "ws:") {
      reject(new WebSocketRefused(0, "invalid url"));
      return;
    }
    const key = randomBytes(16).toString("base64");
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const request = (secure ? https : http).request({
      protocol: secure ? "https:" : "http:",
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      agent: false,
      headers: {...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13"},
    });
    const timer = setTimeout(() => {
      request.destroy();
      fail(new WebSocketRefused(0, "timeout"));
    }, timeoutMs);
    timer.unref?.();
    request.on("response", (response) => {
      const chunks = [];
      let size = 0;
      const done = () => {
        request.destroy();
        fail(new WebSocketRefused(response.statusCode ?? 0, "refused", {headers: response.headers, body: Buffer.concat(chunks).toString("utf8").slice(0, 4096)}));
      };
      response.on("data", (chunk) => {
        if (size < 4096) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", done);
      response.on("error", done);
      response.on("close", done);
    });
    request.on("upgrade", (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== acceptKey(key)) {
        socket.destroy();
        fail(new WebSocketRefused(response.statusCode ?? 0));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(new LinkSocket(socket, {role: "client", maxMessageBytes, head, autoPong}));
    });
    request.on("error", () => fail(new WebSocketRefused(0, "unreachable")));
    request.end();
  });
}

// The server side of an upgrade request (tests' fake servers). Unstarted.
export function acceptWebSocket(request, socket, head, {maxMessageBytes, autoPong = true} = {}) {
  const key = String(request.headers["sec-websocket-key"] ?? "");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "", "",
  ].join("\r\n"));
  return new LinkSocket(socket, {role: "server", maxMessageBytes, head, autoPong});
}
