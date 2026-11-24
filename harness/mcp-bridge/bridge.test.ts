// The stdio bridge (D22) in front of a fake stdio server that answers each request
// with the message it read: what the HTTP client sends reaches the process
// unchanged, what the process writes reaches the client unchanged, each session has
// its own process, and a foreign Host is rejected.
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { parseBridgeArgs, startBridge } from "./bridge.ts";

// Answers every request with {received: <message as read>, pid}; ignores notifications.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { received: message, pid: process.pid } }) + "\\n");
});
`;

let bridge: Server;
let url: string;

before(async () => {
  bridge = await startBridge({ port: 0, command: [process.execPath, "--input-type=module", "-e", FAKE_SERVER], stderr: () => {} });
  url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/mcp`;
});

after(() => new Promise<void>((resolve) => bridge.close(() => resolve())));

interface Message {
  jsonrpc: "2.0";
  id: number;
  result: { received: unknown; pid: number };
}

async function post(message: unknown, session?: string): Promise<{ status: number; session: string | null; body: Message | null }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session !== undefined) Object.assign(headers, { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).pop();
  return { status: response.status, session: response.headers.get("mcp-session-id"), body: data === undefined || data === "" ? null : (JSON.parse(data) as Message) };
}

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "paridad-test", version: "0" } },
});

test("parseBridgeArgs takes the port and everything after --command", () => {
  assert.deepEqual(parseBridgeArgs(["--port", "8123", "--command", "node", "mcp/src/main.ts", "--transport", "stdio"]), {
    port: 8123,
    command: ["node", "mcp/src/main.ts", "--transport", "stdio"],
  });
  assert.throws(() => parseBridgeArgs(["--port", "8123"]), /--command/);
  assert.throws(() => parseBridgeArgs(["--port", "x", "--command", "node"]), /--port/);
});

test("messages are forwarded both ways without changes", async () => {
  const init = await post(initialize(1));
  assert.equal(init.status, 200);
  assert.ok(init.session);
  assert.deepEqual(init.body!.result.received, initialize(1));
  assert.equal(init.body!.id, 1);

  const call = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "emails_send", arguments: { body: { to: ["a@b.c"], n: 1.5, nested: [null, true, { "ü": "😀" }] }, idempotency_key: "k" } },
  };
  const answer = await post(call, init.session!);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body!.result.received, call);
  assert.equal(answer.body!.result.pid, init.body!.result.pid);
});

test("each session has its own process", async () => {
  const first = await post(initialize(1));
  const second = await post(initialize(1));
  assert.notEqual(first.session, second.session);
  assert.notEqual(first.body!.result.pid, second.body!.result.pid);
});

test("an unknown session is 404 and a request without session that is not initialize is 400", async () => {
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "no-such-session")).status, 404);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 400);
});

test("a foreign Host or Origin is rejected (DNS rebinding)", async () => {
  const status = (headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(JSON.stringify(initialize(1)));
    });
  assert.equal(await status({ host: "evil.example" }), 403);
  assert.equal(await status({ origin: "http://evil.example" }), 403);
});
