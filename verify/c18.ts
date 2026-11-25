// node verify/c18.ts <run dir>   (make verify C=c18)
// C18 (contract §9, §10, D11): materializes every included pair of the corpus
// (verify/corpus/materialize.ts) and classifies it twice: `paridad contract-check
// <base> <revision> --json` (exit 0 compatible, 1 breaking) and `oasdiff breaking
// --fail-on ERR` of oasdiff v1.39.0 from tools/go.mod (exit 0 or 1 the same way).
// `go tool -modfile=tools/go.mod` does not work from the root, which has no go.mod, so
// oasdiff runs as `go tool oasdiff` inside tools/. Both use the same matching:
// oasdiff gets --include-path-params, without which it rejects 19 history pairs as
// "duplicate endpoint" (compat/src/rules.ts), and --allow-external-refs=false, so it
// never reads the network. Writes matrix.jsonl ({"pair","kind","ours","base",
// "revision"}, with both files relative to the repository root), failures.jsonl and
// out/<pair>.ours|oasdiff.stdout|stderr. Exits 0 only if both agree on every pair and
// the corpus has at least 85 history and 24 synthetic pairs.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runCommand, type CommandResult } from "./command.ts";
import { corpusPairs, materialize } from "./corpus/materialize.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MIN_HISTORY = 85;
const MIN_SYNTHETIC = 24;

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

function classification(result: CommandResult): "breaking" | "compatible" | null {
  return result.code === 0 ? "compatible" : result.code === 1 ? "breaking" : null;
}

const pairs = corpusPairs();
for (const [kind, minimum] of [["history", MIN_HISTORY], ["synthetic", MIN_SYNTHETIC]] as const) {
  const count = pairs.filter((entry) => entry.kind === kind).length;
  if (count < minimum) failures.push({ pair: "-", reason: `${count} ${kind} pairs, fewer than ${minimum}` });
}

for (const { pair, kind } of pairs) {
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
    ["go", "tool", "oasdiff", "breaking", "--allow-external-refs=false", "--include-path-params", "--fail-on", "ERR", "-f", "json", files.base, files.revision],
    { cwd: join(ROOT, "tools"), out: join(out, `${pair}.oasdiff`) },
  );
  const own = classification(ours);
  const reference = classification(oasdiff);
  if (own === null) failures.push({ pair, reason: `paridad contract-check exited ${ours.code}` });
  if (reference === null) failures.push({ pair, reason: `oasdiff breaking exited ${oasdiff.code}` });
  if (own !== null && reference !== null && own !== reference) failures.push({ pair, reason: `paridad says ${own}, oasdiff says ${reference}` });
  if (own !== null) {
    const line = { pair, kind, ours: own, base: relative(ROOT, files.base), revision: relative(ROOT, files.revision) };
    appendFileSync(matrixFile, `${JSON.stringify(line)}\n`);
  }
}

writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stderr.write(`c18: ${failure.pair}: ${failure.reason}\n`);
process.stdout.write(`c18: ${pairs.length} pairs, failures=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
