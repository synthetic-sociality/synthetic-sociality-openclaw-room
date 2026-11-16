// Open-failure reason (OpenClaw 0.2.85, the Hermes twin is 1.0.110): when a
// channel cannot open, openclaw-open-failed carries one code of the contract's
// closed list in `reason`, but only when the Harness advertised
// `limits.openFailedReason: 1` in authentication-complete. Without that value
// (an older Harness with a strict schema) the frame has no `reason` key at all.
// Everything runs on loopback: a fake Harness device ingress and a fake gateway.
import assert from "node:assert/strict";
import test from "node:test";
import {EventEmitter} from "node:events";
import {mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as link from "../src/link.js";
import {LocalStatus} from "../src/local-status.js";
import {fakeGateway, fakeHarness, makeToken, waitFor} from "./support/fake-link.mjs";

link.allowLoopbackPlainForTests(true);

const GATEWAY_TOKEN = "gateway-token-0123456789abcdef";
const BASE_LIMITS = {maxDataBytes: 4096, openTimeoutMs: 2000, maxChannels: 2};
const CLOSED_LIST = ["local_gateway_refused", "local_gateway_auth_unavailable", "local_gateway_unavailable",
  "link_blocked_by_site_protection", "channel_limit", "open_timeout", "unknown"];

async function scratch(name) {
  const root = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const store = join(root, "state", "synthetic-sociality-room");
  return {recordPath: join(store, "link.json"), statusPath: join(store, "status.json"), cleanup: () => rm(root, {recursive: true, force: true})};
}

async function linked(harness, recordPath) {
  const token = link.parseToken(makeToken({audience: harness.audience}));
  link.writeLink(link.pendingRecord(token, {label: "Mac test · OpenClaw default"}), link.pendingPath(recordPath));
  const result = await link.confirmPending({path: recordPath});
  assert.equal(result.state, "active");
}

// One linked device against a fake Harness advertising `limits`; `opener`
// replaces the local gateway open. Returns the device's frames for one failed
// open (or two, for the channel cap) and the status snapshot.
async function failedOpen(limits, opener, {channels = 1} = {}) {
  const paths = await scratch("open-failed-reason");
  const harness = await fakeHarness({limits});
  const status = new LocalStatus(paths.statusPath, {version: "0.2.85", hostLabel: "test"});
  const instance = new link.LinkService({pluginVersion: "0.2.85", status, recordPath: paths.recordPath, localOpener: opener,
    backoff: () => 30, pollMs: 25, logger: {info() {}, warn() {}, error() {}}});
  let running;
  try {
    await linked(harness, paths.recordPath);
    running = instance.run();
    const device = await harness.waitDevice();
    const ids = [];
    const count = typeof channels === "function" ? channels(limits) : channels;
    for (let index = 0; index < count; index += 1) ids.push(device.open());
    const last = ids.at(-1);
    const failed = await device.waitFrame((frame) => frame.channelId === last && frame.type === "openclaw-open-failed", {timeoutMs: 5000});
    return {failed, last, snapshot: instance.snapshot(), closed: device.closed};
  } finally {
    instance.stop();
    await running;
    await harness.close();
    await paths.cleanup();
  }
}

const expected = (channelId, reason) => reason === undefined
  ? {version: 1, type: "openclaw-open-failed", channelId}
  : {version: 1, type: "openclaw-open-failed", channelId, reason};

// Without the flag: absent, another number, a string, a boolean, no limits.
const WITHOUT = [BASE_LIMITS, {...BASE_LIMITS, openFailedReason: 2}, {...BASE_LIMITS, openFailedReason: "1"},
  {...BASE_LIMITS, openFailedReason: true}, {...BASE_LIMITS, openFailedReason: 0}, null];
const WITH = {...BASE_LIMITS, openFailedReason: 1};

async function bothWays(opener, reason, statusCode, options) {
  const sent = await failedOpen(WITH, opener, options);
  assert.deepEqual(sent.failed, expected(sent.last, reason));
  assert.equal(sent.closed, null);
  assert.equal(sent.snapshot.lastChannelErrorCode, statusCode);
  for (const limits of WITHOUT) {
    const plain = await failedOpen(limits, opener, options);
    assert.deepEqual(plain.failed, expected(plain.last, undefined), `limits ${JSON.stringify(limits)}`);
    assert.equal(Object.hasOwn(plain.failed, "reason"), false);
    assert.equal(plain.snapshot.lastChannelErrorCode, statusCode);
  }
}

test("OFR-01 the capability is read only as limits.openFailedReason === 1", () => {
  assert.equal(link.readOpenFailedReason({limits: {openFailedReason: 1}}), true);
  for (const value of [undefined, 0, 2, "1", true, 1.5, null, {}]) {
    assert.equal(link.readOpenFailedReason({limits: {...BASE_LIMITS, openFailedReason: value}}), false, String(value));
  }
  assert.equal(link.readOpenFailedReason({}), false);
  assert.equal(link.readOpenFailedReason({limits: null}), false);
  assert.equal(link.readOpenFailedReason(null), false);
  // The other limits are read as before: the flag is not a limit.
  assert.deepEqual(link.readLimits({limits: {openFailedReason: 1}}), {limits: {...link.FALLBACK_LIMITS}, source: "fallback"});
});

test("OFR-02 every cause maps to exactly one code of the closed list and anything else is unknown", () => {
  assert.deepEqual([...link.OPEN_FAILED_REASONS], CLOSED_LIST);
  const reason = link.openFailedReasonFor;
  assert.equal(reason(new link.LocalGatewayError("local_gateway_refused")), "local_gateway_refused");
  assert.equal(reason(new link.LocalGatewayError("local_gateway_auth_unavailable")), "local_gateway_auth_unavailable");
  assert.equal(reason(new link.LocalGatewayError("local_gateway_unavailable")), "local_gateway_unavailable");
  assert.equal(reason(new link.LocalGatewayError("local_gateway_unavailable", "open_timeout")), "open_timeout");
  assert.equal(reason(new link.LocalGatewayError("something_new")), "unknown");
  assert.equal(reason(new link.LocalGatewayError("local_gateway_refused", "upstream said: token abc")), "unknown");
  assert.equal(reason(new Error("Bearer secret-token at 10.0.0.5")), "unknown");
  assert.equal(reason(undefined), "unknown");
  assert.equal(reason("local_gateway_refused"), "unknown");
});

test("OFR-03 a missing local credential is local_gateway_auth_unavailable, only when advertised", async () => {
  const cfg = {gateway: {port: 18789, bind: "tailnet", auth: {mode: "token", token: GATEWAY_TOKEN}}};
  await bothWays((limits) => link.openLocalGateway({cfg, env: {}, timeoutMs: limits.openTimeoutMs}), "local_gateway_auth_unavailable", "local_gateway_auth_unavailable");
});

test("OFR-04 a gateway refusing the credential is local_gateway_refused, only when advertised", async () => {
  const gateway = await fakeGateway();
  try {
    const cfg = gateway.config({auth: {mode: "token", token: "wrong-token-0123456789"}});
    await bothWays((limits) => link.openLocalGateway({cfg, env: {}, timeoutMs: limits.openTimeoutMs}), "local_gateway_refused", "local_gateway_refused");
  } finally {
    await gateway.close();
  }
});

test("OFR-05 nothing on the gateway address is local_gateway_unavailable, only when advertised", async () => {
  const cfg = {gateway: {port: 1, auth: {mode: "token", token: GATEWAY_TOKEN}}};
  await bothWays((limits) => link.openLocalGateway({cfg, env: {}, timeoutMs: limits.openTimeoutMs}), "local_gateway_unavailable", "local_gateway_unavailable");
});

test("OFR-06 an open above the device's channel cap is channel_limit, only when advertised", async () => {
  const gateway = await fakeGateway();
  try {
    const cfg = gateway.config();
    const opener = (limits) => link.openLocalGateway({cfg, env: {}, timeoutMs: limits.openTimeoutMs});
    // One open above the cap in force: advertised, or the fallback without limits.
    const aboveCap = (limits) => (limits?.maxChannels ?? link.FALLBACK_LIMITS.maxChannels) + 1;
    await bothWays(opener, "channel_limit", "channel_cap", {channels: aboveCap});
  } finally {
    await gateway.close();
  }
});

test("OFR-07 an open past the device's open deadline is open_timeout, only when advertised", async () => {
  // The relay's openTimeoutMs (1000, the lowest accepted) is the device's deadline.
  const never = () => new Promise(() => {});
  const sent = await failedOpen({...WITH, openTimeoutMs: 1000}, never);
  assert.deepEqual(sent.failed, expected(sent.last, "open_timeout"));
  assert.equal(sent.snapshot.lastChannelErrorCode, "local_gateway_unavailable");
  const plain = await failedOpen({...BASE_LIMITS, openTimeoutMs: 1000}, never);
  assert.deepEqual(plain.failed, expected(plain.last, undefined));
});

test("OFR-08 the gateway's own open deadline is open_timeout: no upgrade answer, or no challenge after it", async () => {
  // A TCP listener that never answers the upgrade.
  const sockets = new Set();
  const silent = createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const cfg = {gateway: {port: silent.address().port, auth: {mode: "token", token: GATEWAY_TOKEN}}};
    await assert.rejects(link.openLocalGateway({cfg, env: {}, timeoutMs: 200}), (error) => {
      assert.equal(error.code, "local_gateway_unavailable");
      assert.equal(link.openFailedReasonFor(error), "open_timeout");
      return true;
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
  // An upgraded socket that never sends connect.challenge.
  const socket = Object.assign(new EventEmitter(), {start() {}, send() {}, terminate() {}});
  const cfg = {gateway: {port: 18789, auth: {mode: "token", token: GATEWAY_TOKEN}}};
  // The link's deadline timer is unref'd and this fake holds no handle: keep the loop alive.
  const alive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(link.openLocalGateway({cfg, env: {}, timeoutMs: 100, connect: async () => socket}), (error) => {
      assert.equal(error.code, "local_gateway_unavailable");
      assert.equal(link.openFailedReasonFor(error), "open_timeout");
      return true;
    });
  } finally {
    clearInterval(alive);
  }
});

test("OFR-09 any other failure is unknown and no upstream text, address or credential reaches the frame", async () => {
  const leaky = () => { throw new Error(`upstream 500 at 127.0.0.1:18789 with ${GATEWAY_TOKEN}`); };
  await bothWays(leaky, "unknown", "local_gateway_unavailable");
  const sent = await failedOpen(WITH, leaky);
  assert.deepEqual(Object.keys(sent.failed).sort(), ["channelId", "reason", "type", "version"]);
  assert.equal(JSON.stringify(sent.failed).includes(GATEWAY_TOKEN), false);
  assert.equal(JSON.stringify(sent.failed).includes("127.0.0.1"), false);
  assert.ok(CLOSED_LIST.includes(sent.failed.reason));
});

test("OFR-10 a channel that opens is unaffected by the flag", async () => {
  const gateway = await fakeGateway();
  const paths = await scratch("open-failed-reason-ok");
  const harness = await fakeHarness({limits: WITH});
  const status = new LocalStatus(paths.statusPath, {version: "0.2.85", hostLabel: "test"});
  const cfg = gateway.config();
  const instance = new link.LinkService({pluginVersion: "0.2.85", status, recordPath: paths.recordPath,
    localOpener: (limits) => link.openLocalGateway({cfg, env: {}, timeoutMs: limits.openTimeoutMs}),
    backoff: () => 30, pollMs: 25, logger: {info() {}, warn() {}, error() {}}});
  let running;
  try {
    await linked(harness, paths.recordPath);
    running = instance.run();
    const device = await harness.waitDevice();
    const channelId = device.open();
    const opened = await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-opened");
    assert.deepEqual(opened, {version: 1, type: "openclaw-opened", channelId});
    device.send({version: 1, type: "openclaw-close", channelId});
    await waitFor(() => instance.snapshot().channels === 0, {label: "closed"});
    assert.equal(instance.snapshot().state, "connected");
  } finally {
    instance.stop();
    await running;
    await harness.close();
    await gateway.close();
    await paths.cleanup();
  }
});
