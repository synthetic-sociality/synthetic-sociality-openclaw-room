// Contract "Link features (additive, frame version 1, 2026-11-17)", LF-1 to
// LF-7 (OpenClaw 0.2.86): with `limits.openclawLinkFeatures: 1` a channel
// announces create, archive, attachments and (when the gateway grants
// operator.approvals) approvals, and admits sessions.create, sessions.patch
// (archive only), chat.send attachments and the approval events, lists and
// answers of the sessions that channel serves. Without the capability every
// frame, scope and projection is exactly 0.2.85. Loopback fakes only: the
// fake Harness device ingress and the fake OpenClaw gateway.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as link from "../src/link.js";
import {LocalStatus} from "../src/local-status.js";
import {fakeGateway, fakeHarness, makeToken, waitFor} from "./support/fake-link.mjs";

link.allowLoopbackPlainForTests(true);

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const BASE_LIMITS = {maxDataBytes: 65536, openTimeoutMs: 3000, maxChannels: 3, openFailedReason: 1};
const ALL = ["create", "archive", "attachments", "approvals"];
const GRANT_ALL = (requested) => requested;
const S1 = "agent:main:s1";
const S2 = "agent:main:s2";
const ABSENT = Symbol("absent");

let sequence = 0;
const nextId = (prefix = "r") => `${prefix}${++sequence}`;

async function scratch(name) {
  const root = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const store = join(root, "state", "synthetic-sociality-room");
  return {recordPath: join(store, "link.json"), statusPath: join(store, "status.json"), cleanup: () => rm(root, {recursive: true, force: true})};
}

// One linked device. `capability` is the value of limits.openclawLinkFeatures
// (ABSENT: no such key); `handlers[method](frame, connection)` answer
// gateway requests (default: an echo of method and params).
async function linkWith({capability = 1, limits = {}, gateway: gatewayOptions = {}} = {}) {
  const paths = await scratch("lf");
  const advertised = {...BASE_LIMITS, ...limits};
  if (capability !== ABSENT) advertised.openclawLinkFeatures = capability;
  const harness = await fakeHarness({limits: advertised});
  const handlers = {};
  const gateway = await fakeGateway({grantScopes: GRANT_ALL, ...gatewayOptions, respond: (frame, connection) => handlers[frame.method]
    ? handlers[frame.method](frame, connection)
    : {type: "res", id: frame.id, ok: true, payload: {method: frame.method, params: frame.params}}});
  const status = new LocalStatus(paths.statusPath, {version: "0.2.86", hostLabel: "test"});
  const instance = new link.LinkService({pluginVersion: "0.2.86", status, recordPath: paths.recordPath,
    localOpener: (lim, options = {}) => link.openLocalGateway({cfg: gateway.config(), env: {}, maxDataBytes: lim.maxDataBytes,
      timeoutMs: lim.openTimeoutMs, version: "0.2.86", ...options}),
    backoff: () => 30, pollMs: 25, logger: {info() {}, warn() {}, error() {}}});
  const token = link.parseToken(makeToken({audience: harness.audience}));
  link.writeLink(link.pendingRecord(token, {label: "Mac test · OpenClaw default"}), link.pendingPath(paths.recordPath));
  assert.equal((await link.confirmPending({path: paths.recordPath})).state, "active");
  const running = instance.run();
  const device = await harness.waitDevice();
  const data = (frame) => JSON.parse(frame.data);
  const ctx = {
    device, gateway, handlers, instance,
    // Open a channel: {channelId, opened, connection}.
    async open() {
      const before = gateway.connections.length;
      const channelId = device.open();
      const opened = await device.waitFrame((frame) => frame.channelId === channelId && ["openclaw-opened", "openclaw-open-failed"].includes(frame.type));
      return {channelId, opened, connection: gateway.connections.at(-1), connections: gateway.connections.slice(before)};
    },
    // One request through the link and its answer.
    async call(channelId, method, params, id = nextId()) {
      device.request(channelId, {type: "req", id, method, params});
      const answer = await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-frame" && data(frame).id === id);
      return data(answer);
    },
    events(channelId, name) {
      return device.channelFrames(channelId).filter((frame) => frame.type === "openclaw-frame").map(data)
        .filter((value) => value.type === "event" && (!name || value.event === name));
    },
    // Push a gateway event, then a marker chat event, and wait for the marker:
    // everything the device forwarded from the first has arrived by then.
    async push(channel, event, payload, seq) {
      const value = {type: "event", event, payload};
      if (seq !== undefined) value.seq = seq;
      channel.connection.send(value);
      const marker = nextId("m");
      channel.connection.send({type: "event", event: "chat", payload: {marker}});
      await device.waitFrame((frame) => frame.channelId === channel.channelId && frame.type === "openclaw-frame" && data(frame).payload?.marker === marker);
    },
    requests(channel, method) {
      return channel.connection.requests.filter((frame) => frame.method === method);
    },
    async serve(channel, sessionKey) {
      const answer = await ctx.call(channel.channelId, "chat.history", {sessionKey});
      assert.equal(answer.ok, true);
    },
    async close() {
      instance.stop();
      await running;
      await gateway.close();
      await harness.close();
      await paths.cleanup();
    },
  };
  return ctx;
}

async function withLink(options, body) {
  const ctx = await linkWith(options);
  try {
    await body(ctx);
  } finally {
    await ctx.close();
  }
}

const approval = (id, sessionKey, extra = {}) => ({
  id, createdAtMs: 1000, expiresAtMs: Date.now() + 600_000, allowedDecisions: ["allow-once", "allow-always", "deny"],
  request: {sessionKey, command: "ls -la", commandPreview: "ls", ...extra.request},
  ...extra.top,
});
const reduced = (row) => {
  const out = {id: row.id, createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs, allowedDecisions: row.allowedDecisions};
  const request = {};
  for (const key of ["sessionKey", "parentSessionKey", "parent", "commandPreview", "command", "title", "description", "toolName", "tool"]) {
    if (row.request[key] !== undefined) request[key] = row.request[key];
  }
  for (const key of ["allowedDecisions", "expiresAtMs"]) if (row.request[key] !== undefined) request[key] = row.request[key];
  out.request = request;
  return out;
};
const refusedCode = (answer) => answer.ok === false ? answer.error.code : "ok";

test("LF-01 without limits.openclawLinkFeatures 1 the opened frame has no features, the connect asks no extra scope, and every LF method is method_not_allowed and every approval event is dropped", async () => {
  for (const capability of [ABSENT, 2, "1", true, 0, null]) {
    await withLink({capability}, async (ctx) => {
      const channel = await ctx.open();
      assert.deepEqual(channel.opened, {version: 1, type: "openclaw-opened", channelId: channel.channelId}, String(capability === ABSENT ? "absent" : capability));
      assert.deepEqual(channel.connection.connect.params.scopes, ["operator.read", "operator.write"]);
      await ctx.serve(channel, S1);
      for (const method of ["sessions.create", "sessions.patch", "exec.approval.list", "plugin.approval.list", "exec.approval.resolve", "plugin.approval.resolve"]) {
        assert.equal(refusedCode(await ctx.call(channel.channelId, method, {key: S1, archived: true, id: "a1", decision: "deny"})), "method_not_allowed", method);
        assert.equal(ctx.requests(channel, method).length, 0);
      }
      // chat.send keeps the 0.2.85 projection: attachments are dropped.
      await ctx.call(channel.channelId, "chat.send", {sessionKey: S1, message: "m", idempotencyKey: "k1",
        attachments: [{type: "file", mimeType: "text/plain", fileName: "a.txt", content: "YQ=="}]});
      assert.deepEqual(ctx.requests(channel, "chat.send")[0].params, {sessionKey: S1, message: "m", idempotencyKey: "k1"});
      for (const event of ["exec.approval.requested", "plugin.approval.requested"]) await ctx.push(channel, event, approval("a1", S1));
      await ctx.push(channel, "exec.approval.resolved", {id: "a1", decision: "deny"});
      assert.deepEqual(ctx.events(channel.channelId).filter((value) => value.event !== "chat"), []);
    });
  }
  // Control: the same device with the capability announces its features.
  await withLink({}, async (ctx) => {
    assert.deepEqual((await ctx.open()).opened.features, ALL);
  });
});

test("LF-02 with the capability the opened frame carries features create, archive, attachments, approvals in that order after channelId", async () => {
  await withLink({}, async (ctx) => {
    const {channelId, opened} = await ctx.open();
    assert.deepEqual(opened, {version: 1, type: "openclaw-opened", channelId, features: ["create", "archive", "attachments", "approvals"]});
    assert.deepEqual(Object.keys(opened), ["version", "type", "channelId", "features"]);
    assert.deepEqual([...link.LINK_FEATURES], conformance.parityL1oLinkFeatures.closedList);
  });
});

test("LF-03 sessions.create keeps only agentId", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    const answer = await ctx.call(channel.channelId, "sessions.create", {agentId: "main", label: "x", model: "gpt", key: "agent:main:forced"});
    assert.equal(answer.ok, true);
    await ctx.call(channel.channelId, "sessions.create", {});
    const sent = ctx.requests(channel, "sessions.create").map((frame) => frame.params);
    assert.deepEqual(sent, [{agentId: "main"}, {}]);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "sessions.create", {agentId: 7})), "invalid_params");
    assert.equal(ctx.requests(channel, "sessions.create").length, 2);
  });
});

test("LF-04 sessions.patch keeps only key and archived true, drops every other key, and refuses a missing or other archived with invalid_params", async () => {
  await withLink({}, async (ctx) => {
    ctx.handlers["sessions.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: {sessions: [{key: S1, sessionId: "u1", archived: false}]}});
    const channel = await ctx.open();
    await ctx.call(channel.channelId, "sessions.list", {limit: 10});
    for (const archived of [undefined, false, "true", 1, null]) {
      const params = {key: S1};
      if (archived !== undefined) params.archived = archived;
      assert.equal(refusedCode(await ctx.call(channel.channelId, "sessions.patch", params)), "invalid_params", String(archived));
    }
    assert.equal(ctx.requests(channel, "sessions.patch").length, 0);
    const answer = await ctx.call(channel.channelId, "sessions.patch", {key: S1, archived: true, model: "x", thinking: "high", label: "renamed",
      execSecurity: "full", newerKey: 1});
    assert.equal(answer.ok, true);
    assert.deepEqual(ctx.requests(channel, "sessions.patch").map((frame) => frame.params), [{key: S1, archived: true}]);
  });
});

test("LF-05 sessions.patch for a key not returned on the same channel is invalid_params and never reaches the gateway", async () => {
  await withLink({}, async (ctx) => {
    ctx.handlers["sessions.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: {sessions: [{key: S1}, {key: 5}, "x"]}});
    ctx.handlers["sessions.create"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: {ok: true, key: "agent:main:new"}});
    const a = await ctx.open();
    const b = await ctx.open();
    // Never returned, or returned only on another channel.
    assert.equal(refusedCode(await ctx.call(a.channelId, "sessions.patch", {key: S1, archived: true})), "invalid_params");
    await ctx.call(b.channelId, "sessions.list", {});
    assert.equal(refusedCode(await ctx.call(a.channelId, "sessions.patch", {key: S1, archived: true})), "invalid_params");
    assert.equal(refusedCode(await ctx.call(b.channelId, "sessions.patch", {key: "agent:main:s", archived: true})), "invalid_params");
    assert.equal(ctx.requests(a, "sessions.patch").length + ctx.requests(b, "sessions.patch").length, 0);
    // Returned on the same channel: by sessions.list or by sessions.create.
    assert.equal((await ctx.call(b.channelId, "sessions.patch", {key: S1, archived: true})).ok, true);
    await ctx.call(a.channelId, "sessions.create", {});
    assert.equal((await ctx.call(a.channelId, "sessions.patch", {key: "agent:main:new", archived: true})).ok, true);
    assert.equal(refusedCode(await ctx.call(b.channelId, "sessions.patch", {key: "agent:main:new", archived: true})), "invalid_params");
  });
});

test("LF-06 an unlisted method (sessions.delete, sessions.reset, connect) stays method_not_allowed with the capability", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    assert.deepEqual(channel.opened.features, ALL);
    for (const method of ["sessions.delete", "sessions.reset", "connect", "exec.approvals.set", "exec.approval.request", "config.apply", "chat.inject", "node.invoke"]) {
      const answer = await ctx.call(channel.channelId, method, {key: S1, id: "a1"});
      assert.deepEqual(answer.error, {code: "method_not_allowed", message: link.METHOD_REFUSAL_MESSAGE}, method);
    }
    assert.equal(channel.connection.requests.length, 0);
    assert.deepEqual([...link.ADMITTED_METHODS], conformance.parityL1oAdmittedMethods);
  });
});

test("LF-07 with approvals the connect asks operator.approvals in addition to operator.read and operator.write", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    assert.deepEqual(channel.connection.connect.params.scopes, ["operator.read", "operator.write", "operator.approvals"]);
    assert.equal(link.APPROVALS_SCOPE, conformance.parityL1oLinkFeatures.scope.approvals);
  });
});

test("LF-07b without operator.approvals in the hello-ok auth.scopes the opened frame omits approvals and no approval method or event passes; a connect refused with the extra scope is retried once without it and the channel opens without approvals", async () => {
  const withoutApprovals = async (ctx, channel) => {
    assert.deepEqual(channel.opened.features, ["create", "archive", "attachments"]);
    await ctx.serve(channel, S1);
    for (const method of ["exec.approval.list", "plugin.approval.list", "exec.approval.resolve", "plugin.approval.resolve"]) {
      assert.equal(refusedCode(await ctx.call(channel.channelId, method, {id: "a1", decision: "deny"})), "method_not_allowed", method);
    }
    await ctx.push(channel, "exec.approval.requested", approval("a1", S1));
    await ctx.push(channel, "exec.approval.resolved", {id: "a1", decision: "deny"});
    assert.deepEqual(ctx.events(channel.channelId).filter((value) => value.event !== "chat"), []);
    // The other features still work.
    assert.equal((await ctx.call(channel.channelId, "sessions.create", {})).ok, true);
  };
  // Granted without the extra scope.
  await withLink({gateway: {grantScopes: () => ["operator.read", "operator.write"]}}, async (ctx) => {
    const channel = await ctx.open();
    assert.deepEqual(channel.connection.connect.params.scopes, ["operator.read", "operator.write", "operator.approvals"]);
    await withoutApprovals(ctx, channel);
  });
  // Refused with the extra scope: one more connect without it on a new connection.
  await withLink({gateway: {refuseScope: "operator.approvals"}}, async (ctx) => {
    const channel = await ctx.open();
    assert.equal(channel.opened.type, "openclaw-opened");
    assert.deepEqual(channel.connections.map((connection) => connection.connect.params.scopes),
      [["operator.read", "operator.write", "operator.approvals"], ["operator.read", "operator.write"]]);
    await withoutApprovals(ctx, channel);
  });
  // Both refused (every connect asks operator.read): only then the open fails as refused.
  await withLink({gateway: {refuseScope: "operator.read"}}, async (ctx) => {
    const channel = await ctx.open();
    assert.equal(channel.opened.type, "openclaw-open-failed");
    assert.equal(channel.opened.reason, "local_gateway_refused");
    assert.equal(channel.connections.length, 2);
    assert.equal(ctx.instance.snapshot().lastChannelErrorCode, "local_gateway_refused");
  });
});

test("LF-08 an approval request event is forwarded, reduced, only when its session belongs to a served session of the channel, nested keys included, never a prefix sibling", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    const own = approval("a1", S1, {top: {secret: "drop me", createdAtMs: 5}, request: {env: {TOKEN: "x"}, title: "Run", toolName: "exec", cwd: "/home"}});
    await ctx.push(channel, "exec.approval.requested", own, 7);
    const nested = approval("p1", "agent:main:other", {request: {parentSessionKey: `${S1}:sub`}});
    await ctx.push(channel, "plugin.approval.requested", nested);
    const parent = approval("a2", "agent:main:x", {request: {parent: S1}});
    await ctx.push(channel, "exec.approval.requested", parent);
    await ctx.push(channel, "exec.approval.requested", approval("a3", `${S1}0`));
    await ctx.push(channel, "exec.approval.requested", approval("a4", "agent:main:s"));
    const events = ctx.events(channel.channelId).filter((value) => value.event !== "chat");
    assert.deepEqual(events, [
      {type: "event", event: "exec.approval.requested", payload: reduced(own), seq: 7},
      {type: "event", event: "plugin.approval.requested", payload: reduced(nested)},
      {type: "event", event: "exec.approval.requested", payload: reduced(parent)},
    ]);
    assert.equal(JSON.stringify(events).includes("drop me"), false);
    assert.equal(JSON.stringify(events).includes("TOKEN"), false);
    // A served chat.send counts too.
    await ctx.call(channel.channelId, "chat.send", {sessionKey: S2, message: "m", idempotencyKey: "k"});
    await ctx.push(channel, "exec.approval.requested", approval("a5", S2));
    assert.equal(ctx.events(channel.channelId, "exec.approval.requested").at(-1).payload.id, "a5");
  });
});

test("LF-08b an approval request whose command (or any kept request string) exceeds 32768 characters is not forwarded, is not pending, and its resolve is invalid_params", async () => {
  await withLink({limits: {maxDataBytes: 1_000_000}}, async (ctx) => {
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    const long = approval("big", S1, {request: {command: "x".repeat(32769)}});
    const exact = approval("edge", S1, {request: {command: "y".repeat(32768)}});
    const typed = approval("typed", S1, {request: {title: 42}});
    ctx.handlers["exec.approval.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: [long, typed, exact]});
    await ctx.push(channel, "exec.approval.requested", long);
    await ctx.push(channel, "exec.approval.requested", typed);
    assert.deepEqual(ctx.events(channel.channelId, "exec.approval.requested"), []);
    const list = await ctx.call(channel.channelId, "exec.approval.list", {});
    assert.deepEqual(list.payload.map((row) => row.id), ["edge"]);
    for (const id of ["big", "typed"]) {
      assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id, decision: "deny"})), "invalid_params", id);
    }
    assert.equal(ctx.requests(channel, "exec.approval.resolve").length, 0);
    // The longest admitted value is kept whole, never cut.
    assert.equal(list.payload[0].request.command.length, 32768);
  });
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.equal(contract.includes("cut to 32768"), false);
  assert.ok(contract.includes("**Link features (additive, frame version 1, 2026-11-17).**"));
});

test("LF-09 an approval request event of a session the channel does not serve, or of another channel, is never forwarded", async () => {
  await withLink({}, async (ctx) => {
    const a = await ctx.open();
    const b = await ctx.open();
    await ctx.serve(a, S1);
    await ctx.serve(b, S2);
    // Not served at all.
    await ctx.push(a, "exec.approval.requested", approval("n1", "agent:main:nobody"));
    // Served by the other channel: arrives on b's gateway connection.
    await ctx.push(b, "exec.approval.requested", approval("x1", S1));
    await ctx.push(a, "exec.approval.requested", approval("own", S1));
    assert.deepEqual(ctx.events(a.channelId, "exec.approval.requested").map((value) => value.payload.id), ["own"]);
    assert.deepEqual(ctx.events(b.channelId, "exec.approval.requested"), []);
  });
});

test("LF-10 an approval answer for a request that is not pending on the channel is invalid_params and never reaches the gateway", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    for (const kind of ["exec", "plugin"]) {
      assert.equal(refusedCode(await ctx.call(channel.channelId, `${kind}.approval.resolve`, {id: "never", decision: "allow-once"})), "invalid_params");
      assert.equal(ctx.requests(channel, `${kind}.approval.resolve`).length, 0);
    }
  });
});

test("LF-11 an approval answer for a request pending on another channel, or of the other kind, is invalid_params", async () => {
  await withLink({}, async (ctx) => {
    const a = await ctx.open();
    const b = await ctx.open();
    await ctx.serve(a, S1);
    await ctx.serve(b, S2);
    await ctx.push(a, "exec.approval.requested", approval("a1", S1));
    assert.equal(ctx.events(a.channelId, "exec.approval.requested").length, 1);
    // Another channel (another seat's conversation), and the other kind.
    assert.equal(refusedCode(await ctx.call(b.channelId, "exec.approval.resolve", {id: "a1", decision: "deny"})), "invalid_params");
    assert.equal(refusedCode(await ctx.call(a.channelId, "plugin.approval.resolve", {id: "a1", decision: "deny"})), "invalid_params");
    assert.equal(ctx.requests(a, "plugin.approval.resolve").length + ctx.requests(b, "exec.approval.resolve").length, 0);
    // The right channel and kind passes, with exactly id and decision.
    assert.equal((await ctx.call(a.channelId, "exec.approval.resolve", {id: "a1", decision: "deny"})).ok, true);
    assert.deepEqual(ctx.requests(a, "exec.approval.resolve").map((frame) => frame.params), [{id: "a1", decision: "deny"}]);
  });
});

test("LF-12 a second answer for the same request (an answered id) is invalid_params; it is pending again only after the gateway answered the first with ok false and no resolved event came", async () => {
  await withLink({}, async (ctx) => {
    const outcome = {};
    ctx.handlers["exec.approval.resolve"] = (frame, connection) => {
      const mode = outcome[frame.params.id];
      if (mode === "resolved-then-false") connection.send({type: "event", event: "exec.approval.resolved", payload: {id: frame.params.id, decision: "deny"}});
      return {type: "res", id: frame.id, ok: mode === "ok", ...(mode === "ok" ? {payload: {ok: true}} : {error: {code: "INVALID_REQUEST", message: "no"}})};
    };
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    for (const id of ["ok1", "false1", "gone1"]) await ctx.push(channel, "exec.approval.requested", approval(id, S1));
    outcome.ok1 = "ok";
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "ok1", decision: "allow-once"})).ok, true);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "ok1", decision: "allow-once"})), "invalid_params");
    outcome.false1 = "false";
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "false1", decision: "deny"})).ok, false);
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "false1", decision: "deny"})).ok, false);
    outcome.gone1 = "resolved-then-false";
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "gone1", decision: "deny"})).ok, false);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "gone1", decision: "deny"})), "invalid_params");
    assert.deepEqual(ctx.requests(channel, "exec.approval.resolve").map((frame) => frame.params.id), ["ok1", "false1", "false1", "gone1"]);
  });
});

test("LF-13 an approval answer with a decision outside the request's allowed decisions, an expired request, or a key beyond id and decision is refused", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    await ctx.push(channel, "exec.approval.requested", approval("a1", S1, {request: {allowedDecisions: ["allow-once", "deny"]}}));
    await ctx.push(channel, "exec.approval.requested", approval("soon", S1, {top: {expiresAtMs: Date.now() + 300}}));
    await ctx.push(channel, "exec.approval.requested", approval("req-exp", S1, {top: {expiresAtMs: Date.now() + 600_000}, request: {expiresAtMs: Date.now() + 300}}));
    const refused = async (params) => assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", params)), "invalid_params", JSON.stringify(params));
    await refused({id: "a1", decision: "allow-always"});
    await refused({id: "a1", decision: "maybe"});
    await refused({id: "a1", decision: "deny", note: "x"});
    await refused({id: "a1"});
    await refused({id: "a1", decision: 1});
    await refused({decision: "deny"});
    await new Promise((resolve) => setTimeout(resolve, 400));
    await refused({id: "soon", decision: "deny"});
    await refused({id: "req-exp", decision: "deny"});
    assert.equal(ctx.requests(channel, "exec.approval.resolve").length, 0);
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "a1", decision: "deny"})).ok, true);
  });
});

test("LF-14 the approval list answer is a bare array of the channel's own rows, reduced, and those rows become pending", async () => {
  await withLink({}, async (ctx) => {
    const own = approval("l1", S1, {top: {extra: "x"}});
    const nested = approval("l2", "agent:main:z", {request: {parentSessionKey: `${S1}:child`}});
    const foreign = approval("l3", S2);
    ctx.handlers["exec.approval.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: [own, foreign, {id: "bad"}, "row", nested]});
    ctx.handlers["plugin.approval.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: {requests: [approval("pl1", S1)]}});
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    const list = await ctx.call(channel.channelId, "exec.approval.list", {sessionKey: S2, all: true});
    assert.deepEqual(list, {type: "res", id: list.id, ok: true, payload: [reduced(own), reduced(nested)]});
    assert.deepEqual(ctx.requests(channel, "exec.approval.list").map((frame) => frame.params), [{}]);
    const plugin = await ctx.call(channel.channelId, "plugin.approval.list", undefined);
    assert.deepEqual(plugin.payload.map((row) => row.id), ["pl1"]);
    // The rows are pending now; a foreign row is not.
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "l1", decision: "deny"})).ok, true);
    assert.equal((await ctx.call(channel.channelId, "plugin.approval.resolve", {id: "pl1", decision: "allow-once"})).ok, true);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "l3", decision: "deny"})), "invalid_params");
  });
});

test("LF-14b entries are forgotten on their resolved event, on expiry and on channel close; a list replay does not re-arm a pending or answered id and leaves out rows beyond the 32 entries; a full channel forwards no further request", async () => {
  await withLink({}, async (ctx) => {
    let rows = [];
    ctx.handlers["exec.approval.list"] = (frame) => ({type: "res", id: frame.id, ok: true, payload: rows});
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    // Resolved event: forgotten.
    await ctx.push(channel, "exec.approval.requested", approval("r1", S1));
    await ctx.push(channel, "exec.approval.resolved", {id: "r1", decision: "deny"});
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "r1", decision: "deny"})), "invalid_params");
    // Expiry: forgotten, so its resolved event is no longer forwarded either.
    await ctx.push(channel, "exec.approval.requested", approval("e1", S1, {top: {expiresAtMs: Date.now() + 200}}));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.push(channel, "exec.approval.resolved", {id: "e1", decision: "deny"});
    assert.deepEqual(ctx.events(channel.channelId, "exec.approval.resolved").map((value) => value.payload.id), ["r1"]);
    // Answered id: a replay leaves it out and does not re-arm it.
    await ctx.push(channel, "exec.approval.requested", approval("ans", S1));
    await ctx.push(channel, "exec.approval.requested", approval("pen", S1, {request: {allowedDecisions: ["deny"]}}));
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "ans", decision: "deny"})).ok, true);
    rows = [approval("ans", S1), approval("pen", S1)];
    assert.deepEqual((await ctx.call(channel.channelId, "exec.approval.list", {})).payload.map((row) => row.id), ["pen"]);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "ans", decision: "deny"})), "invalid_params");
    // A pending id keeps its entry unchanged (its own allowed decisions).
    assert.equal(refusedCode(await ctx.call(channel.channelId, "exec.approval.resolve", {id: "pen", decision: "allow-once"})), "invalid_params");
    // Fill up to 32 entries (ans and pen hold two): the 33rd is not forwarded.
    for (let index = 0; index < 31; index += 1) await ctx.push(channel, "exec.approval.requested", approval(`f${index}`, S1));
    assert.equal(ctx.events(channel.channelId, "exec.approval.requested").at(-1).payload.id, "f29");
    assert.equal(ctx.events(channel.channelId, "exec.approval.requested").some((value) => value.payload.id === "f30"), false);
    rows = [approval("pen", S1), approval("new1", S1)];
    assert.deepEqual((await ctx.call(channel.channelId, "exec.approval.list", {})).payload.map((row) => row.id), ["pen"]);
    // Channel close: a new channel serving the same session has no entry.
    ctx.device.send({version: 1, type: "openclaw-close", channelId: channel.channelId});
    await waitFor(() => ctx.instance.snapshot().channels === 0, {label: "closed"});
    const next = await ctx.open();
    await ctx.serve(next, S1);
    assert.equal(refusedCode(await ctx.call(next.channelId, "exec.approval.resolve", {id: "pen", decision: "deny"})), "invalid_params");
    await ctx.push(next, "exec.approval.requested", approval("after", S1));
    assert.deepEqual(ctx.events(next.channelId, "exec.approval.requested").map((value) => value.payload.id), ["after"]);
  });
});

test("LF-15 a resolved event is forwarded only for a pending or answered id and ends its entry", async () => {
  await withLink({}, async (ctx) => {
    const channel = await ctx.open();
    await ctx.serve(channel, S1);
    await ctx.push(channel, "exec.approval.resolved", {id: "unknown", decision: "deny"});
    await ctx.push(channel, "plugin.approval.requested", approval("p1", S1));
    await ctx.push(channel, "exec.approval.requested", approval("a1", S1));
    assert.equal((await ctx.call(channel.channelId, "exec.approval.resolve", {id: "a1", decision: "allow-once"})).ok, true);
    // Other kind for p1: not its entry.
    await ctx.push(channel, "exec.approval.resolved", {id: "p1", decision: "deny"});
    await ctx.push(channel, "plugin.approval.resolved", {id: "p1", decision: "deny", resolvedBy: "someone", ts: 1}, 9);
    await ctx.push(channel, "exec.approval.resolved", {id: "a1", decision: "allow-once"});
    await ctx.push(channel, "exec.approval.resolved", {id: "a1", decision: "allow-once"});
    const resolved = ctx.events(channel.channelId).filter((value) => value.event.endsWith(".resolved"));
    assert.deepEqual(resolved, [
      {type: "event", event: "plugin.approval.resolved", payload: {id: "p1", decision: "deny"}, seq: 9},
      {type: "event", event: "exec.approval.resolved", payload: {id: "a1", decision: "allow-once"}},
    ]);
    assert.equal(refusedCode(await ctx.call(channel.channelId, "plugin.approval.resolve", {id: "p1", decision: "deny"})), "invalid_params");
  });
});

test("LF-16 with attachments chat.send keeps valid attachments and refuses an invalid type, mime type, file name, base64, more than 10 files or more than 716800 decoded bytes with invalid_params", async () => {
  await withLink({limits: {maxDataBytes: 2_000_000}}, async (ctx) => {
    const channel = await ctx.open();
    const png = {type: "image", mimeType: "image/png", fileName: "photo.png", content: Buffer.from("png-bytes").toString("base64")};
    const file = {type: "file", mimeType: "application/pdf", fileName: "Report 2026.pdf", content: Buffer.from("pdf").toString("base64")};
    const send = (attachments) => ctx.call(channel.channelId, "chat.send", {sessionKey: S1, message: "m", idempotencyKey: nextId("k"), attachments});
    assert.equal((await send([png, file])).ok, true);
    assert.deepEqual(ctx.requests(channel, "chat.send")[0].params.attachments, [png, file]);
    const big = (bytes) => ({...file, content: Buffer.alloc(bytes, 1).toString("base64")});
    assert.equal((await send([big(716800 - 3), {...file, content: "YWJj"}])).ok, true);
    const invalid = [
      [{...png, type: "video"}],
      [{...png, mimeType: "image/svg+xml"}],
      [{...file, mimeType: "text plain"}],
      [{...file, mimeType: `${"a".repeat(120)}/${"b".repeat(10)}`}],
      [{...file, fileName: ""}],
      [{...file, fileName: "../etc/passwd"}],
      [{...file, fileName: "a\\b"}],
      [{...file, fileName: "a\nb"}],
      [{...file, fileName: "x".repeat(257)}],
      [{...file, content: "YWJ"}],
      [{...file, content: "YQ"}],
      [{...file, content: "YR=="}],
      [{...file, content: "Y Q=="}],
      [{...file, url: "file:///etc/passwd"}],
      [{type: "file", mimeType: "text/plain", fileName: "a.txt"}],
      [{...file, path: "/etc/passwd", content: undefined}],
      Array.from({length: 11}, () => file),
      [big(716801)],
      [big(400000), big(400000)],
      "not-an-array",
      [null],
    ];
    for (const attachments of invalid) assert.equal(refusedCode(await send(attachments)), "invalid_params", JSON.stringify(attachments).slice(0, 80));
    assert.equal(ctx.requests(channel, "chat.send").length, 2);
    assert.equal(ctx.requests(channel, "chat.send")[1].params.attachments.length, 2);
  });
});

test("the Link features conformance names and lists are the shared ones, and every OpenClaw case has exactly one test", async () => {
  const features = conformance.parityL1oLinkFeatures;
  assert.equal(features.capability, "openclawLinkFeatures");
  assert.deepEqual(features.methods, {create: ["sessions.create"], archive: ["sessions.patch"], attachments: ["chat.send"],
    approvals: ["exec.approval.list", "plugin.approval.list", "exec.approval.resolve", "plugin.approval.resolve"]});
  assert.deepEqual(link.LINK_FEATURE_METHODS, features.methods);
  assert.deepEqual(link.LINK_FEATURE_EVENTS, features.events);
  const source = await readFile(new URL(import.meta.url), "utf8");
  // Keyed by the shared case name, as in Hermes' conformance.json.
  const cases = Object.entries(conformance.parityL1oFeatureCases);
  assert.deepEqual(cases.map(([name]) => name.slice(0, name.indexOf(" "))), ["LF-01", "LF-02", "LF-03", "LF-04", "LF-05", "LF-06", "LF-07", "LF-07b",
    "LF-08", "LF-08b", "LF-09", "LF-10", "LF-11", "LF-12", "LF-13", "LF-14", "LF-14b", "LF-15", "LF-16", "LF-17"]);
  for (const [name, status] of cases) {
    const count = source.split(`test(${JSON.stringify(name)},`).length - 1;
    assert.equal(status, name.startsWith("LF-17 ") ? "hermes-only" : "implemented", name);
    assert.equal(count, status === "implemented" ? 1 : 0, name);
  }
});
