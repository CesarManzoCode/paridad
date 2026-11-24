// The drivers of the five own surfaces and the loop that runs a battery of cases on
// them, one driver at a time, shared by the criteria runners (c5 to c8).
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { caseFile, type Case } from "./cases.ts";
import { runCommand } from "./command.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const ALL_SURFACES = ["ts", "python", "go", "cli", "mcp"];

export interface ResultLine {
  case: string;
  surface: string;
  outcome: "ok" | "error";
  error: { code: unknown; message: unknown; statusCode: unknown } | null;
  items: unknown[] | null;
  exit_code: number | null;
}

// SURFACES of the environment (default: the five); exits 1 when one has no driver.
export function selectedSurfaces(runner: string): string[] {
  const surfaces = (process.env["SURFACES"] ?? ALL_SURFACES.join(",")).split(",").map((surface) => surface.trim()).filter((surface) => surface !== "");
  const unknown = surfaces.filter((surface) => !ALL_SURFACES.includes(surface));
  if (surfaces.length === 0 || unknown.length > 0) {
    process.stderr.write(`${runner}: no driver for surface(s) ${unknown.join(",") || "(none given)"}; available: ${ALL_SURFACES.join(",")}\n`);
    process.exit(1);
  }
  return surfaces;
}

// Builds the Go driver into <run dir>/bin when go is among the surfaces; exits 1 if
// the build fails. Returns the path of the binary.
export async function buildGoDriver(runner: string, runDir: string, out: string, surfaces: string[]): Promise<string> {
  const binary = join(runDir, "bin/go-driver");
  if (!surfaces.includes("go")) return binary;
  const build = await runCommand(["go", "build", "-o", binary, "."], { cwd: join(ROOT, "harness/oracle/go"), out: join(out, "build.go") });
  if (build.code !== 0) {
    process.stderr.write(`${runner}: building the Go driver failed (exit ${build.code}); see out/build.go.stderr\n`);
    process.exit(1);
  }
  return binary;
}

// The command of a driver. The SDK drivers are the surface process, so the runner
// keeps their stdout and stderr as <prefix>.stdout|stderr; the CLI and MCP drivers
// keep those of paridad and of the MCP server there themselves.
export function driverArgv(surface: string, input: string, prefix: string, goDriver: string): string[] {
  switch (surface) {
    case "ts":
      return [process.execPath, "harness/oracle/ts.ts", input];
    case "python":
      return ["python3", "-I", "harness/oracle/python_driver.py", input];
    case "go":
      return [goDriver, input];
    case "cli":
      return [process.execPath, "harness/oracle/cli.ts", input, prefix];
    case "mcp":
      return [process.execPath, "harness/oracle/mcp.ts", input, prefix];
    default:
      throw new Error(`no driver for surface ${surface}`);
  }
}

export interface BatteryOptions {
  run: string;
  cases: Case[];
  surfaces: string[];
  // Directory of the raw output (out/).
  out: string;
  // results.jsonl, appended to.
  results: string;
  env: NodeJS.ProcessEnv;
  // Control ports (capture server, fault proxy) that receive each session.
  controlPorts: number[];
  goDriver: string;
  // Items the capture server serves per page walk of a case (session list_items).
  listItems?: Record<string, number>;
  // Command put before every driver, such as one that enters a network namespace.
  prefix?: string[];
}

// Runs every case on every surface; returns the result lines, with a driver_failed
// error for a driver that printed none.
export async function runBattery(options: BatteryOptions): Promise<ResultLine[]> {
  const lines: ResultLine[] = [];
  for (const item of options.cases) {
    for (const surface of options.surfaces) {
      for (const port of options.controlPorts) {
        const session = await fetch(`http://127.0.0.1:${port}/__paridad/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: options.run, case: item.case, surface, list_items: options.listItems?.[item.case] }),
        });
        if (session.status !== 200) throw new Error(`session for ${item.case} ${surface} on port ${port}: ${session.status} ${await session.text()}`);
      }
      const prefix = join(options.out, `${caseFile(item.case)}.${surface}`);
      const own = surface === "cli" || surface === "mcp";
      const result = await runCommand([...(options.prefix ?? []), ...driverArgv(surface, JSON.stringify(item), prefix, options.goDriver)], {
        cwd: ROOT,
        env: options.env,
        out: own ? `${prefix}.driver` : prefix,
      });
      let line: ResultLine;
      try {
        line = JSON.parse(result.stdout.trimEnd().split("\n").pop() ?? "") as ResultLine;
      } catch {
        line = {
          case: item.case,
          surface,
          outcome: "error",
          error: { code: "driver_failed", message: `driver exited ${result.code} without a result line`, statusCode: null },
          items: null,
          exit_code: null,
        };
      }
      appendFileSync(options.results, `${JSON.stringify(line)}\n`);
      lines.push(line);
    }
  }
  return lines;
}

export function driverFailures(lines: ResultLine[]): number {
  return lines.filter((line) => line.error?.code === "driver_failed").length;
}
