// The plugin must load in the real host (0.2.55 incident: 0.2.54 was refused
// with "await is only valid in async functions and the top level bodies of
// modules"). The host loads plugins synchronously: native require first, then a
// jiti CommonJS transform; both reject top-level await.
import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {readdirSync, readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PINNED_HOST = packageJson.peerDependencies.openclaw;

function installedHost() {
  const candidates = [process.env.OPENCLAW_HOST_ROOT];
  try { candidates.push(dirname(createRequire(join(root, "package.json")).resolve("openclaw/package.json"))); } catch {}
  candidates.push("/usr/local/lib/node_modules/openclaw");
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version === PINNED_HOST) return candidate;
    } catch {}
  }
  return null;
}

async function loadThroughHost(hostRoot, entry, channel) {
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-plugin-load.mjs"), hostRoot, entry, ...(channel ? [channel] : [])], {
    // No transform cache on disk; the transform itself is unchanged.
    env: {...process.env, JITI_FS_CACHE: "false"},
    timeout: 120_000,
    maxBuffer: 1 << 20,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("the plugin entry loads through the installed host's plugin loader", async (t) => {
  const hostRoot = installedHost();
  if (!hostRoot) return t.skip(`OpenClaw ${PINNED_HOST} is not installed`);
  const result = await loadThroughHost(hostRoot, join(root, "src/index.js"), join(root, "src/channel.js"));
  assert.deepEqual(result.entry, {ok: true, id: "synthetic-sociality-room", exports: result.entry.exports}, JSON.stringify(result));
  // The lazily loaded host helper resolves to the host's own module instance.
  assert.deepEqual(result.notice, {toolWarning: "tool_error_warning", fallback: "fallback_notice", reply: ""}, JSON.stringify(result));
});

// V8 decides: with its import/export syntax removed, a module body compiled as
// an ordinary (non-async) function rejects any top-level await, as the host's
// CommonJS transform does. Dynamic import() inside functions stays valid.
function topLevelAwaitError(source) {
  const body = source
    .replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']+["'];?/gm, "")
    .replace(/^import\s*["'][^"']+["'];?/gm, "")
    .replace(/^export\s*\{[\s\S]*?\}(\s*from\s*["'][^"']+["'])?;?/gm, "")
    .replace(/^export\s+default\s+/gm, "void ")
    .replace(/^export\s+(?=(async\s+)?function|class|const|let|var)/gm, "")
    .replace(/\bimport\.meta\b/g, "({url: ''})");
  try {
    new vm.Script(`(function () {\n${body}\n})`);
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}

test("no top-level await anywhere in src", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(c|m)?js$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(root, "src"));
  assert.ok(files.length > 10);
  const failures = files.map((file) => [file, topLevelAwaitError(readFileSync(file, "utf8"))]).filter(([, error]) => error);
  assert.deepEqual(failures, []);
  // The guard itself rejects the 0.2.54 shape: an await inside a top-level block.
  assert.match(topLevelAwaitError("let helper = {};\ntry {\n  helper = await import(\"x\");\n} catch {}\n"), /await is only valid/);
  assert.equal(topLevelAwaitError("let task = null;\nexport function load() { task ??= import(\"x\"); return task; }\n"), "");
});
