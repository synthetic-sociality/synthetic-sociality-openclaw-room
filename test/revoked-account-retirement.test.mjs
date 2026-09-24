import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {resolveRoomAccount} from "../src/account-discovery.js";
import {saveState} from "../src/state.js";

// Removing an agent from a Room revokes its credential. Before this, the account
// was never marked, the host kept starting it from openclaw.json, and its health
// monitor revived it every ten minutes: Aura's Health Room account was refused
// by the server for a week after the membership was removed on 2026-09-17.

async function stateFixture(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const stateFile = join(directory, "member-1.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    credential: "fixture-only", clientInstanceId: "client-1", cursor: 0,
  });
  return stateFile;
}

function refusingRoom(code) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/status")) return new Response(JSON.stringify({code: "request_validation_failed"}), {status: 400});
    if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({code, retryable: false}), {status: 401});
    throw new Error(`Unexpected request: ${url}`);
  };
  return {calls, fetchImpl};
}

test("a revoked credential retires the account instead of failing forever", async () => {
  const stateFile = await stateFixture("openclaw-room-revoked-");
  const room = refusingRoom("credential_revoked");
  const warnings = [];
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: room.fetchImpl, logger: {warn: (message) => warnings.push(message), info: () => {}},
  });
  await assert.rejects(runtime.initialize(), (error) => error?.code === "credential_revoked");

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.revoked, true);
  assert.equal(state.revokedReason, "credential_revoked");
  assert.ok(!Number.isNaN(Date.parse(state.revokedAt)), "the retirement carries when it happened");
  assert.equal(state.credential, "fixture-only", "retirement records the fact and keeps the rest of the state");
  // The host's own log only ever said "stopped"; the cause must be named, once.
  // (The fixture's old-server status answer adds an unrelated renewal warning.)
  assert.equal(warnings.filter((message) => /revoked/.test(message)).length, 1);

  // The next start is refused before any request reaches the Room.
  const again = refusingRoom("credential_revoked");
  const restarted = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"}, {fetchImpl: again.fetchImpl});
  await assert.rejects(restarted.initialize(), /disabled, revoked or closed/);
  assert.equal(again.calls.length, 0);
});

test("an expired credential is not retired; it can still be renewed", async () => {
  const stateFile = await stateFixture("openclaw-room-expired-");
  const room = refusingRoom("credential_expired");
  const runtime = new OpenClawRoomRuntime({accountId: "member-1", stateFile, baseUrl: "https://room.example/api"}, {fetchImpl: room.fetchImpl});
  await assert.rejects(runtime.initialize(), (error) => error?.code === "credential_expired");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.revoked, undefined);
  assert.equal(state.revokedReason, undefined);
});

test("the host sees a retired account as not enabled, so it neither starts nor revives it", async () => {
  const stateFile = await stateFixture("openclaw-room-discovery-");
  const cfg = {channels: {"synthetic-sociality-room": {accounts: {"member-1": {}}}}};
  const managedResolver = () => ({baseUrl: "https://room.example/api", stateFile});
  assert.equal(resolveRoomAccount(cfg, "member-1", {managedResolver}).enabled, true);

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await saveState(stateFile, {...state, revoked: true, revokedReason: "credential_revoked", revokedAt: new Date().toISOString()});
  assert.equal(resolveRoomAccount(cfg, "member-1", {managedResolver}).enabled, false);

  // An administrative disable in the configuration is still honoured on its own.
  await saveState(stateFile, state);
  const disabled = {channels: {"synthetic-sociality-room": {accounts: {"member-1": {enabled: false}}}}};
  assert.equal(resolveRoomAccount(disabled, "member-1", {managedResolver}).enabled, false);
});
