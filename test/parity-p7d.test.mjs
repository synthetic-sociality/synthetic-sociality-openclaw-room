// Parity P7d "Discussion documents: once in full, then on demand": contract
// section P7d (conformance parityP7dCases; Hermes implements the same names).
// The Room state's activeTopic.documents (Room server ebad3df and later) names
// the documents of the discussion. No test uses a real credential or talks to a
// live Room.
import assert from "node:assert/strict";
import test, {after, beforeEach} from "node:test";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {cp, mkdir, mkdtemp, readFile, readdir, rm, symlink} from "node:fs/promises";
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
const {readRoomDocument, registerRoomDocumentTool, ROOM_DOCUMENT_DESCRIPTION, ROOM_DOCUMENT_PARAMETERS} = await import("../src/document-tool.js").catch(() => ({}));
const historyModule = await import("../src/history.js");
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
async function turnFor(room, events, {memory, claim = claimed(), agentId} = {}) {
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
  // The agent the host routes the conversation to (the channel sets this).
  if (agentId) runtime.resolveRoomAgent = () => agentId;
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
  const clauses = [...(given ? ["given in full earlier in this discussion"] : []), ...(tool ? [`read passages with ${TOOL}`] : [])];
  return clauses.length ? `${line} · ${clauses.join("; ")}` : line;
};
const sessionKeyFor = (epochId) => `agent:main:${ID}:group:${epochConversationId("room-1", epochId)}`;

// One agent's turns in one discussion, with the memory written after each run.
class Discussion {
  constructor(room, {agentId} = {}) {
    this.room = room;
    this.agentId = agentId;
    this.memory = undefined;
    this.seq = 49;
  }

  async turn({mark = true, event, claim, beforeMark} = {}) {
    this.seq += 1;
    const epochId = this.room.epochId;
    const ready = event ?? readyFor(this.seq, epochId);
    const {turn, runtime} = await turnFor(this.room, [start(epochId), humanSource(epochId), ready], {memory: this.memory, claim, agentId: this.agentId});
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
  assert.equal(cases.length, 29);
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
    sizeVersions: documents.DOCUMENT_SIZE_VERSIONS, idForm: documents.ROOM_ID_FORM?.source, givenClause: documents.GIVEN_CLAUSE,
    roomMismatchError: documents.ROOM_MISMATCH_ERROR, toolDescription: ROOM_DOCUMENT_DESCRIPTION,
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
  // The status: unknown until a document read of a Room session succeeded
  // (review r2 N5); calling the tool alone, or a call that answered an error,
  // changes nothing.
  documents.resetDocumentRuntimeMemory();
  statusModule.resetLocalStatusWriters();
  const path = channelModule.roomStatusPath(ISOLATED_HOST_CONFIG);
  const registered = [];
  const hooks = {};
  // The channel's own full registration (the gateway's).
  const api = new Proxy({registrationMode: "full", config: ISOLATED_HOST_CONFIG, logger: {info() {}, warn() {}, error() {}},
    on(name, handler) { hooks[name] = handler; }, registerTool(factory) { registered.push(factory); }},
  {get: (target, property) => (property in target ? target[property] : () => undefined)});
  channelModule.createRoomChannel({makeClient: () => null}).registerFull(api);
  assert.equal(JSON.parse(await readFile(path, "utf8")).documentTool, "unknown");
  const roomSession = {agentId: "main", sessionKey: sessionKeyFor("epoch-z"), sessionId: "s"};
  hooks.before_tool_call({toolName: TOOL, params: {artifactId: "a"}}, roomSession);
  const channelTool = registered.map((factory) => factory(roomSession)).find((tool) => tool.name === TOOL);
  // No Room account in this gateway: the call answers an error.
  assert.equal((await channelTool.execute("c", {artifactId: "long"})).details.code, "no_room");
  assert.equal(JSON.parse(await readFile(path, "utf8")).documentTool, "unknown");
  assert.equal(documents.documentToolState(), "unknown");
  // The tool answered with an error: a large document keeps its first-turn head.
  const afterError = documentBlock(await new Discussion(new Room({long: record("long", {v1: ["ready", LARGE_TEXT]})}, [],
    {documentsList: [entry("long")]})).turn());
  assert.ok(afterError.includes(`Content (cut: the first 24000 of ${size} characters):\n${head}`));
  // Refused or failed reads of a Room session: still unknown.
  const sessionsOf = [{accountId: "t", roomId: "room-1", credential: "c", baseUrl: room.baseUrl, agentId: "main"}];
  let noted = 0;
  const made = [];
  registerRoomDocumentTool({registerTool: (factory) => made.push(factory)},
    {makeClient: () => room.client(), sessions: async () => sessionsOf, onAvailable: () => { noted += 1; }});
  const outside = made[0]({agentId: "main", sessionKey: "agent:main:telegram:group:x", sessionId: "t"});
  const inside = made[0](roomSession);
  for (const args of [{artifactId: "unknown"}, {artifactId: "long", room: "room-2"}, {artifactId: "long", query: "x", fromLine: 1}]) {
    assert.equal((await inside.execute("c", args)).details.success, false, JSON.stringify(args));
  }
  // A successful read outside a Room session says nothing about Room turns.
  assert.equal((await outside.execute("c", {artifactId: "long"})).details.success, true);
  assert.deepEqual([noted, documents.documentToolState()], [0, "unknown"]);
  assert.equal((await inside.execute("c", {artifactId: "long"})).details.success, true);
  assert.deepEqual([noted, documents.documentToolState()], [1, "available"]);
});

test("P7d-12 a Room state without activeTopic.documents keeps the P5 rule unchanged", async () => {
  const brief = {brief: {artifactId: "brief", visibility: "room_shared",
    currentVersion: {versionId: "v1", name: "brief.md", extractionStatus: "ready", extractedText: "The P5 brief."}}};
  const attachments = [{artifactId: "brief", versionId: "v1", name: "brief.md", mimeType: "text/markdown", sha256: "c".repeat(64)}];
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
  // Ids not in the Room's id form are logged as "invalid" (P7d-7, P7d-19).
  assert.ok(logged.includes("document read: artifact=invalid version=- code=ok"));
  assert.ok(logged.includes("document read: artifact=invalid version=- code=not_in_discussion"));
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
  }, [{artifactId: "shared", visibility: "room_shared", currentVersion: {versionId: "v1", name: "shared.md", mimeType: "text/markdown",
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
  // Inside a Room turn the tool reads the turn's own Room; another Room named
  // by the argument is refused (review B1: this test pinned the override).
  const used = [];
  const registered = [];
  registerRoomDocumentTool({registerTool: (factory, options) => registered.push([factory, options]), logger: null}, {
    makeClient: (session) => { used.push(session.roomId); return room.client(); },
    sessions: async () => [{accountId: "t", roomId: "room-1", credential: "c", baseUrl: room.baseUrl, agentId: "main"},
      {accountId: "u", roomId: "room-9", credential: "c9", baseUrl: room.baseUrl, agentId: "main"}],
  });
  const [factory, options] = registered[0];
  assert.deepEqual(options, {name: TOOL});
  const tool = factory({sessionKey: sessionKeyFor("epoch-z"), sessionId: "session-7"});
  assert.equal((await tool.execute("call-1", {artifactId: "shared"})).details.success, true);
  assert.equal((await tool.execute("call-2", {artifactId: "shared", room: "room-9"})).details.code, "room_mismatch");
  assert.deepEqual(used, ["room-1"]);
  const answer = await factory({}).execute("call-3", {artifactId: "shared"});
  assert.deepEqual(answer.details, {success: false, selectionRequired: true, rooms: [{accountId: "t", roomId: "room-1"}, {accountId: "u", roomId: "room-9"}]});
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
  assert.deepEqual(manifest.contracts, {tools: ["synthetic_sociality_room_history", TOOL, "synthetic_sociality_room_share_file"]});
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
  assert.deepEqual(result.plugin.toolNames, [TOOL, "synthetic_sociality_room_history", "synthetic_sociality_room_share_file"].sort(), JSON.stringify(result));
  assert.deepEqual(result.tools.flat().sort(), [TOOL, "synthetic_sociality_room_history", "synthetic_sociality_room_share_file"].sort(), JSON.stringify(result));
  assert.deepEqual(result.diagnostics.filter((item) => /contracts\.tools/.test(item.message)), [], JSON.stringify(result));
  assert.equal(result.plugin.failed, false);
});

// Rooms of one gateway: agent zurie with two accounts in Room A and one in Room
// B, agent aura with one account in Room C. Every request names the credential
// it carries.
function gatewayFixture() {
  const rooms = {rooma0000000001: {title: "Alpha", doc: "doca"}, roomb0000000002: {title: "Beta", doc: "docb"}, roomc0000000003: {title: "Gamma", doc: "docc"}};
  const accountsList = [["zurie-a", "rooma0000000001", "cred-za", "zurie"], ["zurie-a2", "rooma0000000001", "cred-za2", "zurie"],
    ["zurie-b", "roomb0000000002", "cred-zb", "zurie"], ["aura-c", "roomc0000000003", "cred-ac", "aura"]];
  const requests = [];
  const made = [];
  const api = {logger: {info: () => {}}, registerTool: (factory, options) => made.push([factory, options]),
    // The host's own route resolution decides an account's agent.
    runtime: {channel: {routing: {resolveAgentRoute: ({accountId}) => ({agentId: accountsList.find((item) => item[0] === accountId)[3]})}}}};
  const accounts = () => accountsList.map(([accountId]) => ({accountId, stateFile: `/state/${accountId}.json`}));
  const load = async (file) => {
    const [accountId, roomId, credential] = accountsList.find((item) => file.endsWith(`/${item[0]}.json`));
    return {roomId, credential, baseUrl: "https://room.example/api", membershipId: accountId};
  };
  const makeClient = (session) => {
    const spec = rooms[session.roomId];
    const log = (method) => requests.push([session.credential, method]);
    return {baseUrl: "https://room.example/api",
      roomState: async () => { log("state"); return {headSeq: 3, title: spec.title, activeEpoch: {id: "e1", startsAtSeq: 1}, activeTopic: {id: "t", documents: [entry(spec.doc)]}}; },
      listArtifacts: async () => { log("artifacts"); return {items: []}; },
      getArtifact: async (_session, id) => { log(`artifact ${id}`); return record(id, {v1: ["ready", `Text of ${spec.title}.`]}); },
      readEvents: async () => { log("events"); return {events: [], hasMore: false, headSeq: 3}; },
      listEpochs: async () => { log("epochs"); return {epochs: []}; },
    };
  };
  const sessions = (ctx) => historyModule.roomSessions(api, ctx, {accounts, load});
  registerRoomDocumentTool(api, {makeClient, sessions});
  historyModule.registerRoomHistoryTool(api, {makeClient, sessions});
  const call = async (ctx, name, args) => {
    const tools = Object.fromEntries(made.map(([factory]) => { const tool = factory(ctx); return [tool.name, tool]; }));
    return (await tools[name].execute("call", args)).details;
  };
  const credentials = () => [...new Set(requests.map(([credential]) => credential))];
  return {requests, call, credentials};
}

test("P7d-18 inside a Room turn the document, history and Room-context tools act only for the turn's own Room and account; another Room named by id, title or account id is refused room_mismatch and nothing of it is read; outside a Room turn only the calling agent's own Rooms are offered", async () => {
  const {requests, call, credentials} = gatewayFixture();
  const HISTORY = "synthetic_sociality_room_history";
  // OpenClaw registers no Room-context tool; the history and document tools.
  const zurieInA = {agentId: "zurie", agentAccountId: "zurie-a", sessionKey: `agent:zurie:${ID}:group:rooma0000000001:epoch:x`, sessionId: "s1"};
  for (const name of [TOOL, HISTORY]) {
    for (const other of ["roomb0000000002", "Beta", "beta", "zurie-b", "zurie-a2", "aura-c", "roomc0000000003"]) {
      assert.deepEqual(await call(zurieInA, name, {artifactId: "docb", room: other}),
        {success: false, code: "room_mismatch", error: documents.ROOM_MISMATCH_ERROR}, `${name} ${other}`);
    }
  }
  assert.deepEqual(requests, [], "no request leaves for a refused call");
  for (const own of [undefined, "rooma0000000001", "zurie-a"]) {
    const answer = await call(zurieInA, TOOL, own ? {artifactId: "doca", room: own} : {artifactId: "doca"});
    assert.equal(answer.text, "1: Text of Alpha.", JSON.stringify(answer));
  }
  assert.equal((await call(zurieInA, HISTORY, {})).selectionRequired, undefined);
  assert.equal((await call(zurieInA, TOOL, {artifactId: "docb"})).code, "not_in_discussion");
  assert.deepEqual(credentials(), ["cred-za"]);
  // Two accounts of the agent in one Room: the turn's account, no selection.
  requests.length = 0;
  documents.TEXT_CACHE.clear();
  const secondAccount = {...zurieInA, agentAccountId: "zurie-a2"};
  assert.equal((await call(secondAccount, TOOL, {artifactId: "doca"})).success, true);
  assert.equal((await call(secondAccount, HISTORY, {})).selectionRequired, undefined);
  assert.deepEqual(credentials(), ["cred-za2"]);
  // Outside a Room turn: only the calling agent's own Rooms.
  requests.length = 0;
  const zurieMain = {agentId: "zurie", sessionKey: "agent:zurie:main", sessionId: "m1"};
  const own = [{accountId: "zurie-a", roomId: "rooma0000000001"}, {accountId: "zurie-a2", roomId: "rooma0000000001"}, {accountId: "zurie-b", roomId: "roomb0000000002"}];
  assert.deepEqual(await call(zurieMain, TOOL, {artifactId: "docb"}), {success: false, selectionRequired: true, rooms: own});
  assert.deepEqual((await call(zurieMain, HISTORY, {})).rooms, own);
  for (const foreign of ["aura-c", "roomc0000000003"]) {
    assert.deepEqual((await call(zurieMain, TOOL, {artifactId: "docc", room: foreign})).rooms, own);
    assert.deepEqual((await call(zurieMain, HISTORY, {room: foreign})).rooms, own);
  }
  assert.deepEqual(requests, []);
  assert.equal((await call(zurieMain, TOOL, {artifactId: "docb", room: "roomb0000000002"})).text, "1: Text of Beta.");
  assert.deepEqual(credentials(), ["cred-zb"]);
  // A second agent of the gateway sees its own Room only, and the first
  // agent's accounts are invisible to it.
  requests.length = 0;
  const auraMain = {agentId: "aura", sessionKey: "agent:aura:main"};
  assert.equal((await call(auraMain, TOOL, {artifactId: "docc"})).text, "1: Text of Gamma.");
  assert.deepEqual((await call(auraMain, TOOL, {artifactId: "doca", room: "zurie-a"})).rooms, [{accountId: "aura-c", roomId: "roomc0000000003"}]);
  const auraInC = {agentId: "aura", sessionKey: `agent:aura:${ID}:group:roomc0000000003`};
  assert.equal((await call(auraInC, HISTORY, {room: "rooma0000000001"})).code, "room_mismatch");
  assert.deepEqual(credentials(), ["cred-ac"]);
});

test("P7d-19 a log line carries a caller-supplied id only in the Room's id form; a document name, a sentence or a line break is logged as invalid", async () => {
  const room = new Room({doca: record("doca", {v1: ["ready", "Alpha text."]})}, [], {documentsList: [entry("doca")]});
  const lines = [];
  const logger = {info: (line) => lines.push(line)};
  const session = {roomId: "rooma0000000001", credential: "c", baseUrl: room.baseUrl};
  // A document name, a sentence, a string with a line break, a carriage return.
  const typed = ["Befund-Zeisig-Kardiologie.md", "Unique finding: violet heron syndrome stage IX.", "x\nRoom r1 FORGED LOG LINE code=ok", "doca\r"];
  const sessions = [{accountId: "t", roomId: "rooma0000000001", agentId: "main"}];
  for (const value of typed) {
    await readRoomDocument({client: room.client(), session, args: {artifactId: value}, logger});
    await readRoomDocument({client: room.client(), session, args: {artifactId: "doca", versionId: value}, logger});
    historyModule.selectCallSession(sessions, value, {sessionKey: `agent:main:${ID}:group:rooma0000000001`}, {logger, tool: "document"});
    historyModule.selectCallSession(sessions, value, {sessionKey: `agent:main:${ID}:group:rooma0000000001`}, {logger, tool: "history"});
  }
  await readRoomDocument({client: room.client(), session, args: {artifactId: "abcde12345fghij", versionId: "v0000000000000a"}, logger});
  for (const line of lines) {
    assert.ok(!/[\n\r]/.test(line), line);
    for (const value of typed) assert.ok(!line.includes(value.trim()), line);
    for (const fragment of ["Befund", "violet", "FORGED"]) assert.ok(!line.includes(fragment), line);
  }
  for (const expected of ["Room rooma0000000001 document read: artifact=invalid version=- code=not_in_discussion",
    "Room rooma0000000001 document read: artifact=invalid version=invalid code=not_in_discussion",
    "Room rooma0000000001 document refused: code=room_mismatch", "Room rooma0000000001 history refused: code=room_mismatch",
    "Room rooma0000000001 document read: artifact=abcde12345fghij version=v0000000000000a code=not_in_discussion"]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.equal(documents.loggableId("abcde12345fghij"), "abcde12345fghij");
  for (const value of ["abcde12345fghij\n", "ABCDE12345FGHIJ", "abcde12345fghi", "abcde12345fghijk", "abcde-2345fghij", 15, null]) {
    assert.equal(documents.loggableId(value), "invalid", String(value));
  }
});

// The relative modules a shipped file imports, statically or dynamically.
const relativeImports = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);

test("P7d-20 the release archive installs every runtime file it ships, byte-equal, and the installed plugin loads", async (t) => {
  // What ships is package.json "files", packed by npm (tools/build-release.mjs
  // packs a git archive of the release commit the same way).
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.files, ["bin", "docs", "src", "README.md", "conformance.json", "openclaw.plugin.json"]);
  const hostRoot = installedHost();
  if (!hostRoot) return t.skip("the pinned OpenClaw host is not installed");
  const npm = join(dirname(process.execPath), "npm");
  const scratch = await mkdtemp(join(home, "pack-"));
  const source = join(scratch, "source");
  await cp(root, source, {recursive: true, filter: (path) => !/\/(node_modules|\.git)(\/|$)/.test(path.slice(root.length))});
  const out = join(scratch, "out");
  await mkdir(out);
  const run = promisify(execFile);
  const env = {...process.env, HOME: scratch, npm_config_cache: join(scratch, "npm-cache"), npm_config_offline: "true",
    npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false"};
  const {stdout} = await run(npm, ["pack", "--json", "--pack-destination", out], {cwd: source, env, timeout: 120_000, maxBuffer: 8 << 20});
  const [packed] = JSON.parse(stdout);
  const extracted = join(scratch, "extracted");
  await mkdir(extracted);
  await run("tar", ["-xzf", join(out, packed.filename), "-C", extracted]);
  const plugin = join(extracted, "package");
  const shipped = new Set(packed.files.map((item) => item.path));
  // The new source files of this release are in the archive, byte-equal.
  for (const name of ["src/documents.js", "src/document-tool.js", "src/history.js", "openclaw.plugin.json"]) {
    assert.ok(shipped.has(name), name);
    assert.deepEqual(await readFile(join(plugin, name)), await readFile(join(root, name)), name);
  }
  // Every module the entry imports, directly or through others, is shipped.
  const pending = ["src/index.js"];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    assert.ok(shipped.has(name), `${name} is imported but not shipped`);
    for (const target of relativeImports(await readFile(join(plugin, name), "utf8"))) {
      pending.push(join(dirname(name), target).replaceAll("\\", "/"));
    }
  }
  assert.ok(seen.has("src/documents.js") && seen.has("src/document-tool.js"));
  // Loaded by the host's own loader from the BUILT archive, the host as its peer.
  await mkdir(join(plugin, "node_modules"));
  await symlink(hostRoot, join(plugin, "node_modules", "openclaw"));
  const loaded = await run(process.execPath, [join(root, "test/support/host-plugin-register.mjs"), hostRoot, plugin], {
    env: {...process.env, HOME: await mkdtemp(join(scratch, "host-")), JITI_FS_CACHE: "false"}, timeout: 120_000, maxBuffer: 1 << 20,
  });
  const result = JSON.parse(loaded.stdout.trim().split("\n").at(-1));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.plugin.toolNames, [TOOL, "synthetic_sociality_room_history", "synthetic_sociality_room_share_file"].sort(), JSON.stringify(result));
  assert.equal(result.plugin.failed, false);
});

test("P7d-21 a version already given, or a large one while the tool is available, is named by its reference line without a Room read", async () => {
  documents.noteDocumentToolAvailable();
  // Review N4: more listed documents than the text cache holds.
  const names = Array.from({length: 12}, (_, index) => `doc${String(index).padStart(2, "0")}`);
  const room = new Room(Object.fromEntries(names.map((name) => [name, record(name, {v1: ["ready", `${name} text. `.repeat(300)]})])), [],
    {documentsList: names.map((name) => entry(name))});
  const discussion = new Discussion(room);
  assert.equal((await discussion.turn()).split("\nContent:\n").length - 1, 12);
  assert.deepEqual([...room.reads].sort(), names);
  for (let turn = 0; turn < 3; turn += 1) {
    assert.equal(documentBlock(await discussion.turn()).split(" · given in full earlier in this discussion").length - 1, 12);
  }
  assert.equal(room.reads.length, 12, "a given version is named without a Room read");
  // A process that holds no count (a restart) reads each version once.
  documents.TEXT_SIZES.clear();
  documents.TEXT_CACHE.clear();
  await discussion.turn();
  await discussion.turn();
  assert.equal(room.reads.length, 24);
  // A large document while the tool is available: read once, then by count.
  const large = new Room({long: record("long", {v1: ["ready", LARGE_TEXT]})}, [], {documentsList: [entry("long")]});
  documents.TEXT_CACHE.clear();
  const discussionLarge = new Discussion(large);
  for (let turn = 0; turn < 3; turn += 1) {
    assert.ok((await discussionLarge.turn()).includes(reference("long.md", "long", "v1", codePointLength(LARGE_TEXT), {given: false})));
  }
  assert.deepEqual(large.reads, ["long"]);
  const sizes = new documents.DocumentSizes({versions: 3});
  for (let index = 0; index < 5; index += 1) sizes.put(`k${index}`, index);
  assert.deepEqual(Array.from({length: 5}, (_, index) => sizes.get(`k${index}`)), [null, null, 2, 3, 4]);
});

test("P7d-22 bounds: the memory keeps the newest 64 keys, a human_only library entry is refused, the text cache is per Room, a result may fill the bound exactly, no head without 24,000 characters left", async () => {
  const keys = Array.from({length: 70}, (_, index) => `a${index}/v1`);
  assert.deepEqual(documents.givenMemory("epoch-z", keys.slice(0, 60), keys.slice(60), "s").given, keys.slice(6));
  const room = new Room({private: record("private", {v1: ["ready", "Owner only."]}), open: record("open", {v1: ["ready", "Open text."]})},
    [{artifactId: "private", visibility: "human_only", currentVersion: {versionId: "v1", name: "private.md"}},
      {artifactId: "open", visibility: "restricted", currentVersion: {versionId: "v1", name: "open.md"}}], {documentsList: []});
  const call = toolCaller(room);
  assert.equal((await call({artifactId: "private"})).code, "not_in_discussion");
  assert.deepEqual(room.reads, []);
  assert.equal((await call({artifactId: "open"})).success, true);
  const fetched = [];
  for (const roomId of ["rooma0000000001", "roomb0000000002"]) {
    const version = await documents.readVersion(["https://room.example/api", roomId],
      async (wanted) => { fetched.push(roomId); return record(wanted, {v1: ["ready", `Text of ${roomId}.`]}); }, "same", "v1");
    assert.deepEqual(version, {status: "ready", text: `Text of ${roomId}.`});
  }
  assert.deepEqual(fetched, ["rooma0000000001", "roomb0000000002"]);
  const line = "x".repeat(documents.DOCUMENT_TOOL_RESULT_LIMIT - "1: ".length);
  const exact = documents.documentPassages("exact.md", "exact", "v1", `${line}\nsecond`, {fromLine: 1, toLine: 1});
  assert.deepEqual([codePointLength(exact.text), exact.truncated, exact.text.at(-1)], [documents.DOCUMENT_TOOL_RESULT_LIMIT, false, "x"]);
  const over = documents.documentPassages("over.md", "over", "v1", `${line}x`, {});
  assert.deepEqual([codePointLength(over.text), over.truncated, over.text.at(-1)], [documents.DOCUMENT_TOOL_RESULT_LIMIT, true, "…"]);
  const texts = {one: "a".repeat(20_001), two: "b".repeat(20_001), big: "c".repeat(30_000)};
  const read = async (artifactId) => ({status: "ready", text: texts[artifactId]});
  const listed = documents.discussionDocuments({activeTopic: {documents: Object.keys(texts).map((key) => entry(key))}});
  let rendered = await documents.discussionDocumentContext(listed, read, {given: [], tool: "unknown"});
  assert.deepEqual([rendered.offered, rendered.counts.full, rendered.counts.head], [["one/v1", "two/v1"], 2, 0]);
  assert.ok(!rendered.context.includes("c".repeat(100)));
  assert.ok(rendered.context.includes(reference("big.md", "big", "v1", 30_000, {given: false})));
  texts.two = "b".repeat(16_000);
  rendered = await documents.discussionDocumentContext(listed, read, {given: [], tool: "unknown"});
  assert.deepEqual([rendered.offered, rendered.counts.head], [["one/v1", "two/v1", "big/v1"], 1]);
  // OpenClaw review deferred 1: heads are charged to the budget.
  const heads = {a: "a".repeat(30_000), b: "b".repeat(30_000), c: "c".repeat(30_000)};
  const many = documents.discussionDocuments({activeTopic: {documents: Object.keys(heads).map((key) => entry(key))}});
  rendered = await documents.discussionDocumentContext(many, async (artifactId) => ({status: "ready", text: heads[artifactId]}), {given: [], tool: "unknown"});
  assert.deepEqual([rendered.offered, rendered.counts.head], [["a/v1", "b/v1"], 2]);
});

test("P7d-23 two agents in one Room each get a document in full once", async () => {
  // OpenClaw review B2: one gateway, one Room, two agents, the host session
  // of each seen during its run (a tool call of a Room session).
  const room = new Room({brief: record("brief", {v1: ["ready", PROOF_TEXT]})}, [], {documentsList: [entry("brief")]});
  const conversation = epochConversationId("room-1", "epoch-z");
  const agents = {zurie: new Discussion(room, {agentId: "zurie"}), aura: new Discussion(room, {agentId: "aura"})};
  const texts = {zurie: [], aura: []};
  for (let turn = 0; turn < 8; turn += 1) {
    for (const [agent, discussion] of Object.entries(agents)) {
      texts[agent].push(await discussion.turn({beforeMark: () => documents.noteHostSession(`agent:${agent}:${ID}:group:${conversation}`, `session-${agent}`)}));
    }
  }
  for (const [agent, turns] of Object.entries(texts)) {
    assert.equal(turns.reduce((count, text) => count + text.split(PROOF_TEXT.trim()).length - 1, 0), 1, agent);
    assert.ok(turns[0].includes(PROOF_TEXT.trim()), agent);
    assert.equal(agents[agent].memory.hostSession, `session-${agent}`);
  }
  assert.equal(documents.observedHostSession(conversation, "zurie"), "session-zurie");
  assert.equal(documents.observedHostSession(conversation, "aura"), "session-aura");
});

test("P7d-24 a host session that changed unseen after a restart gives the documents in full again on the next turn", async () => {
  // OpenClaw review B3: the memory records S1; after a restart the turn is
  // built without a known session and the run reveals S2.
  const room = new Room({brief: record("brief", {v1: ["ready", PROOF_TEXT]})}, [], {documentsList: [entry("brief")]});
  const key = sessionKeyFor("epoch-z");
  const discussion = new Discussion(room);
  assert.ok((await discussion.turn({beforeMark: () => documents.noteHostSession(key, "S1")})).includes(PROOF_TEXT.trim()));
  assert.equal(discussion.memory.hostSession, "S1");
  documents.resetDocumentRuntimeMemory();
  // The turn built before the change was seen: references (P7d-5).
  assert.ok(!(await discussion.turn({beforeMark: () => documents.noteHostSession(key, "S2")})).includes(PROOF_TEXT.slice(0, 200)));
  assert.deepEqual(discussion.memory, {epochId: "epoch-z", hostSession: "S2", given: []});
  assert.ok((await discussion.turn()).includes(PROOF_TEXT.trim()));
  assert.ok(!(await discussion.turn()).includes(PROOF_TEXT.slice(0, 200)));
  assert.deepEqual(discussion.memory.given, ["brief/v1"]);
});

test("P7d-25 a run that ended in the host's operational fallback marks nothing given", async () => {
  // OpenClaw review B4: the channel settles such an attempt as fail.
  const GENERIC = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
  const COMPACTION = "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.";
  for (const [label, payload, expected, settledAs] of [
    ["generic fallback", {text: GENERIC, isError: true}, [], "fail"],
    ["compaction fallback", {text: COMPACTION, isError: true}, [], "fail"],
    ["model reply", {text: "A contribution of the model."}, ["event-1"], null],
  ]) {
    const marked = [];
    const settled = [];
    const event = {id: "event-1", sourceEventId: "event-1", respondsToId: "event-1", roomId: "room-1", epochId: "epoch-z",
      conversationId: "room-1:epoch:x", senderId: "owner-tj", senderName: "TJE", senderKind: "human", text: "question", occurredAt: 1, raw: {},
      cycleAttempt: {cycle: {id: "cycle-1", generation: 1}, attempt: {id: "attempt-1", membershipId: "zurie"}}};
    const client = {
      initialize: async () => ({sessionId: "session-1"}),
      assignedTurns: async function* () { yield event; },
      markTurnReading: async () => {},
      markDocumentsGiven: async (eventId) => { marked.push(eventId); },
      postAndFinish: async () => ({eventId: "posted", sentAt: 1}),
      settleDiscussionAttempt: async (_attempt, action) => { settled.push(action); },
      recordSkipped: async () => {},
      ack: async () => {},
      close: async () => {},
    };
    const channel = channelModule.createRoomChannel({makeClient: () => client});
    let status = {running: false, connected: false};
    const ctx = {account: {accountId: "default", stateFile: join(home, `channel-p7d25-${marked.length}-${label.length}.json`)}, accountId: "default",
      abortSignal: new AbortController().signal, cfg: ISOLATED_HOST_CONFIG, getStatus: () => status, setStatus: (next) => { status = next; },
      log: {info: () => {}, warn: () => {}, error: () => {}},
      channelRuntime: {
        // The host delivers its payload and returns normally.
        inbound: {run: async ({raw, adapter}) => {
          const turn = adapter.resolveTurn(adapter.ingest(raw));
          try { await turn.delivery.deliver(payload); } catch {}
        }},
        routing: {resolveAgentRoute: () => ({agentId: "main", accountId: "default", sessionKey: "s", mainSessionKey: "m"})},
        session: {resolveStorePath: () => "/tmp/session-store", recordInboundSession: async () => {}},
        reply: {dispatchReplyWithBufferedBlockDispatcher: async () => {}},
      }};
    await channel.plugin.gateway.startAccount(ctx).catch(() => {});
    assert.deepEqual(marked, expected, label);
    if (settledAs) assert.deepEqual(settled, [settledAs], label);
  }
});

test("P7d-26 an id over 128 characters never reaches the state, and a failed library listing does not fail the turn", async () => {
  documents.noteDocumentToolAvailable();
  const longId = "a".repeat(129);
  const room = new Room({brief: record("brief", {v1: ["ready", "Brief text."]}), [longId]: record(longId, {v1: ["ready", "Long id text."]})}, [],
    {documentsList: [entry(longId), entry("brief", "v".repeat(129)), entry("brief")]});
  assert.deepEqual(documents.discussionDocuments(room.state()).map((item) => `${item.artifactId}/${item.versionId}`), ["brief/v1"]);
  const discussion = new Discussion(room);
  assert.ok(!(await discussion.turn()).includes("Long id text."));
  assert.deepEqual(room.reads, ["brief"]);
  assert.deepEqual(discussion.memory.given, ["brief/v1"]);
  // A memory that could not be loaded again is never written (review N3).
  const runtime = discussion.runtime;
  const before = structuredClone(runtime.state.documentsGiven);
  const persisted = runtime.persisted.length;
  runtime.documentsOffered.set("ready-x", {epochId: "epoch-z", conversationId: "c", agentId: "main", hostSession: "", recordedSession: "",
    given: [], offered: [`${"a".repeat(300)}/v1`]});
  await assert.rejects(runtime.markDocumentsGiven("ready-x"), /invalid/);
  assert.deepEqual(runtime.state.documentsGiven, before);
  assert.equal(runtime.persisted.length, persisted);
  validateState(runtime.state);
  // Review N5: the library listing failing leaves the documents in place.
  const failing = new Room({brief: record("brief", {v1: ["ready", "Brief text."]})}, [], {documentsList: [entry("brief")]});
  failing.listArtifacts = async () => { throw new RoomTransportError("library down"); };
  const withoutLibrary = new Discussion(failing);
  assert.ok(documentBlock(await withoutLibrary.turn()).includes("Content:\nBrief text."));
  assert.ok(withoutLibrary.runtime.logs.some((line) => /document library unavailable: RoomTransportError/.test(line)), withoutLibrary.runtime.logs.join("\n"));
});

test("P7d-27 the tools find every Room the connector runs, also one whose state the configuration places outside the default directory, and each agent sees only its own", async (t) => {
  const hostRoot = installedHost();
  if (!hostRoot) return t.skip("the pinned OpenClaw host is not installed");
  // OpenClaw review r2 B1. Through the host's own loader, the registered
  // factories, the host's own route resolution and real state files.
  const scratch = await mkdtemp(join(home, "host-tools-"));
  const {stdout} = await promisify(execFile)(process.execPath, [join(root, "test/support/host-room-tools.mjs"), hostRoot, root], {
    env: {...process.env, HOME: scratch, JITI_FS_CACHE: "false"}, timeout: 120_000, maxBuffer: 4 << 20,
  });
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.plugin, {failed: false, toolNames: [TOOL, "synthetic_sociality_room_history", "synthetic_sociality_room_share_file"].sort()});
  assert.deepEqual(result.diagnostics, []);
  // The accounts the host starts: the configured ones outside the default
  // directory and the managed one inside it; not the disabled one, not a state
  // file nobody names. The tools see exactly these.
  assert.deepEqual(result.started, ["ZX", "ac", "ad", "default", "zb", "zm"]);
  // The host passes the account id in its normalised form.
  assert.deepEqual(result.contexts, {ZX: {agentId: "zurie", agentAccountId: "zx"}, ad: {agentId: "aura", agentAccountId: "ad"},
    ac: {agentId: "aura", agentAccountId: "ac"}});
  const {calls} = result;
  const only = (call, request) => assert.ok(call.requests.length > 0 && call.requests.every((item) => item === request), JSON.stringify(call));
  // In ZX's own Room turn both tools work for that Room, with its credential.
  assert.equal(calls.zxError.answer.code, "not_in_discussion");
  assert.equal(calls.zxDocument.answer.text, "1: Text of Alpha.", JSON.stringify(calls.zxDocument));
  only(calls.zxDocument, "rooma0000000001 cred-zx");
  assert.equal(calls.zxHistory.answer.success, true, JSON.stringify(calls.zxHistory));
  assert.deepEqual(calls.zxHistory.answer.messages.map((item) => item.body), ["Message in Alpha."]);
  only(calls.zxHistory, "rooma0000000001 cred-zx");
  assert.deepEqual([calls.zxOtherRoom.answer.code, calls.zxOtherRoom.requests], ["room_mismatch", []]);
  // The second agent in the same Room uses its own account.
  assert.equal(calls.adDocument.answer.text, "1: Text of Alpha.");
  only(calls.adDocument, "rooma0000000001 cred-ad");
  only(calls.acHistory, "roomc0000000003 cred-ac");
  assert.deepEqual([calls.acZurieRoom.answer.code, calls.acZurieRoom.requests], ["room_mismatch", []]);
  // Outside a Room turn each agent is offered its own running accounts only.
  const zurie = [{accountId: "ZX", roomId: "rooma0000000001"}, {accountId: "zb", roomId: "roomb0000000002"}, {accountId: "zm", roomId: "roomb0000000002"}];
  assert.deepEqual(calls.zurieMain.answer, {success: false, selectionRequired: true, rooms: zurie});
  assert.deepEqual(calls.auraMain.answer.rooms, [{accountId: "ac", roomId: "roomc0000000003"}, {accountId: "ad", roomId: "rooma0000000001"}]);
  assert.deepEqual([calls.zurieNamesAura.answer.rooms, calls.zurieNamesAura.requests], [zurie, []]);
  only(calls.zurieRoomB, "roomb0000000002 cred-zb");
  // Review r2 N5: a call that answered an error does not make the tool
  // available; the successful read of a Room session does.
  assert.deepEqual([result.statusBefore, result.statusAfterError, result.statusAfterRead], ["unknown", "unknown", "available"]);
});

test("P7d-28 a recorded host session is never overwritten by a run whose session is unknown", async () => {
  // OpenClaw review r2 N1: restart, a turn whose run shows no session, a host
  // reset, then the run shows the new session.
  const room = new Room({brief: record("brief", {v1: ["ready", PROOF_TEXT]})}, [], {documentsList: [entry("brief")]});
  const key = sessionKeyFor("epoch-z");
  const discussion = new Discussion(room);
  assert.ok((await discussion.turn({beforeMark: () => documents.noteHostSession(key, "S1")})).includes(PROOF_TEXT.trim()));
  documents.resetDocumentRuntimeMemory();
  assert.ok(!(await discussion.turn()).includes(PROOF_TEXT.slice(0, 200)));
  assert.deepEqual(discussion.memory, {epochId: "epoch-z", hostSession: "S1", given: ["brief/v1"]});
  // The host reset the session; the run of the next turn shows S2.
  assert.ok(!(await discussion.turn({beforeMark: () => documents.noteHostSession(key, "S2")})).includes(PROOF_TEXT.slice(0, 200)));
  assert.deepEqual(discussion.memory, {epochId: "epoch-z", hostSession: "S2", given: []});
  assert.ok((await discussion.turn()).includes(PROOF_TEXT.trim()));
  assert.ok(!(await discussion.turn()).includes(PROOF_TEXT.slice(0, 200)));
  // The new session known before the third turn is built: a first turn again.
  documents.resetDocumentRuntimeMemory();
  const known = new Discussion(room);
  await known.turn({beforeMark: () => documents.noteHostSession(key, "S1")});
  documents.resetDocumentRuntimeMemory();
  await known.turn();
  assert.equal(known.memory.hostSession, "S1");
  documents.noteHostSession(key, "S2");
  assert.ok((await known.turn()).includes(PROOF_TEXT.trim()));
  assert.ok(!(await known.turn()).includes(PROOF_TEXT.slice(0, 200)));
  assert.deepEqual(known.memory, {epochId: "epoch-z", hostSession: "S2", given: ["brief/v1"]});
});

test("P7d-29 a document tool deferred behind the host's tool search is available", async () => {
  // OpenClaw cannot see a host's deferral: the value is unknown, which counts
  // as offered (the reference line names the tool); a read the host executes
  // for the agent through its tool search makes it available.
  const room = new Room({long: record("long", {v1: ["ready", LARGE_TEXT]})}, [], {documentsList: [entry("long")]});
  const size = codePointLength(LARGE_TEXT);
  assert.equal(documents.documentToolState(), "unknown");
  const before = documentBlock(await new Discussion(room).turn());
  assert.ok(before.endsWith(`${reference("long.md", "long", "v1", size, {given: false})}\n\n${FOOTER}`));
  const made = [];
  let noted = 0;
  registerRoomDocumentTool({registerTool: (factory) => made.push(factory)}, {makeClient: () => room.client(),
    sessions: async () => [{accountId: "t", roomId: "room-1", credential: "c", baseUrl: room.baseUrl, agentId: "main"}],
    onAvailable: () => { noted += 1; }});
  const tool = made[0]({agentId: "main", sessionKey: sessionKeyFor("epoch-z"), sessionId: "s"});
  assert.equal((await tool.execute("c", {artifactId: "long", fromLine: 1, toLine: 2})).details.success, true);
  assert.deepEqual([noted, documents.documentToolState()], [1, "available"]);
  const discussion = new Discussion(room);
  for (let turn = 0; turn < 2; turn += 1) {
    assert.equal(documentBlock(await discussion.turn()), [documents.DOCUMENT_CONTEXT_HEADER,
      reference("long.md", "long", "v1", size, {given: false}), FOOTER].join("\n\n"));
  }
});

test("P7d round 3 (OpenClaw): account ids compare in the host's normalised form; an account whose agent cannot be resolved is offered to nobody; distinct answers without a selectable account", async () => {
  const session = (accountId, roomId, agentId) => ({accountId, roomId, agentId, credential: `cred-${accountId}`, baseUrl: "https://room.example/api"});
  const inRoomA = (extra = {}) => ({agentId: "zurie", sessionKey: `agent:zurie:${ID}:group:rooma0000000001:epoch:x`, ...extra});
  const two = [session("Zurie-A", "rooma0000000001", "zurie"), session("zurie-a2", "rooma0000000001", "zurie"), session("zb", "roomb0000000002", "zurie")];
  // N4: the host passes "zurie-a" for the configured "Zurie-A".
  assert.equal(historyModule.selectCallSession(two, undefined, inRoomA({agentAccountId: "zurie-a"})).session?.accountId, "Zurie-A");
  assert.equal(historyModule.selectCallSession(two, undefined, inRoomA({agentAccountId: "ZURIE-A2"})).session?.accountId, "zurie-a2");
  // Round-2 survivor: two of the agent's accounts in the turn's Room and the
  // host named none: no account is taken, a plain coded answer.
  const unnamed = {success: false, code: "account_not_named", error: historyModule.ACCOUNT_NOT_NAMED_ERROR};
  assert.deepEqual(historyModule.selectCallSession(two, undefined, inRoomA()), {refused: unnamed});
  assert.deepEqual(historyModule.selectCallSession(two, undefined, inRoomA({agentAccountId: "aura-c"})), {refused: unnamed});
  // N3: no Room configured for the agent; none of its accounts in this Room.
  const noRoom = {success: false, code: "no_room", error: historyModule.NO_ROOM_ERROR};
  assert.deepEqual(historyModule.selectCallSession([], undefined, inRoomA()), {refused: noRoom});
  assert.deepEqual(historyModule.selectCallSession([], undefined, {agentId: "zurie", sessionKey: "agent:zurie:main"}), {refused: noRoom});
  assert.deepEqual(historyModule.selectCallSession([session("zb", "roomb0000000002", "zurie")], undefined, inRoomA()),
    {refused: {success: false, code: "no_room", error: historyModule.NOT_IN_ROOM_ERROR}});
  assert.equal(new Set([historyModule.NO_ROOM_ERROR, historyModule.NOT_IN_ROOM_ERROR, historyModule.ACCOUNT_NOT_NAMED_ERROR]).size, 3);
  // N2: an account whose agent the host cannot resolve is offered to nobody,
  // not to "main".
  const state = {"/s/ok.json": "rooma0000000001", "/s/throws.json": "roomb0000000002", "/s/empty.json": "roomc0000000003"};
  const accounts = () => Object.keys(state).map((stateFile) => ({accountId: stateFile.slice(3, -5), stateFile}));
  const load = async (file) => ({roomId: state[file], credential: "c", baseUrl: "https://room.example/api"});
  const route = ({accountId}) => {
    if (accountId === "throws") throw new Error("no route");
    return accountId === "empty" ? {agentId: ""} : {agentId: "main"};
  };
  const found = await historyModule.roomSessions({runtime: {channel: {routing: {resolveAgentRoute: route}}}}, {agentId: "main"}, {accounts, load});
  assert.deepEqual(found.map((item) => [item.accountId, item.agentId]), [["ok", "main"]]);
  for (const agentId of ["main", "zurie", ""]) {
    const outside = historyModule.selectCallSession(found, "roomb0000000002", {agentId, sessionKey: `agent:${agentId || "main"}:main`});
    assert.notEqual(outside.session?.accountId, "throws");
    assert.ok(!(outside.choices ?? []).some((item) => ["throws", "empty"].includes(item.accountId)));
  }
});
