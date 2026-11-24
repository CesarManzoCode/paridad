// MCP server of paridad (vault/CONTRACT.md §5, §6, D22, D28): the low-level Server of
// @modelcontextprotocol/sdk with one tool per operation, the stdio and Streamable
// HTTP transports, and the validation of tool arguments against their input schema.
// Static template copied by the generator; the tools come from the IR (tools.ts) and
// each one calls its method of the TypeScript SDK (paridad-resend).
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { ParidadError, Resend } from "paridad-resend";
import { DEFS, SERVER_VERSION, TOOLS } from "./tools.ts";

export const SERVER_NAME = "paridad-mcp";
export const MCP_PATH = "/mcp";
// DNS rebinding protection: the Host header, and the Origin header when present,
// must name the local machine (any port).
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface Tool {
  name: string;
  operationId: string;
  description: string;
  // Without $defs: the server adds the component schemas named in `defs`.
  inputSchema: Record<string, unknown>;
  defs: string[];
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  // Resource property and method of the SDK client.
  sdk: [string, string];
  pathParams: string[];
  queryParams: string[];
  body: boolean;
  // Top-level body properties of format binary, sent as files of a multipart body.
  binary: string[];
  idempotency: boolean;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: McpTool["inputSchema"];
  annotations: Tool["annotations"];
}

const byName = new Map(TOOLS.map((entry) => [entry.name, entry]));
const debugEnabled = process.env["PARIDAD_DEBUG"] === "1";

// The input schema of a tool as tools/list shows it: the schema of the IR with the
// component schemas it references in $defs.
function inputSchema(entry: Tool): ListedTool["inputSchema"] {
  const schema: Record<string, unknown> = { ...entry.inputSchema };
  if (entry.defs.length > 0) schema["$defs"] = Object.fromEntries(entry.defs.map((name) => [name, DEFS[name]]));
  return schema as ListedTool["inputSchema"];
}

export function listTools(): ListedTool[] {
  return TOOLS.map((entry) => ({ name: entry.name, description: entry.description, inputSchema: inputSchema(entry), annotations: entry.annotations }));
}

// JSON Schema 2020-12; `format` is an annotation, as the dialect's default vocabulary says.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validators = new Map<string, ValidateFunction>();

function validate(entry: Tool, args: Record<string, unknown>): string | null {
  let check = validators.get(entry.name);
  if (check === undefined) {
    check = ajv.compile(inputSchema(entry));
    validators.set(entry.name, check);
  }
  return check(args) ? null : ajv.errorsText(check.errors, { dataVar: "arguments" });
}

let client: Resend | undefined;

// The key comes only from RESEND_API_KEY of the process, never from the arguments.
function resend(): Resend {
  client ??= new Resend(process.env["RESEND_API_KEY"] || undefined, { userAgentSuffix: "mcp" });
  return client;
}

// tools/call: validates the arguments, calls the SDK and returns the JSON of the
// response; every error is a result with isError (§5.2).
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const entry = byName.get(name);
  if (entry === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  const result = await execute(entry, args);
  debug(`tool=${entry.name} operation=${entry.operationId} result=${result.isError === true ? (result.structuredContent as { error: { code: string } }).error.code : "ok"}`);
  return result;
}

async function execute(entry: Tool, args: Record<string, unknown>): Promise<CallToolResult> {
  const invalid = validate(entry, args);
  if (invalid !== null) return failure(new ParidadError("invalid_arguments", invalid, null));
  let sdk: Resend;
  try {
    sdk = resend();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(new ParidadError(process.env["RESEND_API_KEY"] ? "invalid_configuration" : "missing_api_key", message, null));
  }
  const call: unknown[] = entry.pathParams.map((name) => String(args[name]));
  if (entry.body) call.push(withFiles(entry, args["body"]));
  if (entry.queryParams.length > 0) {
    const query: Record<string, unknown> = {};
    for (const name of entry.queryParams) if (args[name] !== undefined) query[name] = args[name];
    call.push(query);
  }
  if (entry.idempotency) {
    const key = args["idempotency_key"];
    call.push(typeof key === "string" ? { idempotencyKey: key } : undefined);
  }
  const resource = (sdk as unknown as Record<string, Record<string, (...values: unknown[]) => Promise<{ data: unknown; error: ParidadError | null }>>>)[entry.sdk[0]]!;
  try {
    const result = await resource[entry.sdk[1]]!.call(resource, ...call);
    if (result.error !== null) return failure(result.error);
    return success(result.data);
  } catch (error) {
    return failure(error instanceof ParidadError ? error : new ParidadError("mcp_error", error instanceof Error ? error.message : String(error), null));
  }
}

// File fields of a multipart body arrive as text and are sent as files.
function withFiles(entry: Tool, body: unknown): unknown {
  if (entry.binary.length === 0 || typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...body };
  for (const name of entry.binary) {
    const value = copy[name];
    if (typeof value === "string") copy[name] = new Blob([value]);
  }
  return copy;
}

function success(data: unknown): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
  if (typeof data === "object" && data !== null && !Array.isArray(data)) result.structuredContent = data as Record<string, unknown>;
  return result;
}

function failure(error: ParidadError): CallToolResult {
  const structured = { error: { message: error.message, code: error.code, statusCode: error.statusCode } };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
}

// One protocol server; each stdio process or HTTP session has its own.
export function createMcpServer(): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {}, logging: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(request.params.name, request.params.arguments));
  return server;
}

// stdio: stdout carries only protocol messages; debug output goes to stderr.
export async function serveStdio(): Promise<void> {
  debug(`transport=stdio tools=${TOOLS.length}`);
  await createMcpServer().connect(new StdioServerTransport());
}

// Streamable HTTP on 127.0.0.1, path /mcp, one session per initialize.
export async function serveHttp(port: number): Promise<HttpServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createHttpServer((req, res) => {
    handle(req, res, sessions).catch((error: unknown) => {
      debug(`http error=${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) rpcError(res, 500, ErrorCode.InternalError, "Internal server error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  const { port: bound } = http.address() as AddressInfo;
  process.stderr.write(`${SERVER_NAME} listening on http://127.0.0.1:${bound}${MCP_PATH}\n`);
  debug(`transport=http port=${bound} tools=${TOOLS.length}`);
  return http;
}

async function handle(req: IncomingMessage, res: ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>): Promise<void> {
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== MCP_PATH) return rpcError(res, 404, ErrorCode.InvalidRequest, "Not found");
  const rejected = checkLocal(req);
  if (rejected !== null) return rpcError(res, 403, ErrorCode.ConnectionClosed, rejected);
  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string") {
    const transport = sessions.get(sessionId);
    if (transport === undefined) return rpcError(res, 404, -32001, "Session not found");
    return transport.handleRequest(req, res);
  }
  if (req.method !== "POST") return rpcError(res, 400, ErrorCode.ConnectionClosed, "Bad Request: No valid session ID provided");
  // The transport answers 400 to anything but initialize without a session.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
  };
  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res);
}

// Null when Host (and Origin, if present) name the local machine; otherwise the reason.
export function checkLocal(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (host === undefined || host === "") return "Missing Host header";
  if (!LOCAL_HOSTNAMES.has(hostname(`http://${host}`) ?? "")) return `Invalid Host header: ${host}`;
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_HOSTNAMES.has(hostname(origin) ?? "")) return `Invalid Origin header: ${origin}`;
  return null;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function debug(line: string): void {
  if (debugEnabled) process.stderr.write(`[paridad-mcp] ${line}\n`);
}
