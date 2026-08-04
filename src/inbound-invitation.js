import {parseInvitationURL} from "./invitation.js";
import {joinInvitation} from "./join.js";
import {RoomClient} from "./room-client.js";
import {activateRoomChannel, scheduleGatewayRestart} from "./activation.js";

export function registerInboundInvitationHandler(api, options = {}) {
  const join = options.join ?? joinInvitation;
  const review = options.review ?? reviewInvitation;
  const activate = options.activate ?? activateRoomChannel;
  const restart = options.restart ?? (() => scheduleGatewayRestart({logger: api.logger}));

  api.on("inbound_claim", async (event) => {
    const invitationUrl = [event.content, event.body, event.bodyForAgent]
      .map(exactInvitationURL)
      .find(Boolean) ?? "";
    if (!invitationUrl) return;

    // Never expose a one-use capability to a language model, even when the
    // sender is not authorized to operate this host.
    if (event.commandAuthorized !== true) {
      return {
        handled: true,
        reply: {text: "Room invitation not accepted: send it from an authorized operator account."},
      };
    }

    try {
      const invitation = await review(invitationUrl);
      const displayName = String(invitation.proposedAgentName ?? "").trim();
      if (!displayName) throw new Error("Invitation does not specify the agent identity");

      const result = await join({invitationUrl, displayName});
      await activate({baseUrl: result.baseUrl, stateFile: result.stateFile});
      restart();
      return {
        handled: true,
        reply: {
          text: `Joined “${invitation.roomTitle || result.roomId}” as ${displayName}. The Room connector is restarting and will reconnect automatically.`,
        },
      };
    } catch (error) {
      return {handled: true, reply: {text: invitationErrorMessage(error)}};
    }
  }, {priority: 100, timeoutMs: 30_000});
}

export function exactInvitationURL(value) {
  const text = String(value ?? "").trim();
  if (!text || /\s/.test(text)) return "";
  try {
    const parsed = parseInvitationURL(text);
    return parsed.invitationId ? text : "";
  } catch {
    return "";
  }
}

export async function reviewInvitation(invitationUrl, {fetchImpl = globalThis.fetch, signal} = {}) {
  const invitation = parseInvitationURL(invitationUrl);
  if (!invitation.invitationId) throw new Error("Automatic onboarding requires a current universal invitation link");
  const client = new RoomClient({baseUrl: invitation.baseUrl, fetchImpl});
  const review = await client.reviewUniversalInvitation({invitationId: invitation.invitationId, signal});
  if (review.consumable !== true) throw new Error("Invitation is no longer available");
  return review;
}

function invitationErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (code === "invitation_expired") return "Room invitation expired. Ask the room owner for a new link.";
  if (code === "invitation_consumed") return "Room invitation was already used. No duplicate membership was created.";
  if (code === "invitation_invalid") return "Room invitation is invalid or unavailable. Ask the room owner for a fresh link.";
  return `Room invitation failed: ${String(error?.message ?? error)}`;
}
