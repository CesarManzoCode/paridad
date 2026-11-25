// The output contract of the CLI (vault/CONTRACT.md §5, §6, D27), with the binary
// launched as a process against an in-process server and stdout written to a file:
// JSON and exit 0 on success, the error object and exit 1 on error, the masked key
// of `config show`, the same idempotency error as the SDK, the HTML of `render` for
// --react, and `contract-check` run through compat/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { render } from "@react-email/render";
import { Resend } from "paridad-resend";
import { createElement } from "react";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const FIXTURE = join(import.meta.dirname, "fixtures/welcome.tsx");
const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";
const SEND = { from: "Acme <onboarding@resend.dev>", to: ["delivered@resend.dev"], subject: "Hello World" };

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const received: { method: string; path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let handler: Handler = (_req, res) => json(res, 200, { object: "list", has_more: false, data: [] });
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    received.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0]!, headers: req.headers, body });
    handler(req, res, body);
  });
});
let baseUrl: string;
const dir = mkdtempSync(join(tmpdir(), "paridad-cli-"));

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let runs = 0;

// Runs the binary with stdout to a file and the test key and server in its environment.
async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  received.length = 0;
  const file = join(dir, `stdout-${runs++}`);
  const fd = openSync(file, "w");
  const child = spawn(process.execPath, [MAIN, ...argv], {
    env: { ...process.env, RESEND_API_KEY: KEY, RESEND_BASE_URL: baseUrl, ...env },
    stdio: ["ignore", fd, "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  closeSync(fd);
  return { code, stdout: readFileSync(file, "utf8"), stderr };
}

test("success: the response body as JSON on stdout and exit 0", async () => {
  const page = { object: "list", has_more: false, data: [{ id: "d1", name: "example.com" }] };
  handler = (_req, res) => json(res, 200, page);
  const { code, stdout } = await cli(["domains", "list", "--limit", "10"]);
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout), page);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.method, "GET");
  assert.equal(received[0]!.path, "/domains");
  assert.equal(received[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.match(received[0]!.headers["user-agent"] ?? "", /^paridad-ts\/\S+ cli$/);
});

test("error 404: {error:{message,code,statusCode}} on stdout and exit 1", async () => {
  handler = (_req, res) => json(res, 404, { statusCode: 404, name: "not_found", message: "Domain not found" });
  const { code, stdout } = await cli(["domains", "list"]);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(stdout), { error: { message: "Domain not found", code: "not_found", statusCode: 404 } });
  // 404 is never retried.
  assert.equal(received.length, 1);
});

test("an unknown command is a JSON error with exit 1", async () => {
  const { code, stdout } = await cli(["domains", "explode"]);
  assert.equal(code, 1);
  assert.equal(typeof JSON.parse(stdout).error.message, "string");
  assert.equal(received.length, 0);
});

test("config show masks the key as re_... and its last 4 characters", async () => {
  const { code, stdout, stderr } = await cli(["config", "show"], { PARIDAD_DEBUG: "1" });
  assert.equal(code, 0);
  const config = JSON.parse(stdout);
  assert.equal(config.api_key, `re_...${KEY.slice(-4)}`);
  assert.equal(config.base_url, baseUrl);
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY));
});

test("debug mode writes each attempt to stderr with the key masked", async () => {
  handler = (_req, res) => json(res, 200, { object: "list", has_more: false, data: [] });
  const { code, stdout, stderr } = await cli(["domains", "list"], { PARIDAD_DEBUG: "1" });
  assert.equal(code, 0);
  assert.match(stderr, /api_key=re_\.\.\.1706/);
  assert.match(stderr, /operation=domains\/list method=GET path=\/domains attempt=1 result=200/);
  assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY));
});

for (const [label, key] of [
  ["empty", ""],
  ["257 characters", "k".repeat(257)],
] as const) {
  test(`an invalid idempotency key (${label}) gives the error of the SDK and sends nothing`, async () => {
    const sdk = await new Resend(KEY, { baseUrl }).emails.send(SEND, { idempotencyKey: key });
    assert.notEqual(sdk.error, null);
    const { code, stdout } = await cli(["emails", "send", "--body", JSON.stringify(SEND), "--idempotency-key", key]);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout), { error: { message: sdk.error!.message, code: sdk.error!.code, statusCode: sdk.error!.statusCode } });
    assert.equal(received.length, 0);
  });
}

test("--react sends as html exactly what render produces for the template and props", async () => {
  handler = (_req, res) => json(res, 200, { id: "e1" });
  const { code, stdout } = await cli(["emails", "send", "--body", JSON.stringify(SEND), "--react", FIXTURE, "--react-props", '{"name":"Ana"}']);
  assert.equal(code, 0, stdout);
  assert.deepEqual(JSON.parse(stdout), { id: "e1" });
  // The same tree the JSX of fixtures/welcome.tsx builds.
  const expected = await render(createElement("html", { lang: "en" }, createElement("body", null, createElement("p", null, "Hello ", "Ana"))));
  assert.equal(received.length, 1);
  assert.deepEqual(JSON.parse(received[0]!.body), { ...SEND, html: expected });
});

const SPEC = join(import.meta.dirname, "../../spec/resend.yaml");

test("contract-check delegates to compat/: JSON output, exit 0 for the pinned spec against itself", async () => {
  const { code, stdout } = await cli(["contract-check", SPEC, SPEC]);
  assert.equal(code, 0, stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.classification, "compatible");
  assert.equal(result.bump, "patch");
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.changes, []);
});

test("contract-check exits 2 with the error object when a file does not load", async () => {
  const { code, stdout } = await cli(["contract-check", SPEC, join(dir, "missing.yaml")]);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).error.code, "invalid_spec");
});
