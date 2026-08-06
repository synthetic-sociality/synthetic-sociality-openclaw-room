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
