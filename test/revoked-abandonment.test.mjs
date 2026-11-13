// Contract P18 (Hermes 1.0.105, OpenClaw 0.2.80): a re-admission abandons the pending lifecycle work of a revoked
// account. OpenClaw keeps unfinished post-delivery lifecycle work as delivery intents with status lifecycle_pending or
// lifecycle_blocked; it has no inbox or pending_since ledger. Only those intents are abandoned, audited first in
// revocation-abandonment.jsonl beside the account state, and only while a listed enrollment names the Room, before the
// claim, and only when the account is inert afterwards. Case names are shared with the Hermes connector.
import assert from "node:assert/strict";
import test from "node:test";
import {lstat, mkdtemp, readFile, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime, resetEnrollmentLineages} from "../src/runtime.js";
import {connectorControl} from "../src/connector-control.js";
import {loadState, saveState} from "../src/state.js";

const FIXTURE = JSON.parse(await readFile(new URL("./fixtures/real-shaped-revoked-account-0.2.79.json", import.meta.url), "utf8"));
const REAL = Object.fromEntries(Object.entries(FIXTURE).filter(([key]) => key !== "_comment"));
const JOURNAL = "revocation-abandonment.jsonl";
const SOURCE = {
  version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
  credential: "secret-1", identityVersion: 3, clientInstanceId: "client-1", cursor: 5,
};
const clone = (value) => structuredClone(value);
const PENDING_KEY = "evt-2646:final";
const SELECTED = {version: 1, status: "selected", messagePayloadDialect: "v1", identity: {roomId: "room-2", body: "x", sourceEventId: "evt-9"}};

async function claim(stored, {liveRuntime = false, journal = null, prepare = null, mutateHeld = null, accounts = null, onClaim = null} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-p18-"));
  const sourceFile = join(directory, "default.json");
  const staleFile = join(directory, "member-2.json");
  const journalFile = join(directory, JOURNAL);
  await saveState(sourceFile, SOURCE);
  await saveState(staleFile, stored);
  if (journal !== null) await writeFile(journalFile, journal, {mode: 0o600});
  if (prepare) await prepare({directory, staleFile, journalFile});
  // PR80-O-001: the host config's account list (connector control's listedAccounts()).
  connectorControl.configure(accounts ? {accounts: () => accounts({staleFile, sourceFile})} : {});
  const sourceBefore = await readFile(sourceFile);
  const before = await readFile(staleFile);
  const activations = [];
  const claims = [];
  const runtime = new OpenClawRoomRuntime(
    {accountId: "default", stateFile: sourceFile, baseUrl: SOURCE.baseUrl},
    {activateEnrollment: async (activation) => { activations.push({activation, persisted: await loadState(activation.stateFile)}); }},
  );
  runtime.state = {...SOURCE};
  resetEnrollmentLineages();
  runtime.client = {
    connectorEnrollments: async () => [{invitationId: "invite-9", roomId: "room-2"}],
    claimConnectorEnrollment: async (_state, invitationId) => (claims.push(invitationId), onClaim?.(), {
      roomId: "room-2", membershipId: "member-2", credential: "secret-fresh",
      credentialExpiresAt: "2026-12-12T00:00:00Z", identityVersion: 3, headSeq: 2650,
    }),
  };
  if (mutateHeld) {
    const original = runtime.heldAccountForRoom.bind(runtime);
    runtime.heldAccountForRoom = async (roomId) => {
      const held = await original(roomId);
      return held && held.state ? {...held, state: mutateHeld(clone(held.state))} : held;
    };
  }
  let closed = 0;
  let old = null;
  if (liveRuntime) {
    old = {account: {stateFile: staleFile}, closed: false, close: async () => { closed += 1; old.closed = true; }};
    connectorControl.runtimes.add(old);
  }
  try {
    const activated = await runtime.acceptConnectorEnrollments();
    return {activated, activations, claims, staleFile, journalFile, before, closed, runtime,
      sourceUnchanged: Buffer.compare(sourceBefore, await readFile(sourceFile)) === 0};
  } finally {
    if (old) connectorControl.runtimes.delete(old);
    connectorControl.configure({});
  }
}

async function journalLines(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {torn: line}; } });
}

async function assertUntouched(result, message) {
  assert.deepEqual(result.claims, [], `${message}: the enrollment must not be claimed`);
  assert.deepEqual(result.activations, [], message);
  assert.equal(Buffer.compare(result.before, await readFile(result.staleFile)), 0, `${message}: the state file stays byte for byte`);
}

test("P18 owner case: a revoked account with one lifecycle_pending entry is claimed, not left unclaimed", async () => {
  const result = await claim(clone(REAL));
  assert.deepEqual(result.claims, ["invite-9"], "0.2.79 left this re-admission unclaimed");
  assert.equal((await loadState(result.staleFile)).credential, "secret-fresh");
});

test("test_p18_01_the_live_real_binding_is_replaced_by_the_fresh_credential", async () => {
  const result = await claim(clone(REAL), {liveRuntime: true});
  assert.equal(result.closed, 1, "the live runtime of the revoked account is closed first");
  assert.deepEqual(result.claims, ["invite-9"]);
  const persisted = await loadState(result.staleFile);
  assert.equal(persisted.credential, "secret-fresh");
  assert.equal(persisted.revoked, undefined, "the old credential is never re-enabled; the fresh state replaces it");
  assert.equal(persisted.cursor, 2650);
  assert.deepEqual(persisted.deliveryIntents ?? {}, {});
  assert.equal(result.activations.length, 1, "activated once through the hot reload");
  assert.equal(result.sourceUnchanged, true, "the sibling account is untouched");
});

test("test_p18_02_the_journal_records_every_abandoned_entry_and_survives_replacement_and_reload", async () => {
  const stored = clone(REAL);
  stored.deliveryIntents["evt-2640:final"] = {...clone(stored.deliveryIntents[PENDING_KEY]), status: "lifecycle_blocked",
    lifecycleState: "blocked", lifecycleAutomaticRetry: false, identity: {roomId: "room-2", body: "blocked", sourceEventId: "evt-2640"}};
  const result = await claim(stored);
  assert.deepEqual(result.claims, ["invite-9"]);
  const info = await lstat(result.journalFile);
  assert.equal(info.mode & 0o777, 0o600);
  const lines = await journalLines(result.journalFile);
  const recorded = lines.filter((line) => line.phase === "recorded");
  assert.deepEqual(recorded.map((line) => line.entry.id).sort(), ["evt-2640:final", PENDING_KEY]);
  for (const line of recorded) {
    assert.equal(line.reason, "abandoned_on_revocation");
    assert.equal(line.roomId, "room-2");
    assert.equal(line.membershipId, "member-2");
    assert.equal(line.installationId, "client-1");
    assert.equal(line.entry.kind, "delivery_intent");
    assert.deepEqual(line.entry.record, stored.deliveryIntents[line.entry.id], "the verbatim original record");
    assert.deepEqual(line.revocation, {revoked: true, disabledReason: "credential_revoked"});
    assert.match(line.auditId, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(Date.parse(line.abandonedAt)));
  }
  assert.deepEqual(lines.filter((line) => line.phase === "applied").map((line) => line.auditId).sort(),
    recorded.map((line) => line.auditId).sort());
  const text = await readFile(result.journalFile, "utf8");
  assert.ok(!text.includes("secret-old") && !text.includes("secret-fresh"), "no credential value in the journal");
  // The journal is separate from the account state: replacement and every later load/save leave it intact.
  const reloaded = await loadState(result.staleFile);
  await saveState(result.staleFile, reloaded);
  assert.equal(await readFile(result.journalFile, "utf8"), text);
});

test("test_p18_03_an_active_binding_with_pending_work_is_untouched_and_unclaimed", async () => {
  const active = clone(REAL);
  delete active.revoked; delete active.revokedReason; delete active.revokedAt;
  for (const [label, stored] of [["active", active], ["enabled with an expired credential", {...active, credentialExpiresAt: "2026-01-01T00:00:00Z"}]]) {
    const result = await claim(stored);
    await assertUntouched(result, label);
    assert.deepEqual(await journalLines(result.journalFile), [], `${label}: nothing is journaled`);
  }
});

test("test_p18_04_an_operator_disabled_binding_is_untouched_and_unclaimed", async () => {
  const disabled = clone(REAL);
  delete disabled.revoked; delete disabled.revokedReason; delete disabled.revokedAt;
  for (const [label, stored] of [
    ["state disabled", {...disabled, enabled: false}],
    ["revoked flag with an operator reason", {...clone(REAL), revokedReason: "operator_disabled"}],
  ]) {
    const result = await claim(stored);
    await assertUntouched(result, label);
    assert.deepEqual(await journalLines(result.journalFile), [], `${label}: nothing is journaled`);
  }
  // PR80-O-001: a host-config enabled:false is an operator's disable, even when the state says revoked.
  for (const [label, stored] of [["config disabled, revoked with pending work", clone(REAL)],
    ["config disabled, revoked and inert", (() => { const inert = clone(REAL); delete inert.deliveryIntents["evt-2646:final"]; return inert; })()]]) {
    const result = await claim(stored, {accounts: ({staleFile}) => [{accountId: "member-2", stateFile: staleFile, enabled: false}]});
    await assertUntouched(result, label);
    assert.deepEqual(await journalLines(result.journalFile), [], `${label}: nothing is journaled`);
  }
});

test("test_p18_05_a_replay_appends_no_duplicate_audit_entry", async () => {
  const first = await claim(clone(REAL));
  const journal = await readFile(first.journalFile, "utf8");
  // A replay of the same abandonment (the same revoked state seen again, e.g. after a rollback) keeps one record.
  const second = await claim(clone(REAL), {journal});
  assert.deepEqual(second.claims, ["invite-9"]);
  const lines = await journalLines(second.journalFile);
  assert.equal(lines.filter((line) => line.phase === "recorded").length, 1);
  assert.equal(lines.filter((line) => line.phase === "applied").length, 1);
});

test("test_p18_06_a_binding_changed_before_the_transaction_is_kept_and_unclaimed", async () => {
  // The account read for the decision differs from the one stored when the transaction runs.
  const result = await claim(clone(REAL), {mutateHeld: (state) => {
    state.deliveryIntents[PENDING_KEY].lifecycleAttempts = 2;
    return state;
  }});
  await assertUntouched(result, "changed before the transaction");
  const lines = await journalLines(result.journalFile);
  assert.ok(lines.some((line) => line.phase === "not_applied" && line.why === "stored_binding_changed"));
  assert.ok(!lines.some((line) => line.phase === "applied"));
});

test("test_p18_07_a_revoked_binding_with_an_intent_or_quarantine_is_not_abandoned", async () => {
  const cases = {
    "a selected delivery intent": (state) => { state.deliveryIntents["evt-9:final"] = clone(SELECTED); },
    "a quarantined intent": (state) => { state.deliveryIntents["evt-9:final"] = {...clone(SELECTED), status: "quarantined"}; },
    "a quarantined ledger entry": (state) => { state.receiveLedger["2648"] = {eventId: "evt-2648", status: "quarantined"}; },
    "a received ledger entry": (state) => { state.receiveLedger["2648"] = {eventId: "evt-2648", status: "received"}; },
    "an applied recovery closure": (state) => { state.appliedRecoveryClosures = {2648: {recordDigest: "sha256:aa", appliedAt: "2026-11-01T00:00:00Z"}}; },
    "failed terminal evidence": (state) => { state.terminalEvidence["2648"] = {status: "failed", sourceSeq: 2648, sourceEventId: "evt-2648", reason: "model_error"}; },
  };
  for (const [label, change] of Object.entries(cases)) {
    const stored = clone(REAL);
    change(stored);
    const result = await claim(stored);
    await assertUntouched(result, label);
    assert.deepEqual(await journalLines(result.journalFile), [], `${label}: nothing is journaled`);
  }
});

test("settled terminal intents neither block re-admission nor are journaled", async () => {
  const stored = clone(REAL);
  delete stored.deliveryIntents[PENDING_KEY];
  const result = await claim(stored);
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.equal((await loadState(result.staleFile)).credential, "secret-fresh");
  assert.deepEqual(await journalLines(result.journalFile), []);
});

test("H105-F004 a journal that is a link or not a regular file fails closed: nothing removed, no claim", async () => {
  for (const kind of ["symlink", "directory"]) {
    const result = await claim(clone(REAL), {prepare: async ({directory, journalFile}) => {
      if (kind === "symlink") {
        await writeFile(join(directory, "elsewhere.log"), "");
        await symlink(join(directory, "elsewhere.log"), journalFile);
      } else {
        const {mkdir} = await import("node:fs/promises");
        await mkdir(journalFile);
      }
    }});
    await assertUntouched(result, kind);
  }
});

test("H105-F007 a torn last line stays its own line and new records start on a fresh line", async () => {
  const torn = '{"phase":"recorded","auditId":"to';
  const result = await claim(clone(REAL), {journal: torn});
  assert.deepEqual(result.claims, ["invite-9"]);
  const text = await readFile(result.journalFile, "utf8");
  assert.ok(text.startsWith(`${torn}\n{`), "the torn line is kept unchanged and isolated");
  const lines = await journalLines(result.journalFile);
  assert.equal(lines.filter((line) => line.phase === "recorded").length, 1);
});

test("PR80-O-001 a config disable that lands before the claim keeps the account and claims nothing", async () => {
  let calls = 0;
  const result = await claim(clone(REAL), {accounts: ({staleFile}) => [{accountId: "member-2", stateFile: staleFile, enabled: calls++ < 1}]});
  assert.deepEqual(result.claims, [], "re-checked immediately before the claim");
  assert.deepEqual(result.activations, []);
  assert.equal((await loadState(result.staleFile)).credential, "secret-old", "never replaced or re-enabled");
});

test("PR80-O-001 a config disable that lands during the claim is never replaced or re-enabled", async () => {
  let disabled = false;
  const result = await claim(clone(REAL), {onClaim: () => { disabled = true; },
    accounts: ({staleFile}) => [{accountId: "member-2", stateFile: staleFile, enabled: !disabled}]});
  assert.deepEqual(result.claims, ["invite-9"]);
  assert.deepEqual(result.activations, [], "no enabled:true merge over the operator's false");
  const persisted = await loadState(result.staleFile);
  assert.equal(persisted.credential, "secret-old");
  assert.equal(persisted.revoked, true);
});

test("PR80-O-001 an unreadable host account list fails closed", async () => {
  const result = await claim(clone(REAL), {accounts: () => { throw new Error("config unreadable"); }});
  await assertUntouched(result, "unreadable config");
});
