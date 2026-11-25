// The fault cases of C9 to C12 (contract §5.3, §9, §9.2, §9.4): the scenario of each
// case in verify/scenarios/<case>.json, the expected results of the contract tables,
// the run of a set of cases on the surfaces through the fault proxy, and the checks of
// each criterion on results.jsonl and traces.jsonl.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { startFaultProxy, type Action, type Scenarios, type Trace } from "../harness/faults/proxy.ts";
import type { Case } from "./cases.ts";
import { runBattery, type ResultLine } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const SCENARIOS_DIR = join(ROOT, "verify/scenarios");

// A case of §9.2 or §9.4: the operation with examples[0] of the IR (query replaced
// when given), the key, whether it walks every page, the items the capture server
// serves (list_items), the client timeout and the proxy action of each attempt.
export interface FaultScenario {
  case: string;
  operation: string;
  query?: Record<string, unknown>;
  idempotency_key: string | null;
  iterate: boolean;
  list_items: number | null;
  timeout_ms: number;
  actions: Action[];
}

// The "Resultado esperado" column: outcome, error code, requests the proxy receives,
// unique items of a full iteration, and whether every attempt carries the same key
// and body.
export interface Expected {
  outcome: "ok" | "error";
  code: string | null;
  requests: number;
  items: number | null;
  sameKeyAndBody: boolean;
}

const ok = (requests: number, sameKeyAndBody = false): Expected => ({ outcome: "ok", code: null, requests, items: null, sameKeyAndBody });
const error = (code: string, requests: number): Expected => ({ outcome: "error", code, requests, items: null, sameKeyAndBody: false });

// §9.2, in its order.
export const PARTIAL_FAILURES: Record<string, Expected> = {
  "timeout-get": ok(2),
  "timeout-post-key": ok(2, true),
  "timeout-post-nokey": error("timeout", 1),
  "cut-get": ok(2),
  "cut-post-key": ok(2, true),
  "cut-post-nokey": error("connection_error", 1),
  "5xx-intermittent-get": ok(2),
  "5xx-persistent-get": error("application_error", 3),
  "5xx-post-nokey": error("service_unavailable", 1),
  "paginate-cut": { outcome: "ok", code: null, requests: 4, items: 5, sameKeyAndBody: false },
};

// §9.4, split by criterion.
export const RATE_LIMIT_CASES: Record<string, Expected> = {
  "ratelimit-get": ok(2),
  "ratelimit-post-nokey": ok(2),
  "ratelimit-exhausted": error("rate_limit_exceeded", 3),
};

export const IDEMPOTENCY_CASES: Record<string, Expected> = {
  "idem-retry-send": ok(2, true),
  "idem-retry-batch": ok(2, true),
  "idem-invalid-empty": error("invalid_idempotency_key", 0),
  "idem-invalid-257": error("invalid_idempotency_key", 0),
};

export interface Failure {
  case: string;
  surface: string;
  reason: string;
}

export function loadScenario(id: string): FaultScenario {
  const scenario = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${id}.json`), "utf8")) as FaultScenario;
  if (scenario.case !== id) throw new Error(`verify/scenarios/${id}.json names case ${scenario.case}`);
  return scenario;
}

export function faultCase(ir: IR, scenario: FaultScenario): Case {
  const op = ir.operations.find((candidate) => candidate.id === scenario.operation);
  const example = op?.examples[0];
  if (example === undefined) throw new Error(`${scenario.operation} has no example in the IR`);
  return {
    case: scenario.case,
    operation: scenario.operation,
    path: example.path,
    query: scenario.query ?? example.query,
    headers: example.headers,
    body: example.body,
    idempotency_key: scenario.idempotency_key,
    iterate: scenario.iterate,
  };
}

export interface FaultRunOptions {
  run: string;
  ir: IR;
  ids: string[];
  surfaces: string[];
  // Directory of scenarios.json, captures.jsonl and traces.jsonl.
  dir: string;
  out: string;
  results: string;
  env: NodeJS.ProcessEnv;
  goDriver: string;
  // Address the fault proxy listens on and the surfaces reach (C12: the host end of
  // the veth pair); 127.0.0.1 by default.
  host?: string;
  // Command put before every driver (C12: run it inside the network namespace).
  prefix?: (env: NodeJS.ProcessEnv) => string[];
}

export interface FaultRun {
  lines: ResultLine[];
  traces: Trace[];
}

// Surface -> fault proxy -> capture server for the cases of ids, with
// RESEND_TIMEOUT_MS from the scenarios (one value for the whole run).
export async function runFaultCases(options: FaultRunOptions): Promise<FaultRun> {
  const scenarios = options.ids.map(loadScenario);
  const timeouts = new Set(scenarios.map((scenario) => scenario.timeout_ms));
  if (timeouts.size !== 1) throw new Error(`the scenarios of ${options.run} disagree on timeout_ms: ${[...timeouts].join(", ")}`);
  const proxyScenarios: Scenarios = { cases: Object.fromEntries(scenarios.map((scenario) => [scenario.case, scenario.actions])) };
  writeFileSync(join(options.dir, "scenarios.json"), `${JSON.stringify(proxyScenarios, null, 2)}\n`);
  const listItems = Object.fromEntries(scenarios.filter((scenario) => scenario.list_items !== null).map((scenario) => [scenario.case, scenario.list_items!]));
  const host = options.host ?? "127.0.0.1";
  const tracesFile = join(options.dir, "traces.jsonl");

  const capture = await startCaptureServer({ port: 0, controlPort: 0, out: join(options.dir, "captures.jsonl"), ir: options.ir });
  let lines: ResultLine[];
  try {
    const proxy = await startFaultProxy({ port: 0, controlPort: 0, host, upstream: `http://127.0.0.1:${capture.port}`, scenarios: proxyScenarios, out: tracesFile });
    try {
      const env = { ...options.env, RESEND_BASE_URL: `http://${host}:${proxy.port}`, RESEND_TIMEOUT_MS: String([...timeouts][0]) };
      lines = await runBattery({
        run: options.run,
        cases: scenarios.map((scenario) => faultCase(options.ir, scenario)),
        surfaces: options.surfaces,
        out: options.out,
        results: options.results,
        env,
        controlPorts: [capture.controlPort, proxy.controlPort],
        goDriver: options.goDriver,
        listItems,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix(env) }),
      });
      // A delayed response ends after its driver gave up; its trace is written then.
      await settleDelays(scenarios);
    } finally {
      await proxy.close();
    }
  } finally {
    await capture.close();
  }
  return { lines, traces: readTraces(tracesFile) };
}

// Waits for the longest delay of the run, so that the trace of a delayed attempt of
// the last surface is in traces.jsonl before it is read.
async function settleDelays(scenarios: FaultScenario[]): Promise<void> {
  const longest = Math.max(0, ...scenarios.flatMap((scenario) => scenario.actions.map((action) => (action.action === "delay" ? action.delay_ms : 0))));
  if (longest > 0) await new Promise((done) => setTimeout(done, longest));
}

export function readTraces(file: string): Trace[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Trace);
}

// The traces of one case and surface, by attempt.
export function attemptsOf(traces: Trace[], id: string, surface: string): Trace[] {
  return traces.filter((trace) => trace.case === id && trace.surface === surface).sort((a, b) => a.attempt - b.attempt);
}

function header(headers: [string, string][], name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

// The expected table on the result lines and traces: outcome and code, number of
// requests, unique items, the same key and body on every attempt, and no write
// without a key repeated after an answer other than 429.
export function checkExpected(ir: IR, table: Record<string, Expected>, surfaces: string[], lines: ResultLine[], traces: Trace[]): Failure[] {
  const failures: Failure[] = [];
  for (const [id, expected] of Object.entries(table)) {
    const scenario = loadScenario(id);
    const op = ir.operations.find((candidate) => candidate.id === scenario.operation);
    const write = op !== undefined && (op.method === "POST" || op.method === "PATCH");
    for (const surface of surfaces) {
      const fail = (reason: string): void => {
        failures.push({ case: id, surface, reason });
      };
      const line = lines.find((candidate) => candidate.case === id && candidate.surface === surface);
      if (line === undefined) {
        fail("no result line");
        continue;
      }
      if (line.outcome !== expected.outcome) fail(`outcome ${line.outcome}, expected ${expected.outcome}`);
      if (expected.code !== null && line.error?.code !== expected.code) fail(`code ${JSON.stringify(line.error?.code)}, expected ${expected.code}`);
      if (expected.outcome === "ok" && line.error !== null) fail(`error ${JSON.stringify(line.error)}`);

      const attempts = attemptsOf(traces, id, surface);
      if (attempts.length !== expected.requests) fail(`${attempts.length} requests, expected ${expected.requests}`);
      // A 429 is never processed, so only a repeat after any other answer is a repeated write (§5.3).
      const ambiguous = attempts.slice(0, -1).filter((trace) => trace.status !== 429).length;
      if (write && scenario.idempotency_key === null && ambiguous > 0) fail(`write without a key sent again after ${ambiguous} ambiguous failures`);
      if (expected.sameKeyAndBody) {
        const keys = new Set(attempts.map((trace) => header(trace.headers, "idempotency-key")));
        const bodies = new Set(attempts.map((trace) => trace.body_sha256));
        if (keys.size !== 1 || !keys.has(scenario.idempotency_key ?? undefined)) fail(`idempotency keys ${JSON.stringify([...keys])}, expected only ${JSON.stringify(scenario.idempotency_key)}`);
        if (bodies.size !== 1) fail(`${bodies.size} different bodies across the attempts`);
      }
      if (expected.items !== null) {
        const items = line.items ?? [];
        const ids = new Set(items.map((item) => (typeof item === "object" && item !== null && "id" in item ? String(item.id) : JSON.stringify(item))));
        if (items.length !== expected.items) fail(`${items.length} items, expected ${expected.items}`);
        if (ids.size !== items.length) fail(`${items.length - ids.size} duplicated items`);
      }
    }
  }
  return failures;
}

// C10: an invalid key gives the message of the policy on every surface.
export function checkInvalidKeyMessages(ir: IR, table: Record<string, Expected>, surfaces: string[], lines: ResultLine[]): Failure[] {
  const policy = ir.policy["idempotency_key"] as { error_code: string; error_message: string };
  const failures: Failure[] = [];
  for (const [id, expected] of Object.entries(table)) {
    if (expected.code !== policy.error_code) continue;
    for (const surface of surfaces) {
      const line = lines.find((candidate) => candidate.case === id && candidate.surface === surface);
      if (line !== undefined && line.error?.message !== policy.error_message) {
        failures.push({ case: id, surface, reason: `message ${JSON.stringify(line.error?.message)}, expected ${JSON.stringify(policy.error_message)}` });
      }
    }
  }
  return failures;
}

// Tolerance of C9 around retry-after × 1000 ms (D13).
export const WAIT_BELOW_MS = 25;
export const WAIT_ABOVE_MS = 1000;
const RATE_HEADERS = ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"];

// C9 on the traces of one case and surface: every 429 carries the four rate limit
// headers with retry-after: 1, the next attempt arrives between retry-after × 1000 −
// 25 ms and retry-after × 1000 + 1000 ms after the end of that response, and there are
// never more than max_attempts attempts.
export function checkRateLimitWaits(attempts: Trace[], maxAttempts: number): string[] {
  const problems: string[] = [];
  if (attempts.length > maxAttempts) problems.push(`${attempts.length} attempts, more than ${maxAttempts}`);
  attempts.forEach((trace, index) => {
    if (trace.status !== 429) return;
    for (const name of RATE_HEADERS) {
      if (header(trace.response_headers, name) === undefined) problems.push(`attempt ${trace.attempt}: the 429 has no ${name}`);
    }
    const retryAfter = header(trace.response_headers, "retry-after");
    if (retryAfter !== "1") problems.push(`attempt ${trace.attempt}: retry-after ${JSON.stringify(retryAfter)}, expected "1"`);
    const next = attempts[index + 1];
    if (next === undefined || retryAfter === undefined || !/^\d+$/.test(retryAfter)) return;
    const waitMs = (next.t_recv_ns - trace.t_resp_end_ns) / 1e6;
    const target = Number(retryAfter) * 1000;
    if (waitMs < target - WAIT_BELOW_MS || waitMs > target + WAIT_ABOVE_MS) {
      problems.push(`attempt ${next.attempt} came ${waitMs.toFixed(1)} ms after the 429, outside [${target - WAIT_BELOW_MS}, ${target + WAIT_ABOVE_MS}] ms`);
    }
  });
  return problems;
}

export function checkRateLimits(ir: IR, ids: string[], surfaces: string[], traces: Trace[]): Failure[] {
  const maxAttempts = Number(ir.policy["max_attempts"]);
  return ids.flatMap((id) => surfaces.flatMap((surface) => checkRateLimitWaits(attemptsOf(traces, id, surface), maxAttempts).map((reason) => ({ case: id, surface, reason }))));
}

// C9: the sequence of response statuses of a case is the same on every surface.
export function checkSameStatuses(ids: string[], surfaces: string[], traces: Trace[]): Failure[] {
  const failures: Failure[] = [];
  for (const id of ids) {
    const [first, ...others] = surfaces;
    if (first === undefined) break;
    const reference = attemptsOf(traces, id, first).map((trace) => trace.status);
    for (const surface of others) {
      const statuses = attemptsOf(traces, id, surface).map((trace) => trace.status);
      if (JSON.stringify(statuses) !== JSON.stringify(reference)) {
        failures.push({ case: id, surface, reason: `statuses ${JSON.stringify(statuses)}, ${first} has ${JSON.stringify(reference)}` });
      }
    }
  }
  return failures;
}

export function writeFailures(runDir: string, runner: string, failures: Failure[]): void {
  writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
  for (const failure of failures) process.stdout.write(`${runner}: ${failure.case} ${failure.surface}: ${failure.reason}\n`);
}
