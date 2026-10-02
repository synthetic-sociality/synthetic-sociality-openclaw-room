// Contract P2c-1 proof against the installed host: loads the plugin through the
// host's plugin loader, registers it in "full" mode, installs its hooks in the
// host's global hook runner, and runs the host's own read and bash tools,
// wrapped by the host's before_tool_call wrapper, against the Room store.
// Run in a child process (the host installs process-wide hooks).
// Usage: node host-tool-call.mjs HOST_ROOT ENTRY STATE_DIR STATE_FILE OTHER_FILE CONFIG_JSON
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [hostRoot, entry, stateDir, stateFile, otherFile, configJson] = process.argv.slice(2);
process.env.OPENCLAW_STATE_DIR = stateDir;
const config = JSON.parse(configJson);
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
const hooks = await hostModule("function initializeGlobalHookRunner(registry) {");
const wrapper = await hostModule("function wrapToolWithBeforeToolCallHook(tool, ctx, options = {}) {");
const tools = await hostModule("function createReadTool(cwd, options) {");
const importerUrl = pathToFileURL(loader.file).href;
const testing = loader.pick("testing");
const moduleLoaders = cache.pick("createPluginModuleLoaderCache")();

function loadPluginModule(modulePath) {
  cache.pick("installOpenClawPluginSdkNativeResolver")({argv1: process.argv[1], moduleUrl: importerUrl, pluginModulePath: modulePath});
  const load = cache.pick("getCachedPluginModuleLoader")({
    cache: moduleLoaders, modulePath, importerUrl, loaderFilename: modulePath,
    aliasMap: testing.buildPluginLoaderAliasMap(modulePath, process.argv[1], importerUrl),
  });
  return load(cache.pick("toSafeImportPath")(modulePath));
}

const typedHooks = [];
const quiet = {info() {}, warn() {}, error() {}, debug() {}};
const api = new Proxy({
  id: "synthetic-sociality-room",
  registrationMode: "full",
  config,
  runtime: {config: {current: () => config}},
  logger: quiet,
  on(hookName, handler, options = {}) {
    typedHooks.push({pluginId: "synthetic-sociality-room", hookName, handler, priority: options.priority ?? 0, source: "test"});
  },
}, {get: (target, property) => (property in target ? target[property] : () => undefined)});

const result = {};
// Control run (ROOM_P2C_CONTROL=1): the same host without the plugin's hooks.
if (process.env.ROOM_P2C_CONTROL !== "1") {
  const plugin = loadPluginModule(entry);
  (plugin?.default ?? plugin).register(api);
}
result.hooks = typedHooks.map((hook) => hook.hookName).sort();
hooks.pick("initializeGlobalHookRunner")({typedHooks, hooks: [], plugins: [], tools: [], channels: [], commands: [], services: []});

const context = {agentId: "main", sessionKey: "agent:main:telegram:direct:owner", sessionId: "session-1", runId: "run-1", config};
const wrap = (tool) => wrapper.pick("wrapToolWithBeforeToolCallHook")(tool, context);
const read = wrap(tools.pick("createReadTool")(stateDir));
const bash = wrap(tools.pick("createBashTool")(stateDir));

async function attempt(label, tool, params) {
  try {
    const output = await tool.execute(`call-${label}`, params, undefined, undefined);
    const text = (output?.content ?? []).map((part) => part?.text ?? "").join("\n");
    result[label] = {executed: true, text};
  } catch (error) {
    result[label] = {executed: false, error: String(error?.message ?? error).split("\n")[0]};
  }
}

await attempt("readStore", read, {path: stateFile});
await attempt("readOther", read, {path: otherFile});
await attempt("bashStore", bash, {command: `cat ${stateFile}`});
console.log(JSON.stringify(result));
