// A4 (OpenClaw 0.2.80, connector side only; contract Appendix "Updater readiness"): status.json carries every key the
// external updater's canary gate reads, with the shared names and types. Completed-attempt counts are server-derived
// by the updater, not a connector field. Same case and field list as the Hermes connector (conformance).
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalStatus} from "../src/local-status.js";

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const TYPES = {version: "string", pluginLoaded: "boolean", pid: "number", startedAt: "string", updatedAt: "string",
  "rooms.<id>.connection": "string", "rooms.<id>.membershipId": "string", "rooms.<id>.holeSeqs": "array",
  "rooms.<id>.quarantinedSeqs": "array", "rooms.<id>.lastErrorCode": "string"};

test(conformance.statusReadinessCases[0], async () => {
  assert.deepEqual(conformance.statusReadinessFields, Object.keys(TYPES));
  assert.ok(contract.includes("Completed-attempt counts are not a connector field"));
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-status-"));
  const path = join(directory, "status.json");
  const status = new LocalStatus(path, {version: "0.2.80", hostLabel: "test"});
  status.room("room-1", "member-1", {connection: "connected", connected: true, registered: true,
    ledger: {acknowledgedSeq: 3, holeSeqs: [5], quarantinedSeqs: [7], ledgerCode: "ack_hole"}});
  status.write();
  const data = JSON.parse(await readFile(path, "utf8"));
  const room = data.rooms["room-1"];
  for (const [field, type] of Object.entries(TYPES)) {
    const value = field.startsWith("rooms.<id>.") ? room[field.slice("rooms.<id>.".length)] : data[field];
    assert.equal(type === "array" ? (Array.isArray(value) ? "array" : typeof value) : typeof value, type, field);
  }
  assert.equal(data.version, "0.2.80");
  assert.equal(data.pluginLoaded, true);
  assert.equal(data.pid, process.pid);
  for (const key of ["startedAt", "updatedAt"]) assert.ok(Number.isFinite(Date.parse(data[key])), key);
  assert.deepEqual([room.membershipId, room.connection, room.holeSeqs, room.quarantinedSeqs], ["member-1", "connected", [5], [7]]);
  assert.ok(!Object.keys(room).some((key) => /attempt/i.test(key)), "no completed-attempt field");
});
