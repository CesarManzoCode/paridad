// node verify/c19.ts <run dir>   (make verify C=c19)
// C19 (contract §8, §9, §10, D10, D11): for every pair of verify/sdk-pairs.ts, generates
// the SDKs of both sides in a temporary directory and checks that the bump compat/
// proposes (the maximum of the contract and the SDKs) is never lower than the one each
// external tool requires:
// - oasdiff v1.39.0 (`go tool oasdiff changelog -f json` inside tools/, with the
//   options of C18): an entry of level 3 (ERR) or 2 (WARN) is major, any other entry
//   minor, none patch.
// - api-extractor 7.60.1 on the declarations `tsc` emits from sdks/typescript/src: a
//   line of the old report that is not in the new one (removed or changed) is major,
//   only added lines minor, the same lines patch (D10). Lines count as a multiset.
// - `griffe check` (griffe 2.4.1) of paridad_resend in a temporary git repository with
//   one commit per side: exit 1 (breakages) is major, exit 0 patch.
// - apidiff (from tools/go.mod) on the export data that `apidiff -w` writes in each
//   side's sdks/go: an incompatible change is major, only compatible ones minor.
// Writes matrix.jsonl ({"pair","kind","proposed","raw_dir"}), raw/<pair>/ with
// oasdiff-changelog.json, ts-old.api.md, ts-new.api.md, griffe.txt, griffe.exit and
// apidiff.txt (§8), bumps.jsonl (every bump per pair), excluded.jsonl (history pairs
// whose spec the generator rejects), failures.jsonl and out/. Exits 0 only if no pair
// fails and at least 30 history and 24 synthetic pairs were compared.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { maxBump, type Bump } from "../compat/src/semver.ts";
import { runCommand, type CommandResult } from "./command.ts";
import { materialize } from "./corpus/materialize.ts";
import { propose, sdkPairs, sideGenerator, type Side } from "./sdk-pairs.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MIN_HISTORY = 30;
const MIN_SYNTHETIC = 24;
const TSC = join(ROOT, "node_modules/.bin/tsc");
const API_EXTRACTOR = join(ROOT, "node_modules/.bin/api-extractor");
const GRIFFE = join(ROOT, ".venv/bin/griffe");
// The generated Go module has no dependencies, so it never needs the network.
const GO_ENV = { ...process.env, GOWORK: "off", GOPROXY: "off" };
const GIT = ["-c", "user.name=paridad", "-c", "user.email=paridad@localhost", "-c", "commit.gpgsign=false"];

interface Failure {
  pair: string;
  reason: string;
}

// What the tools need from one side, built once per distinct spec.
interface Artifacts {
  report: string;
  goExport: string;
  python: string;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const matrixFile = join(runDir, "matrix.jsonl");
const bumpsFile = join(runDir, "bumps.jsonl");
const excludedFile = join(runDir, "excluded.jsonl");
for (const file of [matrixFile, bumpsFile, excludedFile]) writeFileSync(file, "");
const failures: Failure[] = [];
const work = mkdtempSync(join(tmpdir(), "paridad-c19-"));

function check(result: CommandResult, what: string, ok: number[] = [0]): CommandResult {
  if (result.code === null || !ok.includes(result.code)) throw new Error(`${what} exited ${result.code}: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return result;
}

const artifacts = new Map<string, Artifacts>();
async function sideArtifacts(side: Side & { rejected: null }, apidiff: string): Promise<Artifacts> {
  const known = artifacts.get(side.dir);
  if (known !== undefined) return known;
  const name = relative(work, side.dir).replaceAll("/", "_");
  const ts = join(side.dir, "sdks/typescript");
  writeFileSync(
    join(ts, "tsconfig.declarations.json"),
    `${JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: "./dts", rootDir: "./src", typeRoots: [join(ROOT, "node_modules/@types")] },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  check(await runCommand([TSC, "-p", join(ts, "tsconfig.declarations.json")], { cwd: ts, out: join(out, `${name}.tsc`) }), "tsc");
  mkdirSync(join(ts, "report"), { recursive: true });
  writeFileSync(
    join(ts, "api-extractor.json"),
    `${JSON.stringify(
      {
        $schema: "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
        projectFolder: ts,
        mainEntryPointFilePath: join(ts, "dts/index.d.ts"),
        compiler: {
          overrideTsconfig: {
            compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext", allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, types: [] },
            files: [join(ts, "dts/index.d.ts")],
          },
        },
        apiReport: { enabled: true, reportFolder: join(ts, "report"), reportTempFolder: join(ts, "report-temp"), reportFileName: "ts" },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  check(await runCommand([API_EXTRACTOR, "run", "--local", "-c", join(ts, "api-extractor.json")], { cwd: ts, out: join(out, `${name}.api-extractor`) }), "api-extractor");
  const goExport = join(side.dir, "go.export");
  const go = join(side.dir, "sdks/go");
  check(await runCommand([apidiff, "-w", goExport, side.ir.project.go_module], { cwd: go, out: join(out, `${name}.apidiff-w`), env: GO_ENV }), "apidiff -w");
  const result = { report: join(ts, "report/ts.api.md"), goExport, python: join(side.dir, "sdks/python/src/paridad_resend") };
  artifacts.set(side.dir, result);
  return result;
}

function oasdiffBump(stdout: string): Bump {
  const entries = stdout.trim() === "" ? [] : (JSON.parse(stdout) as { level: number }[]);
  if (entries.some((entry) => entry.level >= 2)) return "major";
  return entries.length > 0 ? "minor" : "patch";
}

function reportBump(before: string, after: string): Bump {
  const remaining = new Map<string, number>();
  const lines = (text: string): string[] => text.split("\n").map((line) => line.trimEnd());
  for (const line of lines(after)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let removed = false;
  for (const line of lines(before)) {
    const count = remaining.get(line) ?? 0;
    if (count === 0) removed = true;
    else remaining.set(line, count - 1);
  }
  if (removed) return "major";
  return [...remaining.values()].some((count) => count > 0) ? "minor" : "patch";
}

function apidiffBump(stdout: string): Bump {
  if (/^Incompatible changes:/m.test(stdout)) return "major";
  return /^Compatible changes:/m.test(stdout) ? "minor" : "patch";
}

async function griffe(pair: string, base: string, revision: string, raw: string): Promise<Bump> {
  const repo = join(work, "griffe", pair);
  const src = join(repo, "src/paridad_resend");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", [...GIT, ...args], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  };
  git("init", "-q");
  cpSync(base, src, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  rmSync(src, { recursive: true, force: true });
  cpSync(revision, src, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "revision");
  const result = await runCommand([GRIFFE, "check", "paridad_resend", "--search", "src", "--against", "HEAD~1", "--base-ref", "HEAD"], {
    cwd: repo,
    out: join(out, `${pair}.griffe`),
  });
  writeFileSync(join(raw, "griffe.txt"), result.stdout + result.stderr);
  writeFileSync(join(raw, "griffe.exit"), `${result.code}\n`);
  check(result, "griffe check", [0, 1]);
  return result.code === 1 ? "major" : "patch";
}

async function main(): Promise<void> {
  const apidiff = check(await runCommand(["go", "tool", "-n", "apidiff"], { cwd: join(ROOT, "tools"), out: join(out, "apidiff-path") }), "go tool -n apidiff").stdout.trim();
  const generate = sideGenerator(work, out);
  const compared = { history: 0, synthetic: 0 };
  for (const { pair, kind } of sdkPairs()) {
    try {
      const files = materialize(pair);
      const base = await generate(files.base);
      const revision = await generate(files.revision);
      if (base.rejected !== null || revision.rejected !== null) {
        const reason = base.rejected ?? revision.rejected;
        if (kind === "synthetic") throw new Error(reason!);
        appendFileSync(excludedFile, `${JSON.stringify({ pair, reason })}\n`);
        continue;
      }
      const raw = join(runDir, "raw", pair);
      mkdirSync(raw, { recursive: true });
      const changelog = check(
        await runCommand(["go", "tool", "oasdiff", "changelog", "--allow-external-refs=false", "--include-path-params", "-f", "json", files.base, files.revision], {
          cwd: join(ROOT, "tools"),
          out: join(out, `${pair}.oasdiff`),
        }),
        "oasdiff changelog",
      );
      writeFileSync(join(raw, "oasdiff-changelog.json"), changelog.stdout);
      const old = await sideArtifacts(base, apidiff);
      const now = await sideArtifacts(revision, apidiff);
      copyFileSync(old.report, join(raw, "ts-old.api.md"));
      copyFileSync(now.report, join(raw, "ts-new.api.md"));
      const griffeBump = await griffe(pair, old.python, now.python, raw);
      const diff = check(await runCommand([apidiff, old.goExport, now.goExport], { cwd: work, out: join(out, `${pair}.apidiff`), env: GO_ENV }), "apidiff");
      writeFileSync(join(raw, "apidiff.txt"), diff.stdout);

      const required = {
        oasdiff: oasdiffBump(changelog.stdout),
        api_extractor: reportBump(readFileSync(old.report, "utf8"), readFileSync(now.report, "utf8")),
        griffe: griffeBump,
        apidiff: apidiffBump(diff.stdout),
      };
      const proposal = propose(files.base, files.revision, base.ir, revision.ir);
      const requiredBump = maxBump(...Object.values(required));
      appendFileSync(matrixFile, `${JSON.stringify({ pair, kind, proposed: proposal.proposed, raw_dir: relative(ROOT, raw) })}\n`);
      appendFileSync(bumpsFile, `${JSON.stringify({ pair, proposed: proposal.proposed, contract: proposal.contract, sdks: proposal.sdks.bumps, required })}\n`);
      writeFileSync(join(raw, "sdk-changes.json"), `${JSON.stringify(proposal.sdks.changes, null, 2)}\n`);
      compared[kind] += 1;
      if (maxBump(proposal.proposed, requiredBump) !== proposal.proposed) {
        const lower = Object.entries(required).filter(([, bump]) => maxBump(proposal.proposed, bump) !== proposal.proposed);
        failures.push({ pair, reason: `proposed ${proposal.proposed}, lower than ${lower.map(([tool, bump]) => `${tool} ${bump}`).join(", ")}` });
      }
    } catch (error) {
      failures.push({ pair, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (compared.history < MIN_HISTORY) failures.push({ pair: "-", reason: `${compared.history} history pairs compared, fewer than ${MIN_HISTORY}` });
  if (compared.synthetic < MIN_SYNTHETIC) failures.push({ pair: "-", reason: `${compared.synthetic} synthetic pairs compared, fewer than ${MIN_SYNTHETIC}` });
  process.stdout.write(`c19: ${compared.history} history and ${compared.synthetic} synthetic pairs compared, failures=${failures.length}\n`);
}

try {
  await main();
} catch (error) {
  failures.push({ pair: "-", reason: error instanceof Error ? error.message : String(error) });
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stderr.write(`c19: ${failure.pair}: ${failure.reason}\n`);
process.exit(failures.length === 0 ? 0 : 1);
