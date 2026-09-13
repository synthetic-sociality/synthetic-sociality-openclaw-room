import assert from "node:assert/strict";
import test from "node:test";
import {resolvedRoomAccounts} from "../src/account-discovery.js";
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

const fixtureAccount = (extra = {}) => ({accountId: "fixture", stateFile: "/private/fixture.json", baseUrl: "https://fixture.invalid/api", enabled: true, configured: true, ...extra});

async function fixture(t, {accounts, current, initialize} = {}) {
  await presenceFallbackTest.reset();
  let service;
  const waiters = [], started = [], closed = [], signals = [];
  const api = {registerService: (value) => {service = value;}, runtime: {config: {current}}};
  registerPresenceFallback(api, {
    ...(accounts ? {accounts} : {}),
    waitFn: () => new Promise((resolve) => waiters.push(resolve)),
    makeClient: (account) => ({
      initialize: async (signal) => {started.push(account);signals.push(signal);return initialize ? initialize(signal) : {sessionId: "fixture"};},
      close: async () => {closed.push(account.accountId);},
    }),
  });
  service.start({logger: {warn: () => {}, error: () => {}}});
  t.after(async () => {await service.stop();await presenceFallbackTest.reset();});
  const tick = async () => {await eventually(() => waiters.length > 0);waiters.shift()();await eventually(() => waiters.length > 0);};
  return {started, closed, signals, tick};
}

test("explicitly disabled and unconfigured accounts never initialize fallback", async (t) => {
  const f = await fixture(t, {accounts: () => [fixtureAccount({enabled:false}), fixtureAccount({accountId:"unconfigured",configured:false})]});
  await f.tick(); await f.tick();
  assert.equal(f.started.length, 0);
});

test("running fallback closes on disable and resumes only after re-enable", async (t) => {
  let enabled = true;
  const f = await fixture(t, {accounts: () => [fixtureAccount({enabled})]});
  await f.tick();assert.equal(f.started.length,1);
  enabled=false;await f.tick();assert.deepEqual(f.closed,["fixture"]);assert.equal(f.signals[0].aborted,true);
  await f.tick();assert.equal(f.started.length,1);
  enabled=true;await f.tick();assert.equal(f.started.length,2);
});

test("disable aborts pending initialization without blocking reconciliation", async (t) => {
  let enabled=true;
  const f=await fixture(t,{accounts:()=>[fixtureAccount({enabled})],initialize:(signal)=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))});
  await f.tick();assert.equal(f.started.length,1);
  enabled=false;await f.tick();assert.equal(f.signals[0].aborted,true);assert.deepEqual(f.closed,["fixture"]);
  await f.tick();assert.equal(presenceFallbackTest.fallbackRuntimes.size,0);
});

test("native takeover cancels pending fallback and cannot restart it", async (t) => {
  const f=await fixture(t,{accounts:()=>[fixtureAccount()],initialize:(signal)=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))});
  await f.tick();await markChannelActive("fixture");await f.tick();
  assert.equal(f.started.length,1);assert.equal(f.signals[0].aborted,true);assert.deepEqual(f.closed,["fixture"]);
});

test("changed identity and removed account close the previous fallback", async (t) => {
  let accounts=[fixtureAccount()];
  const f=await fixture(t,{accounts:()=>accounts});await f.tick();
  accounts=[fixtureAccount({stateFile:"/private/replacement.json"})];await f.tick();
  assert.equal(f.started.length,2);assert.equal(f.started[1].stateFile,"/private/replacement.json");assert.equal(f.closed.length,1);
  accounts=[];await f.tick();assert.equal(f.closed.length,2);
});

test("resolution error closes existing fallback instead of keeping stale authority", async (t) => {
  let fail=false;
  const f=await fixture(t,{accounts:()=>{if(fail)throw Error("fixture config unavailable");return [fixtureAccount()];}});
  await f.tick();fail=true;await f.tick();assert.deepEqual(f.closed,["fixture"]);assert.equal(presenceFallbackTest.fallbackRuntimes.size,0);
});

test("production resolver reads current runtime config each reconcile including split state paths", async (t) => {
  let enabled=false;let reads=0;
  const current=()=>{reads++;return {channels:{"synthetic-sociality-room":{enabled:false,stateFile:"/elsewhere/disabled-default.json",baseUrl:"https://fixture.invalid/api",accounts:{fixture:{enabled,stateFile:"/separate-state/fixture.json",baseUrl:"https://fixture.invalid/api"}}}}};};
  const f=await fixture(t,{current});await f.tick();assert.equal(f.started.length,0);
  enabled=true;await f.tick();assert.equal(f.started.length,1);assert.equal(f.started[0].stateFile,"/separate-state/fixture.json");
  enabled=false;await f.tick();assert.deepEqual(f.closed,["fixture"]);assert.ok(reads>=3);
});

test("disabled default cannot resurrect through a managed file alias", async (t) => {
  const options={managedIds:()=>["alias"],managedResolver:()=>({baseUrl:"https://fixture.invalid/api",stateFile:"/private/shared.json"})};
  const cfg={channels:{"synthetic-sociality-room":{enabled:false,baseUrl:"https://fixture.invalid/api",stateFile:"/private/shared.json"}}};
  const resolved=resolvedRoomAccounts(cfg,options);
  assert.deepEqual(resolved.map(({accountId,enabled})=>({accountId,enabled})),[{accountId:"default",enabled:false}]);
  const f=await fixture(t,{accounts:()=>resolved});await f.tick();assert.equal(f.started.length,0);
});
