import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IR } from "../generator/src/ir.ts";
import { checkErrorResults, ERROR_TABLE, errorCases, errorMessage, errorScenarios } from "./errors.ts";
import { forwardedCount, violationLines } from "./prism.ts";
import type { ResultLine } from "./surfaces.ts";

const ROOT = join(import.meta.dirname, "..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

// The table of contract §9.1, written out again so that a change in either shows.
const TABLE_9_1 = [
  "error-400-validation_error",
  "error-400-invalid_idempotency_key",
  "error-401-missing_api_key",
  "error-403-restricted_api_key",
  "error-404-not_found",
  "error-405-method_not_allowed",
  "error-409-invalid_idempotent_request",
  "error-409-concurrent_idempotent_requests",
  "error-422-missing_required_field",
  "error-429-rate_limit_exceeded",
  "error-429-daily_quota_exceeded",
  "error-500-application_error",
  "error-503-service_unavailable",
];
const IDEMPOTENT = new Set(["error-400-invalid_idempotency_key", "error-409-invalid_idempotent_request", "error-409-concurrent_idempotent_requests"]);

test("the error cases are the 13 rows of §9.1", () => {
  assert.deepEqual(
    errorCases(ir).map((item) => item.case),
    TABLE_9_1,
  );
});

test("idempotency errors use emails/send with a key, the others domains/list", () => {
  for (const item of errorCases(ir)) {
    if (IDEMPOTENT.has(item.case)) {
      assert.equal(item.operation, "emails/send", item.case);
      assert.ok(typeof item.idempotency_key === "string" && item.idempotency_key.length >= 1 && item.idempotency_key.length <= 256, item.case);
    } else {
      assert.equal(item.operation, "domains/list", item.case);
      assert.equal(item.idempotency_key, null, item.case);
    }
    assert.equal(item.iterate, false);
  }
});

test("every attempt of every scenario answers the error of its row", () => {
  const scenarios = errorScenarios(ir);
  assert.deepEqual(Object.keys(scenarios.cases), TABLE_9_1);
  const attempts = Number(ir.policy["max_attempts"]);
  assert.equal(attempts, 3);
  for (const row of ERROR_TABLE) {
    const actions = scenarios.cases[`error-${row.status}-${row.name}`]!;
    assert.equal(actions.length, attempts);
    for (const action of actions) {
      assert.equal(action.action, "respond");
      if (action.action !== "respond") continue;
      assert.equal(action.status, row.status);
      assert.deepEqual(action.body, { statusCode: row.status, name: row.name, message: errorMessage(row) });
      if (row.status === 429) {
        assert.deepEqual(Object.keys(action.headers ?? {}).sort(), ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"]);
        assert.equal(action.headers!["retry-after"], "1");
      } else assert.equal(action.headers, undefined);
    }
  }
});

test("the forced messages are distinct per row", () => {
  assert.equal(new Set(ERROR_TABLE.map(errorMessage)).size, ERROR_TABLE.length);
});

test("checkErrorResults accepts matching results and reports each departure", () => {
  const out = mkdtempSync(join(tmpdir(), "paridad-c6-"));
  try {
    const row = ERROR_TABLE[4]!;
    const id = `error-${row.status}-${row.name}`;
    const error = { code: row.name, message: errorMessage(row), statusCode: row.status };
    writeFileSync(join(out, `${id}.cli.stdout`), `${JSON.stringify({ error }, null, 2)}\n`);
    writeFileSync(join(out, `${id}.mcp.json`), `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, structuredContent: { error }, content: [] } })}\n`);
    const good: ResultLine[] = ["ts", "cli", "mcp"].map((surface) => ({
      case: id,
      surface,
      outcome: "error" as const,
      error,
      items: null,
      exit_code: surface === "cli" ? 1 : null,
    }));
    const failures = checkErrorResults(good, ["ts", "cli", "mcp"], out).filter((failure) => failure.case === id);
    assert.deepEqual(failures, []);

    const bad = good.map((line) => (line.surface === "ts" ? { ...line, error: { ...error, message: "other" } } : line.surface === "cli" ? { ...line, exit_code: 0 } : line));
    const reasons = checkErrorResults(bad, ["ts", "cli", "mcp"], out)
      .filter((failure) => failure.case === id)
      .map((failure) => failure.surface);
    assert.deepEqual(reasons, ["ts", "cli"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const CLEAN_LOG = `[11:02:03 AM] › [CLI] …  awaiting  Starting Prism…
[11:02:04 AM] › [CLI] ℹ  info      GET        http://127.0.0.1:4010/domains
[11:02:04 AM] › [CLI] ▶  start     Prism is listening on http://127.0.0.1:4010
[11:02:05 AM] › [HTTP SERVER] get /domains ℹ  info      Request received
[11:02:05 AM] ›     [PROXY] ℹ  info      > Forwarding "get" request to http://127.0.0.1:4011/domains...
[11:02:05 AM] ›     [PROXY] ℹ  info      The upstream call to /domains has returned 200
[11:02:05 AM] › [HTTP SERVER] post /emails ℹ  info      Request received
[11:02:05 AM] ›     [PROXY] ℹ  info      > Forwarding "post" request to http://127.0.0.1:4011/emails...
`;

const VIOLATION_LOG = `${CLEAN_LOG}[11:02:06 AM] › [HTTP SERVER] post /emails ℹ  info      Request received
[11:02:06 AM] ›     [VALIDATOR] ✖  error     Request body must have required property 'to'
[11:02:06 AM] ›     [VALIDATOR] ✖  error     Violation: request.body Request body must have required property 'to'
\u001b[31m[11:02:06 AM] › [HTTP SERVER] post /emails ✖  error     Request terminated with error: https://stoplight.io/prism/errors#UNPROCESSABLE_ENTITY Invalid request.\u001b[39m
`;

test("a Prism log without violations counts 0 and its forwarded requests", () => {
  assert.deepEqual(violationLines(CLEAN_LOG), []);
  assert.equal(forwardedCount(CLEAN_LOG), 2);
});

test("a Prism log with a rejected request counts each violation line", () => {
  const lines = violationLines(VIOLATION_LOG);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => !line.includes("\u001b")));
  assert.ok(lines[2]!.includes("UNPROCESSABLE_ENTITY"));
  assert.equal(forwardedCount(VIOLATION_LOG), 2);
});
