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

// Repair round: shared prompt, matrix and external-path boundary cases.
test("I106-09 shared procedural format is emitted by the prompt builder", async () => {
  const {roomTurnFacts}=await import("../src/runtime.js");
  const manifest=JSON.parse(await readFile(new URL("../conformance.json",import.meta.url)));
  assert.equal(manifest.issue106Cases.formatSentence,fixture.formatSentence);
  assert.ok(roomTurnFacts().includes(fixture.formatSentence));
});
test("I106-10 shared 28-input model-output matrix", async () => {
  const {contributionOutput}=await import("../src/contribution.js");
  for (const item of fixture.matrix) {
    const posts=[],runtime=harness("unused",state(),posts);
    if (item.outcome === "fail") {
      assert.throws(()=>contributionOutput(item.raw), /Invalid Room contribution/, `input ${item.input}`);
    } else if (item.outcome === "pass") {
      const result=await runtime.postAndFinish({roomId:"room",text:item.raw,idempotencyKey:"matrix"});
      assert.equal(result.skipped,true,`input ${item.input}`);
      assert.equal(posts.length,0);
      assert.deepEqual(runtime.state.deliveryIntents,{});
    } else {
      const parsed=contributionOutput(item.raw);
      assert.equal(parsed.body,item.body,`input ${item.input}`);
      assert.equal(parsed.contributionType,item.type,`input ${item.input}`);
    }
  }
});
test("I106-11 external literal envelope and old external identity survive retry", async () => {
  const dir=await mkdtemp(join(tmpdir(),"issue106-external-"));
  try {
    for (const legacy of [false,true]) {
      const file=join(dir,`${legacy}.json`),posts=[];
      const runtime=harness(file,state(),posts,true);
      const request={roomId:"room",text:fixture.externalText,idempotencyKey:"external",literal:true};
      await assert.rejects(runtime.postAndFinish(request),/ambiguous/);
      assert.equal(posts[0].body,fixture.externalText);
      assert.equal(posts[0].contributionType,"claim");
      const saved=await loadState(file),intent=saved.deliveryIntents.external;
      if (legacy) {
        delete intent.identity.contributionType;
        intent.identity.recipientSelectors=[{kind:"membership",membershipId:"peer"}];
        intent.post.recipientSelectors=structuredClone(intent.identity.recipientSelectors);
        intent.post.contributionType="question";
      }
      const frozen=structuredClone(intent.post);
      await saveState(file,saved);
      const restarted=harness(file,await loadState(file),posts);
      await restarted.postAndFinish(request);
      assert.deepEqual(posts.at(-1),frozen);
    }
    const channel=await readFile(new URL("../src/channel.js",import.meta.url),"utf8");
    assert.match(channel.split('text: async (ctx) =>')[1].split('// The epoch-path')[0],/literal: true/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("P2-2 size refusal releases the attempt with the shared remediation hint", async () => {
  const runtime=harness("unused",state(),[]),settled=[];
  runtime.persistState=async () => {};
  runtime.releaseAttempt=async (attempt,failure) => settled.push({attempt,failure});
  const attempt={cycle:{id:"cycle",generation:1},attempt:{id:"attempt"}};
  const intent={identity:{body:"large response",sourceEventId:"",cycle:null}};
  assert.deepEqual(await runtime.refuseTooLarge(intent,Error("too large"),attempt),{refused:true,reason:"message_too_large"});
  assert.deepEqual(settled,[{attempt,failure:{layer:"runtime",code:"response_too_large",remediationHint:"The response exceeded the Room's message size limit. Retry with a shorter response."}}]);
});
