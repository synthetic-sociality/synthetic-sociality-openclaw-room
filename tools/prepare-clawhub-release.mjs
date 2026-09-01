#!/usr/bin/env node
import {cp, lstat, mkdtemp, readFile, rm} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {readPackagedProvenance, verifyRelease} from "./verify-release.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const options = parseArguments(args);
  await assertMissing(options.output);
  const release = await verifyRelease(options);
  const extractRoot = await mkdtemp(join(tmpdir(), "openclaw-room-clawhub-"));
  try {
    run("tar", ["-xzf", options.archive, "-C", extractRoot], dirname(options.archive));
    const packageDirectory = join(extractRoot, "package");
    await validateClawHubPackage(packageDirectory, release.manifest);
    await cp(packageDirectory, options.output, {recursive: true, errorOnExist: true, force: false});
  } finally {
    await rm(extractRoot, {recursive: true, force: true});
  }
  process.stdout.write(`${JSON.stringify({
    prepared: true,
    packageDirectory: options.output,
    package: release.package,
    version: release.version,
    sourceCommit: release.manifest.sourceCommit,
    artifactIdentity: release.manifest.artifactIdentity,
    signerFingerprintSha256: release.publicKeyFingerprintSha256,
  })}\n`);
}

export async function validateClawHubPackage(packageDirectory, manifest) {
  const packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(await readFile(join(packageDirectory, "openclaw.plugin.json"), "utf8"));
  const conformance = JSON.parse(await readFile(join(packageDirectory, "conformance.json"), "utf8"));
  const provenance = await readPackagedProvenance(join(packageDirectory, "src", "release-provenance.js"));
  validateClawHubIdentity({manifest, packageJson, pluginManifest, conformance, provenance});
  return {packageJson, pluginManifest, conformance, provenance};
}

export function validateClawHubIdentity({manifest, packageJson, pluginManifest, conformance, provenance}) {
  const expectedArtifactIdentity = `npm:${manifest.package}@${manifest.version}#git:${manifest.sourceCommit}`;
  if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) {
    throw new Error("ClawHub package identity does not match the reviewed release");
  }
  if (pluginManifest.id !== manifest.pluginId || pluginManifest.version !== manifest.version) {
    throw new Error("ClawHub plugin metadata does not match the reviewed release");
  }
  if (conformance.adapter !== manifest.pluginId || conformance.adapterVersion !== manifest.version) {
    throw new Error("ClawHub conformance metadata does not match the reviewed release");
  }
  if (provenance.version !== manifest.version || provenance.sourceCommit !== manifest.sourceCommit || provenance.artifactIdentity !== expectedArtifactIdentity) {
    throw new Error("ClawHub runtime provenance does not match the reviewed release; raw source or unbuilt bytes cannot be published");
  }
}

export function parseArguments(values) {
  const result = {archive: "", manifest: "", signature: "", publicKey: "", output: ""};
  const fields = {
    "--archive": "archive",
    "--manifest": "manifest",
    "--signature": "signature",
    "--public-key": "publicKey",
    "--output": "output",
  };
  for (let index = 0; index < values.length; index += 2) {
    const field = fields[values[index]];
    const value = values[index + 1];
    if (!field || !value) {
      throw new Error("Usage: prepare-clawhub-release --archive FILE --manifest FILE --signature FILE --public-key FILE --output NEW_DIRECTORY");
    }
    result[field] = resolve(value);
  }
  for (const field of Object.values(fields)) if (!result[field]) throw new Error(`${field} is required`);
  return result;
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("ClawHub output directory already exists; choose a new path");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, stdio: "inherit"});
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}
