const ROOM_ID_PATTERN = /^[a-z0-9]{15}$/;

export function normalizeRoomTarget(raw) {
  let target = String(raw ?? "").trim();
  for (;;) {
    const stripped = target
      .replace(/^synthetic-sociality-room:/i, "")
      .replace(/^room:/i, "")
      .replace(/^group:/i, "")
      .trim();
    if (stripped === target) return target;
    target = stripped;
  }
}

export function looksLikeRoomId(raw, normalized = undefined) {
  return ROOM_ID_PATTERN.test(normalizeRoomTarget(normalized ?? raw));
}

export function resolveConfiguredRoomTarget(target, state) {
  const roomId = normalizeRoomTarget(target);
  if (!looksLikeRoomId(roomId) || state?.roomId !== roomId) return null;
  return {to: roomId, kind: "group", display: roomId, source: "normalized"};
}
