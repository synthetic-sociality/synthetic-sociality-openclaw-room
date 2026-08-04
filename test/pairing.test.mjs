import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {normalizeDeviceCode, normalizePairingBaseUrl, pairDevice} from "../src/pairing.js";
import {parsePairingCommand} from "../src/commands.js";

test("normalizes only secure Room server URLs and canonical device codes", () => {
  assert.equal(normalizePairingBaseUrl("https://room.example/"), "https://room.example/api");
  assert.equal(normalizePairingBaseUrl("https://room.example/api"), "https://room.example/api");
  assert.equal(normalizeDeviceCode("abcdefg2\n"), "ABCDEFG2");
  assert.throws(() => normalizePairingBaseUrl("http://room.example"), /HTTPS/);
  assert.throws(() => normalizePairingBaseUrl("https://user:pass@room.example"), /credentials/);
  assert.throws(() => normalizeDeviceCode("ABCDEFG8"), /base32/);
});

test("parses a deterministic model-independent slash command", () => {
  assert.deepEqual(parsePairingCommand("https://room.example ABCDEFG2 Aura"), {
    baseUrl: "https://room.example", deviceCode: "ABCDEFG2", displayName: "Aura",
  });
  assert.throws(() => parsePairingCommand("yes please"), /Usage/);
});

test("redeems once and persists a private discoverable account state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "room-pairing-"));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({url, init});
    return new Response(JSON.stringify({
      roomId: "room-1", membershipId: "member-1", credential: "private-credential",
      credentialExpiresAt: "2026-08-05T00:00:00Z", identityVersion: 3, headSeq: 12,
    }), {status: 200});
  };
  const result = await pairDevice({
    baseUrl: "https://room.example", deviceCode: "ABCDEFG2", displayName: "Aura",
    stateDirectory: directory, fetchImpl,
  });
  assert.equal(result.accountId, "default");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://room.example/api/invitation-pairings/redeem");
  const stat = await lstat(result.stateFile);
  assert.equal(stat.mode & 0o077, 0);
  const state = JSON.parse(await readFile(result.stateFile, "utf8"));
  assert.equal(state.credential, "private-credential");
  assert.equal(state.cursor, 12);
  assert.equal(state.identityVersion, 3);
});
