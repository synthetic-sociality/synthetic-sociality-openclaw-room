// Contract P2c-4 (OpenClaw 0.2.83, tkw-049 remedy OP12-TKW049-B01): once a membership is retired, a late status write
// for it (the old channel's startAccount finally, after a re-admission under a new membership id) is ignored. Adapted
// from the independent OP-12 harness openclaw-late-teardown.test.mjs (sha256 5b60d89a…4cdf), its assertions kept: the
// real channel teardown and the real acceptConnectorEnrollments run; the SDK imports are shims as in
// channel-lifecycle.test.mjs, and the old client's iterator is held open until the claim is done.
import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {mkdtemp, readFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/account-id": "export const normalizeAccountId = (value) => String(value ?? \"default\");",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const {createRoomChannel, roomLocalStatus} = await import("../src/channel.js");
const {OpenClawRoomRuntime, resetEnrollmentLineages} = await import("../src/runtime.js");
const {saveState} = await import("../src/state.js");
const {connectorControl} = await import("../src/connector-control.js");
const {LocalStatus} = await import("../src/local-status.js");

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const CASES = conformance.parityP2c4MembershipCases;

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
};

async function scenario({late = true, newId = "member-3"} = {}) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-late-teardown-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  const dir = join(root, "synthetic-sociality-room", "accounts");
  await mkdir(dir, {recursive: true, mode: 0o700});
  const sourceFile = join(dir, "default.json");
  const oldFile = join(dir, "member-2.json");
  const source = {version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "member-1",
    credential: "fixture-source", clientInstanceId: "fixture-client", cursor: 0};
  const oldState = {...source, roomId: "room-2", membershipId: "member-2", credential: "fixture-old", revoked: true,
    revokedReason: "credential_revoked"};
  await saveState(sourceFile, source);
  await saveState(oldFile, oldState);
  const cfg = {tools: {fs: {workspaceOnly: true}, deny: ["group:runtime", "group:nodes"]},
    channels: {"synthetic-sociality-room": {enabled: true, baseUrl: source.baseUrl, stateFile: sourceFile}}};
  const status = roomLocalStatus(undefined, cfg);
  status.room("room-2", "member-2", {connection: "stopped", errorCode: "credential_revoked"});
  status.room("room-sibling", "member-sibling", {connected: true, registered: true});
  const sibling = structuredClone(status.data.memberships["member-sibling"]);
  const entered = deferred();
  const release = deferred();
  let hostState = {};
  const oldClient = {
    account: {accountId: "member-2", stateFile: oldFile},
    closed: false,
    state: oldState,
    initialize: async () => ({sessionId: "fixture-session"}),
    async *assignedTurns() { entered.resolve(); await release.promise; },
    close: async () => { oldClient.closed = true; release.resolve(); connectorControl.runtimes.delete(oldClient); },
  };
  // As a real initialized runtime, the old client is in the control registry; its close drains the reader.
  connectorControl.runtimes.add(oldClient);
  const channel = createRoomChannel({makeClient: () => oldClient});
  const running = channel.plugin.gateway.startAccount({account: {accountId: "member-2", stateFile: oldFile}, accountId: "member-2", cfg,
    abortSignal: new AbortController().signal, channelRuntime: {inbound: {run: async () => {}}}, getStatus: () => hostState,
    setStatus: (value) => { hostState = value; }, log: {info() {}, warn() {}, error() {}}});
  await entered.promise;
  if (!late) {
    release.resolve();
    await running;
  }
  connectorControl.setAccounts(() => [{accountId: "default", stateFile: sourceFile, enabled: true, configEnabled: true}]);
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile: sourceFile, baseUrl: source.baseUrl}, {status, activateEnrollment: async () => {}});
  runtime.state = {...source};
  runtime.logger = {info() {}, warn() {}};
  resetEnrollmentLineages();
  runtime.client = {
    connectorEnrollments: async () => [{invitationId: "fixture-invite", roomId: "room-2"}],
    claimConnectorEnrollment: async () => ({roomId: "room-2", membershipId: newId, credential: "fixture-new", headSeq: 0}),
  };
  try {
    await runtime.acceptConnectorEnrollments();
    const afterClaim = JSON.parse(await readFile(status.path, "utf8"));
    status.room("room-2", newId, {connected: true, registered: true});
    if (late) {
      release.resolve();
      await running;
    }
    const final = JSON.parse(await readFile(status.path, "utf8"));
    assert.deepEqual(final.memberships["member-sibling"], sibling, "sibling must remain unchanged");
    return {afterClaim, final};
  } finally {
    release.resolve();
    await running;
    connectorControl.setAccounts(() => []);
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
}

test("negative control: old channel completes before new-id re-admission", async () => {
  const {afterClaim, final} = await scenario({late: false});
  assert.equal(afterClaim.memberships["member-2"], undefined);
  assert.deepEqual(final.rooms["room-2"].membershipIds, ["member-3"]);
  assert.equal(final.rooms["room-2"].connection, "connected");
});

test("negative control: same-id re-admission retains one membership", async () => {
  const {final} = await scenario({late: true, newId: "member-2"});
  assert.deepEqual(Object.keys(final.memberships).sort(), ["member-2", "member-sibling"]);
});

// OP12-TKW049-B01.
test(CASES["P2c-4-M8"], async () => {
  const {afterClaim, final} = await scenario({late: true});
  assert.equal(afterClaim.memberships["member-2"], undefined, "actual claim did forget old entry");
  assert.equal(final.memberships["member-2"], undefined, "replaced membership must stay dropped after old startAccount finally");
  assert.deepEqual(final.rooms["room-2"].membershipIds, ["member-3"]);
  assert.equal(final.rooms["room-2"].connection, "connected");

  // The writer alone: every later write of the retired (Room, membership) is ignored, also when it is the Room's only
  // membership left and when a provisional Room entry could adopt it; the same id in another Room, a fresh membership
  // and a sibling still write.
  const path = join(await mkdtemp(join(tmpdir(), "openclaw-room-retired-")), "status.json");
  const status = new LocalStatus(path, {version: "0.2.83", hostLabel: "test"});
  status.room("room-a", "m-old", {connection: "stopped", errorCode: "credential_revoked"});
  status.room("room-a", "m-sibling", {connected: true, registered: true});
  status.forget("room-a", "m-old");
  const settled = JSON.parse(await readFile(path, "utf8"));
  status.room("room-a", "m-old", {connection: "stopped"});
  status.room("room-a", "m-old", {connected: true, registered: true});
  status.room("room-a", "m-old", {ledger: {acknowledgedSeq: 9, holeSeqs: [10], quarantinedSeqs: [], ledgerCode: "ack_hole"}});
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([data.memberships, data.rooms], [settled.memberships, settled.rooms]);
  status.forget("room-a", "m-sibling");
  status.room("room-a", "", {connection: "reconnecting"});
  status.room("room-a", "m-old", {connection: "stopped"});
  assert.equal(status.data.memberships["m-old"], undefined);
  status.room("room-a", "m-new", {connected: true, registered: true});
  status.room("room-b", "m-old", {connected: true, registered: true});
  assert.deepEqual(Object.keys(status.data.memberships).sort(), ["m-new", "m-old"]);
  assert.equal(status.data.memberships["m-old"].roomId, "room-b");
  assert.deepEqual(status.data.rooms["room-a"].membershipIds, ["m-new"]);
});
