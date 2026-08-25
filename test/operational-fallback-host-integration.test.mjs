import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";

const fallback = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
const pinnedOpenClawVersion = "2026.7.1-2";
const require = createRequire(import.meta.url);

function pinnedHostRoot() {
  return dirname(dirname(require.resolve("openclaw")));
}

async function assertPinnedHostVersion(root) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.version, pinnedOpenClawVersion);
}

async function loadPinnedHost() {
  const root = pinnedHostRoot();
  await assertPinnedHostVersion(root);
  const home = await mkdtemp(join(tmpdir(), "openclaw-room-host-fallback-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const cleanup = async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, {recursive: true, force: true});
  };
  try {
    const [{createRoomChannel}, {runChannelInboundEvent}] = await Promise.all([
      import("../src/channel.js"),
      import("openclaw/plugin-sdk/channel-inbound"),
    ]);
    return {createRoomChannel, runChannelInboundEvent, home, root, cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function buildPinnedHostFailurePayload() {
  const root = pinnedHostRoot();
  await assertPinnedHostVersion(root);
  const dist = join(root, "dist");
  const candidates = [];
  for (const name of await readdir(dist)) {
    if (!name.startsWith("agent-runner.runtime-") || !name.endsWith(".js")) continue;
    const source = await readFile(join(dist, name), "utf8");
    if (source.includes("function buildTerminalAgentRunFailureReplyPayload(params)")) {
      candidates.push({name, source});
    }
  }
  assert.equal(candidates.length, 1, "pinned host must expose exactly one terminal failure-payload constructor");
  const instrumentedPath = join(dist, `.room-failure-payload-${process.pid}-${Date.now()}.mjs`);
  await writeFile(
    instrumentedPath,
    `${candidates[0].source}\nexport { buildTerminalAgentRunFailureReplyPayload as __buildTerminalAgentRunFailureReplyPayload };\n`,
    {flag: "wx"},
  );
  try {
    const host = await import(`${instrumentedPath}?integration=${Date.now()}`);
    return host.__buildTerminalAgentRunFailureReplyPayload({isHeartbeat: false, sessionCtx: {}, cfg: {}});
  } finally {
    await rm(instrumentedPath, {force: true});
  }
}

function context(account, channelRuntime) {
  let status = {running: false, connected: false};
  return {
    account,
    accountId: account.accountId,
    abortSignal: new AbortController().signal,
    cfg: {},
    channelRuntime,
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: () => {}, error: () => {}},
  };
}

async function runPinnedHostCase(payload) {
  const loaded = await loadPinnedHost();
  const {createRoomChannel, runChannelInboundEvent, home, cleanup} = loaded;
  try {
    const calls = {post: 0, pass: 0, skipped: [], ack: []};
    const event = {
      id: "event-host", sourceEventId: "event-host", respondsToId: "event-host",
      roomId: "room-1", epochId: "epoch-1", conversationId: "room-1:epoch:host",
      senderId: "human-1", senderName: "Owner", senderKind: "human",
      text: "question", occurredAt: 1, raw: {},
      cycleAttempt: {cycle: {id: "cycle-1", generation: 3}, attempt: {id: "attempt-1"}},
    };
    const client = {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* () { yield event; },
      markTurnReading: async () => {},
      postAndFinish: async ({text}) => {
        calls.post += 1;
        assert.equal(text, fallback);
        return {eventId: "posted-host", sentAt: 1};
      },
      passDiscussionAttempt: async () => { calls.pass += 1; },
      recordSkipped: async (eventId, reason) => calls.skipped.push([eventId, reason]),
      ack: async (eventId) => calls.ack.push(eventId),
      close: async () => {},
    };
    const channelRuntime = {
      inbound: {run: runChannelInboundEvent},
      routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
      session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async ({dispatcherOptions}) => {
          await dispatcherOptions.deliver(payload, {kind: "final"});
          return {queuedFinal: true};
        },
      },
    };
    const channel = createRoomChannel({makeClient: () => client});
    const ctx = context({accountId: "default", stateFile: join(home, "state.json")}, channelRuntime);
    await channel.channelPlugin.gateway.startAccount(ctx);
    return calls;
  } finally {
    await cleanup();
  }
}

test("pinned host constructs an error-marked reserved operational fallback", async () => {
  const payload = await buildPinnedHostFailurePayload();
  assert.equal(payload.text, fallback);
  assert.equal(payload.isError, true);
  const calls = await runPinnedHostCase(payload);
  assert.deepEqual(calls, {
    post: 0,
    pass: 1,
    skipped: [["event-host", "gateway_operational_error"]],
    ack: ["event-host"],
  });
});

test("pinned host posts identical non-error model text", async () => {
  const calls = await runPinnedHostCase({text: fallback, isError: false});
  assert.deepEqual(calls, {
    post: 1,
    pass: 0,
    skipped: [],
    ack: ["event-host"],
  });
});
