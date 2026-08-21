import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, link, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {
  accountCandidates,
  canonicalStateFileIdentity,
  claimRuntimeOwnership,
  claimRuntimeStateFile,
  resolveAccountConfig,
  resolveAccountSelection,
  selectUniqueAccountIds,
} from "../src/account.js";

test("selected default account honors the state file from the latest invitation", () => {
  const selected = resolveAccountSelection({
    accountId: "default",
    raw: {
      enabled: true,
      baseUrl: "https://sociality.example/api",
      stateFile: "/private/accounts/current-membership.json",
    },
    managed: {
      baseUrl: "https://old.example/api",
      stateFile: "/private/accounts/default.json",
    },
    defaultStateFile: "/private/accounts/default.json",
  });

  assert.equal(selected.baseUrl, "https://sociality.example/api");
  assert.equal(selected.stateFile, "/private/accounts/current-membership.json");
});

test("named managed accounts still resolve their own state", () => {
  const selected = resolveAccountSelection({
    accountId: "member-2",
    raw: {enabled: true},
    managed: {
      baseUrl: "https://sociality.example/api",
      stateFile: "/private/accounts/member-2.json",
    },
    defaultStateFile: "/private/accounts/default.json",
  });

  assert.equal(selected.baseUrl, "https://sociality.example/api");
  assert.equal(selected.stateFile, "/private/accounts/member-2.json");
});

test("named managed accounts never inherit the top-level default state", () => {
  const section = {
    enabled: true,
    baseUrl: "https://default.example/api",
    stateFile: "/private/accounts/default.json",
  };

  assert.deepEqual(resolveAccountConfig(section, "member-2"), {});
  assert.equal(resolveAccountConfig(section, "default"), section);
});

test("an explicit named account config remains authoritative", () => {
  const named = {
    enabled: true,
    baseUrl: "https://room.example/api",
    stateFile: "/private/accounts/member-2.json",
  };
  const section = {
    stateFile: "/private/accounts/default.json",
    accounts: {"member-2": named},
  };

  assert.equal(resolveAccountConfig(section, "member-2"), named);
});

test("candidate priority is default then explicit config then managed files", () => {
  assert.deepEqual(
    accountCandidates({accounts: {zurie: {}, aura: {}}}, ["managed", "zurie", "other"]),
    ["default", "zurie", "aura", "managed", "other"],
  );
});

test("Zurie topology starts two canonical runtimes for three account IDs sharing two state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-accounts-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory);
  const shared = join(realDirectory, "shared.json");
  const distinct = join(realDirectory, "distinct.json");
  await writeFile(shared, "{}", {mode: 0o600});
  await writeFile(distinct, "{}", {mode: 0o600});

  const candidates = ["default", "zurie-alias", "zurie-staging"];
  const paths = {
    default: relative(process.cwd(), shared),
    "zurie-alias": join(aliasDirectory, "shared.json"),
    "zurie-staging": distinct,
  };
  assert.deepEqual(
    selectUniqueAccountIds(candidates, (accountId) => ({accountId, stateFile: paths[accountId]})),
    ["default", "zurie-staging"],
  );
  assert.equal(canonicalStateFileIdentity(paths.default), canonicalStateFileIdentity(paths["zurie-alias"]));
});

test("Aura topology keeps three runtimes for three distinct state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-aura-"));
  const candidates = ["default", "aura-production", "aura-staging"];
  const paths = Object.fromEntries(candidates.map((accountId) => [accountId, join(root, `${accountId}.json`)]));
  assert.deepEqual(
    selectUniqueAccountIds(candidates, (accountId) => ({accountId, stateFile: paths[accountId]})),
    candidates,
  );
});

test("canonicalizes nonexistent state files through their longest existing real ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-missing-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory);
  assert.equal(
    canonicalStateFileIdentity(join(realDirectory, "future", "state.json")),
    canonicalStateFileIdentity(join(aliasDirectory, "future", ".", "state.json")),
  );
});

test("duplicate runtime state-file claims fail closed and release only their own claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-runtime-claim-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, aliasDirectory);
  const registry = new Map();
  const release = claimRuntimeStateFile(registry, {accountId: "default", stateFile: join(realDirectory, "state.json")});
  assert.throws(
    () => claimRuntimeStateFile(registry, {accountId: "alias", stateFile: join(aliasDirectory, "state.json")}),
    /already claimed by another Room runtime/,
  );
  release();
  const releaseAlias = claimRuntimeStateFile(registry, {accountId: "alias", stateFile: join(aliasDirectory, "state.json")});
  assert.equal(registry.size, 1);
  releaseAlias();
  assert.equal(registry.size, 0);
});

test("existing hard-link aliases share one physical discovery identity but fail runtime ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-hardlink-"));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writeFile(first, "{}", {mode: 0o600});
  await link(first, second);
  assert.equal(canonicalStateFileIdentity(first), canonicalStateFileIdentity(second));
  assert.throws(
    () => claimRuntimeOwnership({accounts: new Map(), stateFiles: new Map()}, {accountId: "default", stateFile: first}),
    /must not be hard-linked/,
  );
});

test("runtime ownership rejects both duplicate account IDs and duplicate physical files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-ownership-"));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writeFile(first, "{}", {mode: 0o600});
  await writeFile(second, "{}", {mode: 0o600});
  const registries = {accounts: new Map(), stateFiles: new Map()};
  const owner = claimRuntimeOwnership(registries, {accountId: "default", stateFile: first});
  assert.throws(
    () => claimRuntimeOwnership(registries, {accountId: "default", stateFile: second}),
    /account is already claimed/,
  );
  assert.throws(
    () => claimRuntimeOwnership(registries, {accountId: "alias", stateFile: first}),
    /state file is already claimed/,
  );
  assert.equal(owner.owns(), true);
  owner.release();
  assert.equal(owner.owns(), false);
});

test("a nonexistent claimed path cannot be bypassed by creating a hard-link alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-room-late-hardlink-"));
  const first = join(root, "first.json");
  const alias = join(root, "alias.json");
  const registries = {accounts: new Map(), stateFiles: new Map()};
  const owner = claimRuntimeOwnership(registries, {accountId: "default", stateFile: first});
  await writeFile(first, "{}", {mode: 0o600});
  await link(first, alias);
  assert.throws(
    () => claimRuntimeOwnership(registries, {accountId: "alias", stateFile: alias}),
    /must not be hard-linked/,
  );
  assert.equal(owner.owns(), true);
  owner.release();
});
