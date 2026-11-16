// Contract P11b-3 (remedy r1 F1, the Cloudflare 1010 lesson; the Hermes twin
// is hermes-link-ua): every device link request to the Harness origin sends
// `openclaw-room-link/<version>`; a bot-protection 403 has its own code and
// stays pending; a pairing 404 after a lost 201 links when a signed connect
// with the pending key completes. A fake origin stands in for Cloudflare's
// Browser Integrity Check: it answers 403 `error code: 1010` to a request
// without a User-Agent or with a library default.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PassThrough} from "node:stream";
// A namespace import: on a head without P11b-3 each case fails on its own.
import * as link from "../src/link.js";
import {runLinkCli} from "../src/link-cli.js";
import {ROOM_USER_AGENT} from "../src/room-client.js";
import {fakeGateway, fakeHarness, makeToken, waitFor} from "./support/fake-link.mjs";

link.allowLoopbackPlainForTests(true);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const LINK_AGENT = `openclaw-room-link/${packageJson.version}`;
const CLOUDFLARE_1010 = {status: 403, headers: {"content-type": "text/plain; charset=UTF-8", server: "cloudflare", "cf-ray": "8f00000000000000-FRA"}, text: "error code: 1010"};

// Cloudflare BIC as Paula saw it: no agent or a library default is refused.
const botProtection = (request) => {
  const agent = String(request.headers["user-agent"] ?? "");
  return !agent || /^(node|undici|Python-urllib)/iu.test(agent) ? CLOUDFLARE_1010 : null;
};

async function scratch(name) {
  const root = await mkdtemp(join(tmpdir(), `openclaw-room-${name}-`));
  const store = join(root, "state", "synthetic-sociality-room");
  return {root, recordPath: join(store, "link.json"), statusPath: join(store, "status.json"), cleanup: () => rm(root, {recursive: true, force: true})};
}

function pending(harness, recordPath) {
  const token = link.parseToken(makeToken({audience: harness.audience}));
  link.writeLink(link.pendingRecord(token, {label: "Mac test · OpenClaw default"}), link.pendingPath(recordPath));
  return token;
}

function service(paths, gateway, overrides = {}) {
  const instance = new link.LinkService({
    pluginVersion: packageJson.version,
    recordPath: paths.recordPath,
    localOpener: (limits) => link.openLocalGateway({cfg: gateway.config(), env: {}, maxDataBytes: limits.maxDataBytes, timeoutMs: limits.openTimeoutMs}),
    backoff: () => 30,
    pollMs: 25,
    ...overrides,
  });
  const running = instance.run();
  return {instance, stop: async () => { instance.stop(); await running; }};
}

function sink() {
  const stream = new PassThrough();
  stream.text = "";
  stream.on("data", (chunk) => { stream.text += chunk; });
  return stream;
}

function ttyInput(text) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.end(text);
  return input;
}

test("P11b-3 the pairing confirmation sends openclaw-room-link/<version> and passes a bot protection that refuses a missing or library User-Agent with 1010", async () => {
  const paths = await scratch("p11b3-confirm");
  const harness = await fakeHarness({edge: botProtection});
  try {
    pending(harness, paths.recordPath);
    assert.deepEqual(await link.confirmPending({path: paths.recordPath}), {state: "active", code: ""});
    assert.equal(harness.edged.length, 0);
    assert.equal(harness.confirmations.at(-1).headers["user-agent"], LINK_AGENT);
    assert.equal(link.linkUserAgent?.("1.2.3"), "openclaw-room-link/1.2.3");
  } finally {
    await harness.close();
    await paths.cleanup();
  }
});

test("P11b-3 the device socket upgrade sends openclaw-room-link/<version> through the same bot protection", async () => {
  const paths = await scratch("p11b3-socket");
  // The confirmation passes on its own agent check; only the upgrade is judged here.
  const harness = await fakeHarness({edge: (request) => (request.headers.upgrade ? (request.headers["user-agent"] === LINK_AGENT ? null : CLOUDFLARE_1010) : null)});
  const gateway = await fakeGateway();
  let running;
  try {
    pending(harness, paths.recordPath);
    assert.equal((await link.confirmPending({path: paths.recordPath})).state, "active");
    running = service(paths, gateway);
    await harness.waitDevice();
    assert.equal(harness.upgrades[0].headers["user-agent"], LINK_AGENT);
    assert.deepEqual(harness.edged.map((item) => [item.kind, item.headers["user-agent"]]), []);
    // The loopback requests to the local Gateway are unchanged (no link agent).
    const device = harness.devices[0];
    const channelId = device.open();
    await device.waitFrame((frame) => frame.channelId === channelId && frame.type === "openclaw-opened");
    assert.notEqual(gateway.upgrades[0].headers["user-agent"], LINK_AGENT);
  } finally {
    await running?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("P11b-3 a bot-protection 403 is link_blocked_by_site_protection and stays pending, the person reads it plainly, and the Harness's own 403 keeps its code", async () => {
  const cases = [
    ["1010 body", () => CLOUDFLARE_1010, "link_blocked_by_site_protection"],
    ["Cloudflare page without Harness JSON", () => ({status: 403, headers: {"content-type": "text/html", "cf-ray": "8f00000000000001-FRA"}, text: "<html>Attention Required</html>"}), "link_blocked_by_site_protection"],
    ["1010 body without Cloudflare headers", () => ({status: 403, headers: {"content-type": "text/plain"}, text: "error code: 1010"}), "link_blocked_by_site_protection"],
    ["Harness JSON 403", () => ({status: 403, headers: {"content-type": "application/json"}, text: JSON.stringify({error: "forbidden"})}), "link_pairing_unavailable"],
  ];
  for (const [name, edge, code] of cases) {
    const paths = await scratch("p11b3-403");
    const harness = await fakeHarness({edge: (request) => (request.method === "POST" ? edge() : null)});
    try {
      pending(harness, paths.recordPath);
      assert.deepEqual(await link.confirmPending({path: paths.recordPath}), {state: "pending", code}, name);
      assert.ok(link.readLink(link.pendingPath(paths.recordPath)), `${name}: still pending`);
      assert.equal(link.readLink(paths.recordPath), null, name);
    } finally {
      await harness.close();
      await paths.cleanup();
    }
  }
  // The person sees a plain reason, not a code alone.
  const paths = await scratch("p11b3-cli");
  const harness = await fakeHarness({edge: () => CLOUDFLARE_1010});
  const gateway = await fakeGateway();
  let running;
  try {
    const output = sink();
    assert.equal(await runLinkCli(["link"], {input: ttyInput(`${makeToken({audience: harness.audience})}\ry\n`), output, errors: sink(), path: paths.recordPath, label: "Mac test"}), 0);
    assert.match(output.text, /blocked by the site's bot protection/);
    assert.match(output.text, /link_blocked_by_site_protection/);
    assert.doesNotMatch(output.text, /link_pairing_unavailable/);
    // The device socket refused by the same edge reports the same code and reconnects.
    link.writeLink((({pairingSecret: _s, expiresAt: _e, ...rest}) => ({...rest, state: "active"}))(link.readLink(link.pendingPath(paths.recordPath))), paths.recordPath);
    const codes = [];
    running = service(paths, gateway, {status: {setLink: (value) => codes.push(value.code)}});
    await waitFor(() => codes.includes("link_blocked_by_site_protection"), {label: "socket blocked"});
    assert.equal(running.instance.snapshot().state, "reconnecting");
  } finally {
    await running?.stop();
    await gateway.close();
    await harness.close();
    await paths.cleanup();
  }
});

test("P11b-3 a pairing 404 after a lost 201 links when a signed connect with the pending key completes, otherwise it stays refused", async () => {
  // The server already holds the device active (the 201 was lost), so a
  // repeated confirmation answers 404; the pending key still authenticates.
  const paths = await scratch("p11b3-404");
  const harness = await fakeHarness({confirmation: (entry, state) => {
    state.keys.set(entry.body.deviceId, entry.body.publicKeySpkiBase64);
    return {status: 404, body: {error: "not_found"}};
  }});
  try {
    pending(harness, paths.recordPath);
    const key = link.readLink(link.pendingPath(paths.recordPath)).privateKeyBase64;
    assert.deepEqual(await link.confirmPending({path: paths.recordPath}), {state: "active", code: ""});
    const record = link.readLink(paths.recordPath);
    assert.equal(record.state, "active");
    assert.equal(record.privateKeyBase64, key);
    assert.ok(!("pairingSecret" in record));
    assert.equal(harness.devices.length, 1);
    assert.ok(harness.devices[0].proofVerified, "the probe signed with the pending key");
    assert.equal(harness.upgrades[0].headers["user-agent"], LINK_AGENT);
  } finally {
    await harness.close();
    await paths.cleanup();
  }
  // A genuine refusal: the 404 stands when the signed connect is refused.
  const refusedPaths = await scratch("p11b3-404r");
  const refusing = await fakeHarness({confirmation: () => ({status: 404, body: {error: "not_found"}}), connectStatus: 404});
  try {
    pending(refusing, refusedPaths.recordPath);
    assert.deepEqual(await link.confirmPending({path: refusedPaths.recordPath}), {state: "refused", code: "link_pairing_refused"});
    assert.equal(link.readLink(refusedPaths.recordPath).state, "refused");
  } finally {
    await refusing.close();
    await refusedPaths.cleanup();
  }
});

test("P11b-3 the Room API client keeps its P11b-1 value", () => {
  const p11b1 = contract.slice(contract.indexOf("P11b-1 Product User-Agent."), contract.indexOf("P11b-2 Shared conformance."));
  const named = p11b1.replace(/\s+/gu, " ").match(/OpenClaw: `([^`]+)`/u);
  assert.ok(named, "P11b-1 names the OpenClaw value");
  assert.equal(ROOM_USER_AGENT, named[1]);
  assert.ok(contract.includes("the Room API client keeps its P11b-1 value"));
});
