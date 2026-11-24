// node harness/oracle/cli.ts '<case JSON>' <out prefix>
// Driver of the paridad CLI (contract §7): translates a neutral case (§8) to the
// arguments of `paridad <resource> <action>`, runs `node cli/src/main.ts` against
// RESEND_BASE_URL with RESEND_API_KEY, keeps its raw stdout and stderr as
// <out prefix>.stdout and .stderr, and prints one results.jsonl line. Run from the
// repository root.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { command, flagText } from "../../generator/src/emit/cli.ts";
import type { IR } from "../../generator/src/ir.ts";
import { isObject } from "../../generator/src/spec.ts";

export interface Case {
  case: string;
  operation: string;
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  idempotency_key: string | null;
  iterate: boolean;
}

// Arguments after `paridad` for a case: path and query parameters as flags, the body
// as flags when each property can be one (a file field as the path that `file`
// returns for its text), otherwise as --body; --idempotency-key when the case has a
// key, even an empty one; --all when the case iterates.
export function cliArgv(ir: IR, item: Case, file: (name: string, text: string) => string): string[] {
  const op = ir.operations.find((candidate) => candidate.id === item.operation);
  if (op === undefined) throw new Error(`unknown operation ${item.operation}`);
  const cmd = command(op, ir.schemas);
  const argv = [cmd.resource, cmd.action];
  for (const flag of cmd.pathParams) argv.push(`--${flag.flag}`, String(item.path[flag.name]));
  for (const flag of cmd.queryParams) {
    const value = item.query[flag.name];
    if (value === undefined) continue;
    const text = flagText(flag.kind, value);
    if (text === null) throw new Error(`${op.id}: the case cannot give --${flag.flag}`);
    argv.push(`--${flag.flag}`, text);
  }
  if (cmd.body !== null) {
    const byName = new Map(cmd.body.flags.map((flag) => [flag.name, flag]));
    const body = item.body;
    const pairs =
      isObject(body) && Object.keys(body).length > 0
        ? Object.entries(body).map(([name, value]) => {
            const flag = byName.get(name);
            if (flag === undefined) return null;
            const text = flag.kind === "binary" ? (typeof value === "string" ? file(name, value) : null) : flagText(flag.kind, value);
            return text === null ? null : [`--${flag.flag}`, text];
          })
        : [null];
    if (pairs.every((pair) => pair !== null)) argv.push(...pairs.flat());
    else argv.push("--body", JSON.stringify(body));
  }
  if (cmd.idempotency && item.idempotency_key !== null) argv.push("--idempotency-key", item.idempotency_key);
  if (item.iterate) {
    if (!cmd.paginated) throw new Error(`${op.id} does not paginate`);
    argv.push("--all");
  }
  return argv;
}

function main(): void {
  const item = JSON.parse(process.argv[2] ?? "") as Case;
  const prefix = process.argv[3];
  if (prefix === undefined) throw new Error("usage: cli.ts '<case JSON>' <out prefix>");
  const ir = JSON.parse(readFileSync("ir/ir.json", "utf8")) as IR;
  const child = runCli(ir, item);
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(`${prefix}.stdout`, child.stdout ?? "");
  writeFileSync(`${prefix}.stderr`, child.stderr ?? "");
  if (child.error !== undefined) throw child.error;
  const code = child.status;
  if (code !== 0 && code !== 1) throw new Error(`paridad exited ${code ?? child.signal}; see ${prefix}.stderr`);

  let output: unknown;
  try {
    output = JSON.parse(child.stdout.toString("utf8"));
  } catch {
    throw new Error(`paridad exited ${code} without JSON on stdout; see ${prefix}.stdout`);
  }
  let error: { code: unknown; message: unknown; statusCode: unknown } | null = null;
  if (code === 1) {
    const shown = isObject(output) ? output["error"] : undefined;
    if (!isObject(shown)) throw new Error(`paridad exited 1 without an error object on stdout; see ${prefix}.stdout`);
    error = { code: shown["code"], message: shown["message"], statusCode: shown["statusCode"] ?? null };
  }
  const items = item.iterate && code === 0 && isObject(output) && Array.isArray(output["data"]) ? output["data"] : null;
  const line = { case: item.case, surface: "cli", outcome: error === null ? "ok" : "error", error, items, exit_code: code };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// File fields are written to a temporary directory that lives only while paridad runs.
function runCli(ir: IR, item: Case): SpawnSyncReturns<Buffer> {
  const files = mkdtempSync(join(tmpdir(), "paridad-cli-driver-"));
  try {
    const argv = cliArgv(ir, item, (name, text) => {
      const path = join(files, name);
      writeFileSync(path, text);
      return path;
    });
    return spawnSync(process.execPath, ["cli/src/main.ts", ...argv], { env: process.env, maxBuffer: 256 * 1024 * 1024 });
  } finally {
    rmSync(files, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`cli driver: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
