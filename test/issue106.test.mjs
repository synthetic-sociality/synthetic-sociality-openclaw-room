// Shared ISSUE-106 cases. Only local source, synthetic state and mocked Room I/O.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenClawRoomRuntime, cyclePhaseInstruction} from "../src/runtime.js";
import {loadState, saveState, validateState} from "../src/state.js";
const fixture = JSON.parse(await readFile(new URL("./fixtures/issue-106.json", import.meta.url)));
const state = () => ({version:1,baseUrl:"https://fixture.invalid/api",roomId:"room",membershipId:"self",credential:"fixture",clientInstanceId:"client",cursor:0,messagePayloadDialect:"v1",deliveryIntents:{}});
function harness(file, initial, posts, fail = false) {
  const runtime = new OpenClawRoomRuntime({accountId:"fixture",stateFile:file,baseUrl:initial.baseUrl});
  runtime.state = initial;
  runtime.pendingEvent = {id:"source",seq:1};
  runtime.markTurnPreparing = async () => {};
  runtime.markTurnPosted = async () => {};
  runtime.client = {
    roomState: async () => ({headSeq:1,activeEpoch:{id:"epoch"},roster:[{membershipId:"peer",displayName:"Peer",role:"participant_agent",status:"active"}]}),
    roomPolicy: async () => ({policy:{coordinationMode:"open"}}),
    postMessage: async (_state, payload) => {
      posts.push(structuredClone(payload));
      if (fail) throw Error("ambiguous fixture disconnect");
      return {id:"canonical",seq:2,ts:"2026-10-21T00:00:00Z"};
    },
  };
  return runtime;
}
const envelope = (item) => JSON.stringify({action:"contribute",body:"@Peer Same text?",...(item.type === null ? {} : {contributionType:item.type})});
for (const item of fixture.cases) {
  test(`${item.id} / I106-05 directed classification, disk reload, exact retry, receipt`, async () => {
    const dir = await mkdtemp(join(tmpdir(),"issue106-"));
    try {
      for (const fenced of [false,true]) {
        const file=join(dir,`${fenced}.json`), posts=[];
        const runtime=harness(file,state(),posts,true);
        const text=fenced ? `\`\`\`json\n${envelope(item)}\n\`\`\`` : envelope(item);
        const request={roomId:"room",text,idempotencyKey:"source:final",sourceEventId:"source",resolveRecipientMentions:true};
        await assert.rejects(runtime.postAndFinish(request),/ambiguous fixture disconnect/);
        const saved=await loadState(file);
        assert.equal(saved.deliveryIntents[request.idempotencyKey].identity.contributionType,item.type || "claim");
        assert.equal(posts[0].contributionType,item.type || "claim");
        assert.equal(posts[0].body,"@Peer Same text?");
        assert.equal(posts[0].recipientSelectors.length,1);
        const restarted=harness(file,saved,posts);
        await restarted.postAndFinish(request);
        assert.deepEqual(posts[1],posts[0]);
        validateState(await loadState(file));
        await restarted.postAndFinish(request);
        assert.equal(posts.length,2,"canonical receipt prevents repost");
        await assert.rejects(restarted.postAndFinish({...request,text:JSON.stringify({action:"contribute",body:"@Peer Same text?",contributionType:item.type === "response" ? "claim":"response"})}),/different semantic intent/);
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
}
test("I106-06 legacy frozen directed question replays unchanged",async () => {
  const dir=await mkdtemp(join(tmpdir(),"issue106-legacy-"));
  try {
    const file=join(dir,"state.json"),posts=[];
    const first=harness(file,state(),posts,true);
    const request={roomId:"room",text:"@Peer Same text?",idempotencyKey:"fixture-legacy",resolveRecipientMentions:true};
    await assert.rejects(first.postAndFinish(request));
    const saved=await loadState(file),intent=saved.deliveryIntents[request.idempotencyKey];
    delete intent.identity.contributionType;
    intent.post.contributionType="question";
    await saveState(file,saved);
    const frozen=structuredClone(intent.post);
    const restarted=harness(file,await loadState(file),posts);
    await restarted.postAndFinish(request);
    assert.deepEqual(posts.at(-1),frozen);
    validateState(await loadState(file));
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("I106-07 unsupported types never post",async () => {
  for (const kind of fixture.rejected) {
    const posts=[],runtime=harness("unused",state(),posts);
    await assert.rejects(runtime.postAndFinish({roomId:"room",text:JSON.stringify({action:"contribute",body:"Same text?",contributionType:kind}),idempotencyKey:"fixture-invalid"}),/Invalid Room contribution/);
    assert.equal(posts.length,0);
    assert.deepEqual(runtime.state.deliveryIntents,{});
  }
});
test("I106-08 moderator fixture covers named delegation and optional same-turn summary",async () => {
  const source=await readFile(new URL("./parity-p7c.test.mjs",import.meta.url),"utf8");
  const instruction = JSON.parse(source.match(/const RESPONSE_INSTRUCTION = (".*");/)[1]);
  assert.deepEqual(cyclePhaseInstruction({}, {}, {phase:"response",phaseInstruction:instruction}),{phase:"response",instruction});
  for (const clause of ["every sub-question","by name","may include a short interim summary within this turn","one short clarifying question"]) assert.ok(source.includes(clause));
});
test("I106-06 legacy envelope prose and I106-05 nested envelope body survive restart",async () => {
  const dir=await mkdtemp(join(tmpdir(),"issue106-envelope-"));
  try {
    for (const legacy of [false,true]) {
      const file=join(dir,`${legacy}.json`),posts=[];
      const inner=JSON.stringify({action:"contribute",body:"@Peer literal JSON",contributionType:legacy ? "evidence":"question"});
      const first=harness(file,state(),posts,true);
      const request={roomId:"room",text:inner,contributionType:"response",sourceEventId:"source",idempotencyKey:"source:final",resolveRecipientMentions:true};
      await assert.rejects(first.postAndFinish(request));
      const saved=await loadState(file),intent=saved.deliveryIntents[request.idempotencyKey];
      if (legacy) {
        delete intent.identity.contributionType;
        intent.post.contributionType=intent.post.recipientSelectors?.length ? "question":"claim";
      }
      await saveState(file,saved);
      const frozen=structuredClone(intent.post);
      const restarted=harness(file,await loadState(file),posts);
      assert.equal(await restarted.recoverPendingDelivery({id:"source",seq:1}),true);
      assert.deepEqual(posts.at(-1),frozen);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
