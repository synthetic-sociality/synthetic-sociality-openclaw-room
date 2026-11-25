// Contract P2c-3h: the one terminal-state set of this connector. Every
// terminal check uses it: the frontier walk and state validation (terminal
// evidence), retention (terminal intents), renewal quiescence and the owner
// control fence (settled intents). No other module keeps its own list.

// Terminal evidence of a source event: the acknowledgement frontier walks over
// these, and nothing else.
export const TERMINAL_EVIDENCE_STATUSES = Object.freeze(["posted", "skipped", "failed", "cancelled", "superseded", "ignored", "stuck"]);
// Receive ledger entries (contract P3-1): read, isolated, or ended in terminal evidence.
export const LEDGER_STATUSES = Object.freeze(["received", "quarantined", ...TERMINAL_EVIDENCE_STATUSES]);
// A delivery intent that is no longer work: terminal, or plainly quarantined
// (an inert journal), unless its lifecycle is still open.
export const SETTLED_INTENT_STATUSES = Object.freeze(["posted", "superseded", "skipped", "quarantined"]);
export const OPEN_LIFECYCLE_STATES = Object.freeze(["pending", "blocked"]);

// Contract P2c-3h: why an event became stuck. The reason grammar is closed:
// stuck:<trigger>:<original code>, the original code being the prior
// lastErrorCode, or the literal none when there is none or it does not fit.
export const STUCK_TRIGGERS = Object.freeze(["epoch_closed", "cycle_terminal", "cycle_superseded", "age", "hole_epoch_closed"]);
const STUCK_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const STUCK_REASON = new RegExp(`^stuck:(${STUCK_TRIGGERS.join("|")}):([A-Za-z0-9_.-]{1,64})$`);

export function isTerminalEvidenceStatus(status) {
  return TERMINAL_EVIDENCE_STATUSES.includes(status);
}

export function stuckReason(trigger, code) {
  if (!STUCK_TRIGGERS.includes(trigger)) throw new Error(`stuck trigger must be one of ${STUCK_TRIGGERS.join(", ")}`);
  const text = String(code ?? "");
  return `stuck:${trigger}:${STUCK_CODE.test(text) ? text : "none"}`;
}

export function parseStuckReason(reason) {
  const match = STUCK_REASON.exec(String(reason ?? ""));
  return match ? {trigger: match[1], code: match[2]} : null;
}

export function isQuarantinedIntent(intent) {
  return intent?.status === "quarantined"
    && (intent.deliveryState === "quarantined" || (intent.version === 1 && intent.deliveryState === undefined));
}

// Posted with its lifecycle done, superseded or skipped (contract P3-2). A
// stuck event's intent stays quarantined, so retention never prunes it.
export function isTerminalIntent(intent) {
  if (!intent || typeof intent !== "object" || isQuarantinedIntent(intent)) return false;
  if (intent.deliveryState === "posted" && ["complete", "not_required"].includes(intent.lifecycleState)
    && ["posted", undefined].includes(intent.status)) return true;
  return ["superseded", "skipped"].includes(intent.deliveryState) && [intent.deliveryState, undefined].includes(intent.status);
}

// Renewal quiescence and the owner control fence (P17-3).
export function intentSettled(intent) {
  return SETTLED_INTENT_STATUSES.includes(intent?.status) && !OPEN_LIFECYCLE_STATES.includes(intent?.lifecycleState);
}
