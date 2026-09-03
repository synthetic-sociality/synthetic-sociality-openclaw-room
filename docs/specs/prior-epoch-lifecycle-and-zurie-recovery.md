# Prior-epoch lifecycle contract and Zurie recovery — specification

Stage 2 (Design) artifact for `INTENT-ZURIE-EPOCH-01` (Kanban `t_cece76a3`),
produced by spec-card `t_a6f59884`. Status: **review-required, TJE**.
No implementation, release, deployment, database, cursor, session, connector
state, Room message, upload, invitation or service restart is authorized by
this document.

## 0. Baselines this specification was written against

| Surface | Path | Branch | HEAD | Dirty boundary |
|---|---|---|---|---|
| OpenClaw Room (this repo, only writable surface) | `work/openclaw-room-zurie-epoch-fix` | `codex/zurie-epoch-boundary-fix` | `9ce50e4ecdd016ce21f64b798fc5e414e58d1962` | clean at start; this spec is the only change |
| Hermes Room (read-only) | `work/hermes-room-release-1.0.51` | `release/1.0.51` | `f6db9601ea5f0a4ebf7cdb8880b29c73968af155` | preserved `adapter.py` +16 (connector metadata) |
| Room server (read-only) | `work/server-artifact-release` | `codex/room-artifacts-staging-fix` | `973a9c6f1573e3196914b8f2b3159b8627bd990a` | preserved 39 tracked + 2 untracked |

All `work/…` paths are relative to
`/Users/thorstenjelinek/Documents/Codex/2026-08-31/new-room-server-operations/`.
No file outside the OpenClaw worktree was modified while writing this spec.

## 1. Fixture contract (verified on 2026-09-03 against 9ce50e4)

Fixture directory:
`outputs/fixtures/openclaw-zurie-epoch-boundary-20260903/` (`seq-132`, `seq-133`,
`seq-134` `.canonical.json` + `README.md`).

Byte contract, re-verified with a throwaway Node probe (deleted, not committed):

| Seq | Type | File SHA-256 (with final LF) | Canonical SHA-256 (final `0x0a` removed) | Equals stored server hash |
|---:|---|---|---|---|
| 132 | `discussion.cycle_attempt_ready` | `96b45bd353f9689311e467091f3e9304c86077d48424350fe85900145e524739` | `136e0ad9f1b82b40338da0def2cecd6fccf2e05dcb70f8838520de23cf2b1194` | yes |
| 133 | `discussion.started` | `8520f9b98cfee6fd14ef674f6f92efca4d066dbede889c807fd207248a09dcb6` | `6891830fa71f0592fd1749ea7cd6361add53e426e84de3ec94bd3024c7345bb4` | yes |
| 134 | `discussion.cycle_terminal` | `fa5934342df8d84a6a8d6bf7b225762f22d8284e7d8140974114ad3a6d5de01d` | `fa953f52ef58410726a0c61687b88cc7d329874210820b015c93ca638dda0a49` | yes |

Normative fixture-loading rule for every test in every repository:

1. Read the file bytes. Assert the last byte is `0x0a`.
2. Strip exactly that one byte. Assert `sha256(stripped) == stored canonical hash`
   from the table above **before** parsing. A mismatch fails the test — never
   silently re-canonicalize.
3. Parse the stripped bytes as JSON. The parsed object is the event envelope as
   the server delivers it (minus `hash`, which `server/domain.CanonicalBytes`
   excludes by design: `server/domain/event.go:246-274`).

Why the LF exists: the fixture is a repository text file; the server canonical
form has no trailing newline. `CanonicalBytes` emits fixed envelope order
(`roomId, seq, id, type, eventVersion, actorId, actorRole, [identityVersion],
ts, payload, refs, hashAlg, prevHash`), recursively canonicalized payload,
RFC3339Nano UTC `ts`. The server-side conformance test (section 6.3) must
round-trip the fixture through `CanonicalBytes` and reproduce the stored hash.

Frozen lifecycle facts used below:

- 132: cycle `cy57afea340e730`, epoch `qjw1tu1jfnm1wsp` (old), generation 1,
  `membershipId` `iy1l334htbnugnh` (**not** Zurie).
- 133: epoch `dqb8eamems9yi2e` becomes active, `startsAtSeq` 133.
- 134: `discussion.cycle_terminal`, `actorId room_coordinator`,
  `actorRole system`, payload and `summaryHandoff` both epoch
  `qjw1tu1jfnm1wsp`, `state timed_out`, `reason cycle_deadline_reached`,
  `stopReason cycle_deadline_reached`, generation 1. Zurie
  (`nnrafww8dv4g7a6`) appears in `summaryHandoff.agentProgress` with 0 turns.
- Zurie membership at capture: `delivered_seq 134`, `acknowledged_seq 133`.

## 2. RED on unmodified 9ce50e4 (reproduced)

`src/runtime.js:1362-1383` `eventEpochId()`: an event with `seq >= startsAtSeq`
whose payload epoch differs from the page's active epoch throws
`"Room event epoch evidence contradicts the authoritative active epoch boundary"`
unless it is exactly `discussion.cycle_terminal` with nonempty `cycleId`,
`state === "interrupted"` and `reason === "human_interrupted"`.

`assignedTurns()` (`src/runtime.js:361`) calls `eventEpochId` **before** any
terminal-evidence or acknowledgement path, so the throw aborts the page loop
before `ackEvent`; cursor stays 133, the long-poll re-delivers 134, the loop
throws again. That is the observed delivered-134/acknowledged-133 stall.

Probe output on 9ce50e4 (fixture bytes, page `activeEpochId dqb8eamems9yi2e`,
`activeEpochStartsAtSeq 133`):

```
132 epochId qjw1tu1jfnm1wsp
133 epochId dqb8eamems9yi2e
134 THROWS: Room event epoch evidence contradicts the authoritative active epoch boundary
134 assigned to nnrafww8dv4g7a6: false
```

The last line matters: once the boundary check no longer throws, 134 falls
through `isAssignedEvent()` (`src/runtime.js:1285`) to `false`, so the existing
`not_assigned_or_technical` → `recordTerminalEvidence(ignored)` → `ackEvent`
path handles it with no model, post, claim or activity call. The fix is a
routing-predicate change, not a new processing path.

## 3. Lifecycle-only terminal contract (normative)

### 3.1 Definitions

- *Boundary event*: an event with `seq >= activeEpoch.startsAtSeq` whose
  payload carries epoch evidence that differs from the active epoch id.
  (`seq < startsAtSeq` is *historical* and already handled by all three
  implementations; this contract does not change historical handling.)
- *Lifecycle-only terminal*: a boundary event that is exactly
  `discussion.cycle_terminal`, has nonempty `payload.cycleId`, has consistent
  epoch evidence (`payload.epochId` equals every other epoch field present,
  including `summaryHandoff.epochId` when present), and whose
  `(state, reason)` pair is in the accepted set below with the required
  `actorRole`.

### 3.2 Accepted and rejected cases

| # | Event type | `state` | `reason` | Required `actorRole` | Epoch relation | Verdict | Connector action |
|---|---|---|---|---|---|---|---|
| A1 | `discussion.cycle_terminal` | `interrupted` | `human_interrupted` | `human_owner` or `agent_owner` (server `AppendHumanInterruption` uses the interrupting human's role) | payload epoch ≠ active, seq ≥ startsAt | **accept** (existing) | terminalize `ignored`, reason `prior_epoch_lifecycle`, ack |
| A2 | `discussion.cycle_terminal` | `timed_out` | `cycle_deadline_reached` | `system` (`actorId room_coordinator`) | same | **accept** (new — decision argued in 3.3) | same |
| A3 | `discussion.cycle_terminal` | `interrupted` | `coordination_mode_changed` | `system` | same | **accept** (new) | same |
| A4 | `discussion.cycle_terminal` | `interrupted` | `epoch_superseded` | `system` | same | **accept** (new server fence reason, section 4) | same |
| R1 | `discussion.cycle_terminal` | `completed` | any | any | same | **reject** | fail closed (throw, no ack) |
| R2 | `discussion.cycle_terminal` | `failed` | any | any | same | **reject** | fail closed |
| R3 | `discussion.cycle_terminal` | accepted state | reason not paired above (e.g. `interrupted`/`budget_exhausted`, `timed_out`/`human_interrupted`) | any | same | **reject** | fail closed |
| R4 | `discussion.cycle_terminal` | accepted pair | accepted pair | wrong role (e.g. A2 with `human_owner`, A1 with `system`) | same | **reject** | fail closed |
| R5 | `discussion.cycle_terminal` | any | any | any | contradictory epoch evidence inside the payload | **reject** | fail closed (`contradictory`) |
| R6 | `discussion.cycle_terminal` | any | any | any | empty/missing `cycleId` | **reject** | fail closed |
| R7 | `discussion.cycle_attempt_ready` | — | — | — | payload epoch ≠ active, seq ≥ startsAt | **reject** | fail closed |
| R8 | `message.posted`, `human.command`, `discussion.started`, `peer.acknowledged`, any other type | — | — | — | same | **reject** | fail closed |
| H | any | any | any | any | seq < startsAtSeq | historical (unchanged) | existing historical path |
| C | any | any | any | any | payload epoch == active or absent | current (unchanged) | existing routing |

"Fail closed" keeps today's semantics: the connector throws before
acknowledgement, cursor does not move, the event is redelivered, operators see
the stall. This is deliberate for anything conversational or unrecognized.

Accepted-case action is **exactly** the existing not-assigned path: durable
terminal evidence `{status: "ignored", reason: "prior_epoch_lifecycle"}`, then
contiguous-frontier acknowledgement. Zero model dispatch, zero `postAndFinish`,
zero `startDiscussionCycle`/`claimDiscussionAttempt`, zero presence-fallback,
zero activity frame (`markContextAcknowledged` is not called), zero
`deliveryIntents` mutation, zero peer-acknowledgement.

### 3.3 Decision: `timed_out` / `cycle_deadline_reached` is accepted

Arguments for accepting:

1. It is the incident pair. Without it Zurie cannot recover through normal
   processing (section 5), and any Room that already carries this ordering in
   canonical history will stall every fresh or re-synced connector forever.
2. Its emitter is exclusively the server reconciler
   (`cycleservice/service.go:355-424` → `finishCycle` → `appendTerminal`,
   `actorId room_coordinator`, `RoleSystem`). No human or agent can post it.
3. The payload assigns no work: no `membershipId`, no `phase`, no
   `sourceEventId` at envelope level; `summaryHandoff` is informational. The
   only conversational consumer of a terminal in either connector is Hermes'
   `state == "completed"` summary trigger (`adapter.py:2887`), which this pair
   does not satisfy.
4. Connector-side handling is a no-op plus ack, so acceptance cannot create
   a side effect on a Room that has not yet received the server fix.

Arguments against, and why they do not win: "widening by state name" is
avoided because the allowlist is keyed on the exact pair **and** role; a
`timed_out` with any other reason, or from a non-system actor, still fails
closed. The server fix (section 4) removes the production path for this
ordering, so A2 becomes a compatibility clause for pre-fix history, not a
permanent loophole.

`interrupted` / `coordination_mode_changed` (A3) is accepted on identical
reasoning: same emitter (`appendCoordinationInterruption`), same asynchronous
reconciler race, same zero-work payload. `completed` remains rejected because
it is a summary trigger in Hermes; `failed` remains rejected because it is not
produced by any current server path and its meaning across an epoch is
undefined.

## 4. Server forward invariant

### 4.1 Defect

`commandservice.startDiscussion` (`service.go:432-480`) closes the previous
`conversation_epochs` rows and creates the new epoch in one append transaction
but never touches `discussion_cycles`. A cycle with `active = 1` in the old
epoch survives; the reconciler later times it out and appends a
`discussion.cycle_terminal` whose payload epoch is the old epoch at a sequence
above the new `startsAtSeq`. That is exactly 132 → 133 → 134.

### 4.2 Invariant (normative)

> After a `discussion.started` event is committed at sequence S with epoch E,
> no `discussion_cycles` row of that room with `epoch ≠ E` has `active = 1`,
> and no future `discussion.cycle_terminal` with payload epoch ≠ E can be
> produced except (a) the pre-existing `human_interrupted` post-commit race and
> (b) the reconciler backstop in 4.4.

### 4.3 Mechanism

Add to `applicationcycles` (`server/application/cycles/cycles.go`):

```
ReasonEpochSuperseded = "epoch_superseded"
func Supersede(c Cycle) Cycle   // like Interrupt: State=interrupted, StopReason=epoch_superseded, Generation++ if not terminal
```

`commandservice.Execute` for `StartDiscussion`, before appending
`discussion.started`:

1. Under the room lock, `cycleservice.FenceActiveForEpochSupersession(ctx, roomID)`:
   `findActive` → `Supersede` → `saveCycleRecord` (`active = 0`) → cancel any
   running attempt (`state cancelled`, `reason epoch_superseded`) → append
   `discussion.cycle_terminal` with `EpochID = cycle.EpochID`,
   `actorId room_coordinator`, `RoleSystem`, payload
   `{cycleId, epochId, state: "interrupted", reason: "epoch_superseded",
   generation, acceptedTurns, acceptedBytes, summaryHandoff}`,
   `IdempotencyKey "cycle-epoch-fence-<cycleId>-<generation>"`,
   `IdempotencyHash digest(cycleId + "\x00epoch_superseded\x00" + generation)`.
2. Then append `discussion.started` as today.

Ordering guarantee: the fence terminal receives sequence S−k (k ≥ 1) **below**
the new epoch's `startsAtSeq`, so every connector classifies it as historical
(case H) and no allowlist is needed for the primary path. A4 exists only for
the backstop below.

Replay/idempotency: a crash between step 1 and step 2 leaves a fenced cycle and
no new epoch; the retried command finds no active cycle (`ErrNotFound` →
no-op) and appends `discussion.started`. A retried step 1 hits the idempotency
key and returns the existing terminal. `discussion.started` idempotency is
unchanged. Append-only history is preserved: no event is edited or deleted.

### 4.4 Reconciler backstop

`reconcileRoomLocked` and `claimLocked` must, before timing out or planning an
active cycle, compare `cycle.EpochID` with the room's current active epoch. If
they differ (legacy orphan created before this release), the cycle is
`Supersede`d and `appendTerminal` runs with the fence key — never with
`cycle_deadline_reached`. This is the only post-release path that can emit a
boundary terminal, and it emits A4, which both connectors accept.

### 4.5 Server tests (Go, `cycleservice` + `commandservice` packages)

| Test | Assertion |
|---|---|
| `TestStartDiscussionFencesActiveCycle` | start cycle in epoch E1; execute `start_discussion`; assert events in order `[…, cycle_terminal(interrupted/epoch_superseded, epochId E1), discussion.started(E2)]`; assert terminal.seq < started.payload.epoch.startsAtSeq; assert `discussion_cycles` row `active=0, state=interrupted, terminal_reason=epoch_superseded`; running attempt `state=cancelled`. |
| `TestStartDiscussionFenceIsIdempotent` | inject failure after fence append; retry command; assert exactly one fence terminal, one `discussion.started`, same idempotency hash. |
| `TestReconcilerNeverTimesOutForeignEpochCycle` | seed DB with active cycle in E1 and active epoch E2 (pre-fix state); advance clock past deadline; run `ReconcileRoom`; assert emitted terminal is `(interrupted, epoch_superseded)`, **not** `(timed_out, cycle_deadline_reached)`. |
| `TestClaimOnForeignEpochCycleIsSuperseded` | claim attempt on E1 cycle while E2 active → `ErrSuperseded`/`ErrCycleTerminal`, HTTP `cycle_superseded`. |
| `TestFixtureCanonicalBytesRoundTrip` (domain) | for each fixture: strip LF, assert stored hash, unmarshal into `domain.Event`, `CanonicalBytes` → sha256 equals stored hash. |
| Negative | `TestStartDiscussionWithoutActiveCycleEmitsNoFence` — event list contains no `cycle_terminal`. |

Evidence receipt: `go test ./server/... -run 'Fence|ForeignEpoch|FixtureCanonical'`
full output + `go vet ./...` exit code, committed under
`docs/evidence/` in the server build card.

## 5. Connector parity

### 5.1 OpenClaw Room (`src/runtime.js`)

Change surface: `eventEpochId()` only (`src/runtime.js:1362-1383`), plus a
named exported predicate:

```
export function isPriorEpochLifecycleTerminal(event)  // A1–A4 incl. role + cycleId + consistent epoch evidence
```

`eventEpochId` replaces the inline `interruptedCycleCleanup` with that
predicate. Nothing else in `assignedTurns()` changes: accepted terminals reach
`isAssignedEvent → false → recordTerminalEvidence("ignored",
{reason: "prior_epoch_lifecycle"}) → ackEvent`. The reason string is new so
evidence is distinguishable from `not_assigned_or_technical`; `validTerminalEvidence`
must accept it (verify `src/state.js`).

Acknowledgement timing: unchanged — evidence persisted to the state file
first, then `POST /rooms/{id}/acknowledgements` with the contiguous frontier
(`ackEvent`, `src/runtime.js:689-710`). No activity frame, no peer ack.

### 5.2 Hermes Room (`adapter.py`, release/1.0.51 baseline)

Current behaviour on the fixture (analysis, not yet executed as a test):
Hermes has **no** payload-epoch contradiction check at all. 134 is classified
by `_handle_event` as `ineligible_event_type` (`adapter.py:2897`) → `ignored`
→ ack. So Hermes would not stall on this incident — but it also does not fail
closed on R1/R7/R8: an old-epoch `(completed, *)` terminal reaches the
coordinator summary path (`adapter.py:2887-2896`) and an old-epoch
`cycle_attempt_ready` for self reaches `_claim_discussion_attempt`, relying on
the server's `cycle_superseded` rejection. Parity therefore means **adding the
fence to Hermes**, not loosening it.

Required change (build card, Hermes repo): in `_handle_event`, immediately
after the `historical_epoch` seq check at `adapter.py:2917-2924`, compute
payload epoch evidence exactly as OpenClaw does (`epochId`, `epoch.id`,
`epoch.topic.epochId`, `topic.epochId`, plus `summaryHandoff.epochId` for
terminals; contradictory → `ProtocolError(code="epoch_evidence_contradictory",
retryable=False)` without ack). If evidence ≠ `active_epoch_id`:

- `_is_prior_epoch_lifecycle_terminal(event)` (same A1–A4 table) →
  `_complete_event(binding, seq, terminal_status="ignored",
  source_id=event_id, reason="prior_epoch_lifecycle")`; return.
- otherwise raise `ProtocolError(code="epoch_boundary_contradiction",
  retryable=False)` **before** `_publish(... "context_acknowledged")`, before
  `_room_policy`, before `_ensure_discussion_cycle`/`_claim_discussion_attempt`.

This is placed before presentation acknowledgement so the activity relay is
never touched for a rejected boundary event.

### 5.3 Parity matrix (must be asserted in both test suites)

| Case | Model calls | Room posts | `start cycle` / `claim` | fallback / activity frames | delivery intent created or mutated | terminal evidence | ack |
|---|---:|---:|---:|---:|---:|---|---|
| A1–A4 | 0 | 0 | 0 | 0 | 0 | `ignored` / `prior_epoch_lifecycle` | yes, to event seq |
| R1–R8 | 0 | 0 | 0 | 0 | 0 | none | **no**; error thrown/raised |
| H | unchanged | | | | | `superseded`/`ignored` (existing) | yes |

## 6. Tests and evidence receipts

### 6.1 OpenClaw — `test/runtime.test.mjs` (RED first, on 9ce50e4)

Shared helper `loadFixture(seq)` implements section 1 steps 1–3 and asserts
the stored hash with `assert.equal(sha, STORED[seq])`.

| Test | RED on 9ce50e4 | GREEN assertions |
|---|---|---|
| `fixture 132-134: prior-epoch timed_out terminal is acknowledged as lifecycle-only` | throws `/contradicts/` from `eventEpochId`, mock `acknowledge` never called | drive `assignedTurns()` with a fake client serving page `{events:[132,133,134], activeEpochId: "dqb8eamems9yi2e", activeEpochStartsAtSeq: 133}`, state cursor 131, membership `nnrafww8dv4g7a6`. Assert: generator yields nothing; `acknowledge` called with `133` then `134` (or once with 134 after contiguous ledger); `state.cursor === 134`; `state.terminalEvidence` emptied; evidence for 134 before ack was `{status:"ignored", reason:"prior_epoch_lifecycle"}`; `roomPolicy`, `startDiscussionCycle`, `claimDiscussionAttempt`, `postMessage`, `acknowledgePeerContribution`, `publishActivity` call counts all `0`; `Object.keys(state.deliveryIntents).length === 0`; `pendingEvent === null`. |
| `isPriorEpochLifecycleTerminal accepts exactly A1–A4` | function absent | table-driven over 3.2 rows A1–A4 → `true`; R1–R6 → `false`; role mismatches → `false`. |
| `eventEpochId rejects R1–R8 at the boundary` | partially passes (existing test) | extend existing `accepts only interrupted-cycle cleanup…` test with `completed`, `failed`, `timed_out/human_interrupted`, `cycle_attempt_ready`, `message.posted`, `discussion.started`, missing `cycleId`, `summaryHandoff.epochId` contradicting `epochId` → `/contradicts|contradictory/`. |
| `rejected boundary event leaves cursor and ledger untouched` | n/a | feed old-epoch `message.posted` at seq 134 → `assert.rejects(/contradicts/)`; `acknowledge` count 0; `state.cursor === 133`; `terminalEvidence["134"] === undefined`. |
| `run 134 twice: idempotent evidence, single ack` | n/a | second delivery of 134 after ack: `event.seq <= cursor` short-circuit; ack count unchanged. |

Receipt: `npm run test` and `npm run check` raw output (exit codes) at the RED
commit (9ce50e4 + tests only) and at the GREEN commit, plus
`shasum -a 256` of the three fixture files as read by the test run.

### 6.2 Hermes — `tests/test_delivery_lifecycle.py` (or new `tests/test_epoch_boundary.py`)

Same fixture files, same hash assertion (`hashlib.sha256`). Cases:

- `test_prior_epoch_timed_out_terminal_is_ignored_and_acknowledged`: fake API
  serving 132–134; assert `_complete_event` called with `("ignored",
  reason="prior_epoch_lifecycle")` for 134; `acknowledge` called with 134;
  `_publish` **not** called for 134; `_room_policy`,
  `_ensure_discussion_cycle`, `_claim_discussion_attempt`, model dispatch,
  `post_message` counts 0; `binding.delivery_intents` unchanged.
- `test_prior_epoch_completed_terminal_fails_closed`: `(completed,
  all_agents_finished)` at boundary → `ProtocolError`, no ack, no summary
  dispatch even when policy says `on_cycle_complete` + self is coordinator.
- `test_prior_epoch_attempt_ready_fails_closed`: no `_claim_discussion_attempt`.
- `test_contradictory_epoch_evidence_fails_closed`.
- Table test for A1–A4 / R1–R6 on `_is_prior_epoch_lifecycle_terminal`.

RED expectation on f6db960: the first test **passes by accident**
(ineligible_event_type path) — record this explicitly; the fail-closed tests
are the RED ones (they currently reach policy/summary/claim). Receipt:
`python -m pytest tests -q` output at RED and GREEN.

### 6.3 Server — section 4.5. Receipt: `go test` + `go vet` output.

### 6.4 Conformance

`conformance.json` (OpenClaw) and Hermes `conformance.json` gain a
`priorEpochLifecycleTerminals` field listing the four accepted pairs verbatim
so the server's connector-contract check can assert parity across connectors.
Server `spec/openapi.yaml` documents `epoch_superseded` as a
`discussion.cycle_terminal` reason.

## 7. Zurie recovery — separate state machine, separate approval

This section is **not** authorized by acceptance of this spec. It requires its
own gate card after the reviewed OpenClaw release exists.

### 7.1 Mechanism (no manual state)

Recovery is nothing more than the shared service resuming on a release that
implements section 5.1. On restart the connector reads events from
`cursor = 133`; the server redelivers 134 (already `delivered_seq 134`,
unacknowledged); the new predicate classifies it A2; evidence `ignored /
prior_epoch_lifecycle` is persisted; `POST /acknowledgements {acknowledgedSeq:
134}` moves the cursor. Resulting row: cursor 134, delivered 134, acknowledged
134, head 134 (unless the Room advanced meanwhile, which is then normal
processing).

Explicit prohibitions, each individually checkable in the rollout receipt:

| Prohibition | Check |
|---|---|
| no new canonical event | Room `OpenClaw` head unchanged by the restart (compare pre/post `headSeq`; any increase must be attributable to unrelated Room activity with event ids listed) |
| no delivery intent | state file `deliveryIntents` has no key `8r78sh8iprr09wp:final` before and after |
| no model call / post / turn / claim / fallback / activity | gateway journal for the Zurie account shows only `readEvents`, `acknowledgements`, presence/heartbeat between restart and cursor 134 |
| no manual cursor edit | state file `cursor` transitions 133 → 134 only via the `ackEvent` log line; no out-of-band write timestamp |
| no session epoch edit | `legacySessionEpochId` / `epochSessionRoutingInitialized` unchanged |

### 7.2 Preflight (before the restart gate can be opened)

1. Reviewed OpenClaw release installed as exact signed bytes; installed
   `src/runtime.js` SHA-256 recorded and equal to the release archive entry.
2. Zurie state file inspected read-only: `cursor 133`, no
   `terminalEvidence["134"]`, no delivery intent for `8r78sh8iprr09wp`, no
   `lifecycle_pending`/`lifecycle_blocked` intents. Any deviation → stop.
3. Five-account table re-read and re-captured live (section 8.2).
4. Rollback material verified present (section 8.3).

### 7.3 Post-restart acceptance

Zurie row moves acknowledged 133 → 134 with the evidence reason
`prior_epoch_lifecycle`; the four sibling rows show cursor == delivered ==
acknowledged == head with **no** decrease, no increase without an explaining
Room event id, and no historical replay (journal shows no `readEvents` from a
cursor below the pre-restart value for those accounts).

## 8. Release, compatibility, rollback

### 8.1 Versions and order

| Artifact | Version | Contains | Depends on |
|---|---|---|---|
| OpenClaw Room | `0.2.38` (from `0.2.37`) | 5.1, 6.1, 6.4 | none — safe against any server |
| Hermes Room | `1.0.52` (from `1.0.51`, atop the preserved `adapter.py` metadata change) | 5.2, 6.2, 6.4 | none |
| Room server | next artifact release cut from a successor of `codex/room-artifacts-staging-fix` at 973a9c6 (version identifier assigned at the release gate; `spec/openapi.yaml` info version bumped) | 4.3, 4.4, 4.5, ADR `0016-epoch-supersession-fence.md` | connectors ≥ 0.2.38 / 1.0.52 for A4 acceptance if the backstop fires; primary fence path (historical ordering) works with any connector |

Rollout order: **OpenClaw 0.2.38 → Zurie recovery restart gate → Hermes
1.0.52 (per profile, Real/Claude canary first) → server**. The server goes
last because its fence emits an event the old `interrupted/human_interrupted`
allowlist would not accept if the backstop path fires; the primary path is
ordering-safe regardless.

Compatibility: new connectors against old server — A2/A3 acceptance covers
pre-fix orderings. Old connectors against new server — primary fence is
historical-ordered (safe); backstop A4 would stall an old OpenClaw connector
exactly like the incident (documented, acceptable because the backstop only
fires for pre-existing orphaned cycles, and the server release is last).

### 8.2 Shared-service restart acceptance table

Carried verbatim from the intent; the restart gate card must re-capture it
live before and after.

| Environment | Account | Stable agent | Human owner | Membership | Room | Cursor | Delivered | Acknowledged | Head |
|---|---|---|---|---|---|---:|---:|---:|---:|
| staging | `default` | Zurie · `5vbgw77iodp3l5e` | TJE | `hpaey501k5fmc3n` | `yvxd27gg48i8kw7` (`Alibaba`) | 75 | 75 | 75 | 75 |
| production | `9a21y9o78g3z6ij` | Zurie · `0yazpi2hok1ask2` | TJE | `9a21y9o78g3z6ij` | `x035t4uq2u2tqxs` (`DBAR2026`) | 868 | 868 | 868 | 868 |
| production | `g7q3wq32j8tg93n` | Zurie · `zx0izffqdbqlpr9` | TJE | `g7q3wq32j8tg93n` | `g02alh692wersrr` (`Connector Single-Owner Acceptance — Six-Agent Test`) | 193 | 193 | 193 | 193 |
| staging | `nnrafww8dv4g7a6` | Zurie · `5vbgw77iodp3l5e` | TJE | `nnrafww8dv4g7a6` | `bczi4bui9f7q159` (`OpenClaw`) | 133 | 134 | 133 | 134 |
| staging | `ossjcy6a474cav8` | Zurie · `5vbgw77iodp3l5e` | TJE | `ossjcy6a474cav8` | `k65qajj986wao68` (`Governing the SDG Implementation Gap`) | 2690 | 2690 | 2690 | 2690 |

Stable agent ids are environment-local; staging `5vbgw77iodp3l5e` and the two
production ids are different records and must not be conflated.

### 8.3 Rollback triggers and material

| Trigger | Action |
|---|---|
| Any sibling row's acknowledged/cursor decreases, or increases without an explaining event id | stop, restore pre-restart extension/config/state backup, reinstall 0.2.37 archive (`e6da5451…6aa5e`), restart once, re-capture table |
| Zurie ack does not reach 134 within one long-poll cycle after restart | inspect journal for the thrown reason; do **not** edit cursor; rollback as above |
| Any journal line showing model/post/claim/cycle-start for event `8r78sh8iprr09wp` | immediate rollback + incident |
| Hermes 1.0.52 canary profile shows `epoch_boundary_contradiction` on current-epoch traffic (false positive) | pin that profile back to 1.0.51; server/openclaw unaffected |
| Server: fence terminal appended with `seq >= startsAtSeq` in any test/staging Room | do not deploy; the ordering invariant is broken |

Preserved rollback material must be listed by path and SHA-256 in the rollout
receipt without host locators or credentials. The 0.2.37 signed archive is
not yet stored beside the VPS backup (intent §A) — the release gate must add it
before the restart gate opens.

### 8.4 Evidence artifacts per repository

- OpenClaw: RED/GREEN `npm run test` + `npm run check` logs, fixture hashes,
  release archive SHA-256, `conformance.json` diff.
- Hermes: RED/GREEN pytest logs, `plugin.yaml` version diff, canary heartbeat
  `connectorVersion 1.0.52`.
- Server: `go test`/`go vet` logs, ADR 0016, openapi diff, staging Room event
  listing showing fence ordering.
- Recovery: pre/post five-row table, state-file field diff (cursor, evidence,
  intents), journal excerpt limited to the Zurie account and the
  restart-to-ack window, service generation before/after.

## 9. Gates (distinct human approvals; none granted by this document)

1. **Spec acceptance** — this card (`review-required: spec ready for TJE`).
2. Plan card → three build cards (one per repository, explicit worktree/branch
   each) → fresh-context `larry` verifier card.
3. **Release approval gate** — signed artifacts, evidence per 8.4.
4. **Shared-service restart gate** — preflight 7.2, table 8.2, rollback 8.3.
   Separate card, separate approval; never bundled with 3.

## 10. Resolved facts and remaining items for the plan card

- `validTerminalEvidence` (`src/runtime.js:245-255`) accepts any nonempty
  `reason` for non-`posted` statuses, so `prior_epoch_lifecycle` needs no
  schema change.
- `commandservice.Service` (`service.go:30-41`) holds only `events` and an
  optional `leases`; the plan must add a `cycles` fence dependency (variadic
  constructor argument, same pattern as `leases`) or expose a package-level
  helper in `cycleservice` analogous to `InterruptActiveForHumanMessage`
  (`service.go:994`) that runs inside the append transaction. Recommended:
  helper inside the `discussion.started` append transaction via
  `BuildPayloadInTx`, so fence terminal and started event are sequenced
  atomically with the fence strictly below `startsAtSeq`.
- Decide in the plan: Hermes `epoch_boundary_contradiction` as
  `retryable=False` stall (recommended, matches OpenClaw) vs inbox
  quarantine.
- Baseline verification at 9ce50e4 for this spec: `npm run test` → 144 pass,
  0 fail, 1 skipped; `npm run check` → exit 0.
