// P11b: the connector's product User-Agent on every Room request (contract P11b-1, shared cases P11b-2).
// Offline: the real RoomClient request path with a recording fetch for every request kind P11b-1 names, and one
// loopback listener that records the header Node's fetch actually sends on the photo download. Same case names as
// the Hermes connector's tests/test_parity_p11b.py. No Room, edge or provider contact.
import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {ROOM_USER_AGENT, RoomClient} from "../src/room-client.js";

const PRODUCT = "synthetic-sociality-openclaw/1.0";
const CASES = [
  "every Room request carries the connector user agent",
  "photo download carries the connector user agent on the wire",
];
const conformance = JSON.parse(await readFile(new URL("../conformance.json", import.meta.url), "utf8"));
const contract = await readFile(new URL("../docs/delivery-lifecycle-contract-v1.md", import.meta.url), "utf8");
const SESSION = {roomId: "room-1", credential: "secret-1"};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

test("P11b conformance names the clause and the shared cases", () => {
  assert.deepEqual(conformance.parityP11bCases, CASES);
  assert.match(conformance.parityP11bContract, /^docs\/delivery-lifecycle-contract-v1\.md#p11b/);
  assert.ok(contract.includes(`OpenClaw: \`${PRODUCT}\``), "the contract names the OpenClaw product value");
  assert.equal(ROOM_USER_AGENT, PRODUCT, "one shared constant, product only");
});

test(CASES[0], async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({url: String(url), agent: new Headers(init.headers).get("user-agent")});
    if (String(url).includes("/download")) return new Response(PNG, {status: 200, headers: {"content-type": "image/png"}});
    if (String(url).includes("/artifacts") && init.method === "POST") return Response.json({id: "art-1"}, {status: 201});
    if (String(url).includes("/events")) return Response.json({events: []});
    return Response.json({});
  };
  const client = new RoomClient({baseUrl: "https://room.example/api", credential: "secret-1", fetchImpl});
  await client.roomState(SESSION);                                           // JSON API
  await client.acknowledge(SESSION, 3);                                      // JSON API with a body
  await client.readEvents(SESSION, 0, {wait: 1});                            // event stream (long poll)
  await client.createArtifact(SESSION, Buffer.from("x"), "a.txt", "text/plain", "A"); // multipart upload
  await client.downloadArtifact(SESSION, "art-1", "v-1", "image/png");       // P9-2 download
  await client.status();                                                     // unauthenticated JSON
  assert.equal(seen.length, 6);
  for (const request of seen) assert.equal(request.agent, PRODUCT, request.url);
});

test(CASES[1], async () => {
  const agents = [];
  const server = createServer((request, response) => {
    agents.push(request.headers["user-agent"]);
    response.writeHead(200, {"content-type": "image/png"});
    response.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const client = new RoomClient({baseUrl: base, credential: "secret-1"});
    const download = await client.downloadArtifact(SESSION, "art-1", "v-1", "image/png");
    assert.equal(download.contentType, "image/png");
    // A request formed without the constant shows the library default the edge would see.
    await fetch(`${base}/plain`);
    assert.equal(agents[0], PRODUCT, "the runtime sends the product agent on the wire");
    assert.notEqual(agents[1], PRODUCT);
    assert.match(String(agents[1]), /node/i, "Node's fetch default agent");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
