import {readdirSync} from "node:fs";
import {join} from "node:path";
import {defaultStateDirectory} from "./state.js";

const START_GRACE_MS = 5_000;
const RECONCILE_MS = 10_000;

const activeChannels = new Set();
const fallbackRuntimes = new Map();
let serviceRunning = false;
let serviceTask = null;
let wakeStop = null;

function stateAccounts() {
  try {
    return readdirSync(defaultStateDirectory(), {withFileTypes: true})
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .map((entry) => ({
        accountId: entry.name.slice(0, -5),
        stateFile: join(defaultStateDirectory(), entry.name),
      }));
  } catch {
    return [];
  }
}

async function stopFallback(accountId) {
  const runtime = fallbackRuntimes.get(accountId);
  if (!runtime) return;
  fallbackRuntimes.delete(accountId);
  await runtime.close().catch(() => {});
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
  accounts = stateAccounts,
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
          for (const account of accounts()) {
            if (activeChannels.has(account.accountId) || fallbackRuntimes.has(account.accountId)) continue;
            const runtime = makeClient({
              accountId: account.accountId,
              stateFile: account.stateFile,
              baseUrl: "",
            });
            try {
              const session = await runtime.initialize();
              if (activeChannels.has(account.accountId) || !serviceRunning) {
                await runtime.close().catch(() => {});
                continue;
              }
              fallbackRuntimes.set(account.accountId, runtime);
              ctx.logger?.warn?.(`[${account.accountId}] Native channel did not register; Room presence fallback established (${session.sessionId})`);
            } catch (error) {
              await runtime.close().catch(() => {});
              ctx.logger?.error?.(`[${account.accountId}] Room presence fallback failed: ${String(error)}`);
            }
          }
          await pause(reconcileMs);
        }
      })().catch((error) => {
        if (serviceRunning) ctx.logger?.error?.(`Room presence fallback stopped unexpectedly: ${String(error)}`);
      });
    },
    stop: async () => {
      serviceRunning = false;
      wakeStop?.();
      await Promise.all([...fallbackRuntimes.keys()].map(stopFallback));
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
