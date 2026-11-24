// Stdio bridge of MCP (vault/CONTRACT.md §7, D22): exposes a stdio MCP server over
// Streamable HTTP so the conformance framework, which only takes --url, can test it.
//
//   node harness/mcp-bridge/bridge.ts --port <p> --command <cmd> [args…]
//
// Each session (one initialize) launches its own process of <cmd>. The Streamable
// HTTP transport of @modelcontextprotocol/sdk handles the HTTP side (sessions, SSE,
// status codes); the JSON-RPC messages go to the process's stdin and come back from
// its stdout one per line, without being read or changed. Host and Origin are checked
// like the server does (DNS rebinding), so that check is measured on stdio too.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MCP_PATH = "/mcp";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface BridgeOptions {
  port: number;
  command: string[];
  // Where the processes write their stderr (default: the bridge's stderr).
  stderr?: (text: string) => void;
}

export function parseBridgeArgs(argv: string[]): { port: number; command: string[] } {
  const at = argv.indexOf("--command");
  const own = at === -1 ? argv : argv.slice(0, at);
  const command = at === -1 ? [] : argv.slice(at + 1);
  if (command.length === 0) throw new Error("--command <cmd…> is required");
  if (own.length !== 2 || own[0] !== "--port") throw new Error("usage: bridge.ts --port <p> --command <cmd…>");
  const port = Number(own[1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be an integer from 0 to 65535, not ${own[1]}`);
  return { port, command };
}

interface Session {
  transport: StreamableHTTPServerTransport;
  child: ChildProcessWithoutNullStreams | null;
}

export async function startBridge(options: BridgeOptions): Promise<Server> {
  const sessions = new Map<string, Session>();
  const children = new Set<ChildProcessWithoutNullStreams>();
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));

  // The process of a session starts with its first message (the initialize).
  const launch = (session: Session): ChildProcessWithoutNullStreams => {
    const [file, ...args] = options.command as [string, ...string[]];
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    child.stderr.on("data", (chunk: Buffer) => writeErr(chunk.toString()));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim() === "") return;
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(line) as JSONRPCMessage;
      } catch {
        writeErr(`mcp-bridge: the process wrote a line that is not JSON: ${line}\n`);
        return;
      }
      session.transport.send(message).catch((error: unknown) => writeErr(`mcp-bridge: ${error instanceof Error ? error.message : String(error)}\n`));
    });
    child.on("exit", () => {
      children.delete(child);
      void session.transport.close();
    });
    return child;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== MCP_PATH) return rpcError(res, 404, -32600, "Not found");
    const rejected = checkLocal(req);
    if (rejected !== null) return rpcError(res, 403, -32000, rejected);
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (session === undefined) return rpcError(res, 404, -32001, "Session not found");
      return session.transport.handleRequest(req, res);
    }
    if (req.method !== "POST") return rpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
    const session: Session = {
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
      }),
      child: null,
    };
    session.transport.onmessage = (message) => {
      session.child ??= launch(session);
      session.child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    session.transport.onclose = () => {
      if (session.transport.sessionId !== undefined) sessions.delete(session.transport.sessionId);
      session.child?.stdin.end();
      session.child?.kill();
    };
    await session.transport.start();
    await session.transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      writeErr(`mcp-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
    });
  });
  server.on("close", () => {
    for (const child of children) child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  return server;
}

// Null when Host (and Origin, if present) name the local machine; otherwise the reason.
function checkLocal(req: IncomingMessage): string | null {
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

if (import.meta.main) {
  let parsed: { port: number; command: string[] };
  try {
    parsed = parseBridgeArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`mcp-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const server = await startBridge(parsed);
  const { port } = server.address() as AddressInfo;
  process.stderr.write(`mcp-bridge listening on http://127.0.0.1:${port}${MCP_PATH}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
}
