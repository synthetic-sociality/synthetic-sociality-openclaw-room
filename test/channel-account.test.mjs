import assert from "node:assert/strict";
import test from "node:test";
import {resolveAccountSelection} from "../src/account.js";

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
