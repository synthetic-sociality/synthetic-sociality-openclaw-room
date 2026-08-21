#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile, readdir} from "node:fs/promises";
import {basename, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {assertCleanReleaseWorktree, assertReleaseNodeVersion} from "./release-guards.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
assertReleaseNodeVersion(process.version);
assertCleanReleaseWorktree(gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]));
run("npm", ["test"], packageRoot);
run("npm", ["run", "check"], packageRoot);
assertCleanReleaseWorktree(gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]));
const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Release source commit is unavailable");
await mkdir(options.output, {recursive: true, mode: 0o700});
const before = new Set(await readdir(options.output));
const stageRoot = await mkdtemp(resolve(tmpdir(), "openclaw-room-release-"));
const stage = resolve(stageRoot, "package");
let packageJson;
let artifactIdentity;
try {
  await mkdir(stage, {recursive: true, mode: 0o700});
  const sourceArchive = resolve(stageRoot, "source.tar");
  run("git", ["archive", "--format=tar", "-o", sourceArchive, sourceCommit], packageRoot);
  run("tar", ["-xf", sourceArchive, "-C", stage], packageRoot);
  packageJson = JSON.parse(await readFile(resolve(stage, "package.json"), "utf8"));
  artifactIdentity = `npm:${packageJson.name}@${packageJson.version}#git:${sourceCommit}`;
  await writeFile(resolve(stage, "src/release-provenance.js"), `export const ROOM_CONNECTOR_PROVENANCE = Object.freeze(${JSON.stringify({version: packageJson.version, sourceCommit, artifactIdentity}, null, 2)});\n`, {mode: 0o644});
  run("npm", ["pack", "--pack-destination", options.output], stage, {
    ...process.env,
    npm_config_cache: resolve(options.output, ".npm-cache"),
  });
} finally {
  await rm(stageRoot, {recursive: true, force: true});
}
const created = (await readdir(options.output)).filter((name) => name.endsWith(".tgz") && !before.has(name));
if (created.length !== 1) throw new Error("Release build did not produce exactly one package archive");
const archivePath = resolve(options.output, created[0]);
const bytes = await readFile(archivePath);
const files = archiveEntries(archivePath);
const manifest = {
  schemaVersion: 2,
  package: packageJson.name,
  version: packageJson.version,
  archive: basename(archivePath),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  openclaw: packageJson.peerDependencies.openclaw,
  pluginId: "synthetic-sociality-room",
  sourceCommit,
  artifactIdentity,
  files,
};
const manifestPath = resolve(options.output, `${created[0]}.manifest.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o644});
const signaturePath = `${manifestPath}.sig`;
run("openssl", ["pkeyutl", "-sign", "-rawin", "-inkey", options.signingKey, "-in", manifestPath, "-out", signaturePath], packageRoot);
process.stdout.write(`${JSON.stringify({archivePath, manifestPath, signaturePath, sha256: manifest.sha256})}\n`);

function parseArguments(values) {
  const result = {output: "", signingKey: ""};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!value || !["--output", "--signing-key"].includes(key)) throw new Error("Usage: build-release --output DIR --signing-key ED25519_PRIVATE_KEY");
    if (key === "--output") result.output = resolve(value);
    if (key === "--signing-key") result.signingKey = resolve(value);
  }
  if (!result.output || !result.signingKey) throw new Error("Output directory and signing key are required");
  return result;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {cwd, env, stdio: "inherit"});
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function archiveEntries(archivePath) {
  const result = spawnSync("tar", ["-tzf", archivePath], {encoding: "utf8"});
  if (result.status !== 0) throw new Error("Release archive file list could not be read");
  const files = result.stdout.split(/\r?\n/).filter(Boolean).sort();
  if (!files.length) throw new Error("Release archive file list is empty");
  return files;
}

function gitOutput(args) {
  const result = spawnSync("git", args, {cwd: packageRoot, encoding: "utf8"});
  if (result.status !== 0) throw new Error("git provenance lookup failed");
  return result.stdout.trim();
}
