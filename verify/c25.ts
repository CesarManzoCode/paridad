// node verify/c25.ts <run dir>   (make verify C=c25)
// C25 (contract §9, §10): for every included pair of the corpus
// (verify/corpus/materialize.ts), runs `paridad contract-check <base> <revision> --json`
// and `oasdiff breaking -f json` of oasdiff v1.39.0 from tools/go.mod (as `go tool
// oasdiff` inside tools/, with --include-path-params and --allow-external-refs=false
// like C18). The exit code must be 1 when oasdiff reports an entry of level 3 (ERR)
// and 0 otherwise; on a breaking pair the affected operations (`MÉTODO /ruta`) must be
// exactly the method and path of the level 3 entries, and each one must list the five
// surfaces and the documentation. Writes matrix.jsonl ({"pair","exit_code",
// "operations","surfaces"}, with surfaces the union over the affected operations),
// failures.jsonl and out/<pair>.ours|oasdiff.stdout|stderr. Exits 0 only if every pair
// agrees.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";
import { corpusPairs, materialize } from "./corpus/materialize.ts";

const ROOT = resolve(import.meta.dirname, "..");
const REQUIRED_SURFACES = ["ts", "python", "go", "cli", "mcp", "docs"];

interface OasdiffEntry {
  level: number;
  operation?: string;
  path?: string;
}

interface OwnReport {
  exitCode: number;
  operations: string[];
  surfaces: { operation: string; surfaces: string[] }[];
}

interface Failure {
  pair: string;
  reason: string;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const matrixFile = join(runDir, "matrix.jsonl");
writeFileSync(matrixFile, "");
const failures: Failure[] = [];

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

const pairs = corpusPairs();
for (const { pair } of pairs) {
  let files: { base: string; revision: string };
  try {
    files = materialize(pair);
  } catch (error) {
    failures.push({ pair, reason: `not materialized: ${error instanceof Error ? error.message : String(error)}` });
    continue;
  }
  const ours = await runCommand([process.execPath, join(ROOT, "cli/src/main.ts"), "contract-check", files.base, files.revision, "--json"], {
    cwd: ROOT,
    out: join(out, `${pair}.ours`),
  });
  const oasdiff = await runCommand(
    ["go", "tool", "oasdiff", "breaking", "--allow-external-refs=false", "--include-path-params", "-f", "json", files.base, files.revision],
    { cwd: join(ROOT, "tools"), out: join(out, `${pair}.oasdiff`) },
  );

  let own: OwnReport;
  let entries: OasdiffEntry[];
  try {
    if (ours.code !== 0 && ours.code !== 1) throw new Error(`paridad contract-check exited ${ours.code}`);
    own = JSON.parse(ours.stdout) as OwnReport;
    if (oasdiff.code !== 0) throw new Error(`oasdiff breaking exited ${oasdiff.code}`);
    // oasdiff prints nothing at all for some formats when there are no changes.
    entries = oasdiff.stdout.trim() === "" ? [] : (JSON.parse(oasdiff.stdout) as OasdiffEntry[]);
  } catch (error) {
    failures.push({ pair, reason: error instanceof Error ? error.message : String(error) });
    continue;
  }

  const errors = entries.filter((entry) => entry.level === 3);
  const expectedOperations = sorted(errors.filter((entry) => entry.path).map((entry) => `${entry.operation} ${entry.path}`));
  const expectedCode = errors.length > 0 ? 1 : 0;
  const surfaces = sorted(own.surfaces.flatMap((entry) => entry.surfaces));
  appendFileSync(matrixFile, `${JSON.stringify({ pair, exit_code: ours.code, operations: own.operations, surfaces })}\n`);

  if (ours.code !== expectedCode) failures.push({ pair, reason: `exit code ${ours.code}, oasdiff has ${errors.length} ERR entries` });
  if (ours.code !== 1 || expectedCode !== 1) continue;
  const operations = sorted(own.operations);
  if (JSON.stringify(operations) !== JSON.stringify(expectedOperations)) {
    const missing = expectedOperations.filter((operation) => !operations.includes(operation));
    const extra = operations.filter((operation) => !expectedOperations.includes(operation));
    failures.push({ pair, reason: `operations differ from the oasdiff ERR entries: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}` });
  }
  for (const operation of own.operations) {
    const listed = own.surfaces.find((entry) => entry.operation === operation)?.surfaces ?? [];
    const absent = REQUIRED_SURFACES.filter((surface) => !listed.includes(surface));
    if (absent.length > 0) failures.push({ pair, reason: `${operation} does not list the surfaces ${absent.join(", ")}` });
  }
}

writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stderr.write(`c25: ${failure.pair}: ${failure.reason}\n`);
process.stdout.write(`c25: ${pairs.length} pairs, failures=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
