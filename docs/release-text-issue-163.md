# Release text: private approvals in a Room (ISSUE-163)

Paste into the release notes of the version that carries this change.

**A command that needs private approval is refused at once in a Room.** Nobody can
answer an approval in a Room. On earlier versions the request stayed open for 30
minutes, the host dropped the model's reply for that turn, and at expiry a host
follow-up posted into the Room outside any turn. Under `askFallback=full` the command
then ran with nobody approving. Now the connector refuses such a command before a
request exists, with an ordinary tool error, so the reply stays in its turn.

**Nothing changes on the default policy** (security `full`, ask `off`).

**It refuses** under ask `always`, and in allowlist mode for a miss, a shell wrapper
(`bash -c`), an unquoted expansion (`*`, `~`, `{`) or a heredoc. It also refuses
`security.audit.suppressions` commands, `host=node` under a policy that can ask, and
any policy it cannot read. Under `strictInlineEval` it refuses a command naming an
inline-eval program.

**A private approval target stays open:** `approvals.exec` in mode `targets` or `both`
with a target outside the Rooms. Exception: `askFallback=full` is refused.

**Approval text never reaches a Room:** the same rule as the Hermes connector, plus
this host's own sentences. A reply that matches is dropped whole, even an ordinary
sentence, and only a log line remains.

**Limits:**
- A binary the host finds on its login-shell PATH, alone or before the daemon's copy, is
  refused in allowlist mode, also under ask `off`, although the host would run it. A name the
  hook and the host resolve differently can still open a request.
- `strictInlineEval` also refuses `python script.py` or `find . -name x`, which name
  such a program without its eval flag.
- Refused though the host might run it: custom `safeBinProfiles` or
  `safeBinTrustedDirs`, a miss auto-review might allow, a `host=node` command the node
  might allow, JavaScript under `tools.codeMode`.
- A person driving a Room session by hand is refused too, and a connected Control UI
  is not a target.
- After a person answers at a private target, the host's follow-up is an ordinary post
  not bound to the turn.
- A host upgrade that moves an SDK export used here refuses all `exec` in all Rooms
  until the connector is updated.
- Not covered: ACP children, `sessions_send`, a third-party plugin's `requireApproval`,
  `!cmd` commands, a sandbox with an elevated default level.

**Not run:** a real model, a live gateway or Room server, a real paired node, sandbox,
Control UI, Windows, other host versions, the signed archive install, the ClawHub scan,
the CI workflow. README "Private approvals in a Room" has the full list.
