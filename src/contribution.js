// ISSUE-106: explicit author metadata, never classification from prose or routing.
export const CONTRIBUTION_TYPES = ["claim", "question", "response"];
export function contributionOutput(text) {
  const raw = String(text ?? "").trim();
  const fence = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fence ? fence[1].trim() : raw;
  if (!candidate.startsWith("{")) return {body: raw, contributionType: "claim", explicit: false};
  let value;
  try { value = JSON.parse(candidate); } catch { return {body: raw, contributionType: "claim", explicit: false}; }
  if (value?.action === "contribute") {
    // JSON.parse normally accepts duplicate keys; the shared envelope does not.
    const tokens = candidate.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
    let depth = 0;
    const keys = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "{" || token === "[") depth++;
      else if (token === "}" || token === "]") depth--;
      else if (depth === 1 && token.startsWith('"') && tokens[i + 1] === ":") {
        const key = JSON.parse(token);
        if (keys.has(key)) throw new Error("Invalid Room contribution envelope: duplicate key");
        keys.add(key);
      }
    }
  }
  if (value?.action !== "contribute") return {body: raw, contributionType: "claim", explicit: false};
  if (Object.keys(value).some((key) => !["action", "body", "contributionType"].includes(key))
      || typeof value.body !== "string" || !value.body.trim()
      || !CONTRIBUTION_TYPES.includes(value.contributionType ?? "claim")
      || (Object.hasOwn(value, "contributionType") && value.contributionType == null)) {
    throw new Error("Invalid Room contribution envelope or contributionType");
  }
  return {body: value.body.trim(), contributionType: value.contributionType ?? "claim", explicit: Object.hasOwn(value, "contributionType")};
}
export function frozenContributionType(identity) {
  // Missing field marks legacy identity; do not upgrade its classification.
  return identity.contributionType === undefined
    ? (identity.nextRecipient || identity.recipientSelectors?.length ? "question" : "claim")
    : CONTRIBUTION_TYPES.includes(identity.contributionType) ? identity.contributionType : null;
}
