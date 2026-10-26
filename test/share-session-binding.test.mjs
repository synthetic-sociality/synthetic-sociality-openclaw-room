import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ShareTurn, beginShareTurn, endShareTurn, registerRoomShareFileTool, refused} from '../src/share-file.js';


const CASES = [
  "P12-01 own session shares without a hook or matching turn identifier",
  "P12-02 host-reported continuation of a bound live session can share",
  "P12-03 routing provenance or historical Room mapping grants no authority",
  "P12-04 host-reported descendant chain shares and reuses the receipt",
  "P12-05 turn end refuses bound sessions and late continuations",
  "P12-06 historical continuations cannot join a successor turn",
  "P12-07 missing identities and tool-supplied or unrecorded lineage are refused",
  "P12-08 foreign lineage cannot move authority between Rooms",
  "P12-09 unresolved dispatch and historical parent grant no authority",
  "P12-10 canonical post sealing refuses sharing and new lineage"
];

test('P12 conformance names the clause and shared cases', async () => {
  const conformance = JSON.parse(await readFile(new URL('../conformance.json', import.meta.url), 'utf8'));
  const contract = await readFile(new URL('../docs/delivery-lifecycle-contract-v1.md', import.meta.url), 'utf8');
  assert.deepEqual(conformance.parityP12Cases, CASES);
  const [document, anchor] = conformance.parityP12Contract.split('#');
  assert.equal(document, 'docs/delivery-lifecycle-contract-v1.md');
  assert.equal(anchor, 'p12--share-authority-follows-the-hosts-own-session-continuation-2026-10-26');
  const heading = "P12 — Share authority follows the host's own session continuation (2026-10-26)";
  const headings = contract.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3));
  const anchors = headings.map(title => title.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-'));
  assert.ok(anchors.includes(anchor));
  assert.equal(headings.filter(title => title === heading).length, 1);
  assert.ok(contract.includes('\nP12-1 Host-owned continuation authority.'));
  assert.ok(contract.includes('\nP12-2 Shared conformance.'));
  const section = contract.split(`## ${heading}`)[1];
  assert.deepEqual(section.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)), CASES);
});

// Port of Hermes tests/test_share_session_binding.py. OpenClaw tool ctx has
// no parent: feed lineage through the actual subagent_spawned API instead.
// Cases 2/3 explicitly assert the resulting pre-hook parity limitation.
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'room-share-lineage-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'draft.md'), 'Synthetic share.\n');
  const created = [], hooks = new Map();
  let factory;
  registerRoomShareFileTool({registerTool: f => { factory = f; }, on: (name, handler) => hooks.set(name, handler)});
  const prefix = root;
  const key = name => `${prefix}:${name}`;
  const begin = name => {
    const turn = new ShareTurn({records: {}, root, excluded: [], persist: async () => {},
      create: async () => { created.push(name); return {artifactId: 'synthetic-artifact', versionId: 'synthetic-version'}; }});
    beginShareTurn(key(name), turn);
    t.after(() => endShareTurn(key(name), turn));
    return turn;
  };
  const spawn = (child, parent, context = {}) => hooks.get('subagent_spawned')?.(
    {childSessionKey: key(child), runId: 'core-child-run', agentId: 'main', mode: 'run', threadRequested: false},
    {childSessionKey: key(child), requesterSessionKey: key(parent), ...context});
  const tool = ctx => factory(ctx);
  const call = async ctx => (await tool(ctx).execute('call', {path: 'draft.md'})).details;
  const own = name => call({sessionKey: key(name)});
  const turn = begin('session');
  return {created, hooks, key, begin, spawn, call, tool, own, turn};
}

test(CASES[0], async t => {
  const s = await setup(t);
  assert.equal((await s.call({sessionKey: s.key('session'), sessionId: 'rotated-uuid', runId: 'different-scheme'})).success, true);
  assert.deepEqual(s.created, ['session']);
});

test(CASES[1], async t => {
  const s = await setup(t);
  assert.deepEqual(await s.call({sessionKey: s.key('child'), parentSessionKey: s.key('session')}), refused('no-room-turn'));
  const prebuilt = s.tool({sessionKey: s.key('child')});
  s.spawn('child', 'session');
  assert.equal((await prebuilt.execute('call', {path: 'draft.md'})).details.success, true);
  assert.deepEqual(s.created, ['session']);
});

test(CASES[2], async t => {
  const s = await setup(t);
  const ctx = {sessionKey: s.key('mapped-child'), messageChannel: 'synthetic-sociality-room',
    deliveryContext: {channel: 'synthetic-sociality-room', to: 'room'}, agentAccountId: 'default'};
  assert.deepEqual(await s.call(ctx), refused('no-room-turn'));
  s.spawn('mapped-child', 'session');
  assert.equal((await s.call(ctx)).success, true);
  assert.deepEqual(s.created, ['session']);
});

test(CASES[3], async t => {
  const s = await setup(t);
  s.hooks.get('subagent_spawned')?.({childSessionKey: ` ${s.key('rotated')} `},
    {childSessionKey: s.key('rotated'), requesterSessionKey: ` ${s.key('session')} `});
  assert.equal((await s.own('rotated')).success, true);
  assert.equal((await s.own('rotated')).success, true);
  s.spawn('grandchild', 'rotated');
  assert.equal((await s.own('grandchild')).success, true);
  assert.deepEqual(s.created, ['session']);
});

test(CASES[4], async t => {
  const s = await setup(t);
  s.spawn('child', 'session');
  endShareTurn(s.key('session'), s.turn);
  s.spawn('late', 'session');
  for (const name of ['session', 'child', 'late']) assert.deepEqual(await s.own(name), refused('no-room-turn'));
  assert.deepEqual(s.created, []);
});

test(CASES[5], async t => {
  const s = await setup(t);
  s.spawn('old-child', 'session');
  endShareTurn(s.key('session'), s.turn);
  s.begin('successor');
  s.spawn('old-child', 'session');
  s.spawn('new-child', 'session');
  for (const name of ['session', 'old-child', 'new-child']) assert.deepEqual(await s.own(name), refused('no-room-turn'));
  // Even when the dispatch reuses the root session key, its old aliases expire.
  const current = s.begin('session');
  endShareTurn(s.key('session'), s.turn); // stale teardown cannot remove current
  assert.deepEqual(await s.own('old-child'), refused('no-room-turn'));
  assert.equal((await s.own('session')).success, true);
  assert.equal(current.active, true);
});

test(CASES[6], async t => {
  const s = await setup(t);
  assert.deepEqual(await s.own('unrelated'), refused('no-room-turn'));
  for (const value of [undefined, null, 7, ' ']) {
    assert.deepEqual(await s.call({sessionKey: value, requesterSessionKey: s.key('session')}), refused('no-room-turn'));
    s.hooks.get('subagent_spawned')?.({childSessionKey: value}, {requesterSessionKey: s.key('session')});
  }
  for (const parent of [undefined, null, 7, ' ', s.key('missing')]) {
    s.hooks.get('subagent_spawned')?.({childSessionKey: s.key('unrelated')}, {requesterSessionKey: parent});
  }
  s.spawn('unrelated', 'session', {childSessionKey: s.key('different-child')});
  assert.deepEqual(await s.own('unrelated'), refused('no-room-turn'));
  assert.deepEqual(s.created, []);
});

test(CASES[7], async t => {
  const s = await setup(t);
  const other = s.begin('other-session');
  s.spawn('foreign-history', 'other-session');
  endShareTurn(s.key('other-session'), other);
  s.begin('other-session');
  s.spawn('other-session', 'session');
  s.spawn('foreign-history', 'session');
  s.spawn('session', 'other-session');
  assert.deepEqual(await s.own('foreign-history'), refused('no-room-turn'));
  assert.equal((await s.own('other-session')).success, true);
  assert.equal((await s.own('session')).success, true);
  assert.deepEqual(s.created, ['other-session', 'session']);
});

test(CASES[8], async t => {
  const s = await setup(t);
  assert.throws(() => beginShareTurn('', s.turn), /unbound/);
  const historical = s.begin('historical');
  endShareTurn(s.key('historical'), historical);
  s.spawn('unresolved-child', 'historical');
  assert.deepEqual(await s.own('unresolved-child'), refused('no-room-turn'));
  assert.deepEqual(s.created, []);
});

test(CASES[9], async t => {
  const s = await setup(t);
  s.spawn('bound-child', 'session');
  s.turn.sealed = () => true;
  s.spawn('sealed-child', 'session');
  for (const name of ['session', 'bound-child', 'sealed-child']) assert.deepEqual(await s.own(name), refused('no-room-turn'));
  s.turn.sealed = () => false;
  assert.deepEqual(await s.own('sealed-child'), refused('no-room-turn')); // hook did not bind
  assert.deepEqual(s.created, []);
  assert.deepEqual(s.turn.records, {});
});

test('share lineage: missing hook API keeps own-session sharing and refuses unknown children', async t => {
  const s = await setup(t);
  let factory;
  registerRoomShareFileTool({registerTool: f => { factory = f; }});
  assert.equal((await factory({sessionKey: s.key('session')}).execute('call', {path: 'draft.md'})).details.success, true);
  assert.deepEqual((await factory({sessionKey: s.key('child')}).execute('call', {path: 'draft.md'})).details, refused('no-room-turn'));
});

test('share lineage: post sealing and turn end still fence child uploads during persistence', async t => {
  for (const closing of ['end', 'post']) await t.test(closing, async t => {
    const s = await setup(t);
    s.spawn('child', 'session');
    let entered, release;
    const paused = new Promise(r => { entered = r; });
    const resume = new Promise(r => { release = r; });
    s.turn.persist = async () => { entered(); await resume; };
    const task = s.own('child');
    await paused;
    let sealing;
    if (closing === 'end') endShareTurn(s.key('session'), s.turn);
    else sealing = s.turn.sealForPost();
    s.spawn('late', 'child');
    release();
    assert.deepEqual(await task, refused('no-room-turn'));
    await sealing;
    assert.deepEqual(await s.own('late'), refused('no-room-turn'));
    assert.deepEqual(s.created, []);
    assert.deepEqual(s.turn.records, {});
  });
});

test('share lineage: child late receipt stays uncertain after parent end', async t => {
  const s = await setup(t);
  s.spawn('child', 'session');
  s.turn.create = async () => {
    endShareTurn(s.key('session'), s.turn);
    return {artifactId: 'late-artifact', versionId: 'late-version'};
  };
  assert.deepEqual(await s.own('child'), refused('no-room-turn'));
  assert.equal(Object.values(s.turn.records)[0].state, 'creating');
  assert.equal(Object.values(s.turn.records)[0].result, undefined);
});
