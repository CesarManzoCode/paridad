// node verify/battery.ts   (make battery)
// Runs verify for C1 to C26 in order, going on after a failure, writes
// .paridad/runs/battery.json ({"c1": code, …}) and exits 0 only if every criterion
// exits 0, except C12, which may exit 77 (contract §8, D24).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LAST = 26;

const codes: Record<string, number> = {};
for (let n = 1; n <= LAST; n++) {
  const criterion = `c${n}`;
  process.stdout.write(`battery: ${criterion}\n`);
  const run = spawnSync(process.execPath, [join(ROOT, "verify/run.ts"), criterion], { cwd: ROOT, stdio: "inherit" });
  codes[criterion] = run.status ?? 1;
  process.stdout.write(`battery: ${criterion} exit=${codes[criterion]}\n`);
}

mkdirSync(join(ROOT, ".paridad/runs"), { recursive: true });
writeFileSync(join(ROOT, ".paridad/runs/battery.json"), `${JSON.stringify(codes, null, 2)}\n`);
const passed = Object.entries(codes).every(([criterion, code]) => code === 0 || (criterion === "c12" && code === 77));
process.exit(passed ? 0 : 1);
