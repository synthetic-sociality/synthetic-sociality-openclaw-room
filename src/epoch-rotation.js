// Contract P6-3: operator-authorised rotation of the legacy per-Room host
// session (Hermes: `hermes room rotate-current-epoch-session`). The command
// never writes the state file a running connector owns; it leaves a request
// beside it, which the connector consumes once at its next start.
import {closeSync, constants as fs, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync} from "node:fs";
import {randomUUID} from "node:crypto";

const REQUEST_MAX_BYTES = 4096;

// Never ending in .json: account discovery takes every *.json file in the
// state directory for an account (src/account-discovery.js, src/state.js:17).
export function rotationRequestPath(stateFile) {
  return `${stateFile}.rotate-epoch-session.request`;
}

export function routingSummary(state, requestPending) {
  const routing = state.epochSessionRoutingInitialized === true ? "initialized" : "not initialized";
  const legacy = state.legacySessionEpochId ? "the legacy Room session" : "an epoch session";
  const pending = requestPending || state.rotateCurrentEpochSession === true ? " A rotation is already authorized." : "";
  return `Epoch session routing is ${routing}; the epoch recorded at initialization uses ${legacy}.${pending}`;
}

export function rotationRequestPending(stateFile) {
  try {
    return lstatSync(rotationRequestPath(stateFile)).isFile();
  } catch {
    return false;
  }
}

export function writeRotationRequest(stateFile, state, now = new Date()) {
  const request = {
    version: 1, roomId: state.roomId, membershipId: state.membershipId, clientInstanceId: state.clientInstanceId,
    requestedAt: now.toISOString(),
  };
  // Atomic: a temporary file (0600, never .json) renamed over the request.
  const path = rotationRequestPath(stateFile);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | (fs.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${JSON.stringify(request)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return request;
}

// The request for this exact membership, or null. Throws only for a request
// file that exists and cannot be used; the caller logs that by code.
export function readRotationRequest(stateFile, state) {
  const path = rotationRequestPath(stateFile);
  let fd;
  try {
    fd = openSync(path, fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0) | (fs.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let text;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("rotation request is not a regular file");
    const buffer = Buffer.alloc(REQUEST_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > REQUEST_MAX_BYTES) throw new Error("rotation request is too large");
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const request = JSON.parse(text);
  if (!request || request.version !== 1 || request.roomId !== state.roomId || request.membershipId !== state.membershipId
      || request.clientInstanceId !== state.clientInstanceId) {
    throw new Error("rotation request names another membership");
  }
  return request;
}

export function removeRotationRequest(stateFile) {
  try {
    unlinkSync(rotationRequestPath(stateFile));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
