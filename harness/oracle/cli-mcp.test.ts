import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { IR } from "../../generator/src/ir.ts";
import { cliArgv, type Case } from "./cli.ts";
import { initializeRequest, PROTOCOL_VERSION, toolCall } from "./mcp.ts";

const ROOT = join(import.meta.dirname, "../..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

function exampleCase(id: string, extra: Partial<Case> = {}): Case {
  const op = ir.operations.find((candidate) => candidate.id === id);
  assert.ok(op, id);
  const example = op.examples[0]!;
  return { case: `${id}#example`, operation: id, path: example.path, query: example.query, body: example.body, idempotency_key: null, iterate: false, ...extra };
}

const noFiles = (): string => assert.fail("no file field expected");

test("a path parameter becomes a flag of paridad <resource> <action>", () => {
  const item = exampleCase("domains/get");
  assert.deepEqual(cliArgv(ir, item, noFiles), ["domains", "get", "--domain-id", String(item.path["domain_id"])]);
});

test("body properties become flags and the key becomes --idempotency-key", () => {
  const item = exampleCase("emails/send", { idempotency_key: "key-1" });
  const body = item.body as Record<string, unknown>;
  const argv = cliArgv(ir, item, noFiles);
  assert.deepEqual(argv.slice(0, 2), ["emails", "send"]);
  assert.deepEqual(argv.slice(-2), ["--idempotency-key", "key-1"]);
  for (const [name, value] of Object.entries(body)) {
    const at = argv.indexOf(`--${name}`);
    assert.ok(at > 1, `--${name}`);
    assert.equal(argv[at + 1], typeof value === "string" ? value : JSON.stringify(value));
  }
});

test("an empty key is still passed to the CLI", () => {
  const argv = cliArgv(ir, exampleCase("emails/send", { idempotency_key: "" }), noFiles);
  assert.deepEqual(argv.slice(-2), ["--idempotency-key", ""]);
});

test("a body that is not an object goes whole as --body", () => {
  const item = exampleCase("emails/send-batch");
  const argv = cliArgv(ir, item, noFiles);
  assert.deepEqual(argv, ["emails", "send-batch", "--body", JSON.stringify(item.body)]);
});

test("a file field is written to a file whose path is the flag value", () => {
  const files: [string, string][] = [];
  const argv = cliArgv(ir, exampleCase("contacts/create-import"), (name, text) => {
    files.push([name, text]);
    return `/files/${name}`;
  });
  assert.deepEqual(argv, ["contacts", "create-import", "--file", "/files/file"]);
  assert.deepEqual(files, [["file", "example"]]);
});

test("query parameters become flags and an iterating case adds --all", () => {
  const item = exampleCase("contacts/list", { query: { limit: 2 }, iterate: true });
  assert.deepEqual(cliArgv(ir, item, noFiles), ["contacts", "list", "--limit", "2", "--all"]);
});

test("a case that iterates an operation without pagination is rejected", () => {
  assert.throws(() => cliArgv(ir, exampleCase("domains/get", { iterate: true }), noFiles), /does not paginate/);
});

test("tools/call takes the tool name and path parameters by name", () => {
  const item = exampleCase("domains/get");
  assert.deepEqual(toolCall(ir, item), { name: "domains_get", arguments: { domain_id: item.path["domain_id"] } });
});

test("tools/call takes the body as body and the key as idempotency_key", () => {
  const item = exampleCase("emails/send", { idempotency_key: "key-1" });
  assert.deepEqual(toolCall(ir, item), { name: "emails_send", arguments: { idempotency_key: "key-1", body: item.body } });
  assert.deepEqual(toolCall(ir, { ...item, idempotency_key: null }).arguments, { body: item.body });
});

test("tools/call takes query parameters by name and leaves out the absent ones", () => {
  assert.deepEqual(toolCall(ir, exampleCase("contacts/list", { query: { limit: 2 } })), { name: "contacts_list", arguments: { limit: 2 } });
  assert.deepEqual(toolCall(ir, exampleCase("domains/list", { query: {} })), { name: "domains_list", arguments: {} });
});

test("the session starts with initialize for protocol 2025-11-25", () => {
  assert.equal(PROTOCOL_VERSION, "2025-11-25");
  const message = initializeRequest(1);
  assert.equal(message["jsonrpc"], "2.0");
  assert.equal(message["method"], "initialize");
  assert.equal((message["params"] as Record<string, unknown>)["protocolVersion"], "2025-11-25");
});

test("an unknown operation is rejected by both translations", () => {
  const item = exampleCase("domains/get", { operation: "nothing/here" });
  assert.throws(() => cliArgv(ir, item, noFiles), /unknown operation/);
  assert.throws(() => toolCall(ir, item), /unknown operation/);
});
