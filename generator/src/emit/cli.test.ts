import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildIR, loadOverlay } from "../ir.ts";
import { loadSpec, parseSpec } from "../spec.ts";
import { command, emitCli, exampleArgv, flagKind } from "./cli.ts";

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
      required: [name]
      properties:
        name: { type: string, description: "Name of the thing.\\nSecond line.", example: lamp }
        sizeInCm: { type: integer, example: 3 }
        tags: { type: array, items: { type: string }, example: [a] }
        to: { oneOf: [{ type: string }, { type: array, items: { type: string } }], example: x@example.com }
    ThingList:
      type: object
      properties:
        object: { const: list }
        has_more: { type: boolean }
        data: { type: array, items: { $ref: '#/components/schemas/Thing' } }
`);
const overlay = loadOverlay(join(ROOT, "ir/overlay.yaml"));
const ir = buildIR({ spec, overlay: { ...overlay, operations: {} }, pin: null, ignoreMissingOverlayOperations: false });
const byId = (id: string) => ir.operations.find((op) => op.id === id)!;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-cli-"));
  dirs.push(dir);
  emitCli(ir, dir);
  return join(dir, "cli");
}

function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

test("the package has the paridad binary, the SDK by workspace and exact React Email and esbuild versions", () => {
  const manifest = JSON.parse(readFileSync(join(emit(), "package.json"), "utf8"));
  assert.deepEqual(manifest.bin, { paridad: "./src/main.ts" });
  assert.deepEqual(manifest.dependencies, {
    "@react-email/render": "2.3.1",
    esbuild: "0.28.2",
    "paridad-resend": "workspace:*",
    react: "19.3.1",
    "react-dom": "19.3.1",
  });
  assert.deepEqual(manifest.scripts, { check: "tsc --strict --noEmit -p .", test: "node --test" });
});

test("the templates are copied as they are", () => {
  const out = emit();
  for (const file of ["tsconfig.json", "src/main.ts", "src/cli.ts", "test/cli.test.ts", "test/fixtures/welcome.tsx"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), readFileSync(join(ROOT, "generator/templates/cli", file), "utf8"), file);
  }
});

test("one command per operation, each with its literal operationId", () => {
  const commands = readFileSync(join(emit(), "src/commands.ts"), "utf8");
  for (const op of ir.operations) assert.ok(commands.includes(`"operationId": ${JSON.stringify(op.id)}`), op.id);
  assert.match(commands, /export const USER_AGENT = "paridad-ts\/0\.0\.0-dev cli";/);
});

test("flags come from path and query parameters and top-level body properties", () => {
  const remove = command(byId("things/remove"), ir.schemas);
  assert.deepEqual([remove.resource, remove.action, remove.sdk], ["things", "remove", ["things", "remove"]]);
  assert.deepEqual(remove.pathParams.map((flag) => [flag.flag, flag.name, flag.required]), [["thing-id", "thing_id", true]]);
  assert.equal(remove.body, null);

  const list = command(byId("things/list"), ir.schemas);
  assert.equal(list.paginated, true);
  assert.deepEqual(list.queryParams.map((flag) => [flag.flag, flag.kind]), [["limit", "json"], ["after", "string"], ["before", "string"]]);

  const create = command(byId("things/create"), ir.schemas);
  assert.equal(create.idempotency, true);
  assert.equal(create.react, false);
  assert.deepEqual(
    create.body!.flags.map((flag) => [flag.flag, flag.name, flag.kind, flag.required, flag.description]),
    [
      ["name", "name", "string", true, "Name of the thing."],
      ["size-in-cm", "sizeInCm", "json", false, null],
      ["tags", "tags", "json", false, null],
      ["to", "to", "auto", false, null],
    ],
  );
});

test("flagKind tells how the text of a flag becomes a value", () => {
  assert.equal(flagKind({ type: "string" }, {}), "string");
  assert.equal(flagKind({ type: ["string", "null"] }, {}), "string");
  assert.equal(flagKind({ type: "boolean" }, {}), "json");
  assert.equal(flagKind({ enum: [1, 2] }, {}), "json");
  assert.equal(flagKind({ oneOf: [{ type: "string" }, { type: "object" }] }, {}), "auto");
  assert.equal(flagKind({ type: "string", format: "binary" }, {}), "binary");
  assert.equal(flagKind({ $ref: "#/components/schemas/S" }, { S: { type: "string" } }), "string");
  assert.equal(flagKind({}, {}), "auto");
});

test("exampleArgv gives the body as flags when it can and as --body otherwise", () => {
  const create = byId("things/create");
  const argv = exampleArgv(command(create, ir.schemas), create);
  assert.deepEqual(argv.slice(0, 2), ["things", "create"]);
  if (argv.includes("--body")) assert.deepEqual(JSON.parse(argv[argv.indexOf("--body") + 1]!), create.examples[0]!.body);
  else assert.ok(argv.includes("--name"));
  const remove = byId("things/remove");
  assert.deepEqual(exampleArgv(command(remove, ir.schemas), remove), ["things", "remove", "--thing-id", String(remove.examples[0]!.path["thing_id"])]);
});

test("a flag that collides with a flag of the CLI is an error", () => {
  const create = byId("things/create");
  const clash = { ...create, queryParams: [{ name: "json", required: false, description: null, style: "form", explode: true, schema: { type: "boolean" } }] };
  assert.throws(() => command(clash, ir.schemas), /flag --json of things\/create collides/);
});

test("emitting twice gives the same tree and removes files the emitter no longer writes", () => {
  const out = emit();
  writeFileSync(join(out, "src/stale.ts"), "export {};\n");
  const dir = join(out, "..");
  emitCli(ir, dir);
  const first = tree(out);
  assert.equal(first["src/stale.ts"], undefined);
  emitCli(ir, dir);
  assert.deepEqual(tree(out), first);
  assert.deepEqual(Object.keys(first).sort(), [
    "package.json",
    "src/cli.ts",
    "src/commands.ts",
    "src/main.ts",
    "test/cli.test.ts",
    "test/commands.test.ts",
    "test/fixtures/welcome.tsx",
    "tsconfig.json",
  ]);
});

test("every operation of the pinned specification gets a command and an example command line", () => {
  const pinned = buildIR({ spec: loadSpec(join(ROOT, "spec/resend.yaml")), overlay, pin: null, ignoreMissingOverlayOperations: false });
  const names = new Set<string>();
  for (const op of pinned.operations) {
    const cmd = command(op, pinned.schemas);
    names.add(`${cmd.resource} ${cmd.action}`);
    assert.deepEqual(exampleArgv(cmd, op).slice(0, 2), [cmd.resource, cmd.action]);
  }
  assert.equal(names.size, pinned.operations.length);
  assert.ok(command(pinned.operations.find((op) => op.id === "emails/send")!, pinned.schemas).react);
});
