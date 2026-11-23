import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildIR, loadOverlay } from "../ir.ts";
import { parseSpec } from "../spec.ts";
import { emitTypescript, tsType } from "./typescript.ts";

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
const ir = buildIR({ spec, overlay: { ...loadOverlay(join(ROOT, "ir/overlay.yaml")), operations: {} }, pin: null, ignoreMissingOverlayOperations: false });

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-ts-"));
  dirs.push(dir);
  emitTypescript(ir, dir);
  return join(dir, "sdks/typescript");
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("the package has no runtime dependencies, an optional React Email peer and exact dev tools", () => {
  const manifest = JSON.parse(readFileSync(join(emit(), "package.json"), "utf8"));
  assert.equal(manifest.name, "paridad-resend");
  assert.equal(manifest.version, "0.0.0-dev");
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.peerDependencies), ["@react-email/render"]);
  assert.deepEqual(manifest.peerDependenciesMeta, { "@react-email/render": { optional: true } });
  assert.deepEqual(manifest.devDependencies, { "@types/node": "26.6.6", typescript: "7.0.2" });
  assert.deepEqual(manifest.scripts, { check: "tsc --strict --noEmit -p .", test: "node --test" });
});

test("the runtime, tsconfig and runtime tests are the static templates", () => {
  const out = emit();
  for (const file of ["src/runtime.ts", "tsconfig.json", "test/runtime.test.ts"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(ROOT, "generator/templates/typescript", file), "utf8"), file);
  }
});

test("one method per operation, each with its literal operationId in its documentation", () => {
  const resources = readFileSync(join(emit(), "src/resources.ts"), "utf8");
  for (const op of ir.operations) assert.ok(resources.includes(`operationId: \`${op.id}\` — \`${op.method} ${op.path}\``), op.id);
  assert.match(resources, /export class Things \{/);
  assert.match(resources, /\n {2}list\(query\?: \{/);
  assert.match(resources, /\n {2}listAll\(query\?: \{\n(.*\n)* {2}\}\): AsyncGenerator<NonNullable<\(T\.ThingList\)\["data"\]>\[number\], void, undefined>/);
  assert.match(resources, /\n {2}create\(body: T\.Thing, options\?: IdempotentRequestOptions\): Promise<Result<T\.Thing>>/);
  assert.match(resources, /\n {2}remove\(thingId: string\): Promise<Result<\{/);
  // The iterator takes limit but not the cursors it manages.
  const listAll = resources.slice(resources.indexOf("listAll("));
  assert.ok(!listAll.slice(0, listAll.indexOf("AsyncGenerator")).includes("after?"));
});

test("schema types and the policy constants come from the IR", async () => {
  const out = emit();
  const types = readFileSync(join(out, "src/types.ts"), "utf8");
  assert.match(types, /\/\*\*\n \* A thing\.\n \*\/\nexport type Thing = \{\n {2}id\?: string;\n {2}name: string;\n {2}color\?: "red" \| "blue" \| null;\n\};/);
  const policy = (await import(pathToFileURL(join(out, "src/policy.ts")).href)) as { POLICY: unknown; VERSION: string };
  assert.deepEqual(policy.POLICY, ir.policy);
  assert.equal(policy.VERSION, "0.0.0-dev");
});

test("tsType maps JSON Schema keywords", () => {
  const ref = (name: string) => `T.${name}`;
  assert.equal(tsType({ type: ["string", "null"] }, ref, ""), "string | null");
  assert.equal(tsType({ type: "string", format: "binary" }, ref, ""), "Blob");
  assert.equal(tsType({ type: "array", items: { $ref: "#/schemas/Thing" } }, ref, ""), "Array<T.Thing>");
  assert.equal(tsType({ oneOf: [{ type: "string" }, { type: "integer" }] }, ref, ""), "string | number");
  assert.equal(tsType({ allOf: [{ $ref: "#/schemas/A" }, { $ref: "#/schemas/B" }] }, ref, ""), "T.A & T.B");
  assert.equal(tsType({ type: "object", additionalProperties: { type: "string" } }, ref, ""), "{\n  [key: string]: string;\n}");
  assert.equal(tsType({ const: "list" }, ref, ""), '"list"');
  assert.equal(tsType(true, ref, ""), "unknown");
});

test("emitting twice gives the same tree and removes files the emitter no longer writes", () => {
  const out = emit();
  writeFileSync(join(out, "src/stale.ts"), "export {};\n");
  const dir = join(out, "../..");
  emitTypescript(ir, dir);
  const first = tree(out);
  assert.equal(first["src/stale.ts"], undefined);
  emitTypescript(ir, dir);
  assert.deepEqual(tree(out), first);
  assert.deepEqual(Object.keys(first).sort(), [
    "package.json",
    "src/index.ts",
    "src/policy.ts",
    "src/resources.ts",
    "src/runtime.ts",
    "src/types.ts",
    "test/operations.test.ts",
    "test/runtime.test.ts",
    "tsconfig.json",
  ]);
});

test("the generated client sends the request of an operation", async () => {
  const out = emit();
  const { Resend } = (await import(pathToFileURL(join(out, "src/index.ts")).href)) as {
    Resend: new (key: string, options: { baseUrl: string }) => { things: { remove(id: string): Promise<{ data: unknown; error: unknown }> } };
  };
  const seen: { method: string; url: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"deleted":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const resend = new Resend("re_emitter_test_1234", { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    assert.deepEqual(await resend.things.remove("a b"), { data: { deleted: true }, error: null });
    assert.deepEqual(seen, [{ method: "DELETE", url: "/things/a%20b", authorization: "Bearer re_emitter_test_1234" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
