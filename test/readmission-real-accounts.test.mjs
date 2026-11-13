// PR80-O-005 / PR80-O-006 (OpenClaw 0.2.80 r3; contract P18-1): the operator disable is the RAW host-config
// `enabled: false`, never the resolved account's `enabled` (which also folds in a revoked state). These tests run
// the real enrollment path with connector control's account list from the real resolvedRoomAccounts(cfg) (as
// channel.js sets it) over an isolated OPENCLAW_STATE_DIR, never a hand-built list.
import assert from "node:assert/strict";
import test from "node:test";
import {chmod, link, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile} from "node:fs/promises";
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
  claimed = {roomId: "room-2", membershipId: "member-2"}, accounts = null, onClaim = null, accountsFor = null,
  rawHeld = null, mode = null, extraFiles = {}, prepare = null} = {}) {
  round += 1;
  const directory = join(state, `round-${round}`, "synthetic-sociality-room", "accounts");
  process.env.OPENCLAW_STATE_DIR = join(state, `round-${round}`);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const sourceFile = join(directory, "default.json");
  const heldFile = join(directory, "member-2.json");
  await saveState(sourceFile, SOURCE);
  if (rawHeld !== null) await writeFile(heldFile, rawHeld, {mode: 0o600});
  else if (held) await saveState(heldFile, structuredClone(held));
  for (const [name, bytes] of Object.entries(extraFiles)) await writeFile(join(directory, name), bytes, {mode: 0o600});
  const before = held || rawHeld !== null ? await readFile(heldFile) : null;
  if (mode !== null) await chmod(heldFile, mode);
  if (prepare) await prepare({directory, root: join(state, `round-${round}`)});
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
    claimConnectorEnrollment: async (_state, invitationId) => (claims.push(invitationId), await onClaim?.({directory}), {...claimed,
      credential: "secret-fresh", credentialExpiresAt: "2026-12-12T00:00:00Z", identityVersion: 3, headSeq: 2650}),
  };
  try {
    await runtime.acceptConnectorEnrollments();
  } finally {
    connectorControl.setAccounts(() => []);
    if (mode !== null) await chmod(heldFile, 0o600);
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
  // PAIR-F002: a null post-claim list counts as disabled for activation only; the credential stays retained.
  assert.deepEqual(result.activations, []);
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

// PAIR-F001 (OP-12 PAIR R1, P2; brief A1 "directory-wide held-state scan, fail-closed on an unreadable file"): any
// account file of the directory that cannot be read or parsed leaves the enrollment unclaimed, so no invitation is
// consumed and no fresh credential is lost; the stored bytes stay. PAIR-F002 (P3): a first-time claim of a raw
// config-disabled account is never activated when the post-claim list cannot be read; its credential is kept.
test("PAIR-F001 a corrupt (non-JSON) account file of the listed Room leaves the enrollment unclaimed and its bytes unchanged", async () => {
  const result = await enroll({rawHeld: '{"roomId":"room-2","baseUrl":"https://room.example/api", corrupt'});
  assert.deepEqual(result.claims, [], "never claimed on an unparseable held file");
  assert.deepEqual(result.activations, []);
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
  assert.deepEqual(result.journal, []);
});

test("PAIR-F001 an unreadable (mode 000) account file leaves the enrollment unclaimed and its bytes unchanged", async () => {
  assert.notEqual(process.getuid?.(), 0, "never run as root: mode 000 would still be readable");
  const result = await enroll({mode: 0o000});
  assert.deepEqual(result.claims, [], "never claimed on an unreadable held file");
  assert.deepEqual(result.activations, []);
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
  assert.deepEqual(result.journal, []);
});

test("PAIR-F001 an unrelated unparseable account file fails the whole directory scan closed, even for a first-time enrollment", async () => {
  const result = await enroll({held: null, listing: [{invitationId: "invite-7", roomId: "room-7"}],
    claimed: {roomId: "room-7", membershipId: "member-7"}, extraFiles: {"other.json": "not json"}});
  assert.deepEqual(result.claims, [], "fail closed for the directory");
  assert.deepEqual((await readdir(result.directory)).sort(), ["default.json", "other.json"]);
});

test("PAIR-F002 a first-time claim of a raw config-disabled account keeps the credential and is not activated when the post-claim list cannot be read", async () => {
  let failing = false;
  const result = await enroll({held: null, accountsConfig: {"member-2": {enabled: false}}, onClaim: () => { failing = true; },
    accountsFor: (cfg) => () => (failing ? null : resolvedRoomAccounts(cfg))});
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.equal((await loadState(result.heldFile)).credential, "secret-fresh", "the fresh credential is saved privately");
  assert.deepEqual(result.activations, [], "uncertain evidence never activates");
});

// PR80-O-010..O-013 (OpenClaw 0.2.80 r6; brief A1 "directory-wide held-state scan, fail-closed on an unreadable file"):
// every *.json account file is loaded through the approved state loader (regular file, no symlink, one link, 0600,
// schema) before the Room is decided; any failure or a duplicate Room binding refuses before the claim, naming the
// file and a code (never content). After the claim, a held file that fails to load, appears or changes keeps the
// consumed credential privately in a non-.json rescue file (0600, exclusive create, no symlink) without activation.
const OTHER = {...SOURCE, roomId: "room-7", membershipId: "member-7", credential: "secret-7"};
const unclaimedBecause = (result, name) => {
  assert.deepEqual(result.claims, [], "no invitation is consumed");
  assert.deepEqual(result.activations, []);
  const line = result.warnings.find((item) => item.includes("cannot be read"));
  assert.ok(line, "a scan-failure log line");
  assert.match(line, new RegExp(`account file ${name.replace(/[.]/g, "\\.")} cannot be read \\([A-Za-z0-9_]+\\); enrollment invite-9 left unclaimed`));
  assert.ok(!result.warnings.join("\n").includes("secret"), "no credential in any log line");
};

test("PR80-O-010 a valid held revoked account plus a corrupt zzz.json sorting after it leaves the enrollment unclaimed; both files stay byte for byte", async () => {
  const result = await enroll({extraFiles: {"zzz.json": '{"roomId": "room-'}});
  unclaimedBecause(result, "zzz.json");
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
  assert.equal(await readFile(join(result.directory, "zzz.json"), "utf8"), '{"roomId": "room-');
  assert.deepEqual(result.journal, [], "no abandonment before a failed scan");
});

test("PR80-O-010 a valid held revoked account plus a mode-000 zzz.json sorting after it leaves the enrollment unclaimed", async () => {
  assert.notEqual(process.getuid?.(), 0, "never run as root");
  const result = await enroll({prepare: async ({directory}) => {
    await saveState(join(directory, "zzz.json"), OTHER); await chmod(join(directory, "zzz.json"), 0o000);
  }});
  try {
    unclaimedBecause(result, "zzz.json");
    assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
  } finally { await chmod(join(result.directory, "zzz.json"), 0o600); }
});

test("PR80-O-010 order control: a corrupt aaa.json sorting before the held file refuses the same way", async () => {
  const result = await enroll({extraFiles: {"aaa.json": "not json"}});
  unclaimedBecause(result, "aaa.json");
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
});

test("PR80-O-010 two account files naming the listed Room on this server fail closed", async () => {
  const twin = structuredClone(FIXTURE); twin.membershipId = "member-2b";
  const result = await enroll({prepare: async ({directory}) => { await saveState(join(directory, "member-2b.json"), twin); }});
  assert.deepEqual(result.claims, []);
  assert.ok(result.warnings.some((line) => /duplicate_room_binding/.test(line)));
  assert.equal(Buffer.compare(result.before, await readFile(result.heldFile)), 0);
});

test("PR80-O-011 a symlinked, 0644, hard-linked or schema-invalid account file naming another Room fails the scan closed", async () => {
  const cases = {
    "link.json (symlink)": async ({directory, root}) => { await saveState(join(root, "other.json"), OTHER); await symlink(join(root, "other.json"), join(directory, "link.json")); },
    "member-7.json (0644)": async ({directory}) => { await saveState(join(directory, "member-7.json"), OTHER); await chmod(join(directory, "member-7.json"), 0o644); },
    "member-7.json (hard link)": async ({directory, root}) => { await saveState(join(directory, "member-7.json"), OTHER); await link(join(directory, "member-7.json"), join(root, "hard")); },
    "junk.json (schema-invalid)": async ({directory}) => { await writeFile(join(directory, "junk.json"), JSON.stringify({roomId: "room-7"}), {mode: 0o600}); },
    "dangling.json (dangling symlink)": async ({directory}) => { await symlink(join(directory, "nowhere"), join(directory, "dangling.json")); },
    "x.json (directory)": async ({directory}) => { await mkdir(join(directory, "x.json")); },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    const result = await enroll({held: null, listing: [{invitationId: "invite-9", roomId: "room-9"}],
      claimed: {roomId: "room-9", membershipId: "member-9"}, prepare});
    unclaimedBecause(result, label.split(" ")[0]);
  }
});

test("PR80-O-011 control: a clean directory with a valid other-Room account still claims a first-time enrollment", async () => {
  const result = await enroll({held: null, listing: [{invitationId: "invite-9", roomId: "room-9"}],
    claimed: {roomId: "room-9", membershipId: "member-9"},
    prepare: async ({directory}) => { await saveState(join(directory, "member-7.json"), OTHER); }});
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.deepEqual(result.activations, ["member-9"]);
});

async function rescueFiles(directory) {
  return (await readdir(directory)).filter((name) => /^member-2\.claimed-[0-9A-Za-z-]+$/.test(name));
}

async function assertRescued(result, {heldBytes = null} = {}) {
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.deepEqual(result.activations, [], "never activated");
  const rescued = await rescueFiles(result.directory);
  assert.equal(rescued.length, 1, "one private rescue file");
  const file = join(result.directory, rescued[0]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const kept = JSON.parse(await readFile(file, "utf8"));
  assert.equal(kept.credential, "secret-fresh", "the consumed one-time credential is retained");
  assert.equal(kept.membershipId, "member-2");
  if (heldBytes) assert.equal(Buffer.compare(heldBytes, await readFile(result.heldFile)), 0, "the held file is never overwritten");
  assert.equal(result.warnings.filter((line) => line.includes(rescued[0])).length, 1, "one log line names the rescue file");
  assert.ok(!result.warnings.join("\n").includes("secret"), "no credential in any log line");
  // Reload durability: the rescue file is not an account file; a fresh scan of the directory still works.
  const {OpenClawRoomRuntime: Runtime} = await import("../src/runtime.js");
  const probe = new Runtime({accountId: "default", stateFile: join(result.directory, "default.json"), baseUrl: SOURCE.baseUrl});
  probe.state = {...SOURCE};
  const rescan = await probe.heldAccountForRoom("room-2");
  assert.ok(!rescan?.failure, "the rescue file does not fail the scan");
}

test("PR80-O-013 a held file that appears between the scan and the post-claim read keeps the fresh credential privately", async () => {
  let appeared = null;
  const result = await enroll({held: null, onClaim: async ({directory}) => {
    const other = structuredClone(FIXTURE); other.credential = "secret-appeared";
    await saveState(join(directory, "member-2.json"), other);
    appeared = await readFile(join(directory, "member-2.json"));
  }});
  await assertRescued(result, {heldBytes: appeared});
});

test("PR80-O-013 a held file that becomes unreadable after the claim keeps the fresh credential privately", async () => {
  assert.notEqual(process.getuid?.(), 0, "never run as root");
  let atClaim = null;
  const result = await enroll({onClaim: async ({directory}) => {
    atClaim = await readFile(join(directory, "member-2.json"));
    await chmod(join(directory, "member-2.json"), 0o000);
  }});
  await chmod(result.heldFile, 0o600);
  await assertRescued(result, {heldBytes: atClaim});
});

test("PR80-O-013 a held file that changed (no longer stale) after the claim is kept and the fresh credential is retained privately", async () => {
  let changed = null;
  const result = await enroll({onClaim: async ({directory}) => {
    const active = structuredClone(FIXTURE); delete active.revoked; delete active.revokedReason; delete active.revokedAt;
    active.deliveryIntents = {}; active.credential = "secret-active";
    await saveState(join(directory, "member-2.json"), active);
    changed = await readFile(join(directory, "member-2.json"));
  }});
  await assertRescued(result, {heldBytes: changed});
});

test("PR80-O-013 the rescue writer refuses an existing name or a symlink and never overwrites", async () => {
  const runtimeModule = await import("../src/runtime.js");
  assert.equal(typeof runtimeModule.writeClaimedRescue, "function");
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-rescue-"));
  await writeFile(join(directory, "member-2.claimed-x"), "prior", {mode: 0o600});
  await assert.rejects(runtimeModule.writeClaimedRescue(directory, "member-2.claimed-x", {credential: "secret-fresh"}), /EEXIST/);
  assert.equal(await readFile(join(directory, "member-2.claimed-x"), "utf8"), "prior");
  await symlink(join(directory, "target"), join(directory, "member-2.claimed-y"));
  await assert.rejects(runtimeModule.writeClaimedRescue(directory, "member-2.claimed-y", {credential: "secret-fresh"}));
  await assert.rejects(readFile(join(directory, "target")), /ENOENT/, "nothing written through the link");
});
