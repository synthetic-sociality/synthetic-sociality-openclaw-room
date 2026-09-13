import {resolvedRoomAccounts} from "./account-discovery.js";
import {canonicalStateFileIdentity} from "./account.js";
import {roomErrorDiagnostic} from "./room-client.js";

const START_GRACE_MS = 5_000;
const RECONCILE_MS = 10_000;

const activeChannels = new Set();
const fallbackRuntimes = new Map();
let serviceRunning = false;
let serviceTask = null;
let wakeStop = null;

function accountKey(account) {
  return JSON.stringify([canonicalStateFileIdentity(account.stateFile), account.baseUrl, account.agentId]);
}

async function stopFallback(accountId) {
  const entry = fallbackRuntimes.get(accountId);
  if (!entry) return;
  fallbackRuntimes.delete(accountId);
  entry.abort.abort();
  await entry.runtime.close().catch(() => {});
}

export async function markChannelActive(accountId) {
  activeChannels.add(accountId);
  await stopFallback(accountId);
}

export function markChannelInactive(accountId) {
  activeChannels.delete(accountId);
}

export function registerPresenceFallback(api, {
  makeClient,
  startGraceMs = START_GRACE_MS,
  reconcileMs = RECONCILE_MS,
  accounts = () => resolvedRoomAccounts(api.runtime.config.current()),
  waitFn = wait,
} = {}) {
  api.registerService({
    id: "synthetic-sociality-room-presence",
    start: (ctx) => {
      serviceRunning = true;
      const stopped = new Promise((resolve) => { wakeStop = resolve; });
      const pause = (milliseconds) => Promise.race([waitFn(milliseconds), stopped]);
      serviceTask = (async () => {
        await pause(startGraceMs);
        while (serviceRunning) {
          let eligible;
          try {
            eligible = new Map(accounts().filter((account) => account.enabled !== false && account.configured !== false)
              .map((account) => [account.accountId, {account, key: accountKey(account)}]));
          } catch (error) {
            // Config resolution failure is never permission to keep an old
            // fallback alive. Retry later without retaining stale authority.
            eligible = new Map();
            ctx.logger?.error?.(`Room presence account resolution failed${roomErrorDiagnostic(error)}`);
          }
          for (const [id, entry] of fallbackRuntimes) {
            if (activeChannels.has(id) || eligible.get(id)?.key !== entry.key) await stopFallback(id);
          }
          for (const {account, key} of eligible.values()) {
            if (!serviceRunning) break;
            if (activeChannels.has(account.accountId) || fallbackRuntimes.has(account.accountId)) continue;
            try {
              const runtime = makeClient(account);
              const entry = {runtime, key, abort: new AbortController()};
              // Register before initialization: disable/native takeover can
              // cancel a pending initialization, without blocking reconcile.
              fallbackRuntimes.set(account.accountId, entry);
              entry.task = (async () => {
                try {
                  const session = await runtime.initialize(entry.abort.signal);
                  if (fallbackRuntimes.get(account.accountId) !== entry) return;
                  const current = accounts().find((candidate) => candidate.accountId === account.accountId);
                  if (!serviceRunning || activeChannels.has(account.accountId) || !current || current.enabled === false || current.configured === false || accountKey(current) !== key) {
                    await stopFallback(account.accountId);
                    return;
                  }
                  ctx.logger?.warn?.(`[${account.accountId}] Native channel did not register; Room presence fallback established (${session.sessionId})`);
                } catch (error) {
                  const cancelled = entry.abort.signal.aborted;
                  if (fallbackRuntimes.get(account.accountId) === entry) await stopFallback(account.accountId);
                  if (!cancelled) ctx.logger?.error?.(`[${account.accountId}] Room presence fallback failed${roomErrorDiagnostic(error)}`);
                }
              })();
            } catch (error) {
              ctx.logger?.error?.(`[${account.accountId}] Room presence fallback failed${roomErrorDiagnostic(error)}`);
            }
          }
          await pause(reconcileMs);
        }
      })().catch((error) => {
        if (serviceRunning) ctx.logger?.error?.(`Room presence fallback stopped unexpectedly${roomErrorDiagnostic(error)}`);
      });
    },
    stop: async () => {
      serviceRunning = false;
      wakeStop?.();
      const tasks = [...fallbackRuntimes.values()].map((entry) => entry.task);
      await Promise.all([...fallbackRuntimes.keys()].map(stopFallback));
      await Promise.all(tasks);
      await serviceTask?.catch(() => {});
      serviceTask = null;
      wakeStop = null;
    },
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

export const presenceFallbackTest = {
  activeChannels,
  fallbackRuntimes,
  reset: async () => {
    serviceRunning = false;
    wakeStop?.();
    activeChannels.clear();
    await Promise.all([...fallbackRuntimes.keys()].map(stopFallback));
    serviceTask = null;
    wakeStop = null;
  },
};
