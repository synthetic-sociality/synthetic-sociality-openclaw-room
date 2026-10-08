import {existsSync, readFileSync, readdirSync, lstatSync, statSync} from "node:fs";
import {join} from "node:path";
import {defaultStateDirectory, validateState} from "./state.js";
import {accountCandidates, resolveAccountConfig, resolveAccountSelection, selectUniqueAccountIds} from "./account.js";

export const ROOM_CHANNEL_ID = "synthetic-sociality-room";

function managedAccounts() {
  try {
    return readdirSync(defaultStateDirectory(), {withFileTypes: true})
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5));
  } catch { return []; }
}

// Contract P8-6: an account state file is parsed again only when its identity
// changed (size, modification time in ns, inode, device, mode; every write of
// this plugin replaces the file). The presence fallback asks every 10 s.
const parsedStates = new Map();

function identityOf(stat) {
  return `${stat.size}:${stat.mtimeNs}:${stat.ino}:${stat.dev}:${stat.mode}`;
}

function cachedParse(path, stat, parse) {
  const identity = identityOf(stat);
  const key = `${parse.name}:${path}`;
  const cached = parsedStates.get(key);
  if (cached?.identity === identity) return cached.value;
  const value = parse(path);
  parsedStates.set(key, {identity, value});
  return value;
}

function parseManaged(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    validateState(state);
    return {baseUrl: state.baseUrl};
  } catch { return null; }
}

function parseRevoked(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.revoked === true;
  } catch { return false; }
}

function managedAccount(accountId) {
  const stateFile = join(defaultStateDirectory(), `${accountId}.json`);
  if (!existsSync(stateFile)) return null;
  try {
    const stat = lstatSync(stateFile, {bigint: true});
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n) return null;
    const managed = cachedParse(stateFile, stat, parseManaged);
    return managed ? {baseUrl: managed.baseUrl, stateFile} : null;
  } catch { return null; }
}

// A revoked account is retired, not merely failing. Reporting it as not
// enabled makes the host treat it as unmanaged: it is neither started nor
// revived by the health monitor. Administrative disables stay in the config.
function stateRetired(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return false;
  try {
    return cachedParse(stateFile, statSync(stateFile, {bigint: true}), parseRevoked);
  } catch { return false; }
}

export function resolveRoomAccount(cfg, accountId = "default", {managedResolver = managedAccount} = {}) {
  const section = cfg?.channels?.[ROOM_CHANNEL_ID] ?? {};
  const raw = resolveAccountConfig(section, accountId);
  const selected = resolveAccountSelection({accountId, raw, managed: managedResolver(accountId), defaultStateFile: join(defaultStateDirectory(), "default.json")});
  return {
    accountId,
    enabled: raw.enabled !== false && !stateRetired(selected.stateFile),
    configured: accountId === "default" || selected.managed !== null || (typeof raw.baseUrl === "string" && typeof raw.stateFile === "string"),
    baseUrl: selected.baseUrl,
    stateFile: selected.stateFile,
    agentId: String(raw.agentId ?? "main"),
  };
}

export function resolvedRoomAccounts(cfg, {managedIds = managedAccounts, managedResolver = managedAccount} = {}) {
  const resolve = (id) => resolveRoomAccount(cfg, id, {managedResolver});
  // Deduplicate before filtering enabled: a disabled selected/default account
  // must not be resurrected through an enabled managed alias of the same file.
  return selectUniqueAccountIds(accountCandidates(cfg?.channels?.[ROOM_CHANNEL_ID], managedIds()), resolve).map(resolve);
}
