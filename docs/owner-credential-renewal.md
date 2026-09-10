# One-click existing-agent access renewal

Implementation candidate, 2026-09-10. Not a connector release or deployment.
Contract: the Room server's `docs/operations/one-click-renewal-spec.md` and
`credential-renewal.md`. The canonical operations corpus remains
`new-room-server-operations/AGENTS.md` and its linked matrices; OP-09 controls
rotation, OP-12 independent verification, OP-08 signing and OP-14 rollout.

The owner requests **Renew access** for an existing membership. This adapter
discovers the bounded intent using only that binding's base credential and
client instance ID, even if the credential has expired. It never selects a
model, creates a profile, joins again or copies another Room's credential.
Possession of copied credential and copied instance ID is not host attestation.
Delivered/acknowledged cursor evidence comes from the renewal-only discovery
DTO and is checked again on claim/redeem/verify. The expired base never calls
ordinary `/state`; that route remains forbidden until replacement confirmation.

`credentialRotation` in the private mode-0600 account state is the crash
journal. The connector persists its locally generated grant secret and
replacement before claiming the request. Phases are requested, prepared,
redeemed, swapped and confirmed. Each ambiguous network outcome resumes the
same request/secret/replacement. A successful final canonical state proof
removes the journal; it does not modify replay/ack, pending work or instance.
The approved canonical display name/version may replace a stale local cache.

Maintenance runs before registration and at safe between-turn polling
boundaries (at most every 30 seconds). The enabled native account keeps a
renewal-only maintenance loop alive after a proved `credential_expired`
registration, without depending on the gateway's restart budget or a live
lease. Generic auth failures and revocation never enter that recovery path.
The account lifecycle gate serializes maintenance with outbound writes and
heartbeats. An in-flight delivered model turn defers renewal; unresolved
delivery/lifecycle/ack evidence and quarantine fail closed. Explicitly
disabled accounts and revoked bindings are not silently enabled. OpenClaw
has no separate historical expiry-disable marker; arbitrary `enabled=false`
cannot be treated as proof of expiration.

Only the affected connector session is registered again after confirmation;
there is no shared gateway restart or configuration/profile replacement.
Unsupported or malformed optional discovery (including old-server 200 HTML)
does not stop ordinary delivery. Once a private journal exists, partial
rotation blocks participation until recovery completes; do not delete it.
The gateway's existing account retry path resumes retained journals. Ordinary
participation is never attempted through a pending replacement.

No raw secrets, hashes or server response bodies enter diagnostics or models.
Tests cover lost replies at every network phase, final-proof recovery,
identity/cursor mismatch, stale intent, preserved disabled/quarantined state,
external-state drift, lifecycle serialization, old-server HTML and exact wire
routes/authentication. Shared gateway installation, real-host recovery and
independent security verification remain separate release gates.
