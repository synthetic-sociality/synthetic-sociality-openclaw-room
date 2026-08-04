import test from "node:test";
import assert from "node:assert/strict";
import {validateManifest} from "../tools/verify-release.mjs";
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const valid = {
  schemaVersion: 1,
  package: "@synthetic-sociality/openclaw-room",
  version: "0.1.0",
  archive: "openclaw-room-0.1.0.tgz",
  sha256: "a".repeat(64),
  openclaw: "2026.7.1-2",
  pluginId: "synthetic-sociality-room",
};

test("accepts a pinned signed-release manifest shape", () => assert.doesNotThrow(() => validateManifest(valid)));
test("rejects unsafe archive names and invalid hashes", () => {
  assert.throws(() => validateManifest({...valid, archive: "../plugin.tgz"}), /unsafe/);
  assert.throws(() => validateManifest({...valid, sha256: "abc"}), /SHA-256/);
});

test("declares the compatibility and install metadata required by ClawHub", async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(await readFile(join(packageRoot, "openclaw.plugin.json"), "utf8"));
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.name, "@synthetic-sociality/openclaw-room");
  assert.equal(packageJson.version, pluginManifest.version);
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1-2");
  assert.equal(packageJson.openclaw.compat.minGatewayVersion, ">=2026.7.1-2");
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.7.1-2");
  assert.equal(packageJson.openclaw.build.pluginSdkVersion, "2026.7.1-2");
  assert.equal(packageJson.openclaw.install.clawhubSpec, packageJson.name);
  assert.equal(packageJson.openclaw.channel.docsPath, "README.md");
  assert.deepEqual(pluginManifest.channels, ["synthetic-sociality-room"]);
  assert.ok(pluginManifest.channelConfigs?.["synthetic-sociality-room"]?.schema);
});
