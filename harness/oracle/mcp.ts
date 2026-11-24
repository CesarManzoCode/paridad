// node harness/oracle/mcp.ts '<case JSON>' <out prefix>
// Driver of the paridad MCP server (contract §7): starts `node mcp/src/main.ts
// --transport stdio` with the environment of the driver (RESEND_API_KEY,
// RESEND_BASE_URL), initializes the session and runs the case as tools/call. Keeps
// the raw stdout and stderr of the server as <out prefix>.stdout and .stderr and the
// raw JSON-RPC response line of each tools/call as <out prefix>.json
// (out/<case>.mcp.json), and prints one results.jsonl line. The server does not walk
// pages (§5.4): a case that iterates calls the tool again with `after` = id of the
// last item while has_more is true, like any MCP client. Run from the repository root.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IR } from "../../generator/src/ir.ts";
import { BODY_ARGUMENT, IDEMPOTENCY_ARGUMENT } from "../../generator/src/emit/mcp.ts";
import { isObject } from "../../generator/src/spec.ts";
import type { Case } from "./cli.ts";

export const PROTOCOL_VERSION = "2025-11-25";
// Time the server has to exit after its stdin closes before it is terminated.
const EXIT_GRACE_MS = 5000;

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// The tools/call params of a case: path and query parameters by name, the key as
// idempotency_key when the case has one, even an empty one, and the body as body.
export function toolCall(ir: IR, item: Case): ToolCall {
  const op = ir.operations.find((candidate) => candidate.id === item.operation);
  if (op === undefined) throw new Error(`unknown operation ${item.operation}`);
  const args: Record<string, unknown> = {};
  for (const parameter of op.pathParams) args[parameter.name] = item.path[parameter.name];
  for (const parameter of op.queryParams) if (item.query[parameter.name] !== undefined) args[parameter.name] = item.query[parameter.name];
  if (op.idempotency && item.idempotency_key !== null) args[IDEMPOTENCY_ARGUMENT] = item.idempotency_key;
  if (op.requestBody !== null) args[BODY_ARGUMENT] = item.body;
  return { name: op.names.mcp, arguments: args };
}

// The JSON-RPC message that initializes the session.
export function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "paridad-harness", version: "0.0.0" } },
  };
}

// A stdio session: newline-delimited JSON-RPC messages (MCP stdio transport).
class Session {
  private readonly child = spawn(process.execPath, ["mcp/src/main.ts", "--transport", "stdio"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private buffered = "";
  private readonly waiting = new Map<number, (line: string) => void>();
  private readonly exited: Promise<number | null>;

  constructor() {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout.push(chunk);
      this.buffered += chunk.toString("utf8");
      let end: number;
      while ((end = this.buffered.indexOf("\n")) !== -1) {
        const line = this.buffered.slice(0, end).replace(/\r$/, "");
        this.buffered = this.buffered.slice(end + 1);
        this.receive(line);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.exited = new Promise((done) => {
      this.child.on("error", () => done(null));
      this.child.on("close", (code) => {
        for (const pending of this.waiting.values()) pending("");
        this.waiting.clear();
        done(code);
      });
    });
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Notifications and requests of the server have no matching id.
    if (!isObject(message) || "method" in message) return;
    const id = message["id"];
    const done = typeof id === "number" ? this.waiting.get(id) : undefined;
    if (done === undefined) return;
    this.waiting.delete(id as number);
    done(line);
  }

  // Sends a request and resolves with the raw line of its response; "" when the
  // server exits first.
  request(message: Record<string, unknown>): Promise<string> {
    return new Promise((done) => {
      this.waiting.set(message["id"] as number, done);
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(prefix: string): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), EXIT_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
    writeFileSync(`${prefix}.stdout`, Buffer.concat(this.stdout));
    writeFileSync(`${prefix}.stderr`, Buffer.concat(this.stderr));
  }
}

function parse(line: string): Record<string, unknown> {
  if (line === "") throw new Error("the MCP server exited before answering");
  const message = JSON.parse(line) as unknown;
  if (!isObject(message)) throw new Error("the MCP response is not an object");
  return message;
}

async function main(): Promise<void> {
  const item = JSON.parse(process.argv[2] ?? "") as Case;
  const prefix = process.argv[3];
  if (prefix === undefined) throw new Error("usage: mcp.ts '<case JSON>' <out prefix>");
  const ir = JSON.parse(readFileSync("ir/ir.json", "utf8")) as IR;
  const op = ir.operations.find((candidate) => candidate.id === item.operation);
  if (op === undefined) throw new Error(`unknown operation ${item.operation}`);
  if (item.iterate && op.pagination === null) throw new Error(`${op.id} does not paginate`);
  const call = toolCall(ir, item);
  mkdirSync(dirname(prefix), { recursive: true });

  const session = new Session();
  const responses: string[] = [];
  let error: unknown = null;
  let items: unknown[] | null = item.iterate ? [] : null;
  try {
    const initialized = parse(await session.request(initializeRequest(1)));
    if (!isObject(initialized["result"])) throw new Error(`initialize failed: ${JSON.stringify(initialized["error"])}`);
    session.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
    let id = 2;
    let args = call.arguments;
    for (;;) {
      const line = await session.request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: call.name, arguments: args } });
      id += 1;
      responses.push(line);
      const response = parse(line);
      const result = response["result"];
      if (!isObject(result)) {
        const rpc = isObject(response["error"]) ? response["error"] : {};
        error = { code: `jsonrpc_${String(rpc["code"])}`, message: rpc["message"] ?? null, statusCode: null };
        break;
      }
      const structured = isObject(result["structuredContent"]) ? result["structuredContent"] : null;
      if (result["isError"] === true) {
        const shown = structured !== null && isObject(structured["error"]) ? structured["error"] : {};
        error = { code: shown["code"] ?? null, message: shown["message"] ?? null, statusCode: shown["statusCode"] ?? null };
        break;
      }
      if (!item.iterate) break;
      const page = structured?.[op.pagination!.items];
      if (!Array.isArray(page)) throw new Error(`${op.id}: the page has no ${op.pagination!.items} list`);
      items!.push(...page);
      const last = page.at(-1);
      if (structured![op.pagination!.hasMore] !== true || !isObject(last)) break;
      args = { ...call.arguments, [op.pagination!.after]: last["id"] };
    }
  } finally {
    writeFileSync(`${prefix}.json`, responses.map((line) => `${line}\n`).join(""));
    await session.close(prefix);
  }
  if (error !== null) items = null;
  const line = { case: item.case, surface: "mcp", outcome: error === null ? "ok" : "error", error, items, exit_code: null };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`mcp driver: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
