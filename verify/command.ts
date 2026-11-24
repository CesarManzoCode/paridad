// Runs one process of a criterion and keeps its raw stdout and stderr as
// <out>.stdout and <out>.stderr (contract §8). Asynchronous, so servers that the
// runner hosts in its own process keep answering while the command runs.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandResult {
  // null when the process could not start or ended by a signal.
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(argv: string[], options: { cwd: string; out: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  const [command, ...args] = argv;
  mkdirSync(dirname(options.out), { recursive: true });
  return new Promise((done) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let finished = false;
    const finish = (code: number | null, extra = ""): void => {
      // A process that fails to start may also emit close after error.
      if (finished) return;
      finished = true;
      const result = { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") + extra };
      writeFileSync(`${options.out}.stdout`, result.stdout);
      writeFileSync(`${options.out}.stderr`, result.stderr);
      done(result);
    };
    const child = spawn(command!, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(null, `${error.message}\n`));
    child.on("close", (code) => finish(code));
  });
}
