import assert from "node:assert/strict";
import test from "node:test";
import {evaluateRolloutMatrix,MINIMUM_MULTI_ROOM_VERSION} from "../tools/rollout-gate.mjs";

const approved="sha256:"+"b".repeat(64);
const row=(overrides={})=>({agent:"Aura",host:"owner-host",active:true,pluginVersion:"0.2.26",sourceCommit:"a".repeat(40),artifactIdentity:approved,verified:true,...overrides});
test("rollout gate requires every active OpenClaw target on one verified artifact",()=>{const result=evaluateRolloutMatrix([row(),row({agent:"Zurie"})],{requiredArtifact:approved});assert.equal(result.promotable,true);assert.equal(result.minimumVersion,MINIMUM_MULTI_ROOM_VERSION)});
test("rollout gate fails closed for old, unknown, unverified, or divergent targets",()=>{for(const changed of [{pluginVersion:"0.2.24"},{pluginVersion:""},{sourceCommit:"unknown"},{artifactIdentity:""},{verified:false},{artifactIdentity:"sha256:"+"c".repeat(64)}])assert.equal(evaluateRolloutMatrix([row(changed)],{requiredArtifact:approved}).promotable,false)});
