import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildIR, loadOverlay } from "../ir.ts";
import { loadSpec, parseSpec, type JsonObject } from "../spec.ts";
import { emitMcp, exampleArguments, tool } from "./mcp.ts";

const ROOT = join(import.meta.dirname, "../../..");

const spec = parseSpec(`openapi: 3.1.0
info: { title: Things, version: 0.0.1 }
paths:
  /things:
    get:
      operationId: things/list
      summary: List things
      parameters:
        - { name: limit, in: query, description: Number of items to return., schema: { type: integer, minimum: 1, maximum: 100 } }
        - { name: after, in: query, schema: { type: string } }
        - { name: before, in: query, schema: { type: string } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ThingList' }
    post:
      operationId: things/create
      summary: Create a thing
      parameters:
        - { name: Idempotency-Key, in: header, schema: { type: string, maxLength: 256 } }
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Thing' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
  /things/{thing_id}:
    delete:
      operationId: things/remove
      parameters:
        - { name: thing_id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { type: object, properties: { deleted: { type: boolean } } }
    put:
      operationId: things/replace
      parameters:
        - { name: thing_id, in: path, required: true, schema: { type: string } }
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Thing' }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
components:
  schemas:
    Thing:
      type: object
      required: [name]
      properties:
        name: { type: string, example: lamp }
        part: { $ref: '#/components/schemas/Part' }
    Part:
      type: object
      properties:
        label: { type: string }
    ThingList:
      type: object
      properties:
        object: { const: list }
        has_more: { type: boolean }
        data: { type: array, items: { $ref: '#/components/schemas/Thing' } }
`);
const overlay = loadOverlay(join(ROOT, "ir/overlay.yaml"));
const ir = buildIR({ spec, overlay: { ...overlay, operations: {} }, pin: null, lenientOverlay: false });
const byId = (id: string) => ir.operations.find((op) => op.id === id)!;
const SAFE = new Set(["GET", "PUT", "DELETE"]);

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-mcp-"));
  dirs.push(dir);
  emitMcp(ir, dir);
  return join(dir, "mcp");
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

// The input schema with the component schemas it references, as tools/list shows it.
function fullSchema(entry: ReturnType<typeof tool>): JsonObject {
  const defs = Object.fromEntries(entry.defs.map((name) => [name, JSON.parse(JSON.stringify(ir.schemas[name]).replaceAll("#/schemas/", "#/$defs/"))]));
  return entry.defs.length === 0 ? entry.inputSchema : { ...entry.inputSchema, $defs: defs };
}

test("the package has the paridad-mcp binary, the SDK by workspace and the exact MCP SDK", () => {
  const manifest = JSON.parse(readFileSync(join(emit(), "package.json"), "utf8"));
  assert.equal(manifest.name, "paridad-mcp");
  assert.deepEqual(manifest.bin, { "paridad-mcp": "./src/main.ts" });
  assert.deepEqual(manifest.dependencies, { "@modelcontextprotocol/sdk": "1.32.2", ajv: "8.20.0", "paridad-resend": "workspace:*" });
  assert.deepEqual(manifest.scripts, { check: "tsc --strict --noEmit -p .", test: "node --test" });
});

test("the templates are copied as they are", () => {
  const out = emit();
  for (const file of ["tsconfig.json", "src/main.ts", "src/server.ts", "test/server.test.ts"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(ROOT, "generator/templates/mcp", file), "utf8"), file);
  }
});

test("one tool per operation, each with its literal operationId", () => {
  const tools = readFileSync(join(emit(), "src/tools.ts"), "utf8");
  for (const op of ir.operations) {
    assert.ok(tools.includes(`"operationId": ${JSON.stringify(op.id)}`), op.id);
    assert.ok(tools.includes(`"name": ${JSON.stringify(op.names.mcp)}`), op.names.mcp);
  }
});

test("annotations follow the method, the overlay and the retry policy", () => {
  assert.deepEqual(tool(byId("things/list"), ir.schemas, SAFE).annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  assert.deepEqual(tool(byId("things/create"), ir.schemas, SAFE).annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  assert.deepEqual(tool(byId("things/remove"), ir.schemas, SAFE).annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  assert.deepEqual(tool(byId("things/replace"), ir.schemas, SAFE).annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
});

test("the input schema joins path and query parameters, idempotency_key and the body", () => {
  const list = tool(byId("things/list"), ir.schemas, SAFE);
  assert.equal(list.name, "things_list");
  assert.deepEqual(list.inputSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of items to return." },
      after: { type: "string" },
      before: { type: "string" },
    },
    additionalProperties: false,
  });
  assert.deepEqual(list.defs, []);

  const create = tool(byId("things/create"), ir.schemas, SAFE);
  assert.deepEqual(Object.keys(create.inputSchema["properties"] as JsonObject), ["idempotency_key", "body"]);
  assert.deepEqual(create.inputSchema["required"], ["body"]);
  assert.deepEqual((create.inputSchema["properties"] as JsonObject)["body"], { $ref: "#/$defs/Thing" });
  // Part is reached only through Thing.
  assert.deepEqual(create.defs, ["Part", "Thing"]);
  assert.equal(((create.inputSchema["properties"] as JsonObject)["idempotency_key"] as JsonObject)["maxLength"], undefined);
  assert.deepEqual([create.idempotency, create.body, create.sdk], [true, true, ["things", "create"]]);
  assert.match(create.description, /operationId: things\/create \(POST \/things\)/);

  const remove = tool(byId("things/remove"), ir.schemas, SAFE);
  assert.deepEqual(remove.inputSchema["required"], ["thing_id"]);
  assert.deepEqual(remove.pathParams, ["thing_id"]);
});

test("the input schema is valid 2020-12 and accepts the example and rejects bad arguments", () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const op of ir.operations) {
    const entry = tool(op, ir.schemas, SAFE);
    const validate = ajv.compile(fullSchema(entry));
    assert.ok(validate(exampleArguments(entry, op)), `${op.id}: ${ajv.errorsText(validate.errors)}`);
    assert.equal(validate({ ...exampleArguments(entry, op), unknown_argument: 1 }), false, op.id);
  }
  const create = tool(byId("things/create"), ir.schemas, SAFE);
  assert.equal(ajv.compile(fullSchema(create))({ body: { part: { label: "x" } } }), false);
});

test("an argument name that collides is an error, and a header other than Idempotency-Key is an argument named as the header", () => {
  const create = byId("things/create");
  const clash = { ...create, queryParams: [{ name: "body", required: false, description: null, style: "form", explode: true, schema: { type: "string" } }] };
  assert.throws(() => tool(clash, ir.schemas, SAFE), /argument body of things\/create collides/);
  const header = { ...create, headerParams: [{ name: "X-Trace", required: false, description: null, style: "simple", explode: false, schema: { type: "string" } }] };
  const traced = tool(header, ir.schemas, SAFE);
  assert.deepEqual(traced.headerParams, ["X-Trace"]);
  assert.deepEqual((traced.inputSchema["properties"] as JsonObject)["X-Trace"], { type: "string" });
  assert.ok(!((traced.inputSchema["required"] as string[] | undefined) ?? []).includes("X-Trace"));
});

test("emitting twice gives the same tree and removes files the emitter no longer writes", () => {
  const out = emit();
  writeFileSync(join(out, "src/stale.ts"), "export {};\n");
  const dir = join(out, "..");
  emitMcp(ir, dir);
  const first = tree(out);
  assert.equal(first["src/stale.ts"], undefined);
  emitMcp(ir, dir);
  assert.deepEqual(tree(out), first);
  assert.deepEqual(Object.keys(first).sort(), ["package.json", "src/main.ts", "src/server.ts", "src/tools.ts", "test/server.test.ts", "test/tools.test.ts", "tsconfig.json"]);
});

test("every operation of the pinned specification gets a tool whose schema accepts its example", () => {
  const pinned = buildIR({ spec: loadSpec(join(ROOT, "spec/resend.yaml")), overlay, pin: null, lenientOverlay: false });
  const safe = new Set(pinned.policy["safe_methods"] as string[]);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const names = new Set<string>();
  for (const op of pinned.operations) {
    const entry = tool(op, pinned.schemas, safe);
    names.add(entry.name);
    assert.match(entry.name, /^[a-z0-9_-]+$/);
    assert.equal(entry.name.replace("_", "/"), op.id);
    const defs = Object.fromEntries(entry.defs.map((name) => [name, JSON.parse(JSON.stringify(pinned.schemas[name]).replaceAll("#/schemas/", "#/$defs/"))]));
    const validate = ajv.compile({ ...entry.inputSchema, $defs: defs });
    assert.ok(validate(exampleArguments(entry, op)), `${op.id}: ${ajv.errorsText(validate.errors)}`);
  }
  assert.equal(names.size, pinned.operations.length);
  const send = pinned.operations.find((op) => op.id === "emails/send")!;
  assert.equal(tool(send, pinned.schemas, safe).idempotency, true);
  const imports = pinned.operations.find((op) => op.id === "contacts/create-import")!;
  assert.deepEqual(tool(imports, pinned.schemas, safe).binary, ["file"]);
  const cancel = pinned.operations.find((op) => op.id === "emails/cancel")!;
  assert.equal(tool(cancel, pinned.schemas, safe).annotations.destructiveHint, true);
});
