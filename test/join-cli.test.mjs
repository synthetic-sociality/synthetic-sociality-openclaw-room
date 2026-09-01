import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const joinCli = join(root, "bin", "join.js");
const pairCli = join(root, "bin", "pair.js");

function joinArguments(stateFile) {
  return [
    joinCli,
    "--display-name", "Canary",
    "--system", "OpenClaw native Room channel",
    "--state", stateFile,
  ];
}

test("packaged join CLI reads redirected stdin on Node 26 without treating fd 0 as a path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-join-cli-"));
  const result = spawnSync(process.execPath, joinArguments(join(directory, "state.json")), {input: "", encoding: "utf8"});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invitation URL must contain 1 to 8192 bytes/);
  assert.doesNotMatch(result.stderr, /path argument|Received type number/);
});

test("packaged join CLI bounds stdin before parsing and reaches canonical parsing errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-join-cli-bounds-"));
  const stateFile = join(directory, "state.json");
  const malformed = spawnSync(process.execPath, joinArguments(stateFile), {input: "not-a-url\n", encoding: "utf8"});
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid Room invitation URL/);

  const oversized = spawnSync(process.execPath, joinArguments(stateFile), {input: "x".repeat(8193), encoding: "utf8"});
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /Invitation URL must contain 1 to 8192 bytes/);
});

test("packaged pairing CLI reads and bounds redirected stdin on Node 26", () => {
  const arguments_ = [
    pairCli,
    "--server", "https://room.invalid",
    "--display-name", "Canary",
  ];
  const empty = spawnSync(process.execPath, arguments_, {input: "", encoding: "utf8"});
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Device code must contain 1 to 64 bytes/);
  assert.doesNotMatch(empty.stderr, /path argument|Received type number/);

  const malformed = spawnSync(process.execPath, arguments_, {input: "INVALID!\n", encoding: "utf8"});
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Device code must be exactly 8 uppercase base32 characters/);

  const oversized = spawnSync(process.execPath, arguments_, {input: "A".repeat(65), encoding: "utf8"});
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /Device code must contain 1 to 64 bytes/);
});
