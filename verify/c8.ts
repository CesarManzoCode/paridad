// node verify/c8.ts <run dir>   (make verify C=c8 [SURFACES=ts,python,go,cli,mcp])
// C8 (contract §9): runs the parity battery of C5 on every surface of SURFACES
// (default: the five) pointed at `prism proxy --errors spec/resend.yaml <capture
// server>`. Writes prism.log (the whole output of Prism), captures.jsonl,
// results.jsonl, violations.txt and out/; prints violaciones=<n> and
// sin-reenviar=<n> (case and surface pairs whose request never reached the capture
// server). Exits 0 only if both are 0.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";
import { forwardedCount, startPrism, violationLines } from "./prism.ts";
import { buildGoDriver, driverFailures, runBattery, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c8");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const cases = exampleCases(ir);
const goDriver = await buildGoDriver("c8", runDir, out, surfaces);

const capturesFile = join(runDir, "captures.jsonl");
const resultsFile = join(runDir, "results.jsonl");
const logFile = join(runDir, "prism.log");
writeFileSync(resultsFile, "");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
let failedDrivers: number;
try {
  const prism = await startPrism(`http://127.0.0.1:${server.port}`, logFile);
  try {
    const lines = await runBattery({
      run: "c8",
      cases,
      surfaces,
      out,
      results: resultsFile,
      env: { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: prism.url },
      controlPorts: [server.controlPort],
      goDriver,
    });
    failedDrivers = driverFailures(lines);
  } finally {
    await prism.stop();
  }
} finally {
  await server.close();
}

const log = readFileSync(logFile, "utf8");
const violations = violationLines(log);
writeFileSync(join(runDir, "violations.txt"), violations.map((line) => `${line}\n`).join(""));
const reached = new Set(
  readFileSync(capturesFile, "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as CaseCapture)
    .map((capture) => `${capture.case}\n${capture.surface}`),
);
const notForwarded = cases.flatMap((item) => surfaces.filter((surface) => !reached.has(`${item.case}\n${surface}`)).map((surface) => `${item.case} ${surface}`));
for (const pair of notForwarded) process.stdout.write(`c8: no request reached the capture server: ${pair}\n`);
process.stdout.write(`c8: surfaces=${surfaces.join(",")} cases=${cases.length} driver-failures=${failedDrivers} forwarded-lines=${forwardedCount(log)}\n`);
process.stdout.write(`violaciones=${violations.length}\n`);
process.stdout.write(`sin-reenviar=${notForwarded.length}\n`);
process.exit(violations.length === 0 && notForwarded.length === 0 ? 0 : 1);
