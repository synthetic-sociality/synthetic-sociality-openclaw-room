// ISSUE-163: the connector's hook against the host's real exec tool, on one
// configuration and one command at a time, in one process. The tool really runs the
// command in a scratch directory; "ASK" means it reached exec.approval.request, which
// fails fast here because the gateway URL points at a closed port.
// Usage: node host-exec-differential.mjs HOST_ROOT PLUGIN_ROOT. Prints one JSON line:
// rows of {config, command, hook, host, expected}. Run in a child process: the host
// installs process-wide state.
import {execFileSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [hostRoot, pluginRoot] = process.argv.slice(2);
const scratch = mkdtempSync(join(tmpdir(), "room-163-differential-"));
const home = join(scratch, "home");
const state = join(home, ".openclaw");
const work = join(scratch, "work");
const bin = join(scratch, "bin");
for (const dir of [home, state, work, join(work, "sub"), bin]) mkdirSync(dir, {recursive: true});
writeFileSync(join(work, "note.txt"), "hello\nworld\n");
writeFileSync(join(work, "script.py"), "print(1)\n");
writeFileSync(join(bin, "mytool"), "#!/bin/sh\necho mytool\n");
chmodSync(join(bin, "mytool"), 0o755);
Object.assign(process.env, {
  HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"), SHELL: "/bin/sh",
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9", OPENCLAW_GATEWAY_TOKEN: "test-only-not-a-token",
});
// One PATH for the hook and the host: the host merges its login-shell PATH, which the
// SDK does not give the hook (a limit, README). Here they are made the same.
process.env.PATH = execFileSync("/bin/sh", ["-l", "-c", "printf %s \"$PATH\""], {env: {HOME: home, PATH: "/usr/bin:/bin"}, encoding: "utf8"});
writeFileSync(join(state, "openclaw.json"), "{}");

const dist = join(hostRoot, "dist");
const marker = "function createExecTool(defaults) {";
const hits = readdirSync(dist).filter((name) => name.endsWith(".js") && readFileSync(join(dist, name), "utf8").includes(marker));
if (hits.length !== 1) throw new Error(`expected one host module with createExecTool, found ${hits.length}`);
const aliases = Object.fromEntries([...readFileSync(join(dist, hits[0]), "utf8").trimEnd().split("\n").at(-1).matchAll(/(\w+) as (\w+)/g)].map(([, name, alias]) => [name, alias]));
const createExecTool = (await import(pathToFileURL(join(dist, hits[0])).href))[aliases.createExecTool];
const {roomExecApprovalPolicy} = await import(pathToFileURL(join(pluginRoot, "src/exec-approval-policy.js")).href);

const ROOM = "agent:main:synthetic-sociality-room:group:room-1:epoch:e1";
const ALLOW = ["**/ls", "**/git", "**/cat", "**/grep", "**/echo", "**/pwd", "**/date", "**/sed", "**/find", "**/env", "**/python3", "**/node", "**/sh", "**/bash", "**/touch"].map((pattern) => ({pattern}));
const COMMANDS = [
  "ls", "ls -la", "pwd", "echo hello", "date", "cat note.txt", "head -1 note.txt", "wc -l note.txt", "ls | wc -l", "cat note.txt | head -2", "echo hi | tr a b", "echo hi | cut -c1",
  "grep hello note.txt", "git status", "git log --oneline | head -5", "git status 2>&1", "cd sub && ls", "ls; pwd", "ls > out.txt", "echo hi && echo there", "ls || true", "(ls)",
  "FOO=1 ls", "env ls", "env FOO=1 git status", "nice ls", "timeout 5 ls", "command ls", "exec ls", "/bin/ls", "./script.py", "true", "cd sub", "export A=1",
  // The shell wrappers and expansions the host cannot enforce.
  "bash -c 'git status'", "sh -c 'git status'", "/bin/sh -c ls", "bash -lc 'git status'", "zsh -c ls", "ls *", "ls note.???", "ls ~", "echo {a,b}", "ls $(pwd)", "ls \"$HOME\"",
  "for f in *; do echo $f; done",
  // A real heredoc is an allowlist miss; a satisfied segment with such a token still asks.
  "cat <<EOF\nhi\nEOF", "cat '<<EOF'",
  // Quoted, so nothing expands.
  "grep 'a*' note.txt", "echo \"{a}\"", "echo '~'", "echo a~b", "echo \\*",
  // Inline eval, also behind a wrapper.
  "node -e 1", "python3 -c 'print(1)'", "env python3 -c 1", "timeout 5 node -e 1", "sh -c 'node -e 1'", "sed -n 1p note.txt", "find . -name note.txt", "awk '{print $1}' note.txt",
  // Named an interpreter, no inline eval: a limit under strictInlineEval.
  "python3 script.py",
  // The host's security audit rule.
  "echo security.audit.suppressions", "openclaw config get security.audit.suppressions",
];
const CONFIGS = {
  default: {exec: {}},
  strict: {exec: {strictInlineEval: true}},
  allowlist_off: {exec: {security: "allowlist", ask: "off"}, allow: ALLOW},
  allowlist_off_strict: {exec: {security: "allowlist", ask: "off", strictInlineEval: true}, allow: ALLOW},
  on_miss: {exec: {security: "allowlist", ask: "on-miss"}, allow: ALLOW},
  on_miss_empty: {exec: {security: "allowlist", ask: "on-miss"}},
  on_miss_strict: {exec: {security: "allowlist", ask: "on-miss", strictInlineEval: true}, allow: ALLOW},
  mode_ask: {exec: {mode: "ask"}, allow: ALLOW},
  // A reviewer that never allows: what it would allow is a limit, pinned below.
  mode_auto: {exec: {mode: "auto"}, allow: ALLOW},
  full_on_miss: {exec: {security: "full", ask: "on-miss"}},
  always: {exec: {security: "full", ask: "always"}, commands: ["ls", "bash -c 'git status'"]},
  file_on_miss: {exec: {}, file: {security: "allowlist", ask: "on-miss"}, allow: ALLOW},
  file_always: {exec: {}, file: {ask: "always"}, commands: ["ls"]},
  path_prepend: {exec: {security: "allowlist", ask: "on-miss", pathPrepend: [bin]}, allow: [{pattern: "**/mytool"}], commands: ["mytool"]},
  safebin_profile: {exec: {security: "allowlist", ask: "on-miss", safeBins: ["mytool"], safeBinProfiles: {mytool: {}}, safeBinTrustedDirs: [bin], pathPrepend: [bin]}, commands: ["mytool"]},
  // The node decides remotely: the hook alone, no node runs here.
  host_node_default: {exec: {host: "node"}, commands: ["ls"], noHost: true},
  host_node_on_miss: {exec: {host: "node", security: "allowlist", ask: "on-miss"}, allow: ALLOW, commands: ["ls"], noHost: true},
};
// Where the hook is known to refuse although the host would run it (README). Under
// strictInlineEval: programs it names, without the flag the host looks for.
const NAMED_NOT_INLINE = new Set(["python3 script.py", "find . -name note.txt"]);
const KNOWN_REFUSALS = {
  strict: NAMED_NOT_INLINE,
  allowlist_off_strict: NAMED_NOT_INLINE,
  on_miss_strict: NAMED_NOT_INLINE,
  safebin_profile: new Set(["mytool"]),
  host_node_on_miss: new Set(["ls"]),
};

async function hostDecision(cfg, command) {
  const e = cfg.tools.exec;
  const tool = createExecTool({
    host: e.host, mode: e.mode, security: e.security, ask: e.ask, safeBins: e.safeBins, safeBinProfiles: e.safeBinProfiles, safeBinTrustedDirs: e.safeBinTrustedDirs,
    strictInlineEval: e.strictInlineEval, pathPrepend: e.pathPrepend, agentId: "main", cwd: work, sessionKey: ROOM, messageProvider: "synthetic-sociality-room",
    currentChannelId: "room-1", config: cfg, allowBackground: false, autoReviewer: async () => ({decision: "deny", risk: "high", rationale: "test"}),
  });
  try {
    const result = await tool.execute("t1", {timeout: 5, command});
    return result?.details?.status === "approval-pending" ? "ASK" : "RUN";
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/Exec approval registration failed/.test(message)) return "ASK";
    return /allowlist miss|exec denied/i.test(message) ? "DENY" : "ERROR";
  }
}

const rows = [];
process.chdir(work);
for (const [config, c] of Object.entries(CONFIGS)) {
  writeFileSync(join(state, "exec-approvals.json"), JSON.stringify({version: 1, defaults: c.file ?? {}, agents: c.allow ? {main: {allowlist: c.allow}} : {}}));
  const cfg = {tools: {exec: c.exec}, agents: {defaults: {workspace: work}}};
  const hook = roomExecApprovalPolicy({runtime: {config: {current: () => cfg}}, logger: {warn() {}}});
  for (const command of c.commands ?? COMMANDS) {
    const out = await hook({toolName: "exec", params: {command}}, {sessionKey: ROOM, agentId: "main", runId: `run-${rows.length}`, workspaceDir: work});
    const decided = out?.block ? "REFUSE" : "pass";
    const host = c.noHost ? "not run" : await hostDecision(cfg, command);
    const known = KNOWN_REFUSALS[config]?.has(command);
    // The host's own deny is the same outcome as a refusal: it does not run, no request.
    const expected = known || host === "ASK" || host === "DENY" ? "REFUSE" : c.noHost ? decided : "pass";
    rows.push({config, command, hook: decided, host, expected});
  }
}
process.chdir("/");
rmSync(scratch, {recursive: true, force: true, maxRetries: 2});
process.stdout.write(`${JSON.stringify(rows)}\n`, () => process.exit(0));
