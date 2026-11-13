// A4 (OpenClaw 0.2.80, connector side only): status.json carries what the external updater reads from Hermes'
// status.json (contract Appendix P2c-4, §U-5): version, pluginLoaded, pid, startedAt, updatedAt and per-Room
// connection with membership id and last error code. The same keys and types as Hermes local_status.py.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalStatus} from "../src/local-status.js";

test("A4 status.json carries the updater health fields with Hermes' names and types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-status-"));
  const path = join(directory, "status.json");
  const status = new LocalStatus(path, {version: "0.2.80", hostLabel: "test"});
  status.room("room-1", "member-1", {connection: "connected", connected: true, registered: true});
  status.write();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.equal(data.version, "0.2.80");
  assert.equal(data.pluginLoaded, true);
  assert.equal(data.pid, process.pid);
  for (const key of ["startedAt", "updatedAt"]) assert.ok(Number.isFinite(Date.parse(data[key])), key);
  assert.equal(typeof data.rooms, "object");
  const room = data.rooms["room-1"];
  assert.ok(room, "per-Room entry");
  assert.equal(room.membershipId, "member-1");
  assert.equal(room.connection, "connected");
  assert.equal(typeof (room.lastErrorCode ?? ""), "string");
});
