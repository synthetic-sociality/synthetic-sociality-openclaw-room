// The signed release builder replaces this development placeholder inside
// the staged package. A source checkout deliberately reports unknown values,
// causing the Room release gate to fail closed instead of claiming provenance.
export const ROOM_CONNECTOR_PROVENANCE = Object.freeze({
  version: "0.2.26",
  sourceCommit: "unknown",
  artifactIdentity: "unknown",
});
