import {pairDevice} from "./pairing.js";
import {joinInvitation} from "./join.js";
import {registerInboundInvitationHandler} from "./inbound-invitation.js";
import {activateRoomChannel, healManagedRoomChannel, scheduleGatewayRestart} from "./activation.js";

export function registerRoomCommands(api, options = {}) {
  const join = options.join ?? joinInvitation;
  const activate = options.activate ?? activateRoomChannel;
  const restart = options.restart ?? (() => scheduleGatewayRestart({logger: api.logger}));
  const heal = options.heal ?? (() => healManagedRoomChannel({activate, restart}));
  registerInboundInvitationHandler(api);
  void heal().catch((error) => api.logger?.error?.(`Room connector activation recovery failed: ${String(error)}`));
  api.registerCommand({
    name: "room-join",
    description: "Join a Synthetic Sociality Room from its complete invitation link",
    acceptsArgs: true,
    requireAuth: true,
    agentPromptGuidance: [
      "When an authorized operator asks to accept a complete Synthetic Sociality invitation, use /room-join INVITATION_URL DISPLAY_NAME exactly once. Do not inspect plugin files, invent API calls, or retry automatically.",
    ],
    handler: async (ctx) => {
      try {
        const parsed = parseJoinCommand(ctx.args ?? "");
        const result = await join(parsed);
        await activate({baseUrl: result.baseUrl, stateFile: result.stateFile});
        restart();
        return {text: `Joined Room ${result.roomId} as ${parsed.displayName}. The Room connector is restarting and will reconnect automatically.`};
      } catch (error) {
        return {text: joinErrorMessage(error)};
      }
    },
  });

  api.registerCommand({
    name: "room-pair",
    description: "Pair this OpenClaw agent with a Synthetic Sociality Room",
    acceptsArgs: true,
    requireAuth: true,
    agentPromptGuidance: [
      "Never simulate Room enrollment. A human operator must send /room-pair SERVER DEVICE_CODE DISPLAY_NAME as a standalone command; report its deterministic result without retry loops.",
    ],
    handler: async (ctx) => {
      try {
        const parsed = parsePairingCommand(ctx.args ?? "");
        const result = await pairDevice(parsed);
        const activation = result.accountId === "default"
          ? "The connector is activating automatically."
          : "Send /restart once to activate this additional Room account.";
        return {
          text: `Paired ${parsed.displayName} with Room ${result.roomId}. ${activation}`,
        };
      } catch (error) {
        return {text: pairingErrorMessage(error)};
      }
    },
  });
}

export function parseJoinCommand(raw) {
  const values = String(raw).trim().split(/\s+/).filter(Boolean);
  if (values.length < 2) throw new Error("Usage: /room-join INVITATION_URL DISPLAY_NAME");
  return {invitationUrl: values[0], displayName: values.slice(1).join(" ")};
}

export function parsePairingCommand(raw) {
  const values = String(raw).trim().split(/\s+/).filter(Boolean);
  if (values.length < 3) throw new Error("Usage: /room-pair SERVER DEVICE_CODE DISPLAY_NAME");
  return {baseUrl: values[0], deviceCode: values[1], displayName: values.slice(2).join(" ")};
}

function pairingErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (code === "invitation_expired") return "Pairing expired. Create a new device code and try once more.";
  if (code === "invitation_consumed") return "This pairing code was already used. No second membership was created.";
  if (code === "invitation_invalid") return "Pairing code is invalid or unavailable. Check the server and create a fresh code.";
  return `Pairing failed: ${String(error?.message ?? error)}`;
}

function joinErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (code === "invitation_expired") return "Invitation expired. Ask the Room owner for a new link.";
  if (code === "invitation_consumed") return "This invitation was already used. No second membership was created.";
  if (code === "invitation_invalid") return "Invitation is invalid or unavailable. Ask the Room owner for a fresh link.";
  return `Room join failed: ${String(error?.message ?? error)}`;
}
