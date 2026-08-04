export function parseInvitationURL(raw) {
  let parsed;
  try { parsed = new URL(String(raw).trim()); } catch { throw new Error("Invalid Room invitation URL"); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new Error("Room invitations must use HTTPS");
  if (parsed.username || parsed.password || parsed.search) throw new Error("Room invitation URL must not contain credentials or query parameters");
  const origin = parsed.origin;
  const legacy = parsed.pathname.match(/^\/api\/invitations\/([^/]+)$/);
  if (legacy && !parsed.hash) {
    const token = decodeURIComponent(legacy[1]);
    if (token.length < 32) throw new Error("Room invitation token is invalid");
    return {baseUrl: `${origin}/api`, legacyToken: token};
  }
  const modern = parsed.pathname.match(/^\/invitations\/([^/]+)$/);
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  if (!modern || fragment.size !== 1 || !fragment.has("secret")) throw new Error("Universal Room invitation is missing its secret fragment");
  const invitationId = decodeURIComponent(modern[1]);
  const secret = fragment.get("secret") ?? "";
  if (!invitationId || secret.length < 32) throw new Error("Universal Room invitation is invalid");
  return {baseUrl: `${origin}/api`, invitationId, secret};
}
