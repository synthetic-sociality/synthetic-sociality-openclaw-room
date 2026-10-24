// README "Room tools under a tool profile" (OpenClaw Room 0.2.73, ISSUE-116):
// a host tool profile strips the Room tools from every Room turn unless
// tools.alsoAllow grants them; the connector reports the gap once at account
// start (reporting only) and the account starts. No test uses a real credential.
import assert from "node:assert/strict";
import test, {after} from "node:test";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {registerHooks} from "node:module";
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

const home = await mkdtemp(join(tmpdir(), "openclaw-room-tool-grant-"));
after(() => rm(home, {recursive: true, force: true}));
process.env.OPENCLAW_STATE_DIR = join(home, "openclaw");
const STORE = join(home, "openclaw", "synthetic-sociality-room");
await mkdir(join(STORE, "accounts"), {recursive: true, mode: 0o700});

const {ROOM_TURN_TOOLS, TOOLS_NOT_GRANTED, roomToolGrantGaps} = await import("../src/secret-isolation.js");
const {createRoomChannel, resetToolGrantWarningLog} = await import("../src/channel.js");
const {resetLocalStatusWriters} = await import("../src/local-status.js");

const ROOM_TOOLS = ["synthetic_sociality_room_share_file", "synthetic_sociality_room_document", "synthetic_sociality_room_history"];

test("a tool profile without the additive grant is reported per scope; the grant, no profile and an unreadable config report nothing", () => {
  assert.deepEqual([...ROOM_TURN_TOOLS], ROOM_TOOLS);
  assert.equal(TOOLS_NOT_GRANTED, "room_tools_not_granted");
  assert.deepEqual(roomToolGrantGaps({}), []);
  assert.deepEqual(roomToolGrantGaps(undefined), []);
  assert.deepEqual(roomToolGrantGaps(null), []);
  assert.deepEqual(roomToolGrantGaps("tools"), []);
  assert.deepEqual(roomToolGrantGaps(ISOLATED_HOST_CONFIG), []);
  // The fleet configuration found on 2026-10-24: profile coding, alsoAllow [message].
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding", alsoAllow: ["message"]}}), [{scope: "gateway", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding", alsoAllow: ["message", ...ROOM_TOOLS]}}), []);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding", alsoAllow: ["message", ROOM_TOOLS[0]]}}), [{scope: "gateway", missing: ROOM_TOOLS.slice(1)}]);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding"}}), [{scope: "gateway", missing: ROOM_TOOLS}]);
  // An explicit allow list selects tools too; a Room tool on the list counts as granted.
  assert.deepEqual(roomToolGrantGaps({tools: {allow: ["read", "message"]}}), [{scope: "gateway", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {allow: ["read", ...ROOM_TOOLS]}}), []);
  // Per-agent sections: an agent entry with its own tools section is a scope of its own, one without inherits the gateway's;
  // a grant on either the gateway or the entry counts.
  assert.deepEqual(roomToolGrantGaps({agents: {list: [{id: "zurie", tools: {profile: "coding"}}, {id: "aura"}]}}), [{scope: "zurie", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {alsoAllow: ROOM_TOOLS}, agents: {list: [{id: "zurie", tools: {profile: "coding"}}]}}), []);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding"}, agents: {list: [{id: "zurie", tools: {alsoAllow: ROOM_TOOLS}}]}}),
    [{scope: "gateway", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding", alsoAllow: ["message"]}, agents: {list: [{id: "zurie", tools: {alsoAllow: ROOM_TOOLS}}, {id: "aura", tools: {profile: "coding"}}]}}),
    [{scope: "gateway", missing: ROOM_TOOLS}, {scope: "aura", missing: ROOM_TOOLS}]);
  // Malformed values never throw and never grant.
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding", alsoAllow: 7}}), [{scope: "gateway", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding"}, agents: {list: [null, 4, {id: "x", tools: "coding"}, {tools: ["coding"]}]}}),
    [{scope: "gateway", missing: ROOM_TOOLS}]);
  assert.deepEqual(roomToolGrantGaps({tools: {profile: "coding"}, agents: {list: [{tools: {profile: "coding"}}]}}),
    [{scope: "gateway", missing: ROOM_TOOLS}, {scope: "agent", missing: ROOM_TOOLS}]);
});

test("at account start the gap is logged once per process with the scope and the missing tools, and the account starts even when the warning sink fails", async () => {
  const stateFile = join(STORE, "accounts", "zurie.json");
  await writeFile(stateFile, JSON.stringify({credential: `room-cred-TEST-${"0f1e2d3c".repeat(4)}`}), {mode: 0o600});
  const startTwice = async (cfg, {warnThrows = false} = {}) => {
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
        log: {info: () => {}, warn: (line) => { lines.warn.push(line); if (warnThrows && line.includes(TOOLS_NOT_GRANTED)) throw new Error("synthetic warning sink unavailable"); }, error: (line) => lines.error.push(line)},
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await running;
      return status;
    };
    resetToolGrantWarningLog();
    await run();
    await run();
    return {made, lines};
  };
  const stripped = await startTwice({...ISOLATED_HOST_CONFIG, tools: {...ISOLATED_HOST_CONFIG.tools, profile: "coding", alsoAllow: ["message"]}});
  assert.equal(stripped.made, 2, "reporting only: the account starts");
  assert.equal(stripped.lines.error.length, 0);
  const reports = stripped.lines.warn.filter((line) => line.includes(TOOLS_NOT_GRANTED));
  assert.equal(reports.length, 1, "logged once per process");
  assert.match(reports[0], /\(gateway: synthetic_sociality_room_share_file synthetic_sociality_room_document synthetic_sociality_room_history\)/);
  assert.match(reports[0], /tools\.alsoAllow/);
  assert.doesNotMatch(reports[0], /room-cred-TEST/);
  const granted = await startTwice({...ISOLATED_HOST_CONFIG, tools: {...ISOLATED_HOST_CONFIG.tools, profile: "coding", alsoAllow: ["message", ...ROOM_TOOLS]}});
  assert.equal(granted.made, 2);
  assert.equal(granted.lines.warn.filter((line) => line.includes(TOOLS_NOT_GRANTED)).length, 0);
  // OP-12 round 1 (2026-10-24, P2): a failing warning sink never touches the account start; the warning is attempted
  // once (the flag is set before the sink is called) and the start proceeds.
  const noisy = await startTwice({...ISOLATED_HOST_CONFIG, tools: {...ISOLATED_HOST_CONFIG.tools, profile: "coding", alsoAllow: ["message"]}}, {warnThrows: true});
  assert.equal(noisy.made, 2, "a throwing warn logger does not stop the account");
  assert.equal(noisy.lines.error.length, 0);
  assert.equal(noisy.lines.warn.filter((line) => line.includes(TOOLS_NOT_GRANTED)).length, 1);
  const noProfile = await startTwice(ISOLATED_HOST_CONFIG);
  assert.equal(noProfile.made, 2);
  assert.equal(noProfile.lines.warn.filter((line) => line.includes(TOOLS_NOT_GRANTED)).length, 0);
});
