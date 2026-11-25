import assert from "node:assert/strict";
import { test } from "node:test";
import type { IR, IROperation } from "../../generator/src/ir.ts";
import { compareSdks, maxBump, releaseBump, type SdkReport } from "./semver.ts";

function operation(id: string, method: string, path: string, pathParams: string[]): IROperation {
  const [resource, action] = id.split("/") as [string, string];
  const pascal = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    id,
    resource,
    action,
    method,
    path,
    tag: null,
    summary: null,
    pathParams: pathParams.map((name) => ({ name, required: true, description: null, style: "simple", explode: false, schema: { type: "string" } })),
    queryParams: [],
    headerParams: [],
    requestBody: method === "POST" ? { $ref: "#/schemas/SendEmailRequest" } : null,
    response: { status: 200, schema: { $ref: "#/schemas/Email" } },
    pagination: null,
    idempotency: false,
    readOnly: method === "GET",
    destructive: false,
    names: { ts: `${resource}.${action}`, python: `${resource}.${action}`, go: `${pascal(resource)}.${pascal(action)}`, cli: `paridad ${resource} ${action}`, mcp: `${resource}_${action}` },
    examples: [],
  };
}

function ir(operations: IROperation[]): IR {
  return {
    format: "paridad-ir/1",
    spec: { repository: null, commit: null, sha256: "0", openapi: "3.1.2", version: "1.5.1" },
    project: { repository: "https://github.com/CesarManzoCode/paridad", go_module: "github.com/CesarManzoCode/paridad/sdks/go" },
    policy: {},
    errors: [],
    operations,
    schemas: {
      Email: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      SendEmailRequest: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    },
  };
}

const send = operation("emails/send", "POST", "/emails", []);
const get = operation("emails/get", "GET", "/emails/{email_id}", ["email_id"]);
const base = ir([get, send]);

function report(bump: SdkReport["bump"]): SdkReport {
  return { bumps: { ts: bump, python: bump, go: bump }, bump, changes: [] };
}

test("removing a method is major in every SDK", () => {
  const result = compareSdks(base, ir([send]));
  assert.deepEqual(result.bumps, { ts: "major", python: "major", go: "major" });
  assert.equal(result.bump, "major");
  assert.ok(result.changes.some((change) => change.language === "python" && change.element === "method emails.get" && change.change === "removed"));
});

test("renaming a path parameter is major in TypeScript and Python and patch in Go", () => {
  const renamed = operation("emails/get", "GET", "/emails/{id}", ["id"]);
  const result = compareSdks(base, ir([renamed, send]));
  assert.deepEqual(result.bumps, { ts: "major", python: "major", go: "patch" });
  assert.equal(result.bump, "major");
});

test("adding a method is minor", () => {
  const cancel = operation("emails/cancel", "POST", "/emails/{email_id}/cancel", ["email_id"]);
  const result = compareSdks(base, ir([cancel, get, send]));
  assert.deepEqual(result.bumps, { ts: "minor", python: "minor", go: "minor" });
  assert.equal(result.bump, "minor");
  assert.ok(result.changes.every((change) => change.change === "added"));
});

test("an unchanged IR is patch", () => {
  const result = compareSdks(base, ir([get, send]));
  assert.deepEqual(result.bumps, { ts: "patch", python: "patch", go: "patch" });
  assert.equal(result.bump, "patch");
  assert.deepEqual(result.changes, []);
});

test("the release bump is the maximum of the contract and the SDKs", () => {
  assert.equal(releaseBump("minor", report("patch")), "minor");
  assert.equal(releaseBump("patch", report("major")), "major");
  assert.equal(releaseBump("major", report("minor")), "major");
  assert.equal(releaseBump("patch", report("patch")), "patch");
  assert.equal(releaseBump("patch", compareSdks(base, ir([send]))), "major");
  assert.equal(maxBump(), "patch");
});
