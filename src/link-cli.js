// Contract L1o-1: `openclaw-room-link`, run by the person on their OpenClaw
// host. `link` (the default) reads the token from the person's OpenClaw card
// at a hidden prompt, shows the server and asks before anything is written,
// then confirms the pairing once; `status` shows the link without secrets,
// with the link state the running gateway reports in its status file;
// `unlink` deletes the local key and record. The token, the pairing secret
// and the key are never printed.
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {roomStatusPath} from "./account-discovery.js";
import {
  LinkError, MAX_TOKEN_LENGTH, confirmPending, deleteLink, deviceLabel, discardPending, linkPath, parseToken,
  pendingPath, pendingRecord, publicView, readLink, sendConfirmation, serverHost, withLinkLock, writeLink,
} from "./link.js";

const USAGE = "Usage: openclaw-room-link [link | status | unlink]  (the link token is asked for at a hidden prompt)";
const CARD = "Settings > Plugins > OpenClaw > Link";
// P11b-3: codes the person reads with a plain reason.
const REASONS = {
  link_blocked_by_site_protection: "The request was blocked by the site's bot protection before it reached the Harness",
};
const NOT_REPORTED = "The OpenClaw gateway has not reported the link: its status file has no link entry. Check that the gateway is running.";
const plain = (code) => (REASONS[code] ? `${REASONS[code]} (${code})` : code);

// Lines from the input stream; a hidden read on a terminal turns echo off.
class Prompter {
  constructor(input, errors) {
    this.input = input;
    this.errors = errors;
    this.buffer = "";
    this.ended = false;
    this.waiter = null;
    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      this.buffer += chunk;
      this.pump();
    });
    input.on("end", () => {
      this.ended = true;
      this.pump();
    });
    input.pause?.();
  }

  pump() {
    const waiter = this.waiter;
    if (!waiter) return;
    const index = this.buffer.search(/[\r\n\x03\x04]/u);
    if (index < 0) {
      if (this.buffer.length > MAX_TOKEN_LENGTH + 2) {
        this.buffer = "";
        this.waiter = null;
        waiter.reject(new LinkError("link_token_invalid", "the input is too long"));
      } else if (this.ended) {
        const rest = this.buffer;
        this.buffer = "";
        this.waiter = null;
        waiter.resolve(rest);
      }
      return;
    }
    const mark = this.buffer[index];
    let line = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index + 1);
    if (mark === "\r" && this.buffer.startsWith("\n")) this.buffer = this.buffer.slice(1);
    this.waiter = null;
    if (mark === "\x03") {
      waiter.reject(new LinkError("link_cancelled", "cancelled"));
      return;
    }
    // Backspace as typed at a raw terminal.
    let edited = "";
    for (const ch of line) edited = ch === "\x7f" || ch === "\b" ? edited.slice(0, -1) : edited + ch;
    line = edited;
    waiter.resolve(line);
  }

  read(prompt, {hidden = false} = {}) {
    this.errors.write(prompt);
    const raw = hidden && this.input.isTTY && typeof this.input.setRawMode === "function";
    if (raw) this.input.setRawMode(true);
    this.input.resume?.();
    return new Promise((resolve, reject) => {
      this.waiter = {resolve, reject};
      this.pump();
    }).finally(() => {
      if (raw) {
        this.input.setRawMode(false);
        this.errors.write("\n");
      }
      this.input.pause?.();
    });
  }

  close() {
    this.input.pause?.();
    this.input.removeAllListeners?.("data");
    this.input.removeAllListeners?.("end");
  }
}

// The host configuration of the store the record is in: OPENCLAW_CONFIG_PATH,
// else openclaw.json in the state directory (the parent of the fenced store).
// Only its account paths are used; nothing of it is printed.
function hostConfig(path) {
  const configured = String(process.env.OPENCLAW_CONFIG_PATH ?? "").trim();
  return JSON.parse(readFileSync(configured || join(dirname(dirname(path)), "openclaw.json"), "utf8"));
}

// The link as the running gateway reports it: from the status file the
// gateway writes (the gateway's own path rule, next to the account state in
// use, which on Aura is outside OPENCLAW_STATE_DIR), then from the file
// beside link.json, which is also where a configuration that cannot be read
// leads. Null when neither names the link.
function linkStatus(path) {
  const files = [];
  try {
    files.push(roomStatusPath(hostConfig(path)));
  } catch {
    // No readable configuration: only the file beside link.json.
  }
  files.push(join(dirname(path), "status.json"));
  for (const file of new Set(files)) {
    try {
      const reported = JSON.parse(readFileSync(file, "utf8"))?.link;
      if (reported !== null && typeof reported === "object") return reported;
    } catch {
      // A missing or unreadable status file reports nothing.
    }
  }
  return null;
}

async function link({prompter, out, path, sender, now, label}) {
  const token = parseToken(await prompter.read(`Link token from your OpenClaw card (${CARD}), input hidden: `, {hidden: true}), {now: now()});
  let current = null;
  try {
    current = readLink(path);
  } catch {
    current = null;
  }
  const working = current?.state === "active" ? current : null;
  out(`Server: ${serverHost(token.audience)}\nThis OpenClaw: ${label}\nDevice: ${token.deviceId}\n`);
  if (working) out(`Your working link (device ${working.deviceId}) stays in place until the server confirms this one.\n`);
  const answer = await prompter.read("Link this OpenClaw to that server? [y/N] ");
  if (!/^\s*y(es)?\s*$/iu.test(answer)) {
    out("Not linked. Nothing was written.\n");
    return 1;
  }
  const record = pendingRecord(token, {label, clock: now});
  await withLinkLock(path, () => writeLink(record, pendingPath(path)));
  const result = await confirmPending({path, sender, now});
  if (result.state === "active") {
    out(`Linked: device ${record.deviceId}, key fingerprint ${record.fingerprintSha256.slice(0, 16)}.\n`);
    out("The running OpenClaw gateway connects within a few seconds. Check it with: openclaw-room-link status\n");
    if (working && working.deviceId !== record.deviceId) out(`Revoke the old device ${working.deviceId} on your OpenClaw card (${CARD}).\n`);
    return 0;
  }
  if (result.state === "pending" && !working) {
    out(REASONS[result.code]
      ? `Not confirmed yet. ${plain(result.code)}. The running OpenClaw gateway retries until the token expires at ${token.expiresAt}.\n`
      : `Not confirmed yet (${result.code}). The running OpenClaw gateway retries until the token expires at ${token.expiresAt}.\n`);
    out("Check it with: openclaw-room-link status\n");
    return 0;
  }
  if (result.state === "pending") {
    await discardPending(path);
    out(`The new link was not confirmed (${plain(result.code)}). Your working link is unchanged. Run openclaw-room-link again to retry.\n`);
    return 1;
  }
  const reason = result.state === "expired" ? "The link token expired before the server confirmed it." : "The server refused the link token: it is spent, expired or invalid.";
  out(`${reason} Create a fresh token on your OpenClaw card (${CARD}) and run openclaw-room-link again.\n`);
  out("If this device already appears on your card (a confirmation that did not reach this machine), revoke it there, then link again.\n");
  if (working) out("Your working link is unchanged.\n");
  return 1;
}

function status({out, path}) {
  let record = null;
  let pending = null;
  let readable = true;
  try {
    record = readLink(path);
    pending = readLink(pendingPath(path));
  } catch {
    readable = false;
  }
  const reported = linkStatus(path);
  out(`${JSON.stringify({
    record: readable ? (record ? publicView(record) : null) : "unreadable",
    pending: pending ? publicView(pending) : null,
    link: reported,
    ...(reported ? {} : {note: NOT_REPORTED}),
  }, null, 2)}\n`);
  return 0;
}

async function unlink({out, path}) {
  const view = await withLinkLock(path, () => deleteLink(path));
  if (!view) {
    out("Not linked; nothing to delete.\n");
    return 0;
  }
  const device = view.deviceId ? ` of device ${view.deviceId}` : "";
  out(`Unlinked: the local key and record${device} are deleted.\n`);
  out(`The server lists the device until you revoke it on your OpenClaw card (${CARD}).\n`);
  if (view.pendingNotRemoved) out("A directory in place of the pending re-link was not empty and was left as it is.\n");
  return 0;
}

export async function runLinkCli(argv, {input = process.stdin, output = process.stdout, errors = process.stderr, path = linkPath(),
  sender = sendConfirmation, now = Date.now, label = deviceLabel()} = {}) {
  const out = (text) => output.write(text);
  const args = [...argv];
  const command = args.shift() ?? "link";
  if (args.length || !["link", "status", "unlink"].includes(command)) {
    // L1-1: a token is never taken from the command line.
    const token = [command, ...args].some((value) => /^tw[a-z0-9]*1\./u.test(String(value)));
    errors.write(token
      ? "openclaw-room-link: never put the link token on the command line; run openclaw-room-link and paste it at the prompt.\n"
      : `${USAGE}\n`);
    return 2;
  }
  const prompter = command === "link" ? new Prompter(input, errors) : null;
  try {
    if (command === "status") return status({out, path});
    if (command === "unlink") return await unlink({out, path});
    return await link({prompter, out, path, sender, now, label});
  } catch (error) {
    if (error instanceof LinkError) errors.write(`openclaw-room-link: ${error.message} (${error.code})\n`);
    else errors.write(`openclaw-room-link: the link store could not be used (${error?.code ?? error?.name ?? "error"})\n`);
    return 1;
  } finally {
    prompter?.close();
  }
}
