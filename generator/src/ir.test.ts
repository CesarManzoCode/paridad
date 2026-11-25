import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { buildIR, loadOverlay, serializeIR, type Overlay } from "./ir.ts";
import { loadSpec, parseSpec, readPin } from "./spec.ts";

const ROOT = join(import.meta.dirname, "../..");
const SPEC_FILE = join(ROOT, "spec/resend.yaml");
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const spec = loadSpec(SPEC_FILE);
const overlay = loadOverlay(join(ROOT, "ir/overlay.yaml"));
const pin = readPin(join(ROOT, "spec/PIN"));
// spec/PIN carries a `patch:` line when a local patch changed the pinned file
// (verify/c26/add-operation.patch); the count of 144 is that of the upstream file.
const locallyPatched = /^patch: /m.test(readFileSync(join(ROOT, "spec/PIN"), "utf8"));

function build(changes: Partial<Overlay> = {}, ignoreMissingOverlayOperations = false) {
  return buildIR({ spec, overlay: { ...overlay, ...changes }, pin, ignoreMissingOverlayOperations });
}

const ir = build();

// The spec read on its own, without the generator's loader.
interface RawOperation {
  operationId: string;
  parameters?: { in?: string; name?: string }[];
}
const rawSpec = parse(readFileSync(SPEC_FILE, "utf8")) as { paths: Record<string, Record<string, RawOperation>> };
const specOperations = Object.entries(rawSpec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, op]) => ({ path, method: method.toUpperCase(), op })),
);

test("the IR has every operation of the pinned spec once, with its method and path", () => {
  if (!locallyPatched) assert.equal(specOperations.length, 144);
  assert.equal(ir.operations.length, specOperations.length);
  assert.deepEqual(
    ir.operations.map((op) => op.id),
    specOperations.map(({ op }) => op.operationId).sort(),
  );
  const byId = new Map(ir.operations.map((op) => [op.id, op]));
  for (const { path, method, op } of specOperations) {
    assert.equal(byId.get(op.operationId)?.method, method, op.operationId);
    assert.equal(byId.get(op.operationId)?.path, path, op.operationId);
  }
});

test("idempotency is true exactly for the six operations that declare Idempotency-Key", () => {
  const declared = specOperations
    .filter(({ op }) => (op.parameters ?? []).some((parameter) => parameter.in === "header" && parameter.name?.toLowerCase() === "idempotency-key"))
    .map(({ op }) => op.operationId)
    .sort();
  assert.deepEqual(declared, [
    "emails/send",
    "emails/send-batch",
    "inboxes/create-draft",
    "inboxes/forward-thread-email",
    "inboxes/reply-thread-email",
    "inboxes/send-draft",
  ]);
  assert.deepEqual(
    ir.operations.filter((op) => op.idempotency).map((op) => op.id),
    declared,
  );
});

test("readOnly follows GET and destructive follows DELETE plus the overlay", () => {
  for (const op of ir.operations) {
    assert.equal(op.readOnly, op.method === "GET", op.id);
    assert.equal(op.destructive, op.method === "DELETE" || overlay.operations[op.id]?.destructive === true, op.id);
  }
  assert.equal(ir.operations.find((op) => op.id === "emails/cancel")?.destructive, true);
  assert.equal(ir.operations.find((op) => op.id === "emails/send")?.destructive, false);
});

test("cursor pagination only on GET operations with limit, after and before", () => {
  const paginated = ir.operations.filter((op) => op.pagination !== null);
  for (const op of paginated) {
    assert.equal(op.method, "GET", op.id);
    const names = op.queryParams.map((parameter) => parameter.name);
    for (const name of ["limit", "after", "before"]) assert.ok(names.includes(name), `${op.id} lacks ${name}`);
  }
  // 28 GET use the shared Pagination* parameters (2 of them without `before`)
  // and 4 declare limit/after/before inline: 26 + 4 = 30.
  assert.equal(paginated.length, 30);
  assert.equal(ir.operations.find((op) => op.id === "webhooks/list-events")?.pagination, null);
});

test("building twice gives the same text, equal to the committed ir/ir.json", () => {
  const first = serializeIR(build());
  assert.equal(serializeIR(build()), first);
  assert.ok(first.endsWith("}\n"));
  assert.equal(readFileSync(join(ROOT, "ir/ir.json"), "utf8"), first);
});

test("an overlay entry for an operationId that does not exist fails", () => {
  const operations = { ...overlay.operations, "emails/teleport": { destructive: true as const } };
  assert.throws(() => build({ operations }), /emails\/teleport does not exist/);
  // With --spec (compatibility corpus) such entries are skipped.
  assert.doesNotThrow(() => build({ operations }, true));
});

test("an example that does not validate against the request schema fails", () => {
  const operations = { ...overlay.operations, "emails/send": { examples: [{ body: { subject: "No sender" } }] } };
  assert.throws(() => build({ operations }), /example 0 of emails\/send .*does not validate/);
});

test("an OpenAPI 3.0 fragment with nullable becomes JSON Schema 2020-12", () => {
  const legacy = parseSpec(`openapi: 3.0.3
info: { title: Things, version: 0.0.1 }
paths:
  /things/{id}:
    patch:
      operationId: things/update
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
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
        name: { type: string, nullable: true, example: lamp }
        color: { type: string, enum: [red, blue], nullable: true }
        size: { type: integer, minimum: 0, exclusiveMinimum: true }
        owner: { allOf: [{ $ref: '#/components/schemas/Owner' }], nullable: true }
    Owner:
      type: object
      properties:
        id: { type: string }
`);
  const built = buildIR({ spec: legacy, overlay: { ...overlay, operations: {} }, pin: null, ignoreMissingOverlayOperations: false });
  assert.equal(built.spec.openapi, "3.0.3");
  assert.deepEqual(built.schemas["Thing"], {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: ["string", "null"], examples: ["lamp"] },
      color: { type: ["string", "null"], enum: ["red", "blue", null] },
      size: { type: "integer", exclusiveMinimum: 0 },
      owner: { anyOf: [{ allOf: [{ $ref: "#/schemas/Owner" }] }, { type: "null" }] },
    },
  });
  const [op] = built.operations;
  assert.equal(op?.id, "things/update");
  assert.deepEqual(op?.requestBody, { $ref: "#/schemas/Thing" });
  assert.deepEqual(op?.examples[0]?.body, { name: "lamp" });
});
