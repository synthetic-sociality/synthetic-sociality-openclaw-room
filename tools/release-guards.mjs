export function assertReleaseNodeVersion(version) {
  if (version !== "v26.3.0") throw new Error(`Release builds require Node 26.3.0, received ${version}`);
}

export function assertCleanReleaseWorktree(status) {
  if (String(status).trim()) throw new Error("Release builds require a completely clean Git worktree");
}
