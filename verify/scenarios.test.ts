import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { IR, IROperation } from "../generator/src/ir.ts";
import { rateLimitResponse, type Action, type Trace } from "../harness/faults/proxy.ts";
import { RATE_LIMIT } from "./errors.ts";
import {
  checkRateLimitWaits,
  faultCase,
  IDEMPOTENCY_CASES,
  loadScenario,
  PARTIAL_FAILURES,
  RATE_LIMIT_CASES,
  SCENARIOS_DIR,
  type Expected,
  type FaultScenario,
} from "./faults.ts";

const ROOT = join(import.meta.dirname, "..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const TABLE: Record<string, Expected> = { ...PARTIAL_FAILURES, ...RATE_LIMIT_CASES, ...IDEMPOTENCY_CASES };

interface Rules {
  responses: { status: number; name?: string | null }[];
  transport: string[];
}

interface Policy {
  max_attempts: number;
  safe_methods: string[];
  safe_with_idempotency_key: boolean;
  retry_always: Rules;
  retry_if_safe: Rules;
  backoff: { retry_after_max_seconds: number };
  idempotency_key: { min_length: number; max_length: number; error_code: string };
}

const policy = ir.policy as unknown as Policy;

interface Failed {
  code: string;
  transport: string | null;
  status: number | null;
  name: string | null;
  retryAfter: string | undefined;
}

// What the client sees for an attempt, or null when it succeeds.
function failureOf(action: Action, timeoutMs: number): Failed | null {
  switch (action.action) {
    case "pass":
      return null;
    case "delay":
      return action.delay_ms > timeoutMs ? { code: "timeout", transport: "timeout", status: null, name: null, retryAfter: undefined } : null;
    case "cut":
      return { code: "connection_error", transport: "connection_error_after_send", status: null, name: null, retryAfter: undefined };
    case "respond":
      return { code: action.body.name, transport: null, status: action.status, name: action.body.name, retryAfter: action.headers?.["retry-after"] };
  }
}

function matches(rules: Rules, failed: Failed): boolean {
  if (failed.transport !== null) return rules.transport.includes(failed.transport);
  return rules.responses.some((rule) => rule.status === failed.status && (!("name" in rule) || rule.name === failed.name));
}

// The result that the policy of ir/ir.json gives for a scenario, attempt by attempt,
// over every page of a full iteration.
function simulate(scenario: FaultScenario, op: IROperation): Omit<Expected, "sameKeyAndBody"> {
  const key = scenario.idempotency_key;
  const rule = policy.idempotency_key;
  if (key !== null && op.idempotency && (key.length < rule.min_length || key.length > rule.max_length)) {
    return { outcome: "error", code: rule.error_code, requests: 0, items: null };
  }
  const safe = policy.safe_methods.includes(op.method) || (policy.safe_with_idempotency_key && op.idempotency && key !== null);
  const pages = scenario.iterate ? Math.max(1, Math.ceil(scenario.list_items! / Number(scenario.query?.["limit"]))) : 1;
  let requests = 0;
  for (let page = 0; page < pages; page++) {
    for (let attempt = 1; ; attempt++) {
      const failed = failureOf(scenario.actions[requests] ?? { action: "pass" }, scenario.timeout_ms);
      requests += 1;
      if (failed === null) break;
      const tooLong = failed.retryAfter !== undefined && /^\d+$/.test(failed.retryAfter) && Number(failed.retryAfter) > policy.backoff.retry_after_max_seconds;
      const retryable = (matches(policy.retry_always, failed) || (safe && matches(policy.retry_if_safe, failed))) && !tooLong;
      if (!retryable || attempt >= policy.max_attempts) return { outcome: "error", code: failed.code, requests, items: null };
    }
  }
  return { outcome: "ok", code: null, requests, items: scenario.iterate ? scenario.list_items : null };
}

test("there is one scenario per case of §9.2 and §9.4", () => {
  assert.deepEqual(Object.keys(PARTIAL_FAILURES), [
    "timeout-get",
    "timeout-post-key",
    "timeout-post-nokey",
    "cut-get",
    "cut-post-key",
    "cut-post-nokey",
    "5xx-intermittent-get",
    "5xx-persistent-get",
    "5xx-post-nokey",
    "paginate-cut",
  ]);
  assert.deepEqual(Object.keys({ ...RATE_LIMIT_CASES, ...IDEMPOTENCY_CASES }), [
    "ratelimit-get",
    "ratelimit-post-nokey",
    "ratelimit-exhausted",
    "idem-retry-send",
    "idem-retry-batch",
    "idem-invalid-empty",
    "idem-invalid-257",
  ]);
  const files = readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  assert.deepEqual(files, Object.keys(TABLE).sort());
  for (const id of Object.keys(TABLE)) assert.equal(loadScenario(id).case, id);
});

test("the scenarios use the timeout, delay and 429 of the contract", () => {
  const rate = { ...rateLimitResponse({ limit: RATE_LIMIT, retryAfter: 1 }) };
  for (const id of Object.keys(TABLE)) {
    const scenario = loadScenario(id);
    assert.equal(scenario.timeout_ms, 1000, id);
    for (const action of scenario.actions) {
      if (action.action === "delay") assert.equal(action.delay_ms, 2000, id);
      if (action.action === "respond" && action.status === 429) assert.deepEqual(action, rate, id);
      if (action.action === "respond") assert.equal(action.body.statusCode, action.status, id);
    }
  }
});

test("every scenario gives the expected result under the policy of ir/ir.json", () => {
  for (const [id, expected] of Object.entries(TABLE)) {
    const scenario = loadScenario(id);
    const op = ir.operations.find((candidate) => candidate.id === scenario.operation);
    assert.ok(op, `${id}: ${scenario.operation} is not in the IR`);
    const item = faultCase(ir, scenario);
    assert.equal(item.case, id);
    if (scenario.iterate) assert.ok(op.pagination !== null, `${id}: ${op.id} does not paginate`);
    const result = simulate(scenario, op);
    assert.deepEqual(result, { outcome: expected.outcome, code: expected.code, requests: expected.requests, items: expected.items }, id);
    assert.equal(expected.sameKeyAndBody, scenario.idempotency_key !== null && op.idempotency && result.requests > 1, id);
  }
});

test("the invalid key scenarios have keys of 0 and 257 characters", () => {
  assert.equal(loadScenario("idem-invalid-empty").idempotency_key, "");
  assert.equal(loadScenario("idem-invalid-257").idempotency_key?.length, 257);
});

function trace(attempt: number, status: number, recvMs: number, endMs: number, headers: [string, string][]): Trace {
  return {
    case: "ratelimit-get",
    surface: "ts",
    attempt,
    t_recv_ns: String(BigInt(recvMs) * 1_000_000n),
    t_resp_end_ns: String(BigInt(endMs) * 1_000_000n),
    method: "GET",
    target: "/domains",
    headers: [],
    body_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    action: status === 429 ? "respond" : "pass",
    status,
    response_headers: headers,
  };
}

const RATE_HEADERS: [string, string][] = [
  ["ratelimit-limit", "2"],
  ["ratelimit-remaining", "0"],
  ["ratelimit-reset", "1"],
  ["retry-after", "1"],
];

test("c9 rejects a wait shorter than retry-after and accepts a correct one", () => {
  const early = [trace(1, 429, 0, 10, RATE_HEADERS), trace(2, 200, 900, 905, [])];
  assert.equal(checkRateLimitWaits(early, 3).length, 1);
  const edge = [trace(1, 429, 0, 10, RATE_HEADERS), trace(2, 200, 984, 990, [])];
  assert.equal(checkRateLimitWaits(edge, 3).length, 1);
  const correct = [trace(1, 429, 0, 10, RATE_HEADERS), trace(2, 200, 1130, 1135, [])];
  assert.deepEqual(checkRateLimitWaits(correct, 3), []);
  const late = [trace(1, 429, 0, 10, RATE_HEADERS), trace(2, 200, 2100, 2105, [])];
  assert.equal(checkRateLimitWaits(late, 3).length, 1);
});

test("c9 rejects a 429 without the rate limit headers and more attempts than the policy", () => {
  assert.ok(checkRateLimitWaits([trace(1, 429, 0, 10, [["retry-after", "1"]])], 3).length >= 3);
  const four = [0, 1, 2, 3].map((index) => trace(index + 1, 429, index * 1100, index * 1100 + 10, RATE_HEADERS));
  assert.ok(checkRateLimitWaits(four, 3).some((problem) => problem.includes("more than 3")));
});
