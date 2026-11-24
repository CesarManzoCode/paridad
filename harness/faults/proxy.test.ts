import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { rateLimitResponse, startFaultProxy, type FaultProxy, type Scenarios, type Trace } from "./proxy.ts";

const dir = mkdtempSync(join(tmpdir(), "paridad-faults-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const UPSTREAM_BODY = JSON.stringify({ object: "list", has_more: false, data: [{ id: "d1", name: "example.com" }] });

interface Received {
  method: string;
  target: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  complete: boolean;
  error: string | null;
}

let files = 0;
async function withProxy(scenarios: Scenarios, run: (proxy: FaultProxy, received: Received[], out: string) => Promise<void>): Promise<void> {
  const received: Received[] = [];
  const upstream: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      received.push({ method: incoming.method ?? "", target: incoming.url ?? "", headers: incoming.headers, body: Buffer.concat(chunks) });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(UPSTREAM_BODY) }).end(UPSTREAM_BODY);
    });
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const out = join(dir, `traces-${++files}.jsonl`);
  const proxy = await startFaultProxy({
    port: 0,
    controlPort: 0,
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    scenarios,
    out,
  });
  try {
    await run(proxy, received, out);
  } finally {
    await proxy.close();
    await new Promise((done) => {
      upstream.close(done);
      upstream.closeAllConnections();
    });
  }
}

function traces(out: string): Trace[] {
  return readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Trace);
}

async function setSession(proxy: FaultProxy, id: string, surface: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${proxy.controlPort}/__paridad/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: "test", case: id, surface }),
  });
  assert.equal(response.status, 200);
}

// A raw node:http client without connection reuse, so a cut affects only its own request.
function send(port: number, method: string, path: string, body: string | null = null, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done) => {
    const sent = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let error: string | null = null;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (failure) => {
        error = failure.message;
      });
      response.on("close", () =>
        done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete, error }),
      );
    });
    sent.on("error", (failure) => done({ status: 0, headers: {}, body: Buffer.alloc(0), complete: false, error: failure.message }));
    sent.end(body ?? undefined);
  });
}

test("pass forwards the request unchanged and returns the upstream response", async () => {
  await withProxy({ cases: {} }, async (proxy, received, out) => {
    await setSession(proxy, "emails/send#example", "ts");
    const body = JSON.stringify({ from: "a@example.com", to: ["b@example.com"], subject: "hi", html: "<p>hi</p>" });
    const reply = await send(proxy.port, "POST", "/emails?x=%20y", body, { "content-type": "application/json", "idempotency-key": "key-1" });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), UPSTREAM_BODY);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.method, "POST");
    assert.equal(received[0]!.target, "/emails?x=%20y");
    assert.equal(received[0]!.headers["idempotency-key"], "key-1");
    assert.equal(received[0]!.body.toString(), body);
    const [trace] = traces(out);
    assert.ok(trace);
    assert.equal(trace.case, "emails/send#example");
    assert.equal(trace.surface, "ts");
    assert.equal(trace.attempt, 1);
    assert.equal(trace.action, "pass");
    assert.equal(trace.status, 200);
    assert.equal(trace.method, "POST");
    assert.equal(trace.target, "/emails?x=%20y");
    assert.equal(trace.body_sha256, createHash("sha256").update(body).digest("hex"));
    assert.ok(trace.headers.some(([name, value]) => name.toLowerCase() === "idempotency-key" && value === "key-1"));
  });
});

test("respond answers with the Resend error body without forwarding", async () => {
  const error = { statusCode: 404, name: "not_found", message: "The requested endpoint does not exist." };
  await withProxy({ cases: { "error-404-not_found": [{ action: "respond", status: 404, body: error }] } }, async (proxy, received, out) => {
    await setSession(proxy, "error-404-not_found", "go");
    const reply = await send(proxy.port, "GET", "/domains");
    assert.equal(reply.status, 404);
    assert.equal(reply.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(reply.body.toString()), error);
    assert.equal(received.length, 0);
    const [trace] = traces(out);
    assert.equal(trace?.action, "respond");
    assert.equal(trace?.status, 404);
  });
});

test("delay forwards and holds the response for delay_ms", async () => {
  await withProxy({ cases: { "timeout-get": [{ action: "delay", delay_ms: 300 }] } }, async (proxy, received, out) => {
    await setSession(proxy, "timeout-get", "python");
    const started = process.hrtime.bigint();
    const reply = await send(proxy.port, "GET", "/domains");
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), UPSTREAM_BODY);
    assert.ok(elapsedMs >= 300, `elapsed ${elapsedMs} ms`);
    assert.equal(received.length, 1);
    const [trace] = traces(out);
    assert.equal(trace?.action, "delay");
    assert.ok(Number(BigInt(trace!.t_resp_end_ns) - BigInt(trace!.t_recv_ns)) / 1e6 >= 300);
  });
});

test("cut sends the headers and part of the body, then drops the connection", async () => {
  await withProxy({ cases: { "cut-get": [{ action: "cut" }] } }, async (proxy, received, out) => {
    await setSession(proxy, "cut-get", "cli");
    const reply = await send(proxy.port, "GET", "/domains");
    assert.equal(reply.status, 200);
    assert.equal(reply.complete, false);
    const advertised = Number(reply.headers["content-length"]);
    assert.equal(advertised, Buffer.byteLength(UPSTREAM_BODY));
    assert.ok(reply.body.length < advertised, `got ${reply.body.length} of ${advertised} bytes`);
    assert.equal(received.length, 1, "the cut request reaches the upstream");
    const [trace] = traces(out);
    assert.equal(trace?.action, "cut");
    assert.equal(trace?.status, 200);
  });
});

test("counts attempts per (case, surface) and restarts on a new session", async () => {
  const unavailable = { statusCode: 503, name: "service_unavailable", message: "Service unavailable." };
  const scenarios: Scenarios = { cases: { "5xx-intermittent-get": [{ action: "respond", status: 503, body: unavailable }, { action: "pass" }] } };
  await withProxy(scenarios, async (proxy, _received, out) => {
    await setSession(proxy, "5xx-intermittent-get", "ts");
    const ts = [await send(proxy.port, "GET", "/domains"), await send(proxy.port, "GET", "/domains"), await send(proxy.port, "GET", "/domains")];
    await setSession(proxy, "5xx-intermittent-get", "mcp");
    const mcp = await send(proxy.port, "GET", "/domains");
    await setSession(proxy, "5xx-intermittent-get", "ts");
    const rerun = await send(proxy.port, "GET", "/domains");
    await setSession(proxy, "no-scenario", "ts");
    const other = await send(proxy.port, "GET", "/domains");
    assert.deepEqual(
      [...ts, mcp, rerun, other].map((reply) => reply.status),
      [503, 200, 200, 503, 503, 200],
    );
    assert.deepEqual(
      traces(out).map(({ surface, attempt, action }) => [surface, attempt, action]),
      [
        ["ts", 1, "respond"],
        ["ts", 2, "pass"],
        ["ts", 3, "pass"],
        ["mcp", 1, "respond"],
        ["ts", 1, "respond"],
        ["ts", 1, "pass"],
      ],
    );
  });
});

test("trace times are monotonic and increasing", async () => {
  await withProxy({ cases: { seq: [{ action: "pass" }, { action: "delay", delay_ms: 20 }, { action: "cut" }, { action: "pass" }] } }, async (proxy, _received, out) => {
    await setSession(proxy, "seq", "go");
    for (let index = 0; index < 4; index++) await send(proxy.port, "GET", "/domains");
    const list = traces(out);
    assert.equal(list.length, 4);
    let previousEnd = 0n;
    for (const trace of list) {
      const received = BigInt(trace.t_recv_ns);
      const ended = BigInt(trace.t_resp_end_ns);
      assert.ok(received > previousEnd, "each attempt is received after the previous response ended");
      assert.ok(ended >= received, "a response ends after its request was received");
      previousEnd = ended;
    }
  });
});

test("the rate limit 429 carries the four limit headers", async () => {
  await withProxy({ cases: { "ratelimit-get": [rateLimitResponse({ limit: 2 })] } }, async (proxy, received, out) => {
    await setSession(proxy, "ratelimit-get", "ts");
    const reply = await send(proxy.port, "GET", "/domains");
    assert.equal(reply.status, 429);
    assert.equal(reply.headers["ratelimit-limit"], "2");
    assert.equal(reply.headers["ratelimit-remaining"], "0");
    assert.equal(reply.headers["ratelimit-reset"], "1");
    assert.equal(reply.headers["retry-after"], "1");
    const body = JSON.parse(reply.body.toString()) as { statusCode: number; name: string };
    assert.equal(body.statusCode, 429);
    assert.equal(body.name, "rate_limit_exceeded");
    assert.equal(received.length, 0);
    const [trace] = traces(out);
    const headers = new Map(trace!.response_headers);
    assert.equal(headers.get("retry-after"), "1");
    assert.equal(headers.get("ratelimit-limit"), "2");
  });
});

test("rejects an invalid scenario file", async () => {
  await assert.rejects(
    startFaultProxy({
      port: 0,
      controlPort: 0,
      upstream: "http://127.0.0.1:1",
      scenarios: { cases: { bad: [{ action: "delay", delay_ms: -1 }] } },
      out: join(dir, "invalid.jsonl"),
    }),
    /delay_ms/,
  );
});
