// The MCP server (vault/CONTRACT.md §5, §6, D28) launched as a process against an
// in-process HTTP server that plays the API. Over stdio, with raw JSON-RPC lines:
// initialize with 2025-11-25, tools/list with one tool per operation and its
// annotations, a successful tools/call and the request it sends, a 404 as an isError
// result, invalid arguments rejected without a request, logging/setLevel, and debug
// output only on stderr. Over Streamable HTTP: the same tools and the Host check.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { TOOLS } from "../src/tools.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";
const PROTOCOL = "2025-11-25";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const received: { method: string; target: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let handler: Handler = (_req, res) => json(res, 200, { object: "list", has_more: false, data: [] });
const api = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ method: req.method ?? "", target: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res);
  });
});
let baseUrl: string;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ------------------------------------------------------------------------ stdio

interface Message {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let child: ChildProcessWithoutNullStreams;
const stdoutLines: string[] = [];
let stderr = "";
const waiting = new Map<number, (message: Message) => void>();
let nextId = 1;

function request(method: string, params: Record<string, unknown> = {}): Promise<Message> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method: string): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

before(async () => {
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  child = spawn(process.execPath, [MAIN, "--transport", "stdio"], {
    env: { ...process.env, RESEND_API_KEY: KEY, RESEND_BASE_URL: baseUrl, PARIDAD_DEBUG: "1" },
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdoutLines.push(line);
    const message = JSON.parse(line) as Message;
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
});

after(async () => {
  child.stdin.end();
  child.kill();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("initialize answers with protocol 2025-11-25 and the tools, logging, prompts and resources capabilities", async () => {
  const response = await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "paridad-test", version: "0" } });
  assert.equal(response.error, undefined);
  assert.equal(response.result!["protocolVersion"], PROTOCOL);
  const capabilities = response.result!["capabilities"] as Record<string, unknown>;
  assert.ok(capabilities["tools"]);
  assert.ok(capabilities["logging"]);
  assert.ok(capabilities["prompts"]);
  assert.ok(capabilities["resources"]);
  assert.equal((response.result!["serverInfo"] as { name: string }).name, "paridad-mcp");
  notify("notifications/initialized");
});

test("prompts/list and resources/list answer with empty lists", async () => {
  assert.deepEqual((await request("prompts/list")).result!["prompts"], []);
  assert.deepEqual((await request("resources/list")).result!["resources"], []);
});

test("tools/list has one tool per operation, with annotations and a 2020-12 input schema", async () => {
  const response = await request("tools/list");
  const tools = response.result!["tools"] as { name: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }[];
  assert.equal(tools.length, TOOLS.length);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );
  const domainsList = tools.find((tool) => tool.name === "domains_list")!;
  assert.deepEqual(domainsList.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  const domainsRemove = tools.find((tool) => tool.name === "domains_remove")!;
  assert.equal(domainsRemove.annotations["destructiveHint"], true);
  const send = tools.find((tool) => tool.name === "emails_send")!;
  assert.deepEqual(send.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  assert.equal(send.inputSchema["$schema"], "https://json-schema.org/draft/2020-12/schema");
  assert.equal(send.inputSchema["type"], "object");
  assert.deepEqual(send.inputSchema["required"], ["body"]);
  assert.ok((send.inputSchema["properties"] as Record<string, unknown>)["idempotency_key"]);
  assert.ok((send.inputSchema["$defs"] as Record<string, unknown>)["SendEmailRequest"]);
});

test("a successful tools/call sends the expected request and returns its JSON", async () => {
  received.length = 0;
  handler = (_req, res) => json(res, 200, { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
  const body = { from: "Acme <onboarding@resend.dev>", to: ["delivered@resend.dev"], subject: "Hello World", html: "<p>It works!</p>" };
  const response = await request("tools/call", { name: "emails_send", arguments: { body, idempotency_key: "welcome-user-123" } });
  const result = response.result!;
  assert.notEqual(result["isError"], true);
  assert.deepEqual(JSON.parse((result["content"] as { text: string }[])[0]!.text), { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
  assert.equal(received.length, 1);
  const [sent] = received;
  assert.equal(sent!.method, "POST");
  assert.equal(sent!.target, "/emails");
  assert.equal(sent!.headers["authorization"], `Bearer ${KEY}`);
  assert.equal(sent!.headers["idempotency-key"], "welcome-user-123");
  assert.match(sent!.headers["user-agent"] ?? "", /^paridad-ts\/\S+ mcp$/);
  assert.deepEqual(JSON.parse(sent!.body), body);
});

test("query arguments reach the request", async () => {
  received.length = 0;
  handler = (_req, res) => json(res, 200, { object: "list", has_more: false, data: [] });
  const response = await request("tools/call", { name: "domains_list", arguments: { limit: 2, after: "abc" } });
  assert.notEqual(response.result!["isError"], true);
  assert.equal(received[0]!.method, "GET");
  assert.equal(received[0]!.target, "/domains?limit=2&after=abc");
});

test("a 404 of the API is a result with isError and the error object", async () => {
  received.length = 0;
  handler = (_req, res) => json(res, 404, { statusCode: 404, name: "not_found", message: "Domain not found" });
  const response = await request("tools/call", { name: "domains_get", arguments: { domain_id: "d91cd9bd-1176-453e-8fc1-35364d380206" } });
  assert.equal(response.error, undefined);
  const result = response.result!;
  const error = { error: { message: "Domain not found", code: "not_found", statusCode: 404 } };
  assert.equal(result["isError"], true);
  assert.deepEqual(result["structuredContent"], error);
  assert.deepEqual(JSON.parse((result["content"] as { text: string }[])[0]!.text), error);
  assert.equal(received.length, 1);
});

test("invalid arguments are rejected without a request", async () => {
  received.length = 0;
  for (const args of [{}, { domain_id: 42 }, { domain_id: "d91cd9bd-1176-453e-8fc1-35364d380206", extra: true }]) {
    const response = await request("tools/call", { name: "domains_get", arguments: args });
    const result = response.result!;
    assert.equal(result["isError"], true, JSON.stringify(args));
    assert.equal((result["structuredContent"] as { error: { code: string } }).error.code, "invalid_arguments");
  }
  assert.equal(received.length, 0);
});

test("an idempotency key out of range gives the SDK error and no request", async () => {
  received.length = 0;
  const body = { from: "Acme <onboarding@resend.dev>", to: ["delivered@resend.dev"], subject: "Hello World", html: "<p>It works!</p>" };
  for (const key of ["", "k".repeat(257)]) {
    const response = await request("tools/call", { name: "emails_send", arguments: { body, idempotency_key: key } });
    assert.deepEqual(response.result!["structuredContent"], {
      error: { message: "Idempotency key must be between 1 and 256 characters.", code: "invalid_idempotency_key", statusCode: null },
    });
  }
  assert.equal(received.length, 0);
});

test("an unknown tool is a JSON-RPC error", async () => {
  const response = await request("tools/call", { name: "nothing_here", arguments: {} });
  assert.equal(response.error?.code, -32602);
});

test("logging/setLevel is accepted", async () => {
  const response = await request("logging/setLevel", { level: "warning" });
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, {});
});

test("stdout carries only JSON-RPC; debug lines and no key go to stderr", () => {
  for (const line of stdoutLines) assert.equal((JSON.parse(line) as Message).jsonrpc, "2.0");
  assert.match(stderr, /\[paridad-mcp\] tool=emails_send operation=emails\/send result=ok/);
  assert.match(stderr, /\[paridad\] config .*api_key=re_\.\.\.1706/);
  assert.equal(stderr.includes(KEY), false);
  assert.equal(stdoutLines.join("\n").includes(KEY), false);
});

// ------------------------------------------------------------------------ HTTP

async function startHttp(): Promise<{ process: ChildProcessWithoutNullStreams; url: string }> {
  const server = spawn(process.execPath, [MAIN, "--transport", "http", "--port", "0"], {
    env: { ...process.env, RESEND_API_KEY: KEY, RESEND_BASE_URL: baseUrl },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let text = "";
    server.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(text);
      if (match !== null) resolve(match[1]!);
    });
    server.once("exit", (code) => reject(new Error(`the server exited with ${code}: ${text}`)));
  });
  return { process: server, url };
}

// A POST to /mcp; the answer may come as JSON or as an SSE stream.
async function post(url: string, message: unknown, headers: Record<string, string> = {}): Promise<{ status: number; session: string | null; body: Message | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).pop();
  return { status: response.status, session: response.headers.get("mcp-session-id"), body: data === undefined || data === "" ? null : (JSON.parse(data) as Message) };
}

test("Streamable HTTP serves the same tools on /mcp", async () => {
  const { process: server, url } = await startHttp();
  try {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "paridad-test", version: "0" } } };
    const init = await post(url, initialize);
    assert.equal(init.status, 200);
    assert.equal(init.body!.result!["protocolVersion"], PROTOCOL);
    assert.ok(init.session);
    const headers = { "mcp-session-id": init.session!, "mcp-protocol-version": PROTOCOL };
    const initialized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(initialized.status, 202);
    const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    assert.equal((list.body!.result!["tools"] as unknown[]).length, TOOLS.length);
    received.length = 0;
    handler = (_req, res) => json(res, 200, { object: "list", has_more: false, data: [] });
    const call = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "domains_list", arguments: {} } }, headers);
    assert.notEqual(call.body!.result!["isError"], true);
    assert.equal(received[0]!.target, "/domains");
  } finally {
    server.kill();
  }
});

// Status of an initialize POST with the given Host and Origin; node:http, because
// fetch does not let the caller choose the Host header.
function initializeStatus(url: string, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "paridad-test", version: "0" } } });
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("Streamable HTTP rejects a foreign Host or Origin (DNS rebinding)", async () => {
  const { process: server, url } = await startHttp();
  try {
    assert.equal(await initializeStatus(url, { host: "evil.example" }), 403);
    assert.equal(await initializeStatus(url, { origin: "http://evil.example" }), 403);
    assert.equal(await initializeStatus(url, { host: "localhost" }), 200);
    assert.equal(await initializeStatus(url, { origin: "http://localhost:5173" }), 200);
  } finally {
    server.kill();
  }
});
