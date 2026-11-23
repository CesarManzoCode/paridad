// node harness/capture/server.ts --port <p> --control-port <c> --out <captures.jsonl> [--ir ir/ir.json]
// Capture server (contract §7): records every request it receives in captures.jsonl
// (§8) and answers with the success response of the matched operation. The control
// port takes POST /__paridad/session to attribute the following requests, and
// GET /__paridad/health. Port 0 picks a free port; the bound ports are printed on stdout.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSynthesizer, createValidator, type IR, type IROperation } from "../../generator/src/ir.ts";
import { SCHEMAS_REF, isObject, type JsonObject, type JsonSchema } from "../../generator/src/spec.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const HOST = "127.0.0.1";
// Page size when a paginated request has no valid limit; the spec declares no default.
const DEFAULT_LIMIT = 20;

export interface Session {
  run: string;
  case: string;
  surface: string;
  listItems: number | null;
}

export interface Capture {
  case: string | null;
  surface: string | null;
  seq: number;
  method: string;
  target: string;
  headers: [string, string][];
  body_b64: string;
}

export interface CaptureOptions {
  port: number;
  controlPort: number;
  out: string;
  ir: IR;
}

export interface CaptureServer {
  port: number;
  controlPort: number;
  close(): Promise<void>;
}

interface Route {
  op: IROperation;
  // A literal segment, or null for a path parameter.
  segments: (string | null)[];
}

export async function startCaptureServer(options: CaptureOptions): Promise<CaptureServer> {
  const { ir, out } = options;
  const synthesize = createSynthesizer(ir.schemas, createValidator(ir.schemas, ir.operations));
  const routes: Route[] = ir.operations.map((op) => ({
    op,
    segments: op.path.split("/").map((segment) => (segment.includes("{") ? null : segment)),
  }));
  const bodies = new Map<string, unknown>();
  let session: Session | null = null;
  let seq = 0;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");

  const successBody = (op: IROperation, query: URLSearchParams): unknown => {
    if (op.response.schema === null) return undefined;
    if (!bodies.has(op.id)) bodies.set(op.id, synthesize(op.response.schema));
    const body = bodies.get(op.id);
    if (op.pagination === null || session?.listItems == null || !isObject(body)) return body;
    return page(op, body, session.listItems, query);
  };

  // A deterministic set of n items, served by limit and after with has_more.
  const page = (op: IROperation, body: JsonObject, count: number, query: URLSearchParams): JsonObject => {
    const pagination = op.pagination!;
    const list = deref(ir, op.response.schema!);
    const listProperties = isObject(list) && isObject(list["properties"]) ? list["properties"] : {};
    const data = deref(ir, (listProperties[pagination.items] as JsonSchema | undefined) ?? true);
    const itemSchema = (isObject(data) ? (data["items"] as JsonSchema | undefined) : undefined) ?? true;
    const template = synthesize(itemSchema);
    const ids = Array.from({ length: count }, (_, index) => itemId(index));
    const limitValue = Number(query.get(pagination.limit));
    const limit = Number.isInteger(limitValue) && limitValue > 0 ? limitValue : DEFAULT_LIMIT;
    const after = query.get(pagination.after);
    // An unknown cursor yields an empty page.
    const start = after === null ? 0 : ids.includes(after) ? ids.indexOf(after) + 1 : count;
    const items = ids.slice(start, start + limit).map((id) => (isObject(template) ? { ...template, id } : { id }));
    return { ...body, [pagination.items]: items, [pagination.hasMore]: start + limit < count };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    const target = request.url ?? "";
    const method = request.method ?? "";
    seq += 1;
    const capture: Capture = {
      case: session?.case ?? null,
      surface: session?.surface ?? null,
      seq,
      method,
      target,
      headers: pairs(request.rawHeaders),
      body_b64: body.toString("base64"),
    };
    appendFileSync(out, `${JSON.stringify(capture)}\n`);

    const mark = target.indexOf("?");
    const path = mark === -1 ? target : target.slice(0, mark);
    const op = matchRoute(routes, method, path);
    if (op === null) {
      send(response, 404, { statusCode: 404, name: "not_found", message: `No operation for ${method} ${path}.` });
      return;
    }
    send(response, op.response.status, successBody(op, new URLSearchParams(mark === -1 ? "" : target.slice(mark + 1))));
  };

  const control = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    if (request.method === "GET" && request.url === "/__paridad/health") {
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url === "/__paridad/session") {
      const next = parseSession(body);
      if (typeof next === "string") {
        send(response, 400, { error: next });
        return;
      }
      session = next;
      send(response, 200, { run: next.run, case: next.case, surface: next.surface, list_items: next.listItems });
      return;
    }
    send(response, 404, { error: `unknown control request ${request.method} ${request.url}` });
  };

  const api = await listen(handle, options.port);
  const controlServer = await listen(control, options.controlPort);
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

// Method and path template; among the templates that match, literal segments win
// over parameters, compared from the first segment on.
function matchRoute(routes: Route[], method: string, path: string): IROperation | null {
  const segments = path.split("/");
  let best: Route | null = null;
  for (const route of routes) {
    if (route.op.method !== method || route.segments.length !== segments.length) continue;
    if (!route.segments.every((segment, index) => segment === null || segment === segments[index])) continue;
    if (best === null || moreLiteral(route, best)) best = route;
  }
  return best?.op ?? null;
}

function moreLiteral(a: Route, b: Route): boolean {
  for (let index = 0; index < a.segments.length; index++) {
    const literalA = a.segments[index] !== null;
    const literalB = b.segments[index] !== null;
    if (literalA !== literalB) return literalA;
  }
  return false;
}

function parseSession(body: Buffer): Session | string {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return "the session body is not JSON";
  }
  if (!isObject(value)) return "the session body is not an object";
  for (const key of ["run", "case", "surface"]) {
    if (typeof value[key] !== "string" || value[key] === "") return `session.${key} must be a non-empty string`;
  }
  const listItems = value["list_items"];
  if (listItems !== undefined && (!Number.isInteger(listItems) || (listItems as number) < 0)) {
    return "session.list_items must be a non-negative integer";
  }
  return {
    run: value["run"] as string,
    case: value["case"] as string,
    surface: value["surface"] as string,
    listItems: listItems === undefined ? null : (listItems as number),
  };
}

function itemId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function deref(ir: IR, schema: JsonSchema): JsonSchema {
  let current = schema;
  for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth++) {
    const ref = current["$ref"] as string;
    if (depth > 32 || !ref.startsWith(SCHEMAS_REF)) break;
    current = ir.schemas[ref.slice(SCHEMAS_REF.length)] ?? true;
  }
  return current;
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) out.push([raw[index]!, raw[index + 1]!]);
  return out;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!response.headersSent) send(response, 500, { statusCode: 500, name: "application_error", message: "Capture server error." });
      else response.destroy();
    });
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, HOST, () => {
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
      out: { type: "string" },
      ir: { type: "string" },
    },
    strict: true,
  });
  if (values.out === undefined) throw new Error("--out is required");
  const irFile = values.ir === undefined ? resolve(ROOT, "ir/ir.json") : resolve(values.ir);
  const server = await startCaptureServer({
    port: parsePort(values.port, "port"),
    controlPort: parsePort(values["control-port"], "control-port"),
    out: resolve(values.out),
    ir: JSON.parse(readFileSync(irFile, "utf8")) as IR,
  });
  process.stdout.write(`capture: listening port=${server.port} control-port=${server.controlPort}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
