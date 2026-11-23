import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { createValidator, type IR, type IROperation } from "../../generator/src/ir.ts";
import { startCaptureServer, type Capture, type CaptureServer } from "./server.ts";

const ROOT = join(import.meta.dirname, "../..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const validate = createValidator(ir.schemas, ir.operations);
const dir = mkdtempSync(join(tmpdir(), "paridad-capture-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
async function withServer(run: (server: CaptureServer, out: string) => Promise<void>): Promise<void> {
  const out = join(dir, `captures-${++files}.jsonl`);
  const server = await startCaptureServer({ port: 0, controlPort: 0, out, ir });
  try {
    await run(server, out);
  } finally {
    await server.close();
  }
}

function captures(out: string): Capture[] {
  return readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Capture);
}

async function setSession(server: CaptureServer, session: Record<string, unknown>): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session),
  });
  assert.equal(response.status, 200);
}

function operation(id: string): IROperation {
  const op = ir.operations.find((candidate) => candidate.id === id);
  assert.ok(op, id);
  return op;
}

// A request with headers given as a raw list, so names and order are exactly the sent ones.
function rawRequest(port: number, method: string, path: string, headers: string[], body: Buffer): Promise<number> {
  return new Promise((done, fail) => {
    const sent = request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      response.resume();
      response.on("end", () => done(response.statusCode ?? 0));
    });
    sent.on("error", fail);
    sent.end(body);
  });
}

test("records headers in the received order and case, and the body in base64", async () => {
  await withServer(async (server, out) => {
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff]);
    const headers = [
      "X-Zeta",
      "1",
      "authorization",
      "Bearer re_paridad_test_9f8e7d6c5b4a39281706",
      "Content-Type",
      "application/json; charset=utf-8",
      "Content-Length",
      String(body.length),
      "X-Alpha",
      " spaced ",
    ];
    const status = await rawRequest(server.port, "POST", "/emails?x=%20y", headers, body);
    assert.equal(status, 200);
    const [capture] = captures(out);
    assert.ok(capture);
    assert.equal(capture.method, "POST");
    assert.equal(capture.target, "/emails?x=%20y");
    assert.equal(capture.seq, 1);
    assert.equal(capture.case, null);
    assert.equal(capture.surface, null);
    const sentNames = new Set(headers.filter((_, index) => index % 2 === 0));
    const expected: [string, string][] = [];
    for (let index = 0; index < headers.length; index += 2) expected.push([headers[index]!, headers[index + 1]!.trim()]);
    assert.deepEqual(
      capture.headers.filter(([name]) => sentNames.has(name)),
      // Node trims leading and trailing whitespace of header values on parsing.
      expected,
    );
    assert.deepEqual(Buffer.from(capture.body_b64, "base64"), body);
  });
});

test("attributes requests to the current session with an increasing seq", async () => {
  await withServer(async (server, out) => {
    await fetch(`http://127.0.0.1:${server.port}/domains`);
    await setSession(server, { run: "c5", case: "domains/list#example", surface: "ts" });
    await fetch(`http://127.0.0.1:${server.port}/domains`);
    await fetch(`http://127.0.0.1:${server.port}/domains`);
    await setSession(server, { run: "c5", case: "domains/list#example", surface: "python" });
    await fetch(`http://127.0.0.1:${server.port}/domains`);
    assert.deepEqual(
      captures(out).map(({ case: id, surface, seq }) => [id, surface, seq]),
      [
        [null, null, 1],
        ["domains/list#example", "ts", 2],
        ["domains/list#example", "ts", 3],
        ["domains/list#example", "python", 4],
      ],
    );
  });
});

test("rejects an invalid session and answers the health check", async () => {
  await withServer(async (server) => {
    const health = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/health`);
    assert.equal(health.status, 200);
    const bad = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
      method: "POST",
      body: JSON.stringify({ run: "c5", case: "x" }),
    });
    assert.equal(bad.status, 400);
  });
});

test("answers every operation with its success status and a body valid against the spec", async () => {
  await withServer(async (server) => {
    for (const op of ir.operations) {
      const example = op.examples[0]!;
      const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(example.path[name])));
      const query = new URLSearchParams(Object.entries(example.query).map(([key, value]) => [key, String(value)]));
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(example.headers)) headers[key] = String(value);
      if (example.body !== null) headers["content-type"] = "application/json";
      const search = query.size > 0 ? `?${query}` : "";
      const response = await fetch(`http://127.0.0.1:${server.port}${path}${search}`, {
        method: op.method,
        headers,
        ...(example.body === null ? {} : { body: JSON.stringify(example.body) }),
      });
      assert.equal(response.status, op.response.status, op.id);
      const text = await response.text();
      if (op.response.schema === null) continue;
      assert.equal(response.headers.get("content-type"), "application/json", op.id);
      assert.equal(validate(op.response.schema, JSON.parse(text)), null, op.id);
    }
  });
});

test("prefers literal segments when matching a route", async () => {
  await withServer(async (server) => {
    // GET /emails/receiving (literal) must win over GET /emails/{email_id}.
    const response = await fetch(`http://127.0.0.1:${server.port}/emails/receiving`);
    const op = operation("emails/list-receiving");
    assert.equal(response.status, op.response.status);
    assert.equal(validate(op.response.schema!, await response.json()), null);
  });
});

test("paginates list_items: 5 with limit 2 in three pages", async () => {
  await withServer(async (server) => {
    const op = operation("contacts/list");
    await setSession(server, { run: "c11", case: "paginate", surface: "ts", list_items: 5 });
    const pages: { data: { id: string }[]; has_more: boolean }[] = [];
    let cursor: string | null = null;
    do {
      const search: string = cursor === null ? "?limit=2" : `?limit=2&after=${encodeURIComponent(cursor)}`;
      const response = await fetch(`http://127.0.0.1:${server.port}/contacts${search}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: { id: string }[]; has_more: boolean };
      assert.equal(validate(op.response.schema!, body), null);
      pages.push(body);
      cursor = body.has_more ? body.data.at(-1)!.id : null;
    } while (cursor !== null && pages.length < 10);
    assert.deepEqual(
      pages.map((page) => [page.data.length, page.has_more]),
      [
        [2, true],
        [2, true],
        [1, false],
      ],
    );
    const ids = pages.flatMap((page) => page.data.map((item) => item.id));
    assert.equal(new Set(ids).size, 5);
  });
});

test("the command line starts the server and prints the bound ports", async () => {
  const out = join(dir, "cli.jsonl");
  const child = spawn(process.execPath, [join(import.meta.dirname, "server.ts"), "--port", "0", "--control-port", "0", "--out", out], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const [first] = (await once(createInterface({ input: child.stdout! }), "line")) as [string];
    const match = /port=(\d+) control-port=(\d+)/.exec(first);
    assert.ok(match, first);
    const health = await fetch(`http://127.0.0.1:${match[2]}/__paridad/health`);
    assert.equal(health.status, 200);
    await fetch(`http://127.0.0.1:${match[1]}/domains`);
    assert.equal(captures(out).length, 1);
  } finally {
    child.kill();
  }
});
