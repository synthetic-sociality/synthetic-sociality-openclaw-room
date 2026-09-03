# Prior-epoch lifecycle contract and Zurie recovery — specification

Stage 2 (Design) artifact for `INTENT-ZURIE-EPOCH-01` (Kanban `t_cece76a3`),
produced by spec-card `t_a6f59884`, revised by `t_54739cdb`
(SPEC-REVISION-ZURIE-EPOCH-01: fence discovery moved inside the append
transaction; R5 contract made exact). Status: **review-required, TJE**.
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
through `isAssignedEvent()` (`src/runtime.js:1285`) to `false`. The fix adds
one explicit routing branch for lifecycle-only boundary terminals (section
5.1) that records its own evidence reason before the existing
`not_assigned_or_technical` branch; it reuses the existing
`recordTerminalEvidence(ignored)` → `ackEvent` mechanics and adds no
processing path with side effects.

### 2.1 Exact baseline `assignedTurns()` trace (cursor 131, fixtures 132–134)

Executed on unmodified 9ce50e4 with a throwaway driver (deleted, not
committed): full `version: 1` state in a temp state file, membership
`nnrafww8dv4g7a6`, `cursor 131`, page `{activeEpochId "dqb8eamems9yi2e",
activeEpochStartsAtSeq 133, events [132, 133, 134]}`, `maintainPresence` and
`markContextAcknowledged` stubbed as counters, every client method except
`readEvents`/`acknowledge` stubbed as a counter:

```
acks               [132, 133]
evidence (in order) 132 superseded / historical_epoch (sourceEpochId qjw1tu1jfnm1wsp)
                    133 ignored    / not_assigned_or_technical
error              "Room event epoch evidence contradicts the authoritative active epoch boundary"  (at 134, from eventEpochId)
state.cursor       133
state.terminalEvidence {}          (ledger drained by the 133 ack)
pendingEvent       null
call counts        {}              (markContextAcknowledged, roomPolicy, startDiscussionCycle,
                                    claimDiscussionAttempt, postMessage, publishActivity,
                                    acknowledgePeerContribution: all 0)
deliveryIntents    {}
```

Each event is acknowledged individually because `ackEvent` runs per event and
the contiguous frontier advances by exactly one each time. This trace is the
RED oracle for 6.1 and reproduces the captured membership state
(`acknowledged_seq 133`, `delivered_seq 134`).

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

### 4.3 Mechanism — one atomic chain append

Ground truth that constrains the design (`server/infrastructure/pocketbase/eventstore/store.go:85-216`):
`Store.Append` takes the room mutex, opens **one** `RunInTransaction`,
allocates exactly one sequence via `UPDATE rooms SET head_seq = head_seq + 1
… RETURNING head_seq`, then calls `BuildPayloadInTx(tx, seq)`, seals, inserts,
and runs the projection. A nested `Append` from inside `BuildPayloadInTx`
would allocate `seq + 1` for the fence, i.e. **above** `startsAtSeq` — the
exact defect shape. Therefore the fence cannot be produced inside the
`discussion.started` append; the eventstore must gain a batch primitive.

There is also no valid *external* preflight: any active-cycle lookup executed
outside the append transaction (under only the command idempotency lock) has
a no-active-cycle race — a cycle can become active between the lookup and
the one-link start chain's commit, and the started event would then be
committed un-fenced. Fence discovery therefore has to be evaluated **inside**
the same transaction that appends the chain, under the event store's room
lock. That is the design below.

**New eventstore primitive** (`eventstore/store.go`):

```
// ChainLink is one element of a chain: its AppendInput plus the projection
// that runs after the link's canonical row is inserted (nil = none).
type ChainLink struct {
	Input      AppendInput
	Projection Projection
}

// ChainPlanner runs inside the chain's RunInTransaction, after the room
// lock is held and before any sequence is allocated. It observes projection
// state through tx (never through s.app) and returns the links to append,
// in order. It must not open a nested transaction, acquire any other
// service mutex, or call Append/AppendChain.
type ChainPlanner func(tx core.App) ([]ChainLink, error)

// AppendChain takes the room lock for roomID, opens one RunInTransaction,
// invokes plan(tx), then appends the returned links as consecutive
// sequences S, S+1, … Per link, in order: ValidateCredentialProof,
// allocateSequence, ValidateHead, predecessorHash, BuildPayloadInTx(tx,
// seq) / BuildPayload(seq), Seal, insert (idempotency-key uniqueness is the
// existing (room, idempotency_key) index), then the link's Projection. Any
// error from the planner or from any link rolls back every link and leaves
// rooms.head_seq unchanged. Observers are notified once per link, in
// sequence order, only after the whole transaction commits (same OnComplete
// rule as Append). An empty plan returns (nil, nil) and appends nothing.
func (s *Store) AppendChain(ctx context.Context, roomID string, plan ChainPlanner) ([]domain.Event, error)
```

`Append(ctx, input, apply)` becomes `AppendChain(ctx, input.RoomID, func(tx)
{ return []ChainLink{{input, apply}}, nil })` (no behavioural change; the
existing eventstore test suite is the regression fence). The in-chain
`previousHash` of link `i > 0` is `links[i-1].Hash` (already inserted in the
same transaction, so the existing `predecessorHash(tx, room, seq)` read
returns it; the implementation may pass it directly). `BuildPayloadInTx` for
link `i` receives its own allocated sequence, so `startDiscussion.build(tx,
S+1)` writes `starts_at_seq = S+1` exactly as today.

**Lock discipline (normative):** `AppendChain` holds `Store.locks[roomID]`
for the whole transaction. The planner and every projection run under that
lock and must use only lock-free `cycleservice` helpers that take `tx` as
their app (the same family as `InterruptActiveForHumanMessage(tx, …)`,
`service.go:994`, and `findActive(app, roomID)`, `service.go:1136`). Nothing
inside `AppendChain` may call `cycleservice.Service.roomLock(roomID)`
(`service.go:1388`) or any `Service` method that takes it; the two mutexes
are independent and acquiring the cycleservice mutex from inside the
eventstore would introduce a lock-order inversion against the reconciler
(which holds the cycleservice mutex and then calls `events.Append`).

**Command path** (`commandservice.Execute`, `service.go:196-203`,
`StartDiscussion` case): `commandservice` needs no new dependency — the
fence helper is a lock-free package function, imported like
`InterruptActiveForHumanMessage`. Execute calls

```
events, err := s.events.AppendChain(ctx, request.RoomID, func(tx core.App) ([]eventstore.ChainLink, error) {
	links := make([]eventstore.ChainLink, 0, 2)
	fence, found, err := cycleservice.PlanEpochFence(tx, request.RoomID, s.now().UTC())
	if err != nil { return nil, err }
	if found { links = append(links, fence) }
	return append(links, eventstore.ChainLink{Input: startedInput, Projection: startedProjection}), nil
})
```

where `startedInput`/`startedProjection` are the unchanged
`discussion.started` input with the unchanged `startDiscussion` build +
projection, and

```
// PlanEpochFence is lock-free. It reads the active discussion_cycles row of
// roomID through tx. (Cycle{}, false, nil) when none is active. Otherwise it
// returns the fence link for that cycle:
//   Input: AppendInput{RoomID, EpochID: cycle.EpochID, Type: cycle_terminal,
//     EventVersion 1, ActorID "room_coordinator", ActorRole RoleSystem,
//     Payload {cycleId, epochId, state "interrupted", reason
//     "epoch_superseded", generation, acceptedTurns, acceptedBytes,
//     summaryHandoff}, Refs: contributionIDs(cycle),
//     IdempotencyKey "cycle-epoch-fence-<cycleId>-<generation>",
//     IdempotencyHash digest(cycleId + "\x00interrupted\x00epoch_superseded\x00" + generation)}
//   Projection: func(tx, event) — re-read the row by cycle id through tx,
//     assert still active with the same generation (else
//     applicationcycles.ErrConflict, which rolls the chain back),
//     applicationcycles.Supersede → saveCycleRecord (active = 0, state
//     interrupted, stop_reason epoch_superseded, terminal_seq = event.Seq,
//     summary_handoff), cancel the running attempt (state cancelled, reason
//     epoch_superseded).
func PlanEpochFence(tx core.App, roomID string, now time.Time) (eventstore.ChainLink, bool, error)
```

The command's `findByKey` replay lookup keys on the **started** event's
idempotency key exactly as today (`service.go:98`, `:225`);
`acceptableReplayType` is unchanged. `Execute` returns `events[len(events)-1]`
(the started event) as its result.

Ordering guarantee is structural, not timing-based: the fence is link 0, so
`fence.Seq = S` and `started.Seq = startsAtSeq = S+1`, and both the
discovery read and the two inserts happen under one room lock in one
transaction, so no cycle can become active between them. Every connector
classifies the fence as historical (case H). A4 in the connector table
exists only for the reconciler backstop (4.4) and for legacy orphans.

**Observer timing:** neither link is published until the transaction
commits; then observers receive fence then started, in sequence order. The
SSE stream and long-poll therefore never expose a fenced cycle without its
new epoch or vice versa.

**Exact-retry behaviour:** a retry of the same `start_discussion` command
(same key + hash) after commit hits the `findByKey` replay at
`service.go:98` and returns the original `discussion.started`; no second
chain is planned. A retry after a rolled-back transaction finds no replay,
re-runs the planner inside a new transaction, still finds the active cycle
(rollback restored it), and builds the same two-link chain. A concurrent
writer that won the uniqueness race on either link's `(room,
idempotency_key)`, or a concurrent transaction that changed the cycle row so
the fence projection's re-read fails, causes the whole chain to roll back
(`ErrConflict` / unique-constraint error); the existing post-append
`findByKey` convergence (`service.go:224-231`) returns the winner's started
event, otherwise the error propagates and the caller retries. There is no
reachable state with a fence and no started event, or a started event and
an un-fenced foreign-epoch cycle, except the legacy orphans handled in 4.4.

`cycleservice` additions: `ReasonEpochSuperseded = "epoch_superseded"` and
`Supersede(c Cycle) Cycle` in `server/application/cycles/cycles.go`
(identical shape to `Interrupt`, `cycles.go:404`); `PlanEpochFence` exported
from `infrastructure/pocketbase/cycleservice` alongside
`InterruptActiveForHumanMessage` (`service.go:994`), built on the existing
lock-free `findActive`/`decodeCycle`/`saveCycleRecord`/`activeAttempt`
helpers. `appendTerminal` (`service.go:797`) is not used for the fence; the
`discussion_cycles` write is shared via a small helper so it stays identical
to the reconciler's.

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
| `TestStartDiscussionFencesActiveCycle` | start cycle in epoch E1; execute `start_discussion`; assert events in order `[…, cycle_terminal(interrupted/epoch_superseded, epochId E1) @ S, discussion.started(E2) @ S+1]`; assert `started.payload.epoch.startsAtSeq == S+1 == terminal.seq + 1`; assert `discussion_cycles` row `active=0, state=interrupted, stop_reason=epoch_superseded, terminal_seq=S`; running attempt `state=cancelled, reason=epoch_superseded`; `rooms.head_seq == S+1`. |
| `TestAppendChainIsAllOrNothing` (eventstore) | two-link chain whose second link's projection returns an error; assert `head_seq` unchanged, zero rows inserted for either key, zero observer notifications; then a chain whose **first** link fails (`ValidateHead`) → same assertions. |
| `TestAppendChainObserverOrderAfterCommit` (eventstore) | recording observer; assert it receives exactly `[fence, started]` in that order and only after `RunInTransaction` returns. |
| `TestAppendChainPreviousHashLinkage` (eventstore) | two-link chain; assert `links[1].PrevHash == links[0].Hash`, `links[0].PrevHash == hash of the pre-existing head`, and `links[1].Seq == links[0].Seq + 1 == head_seq`. |
| `TestAppendChainPlannerErrorAppendsNothing` (eventstore) | planner returns an error; assert `head_seq` unchanged, zero rows, zero notifications, no lock leaked (a subsequent `Append` on the room succeeds). |
| `TestStartDiscussionRetryAfterRollbackProducesSingleChain` | inject a failure in the started-link projection on the first call; retry with identical key+hash; assert exactly one fence terminal and one `discussion.started` in the store, fence.seq + 1 == started.seq, same idempotency hash; assert no fence exists after the failed first call. |
| `TestStartDiscussionExactReplayEmitsNoSecondFence` | execute twice with identical key+hash; assert the second call returns the original started event and the event count is unchanged. |
| `TestStartDiscussionFenceConflictsOnGenerationDrift` | test hook between the planner's read and the fence projection's re-read mutates the cycle generation through a separate connection; assert `ErrConflict`, no rows inserted, `head_seq` unchanged. |
| `TestStartDiscussionFencesCycleActivatedAfterCommandLockButBeforeChain` (the formerly missing no-active-cycle race) | room with **no** active cycle; a test hook placed after `commandservice` takes its `(room, key)` lock and before `AppendChain` acquires the room lock runs `cycleservice.Start` (a real cycle in epoch E1 becomes active through its own `events.Append`); then let the chain proceed. Assert the committed chain is `[cycle_terminal(interrupted/epoch_superseded, E1) @ S, discussion.started(E2) @ S+1]`, i.e. the fence was discovered inside the transaction, **not** a lone un-fenced `discussion.started` beside an `active = 1` E1 row. The same test compiled against the removed external-preflight design would produce exactly that un-fenced commit — that assertion is the RED oracle for this correction. |
| `TestStartDiscussionConcurrentWriterForcesRetryNotUnfencedStart` | two goroutines: G1 executes `start_discussion`; a hook inside G1's planner (after the fence was found, before insert) blocks until G2 has committed a competing write on the same room that changes the fence's cycle row (e.g. `cycleservice` human interruption of that cycle, or its own `start_discussion` with a different key). Assert G1's first attempt returns `ErrConflict`/unique-constraint error with **zero** rows from G1 committed (`head_seq` equals G2's head, no `discussion.started` from G1's key); then G1 retries with the same key+hash and either converges via `findByKey` on G2's started event (same-command case) or commits a fresh chain whose fence, if any, references the now-active cycle. In no interleaving does a `discussion.started` commit while a foreign-epoch `discussion_cycles` row remains `active = 1`. |
| `TestReconcilerNeverTimesOutForeignEpochCycle` | seed DB with active cycle in E1 and active epoch E2 (pre-fix state); advance clock past deadline; run `ReconcileRoom`; assert emitted terminal is `(interrupted, epoch_superseded)`, **not** `(timed_out, cycle_deadline_reached)`. |
| `TestClaimOnForeignEpochCycleIsSuperseded` | claim attempt on E1 cycle while E2 active → `ErrSuperseded`/`ErrCycleTerminal`, HTTP `cycle_superseded`. |
| `TestFixtureCanonicalBytesRoundTrip` (domain) | for each fixture: strip LF, assert stored hash, unmarshal into `domain.Event`, `CanonicalBytes` → sha256 equals stored hash. |
| Negative | `TestStartDiscussionWithoutActiveCycleEmitsNoFence` — single-link chain; event list contains no `cycle_terminal`; `startsAtSeq == started.seq`. |

Evidence receipt: `go test ./server/... -run 'Fence|ForeignEpoch|FixtureCanonical|AppendChain'`
full output + `go vet ./...` exit code, committed under
`docs/evidence/` in the server build card.

## 5. Connector parity

### 5.1 OpenClaw Room (`src/runtime.js`)

Three exported helpers, one routing branch. Names are chosen so the scope of
each check is unambiguous:

```
// Shared epoch-evidence extractor. Extracted verbatim from the first half of
// today's eventEpochId (src/runtime.js:1363-1371) and extended by one
// source. Collects payload.epochId, payload.epoch.id,
// payload.epoch.topic.epochId, payload.topic.epochId and — only when
// event.type === "discussion.cycle_terminal" — payload.summaryHandoff.epochId;
// each present value is validated with exactEpochId. Returns the single
// distinct value ("" when none present). Throws the existing
// Error("Room event contains contradictory epoch evidence") when more than
// one distinct value is present (R5). Every caller below goes through this
// function; there is no second extractor.
export function epochEvidence(event)

// Structure only. Calls epochEvidence(event) first — so R5 throws out of
// this function; it never returns false for R5. Then true iff event is
// discussion.cycle_terminal with nonempty payload.cycleId and
// (state, reason, actorRole) in A1–A4; false otherwise.
// Does NOT look at the page or at seq; it never decides boundary relation.
export function isLifecycleOnlyCycleTerminal(event)

// Boundary relation only. Calls epochEvidence(event) (R5 throws). True iff
// seq >= pageActiveEpochStartsAtSeq and the evidence is nonempty and differs
// from pageActiveEpochId.
export function isBoundaryEvent(event, pageActiveEpochId, pageActiveEpochStartsAtSeq)
```

`eventEpochId()` (`src/runtime.js:1362-1383`) replaces its inline evidence
collection with `epochEvidence(event)` and its inline
`interruptedCycleCleanup` with `isLifecycleOnlyCycleTerminal(event)`, and
otherwise keeps its contract (throws on boundary contradiction for
everything not lifecycle-only, returns the payload epoch for accepted
boundary terminals). Because `eventEpochId` is called at
`src/runtime.js:361` before any routing, R1–R8 still throw before evidence
or ack, and R5 now throws the named contradiction error from the shared
extractor for terminals whose `summaryHandoff.epochId` disagrees with the
envelope evidence (today that field is not inspected).

`assignedTurns()` routing change — insert one branch immediately **before**
the `!isAssignedEvent` branch (`src/runtime.js:384-388`) and after the
`recoverPendingDelivery` branch (`:379-383`):

```
if (!historical
    && isLifecycleOnlyCycleTerminal(event)
    && isBoundaryEvent(event, pageActiveEpochId, pageEpoch.startsAtSeq)) {
  await this.recordTerminalEvidence(event, "ignored", {reason: "prior_epoch_lifecycle"});
  await this.ackEvent(event);
  continue;
}
```

Placement rationale: the branches above it (`recoverPostedEvidence`,
`historical`, `existingTerminalEvidence`, `recoverPendingDelivery`) are
state-recovery paths that must keep precedence; a lifecycle terminal never
has a delivery intent, so in practice they all fall through. Placing it
before `!isAssignedEvent` is what makes the recorded reason
`prior_epoch_lifecycle` instead of `not_assigned_or_technical`; nothing
below the new branch (`markContextAcknowledged`, peer ack,
`prepareCycleAttempt`, `sharedRoomContext`, `yield`) is reachable for an
accepted boundary terminal. The `!isAssignedEvent` branch itself is
unchanged.

`recordTerminalEvidence` persists to the state file (`persistState`,
`src/runtime.js:546`) before `ackEvent` issues
`POST /rooms/{id}/acknowledgements` with the contiguous frontier (`ackEvent`,
`src/runtime.js:689-710`); that ordering is unchanged. `validTerminalEvidence`
(`src/runtime.js:245-255`) accepts any nonempty `reason` for status
`ignored`, so no state-schema change is needed (verified at 9ce50e4). No
activity frame, no peer ack.

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

- `_is_lifecycle_only_cycle_terminal(event)` (same A1–A4 table) →
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
| `fixture 132-134: prior-epoch timed_out terminal is acknowledged as lifecycle-only` | Driver exactly as 2.1 (full `version: 1` state in a temp state file, cursor 131, membership `nnrafww8dv4g7a6`, page `{events:[132,133,134], activeEpochId:"dqb8eamems9yi2e", activeEpochStartsAtSeq:133}`, all client methods except `readEvents`/`acknowledge` and `markContextAcknowledged` as counters). RED assertions (`assert.rejects(iterator.next(), /contradicts the authoritative active epoch boundary/)`): `acks` deep-equals `[132, 133]`; evidence trace deep-equals `[[132,"superseded","historical_epoch"],[133,"ignored","not_assigned_or_technical"]]`; `state.cursor === 133`; `terminalEvidence["134"] === undefined`; all counters 0. | Same driver; `iterator.next()` resolves with the abort/`done` outcome instead of rejecting. Assert `acks` deep-equals `[132, 133, 134]` (one ack per event, contiguous frontier advances by one each time); evidence trace deep-equals `[[132,"superseded","historical_epoch"],[133,"ignored","not_assigned_or_technical"],[134,"ignored","prior_epoch_lifecycle"]]`; `state.cursor === 134`; `deepEqual(state.terminalEvidence, {})`; `pendingEvent === null`; `markContextAcknowledged`, `roomPolicy`, `startDiscussionCycle`, `claimDiscussionAttempt`, `postMessage`, `acknowledgePeerContribution`, `publishActivity` counters all `0`; `deepEqual(state.deliveryIntents, {})`; generator yielded nothing. The evidence for 132 and 133 is byte-identical between RED and GREEN — the fix changes only what happens at 134. |
| `isLifecycleOnlyCycleTerminal accepts exactly A1–A4` | function absent (import fails) | table-driven over 3.2 rows A1–A4 → `true`; R1–R4, R6 → `false`; role mismatches → `false`; non-terminal types → `false`. R5 (a `cycle_terminal` whose `summaryHandoff.epochId` differs from `payload.epochId`, and one whose `epoch.id` differs from `payload.epochId`): `assert.throws(() => isLifecycleOnlyCycleTerminal(event), {message: "Room event contains contradictory epoch evidence"})` — it must throw, never return `false`. Pure function: no page argument. |
| `epochEvidence is the single extractor` | function absent | returns `""` for no evidence; returns the value for each of the five sources alone (`summaryHandoff.epochId` only counted when `type === "discussion.cycle_terminal"`; for a `message.posted` carrying a stray `summaryHandoff.epochId` it is ignored); throws `{message: "Room event contains contradictory epoch evidence"}` for any two distinct values; `eventEpochId(fixture134, "dqb8eamems9yi2e", 133)` and `epochEvidence(fixture134)` both return `qjw1tu1jfnm1wsp`. |
| `isBoundaryEvent classifies by seq and epoch only` | function absent | seq < startsAt → `false` regardless of epoch; seq ≥ startsAt & epoch == active → `false`; seq ≥ startsAt & epoch ≠ active → `true`; R5 → `assert.throws(…, {message: "Room event contains contradictory epoch evidence"})`. Never inspects `type`/`state`/`reason`. |
| `eventEpochId rejects R1–R8 at the boundary` | partially passes (existing test) | extend existing `accepts only interrupted-cycle cleanup…` test with `completed`, `failed`, `timed_out/human_interrupted`, `cycle_attempt_ready`, `message.posted`, `discussion.started`, missing `cycleId` → `/contradicts the authoritative active epoch boundary/`; `summaryHandoff.epochId` contradicting `epochId` → `{message: "Room event contains contradictory epoch evidence"}` (RED today: 9ce50e4 ignores `summaryHandoff`). |
| `R5 terminal in the page loop throws before evidence and ack` | RED: 9ce50e4 ignores `summaryHandoff`, so `eventEpochId` sees only `qjw1tu1jfnm1wsp` and rejects with the boundary error `/contradicts the authoritative active epoch boundary/`, not the contradiction error; the exact-message `assert.rejects` fails | driver as 2.1, but 134 replaced by a copy whose `summaryHandoff.epochId` is `dqb8eamems9yi2e` while `payload.epochId` stays `qjw1tu1jfnm1wsp`: `assert.rejects(iterator.next(), {message: "Room event contains contradictory epoch evidence"})`; `acks` deep-equals `[132, 133]`; `terminalEvidence["134"] === undefined`; `state.cursor === 133`; all counters 0. |
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
- Table test for A1–A4 / R1–R6 on `_is_lifecycle_only_cycle_terminal` (structure only, mirrors `isLifecycleOnlyCycleTerminal`).

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
  optional `leases`. Decided (4.3): no new dependency; the fence is planned
  by the lock-free package function `cycleservice.PlanEpochFence(tx, …)`
  inside the `ChainPlanner` callback of the new
  `eventstore.AppendChain(ctx, roomID, plan)` primitive; `Append` delegates
  to a one-link chain. `BuildPayloadInTx` is **not** a valid host for the
  fence — it runs after the started event's sequence is already allocated
  (`store.go:96-110`), so a nested append would land above `startsAtSeq`.
  An out-of-transaction active-cycle lookup is **not** a valid preflight
  either — it races with a cycle activating before the chain commits (4.3,
  test `TestStartDiscussionFencesCycleActivatedAfterCommandLockButBeforeChain`).
- `Store.locks` is per room and `commandservice.locks` is per
  `(room, idempotencyKey)`; `AppendChain` takes only the room lock and its
  planner/projections never take `cycleservice.Service.locks`, so the
  existing lock order (command key lock → room lock) is unchanged and no
  eventstore → cycleservice mutex edge is introduced.
- OpenClaw helper split (5.1): `epochEvidence` (single extractor, throws the
  named contradiction error on R5), `isLifecycleOnlyCycleTerminal`
  (structure, no page) and `isBoundaryEvent` (seq/epoch relation, no
  type/state). The routing branch composes the last two; `eventEpochId`
  composes `epochEvidence` and `isLifecycleOnlyCycleTerminal`. R5 always
  throws; no helper returns `false` for contradictory evidence.
- Decide in the plan: Hermes `epoch_boundary_contradiction` as
  `retryable=False` stall (recommended, matches OpenClaw) vs inbox
  quarantine.
- Baseline verification at 9ce50e4 for this spec: `npm run test` → 144 pass,
  0 fail, 1 skipped; `npm run check` → exit 0.
