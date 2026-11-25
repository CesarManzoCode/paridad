// node verify/c20.ts <run dir>   (make verify C=c20)
// C20 (contract §9, §10, D11): for every pair of verify/sdk-pairs.ts whose bump proposed
// by compat/ is not major, builds and tests each project of verify/examples/ against the
// SDK generated from the base (N), then runs the same files, unchanged, against the SDK
// generated from the revision (N+1). Each run gets a copy of the project in a temporary
// directory and its own capture server (harness/capture) loaded with the IR of that side:
// - typescript: node_modules/paridad-resend links to the generated sdks/typescript;
//   `tsc --noEmit -p .`, then `node --test test/notify.test.ts`.
// - python: `.venv/bin/python -m pytest` with the generated sdks/python/src on PYTHONPATH.
// - go: `go mod edit -replace` to the generated sdks/go, then `go test ./...`.
// The examples only use emails/send, emails/get and domains/list; a pair whose base lacks
// one of them, or whose spec the generator rejects, is listed in skipped.jsonl with the
// reason, like the major pairs. Writes results.jsonl ({"pair","language","bump",
// "exit_code"} against N+1), baseline.jsonl (the same against N), skipped.jsonl,
// captures/, out/ and failures.jsonl. Exits 0 only if every run exits 0 and at least one
// pair ran.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Bump } from "../compat/src/semver.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { runCommand } from "./command.ts";
import { materialize } from "./corpus/materialize.ts";
import { propose, sdkPairs, sideGenerator, type Side } from "./sdk-pairs.ts";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = join(ROOT, "verify/examples");
const LANGUAGES = ["typescript", "python", "go"] as const;
type Language = (typeof LANGUAGES)[number];
const OPERATIONS = ["emails/send", "emails/get", "domains/list"];
const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";

interface Failure {
  pair: string;
  reason: string;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
mkdirSync(join(runDir, "captures"), { recursive: true });
const resultsFile = join(runDir, "results.jsonl");
const baselineFile = join(runDir, "baseline.jsonl");
const skippedFile = join(runDir, "skipped.jsonl");
for (const file of [resultsFile, baselineFile, skippedFile]) writeFileSync(file, "");
const failures: Failure[] = [];
const work = mkdtempSync(join(tmpdir(), "paridad-c20-"));

// Copies the project, points it at the SDK of `side` and runs it against a capture
// server of that side; the exit code is the first non-zero one, or 0.
async function runExample(pair: string, label: "n" | "n1", side: Side & { rejected: null }, language: Language): Promise<number | null> {
  const name = `${pair}.${label}.${language}`;
  const project = join(work, "examples", name);
  cpSync(join(EXAMPLES, language), project, { recursive: true });
  const server = await startCaptureServer({ port: 0, controlPort: 0, out: join(runDir, "captures", `${name}.jsonl`), ir: side.ir });
  const env = { ...process.env, RESEND_BASE_URL: `http://127.0.0.1:${server.port}`, RESEND_API_KEY: KEY };
  const steps: string[][] = [];
  let stepEnv: NodeJS.ProcessEnv = env;
  if (language === "typescript") {
    mkdirSync(join(project, "node_modules"), { recursive: true });
    symlinkSync(join(side.dir, "sdks/typescript"), join(project, "node_modules/paridad-resend"), "dir");
    symlinkSync(join(ROOT, "node_modules/@types"), join(project, "node_modules/@types"), "dir");
    steps.push([join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", project], [process.execPath, "--test", "test/notify.test.ts"]);
  } else if (language === "python") {
    stepEnv = { ...env, PYTHONPATH: join(side.dir, "sdks/python/src"), PYTHONDONTWRITEBYTECODE: "1" };
    steps.push([join(ROOT, ".venv/bin/python"), "-m", "pytest", "-q", "-p", "no:cacheprovider", "--rootdir", project, project]);
  } else {
    // The generated module has no dependencies, so the build never needs the network.
    stepEnv = { ...env, GOWORK: "off", GOPROXY: "off" };
    steps.push(["go", "mod", "edit", `-replace=${side.ir.project.go_module}=${join(side.dir, "sdks/go")}`], ["go", "test", "-count=1", "./..."]);
  }
  try {
    for (const [index, step] of steps.entries()) {
      const result = await runCommand(step, { cwd: project, out: join(out, `${name}.${index}`), env: stepEnv });
      if (result.code !== 0) return result.code;
    }
    return 0;
  } finally {
    await server.close();
  }
}

function skip(pair: string, bump: Bump | null, reason: string): void {
  appendFileSync(skippedFile, `${JSON.stringify({ pair, bump, reason })}\n`);
}

async function main(): Promise<void> {
  const generate = sideGenerator(work, out);
  let ran = 0;
  for (const { pair } of sdkPairs()) {
    try {
      const files = materialize(pair);
      const base = await generate(files.base);
      const revision = await generate(files.revision);
      if (base.rejected !== null || revision.rejected !== null) {
        skip(pair, null, (base.rejected ?? revision.rejected)!);
        continue;
      }
      const { proposed } = propose(files.base, files.revision, base.ir, revision.ir);
      if (proposed === "major") {
        skip(pair, proposed, "major bump");
        continue;
      }
      const missing = OPERATIONS.filter((id) => !base.ir.operations.some((op) => op.id === id));
      if (missing.length > 0) {
        skip(pair, proposed, `the base has no ${missing.join(", ")}`);
        continue;
      }
      ran += 1;
      for (const [label, side, file] of [["n", base, baselineFile], ["n1", revision, resultsFile]] as const) {
        const codes = await Promise.all(LANGUAGES.map((language) => runExample(pair, label, side, language)));
        LANGUAGES.forEach((language, index) => {
          const exitCode = codes[index]!;
          appendFileSync(file, `${JSON.stringify({ pair, language, bump: proposed, exit_code: exitCode })}\n`);
          if (exitCode !== 0) failures.push({ pair, reason: `${language} exited ${exitCode} against ${label === "n" ? "N" : "N+1"}` });
        });
      }
    } catch (error) {
      failures.push({ pair, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (ran === 0) failures.push({ pair: "-", reason: "no pair without a major bump ran" });
  process.stdout.write(`c20: ${ran} pairs ran, failures=${failures.length}\n`);
}

try {
  await main();
} catch (error) {
  failures.push({ pair: "-", reason: error instanceof Error ? error.message : String(error) });
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stderr.write(`c20: ${failure.pair}: ${failure.reason}\n`);
process.exit(failures.length === 0 ? 0 : 1);
