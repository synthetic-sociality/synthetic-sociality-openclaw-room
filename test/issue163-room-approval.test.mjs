// ISSUE-163, OpenClaw translation: a command that needs private approval in a Room
// session is refused at once with an ordinary tool error, so the model's reply stays
// in its turn. No request opens, so no prompt, no follow-up run and nothing to run
// later. Where the owner configured a private target the request stays open, because
// a person can answer there. Approval text never reaches a Room.
//
// The first tests use doubles; the rest run a real gateway with the real exec tool
// (test/support/host-approval-turn.mjs), which needs OPENCLAW_HOST_ROOT: without the
// pinned host they fail, they do not skip.
import assert from "node:assert/strict";
import {describe, test} from "node:test";
import {execFile} from "node:child_process";
import {readFileSync} from "node:fs";
import {registerHooks} from "node:module";
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
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

process.env.HOME = await mkdtemp(join(tmpdir(), "openclaw-room-163-home-"));
const {createRoomChannel} = await import("../src/channel.js");
const {isPrivateApprovalText, roomExecApprovalPolicy, ROOM_EXEC_REFUSAL} = await import("../src/exec-approval-policy.js");

test("the approval text rule is the same as Hermes's, plus this host's own sentences", () => {
  // tests/test_issue163_room_auto_deny.py and the Hermes review's probe.
  for (const text of [
    "⚠️ Dangerous command requires approval. Reply /approve or /deny.",
    "If approval is required, I cannot run it here.",
    "Hermes flagged a dangerous command; I stopped.",
    "Approval required (id 641e170b, full 641e170b-f3d7).",
    "reply `/approve abc allow-once`",
    "🔒 Exec approval required\nID: 641e170b",
    "Command did not run: approval timed out.",
    "Command did not run: approval was denied.",
    "Command did not run: approval is required.",
    "Command did not run: approval request failed.",
    "Command did not run.",
    "I tried. Exec denied (gateway id=641e170b, user-denied): touch /tmp/x",
  ]) assert.equal(isPrivateApprovalText(text), true, text);
  for (const text of [
    "The command was blocked, so I answer from memory.",
    "This command needs approval, which I cannot get here.",
    "The approval of the budget was denied.",
    "",
  ]) assert.equal(isPrivateApprovalText(text), false, text);
});

async function runTurn(steps) {
  const calls = {post: [], settled: [], skipped: [], ack: [], results: [], warn: [], sent: []};
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
    log: {info: () => {}, warn: (message) => calls.warn.push(message), error: () => {}},
    channelRuntime: {
      inbound: {run: async ({raw, adapter}) => {
        const turn = adapter.resolveTurn(adapter.ingest(raw));
        for (const [payload, info] of steps) calls.results.push(await turn.delivery.deliver(payload, info));
        // While the account runs: what an outbound send of the host does.
        for (const text of (steps.outbound ?? [])) calls.sent.push(await channel.plugin.message.send.text({accountId: "default", to: "room-1", text, deliveryQueueId: "q1"}));
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
    channelData: {execApproval: {approvalId: "11111111-2222", approvalSlug: "11111111", approvalKind: "exec"}},
  };
  for (const kind of ["tool", "final"]) {
    const calls = await runTurn([[prompt, {kind}]]);
    assert.deepEqual(calls.results, [{visibleReplySent: false}]);
    assert.deepEqual(calls.post, []);
    assert.deepEqual(calls.skipped, [["evt-1", "approval_required"]]);
    assert.deepEqual(calls.settled, ["pass"]);
    assert.deepEqual(calls.ack, ["evt-1"]);
  }
});

test("a reply with approval text is withheld, the turn closes, and a clean later payload is the reply", async () => {
  const withheld = await runTurn([[{text: "Approval required: reply /approve abc allow-once."}, {kind: "final"}]]);
  assert.deepEqual(withheld.post, []);
  assert.deepEqual(withheld.skipped, [["evt-1", "approval_text_withheld"]]);
  assert.deepEqual(withheld.settled, ["pass"]);
  assert.deepEqual(withheld.ack, ["evt-1"]);
  const clean = await runTurn([[{text: "If approval is required, I stop."}, {kind: "block"}], [{text: "I answer from memory."}, {kind: "final"}]]);
  assert.deepEqual(clean.post, ["I answer from memory."]);
  assert.deepEqual(clean.skipped, []);
});

test("an outbound send with approval text is counted as sent and never posted", async () => {
  const steps = [[{text: "A reply."}, {kind: "final"}]];
  steps.outbound = ["Command did not run: approval was denied.", "🔒 Exec approval required\nID: 1", "A plain message."];
  const calls = await runTurn(steps);
  assert.deepEqual(calls.post, ["A reply.", "A plain message."]);
  assert.equal(calls.sent[0].messageId, "approval_text_withheld");
  assert.equal(calls.sent[1].messageId, "approval_text_withheld");
  assert.deepEqual(calls.sent[0].receipt.platformMessageIds, ["approval_text_withheld"]);
  assert.equal(calls.warn.length, 2);
  assert.doesNotMatch(calls.warn.join("\n"), /did not run|approval required/i);
});

test("a policy that cannot be read refuses in a Room session: fail closed", async () => {
  const warned = [];
  const unreadable = new Proxy({}, {get() { throw new Error("moved in a host bump"); }});
  const hook = roomExecApprovalPolicy({runtime: {config: {current: () => unreadable}}, logger: {warn: (message) => warned.push(message)}});
  const ctx = {sessionKey: "agent:main:synthetic-sociality-room:group:room-1:epoch:e1", agentId: "main", runId: "r1"};
  assert.deepEqual(await hook({toolName: "exec", params: {command: "ls"}}, ctx), {block: true, blockReason: ROOM_EXEC_REFUSAL});
  assert.ok(warned.some((message) => message.includes("could not read the exec policy")), warned.join("\n"));
  // Other tools and other sessions never get that far.
  assert.equal(hook({toolName: "read", params: {}}, ctx), undefined);
  assert.equal(await hook({toolName: "exec", params: {command: "ls"}}, {sessionKey: "agent:main:telegram:direct:owner"}), undefined);
});

test("the host's approval forwarding never takes a Room as its target", () => {
  const {plugin} = createRoomChannel({makeClient: () => null});
  assert.equal(plugin.approvalCapability.delivery.shouldSuppressForwardingFallback({target: {channel: "synthetic-sociality-room", to: "room-1"}}), true);
  // Only the delivery adapter: no native route, and the turn's own surface state stays the host's.
  assert.deepEqual(Object.keys(plugin.approvalCapability), ["delivery"]);
});

const PINNED_HOST = packageJson.peerDependencies.openclaw;
function hostRoot() {
  const candidate = process.env.OPENCLAW_HOST_ROOT;
  assert.ok(candidate, `OPENCLAW_HOST_ROOT must name OpenClaw ${PINNED_HOST}: these tests prove the fix on the real host and do not skip`);
  assert.equal(JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version, PINNED_HOST);
  return candidate;
}

async function realTurn(caseName) {
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-approval-turn.mjs"), hostRoot(), root, caseName], {
    timeout: 120_000, maxBuffer: 1 << 20,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

const REFUSED = "Refused in this Room session";
function assertRefusedInTurn(report, {replySecondsBelow = 10} = {}) {
  const detail = JSON.stringify(report);
  assert.equal(report.commandRan, false, detail);
  assert.ok(report.refusals >= 1, detail);
  assert.ok(report.modelRequests.some((item) => item.toolResult?.includes(REFUSED)), detail);
  // No request opened: the model never saw its text and the host starts no follow-up.
  assert.ok(!report.modelRequests.some((item) => item.toolResult?.includes("Approval required")), detail);
  assert.equal(report.followUps, 0, detail);
  // One reply, the model's own, bound to its turn, not a literal outbound post.
  assert.deepEqual(report.posts.map(({text, literal, sourceEventId}) => ({text, literal, sourceEventId})),
    [{text: "REPLY AFTER THE TOOL RESULT", literal: false, sourceEventId: "evt-5"}], detail);
  assert.ok(report.posts[0].second < replySecondsBelow, detail);
  assert.deepEqual(report.turn.map((item) => item.kind), ["ack"], detail);
}

test("the hook decides as the host's own exec tool does", async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-exec-differential.mjs"), hostRoot(), root], {
    timeout: 170_000, maxBuffer: 1 << 24,
  });
  const rows = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.ok(rows.length > 300, `${rows.length} rows`);
  const differ = rows.filter((row) => row.expected !== row.hook);
  assert.deepEqual(differ, []);
  // The cases the source exists for, by name: each would pass with its clause gone.
  const row = (config, command) => rows.find((item) => item.config === config && item.command === command);
  for (const [config, command, hook, host] of [
    ["on_miss", "bash -c 'git status'", "REFUSE", "ASK"],
    ["allowlist_off", "ls *", "REFUSE", "ASK"],
    ["on_miss", "cat <<EOF\nhi\nEOF", "REFUSE", "ASK"],
    ["on_miss", "cat '<<EOF'", "REFUSE", "ASK"],
    ["on_miss", "echo hi | tr a b", "pass", "RUN"],
    ["allowlist_off", "./script.py", "REFUSE", "DENY"],
    ["on_miss", "git status", "pass", "RUN"],
    ["path_prepend", "mytool", "pass", "RUN"],
    ["strict", "ls", "pass", "RUN"],
    ["strict", "node -e 1", "REFUSE", "ASK"],
    ["full_on_miss", "echo security.audit.suppressions", "REFUSE", "ASK"],
    ["host_node_on_miss", "ls", "REFUSE", "not run"],
    ["host_node_default", "ls", "pass", "not run"],
  ]) {
    const found = row(config, command);
    assert.deepEqual(found && [found.hook, found.host], [hook, host], `${config}: ${command} ${JSON.stringify(found)}`);
  }
});

describe("real gateway", {concurrency: 4}, () => {
  test("default policy: the command runs and nothing is refused", async () => {
    const report = await realTurn("default-policy");
    const detail = JSON.stringify(report);
    assert.equal(report.commandRan, true, detail);
    assert.equal(report.refusals, 0, detail);
    assert.deepEqual(report.posts.map((post) => [post.text, post.sourceEventId]), [["REPLY AFTER THE TOOL RESULT", "evt-5"]], detail);
  });

  test("a command needing approval is refused at once and the reply stays in the turn", async () => {
    assertRefusedInTurn(await realTurn("ask-always"));
  });

  test("an allowlisted command runs under ask=on-miss, and a miss is refused", async () => {
    const allowed = await realTurn("on-miss-allowlisted");
    const detail = JSON.stringify(allowed);
    assert.equal(allowed.commandRan, true, detail);
    assert.equal(allowed.refusals, 0, detail);
    assert.equal(allowed.followUps, 0, detail);
    assert.deepEqual(allowed.posts.map((post) => post.sourceEventId), ["evt-5"], detail);
    assertRefusedInTurn(await realTurn("on-miss-miss"));
  });

  test("allowlisted but not enforceable: refused, and never run at expiry under askFallback=allowlist", async () => {
    assertRefusedInTurn(await realTurn("allowlist-wrapper"));
    assertRefusedInTurn(await realTurn("allowlist-glob"));
  });

  test("strictInlineEval leaves a plain command to the normal decision", async () => {
    const report = await realTurn("strict-plain-command");
    const detail = JSON.stringify(report);
    assert.equal(report.commandRan, true, detail);
    assert.equal(report.refusals, 0, detail);
  });

  test("askFallback=full never runs it, past the host's approval expiry", async () => {
    assertRefusedInTurn(await realTurn("fallback-full-expiry"));
  });

  test("an operator's /exec override on the Room session counts: refused, never run at expiry", async () => {
    assertRefusedInTurn(await realTurn("session-override-ask"));
  });

  test("a stuck model: nothing reaches the Room, no request, no follow-up", async () => {
    const report = await realTurn("stuck-model");
    const detail = JSON.stringify(report);
    assert.ok(report.refusals >= 5, detail);
    assert.equal(report.commandRan, false, detail);
    assert.equal(report.followUps, 0, detail);
    assert.deepEqual(report.posts, [], detail);
  });

  test("a slow model: one reply bound to its turn, no host sentence while it thinks", async () => {
    assertRefusedInTurn(await realTurn("slow-model"), {replySecondsBelow: 20});
  });

  test("a provider error: no approval text and no follow-up, the turn closes", async () => {
    const report = await realTurn("provider-error");
    const detail = JSON.stringify(report);
    assert.equal(report.commandRan, false, detail);
    assert.equal(report.followUps, 0, detail);
    assert.deepEqual(report.posts, [], detail);
    assert.deepEqual(report.turn.map((item) => item.kind).at(-1), "ack", detail);
  });

  test("a subagent spawned in the Room turn is refused too, under askFallback=full", async () => {
    const report = await realTurn("subagent");
    const detail = JSON.stringify(report);
    assert.ok(report.modelRequests.some((item) => item.subagent && item.toolResult?.includes(REFUSED)), detail);
    assert.equal(report.commandRan, false, detail);
    assert.equal(report.followUps, 0, detail);
    assert.ok(!report.posts.some((post) => isPrivateApprovalText(post.text)), detail);
  });

  test("session forwarding: nothing reaches the Room but the model's reply", async () => {
    assertRefusedInTurn(await realTurn("forward-session"));
  });

  test("forwarding that reaches no private person is no private target: refused", async () => {
    for (const caseName of ["target-filtered-out", "target-is-a-room"]) {
      const report = await realTurn(caseName);
      assertRefusedInTurn(report);
      assert.deepEqual(report.desk, [], JSON.stringify(report));
    }
  });

  test("a private target: the request stays open and the prompt goes only there", async () => {
    const report = await realTurn("private-target-open");
    const detail = JSON.stringify(report);
    assert.equal(report.refusals, 0, detail);
    assert.equal(report.commandRan, false, detail);
    assert.equal(report.followUps, 0, detail);
    assert.deepEqual(report.posts, [], detail);
    assert.equal(report.desk.length, 1, detail);
    assert.match(report.desk[0].text, /Exec approval required/, detail);
    assert.deepEqual(report.turn.map((item) => [item.kind, item.reason ?? ""]).at(1), ["skipped", "approval_required"], detail);
  });

  test("a private target: the person's yes runs it, and the model's reply reaches the Room", async () => {
    const report = await realTurn("private-target-answered");
    const detail = JSON.stringify(report);
    assert.deepEqual(report.deskErrors, [], detail);
    assert.equal(report.commandRan, true, detail);
    assert.deepEqual(report.posts.map((post) => post.text), ["FOLLOW-UP REPLY"], detail);
  });

  test("a private target: the person's no with a failing follow-up posts no host sentence", async () => {
    const report = await realTurn("private-target-denied-follow-up-fails");
    const detail = JSON.stringify(report);
    assert.deepEqual(report.deskErrors, [], detail);
    assert.equal(report.commandRan, false, detail);
    assert.deepEqual(report.posts, [], detail);
    assert.ok(report.withheld >= 1, detail);
  });

  test("a private target under askFallback=full: refused, because expiry would run it", async () => {
    const report = await realTurn("private-target-fallback-full");
    assertRefusedInTurn(report);
    assert.deepEqual(report.desk, [], JSON.stringify(report));
  });

  test("a private target and a stuck model: one request, nothing in the Room", async () => {
    const report = await realTurn("private-target-stuck");
    const detail = JSON.stringify(report);
    assert.equal(report.desk.length, 1, detail);
    assert.ok(report.refusals >= 5, detail);
    assert.equal(report.commandRan, false, detail);
    assert.deepEqual(report.posts, [], detail);
  });

  test("the model's reply with approval text is withheld and the turn closes", async () => {
    const report = await realTurn("reply-echo");
    const detail = JSON.stringify(report);
    assert.deepEqual(report.posts, [], detail);
    assert.ok(report.withheld >= 1, detail);
    assert.deepEqual(report.turn.map((item) => [item.kind, item.action ?? item.reason ?? ""]),
      [["settle", "pass"], ["skipped", "approval_text_withheld"], ["ack", ""]], detail);
  });
});
