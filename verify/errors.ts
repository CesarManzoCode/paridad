// The error battery of C6 (contract §9.1): the 13 named cases `error-<status>-<name>`,
// the fault proxy scenario that answers every attempt of each with that error, the
// run of the battery through the proxy, and the checks of C6 on its results. Shared
// by c6 and c7.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { rateLimitResponse, startFaultProxy, type Action, type Scenarios } from "../harness/faults/proxy.ts";
import { caseFile, type Case } from "./cases.ts";
import { runBattery, type ResultLine } from "./surfaces.ts";

export interface ErrorRow {
  status: number;
  name: string;
}

// The table of §9.1, in its order.
export const ERROR_TABLE: readonly ErrorRow[] = [
  { status: 400, name: "validation_error" },
  { status: 400, name: "invalid_idempotency_key" },
  { status: 401, name: "missing_api_key" },
  { status: 403, name: "restricted_api_key" },
  { status: 404, name: "not_found" },
  { status: 405, name: "method_not_allowed" },
  { status: 409, name: "invalid_idempotent_request" },
  { status: 409, name: "concurrent_idempotent_requests" },
  { status: 422, name: "missing_required_field" },
  { status: 429, name: "rate_limit_exceeded" },
  { status: 429, name: "daily_quota_exceeded" },
  { status: 500, name: "application_error" },
  { status: 503, name: "service_unavailable" },
];

// ratelimit-limit of the forced 429s; the official pages disagree on the default (F-RATE).
export const RATE_LIMIT = 2;
const IDEMPOTENCY_ERRORS = new Set(["invalid_idempotency_key", "invalid_idempotent_request", "concurrent_idempotent_requests"]);

export function errorCaseId(row: ErrorRow): string {
  return `error-${row.status}-${row.name}`;
}

// The message the proxy forces for a row; every surface must show it unchanged.
export function errorMessage(row: ErrorRow): string {
  return `Forced by the paridad fault proxy: ${row.status} ${row.name}.`;
}

// domains/list (GET) with its first example, except the idempotency errors, which
// use emails/send with a key.
export function errorCases(ir: IR): Case[] {
  return ERROR_TABLE.map((row) => {
    const idempotent = IDEMPOTENCY_ERRORS.has(row.name);
    const id = idempotent ? "emails/send" : "domains/list";
    const op = ir.operations.find((candidate) => candidate.id === id);
    const example = op?.examples[0];
    if (example === undefined) throw new Error(`${id} has no example in the IR`);
    return {
      case: errorCaseId(row),
      operation: id,
      path: example.path,
      query: example.query,
      headers: example.headers,
      body: example.body,
      idempotency_key: idempotent ? `c6-${row.name}` : null,
      iterate: false,
    };
  });
}

// Every attempt the policy allows answers with the error of the row; in 429, with the
// four rate limit headers and retry-after: 1.
export function errorScenarios(ir: IR): Scenarios {
  const attempts = Number(ir.policy["max_attempts"]);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("policy.max_attempts is not a positive integer");
  const cases: Record<string, Action[]> = {};
  for (const row of ERROR_TABLE) {
    const body = { statusCode: row.status, name: row.name, message: errorMessage(row) };
    const action: Action =
      row.status === 429
        ? { ...(rateLimitResponse({ limit: RATE_LIMIT, retryAfter: 1 }) as Extract<Action, { action: "respond" }>), body }
        : { action: "respond", status: row.status, body };
    cases[errorCaseId(row)] = Array.from({ length: attempts }, () => action);
  }
  return { cases };
}

export interface ErrorBatteryOptions {
  run: string;
  ir: IR;
  surfaces: string[];
  // Directory of scenarios.json, captures.jsonl and traces.jsonl.
  dir: string;
  out: string;
  results: string;
  env: NodeJS.ProcessEnv;
  goDriver: string;
}

// Surface -> fault proxy -> capture server, with the scenarios of errorScenarios.
export async function runErrorBattery(options: ErrorBatteryOptions): Promise<ResultLine[]> {
  const scenarios = errorScenarios(options.ir);
  writeFileSync(join(options.dir, "scenarios.json"), `${JSON.stringify(scenarios, null, 2)}\n`);
  const capture = await startCaptureServer({ port: 0, controlPort: 0, out: join(options.dir, "captures.jsonl"), ir: options.ir });
  try {
    const proxy = await startFaultProxy({
      port: 0,
      controlPort: 0,
      upstream: `http://127.0.0.1:${capture.port}`,
      scenarios,
      out: join(options.dir, "traces.jsonl"),
    });
    try {
      return await runBattery({
        run: options.run,
        cases: errorCases(options.ir),
        surfaces: options.surfaces,
        out: options.out,
        results: options.results,
        env: { ...options.env, RESEND_BASE_URL: `http://127.0.0.1:${proxy.port}` },
        controlPorts: [capture.controlPort, proxy.controlPort],
        goDriver: options.goDriver,
      });
    } finally {
      await proxy.close();
    }
  } finally {
    await capture.close();
  }
}

export interface ErrorFailure {
  case: string;
  surface: string;
  reason: string;
}

// The checks of C6 on the result lines and the raw output of the CLI and MCP.
export function checkErrorResults(lines: ResultLine[], surfaces: string[], out: string): ErrorFailure[] {
  const failures: ErrorFailure[] = [];
  for (const row of ERROR_TABLE) {
    const id = errorCaseId(row);
    const message = errorMessage(row);
    for (const surface of surfaces) {
      const fail = (reason: string): void => {
        failures.push({ case: id, surface, reason });
      };
      const line = lines.find((candidate) => candidate.case === id && candidate.surface === surface);
      if (line === undefined) {
        fail("no result line");
        continue;
      }
      if (line.outcome !== "error" || line.error === null) fail(`outcome ${line.outcome}, expected error`);
      else {
        if (line.error.code !== row.name) fail(`code ${JSON.stringify(line.error.code)}, expected ${row.name}`);
        if (line.error.message !== message) fail(`message ${JSON.stringify(line.error.message)}, expected ${JSON.stringify(message)}`);
      }
      const prefix = join(out, `${caseFile(id)}.${surface}`);
      if (surface === "cli") {
        if (line.exit_code !== 1) fail(`exit code ${line.exit_code}, expected 1`);
        const shown = readJson(`${prefix}.stdout`);
        if (!isRecord(shown) || !isRecord(shown["error"]) || shown["error"]["message"] !== message) fail("stdout has no error.message with the forced message");
      }
      if (surface === "mcp") {
        const lastLine = existsSync(`${prefix}.json`) ? readFileSync(`${prefix}.json`, "utf8").trimEnd().split("\n").pop()! : "";
        const response = parseJson(lastLine);
        const result = isRecord(response) ? response["result"] : undefined;
        const structured = isRecord(result) ? result["structuredContent"] : undefined;
        if (!isRecord(result) || result["isError"] !== true) fail("the tools/call result has no isError: true");
        else if (!isRecord(structured) || !isRecord(structured["error"]) || structured["error"]["code"] !== row.name) fail(`the tools/call result has no error.code ${row.name}`);
      }
    }
  }
  return failures;
}

function readJson(file: string): unknown {
  return existsSync(file) ? parseJson(readFileSync(file, "utf8")) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
