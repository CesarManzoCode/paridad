// node verify/c1.ts <run dir>   (make verify C=c1)
// C1 (contract §9): runs make generate twice, hashes the generated tree after each
// run (hashes-1.txt, hashes-2.txt), and runs git diff --exit-code and
// git status --porcelain on the generated paths. Passes if both trees are identical
// byte for byte, the diff exits 0 and the status is empty. Raw outputs in out/,
// one {"command","exit_code"} line per command in results.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
// What make generate rewrites (contract §3).
const GENERATED = ["ir/ir.json", "sdks", "cli", "mcp", "skill", "docs"];

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const results = join(runDir, "results.jsonl");
writeFileSync(results, "");
const paths = GENERATED.filter((path) => existsSync(join(ROOT, path)));

async function step(name: string, argv: string[]) {
  const result = await runCommand(argv, { cwd: ROOT, out: join(out, name) });
  appendFileSync(results, `${JSON.stringify({ command: argv.join(" "), exit_code: result.code })}\n`);
  return result;
}

// "<sha256>  <path>" per file (tracked or untracked, not ignored) and the hash of the list.
async function hashTree(name: string): Promise<string | null> {
  const listed = await step(`list-${name}`, ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths]);
  if (listed.code !== 0) return null;
  const files = [...new Set(listed.stdout.split("\n").filter((line) => line !== ""))].sort();
  const lines = files.map((file) => {
    const full = join(ROOT, file);
    const digest = existsSync(full) ? createHash("sha256").update(readFileSync(full)).digest("hex") : "missing";
    return `${digest}  ${file}\n`;
  });
  const text = lines.join("");
  writeFileSync(join(runDir, `hashes-${name}.txt`), text);
  return createHash("sha256").update(text).digest("hex");
}

const first = await step("generate-1", ["make", "generate"]);
const tree1 = await hashTree("1");
const second = await step("generate-2", ["make", "generate"]);
const tree2 = await hashTree("2");
const diff = await step("git-diff", ["git", "diff", "--exit-code", "--", ...paths]);
const status = await step("git-status", ["git", "status", "--porcelain", "--", ...paths]);

const identical = tree1 !== null && tree1 === tree2;
const statusEmpty = status.code === 0 && status.stdout.trim() === "";
process.stdout.write(
  `c1: generate=${first.code},${second.code} tree-1=${tree1} tree-2=${tree2} identical=${identical} git-diff=${diff.code} git-status-lines=${status.stdout.split("\n").filter((line) => line !== "").length}\n`,
);
process.exit(first.code === 0 && second.code === 0 && identical && diff.code === 0 && statusEmpty ? 0 : 1);
