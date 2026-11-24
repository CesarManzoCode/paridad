// node verify/run.ts cN   (make verify C=cN [SURFACES=…])
// Deletes and recreates .paridad/runs/cN/, runs verify/cN.ts with that directory
// as its argument and exits with its code: 0 passes, 1 fails, 77 skipped (contract
// §8). Any other code, a missing runner or the anti-hang limit of 30 minutes (D13)
// exits 1; on the limit the whole process group of the runner is killed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIMIT_MS = 30 * 60 * 1000;

async function main(): Promise<number> {
  const criterion = process.argv[2] ?? "";
  if (!/^c[1-9][0-9]*$/.test(criterion)) {
    process.stderr.write("usage: make verify C=cN [SURFACES=ts,python,go,cli,mcp]\n");
    return 1;
  }
  const runDir = join(ROOT, ".paridad/runs", criterion);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const runner = join(ROOT, "verify", `${criterion}.ts`);
  if (!existsSync(runner)) {
    process.stderr.write(`${criterion}: there is no runner verify/${criterion}.ts\n`);
    return 1;
  }

  const child = spawn(process.execPath, [runner, runDir], { cwd: ROOT, stdio: "inherit", detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`${criterion}: anti-hang limit of 30 minutes reached, killing the runner\n`);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }, LIMIT_MS);
  const code = await new Promise<number | null>((done) => {
    child.on("error", (error) => {
      process.stderr.write(`${criterion}: ${error.message}\n`);
      done(null);
    });
    child.on("exit", (exitCode) => done(exitCode));
  });
  clearTimeout(timer);
  if (timedOut || code === null) return 1;
  return code === 0 || code === 1 || code === 77 ? code : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
