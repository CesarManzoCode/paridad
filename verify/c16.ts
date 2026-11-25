// node verify/c16.ts <run dir>   (make verify C=c16)
// C16 (contract §6, §9, D08, D27): runs, with stdout redirected to a file, one command
// of the paridad CLI per operation (case <operationId>#example, arguments from
// examples[0] as the CLI driver builds them) and both sides of every pair of
// verify/official-cli-map.json: `paridad …` and the official `resend …` of
// resend-cli 2.29.0, the latter with a temporary HOME, RESEND_BASE_URL,
// RESEND_API_KEY, RESEND_TELEMETRY_DISABLED=1 and RESEND_NO_UPDATE_NOTIFIER=1. Every
// request goes through the fault proxy, which answers every attempt of a pair with
// `respond` with that error, in front of the capture server. Writes scenarios.json,
// captures.jsonl, traces.jsonl, results.jsonl ({"id","surface","argv","exit_code",
// "stdout_file"}, with stdout_file the file of the compared output from the
// repository root), failures.jsonl and out/<id>.<surface>.stdout|stderr. Exits 0 only
// if every paridad command writes valid JSON and exits 0, or writes JSON with
// error.message and exits 1, and every pair has the same exit code and the same
// top-level keys on both CLIs.
//
// The help of each command of resend-cli 2.29.0 says that, with --json or outside a
// TTY, its errors go as JSON to stderr; paridad writes them to stdout (§5.2). So the
// official output compared is its stdout, or its stderr when stdout is empty.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { startFaultProxy, type Action, type Scenarios } from "../harness/faults/proxy.ts";
import { cliArgv } from "../harness/oracle/cli.ts";
import { caseFile, exampleCases, TEST_KEY } from "./cases.ts";
import { officialMapProblems, outputProblem, readOfficialMap, topLevelKeys } from "./cli-docs-email.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PARIDAD = join(ROOT, "cli/src/main.ts");
const RESEND = join(ROOT, "node_modules/resend-cli/dist/cli.cjs");

interface ResultLine {
  id: string;
  surface: "cli" | "official-cli";
  argv: string[];
  exit_code: number | null;
  stdout_file: string;
}

interface Failure {
  id: string;
  surface: string;
  reason: string;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const pairs = readOfficialMap(readFileSync(join(ROOT, "verify/official-cli-map.json"), "utf8"));
const failures: Failure[] = officialMapProblems(pairs).map((reason) => ({ id: "verify/official-cli-map.json", surface: "-", reason }));

// Every attempt the policy allows answers with the forced error of the pair.
const attempts = Number(ir.policy["max_attempts"]);
const cases: Record<string, Action[]> = {};
for (const pair of pairs) {
  if (pair.respond === undefined) continue;
  const { status, name } = pair.respond;
  const action: Action = { action: "respond", status, body: { statusCode: status, name, message: `Forced by the paridad fault proxy: ${status} ${name}.` } };
  cases[pair.id] = Array.from({ length: attempts }, () => action);
}
const scenarios: Scenarios = { cases };
writeFileSync(join(runDir, "scenarios.json"), `${JSON.stringify(scenarios, null, 2)}\n`);

const results: ResultLine[] = [];
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const home = mkdtempSync(join(tmpdir(), "paridad-c16-home-"));
const files = mkdtempSync(join(tmpdir(), "paridad-c16-files-"));
const capture = await startCaptureServer({ port: 0, controlPort: 0, out: join(runDir, "captures.jsonl"), ir });
try {
  const proxy = await startFaultProxy({ port: 0, controlPort: 0, upstream: `http://127.0.0.1:${capture.port}`, scenarios, out: join(runDir, "traces.jsonl") });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: `http://127.0.0.1:${proxy.port}` };
    const officialEnv: NodeJS.ProcessEnv = {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      RESEND_TELEMETRY_DISABLED: "1",
      RESEND_NO_UPDATE_NOTIFIER: "1",
      // Safety net for rule 7: if a version ignored RESEND_BASE_URL, its HTTPS
      // requests would go to a closed local port instead of the real API.
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://127.0.0.1:9",
    };
    const controlPorts = [capture.controlPort, proxy.controlPort];

    const run = async (id: string, surface: ResultLine["surface"], args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      for (const port of controlPorts) {
        const session = await fetch(`http://127.0.0.1:${port}/__paridad/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: "c16", case: id, surface }),
        });
        if (session.status !== 200) throw new Error(`session for ${id} ${surface} on port ${port}: ${session.status} ${await session.text()}`);
      }
      const prefix = join(out, `${caseFile(id)}.${surface}`);
      const code = await runToFiles([process.execPath, surface === "cli" ? PARIDAD : RESEND, ...args], surface === "cli" ? env : officialEnv, prefix);
      const stdout = readFileSync(`${prefix}.stdout`, "utf8");
      const stderr = readFileSync(`${prefix}.stderr`, "utf8");
      // The file of the output compared, from the repository root: the official
      // errors go to stderr, so its stderr when its stdout is empty.
      const compared = surface === "official-cli" && stdout.trim() === "" ? "stderr" : "stdout";
      const line: ResultLine = {
        id,
        surface,
        argv: [surface === "cli" ? "paridad" : "resend", ...args],
        exit_code: code,
        stdout_file: relative(ROOT, `${prefix}.${compared}`),
      };
      writeFileSync(resultsFile, `${JSON.stringify(line)}\n`, { flag: "a" });
      results.push(line);
      return { code, stdout, stderr };
    };

    for (const item of exampleCases(ir)) {
      const args = cliArgv(ir, item, (name, text) => {
        const path = join(files, `${caseFile(item.case)}-${name}`);
        writeFileSync(path, text);
        return path;
      });
      const result = await run(item.case, "cli", args);
      const problem = outputProblem(result.code, result.stdout);
      if (problem !== null) failures.push({ id: item.case, surface: "cli", reason: problem });
    }

    for (const pair of pairs) {
      const ours = await run(pair.id, "cli", pair.ours);
      const official = await run(pair.id, "official-cli", pair.official);
      const problem = outputProblem(ours.code, ours.stdout);
      if (problem !== null) failures.push({ id: pair.id, surface: "cli", reason: problem });
      if (ours.code !== official.code) failures.push({ id: pair.id, surface: "official-cli", reason: `exit ${official.code}, paridad exits ${ours.code}` });
      const officialText = official.stdout.trim() === "" ? official.stderr : official.stdout;
      const ourKeys = topLevelKeys(ours.stdout);
      const officialKeys = topLevelKeys(officialText);
      if (officialKeys === null) failures.push({ id: pair.id, surface: "official-cli", reason: "no JSON object on stdout or stderr" });
      else if (JSON.stringify(ourKeys) !== JSON.stringify(officialKeys)) {
        failures.push({ id: pair.id, surface: "official-cli", reason: `top-level keys ${JSON.stringify(officialKeys)}, paridad has ${JSON.stringify(ourKeys)}` });
      }
    }
  } finally {
    await proxy.close();
  }
} finally {
  await capture.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(files, { recursive: true, force: true });
}

writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stdout.write(`c16: ${failure.id} ${failure.surface}: ${failure.reason}\n`);
process.stdout.write(`c16: commands=${results.filter((line) => line.surface === "cli").length} pairs=${pairs.length} failures=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);

// Runs a process with stdout and stderr written straight to <prefix>.stdout and
// .stderr (stdout is a file, not a pipe or a TTY) and stdin closed. Asynchronous, so
// the servers of this process keep answering while it runs.
function runToFiles(argv: string[], env: NodeJS.ProcessEnv, prefix: string): Promise<number | null> {
  const stdout = openSync(`${prefix}.stdout`, "w");
  const stderr = openSync(`${prefix}.stderr`, "w");
  return new Promise((done) => {
    let finished = false;
    const finish = (code: number | null, message?: string): void => {
      if (finished) return;
      finished = true;
      closeSync(stdout);
      closeSync(stderr);
      if (message !== undefined) writeFileSync(`${prefix}.stderr`, `${message}\n`, { flag: "a" });
      done(code);
    };
    const child = spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env, stdio: ["ignore", stdout, stderr] });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}
