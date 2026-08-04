import test from "node:test";
import assert from "node:assert/strict";
import {activateRoomChannel, resolveOpenClawBinary} from "../src/activation.js";

test("activates the Room channel through the official OpenClaw config CLI", async () => {
  let call;
  await activateRoomChannel({baseUrl: "https://room.example/api", stateFile: "/private/state.json", command: "/test/openclaw", exec(command, args, options, callback) {
    call = {command, args, options};
    callback(null, "", "");
  }});
  assert.equal(call.command, "/test/openclaw");
  assert.deepEqual(call.args, [
    "config", "set", "channels.synthetic-sociality-room",
    JSON.stringify({enabled: true, baseUrl: "https://room.example/api", stateFile: "/private/state.json"}),
    "--strict-json", "--merge",
  ]);
  assert.equal(call.options.timeout, 15_000);
});

test("prefers an explicit OpenClaw binary and supports Homebrew hosts", () => {
  assert.equal(resolveOpenClawBinary({env: {OPENCLAW_BIN: "/custom/openclaw"}, exists: () => false}), "/custom/openclaw");
  assert.equal(resolveOpenClawBinary({env: {}, exists: (value) => value === "/opt/homebrew/bin/openclaw"}), "/opt/homebrew/bin/openclaw");
});
