// Delivery contract P1a-7: one speaker-label scheme, identical in both
// connectors, for the transcript, the current input and the host session
// speaker. Never "Room participant" or a role id such as "system".

const HUMAN_ROLES = new Set(["human", "agent_owner"]);
const AGENT_ROLES = new Set(["participant_agent", "room_master", "observer"]);

function payloadObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const decoded = JSON.parse(String(value || "{}"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

// (3) The role label, used only when no name is known.
export function speakerRoleLabel(event) {
  const role = String(event?.actorRole ?? "");
  const actorId = String(event?.actorId ?? "");
  if (role === "system" || actorId === "room_coordinator" || actorId === "system") return "Room (system)";
  if (HUMAN_ROLES.has(role) || role.startsWith("human_")) return "Human participant";
  if (AGENT_ROLES.has(role)) return "Room agent";
  return "Unknown actor";
}

// (1) The roster display name for the event's actorId, else (2) the payload's
// actorDisplayName or displayName. Empty when neither names the actor.
export function speakerName(roster, event) {
  const actorId = String(event?.actorId ?? "");
  const member = actorId
    ? (Array.isArray(roster) ? roster : []).find((entry) => String(entry?.membershipId ?? "") === actorId)
    : null;
  const payload = payloadObject(event?.payload);
  for (const candidate of [member?.displayName, payload.actorDisplayName, payload.displayName]) {
    const name = String(candidate ?? "").trim();
    if (name) return name;
  }
  return "";
}

export function speakerLabel(roster, event) {
  return speakerName(roster, event) || speakerRoleLabel(event);
}
