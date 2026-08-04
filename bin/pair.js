#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import {pairDevice} from "../src/pairing.js";

const arguments_ = parseArguments(process.argv.slice(2));
try {
  const deviceCode = await readFile(0, {encoding: "utf8"});
  if (!deviceCode.trim() || Buffer.byteLength(deviceCode) > 64) throw new Error("Device code must contain 1 to 64 bytes");
  const result = await pairDevice({...arguments_, deviceCode});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`openclaw-room-pair: ${error.message}\n`);
  process.exitCode = 1;
}

function parseArguments(values) {
  const result = {baseUrl: "", displayName: "", systemDescriptor: "OpenClaw native Room channel", stateDirectory: undefined};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!value || !["--server", "--display-name", "--system", "--state-directory"].includes(key)) {
      throw new Error("Usage: openclaw-room-pair --server URL --display-name NAME [--system DESCRIPTION] [--state-directory PRIVATE_DIRECTORY] < DEVICE_CODE_FILE");
    }
    if (key === "--server") result.baseUrl = value;
    if (key === "--display-name") result.displayName = value;
    if (key === "--system") result.systemDescriptor = value;
    if (key === "--state-directory") result.stateDirectory = value;
  }
  if (!result.baseUrl || !result.displayName.trim()) throw new Error("Room server and display name are required");
  return result;
}
