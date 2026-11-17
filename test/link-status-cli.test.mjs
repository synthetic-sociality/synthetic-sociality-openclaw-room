// OpenClaw 0.2.87: `openclaw-room-link status` shows the link state the
// running gateway reports, on every layout. The gateway writes its status
// file next to the account state in use (channel.js roomLocalStatus, contract
// P3-5), which on Aura is outside OPENCLAW_STATE_DIR; 0.2.86 read only the
// file beside link.json and printed `"link": null` there. Fakes only: the
// real bin/link.js runs as a child on a scratch HOME and state directory, the
// status file is written by the real LocalStatus, the Harness is the loopback
// fake. Never as root.
import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {allowLoopbackPlainForTests, confirmPending, parseToken, pendingPath, pendingRecord, readLink, writeLink} from "../src/link.js";
import {LocalStatus} from "../src/local-status.js";
import {fakeHarness, makeToken} from "./support/fake-link.mjs";

allowLoopbackPlainForTests(true);

const CLI = fileURLToPath(new URL("../bin/link.js", import.meta.url));
const CHANNEL = "synthetic-sociality-room";
const GATEWAY_TOKEN = "gateway-token-0123456789abcdef";
const PROVIDER_KEY = "sk-provider-key-0123456789abcdef";
const ROOM_CREDENTIAL = "room-credential-0123456789abcdef";
const NOTE = /gateway has not reported the link/u;

// A scratch host: HOME, OPENCLAW_STATE_DIR beside it (not under HOME, as on
// Aura), and a confirmed link in the fenced store.
async function host(name) {
  assert.notEqual(process.getuid?.(), 0, "never run as root");
  const root = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const home = join(root, "home");
  const stateDir = join(root, "state");
  const store = join(stateDir, CHANNEL);
  await mkdir(home, {recursive: true});
  const harness = await fakeHarness();
  const rawToken = makeToken({audience: harness.audience});
  const token = parseToken(rawToken);
  const recordPath = join(store, "link.json");
  try {
    writeLink(pendingRecord(token, {label: "Mac test · OpenClaw default"}), pendingPath(recordPath));
    assert.equal((await confirmPending({path: recordPath})).state, "active");
  } finally {
    await harness.close();
  }
  const record = readLink(recordPath);
  const secrets = [record.privateKeyBase64, token.pairingSecret, rawToken, GATEWAY_TOKEN, PROVIDER_KEY, ROOM_CREDENTIAL];
  return {root, home, stateDir, store, record, secrets, cleanup: () => rm(root, {recursive: true, force: true})};
}

// The host configuration as the gateway reads it, with credentials in it.
async function configure(paths, channel, file = join(paths.stateDir, "openclaw.json")) {
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, JSON.stringify({
    gateway: {auth: {mode: "token", token: GATEWAY_TOKEN}},
    models: {providers: {example: {apiKey: PROVIDER_KEY}}},
    channels: channel ? {[CHANNEL]: channel} : {},
  }, null, 1), {mode: 0o600});
  return file;
}

// An account state file holding a credential, where the configuration names it.
async function accountState(file) {
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  await writeFile(file, JSON.stringify({baseUrl: "https://room.example/api", credential: ROOM_CREDENTIAL}), {mode: 0o600});
  return file;
}

// What the gateway writes: the real status writer, the link as codes only.
function report(statusPath, paths, link = {}) {
  const status = new LocalStatus(statusPath, {plugin: "openclaw", version: "test", hostLabel: "test"});
  assert.equal(status.setLink({state: "connected", code: "", deviceId: paths.record.deviceId, channels: 1, limits: "advertised",
    lastConnectedAt: "2026-11-17T06:00:00.000Z", lastChannelErrorCode: "", ...link}), true);
}

function run(paths, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "status"], {
      env: {PATH: process.env.PATH, HOME: paths.home, OPENCLAW_STATE_DIR: paths.stateDir, ...env}, timeout: 20_000,
    }, (error, stdout, stderr) => resolve({code: error ? error.code ?? 1 : 0, stdout, stderr}));
  });
}

// Exit 0, one JSON document, the record's public view and never a secret.
function shown(result, paths) {
  assert.equal(result.code, 0, result.stderr);
  for (const secret of paths.secrets) {
    assert.ok(secret && !result.stdout.includes(secret) && !result.stderr.includes(secret), "a secret was printed");
  }
  assert.doesNotMatch(result.stdout + result.stderr, /privateKey|pairingSecret|apiKey|credential"/u);
  const view = JSON.parse(result.stdout);
  assert.equal(view.record.state, "active");
  assert.equal(view.record.deviceId, paths.record.deviceId);
  return view;
}

function connected(view, paths) {
  assert.deepEqual(Object.keys(view.link), ["state", "code", "deviceId", "channels", "limits", "lastConnectedAt", "lastChannelErrorCode", "updatedAt"]);
  assert.deepEqual([view.link.state, view.link.code, view.link.deviceId, view.link.channels], ["connected", "", paths.record.deviceId, 1]);
  assert.equal("note" in view, false);
}

test("LS-01 Aura layout: accounts outside OPENCLAW_STATE_DIR, the gateway's status file beside them, the link is reported", async () => {
  const paths = await host("ls-aura");
  try {
    // Aura: OPENCLAW_STATE_DIR elsewhere, accounts under ~/.openclaw (P3-08).
    const room = join(paths.home, ".openclaw", CHANNEL);
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(room, "accounts", "hpaey501k5fmc3n.json"))});
    report(join(room, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-02 a state file outside any accounts/ directory: the status file in its own directory is read", async () => {
  const paths = await host("ls-custom");
  try {
    const elsewhere = join(paths.root, "elsewhere");
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(elsewhere, "room-state.json"))});
    report(join(elsewhere, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-03 a named account outside the state directory and the configuration at OPENCLAW_CONFIG_PATH", async () => {
  const paths = await host("ls-named");
  try {
    const room = join(paths.root, "data", "room");
    const config = await configure(paths, {accounts: {main: {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(room, "accounts", "main.json"))}}},
      join(paths.root, "etc", "openclaw.json"));
    report(join(room, "status.json"), paths);
    connected(shown(await run(paths, {OPENCLAW_CONFIG_PATH: config}), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-04 accounts/ layout under the state directory: the status file beside link.json is read", async () => {
  const paths = await host("ls-accounts");
  try {
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(paths.store, "accounts", "default.json"))});
    report(join(paths.store, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-05 no accounts: the status file under the plugin root is read", async () => {
  const paths = await host("ls-none");
  try {
    await configure(paths, null);
    report(join(paths.store, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-06 a missing or unreadable configuration falls back to the file beside link.json and never throws", async () => {
  const paths = await host("ls-fallback");
  try {
    report(join(paths.store, "status.json"), paths);
    // No configuration at all.
    connected(shown(await run(paths), paths), paths);
    // Not JSON, with a credential in the text.
    const config = join(paths.stateDir, "openclaw.json");
    await writeFile(config, `{"gateway": {"auth": {"token": "${GATEWAY_TOKEN}"}}, // cut`, {mode: 0o600});
    connected(shown(await run(paths), paths), paths);
    // JSON that is not a configuration object.
    for (const text of ["null", "[]", "\"text\"", `{"channels": {"${CHANNEL}": {"stateFile": 7, "accounts": "none"}}}`]) {
      await writeFile(config, text, {mode: 0o600});
      connected(shown(await run(paths), paths), paths);
    }
    // Not readable by this user.
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: join(paths.root, "elsewhere", "room-state.json")});
    await chmod(config, 0o000);
    connected(shown(await run(paths), paths), paths);
    await chmod(config, 0o600);
    // A directory in its place, and a path that does not exist.
    await rm(config);
    await mkdir(config);
    connected(shown(await run(paths), paths), paths);
    connected(shown(await run(paths, {OPENCLAW_CONFIG_PATH: join(paths.root, "missing", "openclaw.json")}), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-07 no link entry in either file: link is null and a plain note says the gateway has not reported it", async () => {
  const paths = await host("ls-note");
  try {
    // No status file anywhere (the 0.2.86 view on Aura).
    let view = shown(await run(paths), paths);
    assert.equal(view.link, null);
    assert.match(view.note, NOTE);
    // Status files without a link entry, a broken one and a directory.
    const elsewhere = join(paths.root, "elsewhere");
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(elsewhere, "room-state.json"))});
    assert.equal(new LocalStatus(join(elsewhere, "status.json"), {plugin: "openclaw", version: "test", hostLabel: "test"}).write(), true);
    await mkdir(paths.store, {recursive: true});
    await writeFile(join(paths.store, "status.json"), "{\"link\": ", {mode: 0o600});
    view = shown(await run(paths), paths);
    assert.equal(view.link, null);
    assert.match(view.note, NOTE);
    await rm(join(paths.store, "status.json"));
    await mkdir(join(paths.store, "status.json"));
    view = shown(await run(paths), paths);
    assert.equal(view.link, null);
    assert.match(view.note, NOTE);
    // The record and the pending re-link stay as they are shown.
    assert.deepEqual(Object.keys(view), ["record", "pending", "link", "note"]);
    assert.equal(view.pending, null);
  } finally {
    await paths.cleanup();
  }
});

test("LS-08 the gateway's status file wins over an older file beside link.json; without a link entry there, the file beside link.json is shown", async () => {
  const paths = await host("ls-both");
  try {
    const elsewhere = join(paths.root, "elsewhere");
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(elsewhere, "room-state.json"))});
    report(join(paths.store, "status.json"), paths, {state: "stopped", code: "link_revoked", channels: 0});
    let view = shown(await run(paths), paths);
    assert.deepEqual([view.link.state, view.link.code], ["stopped", "link_revoked"]);
    report(join(elsewhere, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

test("LS-09 one path rule: the CLI uses the gateway's roomStatusPath and writes nothing", async () => {
  const cli = await readFile(new URL("../src/link-cli.js", import.meta.url), "utf8");
  const channel = await readFile(new URL("../src/channel.js", import.meta.url), "utf8");
  const discovery = await readFile(new URL("../src/account-discovery.js", import.meta.url), "utf8");
  assert.match(cli, /import \{roomStatusPath\} from "\.\/account-discovery\.js";/u);
  assert.match(channel, /roomStatusPath/u);
  // Defined once, and the gateway still writes through it.
  assert.equal([cli, channel, discovery].join("\n").match(/function roomStatusPath\(/gu)?.length, 1);
  assert.match(discovery, /export function roomStatusPath\(/u);
  assert.match(channel, /localStatusFor\(roomStatusPath\(cfg\)/u);
  assert.doesNotMatch(cli, /"accounts"/u);
  // Reading the status leaves both stores as they were.
  const paths = await host("ls-readonly");
  try {
    const elsewhere = join(paths.root, "elsewhere");
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(elsewhere, "room-state.json"))});
    report(join(elsewhere, "status.json"), paths);
    const before = [await readFile(join(paths.store, "link.json")), await readFile(join(elsewhere, "status.json"))];
    connected(shown(await run(paths), paths), paths);
    assert.deepEqual([await readFile(join(paths.store, "link.json")), await readFile(join(elsewhere, "status.json"))], before);
    await assert.rejects(readFile(join(paths.store, "status.json")), /ENOENT/u);
  } finally {
    await paths.cleanup();
  }
});
