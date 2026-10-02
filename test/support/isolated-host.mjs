// An OpenClaw host configuration under which the agent's tools cannot reach
// the Room store (contract P2c-1): file tools workspace-only, shell tools
// denied. Tests about other behaviour start accounts under it.
export const ISOLATED_HOST_CONFIG = Object.freeze({
  tools: Object.freeze({fs: Object.freeze({workspaceOnly: true}), deny: Object.freeze(["group:runtime"])}),
});
