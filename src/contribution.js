// ISSUE-106: explicit author metadata, never classification from prose or routing.
export const CONTRIBUTION_TYPES = ["claim", "question", "response"];
const skip = () => ({skipped: true});
const prose = (body) => ({body, contributionType: "claim", explicit: false});

// Same narrow compatibility as Hermes: escaped whitespace outside JSON strings.
function restoreLayout(candidate) {
  let result = "", inside = false, escaped = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inside) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inside = false;
    } else if (ch === '"') { inside = true; result += ch; }
    else if (ch === "\\" && "nrt".includes(candidate[i + 1] ?? "!") && candidate[i + 1]) {
      result += {n: "\n", r: "\r", t: "\t"}[candidate[++i]];
    } else result += ch;
  }
  return result;
}
function decodeUnique(candidate) {
  const value = JSON.parse(candidate);
  // Reject duplicate keys at every object depth, including escaped key spellings.
  const tokens = candidate.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (stack.at(-1) && token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token);
      if (stack.at(-1).has(key)) throw Error("duplicate key");
      stack.at(-1).add(key);
    }
  }
  return value;
}
function recoverBody(candidate) {
  const prefix = candidate.match(/^\{\s*"action"\s*:\s*"contribute"\s*,\s*"body"\s*:\s*"/);
  const compact = candidate.trimEnd();
  if (!prefix || !compact.endsWith('"') || compact.length <= prefix[0].length) return null;
  const raw = compact.slice(prefix[0].length, -1);
  let body = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') return null;
    if (ch === "\\") {
      const next = raw[++i];
      if (next !== '"' && next !== "n") return null;
      body += next === "n" ? "\n" : '"';
    } else {
      if (ch.charCodeAt(0) < 32 && ch !== "\n") return null;
      body += ch;
    }
  }
  return body.trim() || null;
}
function containsEnvelope(candidate) {
  if (/"action"\s*:|<\s*(?:[A-Za-z_][\w.-]*:)?action(?=\s|=|\/?>)|<[^>]*\baction\s*=/i.test(candidate)) return true;
  const strings = candidate.matchAll(/("(?:\\.|[^"\\])*")\s*:/g);
  for (const match of strings) {
    try { if (JSON.parse(match[1]).toLowerCase() === "action") return true; } catch {}
  }
  // Also reject a quoted/escaped action envelope mixed with wrapper prose.
  return /\\"action\\"\s*:/i.test(candidate);
}
export function contributionOutput(text) {
  const raw = String(text ?? "").trim();
  const fence = raw.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  const candidate = fence ? fence[1].trim() : raw;
  if (candidate.startsWith("{")) {
    let value = null;
    for (const encoded of [candidate, restoreLayout(candidate)]) {
      try { value = decodeUnique(encoded); break; } catch {}
    }
    if (value === null) {
      const body = recoverBody(candidate);
      return body === null ? skip() : prose(body);
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      if (Object.hasOwn(value, "action")) {
        if (value.action !== "contribute") return skip();
        // Match Hermes's type validation before visible-body selection.
        if (Object.hasOwn(value, "contributionType") && !CONTRIBUTION_TYPES.includes(value.contributionType)) {
          throw new Error("Invalid Room contributionType");
        }
        if (Object.keys(value).some((key) => !["action", "body", "contributionType"].includes(key))) return skip();
        if (typeof value.body !== "string" || !value.body.trim()) return skip();
        return {body: value.body.trim(), contributionType: value.contributionType ?? "claim", explicit: Object.hasOwn(value, "contributionType")};
      }
      if (!Object.hasOwn(value, "body")) return raw ? prose(raw) : skip();
    }
    return skip();
  }
  if (candidate.toLowerCase().startsWith("<action") || containsEnvelope(candidate)) return skip();
  return raw ? prose(raw) : skip();
}
export function frozenContributionType(identity) {
  // Missing field marks legacy identity; do not upgrade its classification.
  return identity.contributionType === undefined
    ? (identity.nextRecipient || identity.recipientSelectors?.length ? "question" : "claim")
    : CONTRIBUTION_TYPES.includes(identity.contributionType) ? identity.contributionType : null;
}
