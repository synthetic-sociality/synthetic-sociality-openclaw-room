import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {activateRoomChannel, healManagedRoomChannel, resolveOpenClawBinary} from "../src/activation.js";

test("activates the Room channel through the official OpenClaw config CLI", async () => {
  let call;
  await activateRoomChannel({baseUrl: "https://room.example/api", stateFile: "/private/state.json", command: "/test/openclaw", exec(command, args, options, callback) {
    call = {command, args, options};
    callback(null, "", "");
  }});
  assert.equal(call.command, "/test/openclaw");
  assert.deepEqual(call.args, [
    "config", "set", "channels.synthetic-sociality-room",
    JSON.stringify({enabled: true, baseUrl: "https://room.example/api", stateFile: "/private/state.json"}),
    "--strict-json", "--merge",
  ]);
  assert.equal(call.options.timeout, 15_000);
});

test("activates an additional Room account without replacing the default channel state", async () => {
  let call;
  await activateRoomChannel({
    accountId: "member-2",
    baseUrl: "https://room.example/api",
    stateFile: "/private/accounts/member-2.json",
    command: "/test/openclaw",
    exec(command, args, options, callback) {
      call = {command, args, options};
      callback(null, "", "");
    },
  });

  assert.deepEqual(call.args, [
    "config", "set", "channels.synthetic-sociality-room",
    JSON.stringify({accounts: {"member-2": {
      enabled: true,
      baseUrl: "https://room.example/api",
      stateFile: "/private/accounts/member-2.json",
    }}}),
    "--strict-json", "--merge",
  ]);
});

test("activation conflict recovery reads only the active OpenClaw profile config", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "openclaw-room-profile-"));
  const stateFile = join(stateRoot, "synthetic-sociality-room", "accounts", "default.json");
  await writeFile(join(stateRoot, "openclaw.json"), JSON.stringify({channels: {
    "synthetic-sociality-room": {
      enabled: true,
      baseUrl: "https://room.example/api",
      stateFile,
    },
  }}));

  await assert.doesNotReject(() => activateRoomChannel({
    baseUrl: "https://room.example/api",
    stateFile,
    stateRoot,
    command: "/test/openclaw",
    exec(_command, _args, _options, callback) {
      callback(new Error("simulated config mutation conflict"));
    },
  }));
});

test("startup healing does not restart when the default binding remains configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "openclaw-room-heal-"));
  try {
    const stateDirectory = join(home, ".openclaw", "synthetic-sociality-room", "accounts");
    await mkdir(stateDirectory, {recursive: true});
    const stateFile = join(stateDirectory, "default.json");
    await writeFile(stateFile, JSON.stringify({baseUrl: "https://room.example/api"}));
    await writeFile(join(home, ".openclaw", "openclaw.json"), JSON.stringify({channels: {
      "synthetic-sociality-room": {
        enabled: true,
        baseUrl: "https://room.example/api",
        stateFile,
        accounts: {"member-2": {
          enabled: true,
          baseUrl: "https://room.example/api",
          stateFile: join(stateDirectory, "member-2.json"),
        }},
      },
    }}));
    let activated = 0;
    let restarted = 0;
    const healed = await healManagedRoomChannel({
      home,
      activate: async () => { activated += 1; },
      restart: () => { restarted += 1; },
    });

    assert.equal(healed, false);
    assert.equal(activated, 0);
    assert.equal(restarted, 0);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test("prefers an explicit OpenClaw binary and supports Homebrew hosts", () => {
  assert.equal(resolveOpenClawBinary({env: {OPENCLAW_BIN: "/custom/openclaw"}, exists: () => false}), "/custom/openclaw");
  assert.equal(resolveOpenClawBinary({env: {}, exists: (value) => value === "/opt/homebrew/bin/openclaw"}), "/opt/homebrew/bin/openclaw");
});
