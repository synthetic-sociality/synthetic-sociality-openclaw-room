import {execFile, spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";

const CHANNEL_ID = "synthetic-sociality-room";
const RESTART_DELAY_MS = 1_500;

export function resolveOpenClawBinary({env = process.env, exists = existsSync} = {}) {
  if (env.OPENCLAW_BIN) return env.OPENCLAW_BIN;
  for (const candidate of ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw", "/usr/bin/openclaw"]) {
    if (exists(candidate)) return candidate;
  }
  return "openclaw";
}

export async function activateRoomChannel({baseUrl, stateFile, command = resolveOpenClawBinary(), exec = execFile} = {}) {
  if (!String(baseUrl ?? "").trim() || !String(stateFile ?? "").trim()) {
    throw new Error("Room channel activation requires baseUrl and stateFile");
  }
  const value = JSON.stringify({enabled: true, baseUrl, stateFile});
  try {
    await new Promise((resolve, reject) => {
    exec(command, ["config", "set", `channels.${CHANNEL_ID}`, value, "--strict-json", "--merge"], {
      timeout: 15_000,
      windowsHide: true,
    }, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    // A running gateway can reload the newly written file before the CLI finishes,
    // causing ConfigMutationConflictError even though the desired value landed.
    const configFile = `${homedir()}/.openclaw/openclaw.json`;
    try {
      const config = JSON.parse(await readFile(configFile, "utf8"));
      const current = config?.channels?.[CHANNEL_ID] ?? {};
      if (current.enabled === true && current.baseUrl === baseUrl && current.stateFile === stateFile) return;
    } catch {}
    throw error;
  }
}

export async function healManagedRoomChannel({home = homedir(), activate = activateRoomChannel, restart = scheduleGatewayRestart} = {}) {
  const stateFile = `${home}/.openclaw/synthetic-sociality-room/accounts/default.json`;
  const configFile = `${home}/.openclaw/openclaw.json`;
  let state;
  let config;
  try {
    [state, config] = await Promise.all([
      readFile(stateFile, "utf8").then(JSON.parse),
      readFile(configFile, "utf8").then(JSON.parse),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const current = config?.channels?.[CHANNEL_ID] ?? {};
  if (current.enabled !== false && current.baseUrl === state.baseUrl && current.stateFile === stateFile) return false;
  await activate({baseUrl: state.baseUrl, stateFile});
  restart();
  return true;
}

export function scheduleGatewayRestart({command = resolveOpenClawBinary(), delayMs = RESTART_DELAY_MS, logger} = {}) {
  const timer = setTimeout(() => {
    const child = spawn(command, ["gateway", "restart"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (error) => logger?.error?.(`Room connector restart failed: ${String(error)}`));
    child.unref();
  }, delayMs);
  timer.unref?.();
}
