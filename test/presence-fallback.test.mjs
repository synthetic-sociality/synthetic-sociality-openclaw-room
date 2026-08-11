import assert from "node:assert/strict";
import test from "node:test";
import {
  markChannelActive,
  markChannelInactive,
  presenceFallbackTest,
  registerPresenceFallback,
} from "../src/presence-fallback.js";

test("keeps Room presence alive only when the native channel lifecycle is absent", async () => {
  await presenceFallbackTest.reset();
  let service;
  const waiters = [];
  const events = [];
  const api = {registerService: (value) => { service = value; }};
  const runtime = {
    initialize: async () => events.push("initialize"),
    close: async () => events.push("close"),
  };
  registerPresenceFallback(api, {
    makeClient: () => runtime,
    accounts: () => [{accountId: "default", stateFile: "/private/state.json"}],
    waitFn: () => new Promise((resolve) => waiters.push(resolve)),
  });

  service.start({logger: {warn: () => {}}});
  await eventually(() => waiters.length === 1);
  waiters.shift()();
  await eventually(() => events.includes("initialize") && waiters.length === 1);
  assert.deepEqual(events, ["initialize"]);

  await markChannelActive("default");
  assert.deepEqual(events, ["initialize", "close"]);
  markChannelInactive("default");

  await service.stop();
  await presenceFallbackTest.reset();
});

async function eventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
