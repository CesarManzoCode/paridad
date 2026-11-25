// node verify/c26.ts <run dir>   (make verify C=c26)
// C26 (contract §9): a new local clone of this repository (`git clone` of HEAD, so
// uncommitted changes do not travel) in a temporary directory, where it runs
// `make bootstrap`, `make check`, `git apply verify/c26/add-operation.patch`,
// `make generate` and `make check`, stopping at the first step that fails. Then every
// operationId that the patch adds must appear literally in sdks/typescript,
// sdks/python, sdks/go, cli, mcp and docs of the clone. The temporary directory lives
// under .paridad/tmp/ and not in os.tmpdir(): on this machine /tmp is tmpfs, and the
// clone's node_modules, .venv and caches would count as memory in C29.
// Writes steps.jsonl ({"step","exit_code"}), surfaces.jsonl ({"surface","operation",
// "found"}) and out/. Deletes the temporary directory and exits 0 only if every step
// exits 0 and every operation is found in every surface.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";
import { addedOperationIds, C26_SURFACES } from "./oss.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PATCH = "verify/c26/add-operation.patch";

const STEPS: { name: string; argv: string[] }[] = [
  { name: "bootstrap", argv: ["make", "bootstrap"] },
  { name: "check", argv: ["make", "check"] },
  { name: "apply", argv: ["git", "apply", PATCH] },
  { name: "generate", argv: ["make", "generate"] },
  { name: "check-after-patch", argv: ["make", "check"] },
];

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const stepsFile = join(runDir, "steps.jsonl");
const surfacesFile = join(runDir, "surfaces.jsonl");
writeFileSync(stepsFile, "");
writeFileSync(surfacesFile, "");

// The nested make runs on its own, not as a sub-make of `make verify`.
const env = { ...process.env };
for (const name of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS"]) delete env[name];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes("/node_modules/"))
    .map((entry) => join(entry.parentPath, entry.name));
}

mkdirSync(join(ROOT, ".paridad/tmp"), { recursive: true });
const work = mkdtempSync(join(ROOT, ".paridad/tmp/c26-"));
const clone = join(work, "paridad");
let failed = false;
try {
  const cloned = await runCommand(["git", "clone", "--quiet", ROOT, clone], { cwd: work, out: join(out, "clone"), env });
  appendFileSync(stepsFile, `${JSON.stringify({ step: "clone", exit_code: cloned.code })}\n`);
  process.stdout.write(`c26: clone exit=${cloned.code}\n`);
  failed = cloned.code !== 0;
  for (const { name, argv } of STEPS) {
    if (failed) break;
    const result = await runCommand(argv, { cwd: clone, out: join(out, name), env });
    appendFileSync(stepsFile, `${JSON.stringify({ step: name, exit_code: result.code })}\n`);
    process.stdout.write(`c26: ${name} exit=${result.code}\n`);
    failed = result.code !== 0;
  }

  if (!failed) {
    const operations = addedOperationIds(readFileSync(join(clone, PATCH), "utf8"));
    if (operations.length === 0) {
      process.stdout.write(`c26: ${PATCH} adds no operationId\n`);
      failed = true;
    }
    for (const surface of C26_SURFACES) {
      const texts = filesUnder(join(clone, surface)).map((file) => readFileSync(file, "utf8"));
      for (const operation of operations) {
        const found = texts.some((text) => text.includes(operation));
        appendFileSync(surfacesFile, `${JSON.stringify({ surface, operation, found })}\n`);
        process.stdout.write(`c26: ${surface} ${operation} found=${found}\n`);
        if (!found) failed = true;
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
