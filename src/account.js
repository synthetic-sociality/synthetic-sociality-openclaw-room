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
