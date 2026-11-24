// node verify/c12.ts <run dir>   (make verify C=c12 [SURFACES=ts,python,go,cli,mcp])
// C12 (contract §9, §9.2, D24): if `sudo -n true` fails, exits 77 (skipped) and does
// nothing else. Otherwise creates the network namespace paridad-c12 joined to the host
// by a veth pair, applies tc netem with loss, latency below the client timeout and
// reordering to the namespace end, and runs the ten cases of §9.2 with the surfaces
// inside the namespace, as the normal user, against the fault proxy and capture
// server outside it. Writes netns.log (the commands and `tc qdisc show`),
// scenarios.json, captures.jsonl, traces.jsonl, results.jsonl, failures.jsonl and out/;
// prints fallas=<n>. Exits 0 only if every case gives the result that C11 expects.
// The namespace is deleted at the end, also on failure or SIGINT/SIGTERM.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { TEST_KEY } from "./cases.ts";
import { checkExpected, PARTIAL_FAILURES, runFaultCases, writeFailures } from "./faults.ts";
import { buildGoDriver, driverFailures, selectedSurfaces } from "./surfaces.ts";

if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("c12: sudo -n true failed; skipped\n");
  process.exit(77);
}

const ROOT = resolve(import.meta.dirname, "..");
const NAMESPACE = "paridad-c12";
const HOST_LINK = "paridad-c12h";
const NAMESPACE_LINK = "paridad-c12n";
const HOST_ADDRESS = "10.231.17.1";
const NAMESPACE_ADDRESS = "10.231.17.2";
// Loss, latency well below RESEND_TIMEOUT_MS=1000 and reordering (needs the delay).
const NETEM = ["delay", "20ms", "5ms", "loss", "random", "1%", "reorder", "10%", "50%"];
// The environment the drivers get inside the namespace; sudo does not pass it on.
const PASSED = ["PATH", "HOME", "USER", "LANG", "RESEND_API_KEY", "RESEND_BASE_URL", "RESEND_TIMEOUT_MS"];

const runDir = process.argv[2]!;
const out = join(runDir, "out");
const log = join(runDir, "netns.log");
writeFileSync(log, "");

function sudo(args: string[], required = true): string {
  const result = spawnSync("sudo", ["-n", ...args], { encoding: "utf8" });
  appendFileSync(log, `$ sudo -n ${args.join(" ")}\n${result.stdout}${result.stderr}exit=${result.status}\n`);
  if (required && result.status !== 0) throw new Error(`sudo -n ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

// Deleting the namespace destroys its end of the pair and with it the host end; the
// second command covers a setup that failed before the move.
function cleanup(): void {
  sudo(["ip", "netns", "delete", NAMESPACE], false);
  sudo(["ip", "link", "delete", HOST_LINK], false);
}

function setup(): void {
  sudo(["ip", "netns", "add", NAMESPACE]);
  sudo(["ip", "link", "add", HOST_LINK, "type", "veth", "peer", "name", NAMESPACE_LINK]);
  sudo(["ip", "link", "set", NAMESPACE_LINK, "netns", NAMESPACE]);
  sudo(["ip", "addr", "add", `${HOST_ADDRESS}/24`, "dev", HOST_LINK]);
  sudo(["ip", "link", "set", HOST_LINK, "up"]);
  sudo(["ip", "netns", "exec", NAMESPACE, "ip", "addr", "add", `${NAMESPACE_ADDRESS}/24`, "dev", NAMESPACE_LINK]);
  sudo(["ip", "netns", "exec", NAMESPACE, "ip", "link", "set", NAMESPACE_LINK, "up"]);
  sudo(["ip", "netns", "exec", NAMESPACE, "ip", "link", "set", "lo", "up"]);
  sudo(["ip", "netns", "exec", NAMESPACE, "tc", "qdisc", "add", "dev", NAMESPACE_LINK, "root", "netem", ...NETEM]);
  sudo(["ip", "netns", "exec", NAMESPACE, "tc", "qdisc", "show", "dev", NAMESPACE_LINK]);
}

// Enters the namespace as root and drops back to the normal user before the driver.
function inNamespace(env: NodeJS.ProcessEnv): string[] {
  const pairs = PASSED.filter((name) => env[name] !== undefined).map((name) => `${name}=${env[name]}`);
  return ["sudo", "-n", "ip", "netns", "exec", NAMESPACE, "setpriv", "--reuid", String(process.getuid!()), "--regid", String(process.getgid!()), "--init-groups", "--", "env", "-i", ...pairs];
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
}

const surfaces = selectedSurfaces("c12");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const goDriver = await buildGoDriver("c12", runDir, out, surfaces);
const ids = Object.keys(PARTIAL_FAILURES);
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");

// A namespace left by a run killed with SIGKILL is removed first.
cleanup();
const run = await (async () => {
  try {
    setup();
    return await runFaultCases({
      run: "c12",
      ir,
      ids,
      surfaces,
      dir: runDir,
      out,
      results: resultsFile,
      env: { ...process.env, RESEND_API_KEY: TEST_KEY },
      goDriver,
      host: HOST_ADDRESS,
      prefix: inNamespace,
    });
  } finally {
    cleanup();
  }
})();
const failures = checkExpected(ir, PARTIAL_FAILURES, surfaces, run.lines, run.traces);
writeFailures(runDir, "c12", failures);
process.stdout.write(`c12: surfaces=${surfaces.join(",")} cases=${ids.length} netem="${NETEM.join(" ")}" driver-failures=${driverFailures(run.lines)}\n`);
process.stdout.write(`fallas=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);
