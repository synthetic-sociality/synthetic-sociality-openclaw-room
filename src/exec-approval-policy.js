// ISSUE-163: nobody can answer a private approval in a Room, so a command that
// needs one is refused before the host opens the request. The model gets an
// ordinary tool error in its own turn and its reply stays bound to that turn.
//
// Why here and not a deny of the open request (rejected in review of 1799f749): on
// OpenClaw 2026.7.1-2 every closed request starts a host follow-up run that leaves
// through message.send.text, and the host's fixed sentence follows when that run is
// slow or fails (bash-tools-DHyGpWCr.js:1330, 391-466). With no request there is no
// follow-up to contain.
//
// roomExecNeedsApproval follows the host's own decision, createExecTool and
// processGatewayAllowlist (bash-tools-DHyGpWCr.js:3270-3295, 980-1061), using the
// SDK's evaluators. The SDK lacks two of the host's answers, so they are read from
// the host's own evaluation: whether a satisfied allowlist can be enforced, and
// whether a segment evals inline. Where the SDK cannot answer it says yes, so it
// refuses rather than guesses. README "Private approvals in a Room" lists what that
// costs. test/support/host-exec-differential.mjs holds the decision against the
// host's real exec tool, so a host that decides differently fails the suite.
import {delimiter, resolve} from "node:path";
import {agentWorkspace} from "./secret-isolation.js";
import {openClawStateDirectory} from "./state.js";

const ID = "synthetic-sociality-room";
const MAX_SPAWN_LINEAGE = 16;
const SHELL_TOOLS = new Set(["exec", "bash"]);
export const ROOM_EXEC_REFUSAL = "Refused in this Room session: the host's exec policy does not allow this command here. It did not run.";

// The same rule as Hermes (adapter.py _PRIVATE_APPROVAL): approval text never
// reaches a Room.
const PRIVATE_APPROVAL = /(?:approval\s+(?:is\s+)?required|reply\s+[`"']?\/?approve|\/approve\b|dangerous\s+command)/i;
// The translation for this host: its own sentences and result line about an
// approval (sanitize-user-facing-text-D-sR-1VY.js:86-95, bash-tools-DHyGpWCr.js:950).
const HOST_APPROVAL_SENTENCE = /^Command did not run(?:: approval (?:timed out|was denied|is required|request failed))?\.$/;
const HOST_APPROVAL_RESULT = /\bExec denied \((?:gateway|node)\b/;

export function isPrivateApprovalText(text) {
  const value = String(text ?? "").trim();
  return PRIVATE_APPROVAL.test(value) || HOST_APPROVAL_SENTENCE.test(value) || HOST_APPROVAL_RESULT.test(value);
}

const execLayer = (host, base, layer) => {
  if (!layer) return base;
  if (layer.mode) {
    const {mode, security, ask} = host.resolveExecModePolicy({mode: layer.mode});
    return {mode, security, ask};
  }
  return {mode: layer.security !== undefined || layer.ask !== undefined ? undefined : base.mode,
    security: layer.security ?? base.security, ask: layer.ask ?? base.ask};
};

function agentExec(cfg, agentId) {
  const id = String(agentId ?? "").trim().toLowerCase();
  const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  return list.find((agent) => String(agent?.id ?? "").trim().toLowerCase() === id)?.tools?.exec;
}

// Effective policy before any command is looked at.
async function execPolicy({cfg, agentId, sessionKey, params, roomSession}) {
  const host = await import("openclaw/plugin-sdk/infra-runtime");
  const {resolveExecApprovalsFromFile, loadExecApprovals} = await import("openclaw/plugin-sdk/exec-approvals-runtime");
  const globalExec = cfg?.tools?.exec;
  const localExec = agentExec(cfg, agentId);
  // An operator's /exec override on this session outranks the configuration
  // (get-reply-OTG64ybi.js:945-948).
  const {loadSessionStore, resolveStorePath} = await import("openclaw/plugin-sdk/session-store-runtime");
  const session = loadSessionStore(resolveStorePath(cfg?.session?.store, {agentId}))?.[sessionKey];
  const layered = execLayer(host, execLayer(host, execLayer(host, {}, globalExec), localExec), {security: session?.execSecurity, ask: session?.execAsk});
  const configuredTarget = session?.execHost ?? localExec?.host ?? globalExec?.host ?? "auto";
  const selected = params?.host ?? configuredTarget;
  let target = selected;
  if (params?.elevated === true) target = selected === "node" ? "node" : "gateway";
  else if (selected === "auto") {
    const {resolveSandboxRuntimeStatus} = await import("openclaw/plugin-sdk/sandbox");
    target = resolveSandboxRuntimeStatus({cfg, sessionKey}).sandboxed ? "sandbox" : "gateway";
  }
  const modePolicy = host.resolveExecModePolicy({mode: layered.mode, security: layered.security ?? "full", ask: layered.ask ?? "off"});
  const file = resolveExecApprovalsFromFile({file: loadExecApprovals(), agentId, overrides: {security: "full", ask: "off"}}).agent;
  const security = host.minSecurity(modePolicy.security, file.security);
  const fileAsk = host.maxAsk(modePolicy.ask, file.ask);
  // A Room turn names its provider, so the host ignores the model's own ask under
  // ask=off (bash-tools-DHyGpWCr.js:3292). A subagent's provider is not visible here.
  const ask = roomSession && fileAsk === "off" ? "off" : host.maxAsk(fileAsk, host.normalizeExecAsk(params?.ask) ?? fileAsk);
  return {
    host, target, security, ask,
    fallback: host.minSecurity(security, file.askFallback),
    strictInlineEval: (localExec?.strictInlineEval ?? globalExec?.strictInlineEval) === true,
    safeBins: localExec?.safeBins ?? globalExec?.safeBins,
    pathPrepend: localExec?.pathPrepend ?? globalExec?.pathPrepend,
  };
}

// The host asks when it cannot build an enforced command from a satisfied allowlist
// (bash-tools-DHyGpWCr.js:1018-1033, 1048). Its builder is not in the SDK, so these
// are the builder's refusals (exec-authorization-render-cF5Yzo-G.js:96-128, 175-200,
// hasUnquotedShellExpansionSource :13-52), asked of the plan the host's evaluator
// returned. Quoted text cannot expand; a shell wrapper's payload cannot be rewritten.
const QUOTED_OR_ESCAPED = /\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g;
const UNQUOTED_EXPANSION = /(?:^|\s)~|[{*?[]/;
function enforceablePlan(host, {authorizationPlan: plan, segmentSatisfiedBy}) {
  if (!plan?.ok || plan.dialect !== "posix-shell") return false;
  const candidates = plan.groups.flatMap((group) => group.candidates);
  if ((segmentSatisfiedBy ?? []).length !== candidates.length) return false;
  return candidates.every(({sourceSegment, sourceStep, transport}) => {
    if (transport?.kind === "shell-wrapper" || !host.resolvePlannedSegmentArgv(sourceSegment)?.[0]) return false;
    const args = sourceStep.text.slice(Math.max(0, sourceStep.executableSpan.endIndex - sourceStep.span.startIndex));
    return !UNQUOTED_EXPANSION.test(args.replace(QUOTED_OR_ESCAPED, ""));
  });
}

// tools.exec.strictInlineEval: the host's detector (risks-CnLHDNUX.js:572) is not in
// the SDK. A segment that names one of its inline-eval programs is taken as a hit, also
// without its flag, also behind a wrapper such as env or timeout.
const INLINE_EVAL_PROGRAMS = new Set(["awk", "bun", "deno", "find", "gawk", "gmake", "gsed", "lua", "make", "mawk", "nawk", "node", "nodejs",
  "osascript", "perl", "php", "pypy", "python", "r", "rscript", "ruby", "sed", "xargs"]);
function namesInlineEvalProgram(segment) {
  return [...(segment?.resolution?.effectiveArgv ?? []), ...(segment?.argv ?? [])].some((token) => {
    const name = String(token).split("/").pop().toLowerCase().replace(/-?\d+(?:\.\d+)*$/, "");
    return INLINE_EVAL_PROGRAMS.has(name);
  });
}

export async function roomExecNeedsApproval({cfg, agentId, sessionKey, params, cwd, policy}) {
  const {host, target, security, ask, strictInlineEval, safeBins, pathPrepend} = policy;
  if (target === "sandbox" || security === "deny") return false;
  if (security === "full" && ask === "off" && !strictInlineEval) return false;
  if (target !== "gateway" || ask === "always") return true;
  const approvals = host.resolveExecApprovals(agentId, {security, ask});
  const hostSecurity = host.minSecurity(security, approvals.agent.security);
  const hostAsk = host.maxAsk(ask, approvals.agent.ask);
  if (hostSecurity === "deny") return false;
  if (hostAsk === "always") return true;
  const command = String(params?.command ?? "");
  const workdir = params?.workdir ? resolve(cwd, String(params.workdir)) : cwd;
  const env = {...process.env, ...params?.env};
  // As the host does for the gateway. Its login-shell PATH is not in the SDK.
  const prepended = (Array.isArray(pathPrepend) ? pathPrepend : []).map((entry) => String(entry).trim()).filter(Boolean);
  if (prepended.length) env.PATH = [...prepended, env.PATH].filter(Boolean).join(delimiter);
  const evaluation = await host.evaluateShellAllowlistWithAuthorization({
    command, allowlist: approvals.allowlist, safeBins: host.resolveSafeBins(safeBins), cwd: workdir, env, platform: process.platform,
  });
  if (strictInlineEval && evaluation.segments.some(namesInlineEvalProgram)) return true;
  const {analysisOk} = evaluation;
  const allowlistSatisfied = hostSecurity === "allowlist" && analysisOk ? evaluation.allowlistSatisfied : false;
  const durableApprovalSatisfied = host.hasDurableExecApproval({
    analysisOk, segmentAllowlistEntries: evaluation.segmentAllowlistEntries, allowlist: approvals.allowlist, commandText: command,
  });
  // An allowlist miss: the host asks, or under ask=off denies; here it does not run
  // either way. Refusing both also covers a miss on this PATH that the host's
  // login-shell PATH resolves, allowlists and then cannot enforce.
  return Boolean((hostSecurity === "allowlist" && !allowlistSatisfied && !durableApprovalSatisfied)
    || (allowlistSatisfied && evaluation.segments.some((segment) => segment.argv.some((token) => token.startsWith("<<"))))
    || (allowlistSatisfied && !host.hasExactCommandDurableExecApproval({allowlist: approvals.allowlist, commandText: command})
      && !(process.platform === "win32"
        ? host.buildEnforcedShellCommand({command, segments: evaluation.segments, platform: process.platform}).ok === true
        : enforceablePlan(host, evaluation)))
    || (!(hostSecurity === "full" && hostAsk === "off")
      && host.commandRequiresSecurityAuditSuppressionApproval({command, cwd: workdir, env, segments: evaluation.segments})));
}

// A Room session, or a subagent whose spawn lineage reaches one. The host writes
// spawnedBy before it launches the child and it survives a restart; the
// subagent_spawned hook arrives only after the launch.
async function roomLineage(sessionKey, cfg) {
  let key = String(sessionKey ?? "").trim();
  if (key.split(":")[2] === ID) return {roomSession: true};
  if (key.split(":")[2] !== "subagent") return null;
  const {loadSessionStore, resolveStorePath} = await import("openclaw/plugin-sdk/session-store-runtime");
  for (let depth = 0; depth < MAX_SPAWN_LINEAGE; depth += 1) {
    const agentId = key.split(":")[1];
    key = String(loadSessionStore(resolveStorePath(cfg?.session?.store, {agentId}))?.[key]?.spawnedBy ?? "").trim();
    if (key.split(":")[2] === ID) return {roomSession: false};
    if (key.split(":")[2] !== "subagent") return null;
  }
  return null;
}

// A person can answer only at a target the owner configured away from the Room.
// Native approver DMs do not take a Room's request
// (exec-approval-session-target-BlrHLy0b.js:64), and a connected operator client is
// no configured target.
async function privateApprovalTarget(cfg, agentId, sessionKey) {
  const forward = cfg?.approvals?.exec;
  if (!forward?.enabled || !["targets", "both"].includes(forward.mode)) return false;
  const targets = Array.isArray(forward.targets) ? forward.targets : [];
  if (!targets.some((target) => String(target?.channel ?? "").trim().toLowerCase() !== ID && String(target?.to ?? "").trim())) return false;
  const {matchesApprovalRequestFilters} = await import("openclaw/plugin-sdk/approval-runtime");
  return matchesApprovalRequestFilters({
    request: {agentId, sessionKey}, agentFilter: forward.agentFilter, sessionFilter: forward.sessionFilter, fallbackAgentIdFromSessionKey: true,
  });
}

// At most one request per run: each closed request starts a follow-up that can reach
// the Room, so a stuck model must not open them by the hundred.
const MAX_REMEMBERED_RUNS = 512;
const runsWithOpenRequest = new Set();
function firstRequestOfRun(runId) {
  if (!runId) return true;
  if (runsWithOpenRequest.has(runId)) return false;
  runsWithOpenRequest.add(runId);
  if (runsWithOpenRequest.size > MAX_REMEMBERED_RUNS) runsWithOpenRequest.delete(runsWithOpenRequest.values().next().value);
  return true;
}

export function roomExecApprovalPolicy(api) {
  const refuse = () => {
    api?.logger?.warn?.("Room connector refused an exec call that needs private approval");
    return {block: true, blockReason: ROOM_EXEC_REFUSAL};
  };
  const decide = async (event, ctx) => {
    const cfg = api?.runtime?.config?.current?.() ?? api?.config;
    const sessionKey = String(ctx?.sessionKey ?? "");
    let lineage;
    try {
      lineage = await roomLineage(sessionKey, cfg);
    } catch {
      // An unreadable store says nothing about this subagent; a Room key never gets here.
      return undefined;
    }
    if (!lineage) return undefined;
    try {
      const agentId = ctx?.agentId ?? sessionKey.split(":")[1];
      const cwd = ctx?.workspaceDir || ctx?.cwd || agentWorkspace(cfg, agentId, {stateDir: openClawStateDirectory()});
      const request = {cfg, agentId, sessionKey, params: event?.params, cwd};
      const policy = await execPolicy({...request, roomSession: lineage.roomSession});
      if (!await roomExecNeedsApproval({...request, policy})) return undefined;
      // askFallback=full would run it at expiry if nobody answered: never without approval.
      if (policy.fallback !== "full" && await privateApprovalTarget(cfg, agentId, sessionKey) && firstRequestOfRun(ctx?.runId)) return undefined;
    } catch {
      api?.logger?.warn?.("Room connector could not read the exec policy");
    }
    return refuse();
  };
  return (event, ctx) => (SHELL_TOOLS.has(event?.toolName) ? decide(event, ctx) : undefined);
}
