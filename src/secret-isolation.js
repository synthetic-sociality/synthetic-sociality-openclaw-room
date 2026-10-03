// Contract P2c-1: the Room credential store is out of the agent's tools' reach.
//
// OpenClaw's fs tools read any absolute path unless tools.fs.workspaceOnly is
// set, and its exec/process tools run as the gateway's own OS user on the
// gateway host unless they are denied or sandboxed. Nothing in this process can
// fence a host shell, so the connector:
//
// 1. reports whether the store is reachable (storeReachability): fs tools not
//    workspace-only, a workspace that contains the store, or host shell tools
//    (not denied, not sandboxed for every agent, elevated on, a sandbox bind
//    over the store); it refuses to start while the store is reachable only
//    when the installation enables enforceSecretIsolation
//    (plugins.entries.synthetic-sociality-room.config);
// 2. blocks, in every session, any tool call whose path arguments resolve into
//    the store (or, for a search, contain it), and any shell call that names it
//    (toolCallBlock); a hook error blocks;
// 3. removes the exact credential and renewal secret values from persisted tool
//    results and from its own log lines (scrub).
//
// Before enforcement is switched on, the host configuration is set. Reason
// codes never contain a path or a secret.
import {realpathSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";

export const REFUSAL_CODE = "secret_store_reachable";
// The per-installation switch: off reports and keeps running, on refuses.
export const ENFORCEMENT_SETTING = "enforceSecretIsolation";

// The installation's switch, read from the plugin's own config entry. The
// manifest declares it boolean; only boolean true enables enforcement.
export function secretIsolationEnforced(cfg, pluginId = "synthetic-sociality-room") {
  return cfg?.plugins?.entries?.[pluginId]?.config?.[ENFORCEMENT_SETTING] === true;
}
export const BLOCK_MESSAGE = "Blocked by the Synthetic Sociality Room connector: its private state holds the Room credential and is not available to agent tools.";
export const REDACTED = "[redacted Room credential]";
export const STORE_DIRECTORY_NAME = "synthetic-sociality-room";
const SHELL_TOOLS = new Set(["exec", "bash", "process"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls", "glob", "search", "list"]);
// Contract P3-6: path arguments always resolved, whatever their shape.
const KNOWN_PATH_KEYS = ["path", "file_path", "file", "cwd", "dir", "directory", "root", "workdir"];
const RUNTIME_DENIES = new Set(["*", "group:runtime"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const SECRET_KEY = /credential|secret|token/i;
const MIN_SECRET_LENGTH = 16;

const secretValues = new Set();

function expandHome(value, home = homedir()) {
  const text = String(value);
  if (text === "~") return home;
  if (text.startsWith("~/")) return join(home, text.slice(2));
  return text;
}

// The real path of `value`, resolving the longest existing prefix so a path
// that does not exist yet still resolves its symlinked ancestors.
export function resolvedPath(value, base = process.cwd()) {
  const absolute = resolve(base, expandHome(value));
  let head = absolute;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(head.slice(parent.length).replace(/^[/\\]+/, ""));
      head = parent;
    }
  }
}

function within(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path) && path.split(sep)[0] !== "..");
}

function overlaps(left, right) {
  return within(left, right) || within(right, left);
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()) : [];
}

function deniesRuntime(tools) {
  const deny = new Set(list(tools?.deny));
  return [...RUNTIME_DENIES].some((item) => deny.has(item)) || (deny.has("exec") && deny.has("process"));
}

function deniesFs(tools) {
  const deny = new Set(list(tools?.deny));
  return deny.has("*") || deny.has("group:fs") || ["read", "write", "edit", "apply_patch"].every((item) => deny.has(item));
}

// Contract L1-15: the host's tool selection could not be read; unknown counts
// as reaching the store.
export const TOOL_SELECTION_UNAVAILABLE = "tool_selection_unavailable";

// Reason codes for which the agent's tools can reach the store; [] if none.
// Never throws: a host configuration that cannot be read is reachable.
export function storeReachability(cfg, storeDirectories, options = {}) {
  try {
    const reasons = storeReachabilityOf(cfg, typeof storeDirectories === "function" ? storeDirectories() : storeDirectories, options);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) reasons.push(TOOL_SELECTION_UNAVAILABLE);
    return reasons;
  } catch {
    return [TOOL_SELECTION_UNAVAILABLE];
  }
}

function storeReachabilityOf(cfg, storeDirectories, {stateDir = "", home = homedir()} = {}) {
  const reasons = new Set();
  const stores = [...new Set(storeDirectories.filter(Boolean).map((item) => resolvedPath(item)))];
  const tools = cfg?.tools ?? {};
  const defaults = cfg?.agents?.defaults ?? {};
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list.filter((item) => item && typeof item === "object") : [];

  // File tools: workspace-only for every agent (or denied).
  const fsFenced = (agentTools) => deniesFs(tools) || deniesFs(agentTools)
    || (agentTools?.fs?.workspaceOnly ?? tools?.fs?.workspaceOnly) === true;
  if (!fsFenced(undefined) || agents.some((agent) => !fsFenced(agent.tools))) reasons.add("fs_tools_unfenced");
  if ((tools?.exec?.applyPatch?.workspaceOnly ?? true) !== true) reasons.add("fs_tools_unfenced");
  const workspaces = [defaults.workspace, ...agents.map((agent) => agent.workspace)]
    .filter((item) => typeof item === "string" && item.trim());
  if (!defaults.workspace && stateDir) workspaces.push(join(stateDir, "workspace"));
  if (workspaces.some((workspace) => stores.some((store) => within(store, resolvedPath(workspace, home))))) {
    reasons.add("workspace_covers_store");
  }

  // Shell tools: denied, or sandboxed for every agent with no bind over the store.
  const sandboxAll = (agent) => (agent?.sandbox?.mode ?? defaults?.sandbox?.mode) === "all";
  const hostExec = (agentTools) => ["gateway", "node"].includes(String(agentTools?.exec?.host ?? tools?.exec?.host ?? "auto"));
  const shellFenced = (agent) => deniesRuntime(tools) || deniesRuntime(agent?.tools)
    || (sandboxAll(agent) && !hostExec(agent?.tools) && (agent?.tools?.elevated?.enabled ?? tools?.elevated?.enabled) === false);
  if (!shellFenced(undefined) || agents.some((agent) => !shellFenced(agent))) reasons.add("host_shell_tools");
  const binds = [defaults?.sandbox?.docker?.binds, ...agents.map((agent) => agent?.sandbox?.docker?.binds)]
    .flatMap((item) => (Array.isArray(item) ? item : []));
  if (binds.some((bind) => {
    const host = String(bind).split(":")[0].trim();
    return host && (host.startsWith("/") || host.startsWith("~")) && stores.some((store) => overlaps(resolvedPath(host, home), store));
  })) reasons.add("sandbox_bind_covers_store");
  // Contract P3-7: tools outside both routes. `nodes` runs commands on paired
  // devices (the computer-use / remote-command class; a paired node can be
  // this host); an enabled MCP server runs on the gateway host.
  const deniesNodes = (agentTools) => {
    const deny = new Set([...list(tools?.deny), ...list(agentTools?.deny)]);
    return deny.has("*") || deny.has("nodes") || deny.has("group:nodes");
  };
  if (!deniesNodes(undefined) || agents.some((agent) => !deniesNodes(agent.tools))) reasons.add("remote_command_tool");
  const servers = cfg?.mcp?.servers;
  if (servers && typeof servers === "object" && Object.values(servers).some((entry) => !(entry && entry.enabled === false))) {
    reasons.add("mcp_server_enabled");
  }
  return [...reasons];
}

function* stringLeaves(value, depth = 0) {
  if (depth > 6) return;
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringLeaves(item, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* stringLeaves(item, depth + 1);
}

function* pathCandidates(toolName, params, derivedPaths) {
  // Contract P3-6: a known path argument is a path whatever its shape
  // ("synthetic-sociality-room", "state.json").
  for (const key of KNOWN_PATH_KEYS) {
    const value = params && typeof params === "object" ? params[key] : undefined;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && item.trim() && item.length < 4096 && !item.includes("\n")) yield item.trim();
    }
  }
  for (const text of stringLeaves(params)) {
    const candidate = text.trim();
    if (candidate && candidate.length < 4096 && !candidate.includes("\n") && (
      /^[/~.]/.test(candidate) || (candidate.includes("/") && !/\s/.test(candidate))
    )) yield candidate;
    if (toolName === "apply_patch" || text.includes("*** ")) {
      for (const match of text.matchAll(PATCH_FILE_LINE)) yield String(match[1] ?? match[2] ?? "").trim();
    }
  }
  for (const item of Array.isArray(derivedPaths) ? derivedPaths : []) if (typeof item === "string") yield item;
}

// The block reason for a tool call that would reach the store, else null.
// The ways a command can name the store itself: its absolute and resolved
// path, and the same path written from ~, $HOME or $OPENCLAW_STATE_DIR. The
// bare directory name is not one: a plugin directory or a command argument
// naming the plugin is not the store.
export function storeSpellings(storeDirectories, {stateDir = "", home = homedir()} = {}) {
  const paths = new Set();
  for (const item of storeDirectories.filter(Boolean)) {
    paths.add(resolve(expandHome(item, home)));
    paths.add(resolvedPath(item));
  }
  const prefixes = [[home, ["~", "$HOME", "${HOME}"]]];
  if (stateDir) for (const root of new Set([resolve(stateDir), resolvedPath(stateDir)])) prefixes.push([root, ["$OPENCLAW_STATE_DIR", "${OPENCLAW_STATE_DIR}"]]);
  const spellings = new Set(paths);
  for (const path of paths) {
    for (const [root, names] of prefixes) {
      const base = String(root).replace(/[/\\]+$/, "");
      if (base && path.startsWith(`${base}${sep}`)) for (const name of names) spellings.add(`${name}${path.slice(base.length)}`);
    }
  }
  spellings.delete("/");
  return [...spellings].filter(Boolean);
}

// The workspace an agent's relative tool paths resolve against, as the host
// resolves it (resolveAgentWorkspaceDir): the agent's workspace, else the
// defaults' workspace (joined with the id for a non-default agent), else
// <stateDir>/workspace or <stateDir>/workspace-<id>.
export function agentWorkspace(cfg, agentId, {stateDir = "", home = homedir()} = {}) {
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list.filter((item) => item && typeof item === "object") : [];
  const id = String(agentId ?? "").trim().toLowerCase() || "main";
  const configured = list.find((agent) => String(agent.id ?? "").trim().toLowerCase() === id)?.workspace;
  if (typeof configured === "string" && configured.trim()) return resolve(expandHome(configured.trim(), home));
  const defaultId = String((list.find((agent) => agent.default) ?? list[0])?.id ?? "main").trim().toLowerCase() || "main";
  const fallback = typeof cfg?.agents?.defaults?.workspace === "string" ? cfg.agents.defaults.workspace.trim() : "";
  if (id === defaultId) return fallback ? resolve(expandHome(fallback, home)) : join(stateDir, "workspace");
  return fallback ? join(resolve(expandHome(fallback, home)), id) : join(stateDir, `workspace-${id}`);
}

export function toolCallBlock(toolName, params, storeDirectories, {cwd = process.cwd(), derivedPaths, stateDir = ""} = {}) {
  const name = String(toolName ?? "").toLowerCase();
  const stores = storeDirectories.filter(Boolean).map((item) => resolvedPath(item));
  if (SHELL_TOOLS.has(name)) {
    // Backstop only: a command string cannot be fenced reliably. The start
    // gate keeps shell tools denied or sandboxed away from the store.
    const names = storeSpellings(storeDirectories, {stateDir});
    for (const text of stringLeaves(params)) if (names.some((item) => text.includes(item))) return BLOCK_MESSAGE;
  }
  // A search without a path searches its cwd.
  if (SEARCH_TOOLS.has(name) && !String(params?.path ?? params?.cwd ?? params?.dir ?? "").trim()) {
    const root = resolvedPath(cwd);
    if (stores.some((store) => within(store, root))) return BLOCK_MESSAGE;
  }
  for (const candidate of pathCandidates(name, params, derivedPaths)) {
    if (!candidate) continue;
    const target = resolvedPath(candidate, cwd);
    if (stores.some((store) => within(target, store) || (SEARCH_TOOLS.has(name) && within(store, target)))) return BLOCK_MESSAGE;
  }
  return null;
}

function journalSecrets(value, key = "", depth = 0, found = new Set()) {
  if (depth > 6) return found;
  if (Array.isArray(value)) for (const item of value) journalSecrets(item, key, depth + 1, found);
  else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) journalSecrets(item, name, depth + 1, found);
  else if (typeof value === "string" && SECRET_KEY.test(key) && value.length >= MIN_SECRET_LENGTH) found.add(value);
  return found;
}

// Record the exact secret values of a Room state for scrubbing.
export function rememberSecrets(state) {
  if (typeof state?.credential === "string" && state.credential.length >= MIN_SECRET_LENGTH) secretValues.add(state.credential);
  for (const value of journalSecrets(state?.credentialRotation ?? {})) secretValues.add(value);
}

export function forgetSecrets() {
  secretValues.clear();
}

export function scrub(text) {
  if (typeof text !== "string" || !text) return text;
  let result = text;
  for (const value of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (result.includes(value)) result = result.split(value).join(REDACTED);
  }
  return result;
}

// A deep copy of `value` with every string scrubbed; the same object when clean.
export function scrubDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) {
    const next = value.map((item) => scrubDeep(item, depth + 1));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = scrubDeep(item, depth + 1);
      if (next[key] !== item) changed = true;
    }
    return changed ? next : value;
  }
  return value;
}

// A logger whose messages never carry a remembered secret.
export function scrubbingLogger(logger) {
  if (!logger) return logger;
  const wrap = (level) => (typeof logger[level] === "function" ? (message, ...rest) => logger[level](scrub(String(message)), ...rest) : undefined);
  return {...logger, info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug")};
}
