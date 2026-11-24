import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { IR } from "../../generator/src/ir.ts";
import { startCaptureServer, type Capture, type CaptureServer } from "../capture/server.ts";
import { normalize, type NormalizedRequest } from "../normalize.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "../..");
const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const dir = mkdtempSync(join(tmpdir(), "paridad-drivers-"));
const out = join(dir, "captures.jsonl");
const goDriver = join(dir, "go-driver");
let server: CaptureServer;

const DRIVERS: Record<string, (input: string) => string[]> = {
  ts: (input) => [process.execPath, "harness/oracle/ts.ts", input],
  python: (input) => ["python3", "-I", "harness/oracle/python_driver.py", input],
  go: (input) => [goDriver, input],
};

before(async () => {
  await run("go", ["build", "-o", goDriver, "."], { cwd: join(ROOT, "harness/oracle/go") });
  server = await startCaptureServer({ port: 0, controlPort: 0, out, ir });
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function example(id: string) {
  const op = ir.operations.find((candidate) => candidate.id === id);
  assert.ok(op, id);
  return op.examples[0]!;
}

// Runs one case with a driver under its own capture session; returns the result
// line and the requests attributed to that session.
async function drive(surface: string, item: Record<string, unknown>, listItems?: number) {
  const name = `${String(item["case"])}@${surface}`;
  const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: "test", case: name, surface, ...(listItems === undefined ? {} : { list_items: listItems }) }),
  });
  assert.equal(session.status, 200);
  const argv = DRIVERS[surface]!(JSON.stringify(item));
  const { stdout } = await run(argv[0]!, argv.slice(1), {
    cwd: ROOT,
    env: { ...process.env, RESEND_API_KEY: KEY, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` },
  });
  const requests = readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Capture)
    .filter((capture) => capture.case === name)
    .map((capture) => normalize({ ...capture }));
  return { line: JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, unknown>, requests };
}

for (const surface of Object.keys(DRIVERS)) {
  test(`${surface} driver sends emails/send with its body and idempotency key`, async () => {
    const body = example("emails/send").body;
    const item = { case: "emails/send#example", operation: "emails/send", path: {}, query: {}, headers: {}, body, idempotency_key: "key-1", iterate: false };
    const { line, requests } = await drive(surface, item);
    assert.deepEqual(line, { case: "emails/send#example", surface, outcome: "ok", error: null, items: null, exit_code: null });
    const expected: NormalizedRequest = {
      method: "POST",
      path: "/emails",
      query: [],
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": "key-1" },
      body: normalize({ method: "POST", target: "/", headers: [["content-type", "application/json"]], body_b64: Buffer.from(JSON.stringify(body)).toString("base64") }).body,
    };
    assert.deepEqual(requests, [expected]);
  });

  test(`${surface} driver puts path parameters in the path`, async () => {
    const { path } = example("domains/get");
    const item = { case: "domains/get#example", operation: "domains/get", path, query: {}, headers: {}, body: null, idempotency_key: null, iterate: false };
    const { line, requests } = await drive(surface, item);
    assert.equal(line["outcome"], "ok");
    assert.deepEqual(requests, [{ method: "GET", path: `/domains/${String(path["domain_id"])}`, query: [], headers: { authorization: `Bearer ${KEY}` }, body: null }]);
  });

  test(`${surface} driver walks every page when the case iterates`, async () => {
    const item = { case: "contacts/list#all", operation: "contacts/list", path: {}, query: { limit: 2 }, headers: {}, body: null, idempotency_key: null, iterate: true };
    const { line, requests } = await drive(surface, item, 3);
    assert.equal(line["outcome"], "ok");
    assert.equal((line["items"] as unknown[]).length, 3);
    assert.deepEqual(
      requests.map((request) => request.query),
      [[["limit", "2"]], [["after", "00000000-0000-4000-8000-000000000002"], ["limit", "2"]]],
    );
  });
}
