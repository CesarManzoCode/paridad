// node verify/c6.ts <run dir>   (make verify C=c6 [SURFACES=ts,python,go,cli,mcp])
// C6 (contract §9, §9.1): runs the 13 cases `error-<status>-<name>` on every surface
// of SURFACES (default: the five) through the fault proxy, which answers every attempt
// with that error, in front of the capture server. Writes scenarios.json,
// captures.jsonl, traces.jsonl, results.jsonl, failures.jsonl and out/; prints
// fallas=<n>. Exits 0 only if every surface shows the forced code and message, the
// CLI exits 1 with error.message on stdout and the MCP answers isError: true with the
// same code.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { TEST_KEY } from "./cases.ts";
import { checkErrorResults, ERROR_TABLE, runErrorBattery } from "./errors.ts";
import { buildGoDriver, driverFailures, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c6");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c6", runDir, out, surfaces);

const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const lines = await runErrorBattery({
  run: "c6",
  ir,
  surfaces,
  dir: runDir,
  out,
  results: resultsFile,
  env: { ...process.env, RESEND_API_KEY: TEST_KEY },
  goDriver,
});
const failures = checkErrorResults(lines, surfaces, out);
writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stdout.write(`c6: ${failure.case} ${failure.surface}: ${failure.reason}\n`);
process.stdout.write(`c6: surfaces=${surfaces.join(",")} cases=${ERROR_TABLE.length} driver-failures=${driverFailures(lines)}\n`);
process.stdout.write(`fallas=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
