// Contract P3-4: `openclaw-room-recovery list|close`, the universal recovery
// verbs (Hermes: `hermes room recovery list|close`). Owner-run, as the user
// that owns the account state. Never prints a credential or a message body.
import {join} from "node:path";
import {parseArgs} from "node:util";
import {defaultStateDirectory, loadState} from "./state.js";
import {RoomClient} from "./room-client.js";
import {ROOM_CONNECTOR_PROVENANCE} from "./release-provenance.js";
import {
  REASONS, appendRecord, buildRecord, describe, journalPath, ledgerReport, priorState, renderRecord,
  roomForState, seal, serverProof, stuckIntents,
} from "./recovery.js";

export const USAGE = [
  "Usage: openclaw-room-recovery list (--state FILE | --account ID)",
  "       openclaw-room-recovery close (--state FILE | --account ID) --seq N --reason REASON --evidence REF --operator NAME [--apply --confirm TOKEN]",
  `       REASON: ${REASONS.join(" | ")}; REF: cycle:<cycleId> or epoch:<epochId>`,
].join("\n");

export async function runRecoveryCli(argv, {
  write = (line) => process.stdout.write(`${line}\n`),
  makeClient = (state) => new RoomClient({baseUrl: state.baseUrl, credential: state.credential}),
} = {}) {
  const [verb, ...rest] = argv;
  if (!["list", "close"].includes(verb)) throw new Error(USAGE);
  const {values} = parseArgs({args: rest, strict: true, options: {
    state: {type: "string"}, account: {type: "string"}, seq: {type: "string"}, reason: {type: "string"},
    evidence: {type: "string"}, operator: {type: "string"}, apply: {type: "boolean"}, confirm: {type: "string"},
  }});
  const stateFile = values.state || (values.account ? join(defaultStateDirectory(), `${values.account}.json`) : "");
  if (!stateFile) throw new Error(USAGE);
  const state = await loadState(stateFile);
  write(`state: ${stateFile}`);
  write(`${state.roomId} membership ${state.membershipId}`);
  if (verb === "list") {
    describe(ledgerReport(state), stuckIntents(state), write);
    const applied = Object.keys(state.appliedRecoveryClosures ?? {}).map(Number).sort((a, b) => a - b);
    if (applied.length) write(`  applied closures: ${applied.join(", ")}`);
    return 0;
  }
  const seq = Number(values.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("--seq must be a positive integer");
  if (!REASONS.includes(values.reason)) throw new Error(`--reason must be one of ${REASONS.join(", ")}`);
  const operator = String(values.operator ?? "").trim();
  if (!operator) throw new Error("--operator is required");
  const evidenceRef = String(values.evidence ?? "");
  const prior = priorState(state, seq);
  const proven = await serverProof(roomForState(makeClient(state), state), state.membershipId, seq, values.reason, evidenceRef);
  const record = buildRecord({
    connector: `openclaw/${ROOM_CONNECTOR_PROVENANCE.version}`, roomId: state.roomId, membershipId: state.membershipId,
    clientInstanceId: state.clientInstanceId, seq, reason: values.reason, evidenceRef, proven, prior, operator,
  });
  write(renderRecord(record));
  if (!values.apply) {
    write(`Dry run. The Room proves seq ${seq} terminal for this member (${values.reason}). To apply: add --apply --confirm ${record.confirmToken}`);
    return 0;
  }
  if (values.confirm !== record.confirmToken) {
    throw new Error("confirmation token does not match the current state and proof; run the dry run again");
  }
  const sealed = seal(record);
  appendRecord(journalPath(stateFile), sealed);
  write(`Closure recorded in ${journalPath(stateFile)} (digest ${sealed.recordDigest.slice(0, 16)}). The running connector applies it through its normal acknowledgement path.`);
  return 0;
}
