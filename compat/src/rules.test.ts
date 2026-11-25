// Contract compatibility rules (vault/CONTRACT.md §10): one minimal mutation per rule
// of a small spec, with its expected classification, affected operations and semver
// bump, and the JSON output and exit codes of the command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseSpec } from "../../generator/src/spec.ts";
import { RULES, SURFACES, compareSpecs, report, type Report, type RuleId } from "./rules.ts";

// Fixtures are plain JSON documents mutated in place by each case.
type Doc = any;

const EMAIL_RESPONSE = { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Email" } } } };

const BASE: Doc = {
  openapi: "3.1.0",
  info: { title: "fixture", version: "1.0.0" },
  paths: {
    "/emails": {
      post: {
        operationId: "emails/send",
        parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 256 } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SendEmail" } } } },
        responses: { "200": EMAIL_RESPONSE },
      },
    },
    "/emails/{email_id}": {
      get: {
        operationId: "emails/get",
        parameters: [{ name: "email_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": EMAIL_RESPONSE },
      },
    },
    "/domains": {
      get: {
        operationId: "domains/list",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 100 } }],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "string" } } } } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      SendEmail: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string" },
          to: { type: "array", items: { type: "string" } },
          subject: { type: "string", maxLength: 998 },
          priority: { type: "string", enum: ["low", "high"] },
          template: { allOf: [{ $ref: "#/components/schemas/Template" }] },
        },
      },
      Template: { type: "object", properties: { id: { type: "string" } } },
      Email: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["sent", "delivered"] },
          created_at: { type: "string" },
        },
      },
    },
  },
};

const SEND = "POST /emails";
const GET = "GET /emails/{email_id}";
const LIST = "GET /domains";

interface Case {
  name: string;
  // Applied to the base before the revision is copied from it.
  base?: (doc: Doc) => void;
  mutate: (doc: Doc) => void;
  // A rule the comparison must report, or null when it must report nothing.
  rule: RuleId | null;
  classification: Report["classification"];
  operations: string[];
  bump: Report["bump"];
}

const send = (doc: Doc): Doc => doc.components.schemas.SendEmail;
const email = (doc: Doc): Doc => doc.components.schemas.Email;

const CASES: Case[] = [
  { name: "identical specs", mutate: () => {}, rule: null, classification: "compatible", operations: [], bump: "patch" },
  {
    name: "remove an operation",
    mutate: (doc) => delete doc.paths["/emails/{email_id}"].get,
    rule: "operation-removed",
    classification: "breaking",
    operations: [GET],
    bump: "major",
  },
  {
    name: "remove a deprecated operation",
    base: (doc) => (doc.paths["/domains"].get.deprecated = true),
    mutate: (doc) => delete doc.paths["/domains"],
    rule: "operation-removed-after-deprecation",
    classification: "compatible",
    operations: [LIST],
    bump: "minor",
  },
  {
    name: "add an operation",
    mutate: (doc) =>
      (doc.paths["/emails/{email_id}"].delete = {
        operationId: "emails/cancel",
        parameters: [{ name: "email_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": EMAIL_RESPONSE },
      }),
    rule: "operation-added",
    classification: "compatible",
    operations: ["DELETE /emails/{email_id}"],
    bump: "minor",
  },
  {
    name: "change the path of an operation",
    mutate: (doc) => {
      doc.paths["/messages/{email_id}"] = doc.paths["/emails/{email_id}"];
      delete doc.paths["/emails/{email_id}"];
    },
    rule: "operation-removed",
    classification: "breaking",
    operations: [GET],
    bump: "major",
  },
  {
    name: "rename a path parameter",
    mutate: (doc) => {
      const item = doc.paths["/emails/{email_id}"];
      item.get.parameters[0].name = "id";
      doc.paths["/emails/{id}"] = item;
      delete doc.paths["/emails/{email_id}"];
    },
    rule: "operation-removed",
    classification: "breaking",
    operations: [GET],
    bump: "major",
  },
  {
    name: "add a required request property",
    mutate: (doc) => {
      send(doc).properties.reply_to = { type: "string" };
      send(doc).required.push("reply_to");
    },
    rule: "request-property-added-required",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "add an optional request property",
    mutate: (doc) => (send(doc).properties.reply_to = { type: "string" }),
    rule: "request-property-added-optional",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "remove a request property",
    mutate: (doc) => delete send(doc).properties.priority,
    rule: "request-property-removed",
    classification: "compatible",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "make a request property required",
    mutate: (doc) => send(doc).required.push("subject"),
    rule: "request-property-became-required",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "make a request property optional",
    mutate: (doc) => (send(doc).required = ["from"]),
    rule: "request-property-became-optional",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "change the type of a request property",
    mutate: (doc) => (send(doc).properties.subject.type = "integer"),
    rule: "request-type-changed",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "add a format to a request property",
    mutate: (doc) => (send(doc).properties.from.format = "email"),
    rule: "request-type-changed",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "make a request property nullable",
    mutate: (doc) => (send(doc).properties.subject.type = ["string", "null"]),
    rule: "request-type-generalized",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "change the type of a response property",
    mutate: (doc) => (email(doc).properties.created_at.type = "integer"),
    rule: "response-type-changed",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "make a response property nullable",
    mutate: (doc) => (email(doc).properties.created_at.type = ["string", "null"]),
    rule: "response-type-changed",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "remove the format of a response property",
    mutate: (doc) => delete email(doc).properties.id.format,
    rule: "response-type-changed",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "remove an enum value in a request",
    mutate: (doc) => (send(doc).properties.priority.enum = ["low"]),
    rule: "request-enum-value-removed",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "add an enum value in a request",
    mutate: (doc) => send(doc).properties.priority.enum.push("urgent"),
    rule: "request-enum-value-added",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "add an enum value in a response",
    mutate: (doc) => email(doc).properties.status.enum.push("bounced"),
    rule: "response-enum-value-added",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "add an optional response property",
    mutate: (doc) => (email(doc).properties.subject = { type: "string" }),
    rule: "response-property-added",
    classification: "compatible",
    operations: [GET, SEND],
    bump: "minor",
  },
  {
    name: "remove a required response property",
    mutate: (doc) => {
      delete email(doc).properties.status;
      email(doc).required = ["id"];
    },
    rule: "response-required-property-removed",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "remove an optional response property",
    mutate: (doc) => delete email(doc).properties.created_at,
    rule: "response-optional-property-removed",
    classification: "compatible",
    operations: [GET, SEND],
    bump: "minor",
  },
  {
    name: "make a response property optional",
    mutate: (doc) => (email(doc).required = ["id"]),
    rule: "response-property-became-optional",
    classification: "breaking",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "add a required query parameter",
    mutate: (doc) => doc.paths["/domains"].get.parameters.push({ name: "after", in: "query", required: true, schema: { type: "string" } }),
    rule: "parameter-added-required",
    classification: "breaking",
    operations: [LIST],
    bump: "major",
  },
  {
    name: "add an optional query parameter",
    mutate: (doc) => doc.paths["/domains"].get.parameters.push({ name: "after", in: "query", required: false, schema: { type: "string" } }),
    rule: "parameter-added-optional",
    classification: "compatible",
    operations: [LIST],
    bump: "minor",
  },
  {
    name: "remove a query parameter",
    mutate: (doc) => (doc.paths["/domains"].get.parameters = []),
    rule: "parameter-removed",
    classification: "compatible",
    operations: [LIST],
    bump: "major",
  },
  {
    name: "lower the maximum of a query parameter",
    mutate: (doc) => (doc.paths["/domains"].get.parameters[0].schema.maximum = 50),
    rule: "request-bound-narrowed",
    classification: "breaking",
    operations: [LIST],
    bump: "major",
  },
  {
    name: "widen a query parameter from integer to number",
    mutate: (doc) => (doc.paths["/domains"].get.parameters[0].schema.type = "number"),
    rule: "request-type-generalized",
    classification: "compatible",
    operations: [LIST],
    bump: "minor",
  },
  {
    name: "lower the maxLength of a request property",
    mutate: (doc) => (send(doc).properties.subject.maxLength = 100),
    rule: "request-bound-narrowed",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "raise the maxLength of a request property",
    mutate: (doc) => (send(doc).properties.subject.maxLength = 2000),
    rule: "request-bound-widened",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "add an optional header",
    mutate: (doc) => doc.paths["/emails"].post.parameters.push({ name: "X-Trace", in: "header", required: false, schema: { type: "string" } }),
    rule: "parameter-added-optional",
    classification: "compatible",
    operations: [SEND],
    bump: "minor",
  },
  {
    name: "remove the Idempotency-Key header",
    mutate: (doc) => (doc.paths["/emails"].post.parameters = []),
    rule: "parameter-removed",
    classification: "compatible",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "remove the success response",
    mutate: (doc) => (doc.paths["/emails/{email_id}"].get.responses = { "204": { description: "No Content" } }),
    rule: "response-success-status-removed",
    classification: "breaking",
    operations: [GET],
    bump: "major",
  },
  {
    name: "remove the request body",
    mutate: (doc) => delete doc.paths["/emails"].post.requestBody,
    rule: "request-body-removed",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "change a type under an allOf branch (WARN without --flatten-allof)",
    mutate: (doc) => (doc.components.schemas.Template.properties.id.type = "integer"),
    rule: "request-type-changed",
    classification: "compatible",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "wrap the request body in a oneOf that drops its contract",
    mutate: (doc) =>
      (doc.paths["/emails"].post.requestBody.content["application/json"].schema = {
        oneOf: [
          { type: "object", required: ["from", "to", "html"], properties: { from: { type: "string" }, to: { type: "array", items: { type: "string" } }, html: { type: "string" } } },
          { type: "object", required: ["from", "to", "text"], properties: { from: { type: "string" }, to: { type: "array", items: { type: "string" } }, text: { type: "string" } } },
        ],
      }),
    rule: "request-body-wrapped-in-one-of",
    classification: "breaking",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "wrap the request body in a oneOf that keeps it as an alternative (WARN)",
    mutate: (doc) =>
      (doc.paths["/emails"].post.requestBody.content["application/json"].schema = {
        oneOf: [{ $ref: "#/components/schemas/SendEmail" }, { type: "object", required: ["template_id"], properties: { template_id: { type: "string" } } }],
      }),
    rule: "request-body-wrapped-in-one-of-preserved",
    classification: "compatible",
    operations: [SEND],
    bump: "major",
  },
  {
    name: "wrap the response body in a oneOf that keeps it as an alternative (WARN)",
    mutate: (doc) => {
      doc.components.schemas.EmailV1 = email(doc);
      doc.components.schemas.Email = { oneOf: [{ $ref: "#/components/schemas/EmailV1" }, { type: "object", required: ["id"], properties: { id: { type: "string" } } }] };
    },
    rule: "response-body-wrapped-in-one-of-preserved",
    classification: "compatible",
    operations: [GET, SEND],
    bump: "major",
  },
  {
    name: "require authentication where none was required",
    mutate: (doc) => {
      doc.security = [{ bearerAuth: [] }];
      doc.components.securitySchemes = { bearerAuth: { type: "http", scheme: "bearer" } };
    },
    rule: "security-anonymous-access-removed",
    classification: "breaking",
    operations: [LIST, GET, SEND],
    bump: "major",
  },
];

function load(doc: Doc): ReturnType<typeof parseSpec> {
  return parseSpec(JSON.stringify(doc));
}

function revise(item: Case): { base: Doc; revision: Doc } {
  const base = structuredClone(BASE);
  item.base?.(base);
  const revision = structuredClone(base);
  item.mutate(revision);
  return { base, revision };
}

for (const item of CASES) {
  test(item.name, () => {
    const { base, revision } = revise(item);
    const changes = compareSpecs(load(base), load(revision));
    const result = report(changes);
    if (item.rule === null) assert.deepEqual(changes, []);
    else assert.ok(changes.some((change) => change.rule === item.rule), JSON.stringify(changes, null, 2));
    assert.equal(result.classification, item.classification, JSON.stringify(changes, null, 2));
    assert.deepEqual(result.operations, item.operations);
    assert.equal(result.bump, item.bump);
    assert.equal(result.exitCode, item.classification === "breaking" ? 1 : 0);
  });
}

test("every own rule names the oasdiff checks it covers", () => {
  for (const [id, rule] of Object.entries(RULES)) {
    assert.ok(rule.oasdiff.length > 0, id);
    assert.ok(["ERR", "WARN", "INFO"].includes(rule.level), id);
  }
});

test("each affected operation lists the five surfaces, the documentation and the skill", () => {
  const result = report(compareSpecs(load(BASE), load(revise(CASES.find((item) => item.rule === "response-enum-value-added")!).revision)));
  assert.deepEqual(result.surfaces, [
    { operation: GET, operationId: "emails/get", surfaces: SURFACES },
    { operation: SEND, operationId: "emails/send", surfaces: SURFACES },
  ]);
  assert.deepEqual(SURFACES, ["ts", "python", "go", "cli", "mcp", "docs", "skill"]);
});

const MAIN = join(import.meta.dirname, "main.ts");
const dir = mkdtempSync(join(tmpdir(), "paridad-compat-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function command(base: Doc, revision: Doc, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const baseFile = join(dir, "base.yaml");
  const revisionFile = join(dir, "revision.yaml");
  writeFileSync(baseFile, JSON.stringify(base));
  writeFileSync(revisionFile, JSON.stringify(revision));
  const child = spawnSync(process.execPath, [MAIN, baseFile, revisionFile, ...args], { encoding: "utf8" });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("--json prints the classification, bump, operations, surfaces and changes, and exits 1 when it breaks", () => {
  const { revision } = revise(CASES.find((item) => item.rule === "request-property-added-required")!);
  const { status, stdout } = command(BASE, revision, ["--json"]);
  assert.equal(status, 1, stdout);
  const output = JSON.parse(stdout);
  assert.deepEqual(Object.keys(output).sort(), ["bump", "changes", "classification", "exitCode", "operations", "surfaces"]);
  assert.equal(output.classification, "breaking");
  assert.equal(output.bump, "major");
  assert.equal(output.exitCode, 1);
  assert.deepEqual(output.operations, [SEND]);
  assert.deepEqual(output.surfaces, [{ operation: SEND, operationId: "emails/send", surfaces: SURFACES }]);
  const change = output.changes.find((entry: { rule: string }) => entry.rule === "request-property-added-required");
  assert.deepEqual(Object.keys(change).sort(), ["detail", "level", "oasdiff", "operation", "operationId", "rule"]);
  assert.equal(change.level, "ERR");
  assert.equal(change.operation, SEND);
  assert.equal(change.operationId, "emails/send");
  assert.ok(change.oasdiff.includes("new-required-request-property"));
});

test("a compatible revision exits 0, in JSON and in text", () => {
  const { revision } = revise(CASES.find((item) => item.rule === "operation-added")!);
  const json = command(BASE, revision, ["--json"]);
  assert.equal(json.status, 0, json.stdout);
  assert.deepEqual(JSON.parse(json.stdout).operations, ["DELETE /emails/{email_id}"]);
  const text = command(BASE, revision, []);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^compatible \(bump: minor\)\n/);
  assert.match(text.stdout, /DELETE \/emails\/\{email_id\} \(emails\/cancel\): ts, python, go, cli, mcp, docs, skill/);
});

test("a usage error or a spec that does not load exits 2", () => {
  const usage = spawnSync(process.execPath, [MAIN, "only-one.yaml", "--json"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stdout).error.code, "invalid_usage");
  const invalid = command({ openapi: "2.0" }, BASE, ["--json"]);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid_spec");
});
