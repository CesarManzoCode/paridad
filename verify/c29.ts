// node verify/c29.ts <run dir>   (make verify C=c29)
// C29 (contract §9, D13): runs `make battery` inside
// `systemd-run --user --scope -p MemoryAccounting=yes`. The scope's cgroup disappears
// when its last process exits, so a shell inside the scope runs the battery and then
// copies memory.peak of its own cgroup (/proc/self/cgroup, cgroup v2) to
// <run dir>/memory.peak before exiting. Also copies .paridad/runs/battery.json.
// Prints the peak and the battery exit code, and exits 1 if memory.peak is missing or
// reaches 8 GiB (8 589 934 592 bytes). C29 is not part of `make battery` (C1 to C26).
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
const LIMIT = 8 * 1024 ** 3;

const runDir = process.argv[2]!;
const peakFile = join(runDir, "memory.peak");

const SCRIPT = 'make battery; code=$?; cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/memory.peak" > "$1"; exit $code';
const env = { ...process.env };
for (const name of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS"]) delete env[name];

const battery = await runCommand(
  ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryAccounting=yes", "--", "bash", "-c", SCRIPT, "c29", peakFile],
  { cwd: ROOT, out: join(runDir, "battery"), env },
);
process.stdout.write(`c29: battery exit=${battery.code}\n`);

const batteryJson = join(ROOT, ".paridad/runs/battery.json");
if (existsSync(batteryJson)) copyFileSync(batteryJson, join(runDir, "battery.json"));

const text = existsSync(peakFile) ? readFileSync(peakFile, "utf8").trim() : "";
if (!/^\d+$/.test(text)) {
  process.stdout.write("c29: memory.peak was not read from the scope's cgroup\n");
  process.exit(1);
}
const peak = Number(text);
process.stdout.write(`c29: memory.peak=${peak} bytes (${(peak / 1024 ** 3).toFixed(2)} GiB), limit=${LIMIT}\n`);
process.exit(peak < LIMIT ? 0 : 1);
