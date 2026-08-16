import {randomUUID} from "node:crypto";
import {open, readFile, rename, mkdir, chmod, lstat, link, unlink} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {homedir} from "node:os";

export function defaultStateDirectory() {
  return `${homedir()}/.openclaw/synthetic-sociality-room/accounts`;
}

export async function loadState(path) {
  const stat = await import("node:fs/promises").then((fs) => fs.lstat(path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Room state path must be a regular file");
  if (stat.nlink > 1) throw new Error("Room state file must not be hard-linked");
  if ((stat.mode & 0o077) !== 0) throw new Error("Room state file permissions must be 0600");
  const value = JSON.parse(await readFile(path, "utf8"));
  validateState(value);
  return value;
}

const stateWrites = new Map();

export function saveState(path, value) {
  const key = resolve(path);
  const previous = stateWrites.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => replaceState(path, value));
  stateWrites.set(key, operation);
  return operation.finally(() => {
    if (stateWrites.get(key) === operation) stateWrites.delete(key);
  });
}

async function replaceState(path, value) {
  await assertStateTargetNotHardLinked(path);
  const temporary = await createTemporaryState(path, value);
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function saveNewState(path, value) {
  const temporary = await createTemporaryState(path, value);
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("This Room membership is already paired on this OpenClaw host");
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await chmod(path, 0o600);
}

async function assertStateTargetNotHardLinked(path) {
  try {
    const stat = await lstat(path);
    if (stat.nlink > 1) throw new Error("Room state file must not be hard-linked");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function createTemporaryState(path, value) {
  validateState(value);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Room state directory must be a real directory");
  await chmod(directory, 0o700);
}

export function validateState(value) {
  if (!value || value.version !== 1) throw new Error("Unsupported Room state version");
  for (const field of ["baseUrl", "roomId", "membershipId", "credential", "clientInstanceId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Room state is missing ${field}`);
  }
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error("Room state cursor is invalid");
  if (value.messagePayloadDialect !== undefined && !["v1", "v2"].includes(value.messagePayloadDialect)) {
    throw new Error("Room message payload dialect is invalid");
  }
  if (value.messagePayloadCapabilities !== undefined && (
    !Array.isArray(value.messagePayloadCapabilities)
    || !value.messagePayloadCapabilities.every((item) => typeof item === "string")
  )) throw new Error("Room message payload capabilities are invalid");
  if (value.deliveryIntents !== undefined && (
    !value.deliveryIntents || typeof value.deliveryIntents !== "object" || Array.isArray(value.deliveryIntents)
  )) throw new Error("Room delivery intents are invalid");
}
