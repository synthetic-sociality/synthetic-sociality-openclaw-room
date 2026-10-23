// P10: explicit source-bound shares. A create with an uncertain receipt never retries.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath, stat} from 'node:fs/promises';
import {basename, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
export const TOOL_NAME = 'synthetic_sociality_room_share_file';
export const SHARE_INSTRUCTION = 'Share a file you want the Room to see with synthetic_sociality_room_share_file, never by naming a local path or pasting its contents.';
export const PARAMETERS = {type: 'object', properties: {path: {type: 'string'}, title: {type: 'string'}}, required: ['path'], additionalProperties: false};
export const DESCRIPTION = 'Share a file from your configured workspace with the Room during this turn; stages it on the single canonical post.';
export const LIMIT = 2031616;
export const TYPES = {'.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const expand = (p) => p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
const inside = (p, root) => { const rel = relative(root, p); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
export const refused = (code) => ({success: false, code, ...(code === 'size' ? {limitBytes: LIMIT} : {})});
export function validRefs(value) {
  return Array.isArray(value) && value.length <= 8 && value.every(ref => ref && typeof ref === 'object' &&
    Object.keys(ref).sort().join(',') === 'artifactId,versionId' && ['artifactId','versionId'].every(k => typeof ref[k] === 'string' && ref[k].length > 0 && ref[k].length <= 128));
}
export function validUploads(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([source, records]) => source && records && typeof records === 'object' && !Array.isArray(records) && Object.keys(records).length <= 8 &&
    Object.entries(records).every(([key, record]) => /^[0-9a-f]{64}$/.test(key) && record && ['creating','created','refused'].includes(record.state) &&
      (record.state !== 'created' || (record.result?.success === true && validRefs([{artifactId: record.result.artifactId, versionId: record.result.versionId}])))));
}
export const refs = (records) => Object.values(records).filter(r => r.result?.success === true).map(r => ({artifactId: r.result.artifactId, versionId: r.result.versionId}));
export function receipt(value) {
  const artifact = value?.artifact ?? value ?? {};
  const version = artifact.currentVersion ?? artifact.latestVersion ?? value?.version ?? {};
  const artifactId = artifact.artifactId ?? artifact.id;
  const versionId = value?.versionId ?? artifact.currentVersionId ?? artifact.latestVersionId ?? version.versionId ?? version.id;
  if (![artifactId, versionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128)) throw new Error('Invalid artifact receipt');
  return {artifactId, versionId};
}
export class ShareTurn {
  constructor({records, root, excluded, persist, create, sealed = () => false}) {
    Object.assign(this, {records, root, excluded, persist, create, sealed, active: true});
    this.queue = Promise.resolve();
  }
  share(args) {
    const task = this.queue.then(() => this.shareOnce(args));
    this.queue = task.catch(() => {});
    return task;
  }
  async save() { if (await this.persist() === false) throw new Error('Share intent not persisted'); }
  async shareOnce(args) {
    if (!this.active || this.sealed()) return refused('no Room turn');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['path', 'title'].includes(k)) || typeof args.path !== 'string' || !args.path.trim() || ('title' in args && typeof args.title !== 'string')) return refused('invalid_arguments');
    let path, title, mime, data, key;
    try {
      if (!this.root) return refused('outside-share-root');
      const root = await realpath(expand(this.root));
      path = await realpath(resolve(root, expand(args.path)));
      const excludes = await Promise.all(this.excluded.map(async p => { try { return await realpath(expand(p)); } catch { return resolve(expand(p)); } }));
      if (!inside(path, root) || excludes.some(p => inside(path, p))) return refused('outside-share-root');
      title = args.title || basename(path);
      key = createHash('sha256').update(JSON.stringify([path, title])).digest('hex');
      const previous = this.records[key];
      if (previous) { await this.save(); return previous.result ?? refused('upload-uncertain'); }
      if (Object.keys(this.records).length >= 8) return refused('per-turn cap');
      mime = TYPES[extname(path).toLowerCase()];
      if (!mime) return refused('type');
      const before = await stat(path);
      if (!before.isFile() || before.nlink !== 1) return refused('file');
      if (before.size > LIMIT) return refused('size');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        const checked = await realpath(path), current = await stat(checked);
        if (!inside(checked, root) || excludes.some(p => inside(checked, p))) return refused('outside-share-root');
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== opened.dev || current.ino !== opened.ino) return refused('file');
        data = Buffer.alloc(LIMIT + 1);
        let length = 0;
        while (length < data.length) {
          const {bytesRead} = await handle.read(data, length, data.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > LIMIT) return refused('size');
        data = data.subarray(0, length);
      } finally { await handle.close(); }
    } catch { return refused('file'); }
    const record = {state: 'creating'};
    this.records[key] = record;
    try {
      await this.save();
      const value = await this.create(data, basename(path), mime, title);
      record.result = {success: true, name: basename(path), size: data.length, mimeType: mime, ...receipt(value)};
      record.state = 'created';
      await this.save();
      return {...record.result};
    } catch (error) {
      const code = error?.code || error?.refusalCode;
      if (error?.status >= 400 && error.status < 500 && code) {
        record.result = refused(error.status === 413 ? 'size' : error.status === 400 && code === 'invalid_enum' ? 'type' : 'upload');
        record.state = 'refused';
        try { await this.save(); } catch { return refused('upload-uncertain'); }
        return record.result;
      }
      return refused('upload-uncertain');
    }
  }
}
const active = new Map();
export function beginShareTurn(sessionKey, turn) {
  if (!sessionKey || active.has(sessionKey)) throw new Error('Room share run already active or unbound');
  active.set(sessionKey, turn);
}
export function endShareTurn(sessionKey, turn) {
  turn.active = false;
  if (active.get(sessionKey) === turn) active.delete(sessionKey);
}
export function registerRoomShareFileTool(api) {
  if (typeof api?.registerTool !== 'function') return false;
  api.registerTool(ctx => ({name: TOOL_NAME, label: 'Share Room file', description: DESCRIPTION, parameters: PARAMETERS,
    execute: async (_id, params) => {
      const turn = active.get(ctx?.sessionKey);
      const result = turn ? await turn.share(params) : refused('no Room turn');
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
    },
  }), {name: TOOL_NAME});
  return true;
}
