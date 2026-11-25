// node verify/c27.ts <run dir>   (make verify C=c27)
// C27 (contract §9): LICENSE, CONTRIBUTING.md, the issue templates of
// .github/ISSUE_TEMPLATE/ and .github/pull_request_template.md exist and are not
// empty, and some step of .github/workflows/ci.yml runs `make check`. Writes
// results.jsonl ({"check","ok"}) and exits 0 only if every check holds.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const FILES = [
  "LICENSE",
  "CONTRIBUTING.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/pull_request_template.md",
];
const CI = ".github/workflows/ci.yml";

interface Workflow {
  jobs?: Record<string, { steps?: { run?: string }[] }>;
}

const runDir = process.argv[2]!;
const results = join(runDir, "results.jsonl");
writeFileSync(results, "");
let failed = 0;

function record(check: string, ok: boolean): void {
  appendFileSync(results, `${JSON.stringify({ check, ok })}\n`);
  process.stdout.write(`c27: ${check} ok=${ok}\n`);
  if (!ok) failed += 1;
}

for (const file of FILES) {
  const path = join(ROOT, file);
  record(`exists ${file}`, existsSync(path) && statSync(path).isFile() && statSync(path).size > 0);
}

let runsCheck = false;
if (existsSync(join(ROOT, CI))) {
  const workflow = parse(readFileSync(join(ROOT, CI), "utf8")) as Workflow;
  runsCheck = Object.values(workflow.jobs ?? {}).some((job) =>
    (job.steps ?? []).some((step) => (step.run ?? "").split("\n").some((line) => line.trim() === "make check")),
  );
}
record(`${CI} runs make check`, runsCheck);

process.stdout.write(`c27: failed=${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
