import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime} from "../src/runtime.js";
import {saveState} from "../src/state.js";

test("initializes one connector session when native startup and event polling overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-runtime-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1,
    baseUrl: "https://room.example/api",
    roomId: "room-1",
    membershipId: "member-1",
    credential: "secret",
    clientInstanceId: "client-1",
    cursor: 0,
  });
  let registrations = 0;
  let connectorHeartbeats = 0;
  const activities = [];
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/connector/sessions")) {
        registrations += 1;
        return new Response(JSON.stringify({sessionId: "session-1", heartbeatIntervalSeconds: 60}), {status: 200});
      }
      if (url.endsWith("/heartbeat")) {
        connectorHeartbeats += 1;
        return new Response(JSON.stringify({sessionId: "session-1"}), {status: 200});
      }
      if (url.endsWith("/activity")) {
        activities.push(JSON.parse(init.body));
        return new Response(JSON.stringify({acceptedStreamSeq: 1}), {status: 202});
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const [first, second] = await Promise.all([runtime.initialize(), runtime.initialize()]);
  assert.equal(first.sessionId, "session-1");
  assert.equal(second.sessionId, "session-1");
  assert.equal(registrations, 1);
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], {
    version: 1,
    kind: "heartbeat",
    runId: runtime.presenceRunId,
    streamSeq: 1,
  });
  await runtime.maintainPresence();
  assert.equal(connectorHeartbeats, 1);
  assert.equal(activities.length, 2);
  assert.equal(activities[1].streamSeq, 2);
  await runtime.close();
});

test("activity relay failure never disconnects the canonical connector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-room-runtime-"));
  const stateFile = join(directory, "default.json");
  await saveState(stateFile, {
    version: 1, baseUrl: "https://room.example/api", roomId: "room-1",
    membershipId: "member-1", credential: "secret", clientInstanceId: "client-1", cursor: 0,
  });
  const runtime = new OpenClawRoomRuntime({accountId: "default", stateFile, baseUrl: "https://room.example/api"}, {
    fetchImpl: async (url) => {
      if (url.endsWith("/connector/sessions")) return new Response(JSON.stringify({sessionId: "session-1", heartbeatIntervalSeconds: 60}), {status: 200});
      if (url.endsWith("/activity")) return new Response(JSON.stringify({message: "relay unavailable"}), {status: 503});
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const session = await runtime.initialize();
  assert.equal(session.sessionId, "session-1");
  assert.equal(runtime.pendingPresence.streamSeq, 1);
  assert.ok(runtime.activityError);
  await runtime.close();
});
