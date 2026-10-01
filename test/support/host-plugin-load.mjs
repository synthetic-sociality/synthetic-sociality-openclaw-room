// Loads a plugin module exactly as the installed OpenClaw host does
// (dist loader createPluginModuleLoader, rebuilt from the host's own exported
// pieces), then reports the outcome as JSON. Run in a child process: the host
// installs process-wide require hooks. Usage: node host-plugin-load.mjs HOST_ROOT ENTRY [CHANNEL]
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [hostRoot, entry, channel] = process.argv.slice(2);
const dist = join(hostRoot, "dist");

function findModule(marker) {
  const hits = readdirSync(dist).filter((name) => name.endsWith(".js") && readFileSync(join(dist, name), "utf8").includes(marker));
  if (hits.length !== 1) throw new Error(`expected one host module containing ${JSON.stringify(marker)}, found ${hits.length}`);
  return join(dist, hits[0]);
}
function exportAliases(file) {
  const last = readFileSync(file, "utf8").trimEnd().split("\n").at(-1);
  return Object.fromEntries([...last.matchAll(/(\w+) as (\w+)/g)].map(([, name, alias]) => [name, alias]));
}
async function hostModule(marker) {
  const file = findModule(marker);
  const mod = await import(pathToFileURL(file).href);
  const aliases = exportAliases(file);
  return {file, pick: (name) => {
    if (!(name in aliases)) throw new Error(`host module ${file} does not export ${name}`);
    return mod[aliases[name]];
  }};
}

const loader = await hostModule("function createPluginModuleLoader(options) {");
const cache = await hostModule("function getCachedPluginModuleLoader(params) {");
const payloads = await hostModule("function setReplyPayloadMetadata(payload, metadata) {");
const importerUrl = pathToFileURL(loader.file).href;
const testing = loader.pick("testing");
const moduleLoaders = cache.pick("createPluginModuleLoaderCache")();

// Same steps as the host's createPluginModuleLoader (loader-*.js, `createLoaderForModule`).
function loadPluginModule(modulePath) {
  cache.pick("installOpenClawPluginSdkNativeResolver")({argv1: process.argv[1], moduleUrl: importerUrl, pluginModulePath: modulePath});
  const load = cache.pick("getCachedPluginModuleLoader")({
    cache: moduleLoaders, modulePath, importerUrl, loaderFilename: modulePath,
    aliasMap: testing.buildPluginLoaderAliasMap(modulePath, process.argv[1], importerUrl),
  });
  return load(cache.pick("toSafeImportPath")(modulePath));
}

const result = {};
try {
  const mod = loadPluginModule(entry);
  const plugin = mod?.default ?? mod;
  result.entry = {ok: true, id: plugin?.id ?? plugin?.plugin?.id ?? null, exports: Object.keys(mod ?? {})};
} catch (error) {
  result.entry = {ok: false, name: error?.name, message: String(error?.message ?? error).split("\n")[0]};
}
if (channel && result.entry.ok) {
  try {
    const mod = loadPluginModule(channel);
    const warning = payloads.pick("setReplyPayloadMetadata")({text: "warning", isError: true}, {nonTerminalToolErrorWarning: true});
    result.notice = {
      toolWarning: await mod.hostNoticeKind(warning, {kind: "final"}),
      fallback: await mod.hostNoticeKind({text: "notice", isFallbackNotice: true}, {kind: "final"}),
      reply: await mod.hostNoticeKind({text: "model reply"}, {kind: "final"}),
    };
  } catch (error) {
    result.notice = {error: String(error?.message ?? error).split("\n")[0]};
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
