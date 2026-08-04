import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {readdir} from "node:fs/promises";
import {RoomClient} from "./room-client.js";
import {defaultStateDirectory, ensurePrivateDirectory, saveNewState} from "./state.js";

const DEVICE_CODE = /^[A-Z2-7]{8}$/;

export function normalizePairingBaseUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw).trim()); } catch { throw new Error("Room server URL is invalid"); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new Error("Room server must use HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Room server URL must not contain credentials, query parameters, or fragments");
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path && path !== "/api") throw new Error("Room server URL path must be empty or /api");
  return `${parsed.origin}/api`;
}

export function normalizeDeviceCode(raw) {
  const code = String(raw).trim().toUpperCase();
  if (!DEVICE_CODE.test(code)) throw new Error("Device code must be exactly 8 uppercase base32 characters");
  return code;
}

export async function pairDevice({baseUrl, deviceCode, displayName, systemDescriptor = "OpenClaw native Room channel", stateDirectory = defaultStateDirectory(), fetchImpl = globalThis.fetch, signal}) {
  const normalizedBaseUrl = normalizePairingBaseUrl(baseUrl);
  const normalizedCode = normalizeDeviceCode(deviceCode);
  const identity = {
    displayName: String(displayName ?? "").trim(),
    systemDescriptor: String(systemDescriptor ?? "").trim(),
    identityVersion: 1,
  };
  if (!identity.displayName || !identity.systemDescriptor) throw new Error("Agent display name and system descriptor are required");
  await ensurePrivateDirectory(stateDirectory);
  const client = new RoomClient({baseUrl: normalizedBaseUrl, fetchImpl});
  const session = await client.redeemPairing({deviceCode: normalizedCode, identity, signal});
  const accountId = await selectAccountId(stateDirectory, session.membershipId);
  const stateFile = join(stateDirectory, `${accountId}.json`);
  const state = {
    version: 1,
    baseUrl: normalizedBaseUrl,
    roomId: session.roomId,
    membershipId: session.membershipId,
    credential: session.credential,
    credentialExpiresAt: session.credentialExpiresAt,
    identityVersion: session.identityVersion ?? 1,
    clientInstanceId: randomUUID(),
    cursor: session.headSeq ?? 0,
  };
  await saveNewState(stateFile, state);
  return {joined: true, roomId: state.roomId, membershipId: state.membershipId, accountId, stateFile};
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
