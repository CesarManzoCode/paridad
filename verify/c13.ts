// node verify/c13.ts <run dir>   (make verify C=c13)
// C13 (contract §9, D22, D23): runs the official conformance framework
// (@modelcontextprotocol/conformance) with verify/mcp-conformance-baseline.yml twice:
// against `node mcp/src/main.ts --transport http` (results in http/) and against the
// stdio server behind the bridge of harness/mcp-bridge (results in stdio/). Keeps the
// output of the framework in out/<transport>.conformance.stdout|stderr and the stderr
// of the servers in out/<transport>.server.stderr, and writes exit.json
// ({"http": code, "stdio": code}). Before running, checks that the baseline lists no
// forbidden scenario and gives a reason for each entry. Exits 0 only if the baseline
// is valid and the framework exits 0 on both transports.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { startBridge } from "../harness/mcp-bridge/bridge.ts";
import { baselineProblems, readBaseline } from "./agents.ts";
import { TEST_KEY } from "./cases.ts";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = join(ROOT, "verify/mcp-conformance-baseline.yml");
const CONFORMANCE = join(ROOT, "node_modules/.bin/conformance");
const MAIN = join(ROOT, "mcp/src/main.ts");
// Time the HTTP server has to print the address it listens on.
const START_TIMEOUT_MS = 30_000;

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });

const problems = baselineProblems(readBaseline(readFileSync(BASELINE, "utf8")));
for (const problem of problems) process.stdout.write(`c13: baseline: ${problem}\n`);

// The framework only calls tools of its own, which do not exist; even so the
// servers point to a closed local port so that nothing can reach the real API.
process.env["RESEND_API_KEY"] = TEST_KEY;
process.env["RESEND_BASE_URL"] = "http://127.0.0.1:1";

function conformance(url: string, transport: string): Promise<number | null> {
  const argv = [CONFORMANCE, "server", "--url", url, "--expected-failures", BASELINE, "-o", join(runDir, transport)];
  return runCommand(argv, { cwd: ROOT, out: join(out, `${transport}.conformance`) }).then((result) => result.code);
}

// Streamable HTTP: the server prints `… listening on http://127.0.0.1:<port>/mcp`.
async function runHttp(): Promise<number | null> {
  const stderrFile = join(out, "http.server.stderr");
  writeFileSync(stderrFile, "");
  const server = spawn(process.execPath, [MAIN, "--transport", "http", "--port", "0"], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string | null>((done) => {
    let seen = "";
    const timer = setTimeout(() => done(null), START_TIMEOUT_MS);
    server.stderr.on("data", (chunk: Buffer) => {
      appendFileSync(stderrFile, chunk);
      seen += chunk.toString("utf8");
      const found = /listening on (http:\/\/\S+)/.exec(seen);
      if (found !== null) {
        clearTimeout(timer);
        done(found[1]!);
      }
    });
    server.on("exit", () => {
      clearTimeout(timer);
      done(null);
    });
  });
  try {
    if (url === null) {
      process.stdout.write("c13: the HTTP server did not start; see out/http.server.stderr\n");
      return null;
    }
    return await conformance(url, "http");
  } finally {
    server.kill();
  }
}

// stdio: each session of the bridge launches its own `--transport stdio` process.
async function runStdio(): Promise<number | null> {
  const stderrFile = join(out, "stdio.server.stderr");
  writeFileSync(stderrFile, "");
  const bridge = await startBridge({
    port: 0,
    command: [process.execPath, MAIN, "--transport", "stdio"],
    stderr: (text) => appendFileSync(stderrFile, text),
  });
  try {
    const { port } = bridge.address() as AddressInfo;
    return await conformance(`http://127.0.0.1:${port}/mcp`, "stdio");
  } finally {
    const closed = new Promise<void>((done) => bridge.close(() => done()));
    bridge.closeAllConnections();
    await closed;
  }
}

const codes = { http: await runHttp(), stdio: await runStdio() };
writeFileSync(join(runDir, "exit.json"), `${JSON.stringify(codes)}\n`);
process.stdout.write(`c13: baseline-problems=${problems.length} http=${codes.http} stdio=${codes.stdio}\n`);
process.exit(problems.length === 0 && codes.http === 0 && codes.stdio === 0 ? 0 : 1);
