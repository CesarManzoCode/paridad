#!/usr/bin/env node
// Entry point of the `paridad-mcp` binary: node mcp/src/main.ts --transport stdio|http [--port N].
import { parseArgs } from "node:util";
import { serveHttp, serveStdio } from "./server.ts";

const DEFAULT_PORT = 3000;

let values: { transport?: string; port?: string };
try {
  ({ values } = parseArgs({ options: { transport: { type: "string", default: "stdio" }, port: { type: "string" } }, strict: true }));
} catch (error) {
  process.stderr.write(`paridad-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`paridad-mcp: --port must be an integer from 0 to 65535, not ${values.port}\n`);
  process.exit(2);
}
if (values.transport === "stdio") await serveStdio();
else if (values.transport === "http") await serveHttp(port);
else {
  process.stderr.write(`paridad-mcp: --transport must be stdio or http, not ${values.transport}\n`);
  process.exit(2);
}
