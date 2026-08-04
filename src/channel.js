import {defineChannelPluginEntry} from "openclaw/plugin-sdk/channel-core";
import {defineChannelMessageAdapter} from "openclaw/plugin-sdk/channel-message";
import {buildChannelInboundEventContext} from "openclaw/plugin-sdk/channel-inbound";
import {existsSync, readFileSync, readdirSync, lstatSync} from "node:fs";
import {join} from "node:path";
import {defaultStateDirectory, validateState} from "./state.js";
import {registerRoomCommands} from "./commands.js";
import {markChannelActive, markChannelInactive, registerPresenceFallback} from "./presence-fallback.js";
import {resolveAccountSelection} from "./account.js";

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
  const raw = section.accounts?.[accountId] ?? section;
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
  const message = defineChannelMessageAdapter({
    receive: {defaultAckPolicy: "manual", supportedAckPolicies: ["manual"]},
    send: {
      text: async (ctx) => {
        const accountId = ctx.accountId ?? "default";
        const client = live.get(accountId);
        if (!client) throw new Error(`Room account ${accountId} is not running`);
        const sent = await client.postAndFinish({
          roomId: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId,
          idempotencyKey: ctx.deliveryQueueId ?? `${ctx.replyToId ?? "outbound"}:text`,
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
    config: {
      listAccountIds: (cfg) => [...new Set(["default", ...Object.keys(channelConfig(cfg).accounts ?? {}), ...managedAccounts()])],
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
        const client = makeClient(ctx.account, {logger: ctx.log});
        let registered = false;
        ctx.setStatus({...ctx.getStatus(), running: true, connected: false, lastError: null});
        try {
          const session = await client.initialize(ctx.abortSignal);
          live.set(ctx.accountId, client);
          await markChannelActive(ctx.accountId);
          registered = true;
          ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastConnectedAt: Date.now(), lastError: null});
          ctx.log?.info?.(`[${ctx.accountId}] Room connection signal established (${session.sessionId})`);
          for await (const event of client.assignedTurns(ctx.abortSignal)) {
            ctx.setStatus({...ctx.getStatus(), running: true, connected: true, lastInboundAt: Date.now(), lastError: null});
            await runtime.inbound.run({
              channel: ID,
              accountId: ctx.accountId,
              raw: event,
              adapter: {
                ingest: (raw) => ({id: raw.id, timestamp: raw.occurredAt, rawText: raw.text, textForAgent: raw.text, raw}),
                classify: () => ({kind: "message", canStartAgentTurn: true}),
                resolveTurn: (input) => {
                  const route = runtime.routing.resolveAgentRoute({
                    cfg: ctx.cfg,
                    channel: ID,
                    accountId: ctx.accountId,
                    peer: {kind: "group", id: event.roomId},
                  });
                  const ctxPayload = buildChannelInboundEventContext({
                    channel: ID,
                    provider: ID,
                    accountId: ctx.accountId,
                    messageId: event.sourceEventId,
                    timestamp: event.occurredAt,
                    from: `${ID}:${event.senderId}`,
                    sender: {id: event.senderId, name: event.senderName, displayLabel: event.senderName, isBot: event.senderKind === "agent"},
                    conversation: {kind: "group", id: event.roomId, label: event.roomId, routePeer: {kind: "group", id: event.roomId}},
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
                      replyToId: event.sourceEventId,
                      sourceReplyDeliveryMode: "channel",
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
                    delivery: {
                      durable: {to: event.roomId, replyToId: event.sourceEventId},
                      deliver: async (payload) => {
                        const text = payload.text?.trim();
                        if (!text) return {visibleReplySent: false};
                        const sent = await client.postAndFinish({
                          roomId: event.roomId,
                          text,
                          replyToId: event.sourceEventId,
                          idempotencyKey: `${event.sourceEventId}:final`,
                          signal: ctx.abortSignal,
                        });
                        return {messageIds: [sent.eventId], receipt: receipt(sent.eventId, sent.sentAt), visibleReplySent: true};
                      },
                    },
                    record: {createIfMissing: true, onRecordError: (error) => ctx.log?.error?.(`Room session record failed: ${String(error)}`)},
                    messageId: event.sourceEventId,
                  };
                },
              },
            });
            await client.ack(event.id);
          }
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({...ctx.getStatus(), connected: false, lastError: String(error)});
            throw error;
          }
        } finally {
          live.delete(ctx.accountId);
          await client.close();
          if (registered) markChannelInactive(ctx.accountId);
          ctx.setStatus({...ctx.getStatus(), running: false, connected: false, lastStopAt: Date.now()});
        }
      },
      stopAccount: async (ctx) => {
        await live.get(ctx.accountId)?.close();
        live.delete(ctx.accountId);
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
