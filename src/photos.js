// P9: verified Room bytes go only to the host media store, never a prompt.
import {createHash} from "node:crypto";
import {discussionDocuments, effectiveGiven, DOCUMENT_CONTEXT_HEADER, DOCUMENT_CONTEXT_FOOTER} from "./documents.js";

export const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const PHOTO_MAX_BYTES = 1_900_000;
export const PHOTO_TURN_BYTES = 6_000_000;
export const PHOTO_TURN_COUNT = 4;

export function sourcePhotos(event, events, cycleSource = null) {
  let source = event?.type === "message.posted" ? event : null;
  const sourceId = event?.payload?.sourceEventId;
  if (sourceId) source = [event, ...(events ?? [])].find((item) => item?.id === sourceId);
  const entries = [cycleSource, source].flatMap((item) => Array.isArray(item?.payload?.attachments)
    ? item.payload.attachments.map((attachment) => ({...attachment, sourceSeq: item.seq || 0})) : []);
  return discussionDocuments({activeTopic: {documents: entries}}) ?? [];
}

export function effectivePhotos(memory, epoch, session) {
  return effectiveGiven(memory && {...memory, given: memory.photos ?? []}, epoch, session);
}

export function safePhotoName(name, mime) {
  const base = String(name || "photo").replaceAll("\\", "/").split("/").at(-1);
  const stem = (base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "photo";
  return stem + ({"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"})[mime];
}

// Lazy SDK loading preserves synchronous plugin loading and text-only hosts.
let mediaStore;
export async function hostImageStore() {
  mediaStore ??= import("openclaw/plugin-sdk/media-store").catch(() => ({}));
  const {saveMediaBuffer} = await mediaStore;
  return typeof saveMediaBuffer === "function"
    ? async (data, mime, name) => (await saveMediaBuffer(data, mime, "inbound", PHOTO_MAX_BYTES, name))?.path
    : null;
}

export async function photoContext(entries, given, membership, artifact, download, store) {
  const photos = entries.map((entry, index) => ({entry, index})).filter(({entry}) => PHOTO_TYPES.has(entry.mimeType));
  photos.sort((a, b) => (b.entry.sourceSeq || 0) - (a.entry.sourceSeq || 0) || a.index - b.index);
  const offered = [], media = [], lines = [];
  let used = 0;
  for (const {entry} of photos) {
    const {artifactId: aid, versionId: vid, mimeType: mime} = entry;
    const key = `${aid}/${vid}`;
    let reason = "";
    if (given.includes(key)) reason = "given earlier in this discussion; reference only";
    else if (!["room_shared", "restricted"].includes(entry.classification)) reason = "sharing";
    else if (Number.isSafeInteger(entry.size) && entry.size > PHOTO_MAX_BYTES) reason = "size cap";
    else if (!Number.isSafeInteger(entry.size) || entry.size < 0) reason = "mismatch";
    else if (media.length >= PHOTO_TURN_COUNT || used + entry.size > PHOTO_TURN_BYTES) reason = "per-turn cap";
    else if (!store) reason = "host has no image path";
    else {
      try {
        const current = await artifact(aid);
        const visibility = current?.visibility;
        const audience = current?.allowedMembershipIds ?? [];
        const manifestAudience = Object.hasOwn(entry, "allowedMembershipIds") ? (entry.allowedMembershipIds ?? []) : audience;
        if (!["room_shared", "restricted"].includes(visibility) || (visibility === "restricted" && !audience.includes(membership))) reason = "sharing";
        else if (entry.classification === "restricted" && !manifestAudience.includes(membership)) reason = "sharing";
        else {
          const {data, contentType} = await download(aid, vid, mime);
          if (data.length > PHOTO_MAX_BYTES) reason = "size cap";
          else if (data.length !== entry.size || createHash("sha256").update(data).digest("hex") !== entry.sha256
            || contentType.split(";", 1)[0].trim().toLowerCase() !== mime) reason = "mismatch";
          else {
            let path;
            try { path = await store(data, mime, safePhotoName(entry.name, mime)); }
            catch { path = null; }
            if (typeof path !== "string" || !path) reason = "host has no image path";
            else {
              media.push({path, contentType: mime, kind: "image"});
              offered.push(key);
              used += data.length;
            }
          }
        }
      } catch (error) { reason = error?.code === "photo_size_cap" ? "size cap" : "fetch error"; }
    }
    const name = String(entry.name || "photo").split(/\s/u).filter(Boolean).join(" ").slice(0, 500);
    lines.push(`Document: ${name} · artifact/version ${aid} / ${vid}\nPhoto given to the model: ${reason ? `no: ${reason}` : "yes"}`);
  }
  return {statuses: lines.join("\n\n"), offered, media};
}

export function appendPhotoContext(context, statuses) {
  if (!statuses) return context;
  if (context.includes(DOCUMENT_CONTEXT_FOOTER)) return context.replace(DOCUMENT_CONTEXT_FOOTER, () => `${statuses}\n\n${DOCUMENT_CONTEXT_FOOTER}`);
  return `${context}${context ? "\n\n" : ""}${DOCUMENT_CONTEXT_HEADER}\n\n${statuses}\n\n${DOCUMENT_CONTEXT_FOOTER}`;
}
