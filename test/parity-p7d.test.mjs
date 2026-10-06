// Parity P7d "Discussion documents: once in full, then on demand": contract
// section P7d (conformance parityP7dCases; Hermes implements the same names).
// The Room state's activeTopic.documents (Room server ebad3df and later) names
// the documents of the discussion. No test uses a real credential or talks to a
// live Room.
import assert from "node:assert/strict";
import test, {after, beforeEach} from "node:test";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {createRequire, registerHooks} from "node:module";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {ISOLATED_HOST_CONFIG} from "./support/isolated-host.mjs";

const sdkMocks = {
  "openclaw/plugin-sdk/channel-core": "export const defineChannelPluginEntry = (entry) => entry;",
  "openclaw/plugin-sdk/channel-message": "export const defineChannelMessageAdapter = (adapter) => adapter;",
  "openclaw/plugin-sdk/channel-inbound": "export const buildChannelInboundEventContext = (context) => context;",
  "openclaw/plugin-sdk/reply-payload": "export const isReplyPayloadNonTerminalToolErrorWarning = () => false;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sdkMocks[specifier]) return {url: `data:text/javascript,${encodeURIComponent(sdkMocks[specifier])}`, shortCircuit: true};
    return nextResolve(specifier, context);
  },
});
const home = await mkdtemp(join(tmpdir(), "openclaw-room-p7d-"));
process.env.HOME = home;
after(() => rm(home, {recursive: true, force: true}));
const {OpenClawRoomRuntime, epochConversationId} = await import("../src/runtime.js");
// Imported, not required: on a connector without P7d each case fails on its own.
const documents = await import("../src/documents.js").catch(() => ({}));
const {readRoomDocument, registerRoomDocumentTool, ROOM_DOCUMENT_PARAMETERS} = await import("../src/document-tool.js").catch(() => ({}));
const channelModule = await import("../src/channel.js");
const statusModule = await import("../src/local-status.js");
const {loadState, saveNewState, validateState} = await import("../src/state.js");
const {RoomAPIError, RoomResponseError, RoomTransportError} = await import("../src/room-client.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const TOOL = "synthetic_sociality_room_document";
const HEADER = "[Room-shared document context";
const FOOTER = "[/Room-shared document context]";
const ID = "synthetic-sociality-room";
// Unicode code points, as Python counts and cuts (the test's own copy).
const codePointLength = (text) => [...text].length;
const codePointSlice = (text, count) => [...text].slice(0, count).join("");

// The shared text generator of the conformance vectors (same in Hermes).
const generatedText = (lines, count) => Array.from({length: count}, (_, index) => `${String(index).padStart(4, "0")} ${lines[index % lines.length]}`).join("\n");
const LINES = conformance.parityP7dTextLines;
// The 2026-10-04 proof document had 22,709 characters.
const PROOF_TEXT = codePointSlice(generatedText(LINES, 520), 22_709);
const LARGE_TEXT = generatedText(LINES, 900);
const pyStrip = (text) => text.replace(/^[ \n]+|[ \n]+$/g, "");

const entry = (artifactId, versionId = "v1", {name, classification = "room_shared", seq = 42} = {}) => ({artifactId, versionId,
  name: name ?? `${artifactId}.md`, mimeType: "text/markdown", size: 1, sha256: "d".repeat(64), sourceSeq: seq, classification});
// An artifact as GET /rooms/{room}/artifacts/{id} returns it.
const record = (artifactId, versions) => {
  const items = Object.entries(versions).map(([versionId, [status, text]]) => ({versionId, extractionStatus: status,
    ...(text === null ? {} : {extractedText: text})}));
  return {artifactId, visibility: "room_shared", currentVersion: items.at(-1), versions: items};
};
const apiError = (status, retryAfter = 0) => new RoomAPIError(status, {code: status === 404 ? "not_found" : "forbidden"}, {retryAfter});

const ROSTER = [
  {membershipId: "owner-tj", displayName: "TJE", role: "human_owner", status: "active"},
  {membershipId: "zurie", displayName: "Zurie", role: "participant_agent", status: "active"},
];

// The Room API a turn and the tool read; records every artifact read.
class Room {
  constructor(records = {}, library = [], {documentsList = null, epochId = "epoch-z", topic = true} = {}) {
    this.records = {...records};
    this.library = library;
    this.reads = [];
    this.documentsList = documentsList;
    this.epochId = epochId;
    this.topic = topic;
    this.baseUrl = "https://room.example/api";
  }

  state(head = 60) {
    const state = {headSeq: head, title: "Showroom", activeEpoch: {id: this.epochId, startsAtSeq: 41}, roster: ROSTER, rules: []};
    if (this.topic) {
      state.activeTopic = {id: "topic-1", title: "Disclosure", status: "active", description: null};
      if (this.documentsList !== null) state.activeTopic.documents = structuredClone(this.documentsList);
    }
    return state;
  }

  async getArtifact(_session, artifactId) {
    this.reads.push(artifactId);
    const value = this.records[artifactId];
    if (value instanceof Error) throw value;
    if (value === undefined) throw apiError(404);
    return structuredClone(value);
  }

  async listArtifacts() {
    return {items: structuredClone(this.library)};
  }

  client() {
    return {baseUrl: this.baseUrl, roomState: async () => this.state(), listArtifacts: () => this.listArtifacts(),
      getArtifact: (session, id) => this.getArtifact(session, id)};
  }
}

const start = (epochId) => ({id: `start-${epochId}`, seq: 41, type: "discussion.started", actorRole: "human_owner", actorId: "owner-tj",
  payload: {epoch: {id: epochId, startsAtSeq: 41, topic: {title: "Disclosure"}}}});
const humanSource = (epochId, extra = {}) => ({id: "m-42", seq: 42, type: "message.posted", actorRole: "human_owner", actorId: "owner-tj",
  payload: {body: "Should the doctor disclose the diagnosis?", epochId, ...extra}});
const readyFor = (seq, epochId, sourceEventId = "m-42", extra = {}) => ({id: `ready-${seq}`, seq, type: "discussion.cycle_attempt_ready",
  actorRole: "system", actorId: "room_coordinator",
  payload: {cycleId: "cycle-1", epochId, generation: 1, membershipId: "zurie", round: 1, sourceEventId, ...extra}});
const claimed = (sourceEventId = "m-42") => ({attempt: {id: "attempt-1", round: 1, membershipId: "zurie"},
  cycle: {id: "cycle-1", generation: 1, totalTurns: 1, sourceEventId, budgets: {totalTurns: 16, perAgentTurns: 8}}});

// The turn the runtime hands to OpenClaw for the last of `events`, and the runtime.
async function turnFor(room, events, {memory, claim = claimed()} = {}) {
  const runtime = new OpenClawRoomRuntime({accountId: "t", stateFile: join(home, `${Math.random()}.json`), baseUrl: room.baseUrl});
  const last = events.at(-1);
  runtime.state = {version: 1, baseUrl: room.baseUrl, roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", messagePayloadDialect: "v2", cursor: last.seq - 1, deliveryIntents: {}, terminalEvidence: {},
    epochSessionRoutingInitialized: true, legacySessionEpochId: "", ...(memory ? {documentsGiven: structuredClone(memory)} : {})};
  runtime.connectorSession = {sessionId: "s"};
  runtime.logs = [];
  runtime.logger = {info: (line) => runtime.logs.push(line), warn: (line) => runtime.logs.push(line), error: (line) => runtime.logs.push(line)};
  runtime.persisted = [];
  runtime.persistState = async () => { runtime.persisted.push(structuredClone(runtime.state.documentsGiven)); };
  runtime.client = {
    baseUrl: room.baseUrl,
    readEvents: async (_state, afterSeq) => ({activeEpochId: room.epochId, activeEpochStartsAtSeq: 41,
      events: events.filter((item) => item.seq > afterSeq).slice(0, 100)}),
    roomState: async () => room.state(last.seq),
    roomPolicy: async () => ({policy: {coordinationMode: "coordinated"}}),
    listArtifacts: () => room.listArtifacts(),
    getArtifact: (session, artifactId) => room.getArtifact(session, artifactId),
    startDiscussionCycle: async () => { throw new Error("no cycle start in this suite"); },
    claimDiscussionAttempt: async () => structuredClone(claim),
    acknowledge: async (_state, seq) => ({acknowledgedSeq: seq}),
    acknowledgePeerContribution: async () => ({}),
  };
  runtime.renewAccess = async () => false;
  runtime.maintainPresence = async () => {};
  runtime.markContextAcknowledged = async () => {};
  runtime.startAttemptLease = () => null;
  const controller = new AbortController();
  const turns = runtime.assignedTurns(controller.signal);
  const {value, done} = await turns.next();
  controller.abort();
  await turns.return();
  assert.equal(done, false, "a turn is yielded");
  return {turn: value, runtime};
}

const documentBlock = (text) => {
  const startAt = text.indexOf(HEADER);
  return startAt < 0 ? "" : text.slice(startAt, text.indexOf(FOOTER, startAt) + FOOTER.length);
};
const reference = (name, artifactId, versionId, size, {given, tool = true}) => {
  const line = `Document: ${name} · artifact/version ${artifactId} / ${versionId} · ${size} characters`;
  const clauses = [...(given ? ["given in full on your first turn of this discussion"] : []), ...(tool ? [`read passages with ${TOOL}`] : [])];
  return clauses.length ? `${line} · ${clauses.join("; ")}` : line;
};
const sessionKeyFor = (epochId) => `agent:main:${ID}:group:${epochConversationId("room-1", epochId)}`;

// One agent's turns in one discussion, with the memory written after each run.
class Discussion {
  constructor(room) {
    this.room = room;
    this.memory = undefined;
    this.seq = 49;
  }

  async turn({mark = true, event, claim, beforeMark} = {}) {
    this.seq += 1;
    const epochId = this.room.epochId;
    const ready = event ?? readyFor(this.seq, epochId);
    const {turn, runtime} = await turnFor(this.room, [start(epochId), humanSource(epochId), ready], {memory: this.memory, claim});
    if (beforeMark) beforeMark();
    if (mark) {
      await runtime.markDocumentsGiven(turn.id);
      this.memory = structuredClone(runtime.state.documentsGiven);
    }
    this.runtime = runtime;
    return turn.text;
  }
}

const toolCaller = (room) => async (args) => readRoomDocument({client: room.client(),
  session: {roomId: "room-1", credential: "fixture-credential", baseUrl: room.baseUrl}, args});

beforeEach(() => {
  documents.resetDocumentRuntimeMemory?.();
});

test("conformance P7d case names resolve to tests in this suite; constants pinned", async () => {
  const cases = Object.entries(conformance.parityP7dCases ?? {});
  assert.equal(cases.length, 17);
  const source = await readFile(new URL(import.meta.url), "utf8");
  for (const [key, name] of cases) {
    assert.ok(name.startsWith(`${key} `), name);
    assert.ok(source.includes(`test(${JSON.stringify(name)}`), name);
  }
  assert.deepEqual(conformance.parityP7dConstants, {
    toolName: documents.DOCUMENT_TOOL_NAME, fullTextLimit: documents.DOCUMENT_FULL_TEXT_LIMIT,
    turnCharacterLimit: documents.DOCUMENT_TURN_CHARACTER_LIMIT, toolResultLimit: documents.DOCUMENT_TOOL_RESULT_LIMIT,
    queryCharacterLimit: documents.DOCUMENT_QUERY_CHARACTER_LIMIT, contextLines: documents.DOCUMENT_CONTEXT_LINES,
    givenLimit: documents.DOCUMENTS_GIVEN_LIMIT, cacheVersions: documents.DOCUMENT_CACHE_VERSIONS,
    cacheCharacters: documents.DOCUMENT_CACHE_CHARACTERS, libraryLimit: documents.DOCUMENT_LIBRARY_LIMIT,
  });
});

test("P7d-01 a discussion document of at most 24,000 characters is given in full on the agent's first turn and named by its reference line on every later turn", async () => {
  const room = new Room({brief: record("brief", {v1: ["ready", PROOF_TEXT]})}, [], {documentsList: [entry("brief")]});
  const discussion = new Discussion(room);
  const first = await discussion.turn();
  const block = documentBlock(first);
  assert.equal(first.split(PROOF_TEXT.trim()).length - 1, 1);
  assert.ok(block.includes(`Document: brief.md\nArtifact/version: brief / v1\nMedia type: text/markdown\nSHA-256: ${"d".repeat(64)}\nExtraction status: ready.\nContent:\n${PROOF_TEXT.trim()}`));
  assert.ok(!block.includes(" characters · "));
  assert.deepEqual(discussion.memory, {epochId: "epoch-z", hostSession: "", given: ["brief/v1"]});
  for (let turn = 2; turn <= 8; turn += 1) {
    const later = await discussion.turn();
    assert.ok(!later.includes(PROOF_TEXT.slice(0, 200)));
    assert.equal(documentBlock(later), [documents.DOCUMENT_CONTEXT_HEADER,
      reference("brief.md", "brief", "v1", codePointLength(PROOF_TEXT), {given: true}), FOOTER].join("\n\n"));
  }
  // One Room read of the text for the whole discussion (P7d-5 cache).
  assert.deepEqual(room.reads, ["brief"]);
});

test("P7d-02 the document tool returns the first lines, a line range or the lines matching a query, bounded, and coded refusals", async () => {
  const text = generatedText(LINES, 900);
  const lines = text.split("\n");
  const room = new Room({
    report: record("report", {v1: ["ready", text]}),
    pending: record("pending", {v1: ["pending", null]}),
    secret: apiError(403),
    blank: record("blank", {v1: ["ready", null]}),
    gone: apiError(404),
    busy: apiError(429, 7),
    edge: new RoomResponseError("proxy page", {status: 403}),
    down: new RoomTransportError(new Error("ECONNRESET")),
    guide: record("guide", {v9: ["ready", "Guideline line one.\nGuideline line two."]}),
  }, [{artifactId: "guide", visibility: "room_shared", currentVersion: {versionId: "v9", name: "guide.pdf"}}],
  {documentsList: ["report", "pending", "secret", "blank", "gone", "busy", "edge", "down"].map((name) => entry(name))});
  const call = toolCaller(room);

  const first = await call({artifactId: "report"});
  assert.equal(first.success, true);
  assert.deepEqual([first.name, first.artifactId, first.versionId], ["report.md", "report", "v1"]);
  assert.deepEqual([first.totalLines, first.totalCharacters], [900, codePointLength(text)]);
  assert.ok(codePointLength(first.text) <= documents.DOCUMENT_TOOL_RESULT_LIMIT);
  assert.equal(first.truncated, true);
  const returned = first.returnedLines;
  assert.equal(returned[0], 1);
  assert.equal(first.nextFromLine, returned[1] + 1);
  assert.equal(first.text, Array.from({length: returned[1]}, (_, index) => `${index + 1}: ${lines[index]}`).join("\n"));
  assert.equal(first.note, documents.DOCUMENT_RESULT_NOTE);

  const ranged = await call({artifactId: "report", fromLine: 10, toLine: 12});
  assert.equal(ranged.text, [10, 11, 12].map((n) => `${n}: ${lines[n - 1]}`).join("\n"));
  assert.deepEqual([ranged.returnedLines, ranged.truncated, ranged.nextFromLine], [[10, 12], false, 13]);
  const tail = await call({artifactId: "report", fromLine: 899});
  assert.deepEqual([tail.returnedLines, tail.truncated, tail.nextFromLine], [[899, 900], false, null]);
  const beyond = await call({artifactId: "report", fromLine: 5000});
  assert.deepEqual([beyond.text, beyond.returnedLines, beyond.nextFromLine], ["", null, null]);

  const wanted = LINES[3].split(/\s+/)[1];
  const found = await call({artifactId: "report", query: wanted.toUpperCase()});
  const matching = lines.flatMap((line, index) => (line.toLowerCase().includes(wanted.toLowerCase()) ? [index + 1] : []));
  assert.deepEqual([found.query, found.matches], [wanted.toUpperCase(), matching.length]);
  assert.equal(found.truncated, true);
  assert.ok(codePointLength(found.text) <= documents.DOCUMENT_TOOL_RESULT_LIMIT);
  const shown = found.text.split("\n").filter((line) => line !== "…").map((line) => Number(line.split(":")[0]));
  assert.equal(shown[0], Math.max(1, matching[0] - 3));
  assert.deepEqual(found.returnedLines, [shown[0], shown.at(-1)]);
  assert.equal(found.nextFromLine, null);
  assert.ok(!found.text.includes("…\n…"));
  const words = await call({artifactId: "report", query: `zz-not-there ${wanted}`});
  assert.equal(words.matches, matching.length);
  const none = await call({artifactId: "report", query: "zz-not-there qq"});
  assert.deepEqual([none.matches, none.text, none.returnedLines, none.truncated], [0, "", null, false]);
  const library = await call({artifactId: "guide"});
  assert.deepEqual([library.versionId, library.text], ["v9", "1: Guideline line one.\n2: Guideline line two."]);

  for (const args of [{}, {artifactId: ""}, {artifactId: 7}, {artifactId: "report", fromLine: 0}, {artifactId: "report", fromLine: true},
    {artifactId: "report", fromLine: 5, toLine: 4}, {artifactId: "report", query: "x", fromLine: 2},
    {artifactId: "report", query: "x".repeat(201)}, {artifactId: "x".repeat(129)}, {artifactId: "report", versionId: 3}]) {
    assert.equal((await call(args)).code, "invalid_arguments", JSON.stringify(args));
  }
  const expected = {
    elsewhere: ["not_in_discussion", {}], pending: ["not_ready", {extractionStatus: "pending"}], secret: ["not_readable", {}],
    blank: ["not_readable", {}], gone: ["not_found", {}], busy: ["rate_limited", {retryAfter: 7}], edge: ["unavailable", {}],
    down: ["unavailable", {}],
  };
  for (const [artifactId, [code, extra]] of Object.entries(expected)) {
    const answer = await call({artifactId});
    assert.deepEqual([answer.success, answer.code], [false, code], artifactId);
    for (const [key, value] of Object.entries(extra)) assert.equal(answer[key], value, artifactId);
    assert.deepEqual(Object.keys(answer).filter((key) => !["retryAfter", "extractionStatus"].includes(key)).sort(), ["code", "error", "success"]);
  }
  assert.equal((await call({artifactId: "report", versionId: "v7"})).code, "not_in_discussion");
});

test("P7d-03 a document larger than 24,000 characters is named by its reference line from the start when the tool is offered", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({long: record("long", {v1: ["ready", LARGE_TEXT]})}, [], {documentsList: [entry("long")]});
  const discussion = new Discussion(room);
  for (let turn = 0; turn < 3; turn += 1) {
    const text = await discussion.turn();
    assert.equal(documentBlock(text), [documents.DOCUMENT_CONTEXT_HEADER,
      reference("long.md", "long", "v1", codePointLength(LARGE_TEXT), {given: false}), FOOTER].join("\n\n"));
    assert.ok(!text.includes(LARGE_TEXT.slice(0, 100)));
  }
  assert.ok(codePointLength(LARGE_TEXT) > documents.DOCUMENT_FULL_TEXT_LIMIT);
  assert.deepEqual(discussion.memory.given, []);
  // 24,000 characters is still given in full; one more is not.
  const exact = codePointSlice(LARGE_TEXT, 24_000);
  const over = codePointSlice(LARGE_TEXT, 24_001);
  const both = new Room({exact: record("exact", {v1: ["ready", exact]}), over: record("over", {v1: ["ready", over]})}, [],
    {documentsList: [entry("exact"), entry("over")]});
  const text = await new Discussion(both).turn();
  assert.ok(text.includes(pyStrip(exact)));
  assert.ok(text.includes(reference("over.md", "over", "v1", 24_001, {given: false})));
  assert.ok(!text.includes(over));
});

test("P7d-04 documents given in full on one turn share 64,000 characters newest first; one that does not fit is referenced, never cut, and given on a later turn", async () => {
  documents.noteDocumentToolAvailable();
  const texts = Object.fromEntries(["d1", "d2", "d3"].map((name) => [name, codePointSlice(`[${name}] ${generatedText(LINES, 2000)}`, 23_000)]));
  texts.d4 = "A short note.";
  const room = new Room(Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, record(name, {v1: ["ready", text]})])), [],
    {documentsList: ["d1", "d2", "d3", "d4"].map((name) => entry(name))});
  const discussion = new Discussion(room);
  const first = documentBlock(await discussion.turn());
  for (const name of ["d1", "d2", "d4"]) assert.ok(first.includes(`Content:\n${pyStrip(texts[name])}`), name);
  assert.ok(!first.includes("[d3]"));
  assert.ok(first.indexOf("Artifact/version: d2") < first.indexOf("Artifact/version: d4"));
  assert.ok(first.endsWith(`${reference("d3.md", "d3", "v1", 23_000, {given: false})}\n\n${FOOTER}`));
  assert.deepEqual(discussion.memory.given, ["d1/v1", "d2/v1", "d4/v1"]);
  const second = documentBlock(await discussion.turn());
  assert.ok(second.includes(`Content:\n${pyStrip(texts.d3)}`));
  assert.equal(second.split("Content:").length - 1, 1);
  assert.ok(second.includes(reference("d1.md", "d1", "v1", 23_000, {given: true})));
  const third = documentBlock(await discussion.turn());
  assert.ok(!third.includes("Content:"));
  assert.equal(third.split("\nDocument: ").length - 1, 4);
});

test("P7d-05 a document added during the discussion is given in full on the agent's next turn", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({a: record("a", {v1: ["ready", "First document."]}), b: record("b", {v1: ["ready", "Second document, added later."]})}, [],
    {documentsList: [entry("a")]});
  const discussion = new Discussion(room);
  assert.ok((await discussion.turn()).includes("Content:\nFirst document."));
  room.documentsList = [entry("b", "v1", {seq: 55}), entry("a")];
  const second = documentBlock(await discussion.turn());
  assert.ok(second.includes("Content:\nSecond document, added later."));
  assert.ok(!second.includes("First document."));
  assert.ok(second.includes(reference("a.md", "a", "v1", 15, {given: true})));
  assert.ok(!documentBlock(await discussion.turn()).includes("Content:"));
});

test("P7d-06 a new version is a document of its own and is given in full again", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({a: record("a", {v1: ["ready", "Version one."], v2: ["ready", "Version two, revised."]})}, [],
    {documentsList: [entry("a")]});
  const discussion = new Discussion(room);
  assert.ok((await discussion.turn()).includes("Content:\nVersion one."));
  room.documentsList = [entry("a", "v2", {seq: 56}), entry("a")];
  const second = documentBlock(await discussion.turn());
  assert.ok(second.includes("Artifact/version: a / v2\n"));
  assert.ok(second.includes("Content:\nVersion two, revised."));
  assert.ok(second.includes(reference("a.md", "a", "v1", 12, {given: true})));
  assert.deepEqual(discussion.memory.given, ["a/v1", "a/v2"]);
  // Without versionId the tool reads the first listed version.
  const answer = await toolCaller(room)({artifactId: "a"});
  assert.deepEqual([answer.versionId, answer.text], ["v2", "1: Version two, revised."]);
  assert.equal((await toolCaller(room)({artifactId: "a", versionId: "v1"})).text, "1: Version one.");
});

test("P7d-07 the memory of what was given is in the state file and survives a restart", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({brief: record("brief", {v1: ["ready", PROOF_TEXT]})}, [], {documentsList: [entry("brief")]});
  const discussion = new Discussion(room);
  await discussion.turn();
  const directory = await mkdtemp(join(home, "state-"));
  const path = join(directory, "accounts", "room.json");
  const state = {version: 1, baseUrl: room.baseUrl, roomId: "room-1", membershipId: "zurie", credential: "fixture-credential",
    clientInstanceId: "client-1", cursor: 0, documentsGiven: discussion.memory};
  await saveNewState(path, state);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).documentsGiven, {epochId: "epoch-z", hostSession: "", given: ["brief/v1"]});
  const loaded = await loadState(path);
  for (const invalid of [{epochId: "epoch-z", hostSession: "", given: Array(65).fill("k")},
    {epochId: "epoch-z", hostSession: "", given: [], names: ["brief.md"]}, {epochId: "", hostSession: "", given: []}, ["brief/v1"]]) {
    assert.throws(() => validateState({...state, documentsGiven: invalid}), /document memory is invalid/, JSON.stringify(invalid));
  }
  // Written after the run through the runtime's own persist and read back.
  const merged = join(directory, "accounts", "merged.json");
  await saveNewState(merged, {...state, documentsGiven: undefined});
  const persisting = new OpenClawRoomRuntime({accountId: "m", stateFile: merged, baseUrl: room.baseUrl});
  persisting.state = await loadState(merged);
  persisting.documentsOffered = new Map([["ready-9", {epochId: "epoch-z", conversationId: "c", hostSession: "", given: [], offered: ["brief/v1"]}]]);
  await persisting.markDocumentsGiven("ready-9");
  assert.deepEqual((await loadState(merged)).documentsGiven, {epochId: "epoch-z", hostSession: "", given: ["brief/v1"]});
  documents.TEXT_CACHE.clear(); // a new process has no texts
  discussion.memory = structuredClone(loaded.documentsGiven);
  const afterRestart = await discussion.turn();
  assert.ok(!afterRestart.includes(PROOF_TEXT.slice(0, 200)));
  assert.ok(afterRestart.includes(reference("brief.md", "brief", "v1", codePointLength(PROOF_TEXT), {given: true})));
});

test("P7d-08 a new discussion starts the memory empty", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({brief: record("brief", {v1: ["ready", "The brief."]})}, [], {documentsList: [entry("brief")]});
  const discussion = new Discussion(room);
  await discussion.turn();
  assert.ok(!documentBlock(await discussion.turn()).includes("Content:"));
  room.epochId = "epoch-y";
  assert.ok((await discussion.turn()).includes("Content:\nThe brief."));
  assert.deepEqual(discussion.memory, {epochId: "epoch-y", hostSession: "", given: ["brief/v1"]});
});

test("P7d-09 a changed host session gives the documents in full again", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({brief: record("brief", {v1: ["ready", "The brief."]})}, [], {documentsList: [entry("brief")]});
  const key = sessionKeyFor("epoch-z");
  const discussion = new Discussion(room);
  documents.noteHostSession(key, "session-1");
  assert.ok((await discussion.turn()).includes("Content:\nThe brief."));
  assert.equal(discussion.memory.hostSession, "session-1");
  assert.ok(!documentBlock(await discussion.turn()).includes("Content:"));
  // The host replaced the session (reset) before the turn.
  documents.noteHostSession(key, "session-2");
  assert.ok((await discussion.turn()).includes("Content:\nThe brief."));
  assert.equal(discussion.memory.hostSession, "session-2");
  // The connector learned the new session only during the turn: that turn had
  // the reference only, so the next one gives the text again.
  const late = new Discussion(room);
  documents.noteHostSession(key, "session-1");
  await late.turn();
  const text = await late.turn({beforeMark: () => documents.noteHostSession(key, "session-3")});
  assert.ok(!documentBlock(text).includes("Content:"));
  assert.deepEqual(late.memory, {epochId: "epoch-z", hostSession: "session-3", given: []});
  assert.ok((await late.turn()).includes("Content:\nThe brief."));
  // The host session reaches the connector through a tool call of a Room
  // session (before_tool_call) and through the document tool's context.
  documents.resetDocumentRuntimeMemory();
  channelModule.roomToolCallPolicy({config: ISOLATED_HOST_CONFIG, logger: {warn: () => {}}}, {noteWebRead: true})(
    {toolName: "memory_search", params: {}}, {sessionKey: key, sessionId: "session-4"});
  assert.equal(documents.observedHostSession(epochConversationId("room-1", "epoch-z")), "session-4");
  const registered = [];
  registerRoomDocumentTool({registerTool: (factory, options) => registered.push([factory, options])});
  registered[0][0]({sessionKey: key, sessionId: "session-5"});
  assert.equal(documents.observedHostSession(epochConversationId("room-1", "epoch-z")), "session-5");
  // Another channel's session changes nothing.
  documents.noteHostSession("agent:main:telegram:group:room-1:epoch:x", "session-6");
  assert.equal(documents.observedHostSession(epochConversationId("room-1", "epoch-z")), "session-5");
});

test("P7d-10 the closing-summary turn follows the same rule: in full on the summariser's first turn, referenced after", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({brief: record("brief", {v1: ["ready", "The brief."]})}, [], {documentsList: [entry("brief")]});
  const summary = (seq) => readyFor(seq, "epoch-z", "term-56", {phase: "summary", phaseInstruction: "You are Zurie in this Room. Write the closing summary."});
  const claim = {attempt: {id: "attempt-9", round: 1, membershipId: "zurie", phase: "summary"},
    cycle: {id: "cycle-9", generation: 1, totalTurns: 0, sourceEventId: "term-56", budgets: {totalTurns: 1}}};
  // A summariser who did not debate: its first turn of the discussion.
  const newcomer = new Discussion(room);
  let text = await newcomer.turn({event: summary(57), claim});
  assert.ok(text.includes("Write the closing summary."));
  assert.ok(text.includes("Content:\nThe brief."));
  // A summariser who debated: the reference line only.
  const debater = new Discussion(room);
  await debater.turn();
  text = await debater.turn({event: summary(58), claim});
  assert.ok(!documentBlock(text).includes("Content:"));
  assert.ok(text.includes(reference("brief.md", "brief", "v1", 10, {given: true})));
});

test("P7d-11 when the tool is not known to be offered a large document gives its first 24,000 characters once, marked as cut, and the reference line names the tool unless it is known not to be offered", async () => {
  // OpenClaw cannot know the tool to be absent: unknown, which counts as offered.
  const small = "A short brief.";
  const room = new Room({small: record("small", {v1: ["ready", small]}), long: record("long", {v1: ["ready", LARGE_TEXT]})}, [],
    {documentsList: [entry("small"), entry("long")]});
  const head = pyStrip(codePointSlice(LARGE_TEXT, 24_000));
  const size = codePointLength(LARGE_TEXT);
  assert.equal(documents.documentToolState(), "unknown");
  const discussion = new Discussion(room);
  const first = documentBlock(await discussion.turn());
  assert.ok(first.includes(`Content (cut: the first 24000 of ${size} characters):\n${head}`));
  assert.ok(!first.includes(codePointSlice(LARGE_TEXT, 24_100).slice(codePointSlice(LARGE_TEXT, 24_000).length)));
  assert.ok(first.endsWith(`${reference("long.md", "long", "v1", size, {given: false})}\n\n${FOOTER}`));
  assert.deepEqual(discussion.memory.given, ["small/v1", "long/v1"]);
  const second = documentBlock(await discussion.turn());
  assert.ok(!second.includes("Content"));
  assert.equal(second, [documents.DOCUMENT_CONTEXT_HEADER,
    `${reference("small.md", "small", "v1", codePointLength(small), {given: true})}\n${reference("long.md", "long", "v1", size, {given: false})}`,
    FOOTER].join("\n\n"));
  // The same rendering with the tool known to be absent (Hermes can know it).
  const read = async (artifactId) => ({status: "ready", text: artifactId === "small" ? small : LARGE_TEXT});
  const absent = await documents.discussionDocumentContext([entry("small"), entry("long")], read, {given: ["small/v1"], tool: "unavailable"});
  assert.ok(absent.context.endsWith(`${reference("small.md", "small", "v1", 14, {given: true, tool: false})}\n${reference("long.md", "long", "v1", size, {given: false, tool: false})}\n\n${FOOTER}`));
  assert.ok(absent.context.includes(`Content (cut: the first 24000 of ${size} characters):\n${head}`));
  assert.equal(documents.referenceLine("x", "a", "v", 3, {given: false, tool: "unavailable"}), "Document: x · artifact/version a / v · 3 characters");
  // The status: unknown until a Room session calls the tool, then available.
  statusModule.resetLocalStatusWriters();
  const api = {config: ISOLATED_HOST_CONFIG, logger: {warn: () => {}}};
  const policy = channelModule.roomToolCallPolicy(api, {noteWebRead: true});
  const path = channelModule.roomStatusPath(ISOLATED_HOST_CONFIG);
  channelModule.roomLocalStatus(api.logger, ISOLATED_HOST_CONFIG).setLoaded(true);
  assert.equal(JSON.parse(await readFile(path, "utf8")).documentTool, "unknown");
  policy({toolName: TOOL, params: {artifactId: "a"}}, {sessionKey: "agent:main:telegram:group:x", sessionId: "t"});
  assert.equal(JSON.parse(await readFile(path, "utf8")).documentTool, "unknown");
  policy({toolName: TOOL, params: {artifactId: "a"}}, {sessionKey: sessionKeyFor("epoch-z"), sessionId: "s"});
  assert.equal(JSON.parse(await readFile(path, "utf8")).documentTool, "available");
  assert.equal(documents.documentToolState(), "available");
});

test("P7d-12 a Room state without activeTopic.documents keeps the P5 rule unchanged", async () => {
  const brief = {brief: {artifactId: "brief", visibility: "room_shared",
    currentVersion: {versionId: "v1", name: "brief.md", extractionStatus: "ready", extractedText: "The P5 brief."}}};
  const attachments = [{artifactId: "brief", versionId: "v1", name: "brief.md", mediaType: "text/markdown", sha256: "c".repeat(64)}];
  for (const [label, topic] of [["no activeTopic", false], ["no documents field", true]]) {
    const room = new Room(brief, [], {documentsList: null, topic});
    let memory;
    for (let turn = 0; turn < 3; turn += 1) {
      const events = [start("epoch-z"), humanSource("epoch-z", {attachments}), readyFor(50 + turn, "epoch-z")];
      const {turn: built, runtime} = await turnFor(room, events, {memory});
      assert.equal(built.text.split("Content:\nThe P5 brief.").length - 1, 1, label);
      assert.ok(!built.text.includes(" characters · "), label);
      await runtime.markDocumentsGiven(built.id);
      memory = runtime.state.documentsGiven;
      assert.equal(memory, undefined, label);
    }
  }
});

test("P7d-13 a pending extraction is not marked given, and a failed host run marks nothing", async () => {
  documents.noteDocumentToolAvailable();
  const room = new Room({scan: record("scan", {v1: ["pending", null]})}, [], {documentsList: [entry("scan")]});
  const discussion = new Discussion(room);
  const first = documentBlock(await discussion.turn());
  assert.ok(first.includes("Extraction status: pending.\nContent is not yet available to this membership."));
  assert.deepEqual(discussion.memory.given, []);
  room.records.scan = record("scan", {v1: ["ready", "Scanned text."]});
  assert.ok((await discussion.turn()).includes("Content:\nScanned text."));
  assert.deepEqual(room.reads, ["scan", "scan"]);
  assert.deepEqual(discussion.memory.given, ["scan/v1"]);
  // The mark follows the host run: the channel asks for it only after the run
  // returned; a run that threw marks nothing.
  for (const [outcome, expected] of [["failure", []], ["success", ["event-1"]]]) {
    const marked = [];
    const event = {id: "event-1", sourceEventId: "event-1", respondsToId: "event-1", roomId: "room-1", epochId: "epoch-z",
      conversationId: "room-1:epoch:x", senderId: "owner-tj", senderName: "TJE", senderKind: "human", text: "question", occurredAt: 1, raw: {}};
    const client = {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* () { yield event; },
      markTurnReading: async () => {},
      markDocumentsGiven: async (eventId) => { marked.push(eventId); },
      postAndFinish: async () => ({eventId: "posted", sentAt: 1}),
      recordSkipped: async () => {},
      ack: async () => {},
      close: async () => {},
    };
    const channel = channelModule.createRoomChannel({makeClient: () => client});
    let status = {running: false, connected: false};
    const ctx = {account: {accountId: "default", stateFile: join(home, `channel-${outcome}.json`)}, accountId: "default",
      abortSignal: new AbortController().signal, cfg: ISOLATED_HOST_CONFIG, getStatus: () => status, setStatus: (next) => { status = next; },
      log: {info: () => {}, warn: () => {}, error: () => {}},
      channelRuntime: {
        inbound: {run: async () => { if (outcome === "failure") throw new Error("host run failed"); }},
        routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "s", mainSessionKey: "m"})},
        session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
        reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
      }};
    await channel.plugin.gateway.startAccount(ctx).catch(() => {});
    assert.deepEqual(marked, expected, outcome);
  }
});

test("P7d-14 no document name, text or id in the status file and no name or text in a log line", async () => {
  documents.noteDocumentToolAvailable();
  const secretName = "Diagnosis-Maier-2026.md";
  const text = "Confidential finding: stage II." + " Detail line.".repeat(50);
  const room = new Room({doc: record("doc", {v1: ["ready", text]}), long: record("long", {v1: ["ready", LARGE_TEXT]})}, [],
    {documentsList: [entry("doc", "v1", {name: secretName}), entry("long", "v1", {name: secretName})]});
  const discussion = new Discussion(room);
  await discussion.turn();
  const logs = [...discussion.runtime.logs];
  await discussion.turn();
  logs.push(...discussion.runtime.logs);
  const toolLines = [];
  const session = {roomId: "room-1", credential: "fixture-credential", baseUrl: room.baseUrl};
  await readRoomDocument({client: room.client(), session, args: {artifactId: "doc", query: "stage"}, logger: {info: (line) => toolLines.push(line)}});
  await readRoomDocument({client: room.client(), session, args: {artifactId: "nowhere"}, logger: {info: (line) => toolLines.push(line)}});
  const logged = [...logs, ...toolLines].join("\n");
  for (const fragment of [secretName, "Confidential", "stage II", LARGE_TEXT.slice(0, 40)]) assert.ok(!logged.includes(fragment), fragment);
  assert.ok(logged.includes("documents for ready-50: full=1 head=0 reference=1 status=0 left_out=0 tool=available"), logged);
  assert.ok(logged.includes("document read: artifact=doc version=- code=ok"));
  assert.ok(logged.includes("document read: artifact=nowhere version=- code=not_in_discussion"));
  assert.deepEqual(Object.keys(discussion.memory).sort(), ["epochId", "given", "hostSession"]);
  assert.ok(!JSON.stringify(discussion.memory).includes(secretName));
  const path = join(await mkdtemp(join(home, "status-")), "status.json");
  const status = new statusModule.LocalStatus(path, {version: "0.2.67", hostLabel: "host"});
  status.setDocumentTool("available");
  status.room("room-1", "zurie", {connection: "connected"});
  const written = await readFile(path, "utf8");
  for (const fragment of [secretName, "Confidential", "doc/v1", "brief"]) assert.ok(!written.includes(fragment), fragment);
  assert.equal(JSON.parse(written).documentTool, "available");
});

test("P7d-15 the shared render and tool vectors are reproduced exactly", async () => {
  const vector = conformance.parityP7dRenderVector;
  const materialise = (key) => {
    const spec = vector.texts[key];
    if (!("lines" in spec)) return spec.text ?? null;
    const begin = spec.from ?? 0;
    const full = generatedText(LINES, spec.lines);
    return codePointSlice(full.slice(codePointSlice(full, begin).length), spec.characters);
  };
  for (const item of vector.cases) {
    const read = async (artifactId, versionId) => {
      const spec = vector.texts[`${artifactId}/${versionId}`];
      if (spec.error) throw new documents.DocumentReadError(spec.error);
      return {status: spec.status ?? "ready", text: materialise(`${artifactId}/${versionId}`)};
    };
    const listed = documents.discussionDocuments({activeTopic: {documents: item.documents}});
    const {context, offered} = await documents.discussionDocumentContext(listed, read, {given: item.given, tool: item.tool, catalog: item.catalog ?? ""});
    assert.deepEqual(context.split("\n").filter((line) => line.startsWith("Document: ") && line.includes(" characters")), item.referenceLines, item.name);
    assert.deepEqual(offered, item.offered, item.name);
    assert.deepEqual([codePointLength(context), createHash("sha256").update(context).digest("hex")], [item.characters, item.sha256], item.name);
  }
  for (const document of conformance.parityP7dToolVector.documents) {
    const text = "lines" in document ? generatedText(LINES, document.lines)
      : document.textLines.map((item) => (typeof item === "string" ? item : item.repeat.repeat(item.times))).join("\n");
    for (const call of document.calls) {
      const {arguments: argumentsValue, refused} = documents.toolArguments(call.arguments);
      if (refused) {
        assert.deepEqual(refused, call.expected, call.name);
        continue;
      }
      const answer = documents.documentPassages(document.name, "doc", "v1", text, argumentsValue);
      const {textSha256, textCharacters, ...expected} = call.expected;
      const {text: body, ...rest} = answer;
      assert.deepEqual(rest, expected, call.name);
      assert.deepEqual([codePointLength(body), createHash("sha256").update(body).digest("hex")], [textCharacters, textSha256], call.name);
    }
  }
});

test("P7d-16 only a version the discussion lists or the library catalog shows is read; unreadable entries are left out and the result is bounded", async () => {
  documents.noteDocumentToolAvailable();
  const longLine = "Evidence ".repeat(1200);
  const room = new Room({
    shared: record("shared", {v1: ["ready", `Shared text.\n${longLine}`]}),
    hidden: record("hidden", {v1: ["ready", "Owner-only text."]}),
    meta: record("meta", {v1: ["ready", "Metadata-only text."]}),
    denied: apiError(403),
    empty: record("empty", {v1: ["ready", null]}),
    other: record("other", {v1: ["ready", "Another discussion's text."]}),
  }, [{artifactId: "shared", visibility: "room_shared", currentVersion: {versionId: "v1", name: "shared.md", mediaType: "text/markdown",
    sha256: "e".repeat(64), extractionStatus: "ready"}},
  ...Array.from({length: 32}, (_, index) => ({artifactId: `lib-${index}`, visibility: "room_shared",
    currentVersion: {versionId: "v1", name: `lib-${index}.pdf`}}))],
  {documentsList: [entry("shared"), entry("hidden", "v1", {classification: "human_only"}), entry("meta", "v1", {classification: "metadata_only"}),
    entry("denied"), entry("empty")]});
  const text = await new Discussion(room).turn();
  const block = documentBlock(text);
  assert.deepEqual(room.reads, ["shared", "denied", "empty"]);
  for (const absent of ["hidden", "meta", "denied", "empty", "Owner-only", "Metadata-only"]) assert.ok(!block.includes(absent), absent);
  // The library catalog leaves out every listed exact version.
  assert.ok(!text.includes("shared.md · artifact/version shared / v1"));
  assert.ok(text.includes("lib-0.pdf · artifact/version lib-0 / v1"));
  room.reads.length = 0;
  const call = toolCaller(room);
  for (const artifactId of ["other", "hidden", "meta", "lib-31"]) assert.equal((await call({artifactId})).code, "not_in_discussion", artifactId);
  assert.deepEqual(room.reads, []);
  assert.equal((await call({artifactId: "lib-30"})).code, "not_found");
  // The bound: a line that does not fit alone is cut and ends in "…".
  const cut = await call({artifactId: "shared", fromLine: 2});
  assert.equal(codePointLength(cut.text), documents.DOCUMENT_TOOL_RESULT_LIMIT);
  assert.ok(cut.text.startsWith("2: Evidence ") && cut.text.endsWith("…"));
  assert.deepEqual([cut.returnedLines, cut.truncated, cut.nextFromLine], [[2, 2], true, null]);
  const both = await call({artifactId: "shared"});
  assert.deepEqual([both.text, both.truncated, both.nextFromLine], ["1: Shared text.", true, 2]);
  // Inside a Room turn the tool reads the turn's own Room.
  const asked = [];
  const registered = [];
  registerRoomDocumentTool({registerTool: (factory, options) => registered.push([factory, options]), logger: null}, {
    makeClient: () => room.client(),
    resolve: async (requested) => { asked.push(requested); return {session: {roomId: "room-1", credential: "c", baseUrl: room.baseUrl}}; },
  });
  const [factory, options] = registered[0];
  assert.deepEqual(options, {name: TOOL});
  const tool = factory({sessionKey: sessionKeyFor("epoch-z"), sessionId: "session-7"});
  await tool.execute("call-1", {artifactId: "shared"});
  await tool.execute("call-2", {artifactId: "shared", room: "room-9"});
  assert.deepEqual(asked, ["room-1", "room-9"]);
  const several = [];
  registerRoomDocumentTool({registerTool: (made) => several.push(made)}, {resolve: async () => ({choices: [{roomId: "a"}, {roomId: "b"}]})});
  const answer = await several[0]({}).execute("call-3", {artifactId: "shared"});
  assert.deepEqual(answer.details, {success: false, selectionRequired: true, rooms: [{roomId: "a"}, {roomId: "b"}]});
});

function installedHost() {
  const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).peerDependencies.openclaw;
  const candidates = [process.env.OPENCLAW_HOST_ROOT];
  try { candidates.push(dirname(createRequire(join(root, "package.json")).resolve("openclaw/package.json"))); } catch {}
  candidates.push("/usr/local/lib/node_modules/openclaw");
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version === pinned) return candidate;
    } catch {}
  }
  return null;
}

test("P7d-17 the document tool is registered with the host and declared in the manifest", async (t) => {
  const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"));
  assert.deepEqual(manifest.contracts, {tools: ["synthetic_sociality_room_history", TOOL]});
  assert.deepEqual(Object.keys(ROOM_DOCUMENT_PARAMETERS.properties).sort(), ["artifactId", "fromLine", "query", "room", "toLine", "versionId"]);
  assert.deepEqual(ROOM_DOCUMENT_PARAMETERS.required, ["artifactId"]);
  const hostRoot = installedHost();
  if (!hostRoot) return t.skip("the pinned OpenClaw host is not installed");
  // Through the host's own plugin loader with the real manifest (the mock
  // registerTool cannot see a rejection: 2026.7.1-2 rejects every tool a
  // plugin did not declare in contracts.tools, as a diagnostic only).
  const scratch = await mkdtemp(join(home, "host-register-"));
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-plugin-register.mjs"), hostRoot, root], {
    env: {...process.env, HOME: scratch, JITI_FS_CACHE: "false"}, timeout: 120_000, maxBuffer: 1 << 20,
  });
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.plugin.toolNames, [TOOL, "synthetic_sociality_room_history"].sort(), JSON.stringify(result));
  assert.deepEqual(result.tools.flat().sort(), [TOOL, "synthetic_sociality_room_history"].sort(), JSON.stringify(result));
  assert.deepEqual(result.diagnostics.filter((item) => /contracts\.tools/.test(item.message)), [], JSON.stringify(result));
  assert.equal(result.plugin.failed, false);
});
