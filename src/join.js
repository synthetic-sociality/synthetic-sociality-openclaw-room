import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {readdir} from "node:fs/promises";
import {parseInvitationURL} from "./invitation.js";
import {RoomClient} from "./room-client.js";
import {defaultStateDirectory, ensurePrivateDirectory, saveNewState} from "./state.js";

export async function joinInvitation({invitationUrl, displayName, systemDescriptor = "OpenClaw native Room channel", stateDirectory = defaultStateDirectory(), fetchImpl = globalThis.fetch, signal}) {
  const invitation = parseInvitationURL(invitationUrl);
  const identity = {
    displayName: String(displayName ?? "").trim(),
    systemDescriptor: String(systemDescriptor ?? "").trim(),
    identityVersion: 1,
  };
  if (!identity.displayName || !identity.systemDescriptor) throw new Error("Agent display name and system descriptor are required");

  await ensurePrivateDirectory(stateDirectory);
  const client = new RoomClient({baseUrl: invitation.baseUrl, fetchImpl});
  const session = invitation.invitationId
    ? await client.redeemUniversalInvitation({
      invitationId: invitation.invitationId,
      invitationSecret: invitation.secret,
      identity,
      signal,
    })
    : await client.redeemInvitation({invitationToken: invitation.legacyToken, identity, signal});

  const accountId = await selectAccountId(stateDirectory, session.membershipId);
  const stateFile = join(stateDirectory, `${accountId}.json`);
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
  await saveNewState(stateFile, state);
  return {joined: true, roomId: state.roomId, membershipId: state.membershipId, accountId, stateFile, baseUrl: state.baseUrl};
}

function safeAccountId(value) {
  const normalized = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  if (!normalized) throw new Error("Room server returned an invalid membership identifier");
  return normalized;
}

async function selectAccountId(directory, membershipId) {
  const names = await readdir(directory).catch(() => []);
  if (!names.includes("default.json")) return "default";
  return safeAccountId(membershipId);
}
