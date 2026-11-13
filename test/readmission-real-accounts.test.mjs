// PR80-O-005 / PR80-O-006 (OpenClaw 0.2.80 r3; contract P18-1): the operator disable is the RAW host-config
// `enabled: false`, never the resolved account's `enabled` (which also folds in a revoked state). These tests run
// the real enrollment path with connector control's account list from the real resolvedRoomAccounts(cfg) (as
// channel.js sets it) over an isolated OPENCLAW_STATE_DIR, never a hand-built list.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const state = await mkdtemp(join(tmpdir(), "openclaw-room-real-accounts-"));
process.env.OPENCLAW_STATE_DIR = state;
const {OpenClawRoomRuntime, resetEnrollmentLineages} = await import("../src/runtime.js");
const {connectorControl} = await import("../src/connector-control.js");
const {loadState, saveState} = await import("../src/state.js");
const {resolvedRoomAccounts} = await import("../src/account-discovery.js");
const FIXTURE = JSON.parse(await readFile(new URL("./fixtures/real-shaped-revoked-account-0.2.79.json", import.meta.url), "utf8"));
delete FIXTURE._comment;
const SOURCE = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
  credential: "secret-1", identityVersion: 3, clientInstanceId: "client-1", cursor: 5};
const JOURNAL = "revocation-abandonment.jsonl";
let round = 0;

async function enroll({accountsConfig = undefined, held = FIXTURE, listing = [{invitationId: "invite-9", roomId: "room-2"}],
  claimed = {roomId: "room-2", membershipId: "member-2"}, accounts = null, onClaim = null, accountsFor = null} = {}) {
  round += 1;
  const directory = join(state, `round-${round}`, "synthetic-sociality-room", "accounts");
  process.env.OPENCLAW_STATE_DIR = join(state, `round-${round}`);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const sourceFile = join(directory, "default.json");
  const heldFile = join(directory, "member-2.json");
  await saveState(sourceFile, SOURCE);
  if (held) await saveState(heldFile, structuredClone(held));
  const before = held ? await readFile(heldFile) : null;
  const cfg = {channels: {"synthetic-sociality-room": {enabled: true, baseUrl: SOURCE.baseUrl, stateFile: sourceFile,
    ...(accountsConfig ? {accounts: accountsConfig} : {})}}};
  connectorControl.setAccounts(accounts ?? accountsFor?.(cfg) ?? (() => resolvedRoomAccounts(cfg)));
  const listedBefore = accounts ? null : resolvedRoomAccounts(cfg);
  const claims = [];
  const activations = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: sourceFile, baseUrl: SOURCE.baseUrl},
    {activateEnrollment: async (activation) => { activations.push(activation.accountId); }});
  runtime.state = {...SOURCE};
  const warnings = [];
  runtime.logger = {warn: (message) => warnings.push(String(message)), info: () => {}};
  resetEnrollmentLineages();
  runtime.client = {
    connectorEnrollments: async () => listing.map((item) => ({...item})),
    claimConnectorEnrollment: async (_state, invitationId) => (claims.push(invitationId), onClaim?.(), {...claimed,
      credential: "secret-fresh", credentialExpiresAt: "2026-12-12T00:00:00Z", identityVersion: 3, headSeq: 2650}),
  };
  try {
    await runtime.acceptConnectorEnrollments();
  } finally {
    connectorControl.setAccounts(() => []);
  }
  let journal = [];
  try { journal = (await readFile(join(directory, JOURNAL), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  return {claims, activations, heldFile, before, directory, journal, cfg, listedBefore, warnings};
}

test("PR80-O-005 (a) the owner case with the real account list: a revoked account, not config-disabled, is claimed, journaled and replaced", async () => {
  const result = await enroll();
  const listed = result.listedBefore.find((account) => account.accountId === "member-2");
  assert.equal(listed?.enabled, false, "the resolved account was not enabled (retired), which is not an operator disable");
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.deepEqual(result.activations, ["member-2"]);
  const persisted = await loadState(result.heldFile);
  assert.equal(persisted.credential, "secret-fresh");
  assert.equal(persisted.revoked, undefined);
  assert.deepEqual(persisted.deliveryIntents ?? {}, {});
  assert.deepEqual(result.journal.filter((line) => line.phase === "recorded").map((line) => line.entry.id), ["evt-2646:final"]);
  assert.equal(result.journal.filter((line) => line.phase === "applied").length, 1);
});

test("PR80-O-005 (b) the same account with accounts.member-2.enabled:false in the host config is untouched and unclaimed", async () => {
  const result = await enroll({accountsConfig: {"member-2": {enabled: false}}});
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.activations, []);
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0, "byte for byte");
  assert.deepEqual(result.journal, [], "nothing is journaled");
});

test("PR80-O-005 an inert revoked account (0.2.79 R5 re-admission) is replaced with the real account list", async () => {
  const inert = structuredClone(FIXTURE);
  delete inert.deliveryIntents["evt-2646:final"];
  const result = await enroll({held: inert});
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.equal((await loadState(result.heldFile)).credential, "secret-fresh");
});

test("PR80-O-006 an unreadable account list keeps a first-time enrollment unclaimed: the one-time credential is not consumed", async () => {
  const result = await enroll({held: null, listing: [{invitationId: "invite-7", roomId: "room-7"}],
    claimed: {roomId: "room-7", membershipId: "member-7"}, accounts: () => { throw new Error("config unreadable"); }});
  assert.deepEqual(result.claims, [], "refused before the claim");
  assert.deepEqual(result.activations, []);
  assert.deepEqual((await readdir(result.directory)).sort(), ["default.json"], "no new account file");
});

test("PR80-O-006 a list that becomes unreadable after the claim never discards a first-time credential", async () => {
  let reads = 0;
  const result = await enroll({held: null, listing: [{invitationId: "invite-7", roomId: "room-7"}],
    claimed: {roomId: "room-7", membershipId: "member-7"},
    accounts: () => { reads += 1; if (reads > 1) throw new Error("config unreadable"); return []; }});
  assert.deepEqual(result.claims, ["invite-7"]);
  assert.equal((await loadState(join(result.directory, "member-7.json"))).credential, "secret-fresh", "the credential is saved");
  assert.deepEqual(result.activations, ["member-7"]);
});

// PR80-O-007 / PR80-O-008 (OpenClaw 0.2.80 r4; contract P18-1 "never … re-enabled", "re-read … before a replacement,
// and an unreadable list refuses"), with the real resolvedRoomAccounts(cfg) over an isolated state dir.
test("PR80-O-007 a raw config enabled:false with no state file: the claimed credential is saved privately, never activated, the operator's false stays", async () => {
  const result = await enroll({held: null, accountsConfig: {"member-2": {enabled: false}}});
  assert.deepEqual(result.claims, ["invite-9"]);
  const saved = await loadState(result.heldFile);
  assert.equal(saved.credential, "secret-fresh", "the one-time credential is kept in the private state file");
  const {stat} = await import("node:fs/promises");
  assert.equal((await stat(result.heldFile)).mode & 0o777, 0o600);
  assert.deepEqual(result.activations, [], "no activation, so no enabled:true merge");
  assert.equal(result.cfg.channels["synthetic-sociality-room"].accounts["member-2"].enabled, false);
  assert.equal(resolvedRoomAccounts(result.cfg).find((account) => account.accountId === "member-2")?.configEnabled, false,
    "the real resolver still reports the operator's false");
  assert.equal(result.warnings.filter((line) => /operator-disabled/.test(line)).length, 1, "one log line");
});

test("PR80-O-007 control: the same first-time enrollment without a config disable is saved and activated", async () => {
  const result = await enroll({held: null});
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.deepEqual(result.activations, ["member-2"]);
});

test("PR80-O-008 a held revoked account is not replaced when the account list cannot be read after the claim", async () => {
  let claimedYet = false;
  let atClaim = null;
  const {readFileSync} = await import("node:fs");
  const result = await enroll({onClaim: () => { claimedYet = true; atClaim = readFileSync(join(process.env.OPENCLAW_STATE_DIR, "synthetic-sociality-room", "accounts", "member-2.json")); },
    accountsFor: (cfg) => () => { if (claimedYet) throw new Error("config unreadable"); return resolvedRoomAccounts(cfg); }});
  assert.deepEqual(result.claims, ["invite-9"], "the pre-claim reads were readable");
  assert.deepEqual(result.activations, [], "no activation");
  // The P18 abandonment ran before the claim (the account was eligible then); from the claim on the stored state
  // must stay byte for byte: no replacement.
  assert.equal(Buffer.compare(atClaim, await readFile(result.heldFile)), 0, "the held state stays byte for byte");
  const persisted = await loadState(result.heldFile);
  assert.equal(persisted.credential, "secret-old", "never replaced");
  assert.equal(persisted.revoked, true, "the old credential is never re-enabled");
  assert.equal(result.warnings.filter((line) => /cannot be read before the replacement/.test(line)).length, 1);
});
