// node verify/c5.ts <run dir>   (make verify C=c5 [SURFACES=ts,python,go,cli,mcp])
// C5 (contract §9): starts the capture server, runs every case of the battery (one
// `<operationId>#example` per operation) on every surface of SURFACES (default: the
// five), one driver at a time, and compares the normalized requests per case
// (§7.1). Writes captures.jsonl, results.jsonl (one driver line per run),
// differences.jsonl and out/; prints distintas=<n>. Exits 1 if n > 0, if an
// operation has no case or if a surface has no driver.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { compareCaptures, exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";
import { buildGoDriver, driverFailures, runBattery, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c5");

const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const cases = exampleCases(ir);
const covered = new Set(cases.map((item) => item.operation));
const missing = ir.operations.filter((op) => !covered.has(op.id)).map((op) => op.id);
const goDriver = await buildGoDriver("c5", runDir, out, surfaces);

const capturesFile = join(runDir, "captures.jsonl");
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
let failedDrivers: number;
try {
  const lines = await runBattery({
    run: "c5",
    cases,
    surfaces,
    out,
    results: resultsFile,
    env: { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` },
    controlPorts: [server.controlPort],
    goDriver,
  });
  failedDrivers = driverFailures(lines);
} finally {
  await server.close();
}

const captures = readFileSync(capturesFile, "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as CaseCapture);
const differing = compareCaptures(
  cases.map((item) => item.case),
  surfaces,
  captures,
);
writeFileSync(join(runDir, "differences.jsonl"), differing.map((difference) => `${JSON.stringify(difference)}\n`).join(""));
for (const id of missing) process.stdout.write(`c5: operation without a case: ${id}\n`);
process.stdout.write(`c5: surfaces=${surfaces.join(",")} cases=${cases.length} driver-failures=${failedDrivers} operations-without-case=${missing.length}\n`);
process.stdout.write(`distintas=${differing.length}\n`);
process.exit(differing.length === 0 && missing.length === 0 ? 0 : 1);
