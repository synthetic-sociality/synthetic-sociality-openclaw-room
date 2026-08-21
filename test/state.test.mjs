import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, chmod, link, mkdir, readdir, symlink} from "node:fs/promises";
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
  const linkPath = join(dir, "link.json");
  await symlink(path, linkPath);
  await assert.rejects(() => loadState(linkPath), /regular file/);
});

test("rejects hard-linked state without splitting or overwriting aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-hardlinked-state-"));
  const first = join(dir, "first.json");
  const second = join(dir, "second.json");
  await saveState(first, valid);
  await link(first, second);
  await assert.rejects(() => loadState(first), /must not be hard-linked/);
  await assert.rejects(() => saveState(first, {...valid, cursor: 1}), /must not be hard-linked/);
  await assert.rejects(() => loadState(second), /must not be hard-linked/);
});

test("parallel saveState calls never collide on temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-parallel-state-"));
  const path = join(dir, "state.json");
  const originalNow = Date.now;
  Date.now = () => 1_234_567_890;
  try {
    const results = await Promise.allSettled(
      Array.from({length: 64}, (_, cursor) => saveState(path, {...valid, cursor})),
    );
    assert.equal(results.filter(({status}) => status === "rejected").length, 0);
    const finalState = await loadState(path);
    assert.equal(finalState.cursor, 63);
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".tmp-")), []);
  } finally {
    Date.now = originalNow;
  }
});

test("failed saveState removes secret-bearing temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-room-failed-state-"));
  const targetDirectory = join(dir, "state.json");
  await mkdir(targetDirectory);
  await assert.rejects(() => saveState(targetDirectory, valid));
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".tmp-")), []);
});
