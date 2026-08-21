import {realpathSync, statSync} from "node:fs";
import {basename, dirname, resolve} from "node:path";

export function accountCandidates(section = {}, managedAccountIds = []) {
  return [...new Set(["default", ...Object.keys(section?.accounts ?? {}), ...managedAccountIds])];
}

export function canonicalStateFileIdentity(stateFile, {cwd = process.cwd(), rejectHardlinks = false} = {}) {
  let current = resolve(cwd, String(stateFile));
  const suffix = [];
  while (true) {
    try {
      const ancestor = realpathSync.native(current);
      if (suffix.length === 0) {
        const stat = statSync(ancestor);
        if (stat.nlink > 1) {
          if (rejectHardlinks) throw new Error("Room state file must not be hard-linked");
          return `inode:${stat.dev}:${stat.ino}`;
        }
      }
      return resolve(ancestor, ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

export function claimRuntimeStateFile(registry, account) {
  const identity = canonicalStateFileIdentity(account.stateFile, {rejectHardlinks: true});
  if (registry.has(identity)) throw new Error("Room state file is already claimed by another Room runtime");
  const token = Symbol("room-runtime-state-file");
  registry.set(identity, token);
  return () => {
    if (registry.get(identity) === token) registry.delete(identity);
  };
}

export function claimRuntimeOwnership(registries, account) {
  const accountId = String(account.accountId);
  const stateFile = canonicalStateFileIdentity(account.stateFile, {rejectHardlinks: true});
  if (registries.accounts.has(accountId)) throw new Error("Room account is already claimed by another Room runtime");
  if (registries.stateFiles.has(stateFile)) throw new Error("Room state file is already claimed by another Room runtime");
  const token = Symbol("room-runtime-owner");
  registries.accounts.set(accountId, token);
  registries.stateFiles.set(stateFile, token);
  return {
    token,
    owns: () => registries.accounts.get(accountId) === token && registries.stateFiles.get(stateFile) === token,
    release: () => {
      if (registries.accounts.get(accountId) === token) registries.accounts.delete(accountId);
      if (registries.stateFiles.get(stateFile) === token) registries.stateFiles.delete(stateFile);
    },
  };
}

export function selectUniqueAccountIds(candidateIds, resolveAccount) {
  const selected = [];
  const accountIds = new Set();
  const stateFiles = new Set();
  for (const accountId of candidateIds) {
    if (accountIds.has(accountId)) continue;
    accountIds.add(accountId);
    const account = resolveAccount(accountId);
    const stateFile = String(account?.stateFile ?? "").trim();
    if (stateFile) {
      const identity = canonicalStateFileIdentity(stateFile);
      if (stateFiles.has(identity)) continue;
      stateFiles.add(identity);
    }
    selected.push(accountId);
  }
  return selected;
}

export function resolveAccountSelection({accountId, raw = {}, managed = null, defaultStateFile = ""}) {
  const explicitStateFile = typeof raw.stateFile === "string" && raw.stateFile.trim() ? raw.stateFile : "";
  const explicitBaseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl : "";
  // The top-level channel configuration is the selected default account. A
  // later invitation can point it at a non-default managed state file; an
  // older default.json must never silently override that selection.
  const selectedManaged = accountId === "default" && explicitStateFile ? null : managed;
  return {
    managed: selectedManaged,
    baseUrl: explicitBaseUrl || selectedManaged?.baseUrl || "",
    stateFile: explicitStateFile || selectedManaged?.stateFile || (accountId === "default" ? defaultStateFile : ""),
  };
}

export function resolveAccountConfig(section = {}, accountId = "default") {
  const accounts = section?.accounts;
  if (accounts && Object.prototype.hasOwnProperty.call(accounts, accountId)) {
    return accounts[accountId] ?? {};
  }
  // Top-level channel fields configure only the default account. Falling back
  // to them for a managed account aliases every discovered Room to the same
  // state file and connector session.
  return accountId === "default" ? section : {};
}
