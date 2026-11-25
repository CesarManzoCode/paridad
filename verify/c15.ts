// node verify/c15.ts <run dir>   (make verify C=c15)
// C15 (contract §6, §9, D21): extracts the `paridad …` invocations of the code blocks
// of skill/paridad-resend/SKILL.md and runs each one with bash, `paridad` being the
// CLI (node cli/src/main.ts), from the repository root and against the capture server
// (captures.jsonl, case skill:<line>). Keeps their output in out/skill-<line>.cli.*,
// writes results.jsonl ({"command","exit_code"}), runs `agentskills validate
// skill/paridad-resend` (output in out/validate.*) and writes validate.json
// ({"exit_code"}), and checks that every command of the CLI appears in the skill.
// Exits 0 only if every invocation exits 0, the validator exits 0 and no command is
// missing.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { cliCommands, skillCommands } from "./agents.ts";
import { TEST_KEY } from "./cases.ts";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILL_DIR = "skill/paridad-resend";

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const commands = skillCommands(readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8"));

const server = await startCaptureServer({ port: 0, controlPort: 0, out: join(runDir, "captures.jsonl"), ir });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  RESEND_API_KEY: TEST_KEY,
  RESEND_BASE_URL: `http://127.0.0.1:${server.port}`,
  CI: "1",
  PARIDAD_CLI: join(ROOT, "cli/src/main.ts"),
};
const results: { command: string; exit_code: number | null }[] = [];
try {
  for (const item of commands) {
    const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: "c15", case: `skill:${item.line}`, surface: "cli" }),
    });
    if (session.status !== 200) throw new Error(`session for skill:${item.line}: ${session.status} ${await session.text()}`);
    const script = `paridad() { node "$PARIDAD_CLI" "$@"; }\n${item.command}\n`;
    const result = await runCommand(["bash", "-c", script], { cwd: ROOT, env, out: join(out, `skill-${item.line}.cli`) });
    results.push({ command: item.command, exit_code: result.code });
  }
} finally {
  await server.close();
}
writeFileSync(join(runDir, "results.jsonl"), results.map((line) => `${JSON.stringify(line)}\n`).join(""));

const validate = await runCommand([join(ROOT, ".venv/bin/agentskills"), "validate", SKILL_DIR], { cwd: ROOT, out: join(out, "validate") });
writeFileSync(join(runDir, "validate.json"), `${JSON.stringify({ exit_code: validate.code })}\n`);

const missing = cliCommands(ir.operations).filter((name) => !commands.some((item) => item.command === name || item.command.startsWith(`${name} `)));
writeFileSync(join(runDir, "missing.jsonl"), missing.map((command) => `${JSON.stringify({ command })}\n`).join(""));

const failed = results.filter((line) => line.exit_code !== 0);
for (const line of failed) process.stdout.write(`c15: exit ${line.exit_code}: ${line.command}\n`);
for (const command of missing) process.stdout.write(`c15: the skill never runs ${command}\n`);
if (validate.code !== 0) process.stdout.write(`c15: agentskills validate exited ${validate.code}; see out/validate.stdout|stderr\n`);
process.stdout.write(`c15: invocations=${results.length} failed=${failed.length} missing=${missing.length} validate=${validate.code}\n`);
process.exit(results.length > 0 && failed.length === 0 && missing.length === 0 && validate.code === 0 ? 0 : 1);
