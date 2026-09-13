import {existsSync, readFileSync, readdirSync, lstatSync} from "node:fs";
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

function managedAccount(accountId) {
  const stateFile = join(defaultStateDirectory(), `${accountId}.json`);
  if (!existsSync(stateFile)) return null;
  try {
    const stat = lstatSync(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    validateState(state);
    return {baseUrl: state.baseUrl, stateFile};
  } catch { return null; }
}

export function resolveRoomAccount(cfg, accountId = "default", {managedResolver = managedAccount} = {}) {
  const section = cfg?.channels?.[ROOM_CHANNEL_ID] ?? {};
  const raw = resolveAccountConfig(section, accountId);
  const selected = resolveAccountSelection({accountId, raw, managed: managedResolver(accountId), defaultStateFile: join(defaultStateDirectory(), "default.json")});
  return {
    accountId,
    enabled: raw.enabled !== false,
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
