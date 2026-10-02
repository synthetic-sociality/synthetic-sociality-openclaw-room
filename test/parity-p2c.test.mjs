// Shared conformance cases for parity release P2c (delivery contract section
// "P2c — Secrets, late replies, self-recovery"). Case names are identical in
// the Hermes and OpenClaw conformance.json files. No test uses or prints a
// real credential.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {execFile} from "node:child_process";
import {randomBytes} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import {hostname, tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {registerHooks} from "node:module";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {ISOLATED_HOST_CONFIG} from "./support/isolated-host.mjs";

const sdkMocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/reply-payload": "export const isReplyPayloadNonTerminalToolErrorWarning = () => false;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sdkMocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(sdkMocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p2c-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const STORE = join(home, "openclaw", "synthetic-sociality-room");
await mkdir(join(STORE, "accounts"), {recursive: true, mode: 0o700});

const {createRoomChannel, roomToolCallPolicy, roomToolResultScrub, resetSecretRefusalLog} = await import("../src/channel.js");
const {OpenClawRoomRuntime, HOST_LABEL, KEPT_REPLY_CHARACTER_LIMIT, keptReplyBlock} = await import("../src/runtime.js");
const {RoomAPIError} = await import("../src/room-client.js");
const {loadState, saveState, validateState} = await import("../src/state.js");
const {renewCredential} = await import("../src/credential-renewal.js");
const isolation = await import("../src/secret-isolation.js");
const {LocalStatus, STATUS_SCHEMA, resetLocalStatusWriters} = await import("../src/local-status.js");

const conformance = JSON.parse(await readFile(join(root, "conformance.json"), "utf8"));
const contract = await readFile(join(root, "docs/delivery-lifecycle-contract-v1.md"), "utf8");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// Test-only values; never a real credential.
const FAKE_CREDENTIAL = `room-cred-TEST-${"0f1e2d3c".repeat(4)}`;
const FAKE_REPLACEMENT = `room-cred-TEST-replacement-${"9a8b".repeat(6)}`;
const KEPT_TEXT = "The dosage question needs the lab values first; I would wait for them.";
// The P1a-01 deny-list: connector-authored text never carries these.
const DENY = ["consensus", "common ground", "synthes", "otherwise pass", "only if", "meaningful", "manufacture", "do not repeat", "force", "agree"];

const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
  {membershipId: "paula", displayName: "Paula", role: "participant_agent", status: "active"},
];
const message = (seq, actorId, actorRole, body, extra = {}) => ({id: `message0000${seq}`, seq, ts: `2026-10-02T09:49:${String(seq % 60).padStart(2, "0")}Z`,
  type: "message.posted", actorRole, actorId, payload: {body, epochId: "epoch-z", ...extra}});
const readyFor = (seq, sourceEventId) => ({id: `attemptready${seq}`, seq, ts: "2026-10-02T09:55:00Z",
  type: "discussion.cycle_attempt_ready", actorRole: "system", actorId: "room_coordinator",
  payload: {cycleId: `cycle-${seq}`, epochId: "epoch-z", generation: 1, membershipId: "zurie", round: 1, sourceEventId}});

function appendixKeys() {
  const section = contract.slice(contract.indexOf("## Appendix — Local status file (P2c-4)"));
  return new Set([...section.matchAll(/^\| `([A-Za-z.<>]+)` \|/gm)].map((match) => match[1]));
}
function flattenKeys(value) {
  const keys = new Set(Object.keys(value));
  for (const entry of Object.values(value.rooms ?? {})) for (const key of Object.keys(entry)) keys.add(`rooms.<id>.${key}`);
  return keys;
}

// A runtime for Zurie over `events` (as in the P2a cases); returns the runtime.
function roomRuntime(events, {epochId = "epoch-z", epochStartsAtSeq = 2900, credential = "fixture-credential", cursor = events[0].seq - 1} = {}) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: "https://room.example/api"});
  runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential,
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: ""};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.saved = [];
  runtime.persistState = async () => { runtime.saved.push(structuredClone(runtime.state)); };
  runtime.client = {
    readEvents: async (_state, afterSeq) => ({activeEpochId: epochId, activeEpochStartsAtSeq: epochStartsAtSeq,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => ({headSeq: events.at(-1).seq, activeEpoch: {id: epochId, startsAtSeq: epochStartsAtSeq}, activeTopic: {title: "Coding"}, roster: ROSTER, rules: []}),
    roomPolicy: async () => ({policy: {coordinationMode: "coordinated"}}),
    listArtifacts: async () => ({items: []}),
    claimDiscussionAttempt: async (_state, cycleId) => ({attempt: {id: `attempt-${cycleId}`, round: 1, membershipId: "zurie"},
      cycle: {id: cycleId, generation: 1, totalTurns: 0, budgets: {totalTurns: 4, perAgentTurns: 2}}}),
    acknowledge: async (_state, seq) => ({acknowledgedSeq: seq}),
    acknowledgePeerContribution: async () => ({}),
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  return runtime;
}

async function firstTurn(runtime) {
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const {value} = await turns.next();
  controller.abort();
  return value;
}

function installedHost() {
  for (const candidate of [process.env.OPENCLAW_HOST_ROOT, "/usr/local/lib/node_modules/openclaw"].filter(Boolean)) {
    try {
      if (JSON.parse(readFileSync(join(candidate, "package.json"))).version === packageJson.peerDependencies.openclaw) return candidate;
    } catch {}
  }
  return null;
}

async function hostToolCall(hostRoot, stateDir, stateFile, otherFile, {control = false} = {}) {
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-tool-call.mjs"), hostRoot,
    join(root, "src/index.js"), stateDir, stateFile, otherFile, JSON.stringify(ISOLATED_HOST_CONFIG)], {
    env: {...process.env, JITI_FS_CACHE: "false", ROOM_P2C_CONTROL: control ? "1" : "0"}, timeout: 120_000, maxBuffer: 1 << 20,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("conformance P2c case names resolve to tests in this suite", async () => {
  const cases = Object.entries(conformance.parityP2cCases ?? {});
  assert.equal(cases.length, 5);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  for (const [id, name] of cases) {
    assert.ok(name.startsWith(`${id} `), id);
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(name)},`)).length, 1, name);
  }
  assert.equal(conformance.parityP2cStatusSchema, STATUS_SCHEMA);
  assert.ok(contract.includes(`\`${STATUS_SCHEMA}\``));
});

test("P2c-01 the credential is not readable through the agent's tools and never appears in prompt, tool result or log", async (t) => {
  const stateDir = join(home, "openclaw");
  const stateFile = join(STORE, "accounts", "zurie.json");
  await writeFile(stateFile, JSON.stringify({credential: FAKE_CREDENTIAL}), {mode: 0o600});
  const notes = join(home, "notes.txt");
  await writeFile(notes, "an ordinary file");
  const alias = join(home, "innocent.json");
  await symlink(stateFile, alias);

  // 1. The agent's own read and bash tools, as the installed host runs them
  // (its loader, its hook runner, its tool wrapper): refused; an ordinary file
  // still reads. Without the plugin the same host returns the credential (D4b).
  const hostRoot = installedHost();
  if (!hostRoot) t.diagnostic("installed host 2026.7.1-2 unavailable; host proof skipped");
  else {
    const fenced = await hostToolCall(hostRoot, stateDir, stateFile, notes);
    assert.deepEqual(fenced.hooks, ["before_tool_call", "gateway_stop", "inbound_claim", "tool_result_persist"]);
    for (const label of ["readStore", "bashStore", "readStoreRelative"]) {
      assert.match(JSON.stringify(fenced[label]), /not available to agent tools/, label);
      assert.doesNotMatch(JSON.stringify(fenced[label]), new RegExp(FAKE_CREDENTIAL), label);
    }
    assert.equal(fenced.readOther.text.trim(), "an ordinary file");
    const control = await hostToolCall(hostRoot, stateDir, stateFile, notes, {control: true});
    assert.match(control.readStore.text, new RegExp(FAKE_CREDENTIAL), "control: the host alone would return the credential");
    assert.match(control.readStoreRelative.text, new RegExp(FAKE_CREDENTIAL), "control: also by a workspace-relative path");
  }

  // 2. The fence itself, in every session.
  const api = {config: ISOLATED_HOST_CONFIG, logger: {warn: () => {}}};
  const policy = roomToolCallPolicy(api);
  const refused = [
    ["read", {path: stateFile}],
    ["read", {path: alias}],
    ["read", {file_path: "~/../../../../../../" + stateFile}],
    ["write", {path: join(STORE, "status.json"), content: "{}"}],
    ["edit", {path: stateFile, oldText: "a", newText: "b"}],
    ["apply_patch", {input: `*** Begin Patch\n*** Update File: ${stateFile}\n@@\n-a\n+b\n*** End Patch`}],
    ["grep", {path: home, pattern: "credential"}],
    ["exec", {command: "cat $OPENCLAW_STATE_DIR/synthetic-sociality-room/accounts/*.json"}],
    ["exec", {command: "cat ${OPENCLAW_STATE_DIR}/synthetic-sociality-room/accounts/zurie.json"}],
    ["process", {action: "spawn", command: `tail -f ${stateFile}`}],
    // Relative to the agent's workspace (<stateDir>/workspace), not the gateway cwd.
    ["read", {path: "../synthetic-sociality-room/accounts/x.json"}],
  ];
  const mainAgent = {agentId: "main"};
  for (const [toolName, params] of refused) {
    const verdict = policy({toolName, params}, mainAgent);
    assert.equal(verdict?.block, true, `${toolName} ${JSON.stringify(params).slice(0, 60)}`);
    assert.doesNotMatch(verdict.blockReason, new RegExp(FAKE_CREDENTIAL));
  }
  assert.equal(policy({toolName: "read", params: {path: notes}}), undefined);
  assert.equal(policy({toolName: "read", params: {path: "relative/notes.md"}}, mainAgent), undefined);
  assert.equal(policy({toolName: "web_fetch", params: {url: "https://example.com/a/b"}}), undefined);
  // The shell backstop matches the store, not the plugin's name.
  for (const command of ["ls ~/.openclaw/plugins/synthetic-sociality-room", "hermes plugins update synthetic-sociality-room",
    "openclaw plugins inspect synthetic-sociality-room", "ls $OPENCLAW_STATE_DIR/extensions/synthetic-sociality-room"]) {
    assert.equal(policy({toolName: "exec", params: {command}}, mainAgent), undefined, command);
  }
  // Relative paths: the hook context's workspace when the host gives one,
  // else the agent's workspace (non-default agents: <stateDir>/workspace-<id>).
  const listed = {...ISOLATED_HOST_CONFIG, agents: {list: [{id: "main", default: true}, {id: "zurie"}]}};
  const listedPolicy = roomToolCallPolicy({config: listed, logger: {warn: () => {}}});
  assert.equal(listedPolicy({toolName: "read", params: {path: "../synthetic-sociality-room/accounts/x.json"}}, {agentId: "zurie"})?.block, true);
  assert.equal(policy({toolName: "read", params: {path: "synthetic-sociality-room/accounts/x.json"}}, {workspaceDir: stateDir})?.block, true);
  assert.equal(policy({toolName: "read", params: {path: "synthetic-sociality-room/accounts/x.json"}}, mainAgent), undefined);
  // A search without a path searches its cwd.
  assert.equal(policy({toolName: "grep", params: {pattern: "credential"}}, {workspaceDir: stateDir})?.block, true);
  assert.equal(policy({toolName: "grep", params: {pattern: "credential"}}, mainAgent), undefined);
  // A fence error refuses.
  const broken = policy({get toolName() { throw new Error("boom"); }, params: {}});
  assert.equal(broken.block, true);

  // 3. The start gate.
  const gate = (cfg) => isolation.storeReachability(cfg, [STORE], {stateDir});
  assert.deepEqual(gate({}), ["fs_tools_unfenced", "host_shell_tools"]);
  assert.deepEqual(gate({tools: {fs: {workspaceOnly: true}}}), ["host_shell_tools"]);
  assert.deepEqual(gate(ISOLATED_HOST_CONFIG), []);
  const sandboxed = {tools: {fs: {workspaceOnly: true}, elevated: {enabled: false}}, agents: {defaults: {sandbox: {mode: "all"}}}};
  assert.deepEqual(gate(sandboxed), []);
  assert.deepEqual(gate({...sandboxed, tools: {...sandboxed.tools, elevated: {}}}), ["host_shell_tools"]);
  assert.deepEqual(gate({...sandboxed, tools: {...sandboxed.tools, exec: {host: "gateway"}}}), ["host_shell_tools"]);
  assert.deepEqual(gate({...sandboxed, agents: {defaults: {sandbox: {mode: "all", docker: {binds: [`${stateDir}:/state:ro`]}}}}}),
    ["sandbox_bind_covers_store"]);
  assert.deepEqual(gate({...ISOLATED_HOST_CONFIG, agents: {list: [{id: "x", tools: {fs: {workspaceOnly: false}}}]}}), ["fs_tools_unfenced"]);
  assert.deepEqual(gate({...sandboxed, agents: {defaults: {sandbox: {mode: "all"}}, list: [{id: "x", sandbox: {mode: "off"}}]}}), ["host_shell_tools"]);
  assert.deepEqual(gate({...ISOLATED_HOST_CONFIG, agents: {defaults: {workspace: stateDir}}}), ["workspace_covers_store"]);
  assert.deepEqual(gate({...ISOLATED_HOST_CONFIG, tools: {...ISOLATED_HOST_CONFIG.tools, exec: {applyPatch: {workspaceOnly: false}}}}), ["fs_tools_unfenced"]);

  // The channel under a reachable store. Report-only (the default): logged
  // once, the status says why, and the account starts. Enforced
  // (enforceSecretIsolation on): no client, logged once, it waits for the
  // host's stop. The fence above is active in both modes.
  const enforcing = {plugins: {entries: {"synthetic-sociality-room": {config: {enforceSecretIsolation: true}}}}};
  const startOnce = async (cfg) => {
    resetLocalStatusWriters();
    let made = 0;
    const client = {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* (signal) { await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true})); },
      close: async () => {},
    };
    const channel = createRoomChannel({makeClient: () => { made += 1; return client; }});
    const lines = {warn: [], error: []};
    const run = async () => {
      const controller = new AbortController();
      let status = {};
      const running = channel.plugin.gateway.startAccount({
        account: {accountId: "zurie", stateFile}, accountId: "zurie", abortSignal: controller.signal, cfg,
        channelRuntime: {inbound: {run: async () => {}}}, getStatus: () => status, setStatus: (next) => { status = next; },
        log: {info: () => {}, warn: (line) => lines.warn.push(line), error: (line) => lines.error.push(line)},
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await running;
      return status;
    };
    resetSecretRefusalLog();
    const first = await run();
    await run();
    return {made, first, lines, written: JSON.parse(await readFile(join(STORE, "status.json"), "utf8"))};
  };
  const reporting = await startOnce({});
  assert.equal(reporting.made, 2, "report-only: the account starts");
  assert.notEqual(reporting.first.lastError, "secret_store_reachable");
  assert.equal(reporting.lines.error.length, 0);
  const reports = reporting.lines.warn.filter((line) => line.includes("secret_store_reachable (fs_tools_unfenced,host_shell_tools)"));
  assert.equal(reports.length, 1, reporting.lines.warn.join(" | "));
  assert.match(reports[0], /reporting only/);
  assert.deepEqual([reporting.written.secretStore, reporting.written.secretStoreReasons, reporting.written.secretIsolationEnforced],
    ["reachable", ["fs_tools_unfenced", "host_shell_tools"], false]);
  // Only boolean true enables enforcement (the manifest declares a boolean).
  const stringly = await startOnce({plugins: {entries: {"synthetic-sociality-room": {config: {enforceSecretIsolation: "true"}}}}});
  assert.equal(stringly.made, 2);
  assert.equal(stringly.written.secretIsolationEnforced, false);
  for (const cfg of [enforcing]) {
    const refused = await startOnce(cfg);
    assert.equal(refused.made, 0, "enforced: no client");
    assert.equal(refused.first.lastError, "secret_store_reachable");
    assert.equal(refused.lines.error.length, 1);
    assert.match(refused.lines.error[0], /refused to start: secret_store_reachable \(fs_tools_unfenced,host_shell_tools\)/);
    assert.deepEqual([refused.written.secretStore, refused.written.secretIsolationEnforced], ["reachable", true]);
    assert.doesNotMatch(JSON.stringify(refused.written), new RegExp(FAKE_CREDENTIAL));
  }
  const isolatedEnforced = await startOnce({...ISOLATED_HOST_CONFIG, ...enforcing});
  assert.equal(isolatedEnforced.made, 2, "enforced on an isolated host: starts");
  assert.deepEqual([isolatedEnforced.written.secretStore, isolatedEnforced.written.secretStoreReasons], ["isolated", []]);
  // The switch is declared in the plugin's strict config schema.
  const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(manifest.configSchema.properties.enforceSecretIsolation, {type: "boolean"});
  assert.equal(conformance.parityP2cEnforcementSetting, isolation.ENFORCEMENT_SETTING);

  // 4. Never in a persisted tool result, a log line, or the model prompt.
  isolation.forgetSecrets();
  isolation.rememberSecrets({credential: FAKE_CREDENTIAL, credentialRotation: {replacementCredential: FAKE_REPLACEMENT, grantId: "short"}});
  assert.equal(roomToolResultScrub({message: {role: "toolResult", content: [{type: "text", text: "clean"}]}}), undefined);
  for (const secret of [FAKE_CREDENTIAL, FAKE_REPLACEMENT]) {
    const scrubbed = roomToolResultScrub({message: {role: "toolResult", content: [{type: "text", text: `export X=${secret}`}]}});
    assert.doesNotMatch(JSON.stringify(scrubbed), new RegExp(secret));
    assert.match(JSON.stringify(scrubbed), /redacted Room credential/);
    const lines = [];
    isolation.scrubbingLogger({warn: (line) => lines.push(line)}).warn(`Room diagnostic ${secret}`);
    assert.doesNotMatch(lines.join("\n"), new RegExp(secret));
  }
  isolation.forgetSecrets();
  const runtime = roomRuntime([message(2969, "paula", "participant_agent", "Zurie, over to you.", {resolvedRecipientMembershipIds: ["zurie"]}),
    readyFor(2970, "message00002969")], {credential: FAKE_CREDENTIAL, cursor: 2969});
  const turn = await firstTurn(runtime);
  assert.doesNotMatch(JSON.stringify({text: turn.text, raw: turn.raw}), new RegExp(FAKE_CREDENTIAL));

  // 5. A renewed credential is scrubbed: the real renewal path journals and
  // swaps through saveState, which registers each secret it writes.
  isolation.forgetSecrets();
  const renewal = await renewalFixture();
  assert.equal(await renewCredential(renewal), true);
  for (const secret of [renewal.replacement(), renewal.grantSecret()]) {
    assert.ok(secret && secret.length >= 16);
    assert.equal(isolation.scrub(`export X=${secret}`), `export X=${isolation.REDACTED}`);
  }
  isolation.forgetSecrets();
  // A state read from disk (a renewal by another process) registers it too.
  await loadState(renewal.stateFile);
  assert.equal(isolation.scrub(renewal.replacement()), isolation.REDACTED);
  isolation.forgetSecrets();

  // 6. No plugin module places anything in the environment tools inherit.
  for (const name of await readdir(join(root, "src"))) {
    const source = await readFile(join(root, "src", name), "utf8");
    assert.doesNotMatch(source, /process\.env(\.\w+|\[[^\]]+\])\s*=[^=]|Object\.assign\(process\.env/, name);
  }
});

test("P2c-02 a late reply is offered once as a fact with its kept text and then cleared", async () => {
  // Kept: the model ran; the Room refused the post because the turn had ended.
  for (const code of ["turn_expired", "cycle_superseded", "turn_not_active"]) {
    const runtime = roomRuntime([message(2964, "owner-tj", "human_owner", "Your view?")]);
    runtime.postNumberIndex().set(2964, "message00002964");
    runtime.pendingEvent = {id: "attemptready2970", seq: 2970};
    runtime.client.postMessage = async () => { throw new RoomAPIError(409, {code, retryable: false}); };
    runtime.client.roomState = async () => ({headSeq: 2970, activeEpoch: {id: "epoch-z", startsAtSeq: 2900}});
    runtime.client.requestTurn = async () => ({state: "granted", turnId: "turn-1"});
    const sent = await runtime.postAndFinish({roomId: "room-1", text: KEPT_TEXT, replyToId: "message00002964",
      idempotencyKey: "attemptready2970:final", sourceEventId: "attemptready2970"});
    assert.equal(sent.superseded, true, code);
    const kept = runtime.state.keptReply;
    assert.deepEqual([kept.sourceEventId, kept.sourceSeq, kept.epochId, kept.reason, kept.text],
      ["message00002964", 2964, "epoch-z", code, KEPT_TEXT], code);
    assert.match(kept.producedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    validateState(runtime.state);
    assert.ok(runtime.logs.some((line) => /Room reply kept, not posted code=\S+ sourceSeq=2964 attempt=/.test(line)));
  }
  // Not kept: the discussion changed (never crosses discussions), or no text.
  const stale = roomRuntime([message(2964, "owner-tj", "human_owner", "Your view?")]);
  await stale.keepLateReply({identity: {body: KEPT_TEXT, replyToId: "m", sourceEpochId: "epoch-z"}}, "stale_epoch");
  await stale.keepLateReply({identity: {body: KEPT_TEXT, replyToId: "m", sourceEpochId: "epoch-z"}}, "historical_epoch");
  await stale.keepLateReply({identity: {body: " ", replyToId: "m", sourceEpochId: "epoch-z"}}, "turn_expired");
  assert.equal(stale.state.keptReply, undefined);
  // Bounded: one per Room, the latest wins; an over-long reply is not kept.
  await stale.keepLateReply({identity: {body: "first", replyToId: "m-1", sourceEpochId: "epoch-z"}}, "turn_expired");
  await stale.keepLateReply({identity: {body: "second", replyToId: "m-2", sourceEpochId: "epoch-z"}}, "cycle_superseded");
  assert.deepEqual([stale.state.keptReply.sourceEventId, stale.state.keptReply.text], ["m-2", "second"]);
  const second = {...stale.state.keptReply};
  // Latest wins even when the latest is too long to keep: the older kept
  // reply is cleared, never offered in its place.
  await stale.keepLateReply({identity: {body: "x".repeat(KEPT_REPLY_CHARACTER_LIMIT + 1), replyToId: "m-3", sourceEpochId: "epoch-z"}}, "turn_expired");
  assert.equal(stale.state.keptReply, undefined);
  assert.ok(stale.logs.some((line) => /Room reply not kept code=late_reply_too_large/.test(line)));
  validateState({...stale.state, keptReply: second});
  for (const broken of [{text: "x"}, {...second, text: ""}, {...second, sourceSeq: "5"}]) {
    assert.throws(() => validateState({...stale.state, keptReply: broken}), /kept reply is invalid/);
  }

  // Offered once on the next model turn in the same discussion.
  const source = message(2964, "owner-tj", "human_owner", "Your view on the dosage?");
  const events = [source, message(2969, "paula", "participant_agent", "Zurie, over to you.", {resolvedRecipientMembershipIds: ["zurie"]}),
    readyFor(2970, "message00002969")];
  const kept = {sourceEventId: "message00002964", sourceSeq: 2964, epochId: "epoch-z", producedAt: "2026-10-02T09:52:30Z",
    reason: "turn_expired", text: KEPT_TEXT};
  const runtime = roomRuntime(events, {cursor: 2969});
  runtime.state.keptReply = {...kept};
  const turn = await firstTurn(runtime);
  const block = [
    "[Your own earlier reply, kept: it was produced but not posted]",
    "Answered: #2964 TJE, 09:49 UTC",
    "Produced: 09:52 UTC",
    "Not posted: turn_expired",
    KEPT_TEXT,
    "[/Your own earlier reply]",
  ].join("\n");
  assert.equal(turn.text.split("[Your own earlier reply").length - 1, 1, turn.text);
  assert.ok(turn.text.includes(block), turn.text);
  assert.equal(keptReplyBlock(kept, source, ROSTER), block);
  // Procedural facts only: the connector-authored lines pass the deny-list.
  const authored = block.replace(KEPT_TEXT, "").toLowerCase();
  for (const word of DENY) assert.ok(!authored.includes(word), word);
  // Cleared durably before the host runs the turn; the next turn has none.
  assert.equal(runtime.state.keptReply, undefined);
  assert.equal(runtime.saved.at(-1).keptReply, undefined);
  const again = roomRuntime(events, {cursor: 2969});
  assert.doesNotMatch((await firstTurn(again)).text, /\[Your own earlier reply/);

  // Never across discussions: kept in another epoch, cleared without an offer.
  const other = roomRuntime(events, {cursor: 2969});
  other.state.keptReply = {...kept, epochId: "epoch-y"};
  assert.doesNotMatch((await firstTurn(other)).text, /\[Your own earlier reply/);
  assert.equal(other.state.keptReply, undefined);
});

// The renewal flow of credential-renewal.test.mjs, reduced: the real
// renewCredential generates the grant secret and the replacement credential.
async function renewalFixture() {
  const stateFile = join(await mkdtemp(join(home, "renew-")), "state.json");
  const state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    clientInstanceId: "instance-1", credential: "expired-base-credential", credentialExpiresAt: "2020-01-01T00:00:00Z",
    cursor: 7, terminalEvidence: {}, deliveryIntents: {}};
  await saveState(stateFile, state);
  const request = {roomId: "room-1", membershipId: "member-1", displayName: "An agent", identityVersion: 2,
    baseCredentialGeneration: 1, requestId: randomBytes(32).toString("base64url"), deliveredSeq: 9, acknowledgedSeq: 7, state: "owner_requested",
    expiresAt: new Date(Date.now() + 60_000).toISOString()};
  const proof = {...request, grantId: "grant-1", credentialExpiresAt: "2030-01-01T00:00:00Z"};
  let replacement = "", grantSecret = "", confirmed = false;
  const client = {
    credentialRenewalIntent: async () => ({request: confirmed ? null : request}),
    roomState: async () => ({roomId: "room-1", roster: [proof]}),
    requestCredentialRenewal: async () => {
      grantSecret = (await loadState(stateFile)).credentialRotation.grantSecret;
      return {...request, state: "issued", grantId: "grant-1"};
    },
    redeemCredentialRenewal: async (_session, _grantId, body) => { replacement = body.replacementCredential; return proof; },
    verifyCredentialRenewal: async () => proof,
    confirmCredentialRenewal: async () => {
      confirmed = true;
      return {id: "event-1", type: "credential.renewed", payload: {membershipId: "member-1", credentialGeneration: 2, credentialExpiresAt: proof.credentialExpiresAt}};
    },
  };
  return {state, stateFile, client, replacement: () => replacement, grantSecret: () => grantSecret};
}

test("P2c-03 after network loss and session expiry the connector reconnects without a restart", async () => {
  // The Room says no active session while its heartbeat is accepted and
  // nothing failed before: the enrollment check alone makes the runtime
  // register again (Wu and Real logged this check every 70 s).
  {
    const sessions = ["session-stored"];
    const enrollments = [];
    const runtime = roomRuntime([message(2964, "paula", "participant_agent", "Quiet.")]);
    delete runtime.maintainPresence;
    runtime.publishPresence = async () => {};
    runtime.connectorSession = {sessionId: "session-stored"};
    runtime.account.stateFile = join(home, "p2c-03-enrollment.json");
    Object.assign(runtime.client, {
      heartbeat: async () => ({leaseExpiresAt: "2099-01-01T00:00:00Z"}),
      register: async () => { sessions.push(`session-${sessions.length + 1}`); return {sessionId: sessions.at(-1), capabilities: []}; },
      connectorEnrollments: async () => {
        if (sessions.length === 1) {
          enrollments.push("not_active");
          throw new RoomAPIError(401, {code: "connector_not_active", retryable: true});
        }
        enrollments.push("ok");
        return [];
      },
    });
    await runtime.maintainPresence();
    await runtime.maintainPresence();
    assert.deepEqual(enrollments, ["not_active", "ok"]);
    assert.deepEqual(sessions, ["session-stored", "session-2"]);
    assert.equal(runtime.connectorSession.sessionId, "session-2");
  }
  // Wu and Real, Mac128, 2026-10-02: after a network loss the Room had no
  // live session for the installation; the connector logged that every 70 s
  // until a gateway restart. Here: the event read drops, heartbeats fail, then
  // the Room says no active session (with the stored session's heartbeat
  // accepted, and with it gone). The runtime registers again and resumes its
  // event reads without a restart.
  for (const variant of ["not_active", "session_gone"]) {
    const room = {down: false, over: false, forgotten: new Set(), sessions: ["session-stored"], registrations: [], enrollments: [], delivered: false};
    const events = [message(2964, "paula", "participant_agent", "Before the outage.")];
    const runtime = roomRuntime(events);
    delete runtime.maintainPresence;
    runtime.publishPresence = async () => {};
    runtime.reconnectInitialMs = 20;
    runtime.reconnectMaxMs = 80;
    runtime.heartbeatMinimumSeconds = 0.05;
    runtime.connectorSession = {sessionId: "session-stored", heartbeatIntervalSeconds: 0.05};
    let initializations = 0;
    runtime.initializeOnce = async () => { initializations += 1; return runtime.connectorSession; };
    const network = () => Object.assign(new TypeError("fetch failed"), {cause: {code: "ENETUNREACH"}});
    const readEvents = runtime.client.readEvents;
    let reads = 0;
    Object.assign(runtime.client, {
      readEvents: async (state, afterSeq, options) => {
        reads += 1;
        if (reads === 2) room.down = true; // the laptop loses its network mid-stream
        if (room.down) throw network();
        if (room.over && !room.delivered) {
          room.delivered = true;
          return {activeEpochId: "epoch-z", activeEpochStartsAtSeq: 2900, events: [readyFor(2965, "message00002964")]};
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return readEvents(state, afterSeq, options);
      },
      heartbeat: async (_state, sessionId) => {
        if (room.down) throw network();
        if (variant === "session_gone" && room.forgotten.has(sessionId)) throw new RoomAPIError(404, {code: "not_found"});
        return {leaseExpiresAt: "2099-01-01T00:00:00Z"};
      },
      register: async (_state, registration) => {
        if (room.down) throw network();
        const sessionId = `session-${room.sessions.length + 1}`;
        room.sessions.push(sessionId);
        room.registrations.push({...registration.metadata, afterOutage: room.over});
        return {sessionId, capabilities: [], heartbeatIntervalSeconds: 0.05};
      },
      connectorEnrollments: async () => {
        if (room.down) throw network();
        if (room.forgotten.has(room.sessions.at(-1))) {
          room.enrollments.push("not_active");
          throw new RoomAPIError(401, {code: "connector_not_active", retryable: true});
        }
        room.enrollments.push("ok");
        return [];
      },
    });
    const savedTo = join(home, `p2c-03-${variant}.json`);
    runtime.account.stateFile = savedTo;
    runtime.runHeartbeat();
    const controller = new AbortController();
    const turns = runtime.assignedTurns(controller.signal);
    setTimeout(() => {
      // The network is back; the Room holds no live session for any session
      // registered before the outage.
      for (const session of room.sessions) room.forgotten.add(session);
      room.down = false;
      room.over = true;
    }, 300);
    const deadline = Date.now() + 8_000;
    const {value} = await Promise.race([turns.next(), new Promise((_, reject) => setTimeout(() => reject(new Error("no turn after the outage")), 8_000))]);
    while (!room.enrollments.includes("ok") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await runtime.close?.();
    assert.equal(value.raw.id, "attemptready2965", variant);
    assert.ok(room.registrations.some((item) => item.afterOutage), `${variant}: registered again after the outage`);
    assert.ok(room.enrollments.includes("ok"), `${variant}: the Room sees a live session again`);
    assert.equal(initializations, 0, `${variant}: no restart`);
    assert.ok(room.registrations.every((item) => item.hostLabel === HOST_LABEL));
    assert.ok(runtime.logs.some((line) => /Room connection lost/.test(line)), variant);
    assert.ok(!runtime.logs.some((line) => /stack|at async/.test(line)));
  }
});

test("P2c-04 local status reports load, version, connection and last error without secrets or bodies", async () => {
  const directory = await mkdtemp(join(home, "status-"));
  const path = join(directory, "status.json");
  const status = new LocalStatus(path, {plugin: "openclaw", version: packageJson.version, hostLabel: HOST_LABEL});
  const runtime = roomRuntime([message(2964, "owner-tj", "human_owner", "Your view?")], {credential: FAKE_CREDENTIAL});
  runtime.status = status;
  runtime.account.stateFile = join(directory, "zurie.json");
  runtime.client.register = async () => ({sessionId: "session-1", capabilities: []});
  await runtime.registerConnector();
  const connected = JSON.parse(await readFile(path, "utf8"));
  assert.equal(connected.rooms["room-1"].connection, "connected");
  runtime.reportStatus({connection: "reconnecting", errorCode: "network"});
  status.room("room-1", "", {gateWaitSeconds: 2.54});
  // A superseded reply: its body never reaches the status.
  runtime.pendingEvent = {id: "attemptready2970", seq: 2970};
  runtime.client.postMessage = async () => { throw new RoomAPIError(409, {code: "turn_expired"}); };
  runtime.client.roomState = async () => ({headSeq: 2970, activeEpoch: {id: "epoch-z", startsAtSeq: 2900}});
  runtime.client.requestTurn = async () => ({state: "granted", turnId: "turn-1"});
  await runtime.postAndFinish({roomId: "room-1", text: `Body that must not be in status ${KEPT_TEXT}`, replyToId: "m",
    idempotencyKey: "attemptready2970:final", sourceEventId: "attemptready2970"});
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.schema, "synthetic-sociality-room-status-v1");
  assert.deepEqual([written.plugin, written.version, written.pluginLoaded, written.hostLabel], ["openclaw", packageJson.version, true, HOST_LABEL]);
  const entry = written.rooms["room-1"];
  assert.deepEqual([entry.membershipId, entry.connection, entry.lastErrorCode, entry.lastGateWaitSeconds], ["zurie", "reconnecting", "network", 2.5]);
  assert.ok(entry.lastConnectedAt);
  // The schema is exactly the contract appendix, identical in Hermes.
  assert.deepEqual([...flattenKeys(written)].sort(), [...appendixKeys()].sort());
  // 0600, atomic (no temporary file left), no secret and no body.
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".status-")), []);
  const raw = await readFile(path, "utf8");
  for (const forbidden of [FAKE_CREDENTIAL, KEPT_TEXT, "Body that must"]) assert.ok(!raw.includes(forbidden), forbidden);
  // Unloaded on stop; an error code is a code, never free text.
  status.setLoaded(false);
  status.room("room-1", "", {errorCode: "Room said: secret body text"});
  const last = JSON.parse(await readFile(path, "utf8"));
  assert.equal(last.pluginLoaded, false);
  assert.equal(last.rooms["room-1"].lastErrorCode, "unknown_error");
});

test("P2c-04 local status reports load, version, connection and last error without secrets or bodies (load and stop)", async () => {
  // Part of P2c-04 (OP-12 F6): created when the gateway loads the plugin,
  // pluginLoaded false when the host stops; a CLI discovery pass writes nothing.
  const statusFile = join(STORE, "status.json");
  const register = async (registrationMode) => {
    resetLocalStatusWriters();
    await rm(statusFile, {force: true});
    const hooks = {};
    const api = new Proxy({registrationMode, config: ISOLATED_HOST_CONFIG, logger: {info() {}, warn() {}, error() {}},
      on(name, handler) { hooks[name] = handler; }}, {get: (target, property) => (property in target ? target[property] : () => undefined)});
    createRoomChannel({makeClient: () => null}).registerFull(api);
    return hooks;
  };
  const hooks = await register("full");
  const loaded = JSON.parse(await readFile(statusFile, "utf8"));
  assert.deepEqual([loaded.pluginLoaded, loaded.plugin, loaded.version, loaded.hostLabel], [true, "openclaw", packageJson.version, HOST_LABEL]);
  assert.equal(typeof hooks.gateway_stop, "function");
  await hooks.gateway_stop();
  assert.equal(JSON.parse(await readFile(statusFile, "utf8")).pluginLoaded, false);
  await register("tool-discovery");
  await assert.rejects(readFile(statusFile, "utf8"), /ENOENT/);
});

test("P2c-05 the reported host label comes from the current machine", async () => {
  // Wu moved from Mac128 to the Mac mini and still reported "Mac128". The
  // label is read from this machine when the process starts, never from
  // state or the account id, and every registration carries it.
  assert.equal(HOST_LABEL, hostname());
  const registrations = [];
  for (const [accountId, label] of [["Mac128", undefined], ["default", "Mac-mini"]]) {
    const runtime = new OpenClawRoomRuntime({accountId, stateFile: join(home, `p2c-05-${accountId}.json`), baseUrl: "https://room.example/api"},
      label ? {hostLabel: label} : {});
    runtime.state = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
      clientInstanceId: "client-1", cursor: 0};
    runtime.client = {register: async (_state, registration) => { registrations.push(registration.metadata.hostLabel); return {sessionId: "s", capabilities: []}; }};
    await runtime.registerConnector();
  }
  assert.deepEqual(registrations, [hostname(), "Mac-mini"]);
});
