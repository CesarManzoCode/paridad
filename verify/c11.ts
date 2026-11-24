// node verify/c11.ts <run dir>   (make verify C=c11 [SURFACES=ts,python,go,cli,mcp])
// C11 (contract §5.3, §9, §9.2): runs the ten partial failure cases on every surface
// of SURFACES (default: the five) through the fault proxy, with RESEND_TIMEOUT_MS=1000
// and delays of 2000 ms; paginate-cut walks contacts/list over 5 items in pages of 2.
// Writes scenarios.json, captures.jsonl, traces.jsonl, results.jsonl, failures.jsonl
// and out/; prints fallas=<n>. Exits 0 only if every case gives its expected result
// on every surface, with no repeated write without a key and no duplicated item.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { TEST_KEY } from "./cases.ts";
import { checkExpected, PARTIAL_FAILURES, runFaultCases, writeFailures } from "./faults.ts";
import { buildGoDriver, driverFailures, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c11");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c11", runDir, out, surfaces);
const ids = Object.keys(PARTIAL_FAILURES);

const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const { lines, traces } = await runFaultCases({
  run: "c11",
  ir,
  ids,
  surfaces,
  dir: runDir,
  out,
  results: resultsFile,
  env: { ...process.env, RESEND_API_KEY: TEST_KEY },
  goDriver,
});
const failures = checkExpected(ir, PARTIAL_FAILURES, surfaces, lines, traces);
writeFailures(runDir, "c11", failures);
process.stdout.write(`c11: surfaces=${surfaces.join(",")} cases=${ids.length} driver-failures=${driverFailures(lines)}\n`);
process.stdout.write(`fallas=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
