import test from "node:test";
import assert from "node:assert/strict";
import {registerRoomCommands} from "../src/commands.js";

test("room-join activates the channel and schedules a restart", async () => {
  const commands = new Map();
  let activation;
  let restarted = 0;
  const api = {
    on() {},
    registerCommand(command) { commands.set(command.name, command); },
  };
  registerRoomCommands(api, {
    join: async () => ({roomId: "room-1", accountId: "default", baseUrl: "https://room.example/api", stateFile: "/private/state.json"}),
    activate: async (input) => { activation = input; },
    restart: () => { restarted += 1; },
    heal: async () => false,
  });
  const result = await commands.get("room-join").handler({
    args: `https://room.example/invitations/inv-1#secret=${"s".repeat(32)} Aura`,
  });
  assert.deepEqual(activation, {baseUrl: "https://room.example/api", stateFile: "/private/state.json"});
  assert.equal(restarted, 1);
  assert.match(result.text, /restarting and will reconnect automatically/);
});
