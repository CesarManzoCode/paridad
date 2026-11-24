import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { IR } from "../generator/src/ir.ts";
import { caseFile, compareCaptures, exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";

const ROOT = join(import.meta.dirname, "..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

test("the case builder gives one example case per operation, from examples[0]", () => {
  const cases = exampleCases(ir);
  assert.equal(cases.length, ir.operations.length);
  assert.deepEqual(
    cases.map((item) => item.operation),
    ir.operations.map((op) => op.id),
  );
  assert.equal(new Set(cases.map((item) => item.case)).size, cases.length);
  const send = cases.find((item) => item.operation === "emails/send");
  const example = ir.operations.find((op) => op.id === "emails/send")!.examples[0]!;
  assert.deepEqual(send, {
    case: "emails/send#example",
    operation: "emails/send",
    path: example.path,
    query: example.query,
    headers: example.headers,
    body: example.body,
    idempotency_key: null,
    iterate: false,
  });
  assert.equal(caseFile("emails/send#example"), "emails_send_example");
});

let seq = 0;
function capture(surface: string, target: string, body: unknown): CaseCapture {
  const text = body === null ? "" : JSON.stringify(body);
  const headers: [string, string][] = [["Authorization", `Bearer ${TEST_KEY}`]];
  if (text !== "") headers.push(["Content-Type", "application/json"]);
  return { case: "c#1", surface, seq: ++seq, method: "POST", target, headers, body_b64: Buffer.from(text).toString("base64") };
}

test("the comparator finds no difference in equal requests", () => {
  // Key order and query order do not count (§7.1).
  const captures = [capture("ts", "/emails?a=1&b=2", { to: "x", from: "y" }), capture("go", "/emails?b=2&a=1", { from: "y", to: "x" })];
  assert.deepEqual(compareCaptures(["c#1"], ["ts", "go"], captures), []);
});

test("the comparator detects a body difference", () => {
  const captures = [capture("ts", "/emails", { subject: "Hello" }), capture("python", "/emails", { subject: "Bye" })];
  assert.deepEqual(compareCaptures(["c#1"], ["ts", "python"], captures), [{ case: "c#1", fields: ["body"], surfaces: ["python"] }]);
});

test("the comparator detects a query difference", () => {
  const captures = [capture("ts", "/contacts?limit=2", null), capture("go", "/contacts?limit=3", null)];
  assert.deepEqual(compareCaptures(["c#1"], ["ts", "go"], captures), [{ case: "c#1", fields: ["query"], surfaces: ["go"] }]);
});

test("a surface without requests counts as a difference", () => {
  const captures = [capture("ts", "/emails", { subject: "Hello" })];
  assert.deepEqual(compareCaptures(["c#1"], ["ts", "go"], captures), [{ case: "c#1", fields: ["count"], surfaces: ["go"] }]);
});
