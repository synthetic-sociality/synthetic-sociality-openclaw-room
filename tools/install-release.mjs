#!/usr/bin/env node
import {readdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";
import {fileURLToPath} from "node:url";
import {parseArguments as parseReleaseArguments, verifyRelease} from "./verify-release.mjs";

const PLUGIN_ID = "synthetic-sociality-room";
const TRUSTED_SIGNER_FINGERPRINT = "067f60d608e397d94bd5d0ef7f2b41d5c9794c6fe669186aad4925bf3242c4ad";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const options = await resolveBundlePaths(parseInstallerArguments(args));
  const release = await verifyRelease(options);
  if (release.pluginId !== PLUGIN_ID) throw new Error(`Installer refuses unexpected plugin id ${release.pluginId}`);
  assertTrustedSigner(release.publicKeyFingerprintSha256);

  const runner = createRunner(options.openclaw);
  const inventory = runner.json(["plugins", "list", "--json"]);
  const plan = createInstallPlan({release, inventory, archive: options.archive});
  printPlan(plan);
  if (!options.apply) {
    stdout.write("\nPreview only. Re-run locally with --apply to request installation approval.\n");
    return;
  }
  if (!isLocalInteractive({stdin, stdout, env: process.env})) {
    throw new Error("Installation approval requires an interactive local terminal; remote or piped approval is refused");
  }

  const phrase = `INSTALL ${PLUGIN_ID} ${release.version}`;
  const rl = createInterface({input: stdin, output: stdout});
  const answer = await rl.question(`\nType exactly \"${phrase}\" to approve these changes: `);
  rl.close();
  if (answer !== phrase) throw new Error("Installation was not approved");

  await applyInstallPlan({plan, runner});
  stdout.write(`${JSON.stringify({installed: true, pluginId: PLUGIN_ID, version: release.version, roomJoined: false})}\n`);
}

export function parseInstallerArguments(values) {
  const releaseValues = [];
  let apply = false;
  let openclaw = "openclaw";
  let bundle = "";
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (key === "--apply") {
      apply = true;
      continue;
    }
    if (key === "--openclaw") {
      if (!values[index + 1]) throw new Error("--openclaw requires a path");
      openclaw = values[index + 1];
      index += 1;
      continue;
    }
    if (key === "--bundle") {
      if (!values[index + 1]) throw new Error("--bundle requires a directory");
      bundle = resolve(values[index + 1]);
      index += 1;
      continue;
    }
    releaseValues.push(key);
    if (["--archive", "--manifest", "--signature", "--public-key"].includes(key)) {
      if (!values[index + 1]) throw new Error(`${key} requires a file`);
      releaseValues.push(values[index + 1]);
      index += 1;
    }
  }
  if (bundle && releaseValues.length) throw new Error("Use --bundle or individual release files, not both");
  return bundle ? {bundle, apply, openclaw} : {...parseReleaseArguments(releaseValues), apply, openclaw};
}

export async function resolveBundlePaths(options) {
  if (!options.bundle) return options;
  const names = await readdir(options.bundle);
  const archive = exactlyOne(names.filter((name) => name.endsWith(".tgz")), "release archive");
  const manifest = exactlyOne(names.filter((name) => name.endsWith(".tgz.manifest.json")), "release manifest");
  const signature = exactlyOne(names.filter((name) => name.endsWith(".tgz.manifest.json.sig")), "release signature");
  const publicKey = exactlyOne(names.filter((name) => name.endsWith("public.pem")), "release public key");
  return {
    ...options,
    archive: join(options.bundle, archive),
    manifest: join(options.bundle, manifest),
    signature: join(options.bundle, signature),
    publicKey: join(options.bundle, publicKey),
  };
}

function exactlyOne(values, label) {
  if (values.length !== 1) throw new Error(`Bundle must contain exactly one ${label}`);
  return values[0];
}

export function createInstallPlan({release, inventory, archive}) {
  const plugins = Array.isArray(inventory) ? inventory : inventory?.plugins;
  if (!Array.isArray(plugins)) throw new Error("OpenClaw plugin inventory has an unsupported shape");
  const existing = plugins.find((plugin) => plugin?.id === PLUGIN_ID);
  if (existing && String(existing.version ?? "") === release.version && !isDevelopmentLink(existing)) {
    return {kind: "already-installed", release, existing, archive, actions: [["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"]]};
  }
  if (existing && !isDevelopmentLink(existing)) {
    throw new Error(`A managed ${PLUGIN_ID} installation already exists; use the tracked OpenClaw update workflow`);
  }

  const developmentPath = existing ? findDevelopmentPath(existing) : "";
  if (existing && !developmentPath) {
    throw new Error("A development installation exists but its linked source path cannot be proven; refusing destructive replacement");
  }
  const actions = [];
  if (existing) {
    actions.push(["plugins", "uninstall", PLUGIN_ID, "--dry-run"]);
    actions.push(["plugins", "uninstall", PLUGIN_ID]);
  }
  actions.push(["plugins", "install", `npm-pack:${archive}`, "--force"]);
  actions.push(["plugins", "enable", PLUGIN_ID]);
  actions.push(["plugins", "doctor"]);
  actions.push(["gateway", "restart"]);
  actions.push(["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"]);
  return {kind: existing ? "replace-development-link" : "fresh-install", release, existing, developmentPath, archive, actions};
}

export function assertTrustedSigner(fingerprint) {
  if (fingerprint !== TRUSTED_SIGNER_FINGERPRINT) throw new Error("Release signer fingerprint is not trusted by this installer");
}

export function isLocalInteractive({stdin: input, stdout: output, env}) {
  return input.isTTY === true && output.isTTY === true && !env.SSH_CONNECTION && !env.SSH_TTY;
}

export async function applyInstallPlan({plan, runner}) {
  if (plan.kind === "already-installed") {
    runner.run(plan.actions[0]);
    return;
  }
  let removedDevelopmentLink = false;
  try {
    for (const action of plan.actions) {
      runner.run(action);
      if (action[0] === "plugins" && action[1] === "uninstall" && !action.includes("--dry-run")) removedDevelopmentLink = true;
    }
  } catch (error) {
    if (removedDevelopmentLink && plan.developmentPath) {
      try {
        runner.run(["plugins", "install", "--link", plan.developmentPath]);
        runner.run(["plugins", "enable", PLUGIN_ID]);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Installation failed and the development link rollback also failed");
      }
    }
    throw error;
  }
}

export function isDevelopmentLink(plugin) {
  const values = flattenStrings(plugin).map((value) => value.toLowerCase());
  return plugin?.linked === true || values.some((value) => value === "link" || value === "linked" || value.startsWith("link:") || value.includes("plugins.load.paths"));
}

export function findDevelopmentPath(plugin) {
  const candidates = [plugin.path, plugin.sourcePath, plugin.installPath, plugin.location, plugin.source?.path, plugin.origin?.path];
  return candidates.find((value) => typeof value === "string" && value.startsWith("/")) ?? "";
}

function flattenStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
}

function printPlan(plan) {
  const summary = {
    operation: plan.kind,
    package: plan.release.package,
    version: plan.release.version,
    pluginId: PLUGIN_ID,
    archiveSha256: plan.release.manifest.sha256,
    signerFingerprintSha256: plan.release.publicKeyFingerprintSha256,
    replacesDevelopmentLink: plan.developmentPath || null,
    gatewayRestart: plan.kind !== "already-installed",
    roomInvitationConsumed: false,
    roomJoined: false,
    commands: plan.actions.map((args) => ["openclaw", ...args].join(" ")),
  };
  stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function createRunner(command) {
  return {
    json(args) {
      const result = execute(command, args, "pipe");
      return JSON.parse(result.stdout);
    },
    run(args) {
      execute(command, args, "inherit");
    },
  };
}

function execute(command, args, stdio) {
  const result = spawnSync(command, args, {encoding: "utf8", stdio});
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  return result;
}
