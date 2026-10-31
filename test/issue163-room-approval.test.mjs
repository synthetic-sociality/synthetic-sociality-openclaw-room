// ISSUE-163, OpenClaw translation: a command that needs private approval in a Room
// session ends denied within seconds. Nobody can answer in a Room, so the connector
// answers by the approval id of the tool result. The prompt is never posted and the
// command is never approved.
//
// OpenClaw's path is not Hermes's. Exec answers "approval pending" at once and the
// host keeps the request open for 30 minutes in the background, while it drops the
// model's text in that run. On 0.2.74 the turn therefore ended without a reply, and
// the host's follow-up reached the Room when the request expired; under
// askFallback=full the command ran then, approved by nobody.
//
// The first tests use the SDK double; the last run a real gateway with the real exec
// tool (test/support/host-approval-turn.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {readFileSync} from "node:fs";
import {createRequire, registerHooks} from "node:module";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {ISOLATED_HOST_CONFIG} from "./support/isolated-host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/approval-gateway-runtime": "export const resolveApprovalOverGateway = (params) => globalThis.room163Resolve(params);",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

process.env.HOME = await mkdtemp(join(tmpdir(), "openclaw-room-163-home-"));
const {createRoomChannel, roomApprovalDeny} = await import("../src/channel.js");

const APPROVAL_ID = "11111111-2222-4333-8444-555555555555";
const ROOM_SESSION = "agent:main:synthetic-sociality-room:group:room-1:epoch:epoch-1";
const pendingResult = {content: [{type: "text", text: "Approval required"}], details: {status: "approval-pending", approvalId: APPROVAL_ID, approvalSlug: "11111111", command: "touch /secret/path"}};

function resolver(behaviour = async () => {}) {
  const seen = [];
  globalThis.room163Resolve = (params) => { seen.push(params); return behaviour(params); };
  return seen;
}
function hookApi() {
  const logs = {info: [], warn: []};
  const config = {gateway: {mode: "local"}};
  return {logs, config, api: {
    config: {stale: true},
    runtime: {config: {current: () => config}},
    logger: {info: (message) => logs.info.push(message), warn: (message) => logs.warn.push(message)},
  }};
}

test("a pending approval in a Room session is denied by its id, and only denied", async () => {
  const seen = resolver();
  const {api, config, logs} = hookApi();
  await roomApprovalDeny(api)({toolName: "exec", result: pendingResult}, {sessionKey: ROOM_SESSION});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].approvalId, APPROVAL_ID);
  assert.equal(seen[0].decision, "deny");
  assert.equal(seen[0].cfg, config);
  assert.deepEqual(logs.info, ["Room private approval denied"]);
});

test("a deny that fails stays private and throws nothing into the host", async () => {
  const seen = resolver(async () => { throw new Error("gateway closed touch /secret/path"); });
  const {api, logs} = hookApi();
  await roomApprovalDeny(api)({toolName: "exec", result: pendingResult}, {sessionKey: ROOM_SESSION});
  assert.deepEqual(seen.map((params) => params.decision), ["deny"]);
  assert.equal(logs.warn.length, 1);
  assert.doesNotMatch(logs.warn[0], /secret/);
});

test("other sessions and other results deny nothing", async () => {
  const seen = resolver();
  const {api} = hookApi();
  const hook = roomApprovalDeny(api);
  await hook({toolName: "exec", result: pendingResult}, {sessionKey: "agent:main:telegram:direct:owner"});
  await hook({toolName: "exec", result: pendingResult}, {});
  await hook({toolName: "exec", result: {details: {status: "completed", exitCode: 0}}}, {sessionKey: ROOM_SESSION});
  await hook({toolName: "exec", result: {details: {status: "approval-unavailable", reason: "no-approval-route"}}}, {sessionKey: ROOM_SESSION});
  await hook({toolName: "exec"}, {sessionKey: ROOM_SESSION});
  assert.deepEqual(seen, []);
});

async function runTurn(steps) {
  const calls = {post: [], settled: [], skipped: [], ack: [], results: []};
  const event = {
    id: "evt-1", sourceEventId: "evt-1", respondsToId: "evt-1", roomId: "room-1", epochId: "epoch-1",
    conversationId: "room-1:epoch:1", senderId: "human-1", senderName: "Owner", senderKind: "human",
    text: "Run it.", occurredAt: 1, raw: {seq: 1},
    cycleAttempt: {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1"}},
  };
  const client = {
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () { yield event; },
    markTurnReading: async () => {},
    postAndFinish: async (request) => { calls.post.push(request.text); return {eventId: "posted-1", sentAt: 1}; },
    settleDiscussionAttempt: async (_attempt, action) => { calls.settled.push(action); },
    recordSkipped: async (id, reason) => { calls.skipped.push([id, reason]); },
    ack: async (id) => { calls.ack.push(id); },
    close: async () => {},
  };
  const channel = createRoomChannel({makeClient: () => client});
  let status = {};
  await channel.plugin.gateway.startAccount({
    account: {accountId: "default", stateFile: join(process.env.HOME, "state.json")},
    accountId: "default",
    abortSignal: new AbortController().signal,
    cfg: ISOLATED_HOST_CONFIG,
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: () => {}, error: () => {}},
    channelRuntime: {
      inbound: {run: async ({raw, adapter}) => {
        const turn = adapter.resolveTurn(adapter.ingest(raw));
        for (const [payload, info] of steps) calls.results.push(await turn.delivery.deliver(payload, info));
      }},
      routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "session", mainSessionKey: "main"})},
      session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
      reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
    },
  });
  return calls;
}

test("the host's approval prompt is not posted, in any delivery kind, and the turn says why", async () => {
  const prompt = {
    text: "Approval required.\n\nRun:\n\n```txt\n/approve 11111111 allow-once\n```",
    channelData: {execApproval: {approvalId: APPROVAL_ID, approvalSlug: "11111111", approvalKind: "exec"}},
  };
  for (const kind of ["tool", "final"]) {
    const calls = await runTurn([[prompt, {kind}]]);
    assert.deepEqual(calls.results, [{visibleReplySent: false}]);
    assert.deepEqual(calls.post, []);
    // The host dropped the model's text: this is not a model that chose silence.
    assert.deepEqual(calls.skipped, [["evt-1", "approval_required"]]);
    assert.deepEqual(calls.settled, ["pass"]);
    assert.deepEqual(calls.ack, ["evt-1"]);
  }
});

test("only the host's metadata marks a prompt: the same words from the model are posted", async () => {
  const text = "Approval required: reply /approve abc allow-once or /deny.";
  const calls = await runTurn([[{text}, {kind: "final"}]]);
  assert.deepEqual(calls.post, [text]);
  assert.deepEqual(calls.skipped, []);
});

function installedHost() {
  const pinned = packageJson.peerDependencies.openclaw;
  const candidates = [process.env.OPENCLAW_HOST_ROOT];
  try { candidates.push(dirname(createRequire(join(root, "package.json")).resolve("openclaw/package.json"))); } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version === pinned) return candidate;
    } catch {}
  }
  return null;
}

async function realTurn(caseName) {
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-approval-turn.mjs"), installedHost(), root, caseName], {
    timeout: 120_000, maxBuffer: 1 << 20,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

function assertDeniedAtOnce(report, denials = 1) {
  const detail = JSON.stringify(report);
  // The host's own result reached the model: "approval pending", not a double.
  assert.ok(report.modelRequests.some((item) => item.toolResult?.startsWith("Approval required")), detail);
  assert.equal(report.commandRan, false, detail);
  assert.equal(report.denials, denials, detail);
  const followUp = report.modelRequests.find((item) => item.followUp);
  assert.ok(followUp, `no follow-up after the private deny: ${detail}`);
  assert.match(followUp.followUpText, /Exec denied \(gateway id=[0-9a-f-]+, user-denied\)/, detail);
  assert.ok(followUp.second < 10, `denied after ${followUp.second} s: ${detail}`);
  // Only the model's own reply reaches the Room: no control text.
  assert.deepEqual([...new Set(report.posts.map((post) => post.text))], ["FOLLOW-UP REPLY"], detail);
  assert.deepEqual(report.turn.map((item) => [item.kind, item.action ?? item.reason ?? ""]),
    [["settle", "pass"], ["skipped", "approval_required"], ["ack", ""]], detail);
  assert.ok(report.turn.at(-1).second < 10, detail);
}

const hostTest = (name, run) => test(`real gateway: ${name}`, async (t) => {
  if (!installedHost()) return t.skip(`OpenClaw ${packageJson.peerDependencies.openclaw} is not installed`);
  await run();
});

hostTest("a command needing approval in a Room turn ends denied within seconds", async () => {
  assertDeniedAtOnce(await realTurn("ask-always"));
});

hostTest("a second guarded command in the host's follow-up run ends denied too", async () => {
  assertDeniedAtOnce(await realTurn("follow-up-reruns"), 2);
});

hostTest("askFallback=full never runs it, past the host's approval expiry", async () => {
  assertDeniedAtOnce(await realTurn("fallback-full-expiry"));
});
