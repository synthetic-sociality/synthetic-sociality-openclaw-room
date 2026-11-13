// P18: abandon the pending work of a revoked binding on re-admission (Hermes 1.0.105, OpenClaw 0.2.80). Same
// contract pin and case names as the Hermes connector's tests/test_parity_p18.py.
import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const CONTRACT = "docs/delivery-lifecycle-contract-v1.md#p18--abandon-the-pending-work-of-a-revoked-binding-on-re-admission-2026-11-13";
const HEADING = "## P18 — Abandon the pending work of a revoked binding on re-admission (2026-11-13)";
const CASE_TESTS = {
  "P18-01": ["test_p18_01_the_live_real_binding_is_replaced_by_the_fresh_credential"],
  "P18-02": ["test_p18_02_the_journal_records_every_abandoned_entry_and_survives_replacement_and_reload"],
  "P18-03": ["test_p18_03_an_active_binding_with_pending_work_is_untouched_and_unclaimed"],
  "P18-04": ["test_p18_04_an_operator_disabled_binding_is_untouched_and_unclaimed"],
  "P18-05": ["test_p18_05_a_replay_appends_no_duplicate_audit_entry"],
  "P18-06": ["test_p18_06_a_binding_changed_before_the_transaction_is_kept_and_unclaimed"],
  "P18-07": ["test_p18_07_a_revoked_binding_with_an_intent_or_quarantine_is_not_abandoned"],
};
const conformance = JSON.parse(await readFile(new URL("conformance.json", ROOT), "utf8"));
const contract = await readFile(new URL("docs/delivery-lifecycle-contract-v1.md", ROOT), "utf8");

test("conformance pins the P18 contract and cases", () => {
  assert.equal(conformance.parityP18Contract, CONTRACT);
  assert.deepEqual(conformance.parityP18Cases.map((item) => item.split(" ", 1)[0]), Object.keys(CASE_TESTS).sort());
});

test("the P18 contract section lists the clauses and the same cases", () => {
  assert.equal(contract.split(HEADING).length - 1, 1);
  const section = contract.split(HEADING)[1].split("\n## ")[0];
  const listed = section.split("\n").filter((line) => /^- P18-\d\d /.test(line)).map((line) => line.slice(2));
  assert.deepEqual(listed, conformance.parityP18Cases);
  for (let number = 1; number <= 5; number += 1) assert.ok(section.includes(`- P18-${number} `), `P18-${number}`);
  assert.ok(section.includes("Hermes 1.0.105, OpenClaw 0.2.80"), "the P18 header is universal");
});

test("every P18 case maps to an existing test", async () => {
  const source = await readFile(new URL("test/revoked-abandonment.test.mjs", ROOT), "utf8");
  for (const [id, names] of Object.entries(CASE_TESTS)) {
    for (const name of names) assert.ok(source.includes(`test("${name}"`), `${id}: ${name}`);
  }
});

// PR80-H-005: the whole shared contract is pinned, so a single-repo edit to any clause fails the suite.
test("the whole shared contract matches conformance contractSha256", async () => {
  const {createHash} = await import("node:crypto");
  const bytes = await readFile(new URL("docs/delivery-lifecycle-contract-v1.md", ROOT));
  assert.match(conformance.contractSha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), conformance.contractSha256);
});
