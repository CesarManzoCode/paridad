// node verify/c3.ts <run dir>   (make verify C=c3 [SURFACES=ts,python,go])
// C3 (contract §9, §7.2, D08, D31): for every `<operationId>#example` case that the
// official SDK of a language can run (harness/oracle/official-map.json), runs the
// official SDK and the own SDK of that language, one driver at a time, against the
// capture server, and compares their normalized requests (§7.1). A difference is
// justified only by an entry of verify/divergences.json with the same operation,
// language and field. Also checks that verify/oracle-coverage.json lists exactly
// the public methods of each official SDK (Node and Python by introspection, Go
// with `go doc -all`), each with its operationId or a reason.
// Writes captures.jsonl, results.jsonl, differences.jsonl and out/. Exits 1 if
// there is an unjustified difference, a language compares fewer than 60
// operations, or a table is inconsistent.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { loadSpec } from "../generator/src/spec.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { COUNTED_HEADERS } from "../harness/normalize.ts";
import { LANGUAGES, loadOfficialMap, specRefResolves, type Language } from "../harness/oracle/official-map.ts";
import { caseFile, compareCaptures, exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MINIMUM_OPERATIONS = 60;
const DIFFERENCE_FIELDS = ["method", "path", "query", ...COUNTED_HEADERS.map((name) => `header:${name}`), "body"];
const OFFICIAL_SURFACE: Record<Language, string> = { ts: "official-node", python: "official-python", go: "official-go" };

interface Divergence {
  operation: string;
  language: string;
  field: string;
  spec_ref: string;
  reason: string;
}

interface CoverageRow {
  method: string;
  operation: string | null;
  reason: string | null;
}

type Coverage = Record<Language, { methods: CoverageRow[] }>;

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const bin = join(runDir, "bin");

const languages = (process.env["SURFACES"] ?? LANGUAGES.join(",")).split(",").map((name) => name.trim()).filter((name) => name !== "");
const unknown = languages.filter((name) => !(LANGUAGES as readonly string[]).includes(name));
if (languages.length === 0 || unknown.length > 0) {
  process.stderr.write(`c3: SURFACES must name languages among ${LANGUAGES.join(",")}; got ${unknown.join(",") || "(none)"}\n`);
  process.exit(1);
}

const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const operations = new Set(ir.operations.map((op) => op.id));
const officialMap = loadOfficialMap(ROOT);
const coverage = JSON.parse(readFileSync(join(ROOT, "verify/oracle-coverage.json"), "utf8")) as Coverage;
const divergences = JSON.parse(readFileSync(join(ROOT, "verify/divergences.json"), "utf8")) as Divergence[];
const problems: string[] = [];

// The tables: map entries name IR operations, coverage rows have an operation or a
// reason, divergences are specific and their spec_ref resolves in spec/resend.yaml.
for (const [operation, entries] of Object.entries(officialMap.operations)) {
  if (!operations.has(operation)) problems.push(`official-map.json: ${operation} is not an operation of the IR`);
  for (const language of Object.keys(entries)) {
    if (!(LANGUAGES as readonly string[]).includes(language)) problems.push(`official-map.json: ${operation} has unknown language ${language}`);
  }
}
for (const language of LANGUAGES) {
  for (const row of coverage[language]?.methods ?? []) {
    if (row.operation !== null && !operations.has(row.operation)) problems.push(`oracle-coverage.json: ${language} ${row.method} names unknown operation ${row.operation}`);
    if (row.operation === null && (row.reason === null || row.reason.trim() === "")) problems.push(`oracle-coverage.json: ${language} ${row.method} has neither operation nor reason`);
  }
}
const spec = loadSpec(join(ROOT, "spec/resend.yaml"));
for (const entry of divergences) {
  const where = `divergences.json: ${entry.operation} ${entry.language} ${entry.field}`;
  if (!operations.has(entry.operation)) problems.push(`${where}: unknown operation`);
  if (!(LANGUAGES as readonly string[]).includes(entry.language)) problems.push(`${where}: unknown language`);
  if (!DIFFERENCE_FIELDS.includes(entry.field)) problems.push(`${where}: unknown field`);
  if (!specRefResolves(spec.document, entry.spec_ref)) problems.push(`${where}: spec_ref ${entry.spec_ref} does not resolve in spec/resend.yaml`);
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") problems.push(`${where}: no reason`);
}

// Completeness of the coverage table against the methods each SDK exposes.
const goDriver = join(bin, "official-go");
const ownGoDriver = join(bin, "go-driver");
const builds: [string, string][] = [
  ["harness/oracle/official-go", goDriver],
  ["harness/oracle/go", ownGoDriver],
];
for (const [dir, target] of builds) {
  if (!languages.includes("go")) break;
  const build = await runCommand(["go", "build", "-o", target, "."], { cwd: join(ROOT, dir), out: join(out, `build.${caseFile(dir)}`) });
  if (build.code !== 0) {
    process.stderr.write(`c3: building ${dir} failed (exit ${build.code}); see out/build.${caseFile(dir)}.stderr\n`);
    process.exit(1);
  }
}
const enumerate: Record<Language, () => Promise<string[] | null>> = {
  ts: async () => {
    const result = await runCommand([process.execPath, "harness/oracle/official_node.ts", "--methods"], { cwd: ROOT, out: join(out, "methods.official-node") });
    return result.code === 0 ? (JSON.parse(result.stdout) as string[]) : null;
  },
  python: async () => {
    const result = await runCommand([".venv/bin/python", "-I", "harness/oracle/official_python.py", "--methods"], { cwd: ROOT, out: join(out, "methods.official-python") });
    return result.code === 0 ? (JSON.parse(result.stdout) as string[]) : null;
  },
  go: async () => {
    const result = await runCommand(["go", "doc", "-all", "github.com/resend/resend-go/v3"], { cwd: join(ROOT, "harness/oracle/official-go"), out: join(out, "methods.official-go") });
    if (result.code !== 0) return null;
    return [...result.stdout.matchAll(/^func \(\w+ \*?(\w+)\) (\w+)\(/gm)].map((match) => `${match[1]}.${match[2]}`);
  },
};
for (const language of languages as Language[]) {
  const found = await enumerate[language]();
  if (found === null) {
    problems.push(`${language}: enumerating the official SDK methods failed; see out/methods.${OFFICIAL_SURFACE[language]}.stderr`);
    continue;
  }
  const listed = new Set((coverage[language]?.methods ?? []).map((row) => row.method));
  const exposed = new Set(found);
  for (const method of exposed) if (!listed.has(method)) problems.push(`oracle-coverage.json: ${language} method ${method} is not listed`);
  for (const method of listed) if (!exposed.has(method)) problems.push(`oracle-coverage.json: ${language} lists ${method}, which the SDK does not expose`);
}

// The comparison, one driver at a time.
const capturesFile = join(runDir, "captures.jsonl");
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
const baseUrl = `http://127.0.0.1:${server.port}`;
const env: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: TEST_KEY };
const drivers: Record<string, { argv: (input: string) => string[]; env: NodeJS.ProcessEnv }> = {
  ts: { argv: (input) => [process.execPath, "harness/oracle/ts.ts", input], env: { ...env, RESEND_BASE_URL: baseUrl } },
  python: { argv: (input) => ["python3", "-I", "harness/oracle/python_driver.py", input], env: { ...env, RESEND_BASE_URL: baseUrl } },
  go: { argv: (input) => [ownGoDriver, input], env: { ...env, RESEND_BASE_URL: baseUrl } },
  "official-node": { argv: (input) => [process.execPath, "harness/oracle/official_node.ts", input], env: { ...env, RESEND_BASE_URL: baseUrl } },
  "official-python": { argv: (input) => [".venv/bin/python", "-I", "harness/oracle/official_python.py", input], env: { ...env, RESEND_API_URL: baseUrl } },
  "official-go": { argv: (input) => [goDriver, input], env: { ...env, RESEND_BASE_URL: `${baseUrl}/` } },
};

const runs: { case: string; operation: string; language: Language }[] = [];
let failedDrivers = 0;
try {
  for (const item of exampleCases(ir)) {
    for (const language of languages as Language[]) {
      if (officialMap.operations[item.operation]?.[language] === undefined) continue;
      runs.push({ case: item.case, operation: item.operation, language });
      for (const surface of [OFFICIAL_SURFACE[language], language]) {
        const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: "c3", case: item.case, surface }),
        });
        if (session.status !== 200) throw new Error(`capture session for ${item.case} ${surface}: ${session.status} ${await session.text()}`);
        const driver = drivers[surface]!;
        const result = await runCommand(driver.argv(JSON.stringify(item)), { cwd: ROOT, env: driver.env, out: join(out, `${caseFile(item.case)}.${surface}`) });
        let line: unknown;
        try {
          line = JSON.parse(result.stdout.trimEnd().split("\n").pop() ?? "");
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
  }
} finally {
  await server.close();
}

const captures = readFileSync(capturesFile, "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as CaseCapture);
const differences: string[] = [];
let unjustifiedTotal = 0;
const compared: Record<string, Set<string>> = Object.fromEntries(languages.map((language) => [language, new Set<string>()]));
for (const run of runs) {
  compared[run.language]!.add(run.operation);
  const [difference] = compareCaptures([run.case], [OFFICIAL_SURFACE[run.language], run.language], captures);
  if (difference === undefined) continue;
  const unjustified = difference.fields.filter(
    (field) => !divergences.some((entry) => entry.operation === run.operation && entry.language === run.language && entry.field === field),
  );
  if (unjustified.length > 0) unjustifiedTotal += 1;
  differences.push(`${JSON.stringify({ case: run.case, language: run.language, fields: difference.fields, unjustified })}\n`);
}
writeFileSync(join(runDir, "differences.jsonl"), differences.join(""));

for (const problem of problems) process.stdout.write(`c3: ${problem}\n`);
let enough = true;
for (const language of languages) {
  const count = compared[language]!.size;
  if (count < MINIMUM_OPERATIONS) enough = false;
  process.stdout.write(`c3: language=${language} operations-compared=${count} minimum=${MINIMUM_OPERATIONS}\n`);
}
process.stdout.write(`c3: runs=${runs.length} driver-failures=${failedDrivers} differences=${differences.length} table-problems=${problems.length}\n`);
process.stdout.write(`no_justificadas=${unjustifiedTotal}\n`);
process.exit(unjustifiedTotal === 0 && enough && problems.length === 0 ? 0 : 1);
