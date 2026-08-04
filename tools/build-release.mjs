#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, readdir} from "node:fs/promises";
import {basename, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
await mkdir(options.output, {recursive: true, mode: 0o700});
run("npm", ["test"], packageRoot);
run("npm", ["run", "check"], packageRoot);
const before = new Set(await readdir(options.output));
run("npm", ["pack", "--pack-destination", options.output], packageRoot, {
  ...process.env,
  npm_config_cache: resolve(options.output, ".npm-cache"),
});
const created = (await readdir(options.output)).filter((name) => name.endsWith(".tgz") && !before.has(name));
if (created.length !== 1) throw new Error("Release build did not produce exactly one package archive");
const archivePath = resolve(options.output, created[0]);
const bytes = await readFile(archivePath);
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const manifest = {
  schemaVersion: 1,
  package: packageJson.name,
  version: packageJson.version,
  archive: basename(archivePath),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  openclaw: packageJson.peerDependencies.openclaw,
  pluginId: "synthetic-sociality-room",
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
