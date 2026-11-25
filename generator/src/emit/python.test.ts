import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { buildIR, loadOverlay } from "../ir.ts";
import { parseSpec } from "../spec.ts";
import { PyTypes, emitPython, pyLiteral } from "./python.ts";

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
        - { name: X-Trace, in: header, schema: { type: string } }
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
const ir = buildIR({ spec, overlay: { ...loadOverlay(join(ROOT, "ir/overlay.yaml")), operations: {} }, pin: null, lenientOverlay: false });

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-py-"));
  dirs.push(dir);
  emitPython(ir, dir);
  return join(dir, "sdks/python");
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("pyproject.toml builds paridad-resend with hatchling, Python >=3.10 and no dependencies", () => {
  const pyproject = readFileSync(join(emit(), "pyproject.toml"), "utf8");
  assert.match(pyproject, /\nrequires = \["hatchling==1\.33\.0"\]\nbuild-backend = "hatchling\.build"\n/);
  assert.match(pyproject, /\nname = "paridad-resend"\n/);
  assert.match(pyproject, /\nversion = "0\.0\.0-dev"\n/);
  assert.match(pyproject, /\nrequires-python = ">=3\.10"\n/);
  assert.match(pyproject, /\ndependencies = \[\]\n/);
  assert.match(pyproject, /\npackages = \["src\/paridad_resend"\]\n/);
  assert.match(pyproject, /\npythonpath = \["src"\]\n/);
});

test("the runtime, py.typed and runtime tests are the static templates", () => {
  const out = emit();
  for (const file of ["src/paridad_resend/_runtime.py", "src/paridad_resend/py.typed", "tests/test_runtime.py"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(ROOT, "generator/templates/python", file), "utf8"), file);
  }
});

test("one method per operation, each with its literal operationId in its docstring", () => {
  const resources = readFileSync(join(emit(), "src/paridad_resend/resources.py"), "utf8");
  for (const op of ir.operations) assert.ok(resources.includes(`operationId: \`${op.id}\` — \`${op.method} ${op.path}\``), op.id);
  assert.match(resources, /\nclass Things:\n/);
  assert.match(resources, /\n {4}def list\(self, query: schemas\.ThingsListQuery \| None = None\) -> schemas\.ThingList:\n/);
  assert.match(resources, /\n {4}def list_all\(self, query: schemas\.ThingsListAllQuery \| None = None\) -> Iterator\[schemas\.Thing\]:\n/);
  assert.match(resources, /\n {4}def create\(self, body: schemas\.Thing, \*, idempotency_key: str \| None = None\) -> schemas\.Thing:\n/);
  assert.match(resources, /\n {4}def remove\(self, thing_id: str, \*, headers: schemas\.ThingsRemoveHeaders \| None = None\) -> schemas\.ThingsRemoveResponse:\n/);
  const init = readFileSync(join(emit(), "src/paridad_resend/__init__.py"), "utf8");
  assert.match(init, /\n {4}things: resources\.Things\n/);
  assert.match(init, /\n {8}self\.things = resources\.Things\(core\)\n/);
});

test("schemas are TypedDicts with required and optional keys, and the iterator query has no cursors", () => {
  const schemas = readFileSync(join(emit(), "src/paridad_resend/schemas.py"), "utf8");
  assert.ok(
    schemas.includes(`_ThingRequired = TypedDict(
    "_ThingRequired",
    {
        "name": "str",
    },
)


_ThingOptional = TypedDict(
    "_ThingOptional",
    {
        "id": "str",
        "color": "Literal[\\"red\\", \\"blue\\"] | None",
    },
    total=False,
)


class Thing(_ThingRequired, _ThingOptional):
    """A thing."""
`),
    schemas,
  );
  const allQuery = schemas.slice(schemas.indexOf('_ThingsListAllQueryOptional = TypedDict('));
  assert.match(allQuery, /^_ThingsListAllQueryOptional = TypedDict\(\n {4}"_ThingsListAllQueryOptional",\n {4}\{\n {8}"limit": "int",\n {4}\},/);
  assert.match(schemas, /\n {8}"after": "str",\n/);
  assert.match(schemas, /\n {4}"ThingsRemoveResponse",\n/);
});

test("the policy constants are the policy of the IR", () => {
  const policy = readFileSync(join(emit(), "src/paridad_resend/_policy.py"), "utf8");
  assert.ok(policy.includes(`\nVERSION = "0.0.0-dev"\n`));
  assert.ok(policy.includes(`\nPOLICY: Policy = ${pyLiteral(ir.policy, "")}\n`));
  assert.equal(pyLiteral({ a: [true, null, 1], b: {} }, ""), '{\n    "a": [\n        True,\n        None,\n        1,\n    ],\n    "b": {},\n}');
});

test("PyTypes maps JSON Schema keywords", () => {
  const types = new PyTypes({ A: { type: "object", properties: { x: { type: "string" } } }, B: { type: "object", properties: { y: { type: "integer" } } } });
  assert.equal(types.type({ type: ["string", "null"] }, "H"), "str | None");
  assert.equal(types.type({ type: "string", format: "binary" }, "H"), "bytes");
  assert.equal(types.type({ type: "array", items: { $ref: "#/schemas/A" } }, "H"), "list[A]");
  assert.equal(types.type({ oneOf: [{ type: "string" }, { type: "integer" }] }, "H"), "str | int");
  assert.equal(types.type({ anyOf: [{ required: ["x"] }], type: "object", properties: { x: { type: "string" } } }, "OnlyConstraints"), "OnlyConstraints");
  assert.equal(types.type({ allOf: [{ $ref: "#/schemas/A" }, { $ref: "#/schemas/B" }] }, "AB"), "AB");
  assert.equal(types.type({ allOf: [{ $ref: "#/schemas/A" }, { description: "Only a description." }] }, "H"), "A");
  assert.equal(types.type({ type: "object", additionalProperties: { type: "string" } }, "H"), "dict[str, str]");
  assert.equal(types.type({ const: "list" }, "H"), 'Literal["list"]');
  assert.equal(types.type({ enum: ["a", "b", null] }, "H"), 'Literal["a", "b"] | None');
  assert.equal(types.type(true, "H"), "Any");
  assert.equal(types.named({ type: "array", items: { type: "string" } }, "Strings"), "schemas.Strings");
  assert.equal(types.named({ type: "string" }, "H"), "str");
  const module = types.module();
  assert.match(module, /\nclass AB\(A, B\):\n {4}pass\n/);
  assert.match(module, /\nStrings: TypeAlias = "list\[str\]"\n/);
  // Bases come before the classes that extend them.
  assert.ok(module.indexOf("\nclass A(") < module.indexOf("\nclass AB(") && module.indexOf("\nclass B(") < module.indexOf("\nclass AB("));
});

test("emitting twice gives the same tree and removes files the emitter no longer writes", () => {
  const out = emit();
  writeFileSync(join(out, "src/paridad_resend/stale.py"), "\n");
  const dir = join(out, "../..");
  emitPython(ir, dir);
  const first = tree(out);
  assert.equal(first["src/paridad_resend/stale.py"], undefined);
  emitPython(ir, dir);
  assert.deepEqual(tree(out), first);
  assert.deepEqual(Object.keys(first).sort(), [
    "pyproject.toml",
    "src/paridad_resend/__init__.py",
    "src/paridad_resend/_policy.py",
    "src/paridad_resend/_runtime.py",
    "src/paridad_resend/py.typed",
    "src/paridad_resend/resources.py",
    "src/paridad_resend/schemas.py",
    "tests/test_operations.py",
    "tests/test_runtime.py",
  ]);
});

test("the generated client sends the request of an operation, with a header parameter other than Idempotency-Key", async () => {
  const out = emit();
  const seen: { method: string; url: string; authorization: string; userAgent: string; trace: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization ?? "",
      userAgent: req.headers["user-agent"] ?? "",
      trace: req.headers["x-trace"] as string | undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"deleted":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = `import json, sys
from paridad_resend import Resend
resend = Resend("re_emitter_test_1234", base_url=sys.argv[1])
print(json.dumps(resend.things.remove("a b", headers={"X-Trace": "t-1"})))
`;
    const { stdout } = await promisify(execFile)("python3", ["-c", script, `http://127.0.0.1:${(server.address() as AddressInfo).port}`], {
      env: { ...process.env, PYTHONPATH: join(out, "src"), PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.deepEqual(JSON.parse(stdout), { deleted: true });
    assert.deepEqual(seen, [{ method: "DELETE", url: "/things/a%20b", authorization: "Bearer re_emitter_test_1234", userAgent: "paridad-python/0.0.0-dev", trace: "t-1" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
