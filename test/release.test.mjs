import test from "node:test";
import assert from "node:assert/strict";
import {validateManifest} from "../tools/verify-release.mjs";
import {assertCleanReleaseWorktree, assertReleaseNodeVersion} from "../tools/release-guards.mjs";
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const valid = {
  schemaVersion: 2,
  package: "@synthetic-sociality/openclaw-room",
  version: "0.1.0",
  archive: "openclaw-room-0.1.0.tgz",
  sha256: "a".repeat(64),
  openclaw: "2026.7.1-2",
  pluginId: "synthetic-sociality-room",
  sourceCommit: "c".repeat(40),
  artifactIdentity: "npm:@synthetic-sociality/openclaw-room@0.1.0#git:"+"c".repeat(40),
  files: ["package/package.json", "package/src/index.js"],
};

test("accepts a pinned signed-release manifest shape", () => assert.doesNotThrow(() => validateManifest(valid)));
test("release builds require exact Node and a clean Git worktree", () => {
  assert.doesNotThrow(() => assertReleaseNodeVersion("v26.3.0"));
  assert.throws(() => assertReleaseNodeVersion("v22.23.1"), /Node 26\.3\.0/);
  assert.doesNotThrow(() => assertCleanReleaseWorktree(""));
  assert.throws(() => assertCleanReleaseWorktree(" M src/state.js"), /clean Git worktree/);
  assert.throws(() => assertCleanReleaseWorktree("?? untracked.txt"), /clean Git worktree/);
});
test("rejects unsafe archive names and invalid hashes", () => {
  assert.throws(() => validateManifest({...valid, archive: "../plugin.tgz"}), /unsafe/);
  assert.throws(() => validateManifest({...valid, sha256: "abc"}), /SHA-256/);
  assert.throws(() => validateManifest({...valid, sourceCommit: "unknown"}), /source commit/);
  assert.throws(() => validateManifest({...valid, artifactIdentity: "npm:wrong"}), /artifact identity/);
  assert.throws(() => validateManifest({...valid, files: []}), /file list/);
  assert.throws(() => validateManifest({...valid, files: ["package/../secret"]}), /file list/);
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
