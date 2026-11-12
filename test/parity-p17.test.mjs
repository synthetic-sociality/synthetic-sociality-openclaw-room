import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";

// P17 (shared with Hermes 1.0.104): owner connector control. The cases run in
// test/connector-control.test.mjs against two Room accounts of one gateway;
// this file pins the shared clause, the case names and the version pairing.

export const CASES = [
  "P17-01 registration carries installation identity, connector version and the control capability",
  "P17-02 a malformed or absent connectorControl is ignored and never breaks the loop",
  "P17-03 a command is claimed once across the bindings of one installation and a 409 is ignored",
  "P17-04 an active dispatch refuses control with work_in_progress",
  "P17-05 a pending renewal refuses control with work_in_progress",
  "P17-06 an unfinished delivery intent in another Room refuses control with work_in_progress",
  "P17-07 the fence blocks a new dispatch while the guard runs",
  "P17-08 reconnect reloads each binding once and keeps one live binding per enabled Room",
  "P17-09 after a reconnect a turn in a sibling Room is accepted",
  "P17-10 restart persists its receipt before the supervisor request with a fixed argv",
  "P17-11 a supervisor failure reports supervisor_unavailable and restores service",
  "P17-12 the restarted process reports completion or mismatch once and control leaves state files unchanged",
];
const CLAUSES = ["P17-1", "P17-2", "P17-3", "P17-4", "P17-5", "P17-6", "P17-7", "P17-8"];
const HEADING = "P17 — Owner connector control (2026-11-12)";
const ANCHOR = "p17--owner-connector-control-2026-11-12";

test("P17 conformance names the shared clause and cases", async () => {
  const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
  const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
  assert.deepEqual(conformance.parityP17Cases, CASES);
  assert.equal(conformance.parityP17Contract, `docs/delivery-lifecycle-contract-v1.md#${ANCHOR}`);
  const headings = contract.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
  assert.equal(headings.filter((title) => title === HEADING).length, 1);
  const anchors = headings.map((title) => title.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-"));
  assert.ok(anchors.includes(ANCHOR));
  const section = contract.split(`## ${HEADING}`)[1].split("\n## ")[0];
  assert.deepEqual(section.split("\n").filter((line) => /^- P17-\d\d /.test(line)).map((line) => line.slice(2)), CASES);
  for (const clause of CLAUSES) assert.ok(section.includes(`- ${clause} `), clause);
});

test("P17 case names resolve to tests of the connector-control suite", async () => {
  const suite = await readFile(new URL("./connector-control.test.mjs", import.meta.url), "utf8");
  for (const [index, name] of CASES.entries()) {
    assert.ok(suite.includes(JSON.stringify(name)), name);
    assert.ok(suite.includes(`test(CASES[${index}],`), name);
  }
});

test("P17 restart asks only the supported OpenClaw lifecycle with a fixed argv", async () => {
  const source = await readFile(new URL("../src/connector-control.js", import.meta.url), "utf8").catch(() => "");
  assert.match(source, /\["gateway", "restart", "--safe"\]/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /\bexec(Sync)?\(/);
});

test("P17 version pairing: OpenClaw 0.2.79 implements the clause", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
  assert.equal(packageJson.version, "0.2.79");
  assert.equal(conformance.adapterVersion, "0.2.79");
});
