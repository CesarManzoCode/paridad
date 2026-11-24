// node verify/c10.ts <run dir>   (make verify C=c10 [SURFACES=ts,python,go,cli,mcp])
// C10 (contract §5.3, §9, §9.4): runs the idempotency cases (idem-retry-send,
// idem-retry-batch, idem-invalid-empty, idem-invalid-257) on every surface of
// SURFACES (default: the five) through the fault proxy. Writes scenarios.json,
// captures.jsonl, traces.jsonl, results.jsonl, failures.jsonl and out/; prints
// fallas=<n>. Exits 0 only if every case gives its expected result, every retry of a
// write with a key carries the same Idempotency-Key and body_sha256, and keys of 0
// and 257 characters send no request and give invalid_idempotency_key with the
// message of the policy on every surface.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { TEST_KEY } from "./cases.ts";
import { checkExpected, checkInvalidKeyMessages, IDEMPOTENCY_CASES, runFaultCases, writeFailures } from "./faults.ts";
import { buildGoDriver, driverFailures, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c10");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c10", runDir, out, surfaces);
const ids = Object.keys(IDEMPOTENCY_CASES);

const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const { lines, traces } = await runFaultCases({
  run: "c10",
  ir,
  ids,
  surfaces,
  dir: runDir,
  out,
  results: resultsFile,
  env: { ...process.env, RESEND_API_KEY: TEST_KEY },
  goDriver,
});
const failures = [...checkExpected(ir, IDEMPOTENCY_CASES, surfaces, lines, traces), ...checkInvalidKeyMessages(ir, IDEMPOTENCY_CASES, surfaces, lines)];
writeFailures(runDir, "c10", failures);
process.stdout.write(`c10: surfaces=${surfaces.join(",")} cases=${ids.length} driver-failures=${driverFailures(lines)}\n`);
process.stdout.write(`fallas=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
