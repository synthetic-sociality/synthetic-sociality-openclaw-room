import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, chmod, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadState, saveState} from "../src/state.js";

const valid = {version: 1, baseUrl: "https://room.example/api", roomId: "r", membershipId: "m", credential: "s", clientInstanceId: "i", cursor: 0};

test("persists reconnect credential privately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-"));
  const path = join(dir, "state.json");
  await saveState(path, valid);
  assert.deepEqual(await loadState(path), valid);
});

test("rejects world-readable and symlinked state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-"));
  const path = join(dir, "state.json");
  await saveState(path, valid);
  await chmod(path, 0o644);
  await assert.rejects(() => loadState(path), /0600/);
  await chmod(path, 0o600);
  const link = join(dir, "link.json");
  await symlink(path, link);
  await assert.rejects(() => loadState(link), /regular file/);
});
