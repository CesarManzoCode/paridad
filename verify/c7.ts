// node verify/c7.ts <run dir>   (make verify C=c7 [SURFACES=ts,python,go,cli,mcp])
// C7 (contract §5.1, §9): runs the parity battery of C5 and the error battery of C6
// with PARIDAD_DEBUG=1 on every surface of SURFACES (default: the five), keeping all
// their output in out/, and runs `paridad config show` to out/config-show.cli.stdout.
// The servers of each battery write to parity/ and errors/. Writes results.jsonl and
// leaks.jsonl (files of out/ that contain the test key); prints fugas=<n>. Exits 0
// only if the key appears 0 times in out/ and config show prints re_... with its last
// 4 characters.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { exampleCases, TEST_KEY } from "./cases.ts";
import { runCommand } from "./command.ts";
import { runErrorBattery } from "./errors.ts";
import { buildGoDriver, driverFailures, runBattery, selectedSurfaces } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const surfaces = selectedSurfaces("c7");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c7", runDir, out, surfaces);
const env: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: TEST_KEY, PARIDAD_DEBUG: "1" };

const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const parityDir = join(runDir, "parity");
const errorsDir = join(runDir, "errors");
mkdirSync(parityDir, { recursive: true });
mkdirSync(errorsDir, { recursive: true });

const server = await startCaptureServer({ port: 0, controlPort: 0, out: join(parityDir, "captures.jsonl"), ir });
let failedDrivers: number;
try {
  const lines = await runBattery({
    run: "c7",
    cases: exampleCases(ir),
    surfaces,
    out,
    results: resultsFile,
    env: { ...env, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` },
    controlPorts: [server.controlPort],
    goDriver,
  });
  failedDrivers = driverFailures(lines);
} finally {
  await server.close();
}
const errorLines = await runErrorBattery({ run: "c7", ir, surfaces, dir: errorsDir, out, results: resultsFile, env, goDriver });
failedDrivers += driverFailures(errorLines);

await runCommand([process.execPath, "cli/src/main.ts", "config", "show"], { cwd: ROOT, env, out: join(out, "config-show.cli") });

// Every file under out/, as bytes, so that no encoding hides an occurrence.
const key = Buffer.from(TEST_KEY);
const leaks: { file: string; count: number }[] = [];
const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
for (const entry of files) {
  const file = join(entry.parentPath, entry.name);
  const bytes = readFileSync(file);
  let count = 0;
  for (let at = bytes.indexOf(key); at !== -1; at = bytes.indexOf(key, at + 1)) count += 1;
  if (count > 0) leaks.push({ file: file.slice(out.length + 1), count });
}
writeFileSync(join(runDir, "leaks.jsonl"), leaks.map((leak) => `${JSON.stringify(leak)}\n`).join(""));
const occurrences = leaks.reduce((sum, leak) => sum + leak.count, 0);

const masked = `re_...${TEST_KEY.slice(-4)}`;
const shown = readFileSync(join(out, "config-show.cli.stdout"), "utf8");
const configOk = shown.includes(masked);
for (const leak of leaks) process.stdout.write(`c7: the test key appears ${leak.count} time(s) in out/${leak.file}\n`);
if (!configOk) process.stdout.write(`c7: config show does not print ${masked}; see out/config-show.cli.stdout\n`);
process.stdout.write(`c7: surfaces=${surfaces.join(",")} files=${files.length} driver-failures=${failedDrivers} config-show-masked=${configOk}\n`);
process.stdout.write(`fugas=${occurrences}\n`);
process.exit(occurrences === 0 && configOk ? 0 : 1);
