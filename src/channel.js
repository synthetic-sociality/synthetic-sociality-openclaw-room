import {defineChannelPluginEntry} from "openclaw/plugin-sdk/channel-core";
import {defineChannelMessageAdapter} from "openclaw/plugin-sdk/channel-message";
import {buildChannelInboundEventContext} from "openclaw/plugin-sdk/channel-inbound";
import {existsSync, readFileSync, readdirSync, lstatSync} from "node:fs";
import {join} from "node:path";
import {defaultStateDirectory, loadState, validateState} from "./state.js";
import {registerRoomCommands} from "./commands.js";
import {markChannelActive, markChannelInactive, registerPresenceFallback} from "./presence-fallback.js";
import {
  accountCandidates,
  claimRuntimeOwnership,
  resolveAccountConfig,
  resolveAccountSelection,
  selectUniqueAccountIds,
} from "./account.js";
import {looksLikeRoomId, normalizeRoomTarget, resolveConfiguredRoomTarget} from "./target.js";
import {outboundIdempotencyKey} from "./outbound.js";
import {roomErrorDiagnostic} from "./room-client.js";
import {
  roomReplyDeliveryPolicy,
} from "./reply-policy.js";

const ID = "synthetic-sociality-room";

const receipt = (eventId, sentAt) => ({
  primaryPlatformMessageId: eventId,
  platformMessageIds: [eventId],
  parts: [{platformMessageId: eventId, kind: "text", index: 0}],
  sentAt,
});

function channelConfig(cfg) { return cfg?.channels?.[ID] ?? {}; }

function managedAccounts() {
  const directory = defaultStateDirectory();
  try {
    return readdirSync(directory, {withFileTypes: true})
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5));
  } catch { return []; }
}

function managedAccount(accountId) {
  const stateFile = join(defaultStateDirectory(), `${accountId}.json`);
  if (!existsSync(stateFile)) return null;
  try {
    const stat = lstatSync(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    validateState(state);
    return {baseUrl: state.baseUrl, stateFile};
  } catch { return null; }
}

function resolveAccount(cfg, accountId = "default", {managedResolver = managedAccount} = {}) {
  const section = channelConfig(cfg);
  const raw = resolveAccountConfig(section, accountId);
  const selected = resolveAccountSelection({
    accountId,
    raw,
    managed: managedResolver(accountId),
    defaultStateFile: join(defaultStateDirectory(), "default.json"),
  });
  return {
    accountId,
    enabled: raw.enabled !== false,
    configured: accountId === "default" || selected.managed !== null || (typeof raw.baseUrl === "string" && typeof raw.stateFile === "string"),
    baseUrl: selected.baseUrl,
    stateFile: selected.stateFile,
    agentId: String(raw.agentId ?? "main"),
  };
}

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
          replyToId: ctx.replyToId,
          idempotencyKey: outboundIdempotencyKey(ctx.deliveryQueueId),
          signal: ctx.signal,
        });
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
      listAccountIds: (cfg) => selectUniqueAccountIds(
        accountCandidates(channelConfig(cfg), managedAccounts()),
        (accountId) => resolveAccount(cfg, accountId),
      ),
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
        try {
          const replyPolicy = roomReplyDeliveryPolicy();
          ctx.setStatus({...ctx.getStatus(), running: true, connected: false, lastError: null});
          await markChannelActive(ctx.accountId);
          registered = true;
          client = makeClient(ctx.account, {logger: ctx.log});
          const session = await client.initialize(ctx.abortSignal);
          live.set(ctx.accountId, {token: ownership.token, client, abortSignal: ctx.abortSignal});
          ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastConnectedAt: Date.now(), lastError: null});
          ctx.log?.info?.(`[${ctx.accountId}] Room connection signal established (${session.sessionId})`);
          for await (const event of client.assignedTurns(ctx.abortSignal)) {
            let cycleSettled = false;
            let visibleReplySent = false;
            ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastInboundAt: Date.now(), lastError: null});
            await client.markTurnReading(event.sourceEventId ?? event.id, ctx.abortSignal);
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
                      deliver: async (payload) => {
                        const text = payload.text?.trim();
                        if (!text) return {visibleReplySent: false};
                        const sent = await client.postAndFinish({
                          roomId: event.roomId,
                          text,
                          replyToId: event.respondsToId,
                          idempotencyKey: `${event.sourceEventId}:final`,
                          signal: ctx.abortSignal,
                          sourceEventId: event.sourceEventId,
                          sourceEpochId: event.epochId,
                          cycleAttempt: event.cycleAttempt,
                        });
                        if (sent.superseded) {
                          cycleSettled = true;
                          return {visibleReplySent: false};
                        }
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
            } finally {
              if (event.cycleAttempt && !cycleSettled) {
                await client.passDiscussionAttempt(event.cycleAttempt, ctx.abortSignal);
              }
            }
            if (!visibleReplySent) {
              await client.recordSkipped(event.id, "model_no_visible_reply");
            }
            await client.ack(event.id);
          }
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({...ctx.getStatus(), connected: false, lastError: `Room channel stopped unexpectedly${roomErrorDiagnostic(error)}`});
            throw error;
          }
        } finally {
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
      registerRoomCommands(api);
      registerPresenceFallback(api, {makeClient});
    },
  });
}
