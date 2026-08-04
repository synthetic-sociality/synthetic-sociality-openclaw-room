#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {basename, dirname, resolve, join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const options = parseArguments(args);
  const result = await verifyRelease(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function verifyRelease(options) {
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  validateManifest(manifest);
  if (basename(options.archive) !== manifest.archive) throw new Error("Release archive name does not match signed manifest");
  const signature = spawnSync("openssl", ["pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", options.publicKey, "-in", options.manifest, "-sigfile", options.signature], {stdio: "inherit"});
  if (signature.status !== 0) throw new Error("Release signature verification failed");
  const publicKeyDer = spawnSync("openssl", ["pkey", "-pubin", "-in", options.publicKey, "-outform", "DER"], {encoding: null});
  if (publicKeyDer.status !== 0) throw new Error("Release public key could not be inspected");
  const publicKeyFingerprintSha256 = createHash("sha256").update(publicKeyDer.stdout).digest("hex");
  const archiveHash = createHash("sha256").update(await readFile(options.archive)).digest("hex");
  if (archiveHash !== manifest.sha256) throw new Error("Release archive hash does not match signed manifest");
  const extractRoot = await mkdtemp(join(tmpdir(), "openclaw-room-verify-"));
  try {
    run("tar", ["-xzf", options.archive, "-C", extractRoot], dirname(options.archive));
    const packageJson = JSON.parse(await readFile(join(extractRoot, "package", "package.json"), "utf8"));
    const pluginManifest = JSON.parse(await readFile(join(extractRoot, "package", "openclaw.plugin.json"), "utf8"));
    if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) throw new Error("Packaged identity does not match signed manifest");
    if (packageJson.peerDependencies?.openclaw !== manifest.openclaw) throw new Error("Packaged OpenClaw compatibility does not match signed manifest");
    if (pluginManifest.id !== manifest.pluginId) throw new Error("Packaged plugin id does not match signed manifest");
  } finally {
    await rm(extractRoot, {recursive: true, force: true});
  }
  return {verified: true, package: manifest.package, version: manifest.version, pluginId: manifest.pluginId, publicKeyFingerprintSha256, manifest};
}

export function validateManifest(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("Unsupported release manifest schema");
  for (const field of ["package", "version", "archive", "sha256", "openclaw", "pluginId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Release manifest is missing ${field}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Release manifest SHA-256 is invalid");
  if (value.archive.includes("/") || value.archive.includes("\\")) throw new Error("Release manifest archive name is unsafe");
}

export function parseArguments(values) {
  const result = {archive: "", manifest: "", signature: "", publicKey: ""};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!value || !["--archive", "--manifest", "--signature", "--public-key"].includes(key)) throw new Error("Usage: verify-release --archive FILE --manifest FILE --signature FILE --public-key FILE");
    const fields = {"--archive": "archive", "--manifest": "manifest", "--signature": "signature", "--public-key": "publicKey"};
    result[fields[key]] = resolve(value);
    index += 1;
  }
  for (const field of ["archive", "manifest", "signature", "publicKey"]) if (!result[field]) throw new Error(`${field} is required`);
  return result;
}

export function run(command, args, cwd) {
  const result = spawnSync(command, args, {stdio: "inherit", cwd});
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
