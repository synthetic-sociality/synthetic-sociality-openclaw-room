// Shared conformance cases for the device link L1 (delivery contract section
// "L1 — Device link"). The case names are identical in the Hermes and OpenClaw
// conformance.json files. Hermes implements them first (1.0.78); in OpenClaw
// every case is planned until the P5 translation, so this suite checks the
// planned marking, the contract pins and the shared signature vector only.
import assert from "node:assert/strict";
import test from "node:test";
import {createHash, createPrivateKey, createPublicKey, sign, verify} from "node:crypto";
import {readFile, readdir} from "node:fs/promises";

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const PLANNED_REASON = "OpenClaw translation in P5 (owner: Hermes first, OpenClaw next)";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("conformance L1 cases are planned in OpenClaw with the owner's reason", async () => {
  const cases = Object.entries(conformance.parityL1Cases ?? {});
  assert.equal(cases.length, 14);
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".test.mjs"))
    .map((name) => readFile(new URL(name, directory), "utf8")));
  cases.forEach(([id, entry], index) => {
    assert.equal(id, `L1-${String(index + 1).padStart(2, "0")}`);
    assert.deepEqual(Object.keys(entry), ["name", "status", "reason"]);
    assert.ok(entry.name.startsWith(`${id} `), id);
    assert.equal(entry.status, "planned");
    assert.equal(entry.reason, PLANNED_REASON);
    // A planned case has no implementing test yet.
    assert.equal(sources.filter((source) => source.includes(`test(${JSON.stringify(entry.name)},`)).length, 0, entry.name);
  });
  assert.equal(conformance.parityL1Contract, "docs/delivery-lifecycle-contract-v1.md#l1--device-link-2026-10-03");
});

test("the L1 contract section pins both specification files", () => {
  const start = contract.indexOf("\n## L1 — Device link (2026-10-03)\n");
  assert.ok(start >= 0);
  const section = contract.slice(start);
  const specs = Object.entries(conformance.parityL1Specs ?? {});
  assert.equal(specs.length, 2);
  for (const [file, hash] of specs) {
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(section.includes(`| \`${file}\` | \`${hash}\` |`), file);
  }
});

test("the shared L1 signature vector holds for JSON.stringify and node:crypto", () => {
  const vector = conformance.parityL1SignatureVector;
  const key = createPrivateKey({key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(vector.seedHex, "hex")]), format: "der", type: "pkcs8"});
  const publicKey = createPublicKey(key);
  const spki = publicKey.export({format: "der", type: "spki"});
  assert.equal(spki.toString("base64"), vector.publicKeySpkiBase64);
  assert.equal(sha256(spki), vector.fingerprintSha256);
  assert.equal(vector.pairing.publicKeySpkiBase64, vector.publicKeySpkiBase64);
  // The documented key order, rebuilt explicitly rather than taken from the file.
  const p = vector.pairing;
  const pairing = Buffer.from(JSON.stringify({version: p.version, deviceId: p.deviceId, pairingSecret: p.pairingSecret,
    deviceLabel: p.deviceLabel, publicKeySpkiBase64: p.publicKeySpkiBase64}), "utf8");
  const h = vector.handshake;
  const handshake = Buffer.from(JSON.stringify({version: h.version, handshakeId: h.handshakeId, connectionId: h.connectionId,
    deviceId: h.deviceId, audience: h.audience, nonce: h.nonce, expiresAt: h.expiresAt}), "utf8");
  assert.equal(sha256(pairing), vector.pairingInputSha256);
  assert.equal(sha256(handshake), vector.handshakeInputSha256);
  assert.equal(sign(null, pairing, key).toString("base64"), vector.pairingSignatureBase64);
  assert.equal(sign(null, handshake, key).toString("base64"), vector.handshakeSignatureBase64);
  assert.ok(verify(null, handshake, publicKey, Buffer.from(vector.handshakeSignatureBase64, "base64")));
  // Literal UTF-8 and no escaping of / < > &, as the contract requires.
  assert.ok(pairing.includes(Buffer.from("Mac128 · Hermes claude </&>", "utf8")));
});
