// Contract P15-2/P15-3 (Hermes 1.0.97+, OpenClaw 0.2.80): one participation gate per authenticated membership.
//
// Background Room watchers (event stream, registration/heartbeat, enrollment, activity, document/photo context,
// acknowledgement, attempt maintenance, recovery, credential discovery) opt into waiting while the membership is
// muted, removed or otherwise not active. Model-turn tools and reply/posting calls fail fast with
// RoomMembershipInactiveError. A Room JSON 403 triggers one shared, rate-limited own-roster probe; only roster
// evidence of a non-active own status pauses, and only an active own status reopens. An unread probe, a missing
// own entry or another member's status never reopens a paused gate.
export const PARTICIPATION_RECHECK_MS = 60_000;

export class RoomMembershipInactiveError extends Error {
  constructor(status = "") {
    super(`Room membership is ${status || "inactive"}: participation is paused until the membership is active again`);
    this.name = "RoomMembershipInactiveError";
    this.code = "membership_inactive";
    this.membershipStatus = String(status || "");
  }
}

export class ParticipationGate {
  /**
   * @param {{probe?: (signal?: AbortSignal) => Promise<string>, recheckMs?: number|(() => number), clock?: () => number}} options
   *   probe: the own-membership status from the Room roster ("" when it cannot be read).
   */
  constructor({probe = null, recheckMs = PARTICIPATION_RECHECK_MS, clock = () => Date.now()} = {}) {
    this.probeFn = probe;
    this.recheck = recheckMs;
    this.clock = clock;
    this.state = "unknown";
    this.status = "";
    this.lastProbeAt = 0;
    this.inflight = null;
    this.closed = false;
    this.resume = Promise.withResolvers();
    this.shutdown = Promise.withResolvers();
  }

  get recheckMs() {
    const value = typeof this.recheck === "function" ? this.recheck() : this.recheck;
    return Math.max(1, Math.min(PARTICIPATION_RECHECK_MS, Number(value) || PARTICIPATION_RECHECK_MS));
  }

  get paused() {
    return this.state === "paused";
  }

  /** P15-3: active opens (always, also after a denial); another readable status pauses; unread changes nothing. */
  observe(status) {
    const value = typeof status === "string" ? status.trim() : "";
    if (!value) return this.state;
    // A readable own-roster status is a fresh probe for the recheck cadence.
    this.lastProbeAt = this.clock();
    this.status = value;
    if (value === "active") {
      const wasPaused = this.paused;
      this.state = "open";
      if (wasPaused) {
        const resume = this.resume;
        this.resume = Promise.withResolvers();
        resume.resolve();
      }
    } else {
      this.state = "paused";
    }
    return this.state;
  }

  /** One coalesced own-roster probe, rate-limited to the recheck cadence unless forced. */
  probe({force = false, signal} = {}) {
    if (this.inflight) return this.inflight;
    if (!force && this.lastProbeAt && this.clock() - this.lastProbeAt < this.recheckMs) return Promise.resolve(this.state);
    this.lastProbeAt = this.clock();
    this.inflight = Promise.resolve()
      .then(() => this.probeFn?.(signal))
      .catch(() => "")
      .then((status) => this.observe(status))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** P15-3: a turn offer or attempt-ready probes once at once, even inside the interval; concurrent offers coalesce. */
  probeOffer() {
    return this.probe({force: true});
  }

  /** P15-2: a Room denial probes (rate-limited); true when roster evidence paused participation. */
  async denied(signal) {
    await this.probe({signal});
    return this.paused;
  }

  /** P15-2: turn tools and replies never wait. */
  assertActive() {
    if (this.paused) throw new RoomMembershipInactiveError(this.status);
  }

  /** P15-2/P15-3: a background contact waits while paused, rechecking at most every recheckMs; abort cancels. */
  async waitOpen(signal) {
    while (this.paused) {
      if (this.closed) throw new Error("Room participation stopped");
      signal?.throwIfAborted();
      const waitMs = Math.max(0, this.recheckMs - (this.clock() - this.lastProbeAt));
      await new Promise((resolve, reject) => {
        let timer = null;
        const finish = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        };
        const onAbort = () => finish(signal.reason ?? new Error("aborted"));
        timer = setTimeout(() => finish(), waitMs);
        timer.unref?.();
        signal?.addEventListener("abort", onAbort, {once: true});
        this.resume.promise.then(() => finish());
        this.shutdown.promise.then(() => finish());
      });
      if (this.closed) throw new Error("Room participation stopped");
      if (this.paused) await this.probe({force: true, signal});
    }
  }

  /** Stop: every waiting background contact ends. */
  close() {
    this.closed = true;
    this.shutdown.resolve();
  }
}
