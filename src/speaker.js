// Truthful speaker labels when the roster and payload name no one (delivery
// contract P1a): never "Room participant" or a role id such as "system".
export function speakerRoleLabel(event) {
  const role = String(event?.actorRole ?? "");
  if (role === "system" || String(event?.actorId ?? "") === "room_coordinator") return "Room (system)";
  if (role === "human" || role.startsWith("human_") || role === "agent_owner") return "Human participant";
  if (role) return "Room agent";
  return "Unknown actor";
}

// Roster display name for the event's actor, else the payload's own name.
export function speakerName(roster, event) {
  const actorId = String(event?.actorId ?? "");
  const member = (Array.isArray(roster) ? roster : []).find((entry) => actorId && String(entry?.membershipId ?? "") === actorId);
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return String(member?.displayName ?? payload.actorDisplayName ?? payload.displayName ?? "").trim();
}
