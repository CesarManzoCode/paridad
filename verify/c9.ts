// node verify/c9.ts <run dir>   (make verify C=c9 [SURFACES=ts,python,go,cli,mcp])
// C9 (contract §5.3, §9, §9.4): runs the rate limit cases (ratelimit-get,
// ratelimit-post-nokey, ratelimit-exhausted) on every surface of SURFACES (default:
// the five) through the fault proxy, which answers 429 with the four rate limit
// headers and retry-after: 1. Writes scenarios.json, captures.jsonl, traces.jsonl,
// results.jsonl, failures.jsonl and out/; prints fallas=<n>. Exits 0 only if every
// case gives its expected result, every wait after a 429 is within −25 ms and
// +1000 ms of retry-after × 1000, no case has more than 3 attempts and the status
// sequences are the same on every surface.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { TEST_KEY } from "./cases.ts";
import { checkExpected, checkRateLimits, checkSameStatuses, RATE_LIMIT_CASES, runFaultCases, writeFailures } from "./faults.ts";
import { buildGoDriver, driverFailures, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c9");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c9", runDir, out, surfaces);
const ids = Object.keys(RATE_LIMIT_CASES);

const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const { lines, traces } = await runFaultCases({
  run: "c9",
  ir,
  ids,
  surfaces,
  dir: runDir,
  out,
  results: resultsFile,
  env: { ...process.env, RESEND_API_KEY: TEST_KEY },
  goDriver,
});
const failures = [
  ...checkExpected(ir, RATE_LIMIT_CASES, surfaces, lines, traces),
  ...checkRateLimits(ir, ids, surfaces, traces),
  ...checkSameStatuses(ids, surfaces, traces),
];
writeFailures(runDir, "c9", failures);
process.stdout.write(`c9: surfaces=${surfaces.join(",")} cases=${ids.length} driver-failures=${driverFailures(lines)}\n`);
process.stdout.write(`fallas=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
