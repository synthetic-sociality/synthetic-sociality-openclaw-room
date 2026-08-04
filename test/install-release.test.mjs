import test from "node:test";
import assert from "node:assert/strict";
import {applyInstallPlan, assertTrustedSigner, createInstallPlan, findDevelopmentPath, isDevelopmentLink, isLocalInteractive, parseInstallerArguments, resolveBundlePaths} from "../tools/install-release.mjs";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

const release = {
  package: "@synthetic-sociality/openclaw-room",
  version: "0.1.0",
  pluginId: "synthetic-sociality-room",
  manifest: {sha256: "a".repeat(64)},
  publicKeyFingerprintSha256: "067f60d608e397d94bd5d0ef7f2b41d5c9794c6fe669186aad4925bf3242c4ad",
};

test("fresh installation is pinned to npm-pack and never joins a Room", () => {
  const plan = createInstallPlan({release, inventory: {plugins: []}, archive: "/safe/release.tgz"});
  assert.equal(plan.kind, "fresh-install");
  assert.deepEqual(plan.actions[0], ["plugins", "install", "npm-pack:/safe/release.tgz", "--force"]);
  assert.equal(plan.actions.some((action) => action.join(" ").includes("join")), false);
});

test("a proven development link is replaced and can be restored", async () => {
  const existing = {id: "synthetic-sociality-room", version: "0.1.0", format: "linked", source: {path: "/tmp/dev-plugin"}};
  assert.equal(isDevelopmentLink(existing), true);
  assert.equal(findDevelopmentPath(existing), "/tmp/dev-plugin");
  const plan = createInstallPlan({release, inventory: {plugins: [existing]}, archive: "/safe/release.tgz"});
  assert.equal(plan.kind, "replace-development-link");
  assert.deepEqual(plan.actions[0], ["plugins", "uninstall", "synthetic-sociality-room", "--dry-run"]);

  const calls = [];
  const runner = {run(args) { calls.push(args); if (args[0] === "plugins" && args[1] === "install" && args[2].startsWith("npm-pack:")) throw new Error("install failed"); }};
  await assert.rejects(applyInstallPlan({plan, runner}), /install failed/);
  assert.deepEqual(calls.at(-2), ["plugins", "install", "--link", "/tmp/dev-plugin"]);
  assert.deepEqual(calls.at(-1), ["plugins", "enable", "synthetic-sociality-room"]);
});

test("an unproven or managed existing installation is never destructively replaced", () => {
  assert.throws(() => createInstallPlan({release, inventory: {plugins: [{id: "synthetic-sociality-room", version: "0.0.9", source: "npm"}]}, archive: "/safe/release.tgz"}), /tracked OpenClaw update workflow/);
  assert.throws(() => createInstallPlan({release, inventory: {plugins: [{id: "synthetic-sociality-room", version: "0.1.0", format: "linked"}]}, archive: "/safe/release.tgz"}), /cannot be proven/);
});

test("same managed version is inspected without mutation", () => {
  const existing = {id: "synthetic-sociality-room", version: "0.1.0", format: "managed", source: "clawhub"};
  const plan = createInstallPlan({release, inventory: {plugins: [existing]}, archive: "/safe/release.tgz"});
  assert.equal(plan.kind, "already-installed");
  assert.deepEqual(plan.actions, [["plugins", "inspect", "synthetic-sociality-room", "--runtime", "--json"]]);
});

test("one bundle argument resolves the four verified release inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-installer-test-"));
  try {
    for (const name of ["plugin.tgz", "plugin.tgz.manifest.json", "plugin.tgz.manifest.json.sig", "release-public.pem"]) await writeFile(join(root, name), "test");
    const parsed = parseInstallerArguments(["--bundle", root, "--apply", "--openclaw", "/opt/openclaw"]);
    const resolved = await resolveBundlePaths(parsed);
    assert.equal(resolved.archive, join(root, "plugin.tgz"));
    assert.equal(resolved.manifest, join(root, "plugin.tgz.manifest.json"));
    assert.equal(resolved.signature, join(root, "plugin.tgz.manifest.json.sig"));
    assert.equal(resolved.publicKey, join(root, "release-public.pem"));
    assert.equal(resolved.apply, true);
    assert.equal(resolved.openclaw, "/opt/openclaw");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("installer pins the signer and refuses remote or piped approval", () => {
  assert.doesNotThrow(() => assertTrustedSigner(release.publicKeyFingerprintSha256));
  assert.throws(() => assertTrustedSigner("f".repeat(64)), /not trusted/);
  assert.equal(isLocalInteractive({stdin: {isTTY: true}, stdout: {isTTY: true}, env: {}}), true);
  assert.equal(isLocalInteractive({stdin: {isTTY: true}, stdout: {isTTY: true}, env: {SSH_CONNECTION: "remote"}}), false);
  assert.equal(isLocalInteractive({stdin: {isTTY: false}, stdout: {isTTY: true}, env: {}}), false);
});
