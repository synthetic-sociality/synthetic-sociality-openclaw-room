import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ShareTurn, LIMIT, refs, refused, registerRoomShareFileTool, beginShareTurn, endShareTurn} from '../src/share-file.js';
import {RoomClient, RoomAPIError} from '../src/room-client.js';
import {discussionDocuments, discussionDocumentContext} from '../src/documents.js';
import {OpenClawRoomRuntime} from '../src/runtime.js';
import {validateState} from '../src/state.js';
const fixture=JSON.parse(await readFile(new URL('./fixtures/agent-files.json',import.meta.url),'utf8'));
assert.deepEqual(JSON.parse(await readFile(new URL('../conformance.json',import.meta.url),'utf8')).parityP10Cases,fixture.cases);
async function setup(t) {
  const base=await mkdtemp(join(tmpdir(),'room-p10-')); t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'workspace'); await mkdir(root);
  const path=join(root,fixture.file.name); await writeFile(path,fixture.file.text);
  const records={},created=[],saved=[];
  const persist=async()=>{saved.push(structuredClone(records));};
  const create=async(...args)=>{created.push(args);assert.equal(Object.values(saved.at(-1)).at(-1).state,'creating');return structuredClone(fixture.artifact);};
  const turn=new ShareTurn({records,root,excluded:[join(root,'private')],persist,create});
  return {base,root,path,records,created,saved,turn};
}
for(const {name,scenario} of fixture.cases) test(name,async t=>{
  const s=await setup(t); let args={path:s.path};
  if(['outside','symlink'].includes(scenario)){
    const outside=join(s.base,'other.md');await writeFile(outside,'private');
    args.path=outside;
    if(scenario==='symlink'){args.path=join(s.root,'alias.md');await symlink(outside,args.path);}
  }
  if(scenario==='type'){args.path=join(s.root,'secret.env');await writeFile(args.path,'no');}
  if(scenario==='size')await writeFile(s.path,Buffer.alloc(LIMIT+1));
  if(scenario==='no-turn'){
    let factory;registerRoomShareFileTool({registerTool:f=>{factory=f;}});
    const result=await factory({sessionKey:'unbound'}).execute('call',args);
    assert.deepEqual(result.details,refused('no Room turn'));return;
  }
  if(scenario==='others'){
    const listed=discussionDocuments({activeTopic:{documents:[{artifactId:'artifact-fixture',versionId:'version-fixture',name:'draft.md',mimeType:'text/markdown',classification:'room_shared',authorRole:'agent',authoredByMembershipId:'other-agent'}]}});
    assert.equal(listed.length,1);
    const result=await discussionDocumentContext(listed,async()=>({status:'ready',text:fixture.file.text}),{given:[],tool:'available'});
    assert.ok(result.context.includes(fixture.file.text.trim()));return;
  }
  const result=await s.turn.share(args);
  if(['outside','symlink','type','size'].includes(scenario)){
    assert.deepEqual(result,refused({outside:'outside-share-root',symlink:'outside-share-root'}[scenario]??scenario));assert.equal(s.created.length,0);return;
  }
  assert.equal(result.success,true);
  assert.deepEqual(s.created[0],[Buffer.from(fixture.file.text),'draft.md','text/markdown','draft.md']);
  assert.deepEqual(Object.values(s.saved.at(-1))[0].result,result);
  if(scenario==='title'){assert.equal((await s.turn.share({...args,title:'Draft title'})).success,true);assert.equal(s.created.at(-1)[3],'Draft title');}
  if(scenario==='two'){const path=join(s.root,'second.txt');await writeFile(path,'two');assert.equal((await s.turn.share({path})).success,true);assert.equal(refs(s.records).length,2);}
  if(scenario==='crash'){
    const replay=new ShareTurn({records:JSON.parse(JSON.stringify(s.saved.at(-1))),root:s.root,excluded:[],persist:async()=>{},create:()=>assert.fail('duplicate')});
    assert.deepEqual(await replay.share(args),result);assert.equal(s.created.length,1);
  }
  if(scenario==='post'){
    const runtime=new OpenClawRoomRuntime({});
    runtime.state={version:1,baseUrl:'https://fixture.invalid/api',roomId:'room',membershipId:'agent',credential:'synthetic',clientInstanceId:'fixture',cursor:0,shareUploads:{source:s.records}};
    runtime.persistState=async()=>{};runtime.markTurnPreparing=async()=>{};runtime.attemptAuthorityLost=async()=>null;
    runtime.client={roomState:async()=>({headSeq:1,activeEpoch:{id:'epoch'}}),roomPolicy:async()=>({coordinationMode:'open'}),postMessage:async(_state,post)=>{assert.deepEqual(post.attachments,refs(s.records));throw new Error('crash after freeze');}};
    const request={roomId:'room',text:'Shared.',replyToId:'source',sourceEventId:'source',idempotencyKey:'source:final'};
    await assert.rejects(runtime.postAndFinishOnce(request));
    const intent=runtime.state.deliveryIntents['source:final'];assert.deepEqual(intent.identity.attachments,refs(s.records));assert.deepEqual(intent.post.attachments,refs(s.records));
    validateState(runtime.state);
    const snapshot=structuredClone(runtime.state);
    await assert.rejects(runtime.postAndFinishOnce(request));assert.deepEqual(runtime.state.deliveryIntents['source:final'].post,intent.post);
    snapshot.deliveryIntents['source:final'].post.attachments=[];assert.throws(()=>validateState(snapshot),/frozen|pending/i);
  }
});
test('P10 extra: stores, eight-file cap, ambiguity, sealed turns and active registration',async t=>{
 const s=await setup(t);await mkdir(join(s.root,'private'));const hidden=join(s.root,'private','hidden.md');await writeFile(hidden,'private');assert.equal((await s.turn.share({path:hidden})).code,'outside-share-root');
 for(let i=0;i<8;i++){const path=join(s.root,`${i}.txt`);await writeFile(path,'ok');assert.equal((await s.turn.share({path})).success,true);}
 assert.equal((await s.turn.share({path:s.path})).code,'per-turn cap');s.turn.sealed=()=>true;assert.equal((await s.turn.share({path:s.path})).code,'no Room turn');
 const turn=new ShareTurn({records:{},root:s.root,excluded:[],persist:async()=>{},create:async()=>{throw Error('ambiguous');}});
 assert.equal((await turn.share({path:s.path})).code,'upload-uncertain');turn.create=()=>assert.fail('retry');assert.equal((await turn.share({path:s.path})).code,'upload-uncertain');
 let factory;registerRoomShareFileTool({registerTool:f=>{factory=f;}});beginShareTurn('bound',turn);assert.equal((await factory({sessionKey:'other'}).execute('call',{path:s.path})).details.code,'no Room turn');endShareTurn('bound',turn);assert.equal((await factory({sessionKey:'bound'}).execute('call',{path:s.path})).details.code,'no Room turn');
});
test('P10 extra: durable write failure before create and after receipt',async t=>{
 const s=await setup(t);
 for(const failAt of [1,2]){
  const records={},calls=[],disk=[];
  const turn=new ShareTurn({records,root:s.root,excluded:[],persist:async()=>{calls.push('save');if(calls.filter(x=>x==='save').length===failAt)throw Error('disk');disk.push(structuredClone(records));},create:async()=>{calls.push('create');return fixture.artifact;}});
  assert.equal((await turn.share({path:s.path})).code,'upload-uncertain');assert.equal(calls.filter(x=>x==='create').length,failAt===1?0:1);
  if(failAt===2){const replay=new ShareTurn({records:disk[0],root:s.root,excluded:[],persist:async()=>{},create:()=>assert.fail('duplicate')});assert.equal((await replay.share({path:s.path})).code,'upload-uncertain');}
 }
});
test('P10 extra: multipart uses agent auth, typed bytes, sharing and refusal mapping',async t=>{
 const client=new RoomClient({baseUrl:'https://fixture.invalid/api',credential:'synthetic',fetchImpl:async(url,init)=>{
  assert.ok(url.endsWith('/rooms/room%20one/artifacts'));assert.equal(init.headers.Authorization,'Bearer synthetic');assert.equal(init.redirect,'error');assert.equal(init.body.get('visibility'),'room_shared');assert.equal(init.body.get('title'),'Title');const file=init.body.get('file');assert.equal(file.type,'text/markdown');assert.equal(file.name,'draft.md');assert.equal(await file.text(),'hello');
  return new Response(JSON.stringify(fixture.artifact),{status:201});
 }});
 assert.deepEqual(await client.createArtifact({roomId:'room one',credential:'synthetic'},Buffer.from('hello'),'draft.md','text/markdown','Title'),fixture.artifact);
 const s=await setup(t);
 for(const [status,code,wanted] of [[413,'message_too_large','size'],[400,'invalid_enum','type'],[403,'validation_error','upload']]){
  const turn=new ShareTurn({records:{},root:s.root,excluded:[],persist:async()=>{},create:async()=>{throw new RoomAPIError(status,{code});}});assert.equal((await turn.share({path:s.path})).code,wanted);
 }
});

test('P10 host channel: explicit tool stays active through host run, then closes',async t=>{
 const {registerHooks}=await import('node:module');
 const mocks={
  'openclaw/plugin-sdk/channel-core':'export const defineChannelPluginEntry = entry => entry;',
  'openclaw/plugin-sdk/channel-message':'export const defineChannelMessageAdapter = adapter => adapter;',
  'openclaw/plugin-sdk/channel-inbound':'export const buildChannelInboundEventContext = ctx => ctx;',
  'openclaw/plugin-sdk/account-id':'export const normalizeAccountId = value => String(value ?? "default").trim().toLowerCase();',
 };
 const hook=registerHooks({resolve(specifier,context,next){return mocks[specifier]?{url:`data:text/javascript,${encodeURIComponent(mocks[specifier])}`,shortCircuit:true}:next(specifier,context);}});
 t.after(()=>hook.deregister());
 const s=await setup(t);const oldHome=process.env.HOME;process.env.HOME=s.base;t.after(()=>{process.env.HOME=oldHome;});
 const {createRoomChannel}=await import('../src/channel.js');
 const {ISOLATED_HOST_CONFIG}=await import('./support/isolated-host.mjs');
 let factory,posted=0;registerRoomShareFileTool({registerTool:f=>{factory=f;}});
 const event={id:'source',sourceEventId:'source',respondsToId:'source',roomId:'room',epochId:'epoch',conversationId:'room:epoch',senderId:'human',senderName:'Owner',senderKind:'human',text:'Make a draft.',occurredAt:1,raw:{}};
 const state={roomId:'room',membershipId:'agent',credential:'synthetic'};
 const saves=[];
 const client={state,client:{createArtifact:async(_state,data,name,mime,title)=>{assert.equal(mime,'text/markdown');assert.equal(title,'draft.md');return fixture.artifact;}},
  persistState:async()=>saves.push(structuredClone(state)),initialize:async()=>({sessionId:'session'}),assignedTurns:async function*(){yield event;},markTurnReading:async()=>{},markDocumentsGiven:async()=>{},
  postAndFinish:async()=>{posted++;assert.deepEqual(refs(saves.at(-1).shareUploads.source),[{artifactId:'artifact-fixture',versionId:'version-fixture'}]);state.deliveryIntents={'source:final':{}};return {eventId:'posted',sentAt:1};},
  recordSkipped:async()=>assert.fail('unexpected skip'),ack:async()=>{},close:async()=>{},
 };
 const stateFile=join(s.base,'private','state.json');
 const cfg=structuredClone(ISOLATED_HOST_CONFIG);cfg.agents={defaults:{workspace:s.root}};
 cfg.channels={'synthetic-sociality-room':{baseUrl:'https://fixture.invalid/api',stateFile}};
 const channel=createRoomChannel({makeClient:()=>client});
 let status={};const key='agent:main:synthetic-sociality-room:group:room';
 const ctx={account:{accountId:'default',stateFile},accountId:'default',abortSignal:new AbortController().signal,cfg,getStatus:()=>status,setStatus:v=>{status=v;},log:{info(){},warn(){},error(){}},channelRuntime:{
  inbound:{run:async({raw,adapter})=>{const turn=adapter.resolveTurn(adapter.ingest(raw));const tool=factory({sessionKey:key});assert.equal((await tool.execute('call',{path:s.path})).details.success,true);await turn.delivery.deliver({text:'Shared.'});assert.equal((await tool.execute('later',{path:s.path})).details.code,'no Room turn');}},
  routing:{resolveAgentRoute:()=>({agentId:'main',accountId:'default',sessionKey:key,mainSessionKey:'main'})},session:{resolveStorePath:()=>join(s.base,'sessions'),recordInboundSession:async()=>{}},reply:{dispatchReplyWithBufferedBlockDispatcher:async()=>{}},
 }};
 await channel.plugin.gateway.startAccount(ctx);assert.equal(posted,1);
 assert.equal((await factory({sessionKey:key}).execute('outside',{path:s.path})).details.code,'no Room turn');
});
