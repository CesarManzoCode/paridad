import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildIR, loadOverlay } from "../ir.ts";
import { parseSpec } from "../spec.ts";
import { GoTypes, emitGo, fieldName } from "./go.ts";

const ROOT = join(import.meta.dirname, "../../..");

const spec = parseSpec(`openapi: 3.1.0
info: { title: Things, version: 0.0.1 }
paths:
  /things:
    get:
      operationId: things/list
      summary: List things
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
        - { name: after, in: query, schema: { type: string } }
        - { name: before, in: query, schema: { type: string } }
        - { name: tags, in: query, explode: false, schema: { type: array, items: { type: string } } }
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
components:
  schemas:
    Thing:
      type: object
      description: A thing.
      required: [name]
      properties:
        id: { type: string }
        name: { type: string, example: lamp }
        color: { type: [string, "null"], enum: [red, blue, null] }
    ThingList:
      type: object
      properties:
        object: { const: list }
        has_more: { type: boolean }
        data: { type: array, items: { $ref: '#/components/schemas/Thing' } }
`);
const overlay = loadOverlay(join(ROOT, "ir/overlay.yaml"));
const ir = buildIR({ spec, overlay: { ...overlay, operations: {} }, pin: null, ignoreMissingOverlayOperations: false });

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-go-"));
  dirs.push(dir);
  emitGo(ir, dir);
  return join(dir, "sdks/go");
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("go.mod names the module of project.go_module and go 1.23", () => {
  assert.equal(readFileSync(join(emit(), "go.mod"), "utf8"), `module ${overlay.project.go_module}\n\ngo 1.23\n`);
});

test("the runtime and its tests are the static templates", () => {
  const out = emit();
  for (const file of ["runtime.go", "runtime_test.go"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(ROOT, "generator/templates/go", file), "utf8"), file);
  }
});

test("the runtime uses the standard library only", () => {
  const runtime = readFileSync(join(ROOT, "generator/templates/go/runtime.go"), "utf8");
  const imports = runtime.slice(runtime.indexOf("import ("), runtime.indexOf(")", runtime.indexOf("import (")));
  for (const path of imports.matchAll(/"([^"]+)"/g)) assert.ok(!path[1]!.includes("."), path[1]);
});

test("one method per operation with context.Context, each with its literal operationId in its documentation", () => {
  const services = readFileSync(join(emit(), "services.go"), "utf8");
  for (const op of ir.operations) assert.ok(services.includes(`// operationId: \`${op.id}\` — \`${op.method} ${op.path}\``), op.id);
  assert.match(services, /\ntype ThingsService struct \{\n\tcore \*core\n\}/);
  assert.match(services, /\nfunc \(s \*ThingsService\) List\(ctx context\.Context, query \*ThingsListQuery\) \(\*ThingList, error\) \{/);
  assert.match(services, /\nfunc \(s \*ThingsService\) ListAll\(ctx context\.Context, query \*ThingsListAllQuery\) iter\.Seq2\[Thing, error\] \{/);
  assert.match(services, /\nfunc \(s \*ThingsService\) Create\(ctx context\.Context, body \*Thing, options \.\.\.RequestOption\) \(\*Thing, error\) \{/);
  assert.match(services, /\nfunc \(s \*ThingsService\) Remove\(ctx context\.Context, thingID string\) \(\*ThingsRemoveResponse, error\) \{/);
  const client = readFileSync(join(emit(), "client.go"), "utf8");
  assert.match(client, /\tThings \*ThingsService\n/);
  assert.match(client, /func NewClient\(options \.\.\.Option\) \(\*Client, error\)/);
});

test("schema and query types come from the IR; the iterator query leaves out the cursors", () => {
  const types = readFileSync(join(emit(), "types.go"), "utf8");
  const thing = types.slice(types.indexOf("type Thing struct {"), types.indexOf("}", types.indexOf("type Thing struct {")));
  assert.match(types, /\/\/ A thing\.\ntype Thing struct \{/);
  assert.match(thing, /\tID \*string `json:"id,omitempty"`/);
  assert.match(thing, /\tName string `json:"name"`/);
  assert.match(thing, /\tColor \*string `json:"color,omitempty"`/);
  assert.match(types, /\tData \[\]Thing `json:"data,omitempty"`/);
  const listQuery = types.slice(types.indexOf("type ThingsListQuery struct {"), types.indexOf("}", types.indexOf("type ThingsListQuery struct {")));
  assert.match(listQuery, /\tLimit \*int `json:"limit,omitempty"`/);
  assert.match(listQuery, /\tAfter \*string `json:"after,omitempty"`/);
  assert.match(listQuery, /\tTags \[\]string `json:"tags,omitempty"`/);
  const allQuery = types.slice(types.indexOf("type ThingsListAllQuery struct {"), types.indexOf("}", types.indexOf("type ThingsListAllQuery struct {")));
  assert.match(allQuery, /\tLimit \*int/);
  assert.ok(!allQuery.includes("After") && !allQuery.includes("Before"), allQuery);
  assert.match(types, /values\["tags"\] = queryList\(q\.Tags, false\)/);
  assert.match(types, /values\["limit"\] = \[\]string\{queryText\(\*q\.Limit\)\}/);
});

test("the policy constants come from the IR", () => {
  const policy = readFileSync(join(emit(), "policy.go"), "utf8");
  const p = ir.policy as unknown as { max_attempts: number; backoff: { base_ms: number; cap_ms: number }; idempotency_key: { error_message: string } };
  assert.match(policy, /const Version = "0\.0\.0-dev"/);
  assert.match(policy, new RegExp(`maxAttempts: +${p.max_attempts},`));
  assert.match(policy, new RegExp(`baseMS: ${p.backoff.base_ms}, capMS: ${p.backoff.cap_ms}`));
  assert.ok(policy.includes(JSON.stringify(p.idempotency_key.error_message)));
  assert.match(policy, /\{status: 429, name: ptr\("rate_limit_exceeded"\)\}, \{status: 429\}/);
  assert.match(policy, /\{status: 500, anyName: true\}/);
});

test("fieldName writes PascalCase with Go initialisms", () => {
  assert.equal(fieldName("domain_id"), "DomainID");
  assert.equal(fieldName("reply_to"), "ReplyTo");
  assert.equal(fieldName("html"), "HTML");
  assert.equal(fieldName("ipAddress"), "IPAddress");
  assert.equal(fieldName("Idempotency-Key"), "IdempotencyKey");
});

test("GoTypes maps JSON Schema keywords", () => {
  const types = new GoTypes({ A: { type: "object", properties: { a: { type: "string" } } } });
  assert.deepEqual(types.resolve({ type: ["string", "null"] }, "X"), { expr: "string", kind: "scalar", nullable: true, struct: null });
  assert.equal(types.resolve({ type: "string", format: "binary" }, "X").expr, "[]byte");
  assert.equal(types.resolve({ type: "array", items: { $ref: "#/schemas/A" } }, "X").expr, "[]A");
  assert.equal(types.resolve({ oneOf: [{ type: "string" }, { type: "integer" }] }, "X").expr, "any");
  assert.equal(types.resolve({ allOf: [{ $ref: "#/schemas/A" }, { description: "Only a note." }] }, "X").expr, "A");
  assert.equal(types.resolve({ type: "object", additionalProperties: { type: "string" } }, "X").expr, "map[string]string");
  assert.equal(types.resolve({ type: "object" }, "X").expr, "map[string]any");
  assert.equal(types.resolve({ const: "list" }, "X").expr, "string");
  assert.equal(types.resolve(true, "X").expr, "any");
});

test("a required field that closes a cycle of values is a pointer", () => {
  const types = new GoTypes({ Node: { type: "object", required: ["child", "name"], properties: { name: { type: "string" }, child: { $ref: "#/schemas/Node" } } } });
  const file = types.file();
  assert.match(file, /\tChild \*Node `json:"child"`/);
  assert.match(file, /\tName string `json:"name"`/);
});

test("emitting twice gives the same gofmt-formatted tree and removes files the emitter no longer writes", () => {
  const out = emit();
  writeFileSync(join(out, "stale.go"), "package resend\n");
  const dir = join(out, "../..");
  emitGo(ir, dir);
  const first = tree(out);
  assert.equal(first["stale.go"], undefined);
  emitGo(ir, dir);
  assert.deepEqual(tree(out), first);
  assert.deepEqual(Object.keys(first).sort(), ["client.go", "go.mod", "operations_test.go", "policy.go", "runtime.go", "runtime_test.go", "services.go", "types.go"]);
  assert.equal(execFileSync("gofmt", ["-l", out], { encoding: "utf8" }), "");
});

test("the generated operation tests cover every operation with its example", () => {
  const source = readFileSync(join(emit(), "operations_test.go"), "utf8");
  for (const op of ir.operations) assert.ok(source.includes(`{${JSON.stringify(op.id)}, ${JSON.stringify(op.method)}, `), op.id);
  assert.ok(source.includes(`if len(ids) != ${ir.operations.length} {`));
  assert.match(source, /_, err := c\.Things\.Remove\(ctx, "[^"]+"\)/);
});
