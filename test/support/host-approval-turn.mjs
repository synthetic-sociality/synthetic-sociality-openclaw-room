// ISSUE-163 against the installed host: a Room turn whose command needs private
// approval, in a real OpenClaw gateway with the real exec tool, approval manager,
// reply dispatcher and follow-up. Only the far ends are doubles: a scripted model on
// loopback, the Room client behind the connector's channel.js (the connector's own
// src is copied unchanged), and a private approval target where a case needs one.
// Run in a child process. Usage: node host-approval-turn.mjs HOST_ROOT PLUGIN_ROOT CASE
// Prints one JSON line.
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync} from "node:fs";
import http from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";

const [hostRoot, pluginRoot, caseName] = process.argv.slice(2);
const ID = "synthetic-sociality-room";
const DESK = "private-desk";
const THIRTY_MINUTES = 1_800_000;
const ASKS = {host: "gateway", security: "allowlist", ask: "always"};
const FULL_ASKS = {host: "gateway", security: "full", ask: "always"};
const ON_MISS = {host: "gateway", security: "allowlist", ask: "on-miss"};
const FORWARD_BOTH = {exec: {enabled: true, mode: "both", targets: [{channel: DESK, to: "owner"}]}};
// A case ends minMs after the turn's acknowledgement once a post was seen, at maxMs
// without one, or stopAtMs after the first model request whatever happened.
const CASES = {
  "default-policy": {minMs: 2_000, maxMs: 15_000},
  "ask-always": {exec: ASKS, minMs: 4_000, maxMs: 20_000},
  "on-miss-allowlisted": {exec: ON_MISS, allowlistTouch: true, minMs: 2_000, maxMs: 15_000},
  "on-miss-miss": {exec: ON_MISS, minMs: 2_000, maxMs: 15_000},
  // Allowlisted, but the host cannot enforce it and asks: with askFallback=allowlist
  // the expiry would run it, approved by nobody.
  "allowlist-wrapper": {exec: ON_MISS, allowlistTouch: true, askFallback: "allowlist", command: "bash -c 'touch MARKER'", expiryMs: 4_000, minMs: 7_000, maxMs: 25_000},
  "allowlist-glob": {exec: {host: "gateway", security: "allowlist", ask: "off"}, allowlistTouch: true, askFallback: "allowlist", command: "touch MARKER*", expiryMs: 4_000, minMs: 7_000, maxMs: 25_000},
  "strict-plain-command": {exec: {strictInlineEval: true}, minMs: 2_000, maxMs: 15_000},
  // Past the host's fixed 30 minute approval timer, cut to 4 s here.
  "fallback-full-expiry": {exec: FULL_ASKS, askFallback: "full", expiryMs: 4_000, minMs: 7_000, maxMs: 25_000},
  // The model asks for a guarded command for ever: the window is fixed, and longer
  // than the host waits for a follow-up (60 s, cut to 3 s).
  "stuck-model": {exec: ASKS, stuck: true, cutFollowUpWait: true, stopAtMs: 12_000},
  // The reply takes longer than the host waits for a follow-up (60 s, cut to 3 s).
  "slow-model": {exec: ASKS, replyDelayMs: 8_000, cutFollowUpWait: true, minMs: 2_000, maxMs: 25_000},
  "provider-error": {exec: ASKS, replyStatus: 500, minMs: 3_000, maxMs: 25_000, noPostMs: 6_000},
  // A subagent spawned in the Room turn asks for the guarded command.
  "subagent": {exec: FULL_ASKS, askFallback: "full", expiryMs: 4_000, subagent: true, stopAtMs: 14_000},
  "forward-session": {exec: ASKS, approvals: {exec: {enabled: true, mode: "session"}}, minMs: 3_000, maxMs: 15_000},
  // Forwarding that no person's private target serves.
  "target-filtered-out": {exec: ASKS, approvals: {exec: {...FORWARD_BOTH.exec, agentFilter: ["another-agent"]}}, desk: true, minMs: 2_000, maxMs: 15_000},
  "target-is-a-room": {exec: ASKS, approvals: {exec: {enabled: true, mode: "targets", targets: [{channel: ID, to: "another-room"}]}}, minMs: 2_000, maxMs: 15_000},
  "private-target-open": {exec: ASKS, approvals: FORWARD_BOTH, desk: true, noPostMs: 5_000},
  "private-target-answered": {exec: ASKS, approvals: FORWARD_BOTH, desk: "allow-once", minMs: 2_000, maxMs: 20_000},
  "private-target-denied-follow-up-fails": {exec: ASKS, approvals: FORWARD_BOTH, desk: "deny", followUpStatus: 500, noPostMs: 10_000},
  "private-target-fallback-full": {exec: FULL_ASKS, askFallback: "full", approvals: FORWARD_BOTH, desk: true, minMs: 2_000, maxMs: 15_000},
  "private-target-stuck": {exec: ASKS, approvals: FORWARD_BOTH, desk: true, stuck: true, stopAtMs: 10_000},
  // An operator's /exec override on the Room session, the configuration says nothing.
  "session-override-ask": {sessionExec: {execSecurity: "full", execAsk: "always"}, askFallback: "full", expiryMs: 4_000, minMs: 7_000, maxMs: 25_000},
  // The model's own reply carries approval text.
  "reply-echo": {exec: ASKS, reply: "Approval required: reply /approve abc allow-once.", noPostMs: 4_000},
};
const policy = CASES[caseName];
if (!policy) throw new Error(`unknown case ${caseName}`);

const scratch = mkdtempSync(join(tmpdir(), "room-163-"));
const home = join(scratch, "home");
const stateDir = join(home, ".openclaw");
const workspace = join(scratch, "workspace");
const pluginDir = join(scratch, "plugin");
const deskDir = join(scratch, "desk");
const roomStore = join(scratch, "room-store");
const elsewhere = join(scratch, "elsewhere");
const reportFile = join(scratch, "report.jsonl");
const marker = join(elsewhere, "the-command-ran");
for (const dir of [home, stateDir, workspace, pluginDir, deskDir, roomStore, elsewhere]) mkdirSync(dir, {recursive: true, mode: 0o700});
writeFileSync(reportFile, "");

const guard = setTimeout(() => finish({error: "hang"}, 3), 100_000);

// The connector's source, unchanged; the entry gives channel.js a Room client double.
cpSync(join(pluginRoot, "src"), join(pluginDir, "src"), {recursive: true});
mkdirSync(join(pluginDir, "node_modules"));
symlinkSync(hostRoot, join(pluginDir, "node_modules", "openclaw"));
writeFileSync(join(pluginDir, "openclaw.plugin.json"), readFileSync(join(pluginRoot, "openclaw.plugin.json")));
const packageJson = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
  name: packageJson.name, version: packageJson.version, type: "module", main: "entry.js",
  openclaw: {...packageJson.openclaw, extensions: ["./entry.js"]},
}));
const note = `const note = (kind, data = {}) => appendFileSync(${JSON.stringify(reportFile)}, JSON.stringify({at: Date.now(), kind, ...data}) + "\\n");`;
writeFileSync(join(pluginDir, "entry.js"), `
import {appendFileSync} from "node:fs";
import {createRoomChannel} from "./src/channel.js";
${note}
const untilAborted = (signal) => new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, {once: true}));
const event = {
  id: "evt-5", sourceEventId: "evt-5", respondsToId: "evt-5", roomId: "room-1", epochId: "epoch-1",
  conversationId: "room-1:epoch:epoch-1", senderId: "human-1", senderName: "Owner", senderKind: "human",
  text: "Please run the command.", occurredAt: Date.now(), raw: {seq: 5},
  cycleAttempt: {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1"}},
};
let posted = 0;
const makeClient = () => ({
  initialize: async () => ({sessionId: "room-session"}),
  assignedTurns: async function* (signal) { yield event; await untilAborted(signal); },
  markTurnReading: async () => {},
  postAndFinish: async (request) => {
    note("post", {text: request.text, literal: request.literal === true, sourceEventId: request.sourceEventId ?? ""});
    posted += 1;
    return {eventId: "posted-" + posted, sentAt: Date.now()};
  },
  settleDiscussionAttempt: async (_attempt, action) => note("settle", {action}),
  recordSkipped: async (_id, reason) => note("skipped", {reason}),
  ack: async () => note("ack"),
  close: async () => {},
});
export default createRoomChannel({makeClient});
`);

// The private target: a person who answers at once, or (desk: true) who never does.
if (policy.desk) {
  mkdirSync(join(deskDir, "node_modules"));
  symlinkSync(hostRoot, join(deskDir, "node_modules", "openclaw"));
  writeFileSync(join(deskDir, "openclaw.plugin.json"), JSON.stringify({
    id: DESK, name: "Private desk", activation: {onStartup: true}, channels: [DESK],
    configSchema: {type: "object", additionalProperties: true},
    channelConfigs: {[DESK]: {schema: {type: "object", additionalProperties: true}}},
  }));
  writeFileSync(join(deskDir, "package.json"), JSON.stringify({
    name: "private-desk", version: "1.0.0", type: "module", main: "entry.js",
    openclaw: {extensions: ["./entry.js"], channel: {id: DESK, label: "Private desk", selectionLabel: "Private desk", docsPath: "README.md", blurb: "test"}},
  }));
  writeFileSync(join(deskDir, "entry.js"), `
import {appendFileSync} from "node:fs";
import {defineChannelPluginEntry} from "openclaw/plugin-sdk/channel-core";
import {defineChannelMessageAdapter} from "openclaw/plugin-sdk/channel-message";
import {resolveApprovalOverGateway} from "openclaw/plugin-sdk/approval-gateway-runtime";
${note}
const answer = ${JSON.stringify(typeof policy.desk === "string" ? policy.desk : "")};
const sent = (id) => ({messageId: id, receipt: {primaryPlatformMessageId: id, platformMessageIds: [id], parts: [{platformMessageId: id, kind: "text", index: 0}], sentAt: Date.now()}});
let count = 0;
const message = defineChannelMessageAdapter({
  receive: {defaultAckPolicy: "manual", supportedAckPolicies: ["manual"]},
  send: {text: async (ctx) => {
    note("desk", {text: String(ctx.text).slice(0, 60)});
    const id = /ID: ([0-9a-f-]{36})/.exec(String(ctx.text))?.[1];
    if (id && answer) setTimeout(() => resolveApprovalOverGateway({cfg: ctx.cfg, approvalId: id, decision: answer, clientDisplayName: "Owner"}).catch((error) => note("desk-error", {error: String(error)})), 200);
    count += 1;
    return sent("desk-" + count);
  }},
});
export default defineChannelPluginEntry({
  id: ${JSON.stringify(DESK)}, name: "Private desk", description: "test",
  plugin: {
    id: ${JSON.stringify(DESK)},
    meta: {id: ${JSON.stringify(DESK)}, label: "Private desk", selectionLabel: "Private desk", docsPath: "README.md", blurb: "test"},
    capabilities: {chatTypes: ["direct"]},
    config: {listAccountIds: () => ["default"], resolveAccount: () => ({accountId: "default", enabled: true, configured: true}), isEnabled: () => true, isConfigured: () => true},
    message,
  },
});
`);
}

// The scripted model. Only a Room event, the host's follow-up and the spawned
// subagent get the guarded command; anything else the host asks gets plain text.
const modelRequests = [];
const contentOf = (message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));
function chunk(delta, finish = null) {
  return {id: "c", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{index: 0, delta, finish_reason: finish}]};
}
const call = (name, args) => ({name, args});
const guardedCommand = () => call("exec", {command: (policy.command ?? "touch MARKER").replace("MARKER", marker)});
function script(messages) {
  const system = messages.filter((message) => message.role === "system" || message.role === "developer").map(contentOf).join("\n");
  const users = messages.map((message, index) => ({message, index})).filter(({message}) => message.role === "user" && !contentOf(message).startsWith("[{\"type\":\"text\",\"text\":\"OpenClaw runtime context"));
  const last = users.at(-1);
  const lastUser = last ? contentOf(last.message) : "";
  const toolResult = messages.slice(last ? last.index + 1 : 0).filter((message) => message.role === "tool").at(-1);
  const followUp = /An async command (did not run|the user already approved)/.test(lastUser);
  const roomEvent = /Please run the command/.test(lastUser);
  const subagent = /# Subagent Context/.test(system);
  const details = lastUser.indexOf("Exact completion details");
  const seen = {followUp, subagent, toolResult: toolResult ? contentOf(toolResult).slice(0, 70) : undefined, followUpText: followUp ? lastUser.slice(details, details + 110) : undefined};
  if (followUp) return {seen, text: "FOLLOW-UP REPLY", status: policy.followUpStatus};
  if (subagent) return {seen, ...(toolResult ? {text: "SUBAGENT DONE"} : {tools: [guardedCommand()]})};
  if (!roomEvent) return {seen, text: "OK"};
  if (policy.stuck) return {seen, tools: [guardedCommand()]};
  if (policy.subagent) return {seen, ...(toolResult ? {text: "REPLY AFTER THE SPAWN"} : {tools: [call("sessions_spawn", {task: "run the command", mode: "run"})]})};
  if (!toolResult) return {seen, tools: [guardedCommand()]};
  return {seen, text: policy.reply ?? "REPLY AFTER THE TOOL RESULT", status: policy.replyStatus, delay: policy.replyDelayMs};
}
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => { body += part; });
  req.on("end", () => {
    const {seen, text, tools, status, delay} = script(JSON.parse(body || "{}").messages ?? []);
    modelRequests.push({at: Date.now(), ...seen});
    setTimeout(() => {
      if (status) {
        res.writeHead(status, {"content-type": "application/json"});
        res.end(JSON.stringify({error: {message: "upstream failed", type: "server_error"}}));
        return;
      }
      res.writeHead(200, {"content-type": "text/event-stream"});
      const chunks = tools
        ? [chunk({role: "assistant", tool_calls: tools.map((tool, index) => ({index, id: `call_${index}_${modelRequests.length}`, type: "function", function: {name: tool.name, arguments: JSON.stringify(tool.args)}}))}), chunk({}, "tool_calls")]
        : [chunk({role: "assistant", content: text}), chunk({}, "stop")];
      for (const item of chunks) res.write(`data: ${JSON.stringify(item)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, delay ?? 0);
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
  });
}
const port = await freePort();
const token = randomBytes(16).toString("hex");
const config = {
  gateway: {mode: "local", port, bind: "loopback", auth: {mode: "token", token}, controlUi: {enabled: false}},
  models: {mode: "replace", providers: {mock: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "test-only-not-a-key", api: "openai-completions",
    models: [{id: "mock-1", name: "mock-1", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
  }}},
  // No heartbeat: its run is not a Room turn and must not fall inside a window.
  agents: {defaults: {model: {primary: "mock/mock-1"}, workspace, skipBootstrap: true, heartbeat: {every: "0m"}}},
  tools: {profile: "full", ...(policy.exec ? {exec: policy.exec} : {})},
  ...(policy.approvals ? {approvals: policy.approvals} : {}),
  plugins: {enabled: true, load: {paths: [pluginDir, ...(policy.desk ? [deskDir] : [])]}, entries: {[ID]: {enabled: true}, ...(policy.desk ? {[DESK]: {enabled: true}} : {})}},
  channels: {[ID]: {enabled: true, baseUrl: "http://127.0.0.1:9/api", stateFile: join(roomStore, "room-state.json")}, ...(policy.desk ? {[DESK]: {enabled: true}} : {})},
};
writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify(config, null, 1), {mode: 0o600});
if (policy.askFallback || policy.allowlistTouch) {
  writeFileSync(join(stateDir, "exec-approvals.json"), JSON.stringify({
    version: 1, defaults: policy.askFallback ? {askFallback: policy.askFallback} : {},
    agents: policy.allowlistTouch ? {main: {allowlist: [{pattern: "**/touch"}]}} : {},
  }), {mode: 0o600});
}

if (policy.sessionExec) {
  const sessions = join(stateDir, "agents", "main", "sessions");
  mkdirSync(sessions, {recursive: true, mode: 0o700});
  writeFileSync(join(sessions, "sessions.json"), JSON.stringify({
    "agent:main:synthetic-sociality-room:group:room-1:epoch:epoch-1": {sessionId: "room-session-1", updatedAt: Date.now(), ...policy.sessionExec},
  }), {mode: 0o600});
}

// Test only: the host's fixed timers are shortened, every other timer stays.
const cut = {...(policy.expiryMs ? {[THIRTY_MINUTES]: policy.expiryMs} : {}), ...(policy.cutFollowUpWait ? {60000: 3000, 62000: 5000} : {})};
const preload = join(scratch, "timer.mjs");
writeFileSync(preload, `
const real = globalThis.setTimeout;
const cut = ${JSON.stringify(cut)};
globalThis.setTimeout = (callback, ms, ...rest) => real(callback, cut[ms] ?? ms, ...rest);
`);

const env = {
  ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: "1", OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", JITI_FS_CACHE: "false",
  ...(Object.keys(cut).length ? {NODE_OPTIONS: `--import ${preload}`} : {}),
};
let output = "";
const gateway = spawn(process.execPath, [join(hostRoot, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--allow-unconfigured"], {env, cwd: workspace, stdio: ["ignore", "pipe", "pipe"]});
gateway.stdout.on("data", (part) => { output += part; });
gateway.stderr.on("data", (part) => { output += part; });

function report() {
  return readFileSync(reportFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function result(extra) {
  const entries = report();
  const firstModel = modelRequests[0]?.at ?? Date.now();
  const second = ({at, ...item}) => ({...item, second: Math.round((at - firstModel) / 100) / 10});
  const lines = output.split("\n");
  const counted = (text) => lines.filter((line) => line.includes(text)).length;
  return {
    case: caseName,
    modelCount: modelRequests.length,
    followUps: modelRequests.filter((item) => item.followUp).length,
    modelRequests: modelRequests.slice(0, 8).map(second),
    turn: entries.filter((item) => ["settle", "skipped", "ack"].includes(item.kind)).map(second),
    posts: entries.filter((item) => item.kind === "post").map(second),
    desk: entries.filter((item) => item.kind === "desk").map(second),
    deskErrors: entries.filter((item) => item.kind === "desk-error").map(second),
    refusals: counted("Room connector refused an exec call"),
    withheld: counted("private approval text"),
    commandRan: existsSync(marker),
    logTail: extra.error || process.env.ROOM163_LOG ? lines.slice(-40).map((line) => line.slice(0, 240)) : undefined,
    ...extra,
  };
}
let finished = false;
function finish(extra = {}, code = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(guard);
  writeSync(1, `${JSON.stringify(result(extra))}\n`);
  gateway.kill("SIGKILL");
  model.close();
  rmSync(scratch, {recursive: true, force: true, maxRetries: 2});
  process.exit(code);
}
gateway.on("exit", (code) => { if (!finished) finish({error: `gateway exited ${code}`}, 4); });

setInterval(() => {
  const entries = report();
  const firstModel = modelRequests[0]?.at;
  if (policy.stopAtMs && firstModel && Date.now() - firstModel >= policy.stopAtMs) return finish();
  const ack = entries.find((item) => item.kind === "ack");
  if (!ack) return undefined;
  const waited = Date.now() - ack.at;
  if (policy.noPostMs && waited >= policy.noPostMs) return finish();
  if (policy.maxMs && waited >= policy.maxMs) return finish();
  if (policy.minMs && waited >= policy.minMs && entries.some((item) => item.kind === "post")) return finish();
  return undefined;
}, 250);
