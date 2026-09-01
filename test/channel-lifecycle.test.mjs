import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {mkdtemp, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(join(tmpdir(), "openclaw-room-channel-home-"));
process.env.HOME = home;
const {createRoomChannel, isOpenClawOperationalFallback} = await import("../src/channel.js");
const ID = "synthetic-sociality-room";

function config(defaultState, accounts) {
  return {
    channels: {
      [ID]: {
        enabled: true,
        baseUrl: "https://room.example/api",
        stateFile: defaultState,
        accounts: Object.fromEntries(Object.entries(accounts).map(([accountId, stateFile]) => [accountId, {
          enabled: true,
          baseUrl: "https://room.example/api",
          stateFile,
        }])),
      },
    },
  };
}

function context(account, controller = new AbortController()) {
  let status = {running: false, connected: false};
  const warnings = [];
  return {
    account,
    accountId: account.accountId,
    abortSignal: controller.signal,
    cfg: {},
    channelRuntime: {},
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: (message) => warnings.push(message)},
    controller,
    status: () => status,
    warnings,
  };
}

test("generic OpenClaw operational fallback passes without canonical Room post", async () => {
  const fallback = "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.";
  const calls = {post: 0, pass: 0, skipped: [], ack: []};
  const event = {
    id: "event-error", sourceEventId: "event-error", respondsToId: "event-error",
    roomId: "room-1", epochId: "epoch-1", conversationId: "room-1:epoch:error",
    senderId: "human-1", senderName: "Owner", senderKind: "human",
    text: "question", occurredAt: 1, raw: {},
    cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}},
  };
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { yield event; },
    markTurnReading: async () => {},
    postAndFinish: async () => { calls.post += 1; return {eventId: "posted-error", sentAt: 1}; },
    passDiscussionAttempt: async (attempt) => {
      calls.pass += 1;
      assert.equal(attempt, event.cycleAttempt);
    },
    recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
    ack: async (eventId) => calls.ack.push(eventId),
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  const ctx = context({accountId: "default", stateFile: join(home, "operational-fallback.json")});
  ctx.channelRuntime = {
    inbound: {run: async ({raw, adapter}) => {
      const turn = adapter.resolveTurn(adapter.ingest(raw));
      const first = await turn.delivery.deliver({text: fallback, isError: true});
      const replay = await turn.delivery.deliver({text: fallback, isError: true});
      assert.equal(first.visibleReplySent, false);
      assert.equal(replay.visibleReplySent, false);
    }},
    routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
    session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
    reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
  };

  await channel.plugin.gateway.startAccount(ctx);

  assert.deepEqual(calls, {
    post: 0,
    pass: 1,
    skipped: [["event-error", "gateway_operational_error"]],
    ack: ["event-error"],
  });
});

test("operational fallback classification is exact and requires trusted error metadata", () => {
  const generic = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
  assert.equal(isOpenClawOperationalFallback({text: generic, isError: true}), true);
  assert.equal(isOpenClawOperationalFallback({text: generic, isError: false}), false);
  assert.equal(isOpenClawOperationalFallback({text: `${generic} `, isError: true}), false);
});

test("model-authored fallback text remains a canonical Room contribution", async () => {
  const fallback = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
  const calls = {post: 0, pass: 0, skipped: [], ack: []};
  const event = {
    id: "event-visible", sourceEventId: "event-visible", respondsToId: "event-visible",
    roomId: "room-1", epochId: "epoch-1", conversationId: "room-1:epoch:visible",
    senderId: "human-1", senderName: "Owner", senderKind: "human",
    text: "quote the fallback", occurredAt: 1, raw: {},
    cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}},
  };
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { yield event; },
    markTurnReading: async () => {},
    postAndFinish: async ({text}) => {
      calls.post += 1;
      assert.equal(text, fallback);
      return {eventId: "posted-visible", sentAt: 1};
    },
    passDiscussionAttempt: async () => { calls.pass += 1; },
    recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
    ack: async (eventId) => calls.ack.push(eventId),
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  const ctx = context({accountId: "default", stateFile: join(home, "model-authored-fallback.json")});
  ctx.channelRuntime = {
    inbound: {run: async ({raw, adapter}) => {
      const turn = adapter.resolveTurn(adapter.ingest(raw));
      const result = await turn.delivery.deliver({text: fallback, isError: false});
      assert.equal(result.visibleReplySent, true);
      assert.deepEqual(result.messageIds, ["posted-visible"]);
    }},
    routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
    session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
    reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
  };

  await channel.plugin.gateway.startAccount(ctx);

  assert.deepEqual(calls, {
    post: 1,
    pass: 0,
    skipped: [],
    ack: ["event-visible"],
  });
});

test("real channel discovery maps Zurie 3-to-2 and Aura 3-to-3", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-channel-topology-"));
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias);
  const shared = join(real, "shared.json");
  const second = join(real, "second.json");
  const third = join(real, "third.json");
  await Promise.all([shared, second, third].map((path) => writeFile(path, "{}", {mode: 0o600})));
  const channel = createRoomChannel({makeClient: () => ({})});

  const zurie = config(shared, {alias: join(alias, "shared.json"), staging: second});
  assert.deepEqual(channel.plugin.config.listAccountIds(zurie), ["default", "staging"]);

  const aura = config(shared, {production: second, staging: third});
  assert.deepEqual(channel.plugin.config.listAccountIds(aura), ["default", "production", "staging"]);
});

test("gateway rejects overlapping account ownership before creating a second client", async () => {
  let created = 0;
  let closed = 0;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const channel = createRoomChannel({makeClient: () => {
    created += 1;
    return {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* () { await gate; },
      close: async () => { closed += 1; releaseFirst(); },
    };
  }});
  const first = context({accountId: "default", stateFile: join(home, "first.json")});
  const second = context({accountId: "default", stateFile: join(home, "second.json")});
  const running = channel.plugin.gateway.startAccount(first);
  await eventually(() => first.status().connected === true);
  await assert.rejects(() => channel.plugin.gateway.startAccount(second), /account is already claimed/);
  assert.equal(created, 1);
  try {
    const stopContext = context(first.account, first.controller);
    await channel.plugin.gateway.stopAccount(stopContext);
    assert.ok(closed >= 1);
  } finally {
    releaseFirst();
  }
  await running;
  assert.equal(first.status().running, false);
});

test("gateway finalizes ownership and status even when client close rejects", async () => {
  const channel = createRoomChannel({makeClient: () => ({
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () {},
    close: async () => { throw new Error("private close detail"); },
  })});
  const ctx = context({accountId: "default", stateFile: join(home, "close-error.json")});
  await channel.plugin.gateway.startAccount(ctx);
  assert.equal(ctx.status().running, false);
  assert.equal(ctx.status().connected, false);
  assert.deepEqual(ctx.warnings, ["[default] Room client close failed"]);

  const replacement = context({accountId: "default", stateFile: join(home, "replacement.json")});
  await assert.doesNotReject(() => channel.plugin.gateway.startAccount(replacement));
});

test("routes each Room epoch to a fresh transcript while preserving the outbound Room target and real peer binding", async (t) => {
  let resolveAgentRoute;
  try {
    ({resolveAgentRoute} = await import("openclaw/plugin-sdk/routing"));
  } catch {
    t.skip("exact OpenClaw peer dependency is unavailable");
    return;
  }
  const captured = [];
  const routeInputs = [];
  const events = [
    {id: "event-1", sourceEventId: "event-1", respondsToId: "event-1", roomId: "room-1", epochId: "epoch-1", conversationId: "room-1:epoch:epoch-1", senderId: "human-1", senderName: "Owner", senderKind: "human", text: "first", occurredAt: 1, raw: {}},
    {id: "event-2", sourceEventId: "event-2", respondsToId: "event-2", roomId: "room-1", epochId: "epoch-2", conversationId: "room-1:epoch:epoch-2", senderId: "human-1", senderName: "Owner", senderKind: "human", text: "second", occurredAt: 2, raw: {}},
  ];
  const channel = createRoomChannel({makeClient: () => ({
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { for (const event of events) yield event; },
    markTurnReading: async () => {},
    recordSkipped: async () => {},
    ack: async () => {},
    close: async () => {},
  })});
  const ctx = context({accountId: "default", stateFile: join(home, "epoch-routing.json")});
  ctx.cfg = {
    agents: {list: [{id: "main", default: true}, {id: "special"}]},
    bindings: [{
      agentId: "special",
      match: {channel: ID, accountId: "default", peer: {kind: "group", id: "room-1"}},
    }],
  };
  const rawRoute = resolveAgentRoute({
    cfg: ctx.cfg, channel: ID, accountId: "default", peer: {kind: "group", id: "room-1"},
  });
  ctx.channelRuntime = {
    inbound: {run: async ({raw, adapter}) => {
      const input = adapter.ingest(raw);
      captured.push(adapter.resolveTurn(input));
    }},
    routing: {resolveAgentRoute: (input) => {
      routeInputs.push(input);
      return resolveAgentRoute(input);
    }},
    session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
    reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
  };

  await channel.plugin.gateway.startAccount(ctx);

  assert.equal(captured.length, 2);
  assert.equal(captured[0].agentId, "special");
  assert.equal(captured[0].agentId, rawRoute.agentId);
  assert.equal(captured[0].accountId, rawRoute.accountId);
  assert.equal(captured[0].ctxPayload.route.mainSessionKey, rawRoute.mainSessionKey);
  assert.match(captured[0].routeSessionKey, /room-1:epoch:epoch-1$/);
  assert.match(captured[1].routeSessionKey, /room-1:epoch:epoch-2$/);
  assert.notEqual(captured[0].routeSessionKey, captured[1].routeSessionKey);
  assert.equal(captured[0].ctxPayload.reply.to, "room-1");
  assert.equal(captured[1].ctxPayload.reply.deliveryTarget, "room-1");
  assert.deepEqual(routeInputs.map((input) => input.parentPeer), [
    {kind: "group", id: "room-1"},
    {kind: "group", id: "room-1"},
  ]);
  assert.equal(captured[0].agentId, captured[1].agentId);
  assert.equal(captured[0].accountId, captured[1].accountId);
});

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
