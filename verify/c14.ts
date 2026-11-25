// node verify/c14.ts <run dir>   (make verify C=c14)
// C14 (contract §6, §9): gets tools/list from `node mcp/src/main.ts --transport stdio`
// (raw response in out/tools-list.mcp.json) and checks: a bijection between tools and
// operations of the IR by names.mcp; each inputSchema declares JSON Schema 2020-12
// and is a valid schema of that dialect; the annotations (readOnlyHint on GET,
// destructiveHint on DELETE and on the destructive operations of the overlay,
// idempotentHint on the safe methods of §5.3); and, for the corpus of each operation
// (its example of the IR and its invalid variants, verify/agents.ts), that ajv 2020-12
// gives the same verdict with the request schema of the spec and with the inputSchema.
// Writes corpus.jsonl ({"tool","operation","example","spec_valid","tool_valid"}) and
// problems.jsonl; prints desacuerdos=<n> and exits 0 only if there is no problem.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createValidator, requestSchemaOf, type IR, type IROperation } from "../generator/src/ir.ts";
import { isObject, type JsonObject } from "../generator/src/spec.ts";
import { initializeRequest } from "../harness/oracle/mcp.ts";
import { corpusOf, toolArguments } from "./agents.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
// Time the server has to answer each request.
const ANSWER_TIMEOUT_MS = 30_000;

interface ListedTool {
  name: string;
  inputSchema: JsonObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

// tools/list over stdio, following nextCursor; the raw response lines go to out/.
async function listTools(): Promise<ListedTool[]> {
  const child = spawn(process.execPath, [join(ROOT, "mcp/src/main.ts"), "--transport", "stdio"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const lines: string[] = [];
  const waiting = new Map<number, (message: JsonObject | null) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message) || typeof message["id"] !== "number" || "method" in message) return;
    lines.push(line);
    waiting.get(message["id"])?.(message);
  });
  child.on("close", () => {
    for (const done of waiting.values()) done(null);
  });
  const request = (message: JsonObject): Promise<JsonObject> =>
    new Promise((done, fail) => {
      const id = message["id"] as number;
      const timer = setTimeout(() => fail(new Error(`no answer to ${String(message["method"])} in ${ANSWER_TIMEOUT_MS} ms`)), ANSWER_TIMEOUT_MS);
      waiting.set(id, (response) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (response === null) fail(new Error("the MCP server exited before answering"));
        else if (!isObject(response["result"])) fail(new Error(`${String(message["method"])} failed: ${JSON.stringify(response["error"])}`));
        else done(response["result"]);
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  try {
    await request(initializeRequest(1));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools: ListedTool[] = [];
    let cursor: unknown;
    for (let id = 2; ; id++) {
      const result = await request({ jsonrpc: "2.0", id, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
      tools.push(...(result["tools"] as ListedTool[]));
      cursor = result["nextCursor"];
      if (typeof cursor !== "string") break;
    }
    return tools;
  } finally {
    writeFileSync(join(out, "tools-list.mcp.json"), lines.map((line) => `${line}\n`).join(""));
    child.stdin.end();
    child.kill();
    writeFileSync(join(out, "tools-list.mcp.stderr"), Buffer.concat(stderr));
  }
}

const problems: { tool: string | null; operation: string | null; problem: string }[] = [];
const problem = (tool: string | null, operation: string | null, text: string): void => {
  problems.push({ tool, operation, problem: text });
};

const tools = await listTools();

// Bijection by names.mcp.
const byTool = new Map<string, IROperation>(ir.operations.map((op) => [op.names.mcp, op]));
const listed = new Map<string, ListedTool>();
for (const entry of tools) {
  if (listed.has(entry.name)) problem(entry.name, null, "the tool is listed twice");
  listed.set(entry.name, entry);
  if (!byTool.has(entry.name)) problem(entry.name, null, "the tool has no operation in the IR");
}
for (const op of ir.operations) if (!listed.has(op.names.mcp)) problem(op.names.mcp, op.id, "the operation has no tool");

// The same options as the server: formats are annotations of 2020-12.
const toolAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const specValidate = createValidator(ir.schemas, ir.operations);
const safeMethods = new Set(ir.policy["safe_methods"] as string[]);
const lines: string[] = [];
let disagreements = 0;

for (const op of ir.operations) {
  const entry = listed.get(op.names.mcp);
  if (entry === undefined) continue;
  const annotations = entry.annotations ?? {};
  const expected = { readOnlyHint: op.method === "GET", destructiveHint: op.destructive, idempotentHint: safeMethods.has(op.method) };
  if (op.method === "DELETE" && !op.destructive) problem(entry.name, op.id, "a DELETE operation is not destructive in the IR");
  for (const [hint, value] of Object.entries(expected)) {
    const shown = annotations[hint as keyof typeof expected];
    if (shown !== value) problem(entry.name, op.id, `${hint} is ${String(shown)}, expected ${value}`);
  }

  if (entry.inputSchema["$schema"] !== DIALECT) problem(entry.name, op.id, `inputSchema.$schema is ${String(entry.inputSchema["$schema"])}, not ${DIALECT}`);
  if (toolAjv.validateSchema(entry.inputSchema) !== true) {
    problem(entry.name, op.id, `inputSchema is not a valid 2020-12 schema: ${toolAjv.errorsText(toolAjv.errors)}`);
    continue;
  }
  let toolValidate: (value: unknown) => boolean;
  try {
    toolValidate = toolAjv.compile(entry.inputSchema);
  } catch (error) {
    problem(entry.name, op.id, `inputSchema does not compile: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const requestSchema = requestSchemaOf(op);
  for (const example of corpusOf(op, ir.schemas)) {
    const arguments_ = toolArguments(op, example.request);
    const specValid = specValidate(requestSchema, example.request) === null;
    const toolValid = toolValidate(arguments_);
    lines.push(`${JSON.stringify({ tool: entry.name, operation: op.id, example: { label: example.label, request: example.request, arguments: arguments_ }, spec_valid: specValid, tool_valid: toolValid })}\n`);
    if (specValid !== toolValid) {
      disagreements += 1;
      problem(entry.name, op.id, `${example.label}: the spec says ${specValid ? "valid" : "invalid"}, the inputSchema ${toolValid ? "valid" : "invalid"}`);
    } else if (example.label === "example" && !specValid) problem(entry.name, op.id, "the example of the IR is rejected by both schemas");
  }
}

writeFileSync(join(runDir, "corpus.jsonl"), lines.join(""));
writeFileSync(join(runDir, "problems.jsonl"), problems.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
for (const entry of problems) process.stdout.write(`c14: ${entry.tool ?? "-"} ${entry.operation ?? "-"}: ${entry.problem}\n`);
process.stdout.write(`c14: tools=${tools.length} operations=${ir.operations.length} corpus=${lines.length} problems=${problems.length}\n`);
process.stdout.write(`desacuerdos=${disagreements}\n`);
process.exit(problems.length === 0 ? 0 : 1);
