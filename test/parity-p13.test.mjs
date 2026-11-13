// P13: agent cycle replies address Room members by @DisplayName (OpenClaw 0.2.80; shared contract P13-1..4 and the
// identical parityP13Cases of the Hermes connector). The standalone (cross-channel) recipient routing stays as it is;
// this extends the selection a cycle reply freezes with its delivery intent.
import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import * as runtime from "../src/runtime.js";
import {validateState} from "../src/state.js";

const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const CASES = conformance.parityP13Cases;
const SELF = "a1";
const ROSTER = [
  {membershipId: "a1", displayName: "Aura", role: "participant_agent", status: "active"},
  {membershipId: "a2", displayName: "Claw", role: "participant_agent", status: "active"},
  {membershipId: "a3", displayName: "Real", role: "room_master", status: "active"},
  {membershipId: "a4", displayName: "Muted", role: "participant_agent", status: "muted"},
  {membershipId: "h1", displayName: "Thorsten", role: "human_owner", status: "active"},
  {membershipId: "a5", displayName: "Twin", role: "participant_agent", status: "active"},
  {membershipId: "h2", displayName: "Twin", role: "human_member", status: "active"},
  {membershipId: "a6", displayName: "Ünal", role: "participant_agent", status: "active"},
  {membershipId: "a8", displayName: "aura", role: "participant_agent", status: "active"},
  {membershipId: "a9", displayName: "Strauß", role: "participant_agent", status: "active"},
];
const cycle = (followUps = 0, maxFollowUps = 2) => ({
  cycleId: "c-1", attemptId: "t-1", generation: 0, followUps,
  budgets: {maxFollowUps, perAgentTurns: 2},
  roster: [{membershipId: "a1"}, {membershipId: "a2"}], progress: {},
});
// 0.2.79 model: a cycle reply carried only the rotation recipient, never a mention.
function legacy(_body, {cycle: current, membershipId}) {
  const roster = current.roster;
  if (roster.length < 2 || current.followUps >= current.budgets.maxFollowUps) return {nextRecipient: "", recipientSelectors: []};
  const start = roster.findIndex((agent) => agent.membershipId === membershipId);
  return {nextRecipient: roster[(start + 1) % roster.length].membershipId, recipientSelectors: []};
}
const select = runtime.cycleRecipientSelectors ?? legacy;
const ids = (body, current = cycle()) => {
  const frozen = select(body, {roster: ROSTER, cycle: current, membershipId: SELF});
  const selectors = frozen.nextRecipient ? [{kind: "membership", membershipId: frozen.nextRecipient}] : frozen.recipientSelectors;
  return selectors.map((item) => item.membershipId);
};

test("P13 conformance names the clause and the shared cases", () => {
  assert.match(conformance.parityP13Contract, /^docs\/delivery-lifecycle-contract-v1\.md#p13/);
  assert.equal(CASES.length, 10);
  const section = contract.split("## P13 — ")[1].split("\n## ")[0];
  assert.deepEqual(section.split("\n").filter((line) => /^- P13-\d\d /.test(line)).map((line) => line.slice(2)), CASES);
  assert.equal(typeof runtime.cycleRecipientSelectors, "function", "OpenClaw implements P13 from 0.2.80");
});

test(CASES[0], () => {
  assert.deepEqual(ids("@Real what do you think?"), ["a3", "a2"]);
});

test(CASES[1], () => {
  assert.deepEqual(ids("@Real and @Claw, please"), ["a3", "a2"]);
  assert.deepEqual(ids("@Claw first, then @Real"), ["a2", "a3"]);
});

test(CASES[2], () => {
  assert.deepEqual(ids("@everyone @Muted @Nobody @Rea @Reals x@Real mail real@Real.example"), ["a2"]);
  assert.deepEqual(ids("@Aura talking to myself"), ["a2"]);
});

test(CASES[3], () => {
  assert.doesNotThrow(() => ids("@Twin and @aura please"));
  assert.deepEqual(ids("@Twin and @aura please"), ["a2"]);
});

test(CASES[4], () => {
  assert.deepEqual(ids("@Thorsten what do you think?"), ["a2"]);
});

test(CASES[5], () => {
  const first = select("@Real look", {roster: ROSTER, cycle: cycle(), membershipId: SELF});
  assert.deepEqual(select("@Real look", {roster: ROSTER, cycle: cycle(), membershipId: SELF}), first, "deterministic");
  // A retry or restart replays the frozen request: the validator binds the post to the frozen selectors.
  const selectors = first.nextRecipient ? [{kind: "membership", membershipId: first.nextRecipient}] : first.recipientSelectors;
  const identity = {roomId: "room-1", body: "@Real look", sourceEventId: "evt-1", nextRecipient: first.nextRecipient,
    recipientSelectors: first.recipientSelectors, postObservedSeq: 3, cycle: {cycleId: "c-1", attemptId: "t-1", generation: 0}};
  const post = {body: "@Real look", idempotencyKey: "k-1", observedSeq: 3, attachments: [], recipientSelectors: selectors,
    cycleId: "c-1", attemptId: "t-1", cycleGeneration: 0, contributionType: "question"};
  const state = (frozenPost) => ({version: 1, baseUrl: "https://room.example/api", roomId: "room-1", membershipId: "a1",
    credential: "secret", clientInstanceId: "client-1", cursor: 0, deliveryIntents: {"evt-1:final": {version: 1,
      status: "delivery_pending", messagePayloadDialect: "v1", messageIdempotencyKey: "k-1", identity, post: frozenPost}}});
  assert.doesNotThrow(() => validateState(state(post)));
  assert.throws(() => validateState(state({...post, recipientSelectors: [{kind: "membership", membershipId: "a9"}]})), /frozen post/);
});

test(CASES[6], () => {
  assert.deepEqual(ids("@Real please", cycle(2, 2)), [], "follow-ups exhausted");
  assert.deepEqual(ids("@Real please", cycle(0, 0)), [], "follow-ups off");
});

test(CASES[7], () => {
  for (const body of ["```\n@Real\n```", "~~~\n@Real\n~~~", "see `@Real` here", "> @Real said so", "  > @Real quoted"]) {
    assert.deepEqual(ids(body), ["a2"], body);
  }
  assert.deepEqual(ids("> quoted line\n@Real outside"), ["a3", "a2"]);
});

test(CASES[8], () => {
  const current = cycle(2, 3);
  const chosen = ids("@Real and @Ünal", current);
  assert.deepEqual(chosen, ["a3"], "capped at max(0, maxFollowUps - followUps)");
  // Server acceptance model: at most the remaining follow-ups, each an active eligible agent other than the sender.
  const eligible = new Set(ROSTER.filter((member) => member.status === "active" && ["participant_agent", "room_master"].includes(member.role)
    && member.membershipId !== SELF).map((member) => member.membershipId));
  for (const [body, state] of [["@Real @Claw @Ünal", cycle(0, 2)], ["@Real", cycle(1, 2)], ["@Ünal @Real", cycle(0, 5)]]) {
    const selected = ids(body, state);
    assert.ok(selected.length <= Math.max(0, state.budgets.maxFollowUps - state.followUps), body);
    assert.ok(selected.every((id) => eligible.has(id)), body);
    assert.equal(new Set(selected).size, selected.length, body);
  }
});

test(CASES[9], () => {
  assert.deepEqual(ids("@ünal hello"), ["a6", "a2"]);
  assert.deepEqual(ids("@ÜNAL hello"), ["a6", "a2"]);
  assert.deepEqual(ids("@STRAUSS hello"), ["a2"], "no casefold: ß is not ss");
  assert.deepEqual(ids("@strauß hello"), ["a9", "a2"]);
});
