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
import {readFileSync} from "node:fs";
import {chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
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
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const titles = [];
const cases = new Map();
const ls = (title, run) => {
  titles.push(title);
  cases.set(title.slice(0, 5), run);
  test(title, run);
};
// The shared cases of contract L1-11a (conformance parityL1StatusCommandCases,
// the same strings as Hermes). Each one runs the OpenClaw cases that carry it,
// whole and unchanged.
const shared = [];
const lsc = (title, ...ids) => {
  shared.push(title);
  test(title, async (t) => {
    for (const id of ids) await cases.get(id)(t);
  });
};

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

function run(paths, env = {}, cli = CLI) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, "status"], {
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

ls("LS-01 Aura layout: accounts outside OPENCLAW_STATE_DIR, the gateway's status file beside them, the link is reported", async () => {
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

ls("LS-02 a state file outside any accounts/ directory: the status file in its own directory is read", async () => {
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

ls("LS-03 the configuration at OPENCLAW_CONFIG_PATH; named accounts alone leave the gateway's file under the plugin root", async () => {
  const paths = await host("ls-named");
  try {
    const room = join(paths.root, "data", "room");
    const file = join(paths.root, "etc", "openclaw.json");
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(room, "accounts", "main.json"))}, file);
    report(join(room, "status.json"), paths);
    connected(shown(await run(paths, {OPENCLAW_CONFIG_PATH: file}), paths), paths);
    // Without the variable that configuration is not found: nothing is reported.
    assert.match(shown(await run(paths), paths).note, NOTE);
    // The gateway's rule takes the first account with a state file, which is
    // the default account's managed path: the plugin root, not the named one.
    await configure(paths, {accounts: {main: {enabled: true, baseUrl: "https://room.example/api", stateFile: join(room, "accounts", "main.json")}}}, file);
    report(join(room, "status.json"), paths, {state: "stopped", code: "link_revoked", channels: 0});
    report(join(paths.store, "status.json"), paths);
    connected(shown(await run(paths, {OPENCLAW_CONFIG_PATH: file}), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

ls("LS-04 accounts/ layout under the state directory: the status file beside link.json is read", async () => {
  const paths = await host("ls-accounts");
  try {
    await configure(paths, {enabled: true, baseUrl: "https://room.example/api", stateFile: await accountState(join(paths.store, "accounts", "default.json"))});
    report(join(paths.store, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

ls("LS-05 no accounts: the status file under the plugin root is read", async () => {
  const paths = await host("ls-none");
  try {
    await configure(paths, null);
    report(join(paths.store, "status.json"), paths);
    connected(shown(await run(paths), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

ls("LS-06 a missing or unreadable configuration falls back to the file beside link.json and never throws", async () => {
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

ls("LS-07 no link entry in either file: link is null and a plain note says the gateway has not reported it", async () => {
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

ls("LS-08 the gateway's status file wins over an older file beside link.json; without a link entry there, the file beside link.json is shown", async () => {
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

ls("LS-09 one path rule: the CLI uses the gateway's roomStatusPath and writes nothing", async () => {
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

// The pinned host, found as test/host-load.test.mjs finds it.
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINNED_HOST = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).peerDependencies.openclaw;
function installedHost() {
  const candidates = [process.env.OPENCLAW_HOST_ROOT];
  try { candidates.push(dirname(createRequire(join(PLUGIN_ROOT, "package.json")).resolve("openclaw/package.json"))); } catch {}
  candidates.push("/usr/local/lib/node_modules/openclaw");
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version === PINNED_HOST) return candidate;
    } catch {}
  }
  return null;
}

// A configuration as the host accepts it (JSON5): comments, unquoted keys,
// single quotes and trailing commas, with credentials in it.
async function configureJson5(paths, stateFile) {
  const file = join(paths.stateDir, "openclaw.json");
  await writeFile(file, `// Aura host configuration
{
  gateway: {auth: {mode: 'token', token: '${GATEWAY_TOKEN}'}}, /* the shared token */
  models: {providers: {example: {apiKey: "${PROVIDER_KEY}"}}},
  channels: {
    "${CHANNEL}": {
      enabled: true,
      baseUrl: 'https://room.example/api',
      stateFile: ${JSON.stringify(stateFile)}, // outside OPENCLAW_STATE_DIR
    },
  },
}
`, {mode: 0o600});
  assert.throws(() => JSON.parse(readFileSync(file, "utf8")), SyntaxError);
  return file;
}

ls("LS-10 a JSON5 configuration (comments, a trailing comma, an unquoted key) is read like the host reads it: Aura layout, the link is reported", async (t) => {
  const hostRoot = installedHost();
  if (!hostRoot) return t.skip(`OpenClaw ${PINNED_HOST} is not installed (set OPENCLAW_HOST_ROOT): its json5 cannot be loaded`);
  const paths = await host("ls-json5");
  try {
    const room = join(paths.home, ".openclaw", CHANNEL);
    await configureJson5(paths, await accountState(join(room, "accounts", "hpaey501k5fmc3n.json")));
    report(join(room, "status.json"), paths);
    // The host is found from its binary, as activation.js finds it.
    connected(shown(await run(paths, {OPENCLAW_BIN: join(hostRoot, "openclaw.mjs")}), paths), paths);
    // And as the peer of the plugin's own location, with no host binary.
    const plugin = join(paths.root, "plugin");
    for (const name of ["bin", "src", "package.json"]) await cp(join(PLUGIN_ROOT, name), join(plugin, name), {recursive: true});
    await mkdir(join(plugin, "node_modules"));
    await symlink(hostRoot, join(plugin, "node_modules", "openclaw"));
    connected(shown(await run(paths, {OPENCLAW_BIN: join(paths.root, "no-host", "openclaw.mjs")}, join(plugin, "bin", "link.js")), paths), paths);
  } finally {
    await paths.cleanup();
  }
});

ls("LS-11 a JSON5 configuration without a resolvable host json5 falls back to the file beside link.json; the note says the configuration could not be read and nothing of it is printed", async () => {
  const paths = await host("ls-json5-nohost");
  try {
    // A copy of the plugin with no host above it, and no host binary.
    const plugin = join(paths.root, "plugin");
    for (const name of ["bin", "src", "package.json"]) await cp(join(PLUGIN_ROOT, name), join(plugin, name), {recursive: true});
    const cli = join(plugin, "bin", "link.js");
    const env = {OPENCLAW_BIN: join(paths.root, "no-host", "openclaw.mjs")};
    const room = join(paths.home, ".openclaw", CHANNEL);
    await configureJson5(paths, await accountState(join(room, "accounts", "hpaey501k5fmc3n.json")));
    report(join(room, "status.json"), paths);
    let result = await run(paths, env, cli);
    let view = shown(result, paths);
    assert.equal(view.link, null);
    assert.match(view.note, NOTE);
    assert.match(view.note, /configuration could not be read/u);
    assert.doesNotMatch(result.stdout + result.stderr, /Aura host configuration|shared token|room\.example|hpaey501k5fmc3n/u);
    // A relative or bare binary name is never looked up.
    for (const bin of ["openclaw", "./openclaw.mjs"]) {
      result = await run(paths, {OPENCLAW_BIN: bin}, cli);
      assert.match(shown(result, paths).note, /configuration could not be read/u);
    }
    // The file beside link.json still answers.
    report(join(paths.store, "status.json"), paths, {state: "stopped", code: "link_revoked", channels: 0});
    view = shown(await run(paths, env, cli), paths);
    assert.deepEqual([view.link.state, view.link.code, "note" in view], ["stopped", "link_revoked", false]);
  } finally {
    await paths.cleanup();
  }
});

lsc("LSC-01 the status file the gateway writes is found by the gateway's own path rule, also when it is not beside the link record", "LS-01", "LS-02", "LS-03", "LS-09");
lsc("LSC-02 the link record without its secrets and the link object are shown as the gateway reports them", "LS-04", "LS-05", "LS-08");
lsc("LSC-03 no status file names the link: a plain statement that the gateway has not reported it", "LS-07");
lsc("LSC-04 a missing or unreadable status file or host configuration never fails the command", "LS-06", "LS-07", "LS-11");
lsc("LSC-05 a host configuration is read the way the host reads it; without such a dependency none is read", "LS-10");
lsc("LSC-06 the command writes nothing and prints no credential, configuration or account content", "LS-09", "LS-11");

test("LS conformance: the regression cases are the ones pinned in conformance.json", () => {
  assert.deepEqual(titles, conformance.linkStatusCliCases);
});

test("LSC parity: the six shared cases of contract L1-11a are the ones pinned in conformance.json, and the paragraph follows L1-11", async () => {
  assert.deepEqual(conformance.parityL1StatusCommandCases, shared);
  assert.deepEqual(shared.map((title) => title.slice(0, 6)), ["LSC-01", "LSC-02", "LSC-03", "LSC-04", "LSC-05", "LSC-06"]);
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  const section = contract.slice(contract.indexOf("\n## L1 "), contract.indexOf("\n## ", contract.indexOf("\n## L1 ") + 1));
  assert.match(section, /`channel_binary`, or empty\) and `updatedAt`\.\n\nL1-11a Status command \(2026-11-17\)\. Each connector gives the person one command/u);
  assert.match(section, /\(Hermes: `hermes room link status`; OpenClaw: `openclaw-room-link status`\)/u);
});
