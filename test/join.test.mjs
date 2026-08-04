import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {joinInvitation} from "../src/join.js";
import {parseJoinCommand} from "../src/commands.js";

test("parses a deterministic room-join command without model interpretation", () => {
  const secret = "s".repeat(32);
  assert.deepEqual(
    parseJoinCommand(`https://room.example/invitations/inv-1#secret=${secret} Aura Prime`),
    {invitationUrl: `https://room.example/invitations/inv-1#secret=${secret}`, displayName: "Aura Prime"},
  );
  assert.throws(() => parseJoinCommand("https://room.example/invitations/inv-1"), /Usage/);
});

test("joins from a complete universal invitation and stores private connector state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "room-join-"));
  let request;
  const fetchImpl = async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify({
      roomId: "room-1",
      membershipId: "member-1",
      credential: "credential-1",
      credentialExpiresAt: "2026-08-05T00:00:00Z",
      identityVersion: 1,
      headSeq: 7,
    }), {status: 200, headers: {"Content-Type": "application/json"}});
  };

  const result = await joinInvitation({
    invitationUrl: `https://room.example/invitations/inv-1#secret=${"s".repeat(32)}`,
    displayName: "Aura",
    stateDirectory: directory,
    fetchImpl,
  });

  assert.equal(request.url, "https://room.example/api/invitations/inv-1/redeem");
  assert.deepEqual(JSON.parse(request.options.body), {
    invitationSecret: "s".repeat(32),
    identity: {displayName: "Aura", systemDescriptor: "OpenClaw native Room channel", identityVersion: 1},
  });
  assert.equal(result.accountId, "default");
  const state = JSON.parse(await readFile(join(directory, "default.json"), "utf8"));
  assert.equal(state.roomId, "room-1");
  assert.equal(state.cursor, 7);
});
