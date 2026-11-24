import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { IR } from "../../generator/src/ir.ts";
import { loadSpec } from "../../generator/src/spec.ts";
import { LANGUAGES, loadOfficialMap, officialCall, specRefResolves, type CaseInput, type Language } from "./official-map.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "../..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const operations = new Set(ir.operations.map((op) => op.id));
const officialMap = loadOfficialMap(ROOT);
const coverage = JSON.parse(readFileSync(join(ROOT, "verify/oracle-coverage.json"), "utf8")) as Record<
  Language,
  { methods: { method: string; operation: string | null; reason: string | null }[] }
>;
const divergences = JSON.parse(readFileSync(join(ROOT, "verify/divergences.json"), "utf8")) as {
  operation: string;
  language: string;
  field: string;
  spec_ref: string;
  reason: string;
}[];
const dir = mkdtempSync(join(tmpdir(), "paridad-official-map-"));
const goDriver = join(dir, "official-go");

before(async () => {
  await run("go", ["build", "-o", goDriver, "."], { cwd: join(ROOT, "harness/oracle/official-go") });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The `<operationId>#example` case of an operation, as the runners build it.
function exampleCase(id: string, idempotencyKey: string | null = null): CaseInput & { case: string; headers: Record<string, unknown>; iterate: boolean } {
  const op = ir.operations.find((candidate) => candidate.id === id);
  assert.ok(op, id);
  const example = op.examples[0]!;
  return { case: `${id}#example`, operation: id, path: example.path, query: example.query, headers: example.headers, body: example.body, idempotency_key: idempotencyKey, iterate: false };
}

test("every entry of the map names an operation of the IR and a method per known language", () => {
  for (const [operation, entries] of Object.entries(officialMap.operations)) {
    assert.ok(operations.has(operation), `${operation} is not in the IR`);
    for (const [language, entry] of Object.entries(entries)) {
      assert.ok((LANGUAGES as readonly string[]).includes(language), `${operation}: unknown language ${language}`);
      assert.match(entry!.method, /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$|^[A-Za-z_][A-Za-z0-9_]*$/, `${operation} ${language}`);
      assert.ok(Array.isArray(entry!.args), `${operation} ${language}: args is not a list`);
    }
  }
});

test("every method of the oracle coverage has an operation of the IR or a reason", () => {
  for (const language of LANGUAGES) {
    const rows = coverage[language].methods;
    assert.ok(rows.length > 0, `${language} lists no methods`);
    assert.equal(new Set(rows.map((row) => row.method)).size, rows.length, `${language} lists a method twice`);
    for (const row of rows) {
      if (row.operation !== null) assert.ok(operations.has(row.operation), `${language} ${row.method}: ${row.operation} is not in the IR`);
      else assert.ok(row.reason !== null && row.reason.trim() !== "", `${language} ${row.method} has neither operation nor reason`);
      // A method that corresponds to an operation without a reason must have a case.
      if (row.operation !== null && row.reason === null) {
        assert.ok(officialMap.operations[row.operation]?.[language], `${language} ${row.method}: ${row.operation} has no entry in the map`);
      }
    }
  }
});

test("the Node and Python methods of the map are the ones the coverage lists for their operation", () => {
  for (const language of ["ts", "python"] as const) {
    const listed = new Map(coverage[language].methods.map((row) => [row.method, row]));
    for (const [operation, entries] of Object.entries(officialMap.operations)) {
      const entry = entries[language];
      if (entry === undefined) continue;
      assert.equal(listed.get(entry.method)?.operation, operation, `${language} ${entry.method}`);
    }
  }
});

test("every divergence has a spec_ref that resolves in spec/resend.yaml", () => {
  const spec = loadSpec(join(ROOT, "spec/resend.yaml"));
  assert.equal(specRefResolves(spec.document, "#/paths/~1emails/post/requestBody"), true);
  assert.equal(specRefResolves(spec.document, "#/paths/~1emails/post/no-such-key"), false);
  assert.equal(specRefResolves(spec.document, "#"), false);
  for (const entry of divergences) {
    assert.ok(operations.has(entry.operation), `${entry.operation} is not in the IR`);
    assert.ok((LANGUAGES as readonly string[]).includes(entry.language), `${entry.operation}: unknown language ${entry.language}`);
    assert.ok(specRefResolves(spec.document, entry.spec_ref), `${entry.operation} ${entry.language} ${entry.field}: ${entry.spec_ref} does not resolve`);
    assert.ok(entry.reason.trim() !== "", `${entry.operation} ${entry.language} ${entry.field} has no reason`);
  }
});

test("a Node case translates to the expected official call", () => {
  const item = exampleCase("broadcasts/create");
  assert.deepEqual(officialCall(officialMap, "ts", item), {
    method: "broadcasts.create",
    args: [{ from: "Acme <onboarding@resend.dev>", html: "<p>Hello World</p>", segmentId: "78261eea-8f8b-4381-83c6-79fa7120f1cf", subject: "Hello World" }],
  });
  const send = exampleCase("emails/send", "key-1");
  assert.deepEqual(officialCall(officialMap, "ts", send)?.args[1], { idempotencyKey: "key-1" });
  assert.deepEqual(officialCall(officialMap, "ts", exampleCase("emails/send"))?.args[1], {});
  assert.equal(officialCall(officialMap, "ts", exampleCase("contacts/create-import")), null);
});

test("a Python case translates to the expected official call, as official-map.ts does", async () => {
  const item = exampleCase("domains/update");
  const { stdout } = await run(join(ROOT, ".venv/bin/python"), ["-I", "harness/oracle/official_python.py", "--plan", JSON.stringify(item)], { cwd: ROOT });
  const plan = JSON.parse(stdout) as unknown;
  assert.deepEqual(plan, { method: "Domains.update", args: [{ open_tracking: true, id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }] });
  assert.deepEqual(plan, JSON.parse(JSON.stringify(officialCall(officialMap, "python", item))));
});

test("a Go case translates to the expected official call, as official-map.ts does", async () => {
  const item = exampleCase("contact-properties/update");
  const { stdout } = await run(goDriver, ["--plan", JSON.stringify(item)], { cwd: ROOT });
  const plan = JSON.parse(stdout) as unknown;
  assert.deepEqual(plan, { method: "ContactProperties.Update", args: [{ fallback_value: "example", Id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }] });
  assert.deepEqual(plan, JSON.parse(JSON.stringify(officialCall(officialMap, "go", item))));
});
