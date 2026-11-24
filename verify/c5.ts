// node verify/c5.ts <run dir>   (make verify C=c5 [SURFACES=ts,python,go,cli,mcp])
// C5 (contract §9): starts the capture server, runs every case of the battery (one
// `<operationId>#example` per operation) on every surface of SURFACES (default: the
// five), one driver at a time, and compares the normalized requests per case
// (§7.1). Writes captures.jsonl, results.jsonl (one driver line per run),
// differences.jsonl and out/; prints distintas=<n>. Exits 1 if n > 0, if an
// operation has no case or if a surface has no driver.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { caseFile, compareCaptures, exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ALL_SURFACES = ["ts", "python", "go", "cli", "mcp"];

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const goDriver = join(runDir, "bin/go-driver");
const DRIVERS: Record<string, (input: string) => string[]> = {
  ts: (input) => [process.execPath, "harness/oracle/ts.ts", input],
  python: (input) => ["python3", "-I", "harness/oracle/python_driver.py", input],
  go: (input) => [goDriver, input],
};

const surfaces = (process.env["SURFACES"] ?? ALL_SURFACES.join(",")).split(",").map((surface) => surface.trim()).filter((surface) => surface !== "");
const withoutDriver = surfaces.filter((surface) => DRIVERS[surface] === undefined);
if (surfaces.length === 0 || withoutDriver.length > 0) {
  process.stderr.write(`c5: no driver for surface(s) ${withoutDriver.join(",") || "(none given)"}; available: ${Object.keys(DRIVERS).join(",")}\n`);
  process.exit(1);
}

const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const cases = exampleCases(ir);
const covered = new Set(cases.map((item) => item.operation));
const missing = ir.operations.filter((op) => !covered.has(op.id)).map((op) => op.id);

if (surfaces.includes("go")) {
  const build = await runCommand(["go", "build", "-o", goDriver, "."], { cwd: join(ROOT, "harness/oracle/go"), out: join(out, "build.go") });
  if (build.code !== 0) {
    process.stderr.write(`c5: building the Go driver failed (exit ${build.code}); see out/build.go.stderr\n`);
    process.exit(1);
  }
}

const capturesFile = join(runDir, "captures.jsonl");
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
const env: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` };
let failedDrivers = 0;
try {
  for (const item of cases) {
    for (const surface of surfaces) {
      const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run: "c5", case: item.case, surface }),
      });
      if (session.status !== 200) throw new Error(`capture session for ${item.case} ${surface}: ${session.status} ${await session.text()}`);
      const result = await runCommand(DRIVERS[surface]!(JSON.stringify(item)), { cwd: ROOT, env, out: join(out, `${caseFile(item.case)}.${surface}`) });
      const last = result.stdout.trimEnd().split("\n").pop() ?? "";
      let line: unknown;
      try {
        line = JSON.parse(last);
      } catch {
        // The driver did not print its result line: the run is recorded as failed.
        failedDrivers += 1;
        line = {
          case: item.case,
          surface,
          outcome: "error",
          error: { code: "driver_failed", message: `driver exited ${result.code} without a result line`, statusCode: null },
          items: null,
          exit_code: null,
        };
      }
      appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
    }
  }
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
