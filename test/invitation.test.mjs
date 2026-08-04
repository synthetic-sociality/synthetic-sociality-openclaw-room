import test from "node:test";
import assert from "node:assert/strict";
import {parseInvitationURL} from "../src/invitation.js";

test("parses modern secret fragment without placing it in the HTTP URL", () => {
  const parsed = parseInvitationURL(`https://room.example/invitations/public-id#secret=${"s".repeat(32)}`);
  assert.deepEqual(parsed, {baseUrl: "https://room.example/api", invitationId: "public-id", secret: "s".repeat(32)});
});

test("parses legacy one-time URL", () => {
  const token = "t".repeat(32);
  assert.deepEqual(parseInvitationURL(`https://room.example/api/invitations/${token}`), {baseUrl: "https://room.example/api", legacyToken: token});
});

test("rejects query leakage, remote HTTP, and malformed fragments", () => {
  assert.throws(() => parseInvitationURL(`https://room.example/invitations/x?secret=${"s".repeat(32)}`), /query/);
  assert.throws(() => parseInvitationURL(`http://room.example/api/invitations/${"t".repeat(32)}`), /HTTPS/);
  assert.throws(() => parseInvitationURL("https://room.example/invitations/x#secret=short"), /invalid/);
});
