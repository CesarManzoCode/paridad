// node verify/c4.ts <run dir>   (make verify C=c4)
// C4 (contract §9): strict type checks of the three SDKs, go vet, and their three
// generated test suites. Passes if every command exits 0. Raw outputs in out/, one
// {"command","exit_code"} line per command in results.jsonl.
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");

const COMMANDS: { name: string; cwd: string; argv: string[] }[] = [
  { name: "tsc", cwd: ".", argv: ["node_modules/.bin/tsc", "--strict", "--noEmit", "-p", "sdks/typescript"] },
  { name: "mypy", cwd: ".", argv: [".venv/bin/mypy", "--strict", "sdks/python/src/paridad_resend"] },
  { name: "go-vet", cwd: "sdks/go", argv: ["go", "vet", "./..."] },
  { name: "test-ts", cwd: "sdks/typescript", argv: [process.execPath, "--test", "test/**/*.test.ts"] },
  { name: "test-python", cwd: ".", argv: [".venv/bin/pytest", "sdks/python"] },
  { name: "test-go", cwd: "sdks/go", argv: ["go", "test", "./..."] },
];

const runDir = process.argv[2]!;
const results = join(runDir, "results.jsonl");
writeFileSync(results, "");
let failed = 0;
for (const { name, cwd, argv } of COMMANDS) {
  const result = await runCommand(argv, { cwd: join(ROOT, cwd), out: join(runDir, "out", name) });
  const command = cwd === "." ? argv.join(" ") : `(cd ${cwd} && ${argv.join(" ")})`;
  appendFileSync(results, `${JSON.stringify({ command, exit_code: result.code })}\n`);
  process.stdout.write(`c4: ${name} exit=${result.code}\n`);
  if (result.code !== 0) failed += 1;
}
process.stdout.write(`c4: failed=${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
