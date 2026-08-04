import {pairDevice} from "./pairing.js";

export function registerRoomCommands(api) {
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
