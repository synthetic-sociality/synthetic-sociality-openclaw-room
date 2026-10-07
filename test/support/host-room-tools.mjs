// Contract P7d-4, case P7d-27: the registered Room tools through the installed
// OpenClaw host's own plugin loader, the host's own route resolution and REAL
// state files, with account state files the configuration names OUTSIDE the
// default directory (the recorded layout of the VPS gateway). A loopback Room
// double records the credential of every request. Run in a child process with
// a scratch HOME. Usage: node host-room-tools.mjs HOST_ROOT PLUGIN_ROOT
// Prints one JSON line.
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import http from "node:http";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [hostRoot, pluginRoot] = process.argv.slice(2);
const dist = join(hostRoot, "dist");
const ID = "synthetic-sociality-room";
const DOC = "synthetic_sociality_room_document";
const HIST = "synthetic_sociality_room_history";
// The gateway's OPENCLAW_STATE_DIR; the Room state lives elsewhere.
process.env.OPENCLAW_STATE_DIR = join(homedir(), "var-state");
const defaultAccounts = join(process.env.OPENCLAW_STATE_DIR, ID, "accounts");
const elsewhere = join(homedir(), "connector", ID, "accounts");
const unnamed = join(homedir(), "unnamed");
const guard = setTimeout(() => { process.stdout.write(`${JSON.stringify({error: "hang"})}\n`); process.exit(3); }, 100_000);

function findModule(marker) {
  const hits = readdirSync(dist).filter((name) => name.endsWith(".js") && readFileSync(join(dist, name), "utf8").includes(marker));
  if (hits.length !== 1) throw new Error(`expected one host module containing ${JSON.stringify(marker)}, found ${hits.length}`);
  return join(dist, hits[0]);
}
function exportAliases(file) {
  const last = readFileSync(file, "utf8").trimEnd().split("\n").at(-1);
  return Object.fromEntries([...last.matchAll(/(\w+) as (\w+)/g)].map(([, name, alias]) => [name, alias]));
}

const ROOMS = {
  rooma0000000001: {title: "Alpha", doc: "doca00000000001"},
  roomb0000000002: {title: "Beta", doc: "docb00000000002"},
  roomc0000000003: {title: "Gamma", doc: "docc00000000003"},
};
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const offset = parts[0] === "api" ? 1 : 0;
  const roomId = parts[offset + 1];
  requests.push({room: roomId, credential: String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")});
  const send = (status, body) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(body)); };
  const room = ROOMS[roomId];
  if (parts[offset] !== "rooms" || !room) return send(404, {code: "not_found", message: "no room"});
  const rest = parts.slice(offset + 2);
  const version = {versionId: "v00000000000001", name: `${room.title}.md`, extractionStatus: "ready", extractedText: `Text of ${room.title}.`};
  if (rest[0] === "state") {
    return send(200, {headSeq: 3, title: room.title, activeEpoch: {id: "epoch-z", startsAtSeq: 1}, roster: [], rules: [],
      activeTopic: {id: "t", title: "x", status: "active", description: null, documents: [{artifactId: room.doc, versionId: version.versionId,
        name: version.name, mimeType: "text/markdown", size: 1, sha256: "a".repeat(64), sourceSeq: 2, classification: "room_shared"}]}});
  }
  if (rest[0] === "artifacts" && rest.length === 1) return send(200, {items: []});
  if (rest[0] === "artifacts") {
    if (rest[1] !== room.doc) return send(404, {code: "not_found", message: "no artifact"});
    return send(200, {artifactId: room.doc, visibility: "room_shared", currentVersion: version, versions: [version]});
  }
  if (rest[0] === "events") {
    const after = Number(url.searchParams.get("after") || 0);
    const events = [{id: "e-1", seq: 1, type: "discussion.started", actorRole: "human_owner", actorId: "o", payload: {epoch: {id: "epoch-z", ordinal: 1, startsAtSeq: 1}}},
      {id: "e-2", seq: 2, type: "message.posted", actorRole: "human_owner", actorId: "o", payload: {body: `Message in ${room.title}.`, epochId: "epoch-z"}}];
    return send(200, {events: events.filter((item) => item.seq > after), hasMore: false, headSeq: 3});
  }
  return send(404, {code: "not_found", message: "route"});
});

const result = {};
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const writeState = (directory, name, roomId, credential) => {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    chmodSync(directory, 0o700);
    const file = join(directory, `${name}.json`);
    writeFileSync(file, JSON.stringify({version: 1, baseUrl: base, roomId, membershipId: `m-${name}`, credential, clientInstanceId: `c-${name}`, cursor: 0}), {mode: 0o600});
    return file;
  };
  // Agent zurie: ZX (Room A; an id the host normalises) and zb (Room B), both
  // named by the configuration outside the default directory, and zm, a
  // managed account in the default directory. Agent aura: ac (Room C) and ad
  // (Room A), outside. Not running: zoff (disabled) and a state file nobody
  // names.
  const files = {
    ZX: writeState(elsewhere, "ZX", "rooma0000000001", "cred-zx"),
    zb: writeState(join(homedir(), "other", "accounts"), "zb", "roomb0000000002", "cred-zb"),
    ac: writeState(elsewhere, "ac", "roomc0000000003", "cred-ac"),
    ad: writeState(elsewhere, "ad", "rooma0000000001", "cred-ad"),
    zoff: writeState(elsewhere, "zoff", "roomb0000000002", "cred-zoff"),
  };
  writeState(defaultAccounts, "zm", "roomb0000000002", "cred-zm");
  writeState(unnamed, "zu", "rooma0000000001", "cred-zu");
  const account = (name, extra = {}) => ({baseUrl: base, stateFile: files[name], ...extra});
  const cfg = {
    plugins: {enabled: true, load: {paths: [pluginRoot]}, entries: {[ID]: {enabled: true}}},
    agents: {list: [{id: "zurie", default: true}, {id: "aura"}]},
    bindings: [{agentId: "aura", match: {channel: ID, accountId: "ac"}}, {agentId: "aura", match: {channel: ID, accountId: "ad"}}],
    channels: {[ID]: {accounts: {ZX: account("ZX"), zb: account("zb"), ac: account("ac"), ad: account("ad"), zoff: account("zoff", {enabled: false})}}},
  };
  const loaderFile = findModule("function loadOpenClawPlugins(options = {}) {");
  const loadOpenClawPlugins = (await import(pathToFileURL(loaderFile).href))[exportAliases(loaderFile).loadOpenClawPlugins];
  const routing = await import(pathToFileURL(join(dist, "plugin-sdk", "routing.js")).href);
  const lines = [];
  const logger = {info: (line) => lines.push(String(line)), debug: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line))};
  const registry = loadOpenClawPlugins({config: cfg, workspaceDir: mkdtempSync(join(tmpdir(), "room-host-tools-")), onlyPluginIds: [ID], cache: false,
    activate: true, forceFullRuntimeForChannelPlugins: true, logger});
  const record = registry.plugins.find((plugin) => plugin.id === ID);
  result.plugin = record ? {failed: record.failedAt != null, toolNames: [...(record.toolNames ?? [])].sort()} : null;
  result.diagnostics = registry.diagnostics.filter((item) => !item.pluginId || item.pluginId === ID).map((item) => `${item.level}: ${String(item.message).split("\n")[0]}`);
  // The accounts the channel starts: the host's own rule (listAccountIds,
  // resolveAccount, isEnabled, isConfigured; server-channels startChannel).
  const channel = registry.channels.find((item) => item.plugin?.id === ID)?.plugin;
  result.started = channel ? channel.config.listAccountIds(cfg).filter((id) => {
    const resolved = channel.config.resolveAccount(cfg, id);
    return channel.config.isEnabled(resolved, cfg) && channel.config.isConfigured(resolved, cfg);
  }).sort() : null;
  const factory = (name) => registry.tools.find((tool) => tool.pluginId === ID && tool.names.includes(name))?.factory;
  const call = async (ctx, name, args) => {
    const before = requests.length;
    const answer = (await factory(name)(ctx).execute("call", args)).details;
    return {answer, requests: requests.slice(before).map((item) => `${item.room} ${item.credential}`)};
  };
  // The context as the host builds it for a tool (openclaw-tools: agentId of
  // the session key, sessionKey, sessionId, agentAccountId = the inbound
  // AccountId = the route's normalised account id).
  const roomTurn = (accountId, roomId) => {
    const route = routing.resolveAgentRoute({cfg, channel: ID, accountId, peer: {kind: "group", id: `${roomId}:epoch:${"ab".repeat(16)}`},
      parentPeer: {kind: "group", id: roomId}});
    return {config: cfg, getRuntimeConfig: () => cfg, agentId: routing.resolveAgentIdFromSessionKey(route.sessionKey), sessionKey: route.sessionKey,
      sessionId: `sess-${accountId}`, messageChannel: ID, agentAccountId: route.accountId};
  };
  const mainSession = (agentId) => ({config: cfg, getRuntimeConfig: () => cfg, agentId, sessionKey: `agent:${agentId}:main`, sessionId: `main-${agentId}`});
  const channelModule = await import(pathToFileURL(join(pluginRoot, "src", "channel.js")).href);
  const statusPath = channelModule.roomStatusPath(cfg);
  const documentTool = () => { try { return JSON.parse(readFileSync(statusPath, "utf8")).documentTool ?? null; } catch { return null; } };
  const zx = roomTurn("ZX", "rooma0000000001");
  const ad = roomTurn("ad", "rooma0000000001");
  const ac = roomTurn("ac", "roomc0000000003");
  result.contexts = {ZX: {agentId: zx.agentId, agentAccountId: zx.agentAccountId}, ad: {agentId: ad.agentId, agentAccountId: ad.agentAccountId},
    ac: {agentId: ac.agentId, agentAccountId: ac.agentAccountId}};
  result.statusBefore = documentTool();
  result.calls = {
    zxError: await call(zx, DOC, {artifactId: "docb00000000002"}),
  };
  result.statusAfterError = documentTool();
  Object.assign(result.calls, {
    zxDocument: await call(zx, DOC, {artifactId: "doca00000000001"}),
    zxHistory: await call(zx, HIST, {}),
    zxOtherRoom: await call(zx, DOC, {artifactId: "docb00000000002", room: "roomb0000000002"}),
    adDocument: await call(ad, DOC, {artifactId: "doca00000000001"}),
    acHistory: await call(ac, HIST, {}),
    acZurieRoom: await call(ac, HIST, {room: "rooma0000000001"}),
    zurieMain: await call(mainSession("zurie"), DOC, {artifactId: "doca00000000001"}),
    auraMain: await call(mainSession("aura"), HIST, {}),
    zurieNamesAura: await call(mainSession("zurie"), DOC, {artifactId: "docc00000000003", room: "ac"}),
    zurieRoomB: await call(mainSession("zurie"), DOC, {artifactId: "docb00000000002", room: "zb"}),
  });
  result.statusAfterRead = documentTool();
  result.logLines = lines.filter((line) => line.includes("document") || line.includes("history"));
} catch (error) {
  result.error = String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ");
}
clearTimeout(guard);
server.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
