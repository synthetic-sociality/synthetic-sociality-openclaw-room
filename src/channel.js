import {defineChannelPluginEntry} from "openclaw/plugin-sdk/channel-core";
import {defineChannelMessageAdapter} from "openclaw/plugin-sdk/channel-message";
import {buildChannelInboundEventContext} from "openclaw/plugin-sdk/channel-inbound";
import {basename, dirname, join, resolve} from "node:path";
import {loadState, openClawStateDirectory} from "./state.js";
import {registerRoomCommands} from "./commands.js";
import {markChannelActive, markChannelInactive, registerPresenceFallback} from "./presence-fallback.js";
import {registerRoomHistoryTool} from "./history.js";
import {registerRoomDocumentTool} from "./document-tool.js";
import {noteHostSession} from "./documents.js";
import {claimRuntimeOwnership} from "./account.js";
import {resolveRoomAccount as resolveAccount, resolvedRoomAccounts} from "./account-discovery.js";
import {looksLikeRoomId, normalizeRoomTarget, resolveConfiguredRoomTarget} from "./target.js";
import {outboundIdempotencyKey} from "./outbound.js";
import {roomErrorDiagnostic} from "./room-client.js";
import {
  DEFAULT_EXECUTION_FAILURE,
  HOST_LABEL,
  OPERATIONAL_FALLBACK_EXECUTION_FAILURE,
  RELEASED_ATTEMPT_EXECUTION_FAILURE,
  statusErrorCode,
} from "./runtime.js";
import {BLOCK_MESSAGE, REFUSAL_CODE, agentWorkspace, scrubDeep, scrubbingLogger, secretIsolationEnforced, storeReachability, toolCallBlock} from "./secret-isolation.js";
import {WEB_READ_TOOL_NAMES, localStatusFor} from "./local-status.js";
import {ROOM_CONNECTOR_PROVENANCE} from "./release-provenance.js";
import {
  roomReplyDeliveryPolicy,
} from "./reply-policy.js";

const ID = "synthetic-sociality-room";
const GENERIC_OPENCLAW_OPERATIONAL_FALLBACK = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
const COMPACTION_OPENCLAW_OPERATIONAL_FALLBACK = "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.";
const OPENCLAW_OPERATIONAL_FALLBACKS = new Set([
  GENERIC_OPENCLAW_OPERATIONAL_FALLBACK,
  COMPACTION_OPENCLAW_OPERATIONAL_FALLBACK,
]);

export function isOpenClawOperationalFallback(payload) {
  return payload?.isError === true && OPENCLAW_OPERATIONAL_FALLBACKS.has(payload.text);
}

// The host's own reply-payload helpers (plugin-sdk/reply-payload), loaded once
// on first use. Absent only when the exact host peer is not installed, as in
// unit tests. Never a top-level await: the host loads plugins synchronously
// (native require, then a jiti CommonJS transform), and both reject it (0.2.55).
let hostReplyPayloadTask = null;
function hostReplyPayload() {
  hostReplyPayloadTask ??= import("openclaw/plugin-sdk/reply-payload").catch(() => ({}));
  return hostReplyPayloadTask;
}

// Delivery contract P1a-6: payloads the host generates itself are never a Room
// contribution. Markers as defined by OpenClaw 2026.7.1-2 (dist):
// - isFallbackNotice: model fallback and fallback-cleared notices
//   (agent-runner.runtime-DtdxZiBX.js:7643-7646, 7662-7669);
// - isCompactionNotice: compaction notices (agent-runner.runtime-DtdxZiBX.js:713-734);
// - isStatusNotice: plan and command status notices (dispatch-DnzGTpPs.js:1851-1854,
//   commands-handlers.runtime-CunY89Nu.js:1425-1428, 1513-1516);
//   the host groups these three as isReplyPayloadStatusNotice (reply-payload-BK_jICQ3.js:108-110);
// - channelData.openclawProgressKind "fast-mode-auto": progress notices
//   (reply-payload-BK_jICQ3.js:21-24; agent-runner.runtime-DtdxZiBX.js:541);
// - nonTerminalToolErrorWarning metadata: the host's tool-error warning beside a
//   reply (payloads-1r4oLFNi.js:467-482), read through the SDK helper;
// - delivery kind "tool": tool-result and plan-status deliveries (dispatch-DnzGTpPs.js:1843-1860).
export async function hostNoticeKind(payload, info) {
  if (payload?.isFallbackNotice === true) return "fallback_notice";
  if (payload?.isCompactionNotice === true) return "compaction_notice";
  if (payload?.isStatusNotice === true) return "status_notice";
  if (payload?.channelData?.openclawProgressKind === "fast-mode-auto") return "progress_notice";
  if ((await hostReplyPayload()).isReplyPayloadNonTerminalToolErrorWarning?.(payload) === true) return "tool_error_warning";
  if (info?.kind === "tool") return "tool_result";
  return "";
}

// Contract P2c-1: the Room store is the plugin's state root plus the directory
// of every configured account's state file.
function roomStoreRoot() {
  return join(openClawStateDirectory(), ID);
}

export function roomStoreDirectories(cfg) {
  const directories = [roomStoreRoot()];
  try {
    for (const account of resolvedRoomAccounts(cfg ?? {})) if (account?.stateFile) directories.push(dirname(account.stateFile));
  } catch {
    // An unreadable configuration still fences the default store.
  }
  return [...new Set(directories)];
}

// Contract P2c-4: one status file per installation.
// Contract P3-5: next to the state actually in use: the parent of the first
// configured account's state directory (<...>/synthetic-sociality-room for
// .../accounts/<id>.json), else the plugin root under OPENCLAW_STATE_DIR. On
// Aura the accounts live outside OPENCLAW_STATE_DIR (2026-10-02 ENOENT).
export function roomStatusPath(cfg) {
  try {
    const account = resolvedRoomAccounts(cfg ?? {}).find((item) => item?.stateFile);
    if (account) {
      // An `accounts/` directory's parent; any other layout: the state file's
      // own directory (the same rule as Hermes: next to the state in use).
      const directory = dirname(resolve(account.stateFile));
      return join(basename(directory) === "accounts" ? dirname(directory) : directory, "status.json");
    }
  } catch {
    // An unreadable configuration falls back to the plugin root.
  }
  return join(roomStoreRoot(), "status.json");
}

export function roomLocalStatus(logger, cfg) {
  return localStatusFor(roomStatusPath(cfg), {
    plugin: "openclaw", version: ROOM_CONNECTOR_PROVENANCE.version, hostLabel: HOST_LABEL, logger,
  });
}

let secretRefusalLogged = false;
export function resetSecretRefusalLog() {
  secretRefusalLogged = false;
}

function untilAborted(signal) {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, {once: true});
  });
}

// Contract P2c-1, in every session: a file path inside the Room store (a
// search root containing it), or a shell call naming it, is refused. A fence
// error refuses too. Contract P2c-6: only the gateway's own registration
// (noteWebRead) writes the web-reading status, like every other status write.
export function roomToolCallPolicy(api, {noteWebRead = false} = {}) {
  return (event, ctx) => {
    try {
      const cfg = api?.runtime?.config?.current?.() ?? api?.config;
      // Contract P2c-6: a web reading tool the host offered in a Room turn
      // (the host's session key is agent:<agent>:<channel>:<kind>:<peer>).
      if (noteWebRead && String(ctx?.sessionKey ?? "").split(":")[2] === ID && WEB_READ_TOOL_NAMES.includes(event?.toolName)) {
        try { roomLocalStatus(api?.logger, cfg).noteWebReadTool(event.toolName); } catch {}
      }
      if (noteWebRead && String(ctx?.sessionKey ?? "").split(":")[2] === ID) {
        // Contract P7d-5: the host session of a Room turn.
        noteHostSession(ctx?.sessionKey, ctx?.sessionId);
      }
      const stateDir = openClawStateDirectory();
      // Relative paths resolve where the tool runs: the hook context's
      // workspace or cwd when the host provides one (2026.7.1-2 does not),
      // else the agent's configured workspace.
      const cwd = ctx?.workspaceDir || ctx?.cwd || agentWorkspace(cfg, ctx?.agentId, {stateDir});
      const reason = toolCallBlock(event?.toolName, event?.params, roomStoreDirectories(cfg), {derivedPaths: event?.derivedPaths, cwd, stateDir});
      if (!reason) return undefined;
      api?.logger?.warn?.(`Room connector refused a ${String(event?.toolName ?? "tool")} tool call that reaches its private state`);
      return {block: true, blockReason: reason};
    } catch {
      api?.logger?.warn?.("Room connector refused a tool call: state fence unavailable");
      return {block: true, blockReason: BLOCK_MESSAGE};
    }
  };
}

// Contract P2c-1: no persisted tool result carries a Room credential.
export function roomToolResultScrub(event) {
  const message = event?.message;
  const next = scrubDeep(message);
  return next !== message ? {message: next} : undefined;
}

const receipt = (eventId, sentAt) => ({
  primaryPlatformMessageId: eventId,
  platformMessageIds: [eventId],
  parts: [{platformMessageId: eventId, kind: "text", index: 0}],
  sentAt,
});

export function createRoomChannel({makeClient}) {
  const live = new Map();
  const runtimeOwners = {accounts: new Map(), stateFiles: new Map()};
  const message = defineChannelMessageAdapter({
    receive: {defaultAckPolicy: "manual", supportedAckPolicies: ["manual"]},
    send: {
      text: async (ctx) => {
        const accountId = ctx.accountId ?? "default";
        const entry = live.get(accountId);
        if (!entry) throw new Error(`Room account ${accountId} is not running`);
        const sent = await entry.client.postAndFinish({
          roomId: ctx.to,
          text: ctx.text,
          literal: true,
          replyToId: ctx.replyToId,
          idempotencyKey: outboundIdempotencyKey(ctx.deliveryQueueId),
          resolveRecipientMentions: true,
          signal: ctx.signal,
        });
        // The epoch-path supersede carries no reason; its evidence says historical_epoch.
        if (sent.skipped || sent.superseded || sent.refused) throw new Error(`Room did not accept the post: ${sent.reason || (sent.superseded ? "historical_epoch" : "skipped")}`);
        return {messageId: sent.eventId, receipt: receipt(sent.eventId, sent.sentAt)};
      },
    },
  });

  const plugin = {
    id: ID,
    meta: {
      id: ID,
      label: "Synthetic Sociality Room",
      selectionLabel: "Synthetic Sociality Room",
      docsPath: "/channels/synthetic-sociality-room",
      blurb: "Join a Synthetic Sociality Room with the current OpenClaw identity.",
      markdownCapable: true,
      showInSetup: true,
    },
    capabilities: {chatTypes: ["group"], reply: true, media: false, reactions: false, blockStreaming: true},
    messaging: {
      targetPrefixes: [ID, "room"],
      normalizeTarget: normalizeRoomTarget,
      inferTargetChatType: () => "group",
      targetResolver: {
        looksLikeId: looksLikeRoomId,
        hint: "<room-id>",
        resolveTarget: async ({cfg, accountId, normalized}) => {
          const account = resolveAccount(cfg, accountId ?? "default");
          if (!account.configured || !account.stateFile) return null;
          return resolveConfiguredRoomTarget(normalized, await loadState(account.stateFile));
        },
      },
    },
    config: {
      listAccountIds: (cfg) => resolvedRoomAccounts(cfg).map((account) => account.accountId),
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId ?? "default"),
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({accountId: account.accountId, enabled: account.enabled, configured: account.configured}),
    },
    message,
    gateway: {
      startAccount: async (ctx) => {
        const runtime = ctx.channelRuntime;
        if (!runtime) throw new Error("OpenClaw channelRuntime is unavailable");
        const ownership = claimRuntimeOwnership(runtimeOwners, ctx.account);
        let client;
        let registered = false;
        let lastHostRunEndedAt = 0;
        const localStatus = roomLocalStatus(ctx.log, ctx.cfg);
        try {
          // Contract P2c-1: report whether the agent's tools can reach the
          // store that holds the Room credential; refuse to start only when
          // this installation enables enforceSecretIsolation (off by default).
          // A refusal waits for the host's stop instead of failing, so the host
          // does not restart into it again. Fence and scrubbing stay active.
          const reasons = storeReachability(ctx.cfg, () => roomStoreDirectories(ctx.cfg), {stateDir: openClawStateDirectory()});
          const enforced = secretIsolationEnforced(ctx.cfg);
          localStatus.setSecretStore(reasons.length ? "reachable" : "isolated", reasons, {enforced});
          if (reasons.length && !enforced && !secretRefusalLogged) {
            secretRefusalLogged = true;
            ctx.log?.warn?.(`Room connector: ${REFUSAL_CODE} (${reasons.join(",")}). The agent's file or shell tools could read the Room credential; reporting only (enforceSecretIsolation is off), the path fence and scrubbing stay active.`);
          }
          if (reasons.length && enforced) {
            const saved = await loadState(ctx.account.stateFile).catch(() => null);
            if (saved?.roomId) localStatus.room(String(saved.roomId), String(saved.membershipId ?? ""), {connection: "stopped", errorCode: REFUSAL_CODE});
            if (!secretRefusalLogged) {
              secretRefusalLogged = true;
              ctx.log?.error?.(`Room connector refused to start: ${REFUSAL_CODE} (${reasons.join(",")}). The agent's file or shell tools could read the Room credential; set tools.fs.workspaceOnly, deny group:runtime or sandbox every agent (mode all, elevated off, no bind over the OpenClaw state directory).`);
            }
            ctx.setStatus({...ctx.getStatus(), running: true, connected: false, lastError: REFUSAL_CODE});
            await untilAborted(ctx.abortSignal);
            return;
          }
          const replyPolicy = roomReplyDeliveryPolicy();
          ctx.setStatus({...ctx.getStatus(), running: true, connected: false, lastError: null});
          await markChannelActive(ctx.accountId);
          registered = true;
          client = makeClient(ctx.account, {logger: scrubbingLogger(ctx.log), waitForRenewal: true, status: localStatus});
          // Contract P7d-5: the agent the host routes a Room conversation of
          // this account to (the same route resolution as each turn below).
          client.resolveRoomAgent = (conversationId, roomId) => runtime.routing.resolveAgentRoute({
            cfg: ctx.cfg, channel: ID, accountId: ctx.accountId,
            peer: {kind: "group", id: conversationId}, parentPeer: {kind: "group", id: roomId},
          })?.agentId;
          const session = await client.initialize(ctx.abortSignal);
          live.set(ctx.accountId, {token: ownership.token, client, abortSignal: ctx.abortSignal});
          ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastConnectedAt: Date.now(), lastError: null});
          ctx.log?.info?.(`[${ctx.accountId}] Room connection signal established (${session.sessionId})`);
          for await (const event of client.assignedTurns(ctx.abortSignal)) {
            let cycleSettled = false;
            let visibleReplySent = false;
            let operationalFallbackSuppressed = false;
            let skipReason = "";
            // The recorded outcome of a produced reply (delivery contract P1-5):
            // posted, skipped, superseded, quarantined, delivery_pending, or
            // failed. A refused reply is never a model that chose silence.
            let deliveryOutcome = "";
            // The turn's reply is the first model-authored payload (P1a-6).
            let replyText = null;
            let replySent = null;
            // A handler that throws never reached a deliberate decision either.
            let handlerCompleted = false;
            ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastInboundAt: Date.now(), lastError: null});
            await client.markTurnReading(event.sourceEventId ?? event.id, ctx.abortSignal);
            // Diagnostics (OP-12 P2a): the host run is OpenClaw's only host
            // gate; later Room events are read once it settles. Log when a
            // turn enters it and when it leaves, so a silent agent shows why.
            const hostSeq = Number.isSafeInteger(event.raw?.seq) ? event.raw.seq : "?";
            const hostStartedAt = Date.now();
            const sinceRoomEvent = Number.isFinite(event.occurredAt) ? Math.max(0, (hostStartedAt - event.occurredAt) / 1000) : 0;
            ctx.log?.info?.(`[${ctx.accountId}] Room ${event.roomId} seq ${hostSeq} dispatched to the host after waiting ${sinceRoomEvent.toFixed(1)}s since the Room event; later Room events wait for this run`);
            // P2c-4 (ISSUE-023): the coded reason when the event arrived while an
            // earlier host run of this account still held the session.
            const waitedOnHost = Number.isFinite(event.occurredAt) && event.occurredAt < lastHostRunEndedAt;
            localStatus.room(String(event.roomId ?? ""), "", {gateWaitSeconds: sinceRoomEvent, gateWaitReason: waitedOnHost ? "host_run_busy" : ""});
            try {
              await runtime.inbound.run({
              channel: ID,
              accountId: ctx.accountId,
              raw: event,
              adapter: {
                ingest: (raw) => ({id: raw.id, timestamp: raw.occurredAt, rawText: raw.text, textForAgent: raw.text, raw}),
                classify: () => ({kind: "message", canStartAgentTurn: true}),
                resolveTurn: (input) => {
                  const routePeer = {kind: "group", id: event.conversationId};
                  const parentPeer = {kind: "group", id: event.roomId};
                  const route = runtime.routing.resolveAgentRoute({
                    cfg: ctx.cfg,
                    channel: ID,
                    accountId: ctx.accountId,
                    peer: routePeer,
                    parentPeer,
                  });
                  const ctxPayload = buildChannelInboundEventContext({
                    channel: ID,
                    provider: ID,
                    accountId: ctx.accountId,
                    messageId: event.sourceEventId,
                    timestamp: event.occurredAt,
                    from: `${ID}:${event.senderId}`,
                    sender: {id: event.senderId, name: event.senderName, displayLabel: event.senderName, isBot: event.senderKind === "agent"},
                    conversation: {kind: "group", id: event.conversationId, label: event.roomId, routePeer},
                    route: {
                      agentId: route.agentId,
                      accountId: route.accountId,
                      routeSessionKey: route.sessionKey,
                      mainSessionKey: route.mainSessionKey,
                      createIfMissing: true,
                    },
                    reply: {
                      to: event.roomId,
                      originatingTo: event.roomId,
                      replyTarget: event.roomId,
                      deliveryTarget: event.roomId,
                      replyToId: event.respondsToId,
                      ...replyPolicy.replyPlan,
                    },
                    message: {
                      rawBody: input.rawText,
                      body: input.rawText,
                      bodyForAgent: input.textForAgent ?? input.rawText,
                      commandBody: input.textForCommands ?? input.rawText,
                      senderLabel: event.senderName,
                    },
                    media: event.media ?? [],
                    contextVisibility: "room_only",
                    extra: {canonicalRoomEvent: event.raw},
                  });
                  return {
                    cfg: ctx.cfg,
                    channel: ID,
                    accountId: ctx.accountId,
                    agentId: route.agentId,
                    routeSessionKey: route.sessionKey,
                    storePath: runtime.session.resolveStorePath(undefined, {agentId: route.agentId}),
                    ctxPayload,
                    recordInboundSession: runtime.session.recordInboundSession,
                    dispatchReplyWithBufferedBlockDispatcher: runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
                    replyOptions: replyPolicy.replyOptions,
                    delivery: {
                      durable: {to: event.roomId, replyToId: event.respondsToId},
                      deliver: async (payload, info) => {
                        const notice = await hostNoticeKind(payload, info);
                        if (notice) {
                          ctx.log?.info?.(`[${ctx.accountId}] Room host notice not posted kind=${notice} delivery=${info?.kind ?? "-"} source=${event.sourceEventId}`);
                          return {visibleReplySent: false};
                        }
                        if (isOpenClawOperationalFallback(payload)) {
                          operationalFallbackSuppressed = true;
                          ctx.log?.error?.(`[${ctx.accountId}] Suppressed OpenClaw operational fallback for Room source ${event.sourceEventId}`);
                          return {visibleReplySent: false};
                        }
                        const text = payload.text?.trim();
                        if (!text) return {visibleReplySent: false};
                        if (replyText !== null) {
                          if (text === replyText && replySent) {
                            return {messageIds: [replySent.eventId], receipt: receipt(replySent.eventId, replySent.sentAt), visibleReplySent: true};
                          }
                          // One Room contribution per turn: further model text is recorded here, never posted silently.
                          ctx.log?.warn?.(`[${ctx.accountId}] Room reply payload not posted: the turn's reply is already ${deliveryOutcome || "in flight"} delivery=${info?.kind ?? "-"} chars=${text.length} source=${event.sourceEventId}`);
                          return {visibleReplySent: false};
                        }
                        replyText = text;
                        let sent;
                        try {
                          sent = await client.postAndFinish({
                            roomId: event.roomId,
                            text,
                            replyToId: event.respondsToId,
                            idempotencyKey: `${event.sourceEventId}:final`,
                            signal: ctx.abortSignal,
                            sourceEventId: event.sourceEventId,
                            sourceEpochId: event.epochId,
                            cycleAttempt: event.cycleAttempt,
                          });
                        } catch (error) {
                          // The host swallows a delivery error; keep its recorded outcome.
                          // A later delivery call never downgrades one already recorded.
                          deliveryOutcome = ["quarantined", "delivery_pending"].includes(error?.roomDeliveryOutcome)
                            ? error.roomDeliveryOutcome : (deliveryOutcome || "failed");
                          throw error;
                        }
                        if (sent.superseded) {
                          deliveryOutcome = "superseded";
                          cycleSettled = true;
                          return {visibleReplySent: false};
                        }
                        if (sent.refused) {
                          // Contract L1-12: terminal evidence is recorded and
                          // the attempt released; the source is acknowledged.
                          deliveryOutcome = "refused";
                          cycleSettled = true;
                          return {visibleReplySent: false};
                        }
                        if (sent.skipped) {
                          deliveryOutcome = "skipped";
                          skipReason = sent.reason;
                          return {visibleReplySent: false};
                        }
                        deliveryOutcome = "posted";
                        replySent = sent;
                        cycleSettled = Boolean(event.cycleAttempt);
                        visibleReplySent = true;
                        return {messageIds: [sent.eventId], receipt: receipt(sent.eventId, sent.sentAt), visibleReplySent: true};
                      },
                    },
                    record: {createIfMissing: true, onRecordError: () => ctx.log?.error?.("Room session record failed")},
                    messageId: event.sourceEventId,
                  };
                },
              },
              });
              handlerCompleted = true;
              // Contract P7d-5: the host run of this turn ended. A run that
              // ended in the host's operational fallback failed (it is settled
              // as fail below) and marks nothing.
              if (!operationalFallbackSuppressed) {
                try {
                  await client.markDocumentsGiven?.(event.id);
                } catch (error) {
                  ctx.log?.warn?.(`[${ctx.accountId}] Room document memory not written: ${String(error?.name || "Error")}`);
                }
              }
            } finally {
              lastHostRunEndedAt = Date.now();
              ctx.log?.info?.(`[${ctx.accountId}] Room ${event.roomId} seq ${hostSeq} host run ended after ${((Date.now() - hostStartedAt) / 1000).toFixed(1)}s`);
              // A parked reply replays its exact frozen post and keeps its attempt.
              if (event.cycleAttempt && !cycleSettled && deliveryOutcome !== "delivery_pending") {
                // The skip record one line below already distinguishes these two
                // cases; the attempt outcome must not throw that away.
                const failed = operationalFallbackSuppressed || !handlerCompleted || ["quarantined", "failed"].includes(deliveryOutcome);
                const failure = operationalFallbackSuppressed ? OPERATIONAL_FALLBACK_EXECUTION_FAILURE
                  : deliveryOutcome === "quarantined" ? RELEASED_ATTEMPT_EXECUTION_FAILURE
                    : DEFAULT_EXECUTION_FAILURE;
                await client.settleDiscussionAttempt(event.cycleAttempt, failed ? "fail" : "pass", ctx.abortSignal, failed ? failure : undefined);
              }
            }
            // A quarantined source stays isolated without evidence and a parked
            // one replays; neither is acknowledged here. The scan moves on.
            if (deliveryOutcome === "quarantined" || deliveryOutcome === "delivery_pending") continue;
            if (!visibleReplySent && !["superseded", "refused"].includes(deliveryOutcome)) {
              await client.recordSkipped(event.id, skipReason || (operationalFallbackSuppressed ? "gateway_operational_error"
                : deliveryOutcome === "failed" ? "delivery_failed" : "model_no_visible_reply"));
            }
            await client.ack(event.id);
          }
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({...ctx.getStatus(), connected: false, lastError: `Room channel stopped unexpectedly${roomErrorDiagnostic(error)}`});
            if (client?.state?.roomId) localStatus.room(String(client.state.roomId), "", {errorCode: statusErrorCode(error)});
            throw error;
          }
        } finally {
          if (client?.state?.roomId) localStatus.room(String(client.state.roomId), String(client.state.membershipId ?? ""), {connection: "stopped"});
          const liveEntry = live.get(ctx.accountId);
          if (liveEntry?.token === ownership.token) live.delete(ctx.accountId);
          try {
            await client?.close();
          } catch {
            ctx.log?.warn?.(`[${ctx.accountId}] Room client close failed`);
          }
          if (registered && ownership.owns()) markChannelInactive(ctx.accountId);
          if (ownership.owns()) {
            ctx.setStatus({...ctx.getStatus(), running: false, connected: false, lastStopAt: Date.now()});
          }
          ownership.release();
        }
      },
      stopAccount: async (ctx) => {
        const entry = live.get(ctx.accountId);
        if (entry?.abortSignal === ctx.abortSignal) await entry.client.close();
      },
    },
  };

  return defineChannelPluginEntry({
    id: ID,
    name: "Synthetic Sociality Room",
    description: "Native OpenClaw channel for Synthetic Sociality Rooms",
    plugin,
    registerFull: (api) => {
      // Contract P2c-4: the gateway's status file exists from load; the host
      // stop marks the plugin unloaded. Only the gateway's full registration,
      // never a CLI discovery pass.
      const gatewayLoad = api?.registrationMode === "full";
      if (gatewayLoad) roomLocalStatus(api?.logger, api?.config).setLoaded(true);
      // Contract P2c-1: fence the store in every session, and scrub results.
      if (typeof api?.on === "function") {
        api.on("before_tool_call", roomToolCallPolicy(api, {noteWebRead: gatewayLoad}), {priority: 1000});
        api.on("tool_result_persist", roomToolResultScrub);
        if (gatewayLoad) api.on("gateway_stop", () => { roomLocalStatus(api?.logger, api?.runtime?.config?.current?.() ?? api?.config).setLoaded(false); });
      } else {
        api?.logger?.warn?.("Room connector: this OpenClaw host offers no tool hooks; the start gate still applies");
      }
      registerRoomCommands(api);
      registerPresenceFallback(api, {makeClient});
      registerRoomHistoryTool(api);
      // Contract P7d-6: available once a document read of a Room session
      // succeeded; only the gateway's own registration writes the status.
      registerRoomDocumentTool(api, gatewayLoad
        ? {onAvailable: () => roomLocalStatus(api?.logger, api?.runtime?.config?.current?.() ?? api?.config).setDocumentTool("available")}
        : {});
    },
  });
}
