// ISSUE-163 against the installed host: a Room turn whose command needs private
// approval, in a real OpenClaw gateway with the real exec tool, approval manager,
// reply dispatcher and follow-up. Only the two far ends are doubles: a scripted
// model on loopback, and the Room client behind the connector's channel.js (the
// connector's own src is copied unchanged). Run in a child process.
// Usage: node host-approval-turn.mjs HOST_ROOT PLUGIN_ROOT CASE
// Prints one JSON line.
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync} from "node:fs";
import http from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";

const [hostRoot, pluginRoot, caseName] = process.argv.slice(2);
const ID = "synthetic-sociality-room";
const THIRTY_MINUTES = 1_800_000;
// Each case ends minMs after the turn's acknowledgement once a post was seen, and
// at maxMs without one.
const CASES = {
  // ask=always: the host's approval is due; the fallback is the host default.
  "ask-always": {exec: {host: "gateway", security: "allowlist", ask: "always"}, minMs: 4_000, maxMs: 20_000},
  // The model tries another guarded command in the host's follow-up run.
  "follow-up-reruns": {exec: {host: "gateway", security: "allowlist", ask: "always"}, rerun: true, minMs: 6_000, maxMs: 25_000},
  // An operator who lets a command run when nobody answers: the host's fixed 30
  // minute approval timer is cut to 6 s here, so this case passes that moment.
  "fallback-full-expiry": {exec: {host: "gateway", security: "full", ask: "always"}, askFallback: "full", expiryMs: 6_000, minMs: 9_000, maxMs: 25_000},
};
const policy = CASES[caseName];
if (!policy) throw new Error(`unknown case ${caseName}`);

const scratch = mkdtempSync(join(tmpdir(), "room-163-"));
const home = join(scratch, "home");
const stateDir = join(home, ".openclaw");
const workspace = join(scratch, "workspace");
const pluginDir = join(scratch, "plugin");
const roomStore = join(scratch, "room-store");
const elsewhere = join(scratch, "elsewhere");
const reportFile = join(scratch, "report.jsonl");
const marker = join(elsewhere, "the-command-ran");
const rerunMarker = join(elsewhere, "the-second-command-ran");
for (const dir of [home, stateDir, workspace, pluginDir, roomStore, elsewhere]) mkdirSync(dir, {recursive: true, mode: 0o700});
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
writeFileSync(join(pluginDir, "entry.js"), `
import {appendFileSync} from "node:fs";
import {createRoomChannel} from "./src/channel.js";
const note = (kind, data = {}) => appendFileSync(${JSON.stringify(reportFile)}, JSON.stringify({at: Date.now(), kind, ...data}) + "\\n");
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

// The scripted model: the guarded command, then text. A follow-up prompt of the
// host names itself by its opening sentence.
const modelRequests = [];
let rerunDone = false;
function chunk(delta, finish = null) {
  return {id: "c", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{index: 0, delta, finish_reason: finish}]};
}
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => { body += part; });
  req.on("end", () => {
    const messages = JSON.parse(body || "{}").messages ?? [];
    const contentOf = (message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));
    const recent = messages.slice(-3).map(contentOf).join("\n");
    const followUp = /An async command (did not run|the user already approved)/.test(recent);
    const toolResult = messages.filter((message) => message.role === "tool").at(-1);
    const rerun = followUp && policy.rerun && !rerunDone;
    if (rerun) rerunDone = true;
    const answer = rerun ? null : followUp ? "FOLLOW-UP REPLY" : toolResult ? "REPLY AFTER THE TOOL RESULT" : null;
    const details = recent.indexOf("Exact completion details");
    modelRequests.push({
      at: Date.now(), followUp,
      toolResult: toolResult ? contentOf(toolResult).slice(0, 60) : undefined,
      followUpText: followUp ? recent.slice(details, details + 120) : undefined,
    });
    res.writeHead(200, {"content-type": "text/event-stream"});
    const chunks = answer !== null
      ? [chunk({role: "assistant", content: answer}), chunk({}, "stop")]
      : [chunk({role: "assistant", tool_calls: [{index: 0, id: "call_1", type: "function", function: {name: "exec", arguments: JSON.stringify({command: `touch ${rerun ? rerunMarker : marker}`})}}]}), chunk({}, "tool_calls")];
    for (const item of chunks) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
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
  agents: {defaults: {model: {primary: "mock/mock-1"}, workspace, skipBootstrap: true}},
  tools: {profile: "full", exec: policy.exec},
  plugins: {enabled: true, load: {paths: [pluginDir]}, entries: {[ID]: {enabled: true}}},
  channels: {[ID]: {enabled: true, baseUrl: "http://127.0.0.1:9/api", stateFile: join(roomStore, "room-state.json")}},
};
writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify(config, null, 1), {mode: 0o600});
if (policy.askFallback) {
  writeFileSync(join(stateDir, "exec-approvals.json"), JSON.stringify({version: 1, defaults: {askFallback: policy.askFallback}, agents: {}}), {mode: 0o600});
}

const preload = join(scratch, "timer.mjs");
writeFileSync(preload, `
const real = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...rest) => real(callback, ms === ${THIRTY_MINUTES} ? ${policy.expiryMs ?? THIRTY_MINUTES} : ms, ...rest);
`);

const env = {
  ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_NO_RESPAWN: "1", OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", JITI_FS_CACHE: "false",
  ...(policy.expiryMs ? {NODE_OPTIONS: `--import ${preload}`} : {}),
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
  return {
    case: caseName,
    modelRequests: modelRequests.slice(0, 12).map(second),
    turn: entries.filter((item) => ["settle", "skipped", "ack"].includes(item.kind)).map(second),
    posts: entries.filter((item) => item.kind === "post").map(second),
    denials: lines.filter((line) => line.includes("Room private approval denied")).length,
    commandRan: existsSync(marker) || existsSync(rerunMarker),
    logTail: extra.error ? lines.slice(-30).map((line) => line.slice(0, 240)) : undefined,
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
  const ack = entries.find((item) => item.kind === "ack");
  if (!ack) return;
  const waited = Date.now() - ack.at;
  if (waited >= policy.maxMs || (waited >= policy.minMs && entries.some((item) => item.kind === "post"))) finish();
}, 250);
