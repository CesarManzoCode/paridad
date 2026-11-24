// node harness/faults/proxy.ts --port <p> --control-port <c> --upstream <url> --scenarios <file.json> --out <traces.jsonl>
// Fault proxy (contract §7): sits between a surface and the capture server, counts
// attempts per (case, surface) and applies the scenario action for each attempt
// (pass, respond, delay, cut). Every attempt is recorded in traces.jsonl (§8) with
// times from the proxy's monotonic clock. The control port takes POST /__paridad/session
// like the capture server, and GET /__paridad/health. Port 0 picks a free port; the
// bound ports are printed on stdout. The scenario format is in verify/scenarios/README.md.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const HOST = "127.0.0.1";
// Not forwarded back to the client: the proxy buffers the upstream body and sets its own length.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

export type Action =
  | { action: "pass" }
  | { action: "respond"; status: number; headers?: Record<string, string>; body: { statusCode: number; name: string; message: string } }
  | { action: "delay"; delay_ms: number }
  | { action: "cut" };

// Per case id, the action of attempt n at index n - 1; attempts past the list pass.
export interface Scenarios {
  cases: Record<string, Action[]>;
}

export interface Trace {
  case: string | null;
  surface: string | null;
  attempt: number;
  t_recv_ns: string;
  t_resp_end_ns: string;
  method: string;
  target: string;
  headers: [string, string][];
  body_sha256: string;
  action: Action["action"];
  status: number;
  response_headers: [string, string][];
}

export interface ProxyOptions {
  port: number;
  // Address of the proxied port; 127.0.0.1 by default. The control port stays on 127.0.0.1.
  host?: string;
  controlPort: number;
  upstream: string;
  scenarios: Scenarios;
  out: string;
}

export interface FaultProxy {
  port: number;
  controlPort: number;
  close(): Promise<void>;
}

interface Upstream {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

// The 429 of the rate limit (F-RATE): the limit is a parameter because the official pages
// disagree on its default value.
export function rateLimitResponse(options: { limit: number; retryAfter?: number; message?: string }): Action {
  const retryAfter = options.retryAfter ?? 1;
  return {
    action: "respond",
    status: 429,
    headers: {
      "ratelimit-limit": String(options.limit),
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(retryAfter),
      "retry-after": String(retryAfter),
    },
    body: { statusCode: 429, name: "rate_limit_exceeded", message: options.message ?? "Too many requests." },
  };
}

export async function startFaultProxy(options: ProxyOptions): Promise<FaultProxy> {
  const upstream = new URL(options.upstream);
  const { scenarios, out } = options;
  validateScenarios(scenarios);
  const attempts = new Map<string, number>();
  let session: { case: string; surface: string } | null = null;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");

  const handle = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(incoming);
    const t_recv_ns = process.hrtime.bigint();
    const current = session;
    const key = JSON.stringify([current?.case ?? null, current?.surface ?? null]);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const action: Action = (current === null ? undefined : scenarios.cases[current.case]?.[attempt - 1]) ?? { action: "pass" };
    const method = incoming.method ?? "";
    const target = incoming.url ?? "";
    const headers = pairs(incoming.rawHeaders);

    let status: number;
    let responseHeaders: [string, string][];
    let t_resp_end_ns: bigint;
    if (action.action === "respond") {
      const text = Buffer.from(JSON.stringify(action.body));
      status = action.status;
      responseHeaders = [["content-type", "application/json"], ...Object.entries(action.headers ?? {}), ["content-length", String(text.length)]];
      t_resp_end_ns = await write(response, status, responseHeaders, text);
    } else {
      const reply = await forward(upstream, method, target, headers, body);
      status = reply.status;
      responseHeaders = [...reply.headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())), ["content-length", String(reply.body.length)]];
      if (action.action === "delay") await sleep(action.delay_ms);
      if (action.action === "cut") {
        // The advertised length is never reached, so the client sees an incomplete response.
        responseHeaders[responseHeaders.length - 1] = ["content-length", String(Math.max(reply.body.length, 1))];
        t_resp_end_ns = await cut(response, status, responseHeaders, reply.body.subarray(0, Math.floor(reply.body.length / 2)));
      } else {
        t_resp_end_ns = await write(response, status, responseHeaders, reply.body);
      }
    }

    const trace: Trace = {
      case: current?.case ?? null,
      surface: current?.surface ?? null,
      attempt,
      t_recv_ns: String(t_recv_ns),
      t_resp_end_ns: String(t_resp_end_ns),
      method,
      target,
      headers,
      body_sha256: createHash("sha256").update(body).digest("hex"),
      action: action.action,
      status,
      response_headers: responseHeaders,
    };
    appendFileSync(out, `${JSON.stringify(trace)}\n`);
  };

  const control = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(incoming);
    if (incoming.method === "GET" && incoming.url === "/__paridad/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (incoming.method === "POST" && incoming.url === "/__paridad/session") {
      const next = parseSession(body);
      if (typeof next === "string") {
        sendJson(response, 400, { error: next });
        return;
      }
      session = { case: next.case, surface: next.surface };
      // A new session starts counting again, so a case can be rerun on the same proxy.
      attempts.delete(JSON.stringify([next.case, next.surface]));
      sendJson(response, 200, next);
      return;
    }
    sendJson(response, 404, { error: `unknown control request ${incoming.method} ${incoming.url}` });
  };

  const api = await listen(handle, options.port, options.host ?? HOST);
  const controlServer = await listen(control, options.controlPort, HOST);
  return {
    port: (api.address() as AddressInfo).port,
    controlPort: (controlServer.address() as AddressInfo).port,
    close: async () => {
      await Promise.all(
        [api, controlServer].map(
          (server) =>
            new Promise((done) => {
              server.close(done);
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}

function forward(upstream: URL, method: string, target: string, headers: [string, string][], body: Buffer): Promise<Upstream> {
  return new Promise((done) => {
    const sent = request(
      { host: upstream.hostname, port: upstream.port, method, path: target, headers: headers.flat() },
      (reply) => {
        readBody(reply).then(
          (replyBody) => done({ status: reply.statusCode ?? 502, headers: pairs(reply.rawHeaders), body: replyBody }),
          () => done(badGateway("upstream response failed")),
        );
      },
    );
    sent.on("error", (error) => done(badGateway(error.message)));
    sent.end(body);
  });
}

function badGateway(message: string): Upstream {
  return {
    status: 502,
    headers: [["content-type", "application/json"]],
    body: Buffer.from(JSON.stringify({ statusCode: 502, name: "bad_gateway", message: `Fault proxy: ${message}` })),
  };
}

// Resolves with the monotonic time at which the response was written, or at which the
// client was found gone.
function write(response: ServerResponse, status: number, headers: [string, string][], body: Buffer): Promise<bigint> {
  return new Promise((done) => {
    if (response.destroyed) {
      done(process.hrtime.bigint());
      return;
    }
    const end = (): void => done(process.hrtime.bigint());
    response.once("close", end);
    response.writeHead(status, headers.flat());
    response.end(body, () => {
      response.off("close", end);
      end();
    });
  });
}

function cut(response: ServerResponse, status: number, headers: [string, string][], part: Buffer): Promise<bigint> {
  return new Promise((done) => {
    const destroy = (): void => {
      response.socket?.destroy();
      response.destroy();
      done(process.hrtime.bigint());
    };
    if (response.destroyed) {
      done(process.hrtime.bigint());
      return;
    }
    response.writeHead(status, headers.flat());
    // flushHeaders sends the head even when the partial body is empty.
    response.flushHeaders();
    if (part.length === 0) destroy();
    else response.write(part, destroy);
  });
}

function validateScenarios(scenarios: Scenarios): void {
  if (typeof scenarios !== "object" || scenarios === null || typeof scenarios.cases !== "object" || scenarios.cases === null) {
    throw new Error("scenarios must be an object with a cases object");
  }
  for (const [id, actions] of Object.entries(scenarios.cases)) {
    if (!Array.isArray(actions)) throw new Error(`scenario ${id} must be a list of actions`);
    actions.forEach((step, index) => {
      const where = `scenario ${id} attempt ${index + 1}`;
      switch (step?.action) {
        case "pass":
        case "cut":
          return;
        case "delay":
          if (!Number.isInteger(step.delay_ms) || step.delay_ms < 0) throw new Error(`${where}: delay_ms must be a non-negative integer`);
          return;
        case "respond": {
          if (!Number.isInteger(step.status) || step.status < 100 || step.status > 599) throw new Error(`${where}: status must be an HTTP status`);
          const { body } = step;
          if (typeof body !== "object" || body === null || typeof body.statusCode !== "number" || typeof body.name !== "string" || typeof body.message !== "string") {
            throw new Error(`${where}: body must be {"statusCode","name","message"}`);
          }
          if (step.headers !== undefined && Object.values(step.headers).some((value) => typeof value !== "string")) {
            throw new Error(`${where}: header values must be strings`);
          }
          return;
        }
        default:
          throw new Error(`${where}: unknown action`);
      }
    });
  }
}

function parseSession(body: Buffer): { run: string; case: string; surface: string } | string {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return "the session body is not JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the session body is not an object";
  const fields = value as Record<string, unknown>;
  for (const key of ["run", "case", "surface"]) {
    if (typeof fields[key] !== "string" || fields[key] === "") return `session.${key} must be a non-empty string`;
  }
  return { run: fields["run"] as string, case: fields["case"] as string, surface: fields["surface"] as string };
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) out.push([raw[index]!, raw[index + 1]!]);
  return out;
}

async function readBody(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, port: number, host: string): Promise<Server> {
  const server = createServer((incoming, response) => {
    handler(incoming, response).catch((error: unknown) => {
      process.stderr.write(`faults: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!response.headersSent) sendJson(response, 500, { statusCode: 500, name: "application_error", message: "Fault proxy error." });
      else response.destroy();
    });
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      done(server);
    });
  });
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (value === undefined || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--${name} must be a port number`);
  return port;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      "control-port": { type: "string" },
      upstream: { type: "string" },
      scenarios: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  if (values.upstream === undefined) throw new Error("--upstream is required");
  if (values.scenarios === undefined) throw new Error("--scenarios is required");
  if (values.out === undefined) throw new Error("--out is required");
  const proxy = await startFaultProxy({
    port: parsePort(values.port, "port"),
    controlPort: parsePort(values["control-port"], "control-port"),
    upstream: values.upstream,
    scenarios: JSON.parse(readFileSync(resolve(values.scenarios), "utf8")) as Scenarios,
    out: resolve(values.out),
  });
  process.stdout.write(`faults: listening port=${proxy.port} control-port=${proxy.controlPort}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`faults: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
