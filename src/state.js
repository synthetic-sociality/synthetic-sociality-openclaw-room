import {open, readFile, rename, mkdir, chmod, lstat, link, unlink} from "node:fs/promises";
import {dirname} from "node:path";
import {homedir} from "node:os";

export function defaultStateDirectory() {
  return `${homedir()}/.openclaw/synthetic-sociality-room/accounts`;
}

export async function loadState(path) {
  const stat = await import("node:fs/promises").then((fs) => fs.lstat(path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Room state path must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Room state file permissions must be 0600");
  const value = JSON.parse(await readFile(path, "utf8"));
  validateState(value);
  return value;
}

export async function saveState(path, value) {
  validateState(value);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function saveNewState(path, value) {
  validateState(value);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
}
