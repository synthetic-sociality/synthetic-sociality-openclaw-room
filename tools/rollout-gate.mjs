#!/usr/bin/env node
import {readFile} from "node:fs/promises";

export const MINIMUM_MULTI_ROOM_VERSION = "0.2.25";

export function evaluateRolloutMatrix(entries, {minimumVersion = MINIMUM_MULTI_ROOM_VERSION, requiredArtifact = ""} = {}) {
  const failures=[];
  for(const entry of Array.isArray(entries)?entries:[]){
  const label=`${entry.agent || "unknown-agent"}@${entry.host || "unknown-host"}`;
  if(!entry.active) continue;
  if(!validSemver(entry.pluginVersion)) failures.push(`${label}: plugin version unknown or invalid`);
  else if(compareSemver(entry.pluginVersion,minimumVersion)<0) failures.push(`${label}: ${entry.pluginVersion} is below ${minimumVersion}`);
  if(!/^[a-f0-9]{40}$/.test(String(entry.sourceCommit||""))) failures.push(`${label}: source commit unknown or invalid`);
  if(!String(entry.artifactIdentity||"").trim()) failures.push(`${label}: artifact identity unknown`);
  if(requiredArtifact && entry.artifactIdentity!==requiredArtifact) failures.push(`${label}: artifact identity differs from approved target`);
  if(entry.verified!==true) failures.push(`${label}: host artifact has not been read-only verified`);
  }
  if(!(Array.isArray(entries)&&entries.some(entry=>entry.active))) failures.push("no active OpenClaw target was verified");
  return {promotable:failures.length===0,minimumVersion,failures};
}

function validSemver(value){return /^\d+\.\d+\.\d+$/.test(String(value||""))}
function compareSemver(a,b){const av=a.split(".").map(Number),bv=b.split(".").map(Number);for(let i=0;i<3;i++){if(av[i]!==bv[i])return av[i]-bv[i]}return 0}

if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){const matrix=JSON.parse(await readFile(process.argv[2],"utf8"));const result=evaluateRolloutMatrix(matrix,{requiredArtifact:process.argv[3]||""});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);if(!result.promotable)process.exitCode=1}
