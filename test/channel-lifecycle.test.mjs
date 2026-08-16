import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {mkdtemp, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const mocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});

const home = await mkdtemp(join(tmpdir(), "openclaw-room-channel-home-"));
process.env.HOME = home;
const {createRoomChannel} = await import("../src/channel.js");
const ID = "synthetic-sociality-room";

function config(defaultState, accounts) {
  return {
    channels: {
      [ID]: {
        enabled: true,
        baseUrl: "https://room.example/api",
        stateFile: defaultState,
        accounts: Object.fromEntries(Object.entries(accounts).map(([accountId, stateFile]) => [accountId, {
          enabled: true,
          baseUrl: "https://room.example/api",
          stateFile,
        }])),
      },
    },
  };
}

function context(account, controller = new AbortController()) {
  let status = {running: false, connected: false};
  const warnings = [];
  return {
    account,
    accountId: account.accountId,
    abortSignal: controller.signal,
    cfg: {},
    channelRuntime: {},
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    log: {info: () => {}, warn: (message) => warnings.push(message)},
    controller,
    status: () => status,
    warnings,
  };
}

test("real channel discovery maps Zurie 3-to-2 and Aura 3-to-3", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-channel-topology-"));
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias);
  const shared = join(real, "shared.json");
  const second = join(real, "second.json");
  const third = join(real, "third.json");
  await Promise.all([shared, second, third].map((path) => writeFile(path, "{}", {mode: 0o600})));
  const channel = createRoomChannel({makeClient: () => ({})});

  const zurie = config(shared, {alias: join(alias, "shared.json"), staging: second});
  assert.deepEqual(channel.plugin.config.listAccountIds(zurie), ["default", "staging"]);

  const aura = config(shared, {production: second, staging: third});
  assert.deepEqual(channel.plugin.config.listAccountIds(aura), ["default", "production", "staging"]);
});

test("gateway rejects overlapping account ownership before creating a second client", async () => {
  let created = 0;
  let closed = 0;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const channel = createRoomChannel({makeClient: () => {
    created += 1;
    return {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* () { await gate; },
      close: async () => { closed += 1; releaseFirst(); },
    };
  }});
  const first = context({accountId: "default", stateFile: join(home, "first.json")});
  const second = context({accountId: "default", stateFile: join(home, "second.json")});
  const running = channel.plugin.gateway.startAccount(first);
  await eventually(() => first.status().connected === true);
  await assert.rejects(() => channel.plugin.gateway.startAccount(second), /account is already claimed/);
  assert.equal(created, 1);
  try {
    const stopContext = context(first.account, first.controller);
    await channel.plugin.gateway.stopAccount(stopContext);
    assert.ok(closed >= 1);
  } finally {
    releaseFirst();
  }
  await running;
  assert.equal(first.status().running, false);
});

test("gateway finalizes ownership and status even when client close rejects", async () => {
  const channel = createRoomChannel({makeClient: () => ({
    initialize: async () => ({sessionId: "session-1"}),
    assignedTurns: async function* () {},
    close: async () => { throw new Error("private close detail"); },
  })});
  const ctx = context({accountId: "default", stateFile: join(home, "close-error.json")});
  await channel.plugin.gateway.startAccount(ctx);
  assert.equal(ctx.status().running, false);
  assert.equal(ctx.status().connected, false);
  assert.deepEqual(ctx.warnings, ["[default] Room client close failed"]);

  const replacement = context({accountId: "default", stateFile: join(home, "replacement.json")});
  await assert.doesNotReject(() => channel.plugin.gateway.startAccount(replacement));
});

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
