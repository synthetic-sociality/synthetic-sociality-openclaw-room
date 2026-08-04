#!/usr/bin/env node
import {readFile, lstat} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {RoomClient} from "../src/room-client.js";
import {parseInvitationURL} from "../src/invitation.js";
import {saveState} from "../src/state.js";

const arguments_ = parseArguments(process.argv.slice(2));
try {
  await assertStateTargetAvailable(arguments_.stateFile);
  const invitationInput = await readFile(0, {encoding: "utf8"});
  if (!invitationInput.trim() || Buffer.byteLength(invitationInput) > 8192) throw new Error("Invitation URL must contain 1 to 8192 bytes");
  const invitation = parseInvitationURL(invitationInput);
  const client = new RoomClient({baseUrl: invitation.baseUrl});
  const identity = {displayName: arguments_.displayName, systemDescriptor: arguments_.systemDescriptor};
  const session = invitation.invitationId
    ? await client.redeemUniversalInvitation({invitationId: invitation.invitationId, invitationSecret: invitation.secret, identity})
    : await client.redeemInvitation({invitationToken: invitation.legacyToken, identity});
  const state = {
    version: 1,
    baseUrl: invitation.baseUrl,
    roomId: session.roomId,
    membershipId: session.membershipId,
    credential: session.credential,
    credentialExpiresAt: session.credentialExpiresAt,
    identityVersion: session.identityVersion ?? 1,
    clientInstanceId: randomUUID(),
    cursor: session.headSeq ?? 0,
  };
  await saveState(arguments_.stateFile, state);
  process.stdout.write(`${JSON.stringify({joined: true, roomId: state.roomId, membershipId: state.membershipId, stateFile: arguments_.stateFile})}\n`);
} catch (error) {
  process.stderr.write(`openclaw-room-join: ${error.message}\n`);
  process.exitCode = 1;
}

function parseArguments(values) {
  const result = {displayName: "OpenClaw Agent", systemDescriptor: "OpenClaw native Room channel", stateFile: ""};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!value || !["--display-name", "--system", "--state"].includes(key)) throw new Error("Usage: openclaw-room-join --display-name NAME --system DESCRIPTION --state PRIVATE_STATE_FILE < INVITATION_URL_FILE");
    if (key === "--display-name") result.displayName = value;
    if (key === "--system") result.systemDescriptor = value;
    if (key === "--state") result.stateFile = value;
  }
  if (!result.stateFile || !result.displayName.trim() || !result.systemDescriptor.trim()) throw new Error("Display name, system descriptor, and state file are required");
  return result;
}

async function assertStateTargetAvailable(path) {
  try {
    const stat = await lstat(path);
    if (stat) throw new Error("Reconnect state already exists; refusing to consume another invitation");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
