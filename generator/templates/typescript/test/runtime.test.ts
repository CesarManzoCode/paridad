// Runtime of paridad-resend against an in-process node:http server: authentication,
// User-Agent, error mapping, the retry table of vault/CONTRACT.md §5.3, idempotency,
// pagination and the absence of the API key in errors and debug output.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { ParidadError, Resend } from "../src/index.ts";
import { USER_AGENT } from "../src/runtime.ts";
import { VERSION } from "../src/policy.ts";

const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";
const SEND = { from: "Acme <onboarding@resend.dev>", to: ["delivered@resend.dev"], subject: "Hello World", html: "<p>It works!</p>" };
const MESSAGE = "Idempotency key must be between 1 and 256 characters.";

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

// Answers request n with handlers[n], or the last handler once they run out.
type Handler = (res: ServerResponse, req: Received) => void;

interface Server {
  url: string;
  received: Received[];
}

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(...handlers: Handler[]): Promise<Server> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      const handler = handlers[Math.min(received.length, handlers.length - 1)]!;
      received.push(request);
      handler(res, request);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
const ok = json(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
const list = json(200, { object: "list", has_more: false, data: [] });
const apiError = (status: number, name: string, message: string, headers: Record<string, string> = {}): Handler =>
  json(status, { statusCode: status, name, message }, headers);
// Never answers within the client timeout used below.
const hang: Handler = (res, req) => {
  setTimeout(() => {
    if (!res.destroyed) ok(res, req);
  }, 2000).unref();
};
// Sends the headers and part of the body, then closes the connection.
const cut: Handler = (res) => {
  res.writeHead(200, { "content-type": "application/json", "content-length": "200" });
  res.write('{"object":"li');
  setImmediate(() => res.destroy());
};

function client(server: Server, timeoutMs = 300): Resend {
  return new Resend(KEY, { baseUrl: server.url, timeoutMs });
}

// Runs fn with process.stderr captured; returns what was written.
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const write = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return output;
}

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const assign = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(values);
  try {
    await fn();
  } finally {
    assign(saved);
  }
}

test("every request carries Authorization and User-Agent; Content-Type only with a body", async () => {
  const server = await serve(list, ok);
  const resend = client(server);
  assert.equal((await resend.domains.list()).error, null);
  assert.equal((await resend.emails.send(SEND)).error, null);
  const [get, post] = server.received;
  assert.equal(USER_AGENT, `paridad-ts/${VERSION}`);
  for (const request of [get!, post!]) {
    assert.equal(request.headers["authorization"], `Bearer ${KEY}`);
    assert.equal(request.headers["user-agent"], USER_AGENT);
  }
  assert.equal(get!.method, "GET");
  assert.equal(get!.url, "/domains");
  assert.equal(get!.headers["content-type"], undefined);
  assert.equal(post!.method, "POST");
  assert.equal(post!.url, "/emails");
  assert.equal(post!.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(post!.body.toString()), SEND);
});

test("userAgentSuffix is appended to the User-Agent after a space", async () => {
  const server = await serve(list);
  const resend = new Resend(KEY, { baseUrl: server.url, userAgentSuffix: "cli" });
  assert.equal((await resend.domains.list()).error, null);
  assert.equal(server.received[0]!.headers["user-agent"], `${USER_AGENT} cli`);
});

test("key, base URL and timeout come from RESEND_API_KEY, RESEND_BASE_URL and RESEND_TIMEOUT_MS", async () => {
  const server = await serve(hang, list);
  await withEnv({ RESEND_API_KEY: KEY, RESEND_BASE_URL: `${server.url}/`, RESEND_TIMEOUT_MS: "200" }, async () => {
    const started = Date.now();
    const { error } = await new Resend().domains.list();
    assert.equal(error, null);
    // The first attempt timed out after 200 ms instead of the 30000 ms default.
    assert.ok(Date.now() - started < 1900);
  });
  assert.equal(server.received.length, 2);
  assert.equal(server.received[0]!.url, "/domains");
  assert.equal(server.received[0]!.headers["authorization"], `Bearer ${KEY}`);
});

test("without a key the client does not start", async () => {
  await withEnv({ RESEND_API_KEY: undefined }, async () => {
    assert.throws(() => new Resend(), /Missing API key/);
  });
});

test("a non-2xx response becomes {data: null, error} with code, message and statusCode", async () => {
  const server = await serve(apiError(404, "not_found", "Domain not found"), json(418, { message: "No name" }), json(400, "plain"));
  const resend = client(server);
  const result = await resend.domains.get("49a3999c-0ce1-4ea6-ab68-afcd6dc2e794");
  assert.equal(result.data, null);
  assert.ok(result.error instanceof ParidadError);
  assert.equal(result.error.code, "not_found");
  assert.equal(result.error.message, "Domain not found");
  assert.equal(result.error.statusCode, 404);
  const noName = await resend.domains.list();
  assert.equal(noName.error?.code, "http_418");
  assert.equal(noName.error?.message, "No name");
  assert.equal(noName.error?.statusCode, 418);
  assert.equal((await resend.domains.list()).error?.code, "http_400");
  assert.equal(server.received.length, 3);
});

test("429 rate_limit_exceeded with retry-after waits retry-after seconds and retries", async () => {
  const server = await serve(apiError(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "1" }), list);
  const started = Date.now();
  const { error } = await client(server).domains.list();
  const elapsed = Date.now() - started;
  assert.equal(error, null);
  assert.equal(server.received.length, 2);
  assert.ok(elapsed >= 975, `waited ${elapsed} ms`);
  assert.ok(elapsed < 2000, `waited ${elapsed} ms`);
});

test("429 rate_limit_exceeded is retried even on POST without key, and stops after 3 attempts", async () => {
  const limited = apiError(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "0" });
  const once = await serve(limited, ok);
  assert.equal((await client(once).emails.send(SEND)).error, null);
  assert.equal(once.received.length, 2);
  const always = await serve(limited);
  const { error } = await client(always).domains.list();
  assert.equal(error?.code, "rate_limit_exceeded");
  assert.equal(always.received.length, 3);
});

test("429 with retry-after above 60 seconds is not retried", async () => {
  const server = await serve(apiError(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "61" }), list);
  assert.equal((await client(server).domains.list()).error?.code, "rate_limit_exceeded");
  assert.equal(server.received.length, 1);
});

test("429 daily_quota_exceeded and monthly_quota_exceeded are never retried", async () => {
  for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
    const server = await serve(apiError(429, name, "Quota exceeded", { "retry-after": "1" }), list);
    const { error } = await client(server).domains.list();
    assert.equal(error?.code, name);
    assert.equal(error?.statusCode, 429);
    assert.equal(server.received.length, 1, name);
  }
});

test("503 is retried on GET and on POST with key, not on POST without key", async () => {
  const unavailable = apiError(503, "service_unavailable", "Service unavailable");
  const get = await serve(unavailable, list);
  assert.equal((await client(get).domains.list()).error, null);
  assert.equal(get.received.length, 2);

  const withKey = await serve(unavailable, ok);
  assert.equal((await client(withKey).emails.send(SEND, { idempotencyKey: "welcome-user-123" })).error, null);
  assert.equal(withKey.received.length, 2);
  assertSameKeyAndBody(withKey.received, "welcome-user-123");

  const withoutKey = await serve(unavailable, ok);
  const { error } = await client(withoutKey).emails.send(SEND);
  assert.equal(error?.code, "service_unavailable");
  assert.equal(error?.statusCode, 503);
  assert.equal(withoutKey.received.length, 1);
});

test("500 on every attempt of a GET gives application_error after 3 attempts", async () => {
  const server = await serve(apiError(500, "application_error", "Internal server error"));
  const { error } = await client(server).domains.list();
  assert.equal(error?.code, "application_error");
  assert.equal(server.received.length, 3);
});

test("409 concurrent_idempotent_requests is retried with key; other 4xx are not", async () => {
  const concurrent = await serve(apiError(409, "concurrent_idempotent_requests", "Concurrent request"), ok);
  assert.equal((await client(concurrent).emails.send(SEND, { idempotencyKey: "k-409" })).error, null);
  assert.equal(concurrent.received.length, 2);
  for (const [status, name] of [[400, "validation_error"], [401, "missing_api_key"], [403, "restricted_api_key"], [404, "not_found"], [405, "method_not_allowed"], [409, "invalid_idempotent_request"], [422, "missing_required_field"]] as const) {
    const server = await serve(apiError(status, name, "No"), ok);
    assert.equal((await client(server).emails.send(SEND, { idempotencyKey: "k" })).error?.code, name);
    assert.equal(server.received.length, 1, name);
  }
});

test("a timeout is retried on GET and on POST with key, and returned on POST without key", async () => {
  const get = await serve(hang, list);
  assert.equal((await client(get).domains.list()).error, null);
  assert.equal(get.received.length, 2);

  const withKey = await serve(hang, ok);
  assert.equal((await client(withKey).emails.send(SEND, { idempotencyKey: "timeout-key" })).error, null);
  assert.equal(withKey.received.length, 2);
  assertSameKeyAndBody(withKey.received, "timeout-key");

  const withoutKey = await serve(hang, ok);
  const { error } = await client(withoutKey).emails.send(SEND);
  assert.equal(error?.code, "timeout");
  assert.equal(error?.statusCode, null);
  assert.equal(withoutKey.received.length, 1);
});

test("a response cut in the middle is retried on GET and on POST with key, not on POST without key", async () => {
  const get = await serve(cut, list);
  assert.equal((await client(get).domains.list()).error, null);
  assert.equal(get.received.length, 2);

  const withKey = await serve(cut, ok);
  assert.equal((await client(withKey).emails.send(SEND, { idempotencyKey: "cut-key" })).error, null);
  assert.equal(withKey.received.length, 2);
  assertSameKeyAndBody(withKey.received, "cut-key");

  const withoutKey = await serve(cut, ok);
  const { error } = await client(withoutKey).emails.send(SEND);
  assert.equal(error?.code, "connection_error");
  assert.equal(error?.statusCode, null);
  assert.equal(withoutKey.received.length, 1);
});

test("a refused connection is retried even on POST without key, up to 3 attempts", async () => {
  const server = await serve(ok);
  const url = server.url;
  const closing = servers.pop()!;
  await new Promise((resolve) => closing.close(resolve));
  let result: Awaited<ReturnType<Resend["emails"]["send"]>> | undefined;
  const output = await withDebug(async () => {
    result = await new Resend(KEY, { baseUrl: url, timeoutMs: 300 }).emails.send(SEND);
  });
  assert.equal(result?.error?.code, "connection_error");
  assert.equal(result?.error?.statusCode, null);
  assert.equal(output.split("\n").filter((line) => line.includes("operation=emails/send")).length, 3);
});

test("an invalid Idempotency-Key fails without sending any request", async () => {
  const server = await serve(ok);
  const resend = client(server);
  for (const key of ["", "k".repeat(257)]) {
    const { data, error } = await resend.emails.send(SEND, { idempotencyKey: key });
    assert.equal(data, null);
    assert.equal(error?.code, "invalid_idempotency_key");
    assert.equal(error?.message, MESSAGE);
    assert.equal(error?.statusCode, null);
  }
  assert.equal(server.received.length, 0);
  assert.equal((await resend.emails.send(SEND, { idempotencyKey: "k".repeat(256) })).error, null);
  assert.equal(server.received[0]?.headers["idempotency-key"], "k".repeat(256));
});

test("listAll follows after while has_more is true", async () => {
  const items = ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, email: `${id}@example.com` }));
  const pages: Handler = (res, req) => {
    const query = new URL(req.url, "http://localhost").searchParams;
    const start = query.has("after") ? items.findIndex((item) => item.id === query.get("after")) + 1 : 0;
    const limit = Number(query.get("limit"));
    json(200, { object: "list", has_more: start + limit < items.length, data: items.slice(start, start + limit) })(res, req);
  };
  const server = await serve(pages);
  const seen: string[] = [];
  for await (const contact of client(server).contacts.listAll({ limit: 2 })) seen.push(String(contact.id));
  assert.deepEqual(seen, ["c1", "c2", "c3", "c4", "c5"]);
  assert.deepEqual(
    server.received.map((request) => request.url),
    ["/contacts?limit=2", "/contacts?limit=2&after=c2", "/contacts?limit=2&after=c4"],
  );

  // The first request of page 2 is cut: that page is retried (GET), no item repeats.
  const flaky = await serve(pages, cut, pages);
  const again: string[] = [];
  for await (const contact of client(flaky).contacts.listAll({ limit: 2 })) again.push(String(contact.id));
  assert.deepEqual(again, ["c1", "c2", "c3", "c4", "c5"]);
  assert.equal(flaky.received.length, 4);
});

test("listAll throws the ParidadError of a page that keeps failing", async () => {
  const server = await serve(apiError(404, "not_found", "Gone"));
  await assert.rejects(
    async () => {
      for await (const item of client(server).contacts.listAll()) assert.fail(`unexpected item ${JSON.stringify(item)}`);
    },
    (error: unknown) => error instanceof ParidadError && error.code === "not_found",
  );
});

test("the API key never appears in error messages or debug output; debug shows it masked", async () => {
  const server = await serve(apiError(401, "missing_api_key", "Missing API key"), hang, cut, apiError(503, "service_unavailable", "Down"));
  const messages: string[] = [];
  const output = await withDebug(async () => {
    const resend = client(server);
    for (let i = 0; i < 4; i++) {
      const { error } = await resend.emails.send(SEND);
      messages.push(`${error?.code} ${error?.message} ${String(error?.stack)}`);
    }
    messages.push((await resend.emails.send(SEND, { idempotencyKey: "" })).error?.message ?? "");
  });
  assert.equal(messages.length, 5);
  for (const message of messages) assert.ok(!message.includes(KEY), message);
  assert.ok(!output.includes(KEY));
  assert.ok(!output.includes(KEY.slice(3, -4)));
  assert.match(output, /config .*api_key=re_\.\.\.1706/);
  assert.match(output, /operation=emails\/send method=POST path=\/emails attempt=1 result=401 wait_ms=none/);
  assert.match(output, /attempt=1 result=timeout wait_ms=none/);
  assert.match(output, /attempt=1 result=connection_error wait_ms=none/);
});

test("debug output lists every attempt with the wait before the next one", async () => {
  const server = await serve(apiError(503, "service_unavailable", "Down"), list);
  const output = await withDebug(async () => {
    assert.equal((await client(server).domains.list()).error, null);
  });
  const lines = output.split("\n").filter((line) => line.includes("operation=domains/list"));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /attempt=1 result=503 wait_ms=\d+$/);
  assert.match(lines[1]!, /attempt=2 result=200 wait_ms=none$/);
});

function withDebug(fn: () => Promise<void>): Promise<string> {
  let output = "";
  return withEnv({ PARIDAD_DEBUG: "1" }, async () => {
    output = await captureStderr(fn);
  }).then(() => output);
}

function assertSameKeyAndBody(received: Received[], key: string): void {
  for (const request of received) {
    assert.equal(request.headers["idempotency-key"], key);
    assert.deepEqual(request.body, received[0]!.body);
  }
}
