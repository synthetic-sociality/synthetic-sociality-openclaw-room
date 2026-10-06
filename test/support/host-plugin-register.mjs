// Registers the plugin exactly as the installed OpenClaw host's gateway does:
// the host's own loadOpenClawPlugins with the plugin's real manifest
// (openclaw.plugin.json) from a load path, full registration. Reports the
// tools the host registered for the plugin and the host's diagnostics as JSON.
// Run in a child process with a scratch HOME (the host installs process-wide
// hooks; the plugin writes its status file). Usage:
// node host-plugin-register.mjs HOST_ROOT PLUGIN_ROOT
import {mkdtempSync, readdirSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [hostRoot, pluginRoot] = process.argv.slice(2);
const dist = join(hostRoot, "dist");
const ID = "synthetic-sociality-room";

function findModule(marker) {
  const hits = readdirSync(dist).filter((name) => name.endsWith(".js") && readFileSync(join(dist, name), "utf8").includes(marker));
  if (hits.length !== 1) throw new Error(`expected one host module containing ${JSON.stringify(marker)}, found ${hits.length}`);
  return join(dist, hits[0]);
}
function exportAliases(file) {
  const last = readFileSync(file, "utf8").trimEnd().split("\n").at(-1);
  return Object.fromEntries([...last.matchAll(/(\w+) as (\w+)/g)].map(([, name, alias]) => [name, alias]));
}

const result = {};
try {
  const file = findModule("function loadOpenClawPlugins(options = {}) {");
  const mod = await import(pathToFileURL(file).href);
  const loadOpenClawPlugins = mod[exportAliases(file).loadOpenClawPlugins];
  const lines = [];
  const logger = {info: () => {}, debug: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line))};
  const registry = loadOpenClawPlugins({
    config: {plugins: {enabled: true, load: {paths: [pluginRoot]}, entries: {[ID]: {enabled: true}}}},
    workspaceDir: mkdtempSync(join(tmpdir(), "room-host-register-")),
    onlyPluginIds: [ID],
    cache: false,
    // As the gateway: an activating load (registration mode "full") with the
    // channel plugin's full runtime, not its setup entry.
    activate: true,
    forceFullRuntimeForChannelPlugins: true,
    logger,
  });
  const record = registry.plugins.find((plugin) => plugin.id === ID);
  result.plugin = record ? {status: record.status ?? null, failed: record.failedAt != null, error: record.error ? String(record.error).split("\n")[0] : null,
    toolNames: [...(record.toolNames ?? [])].sort(), channels: [...(record.channelIds ?? record.channels ?? [])]} : null;
  result.tools = registry.tools.filter((tool) => tool.pluginId === ID).map((tool) => [...(tool.names ?? [])].sort());
  result.diagnostics = registry.diagnostics.filter((item) => !item.pluginId || item.pluginId === ID)
    .map((item) => ({level: item.level, message: String(item.message).split("\n")[0]}));
  result.loggerLines = lines.map((line) => line.split("\n")[0]);
} catch (error) {
  result.error = String(error?.message ?? error).split("\n")[0];
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
