// CLI of paridad (vault/CONTRACT.md §5, §6, D27): argument parsing, the output
// contract, `config show`, `contract-check` and React Email loading. Static template
// copied by the generator; the commands come from the IR (commands.ts) and each one
// calls its method of the TypeScript SDK (paridad-resend).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { FunctionComponent } from "react";
import { ParidadError, Resend, type ClientOptions } from "paridad-resend";
import { COMMANDS, USER_AGENT } from "./commands.ts";

const DEFAULT_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 30000;
// compat/ implements `paridad contract-check`; the CLI only delegates to it.
const COMPAT_MAIN = resolve(import.meta.dirname, "../../compat/src/main.ts");

// How the text of a flag becomes a value: `string` as is, `json` parsed as JSON,
// `auto` parsed as JSON only when it starts with [ or {, `binary` read from the file it names.
export type FlagKind = "string" | "json" | "auto" | "binary";

export interface Flag {
  flag: string;
  name: string;
  kind: FlagKind;
  required: boolean;
  description: string | null;
}

export interface Command {
  operationId: string;
  resource: string;
  action: string;
  summary: string | null;
  method: string;
  path: string;
  // Resource property and method of the SDK client.
  sdk: [string, string];
  pathParams: Flag[];
  queryParams: Flag[];
  // Header parameters other than Idempotency-Key.
  headerParams: Flag[];
  // Flags of the top-level body properties; null when the operation has no body.
  body: { flags: Flag[] } | null;
  idempotency: boolean;
  paginated: boolean;
  react: boolean;
}

export interface IO {
  env: Record<string, string | undefined>;
  // Whether stdout is a terminal.
  isTTY: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// An error of the CLI itself (arguments, files), shown like an error of the SDK.
class UsageError extends Error {}

// Runs `paridad <argv>` and returns the exit code: 0 on success, 1 on error.
export async function run(argv: string[], io: IO): Promise<number> {
  const json = io.isTTY === false || io.env["CI"] !== undefined || argv.includes("--json");
  try {
    const [first, second] = argv;
    if (first === undefined || first === "--help" || first === "-h" || first === "help") {
      io.stdout(usage());
      return 0;
    }
    if (first === "config" && second === "show") return configShow(argv.slice(2), io, json);
    if (first === "contract-check") return contractCheck(argv.slice(1), io, json);
    const command = COMMANDS.find((candidate) => candidate.resource === first && candidate.action === second);
    if (command === undefined) throw new UsageError(`Unknown command: paridad ${argv.slice(0, 2).join(" ")}. Run paridad --help for the list of commands.`);
    return await execute(command, argv.slice(2), io, json);
  } catch (error) {
    return fail(io, json, error);
  }
}

async function execute(command: Command, args: string[], io: IO, json: boolean): Promise<number> {
  const { values } = parse(args, commandOptions(command));
  if (values["help"] === true) {
    io.stdout(commandUsage(command));
    return 0;
  }
  const text = (flag: string): string | undefined => {
    const value = values[flag];
    return typeof value === "string" ? value : undefined;
  };

  const pathArgs = command.pathParams.map((flag) => {
    const value = text(flag.flag);
    if (value === undefined) throw new UsageError(`Missing required flag --${flag.flag}.`);
    return value;
  });
  const query: Record<string, unknown> = {};
  for (const flag of command.queryParams) {
    const value = text(flag.flag);
    if (value === undefined) {
      if (flag.required) throw new UsageError(`Missing required flag --${flag.flag}.`);
      continue;
    }
    query[flag.name] = flagValue(flag, value);
  }
  const headers: Record<string, unknown> = {};
  for (const flag of command.headerParams) {
    const value = text(flag.flag);
    if (value !== undefined) headers[flag.name] = flagValue(flag, value);
  }
  let body: unknown;
  if (command.body !== null) {
    const whole = text("body");
    body = whole === undefined ? {} : parseJson(whole, "--body");
    const properties: Record<string, unknown> = {};
    for (const flag of command.body.flags) {
      const value = text(flag.flag);
      if (value !== undefined) properties[flag.name] = flagValue(flag, value);
    }
    if (Object.keys(properties).length > 0) {
      if (!isRecord(body)) throw new UsageError("Body flags need --body to be a JSON object.");
      body = { ...body, ...properties };
    }
    const react = text("react");
    if (react !== undefined) {
      if (!isRecord(body)) throw new UsageError("--react needs --body to be a JSON object.");
      const props = text("react-props");
      body = { ...body, html: await renderTemplate(react, props === undefined ? {} : parseJson(props, "--react-props")) };
    }
  }

  const options: ClientOptions = { userAgentSuffix: "cli" };
  const baseUrl = io.env["RESEND_BASE_URL"];
  if (baseUrl !== undefined && baseUrl !== "") options.baseUrl = baseUrl;
  const timeout = text("timeout-ms") ?? io.env["RESEND_TIMEOUT_MS"];
  if (timeout !== undefined && timeout !== "") options.timeoutMs = Number(timeout);
  const apiKey = io.env["RESEND_API_KEY"];
  let client: Resend;
  try {
    client = new Resend(apiKey === "" ? undefined : apiKey, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw apiKey === undefined || apiKey === "" ? new ParidadError("missing_api_key", message, null) : new UsageError(message);
  }
  const resource = (client as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[command.sdk[0]]!;

  if (values["all"] === true) {
    const items: unknown[] = [];
    // A failed page is thrown as ParidadError and printed by run().
    for await (const item of resource[`${command.sdk[1]}All`]!.call(resource, ...pathArgs, query) as AsyncIterable<unknown>) items.push(item);
    return succeed(io, { object: "list", has_more: false, data: items });
  }
  const call: unknown[] = [...pathArgs];
  if (command.body !== null) call.push(body);
  if (command.queryParams.length > 0) call.push(query);
  if (command.idempotency) {
    const key = text("idempotency-key");
    // An empty key is still a key: the SDK rejects it like any key out of range.
    call.push(key === undefined ? undefined : { idempotencyKey: key });
  }
  if (command.headerParams.length > 0) {
    // The SDK method takes its options (Idempotency-Key) before the headers.
    if (!command.idempotency) call.push(undefined);
    call.push(headers);
  }
  const result = (await resource[command.sdk[1]]!.call(resource, ...call)) as { data: unknown; error: ParidadError | null };
  if (result.error !== null) return fail(io, json, result.error);
  return succeed(io, result.data);
}

function commandOptions(command: Command): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "timeout-ms": { type: "string" },
  };
  for (const flag of [...command.pathParams, ...command.queryParams, ...command.headerParams, ...(command.body?.flags ?? [])]) options[flag.flag] = { type: "string" };
  if (command.body !== null) options["body"] = { type: "string" };
  if (command.idempotency) options["idempotency-key"] = { type: "string" };
  if (command.paginated) options["all"] = { type: "boolean" };
  if (command.react) {
    options["react"] = { type: "string" };
    options["react-props"] = { type: "string" };
  }
  return options;
}

function parse(args: string[], options: ParseArgsOptionsConfig): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function flagValue(flag: Flag, text: string): unknown {
  switch (flag.kind) {
    case "string":
      return text;
    case "json":
      return parseJson(text, `--${flag.flag}`);
    case "auto":
      return /^\s*[[{]/.test(text) ? parseJson(text, `--${flag.flag}`) : text;
    case "binary":
      try {
        return new Blob([readFileSync(text)]);
      } catch {
        throw new UsageError(`Could not read the file of --${flag.flag}: ${text}`);
      }
  }
}

function parseJson(text: string, flag: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${flag} is not valid JSON.`);
  }
}

// §5.6: the .tsx template is bundled with esbuild (JSX automatic, packages external),
// imported, and its default export rendered with `render` of @react-email/render. The
// bundle is written next to the template so its packages resolve from there.
async function renderTemplate(file: string, props: unknown): Promise<string> {
  const entry = resolve(file);
  if (!existsSync(entry)) throw new UsageError(`The React template does not exist: ${file}`);
  if (!isRecord(props)) throw new UsageError("--react-props is not a JSON object.");
  const { build } = await import("esbuild");
  const output = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", jsx: "automatic", packages: "external", write: false, logLevel: "silent" });
  const bundle = join(dirname(entry), `.${basename(entry)}.${randomUUID()}.mjs`);
  writeFileSync(bundle, output.outputFiles[0]!.contents);
  let component: unknown;
  try {
    component = ((await import(pathToFileURL(bundle).href)) as { default?: unknown }).default;
  } finally {
    rmSync(bundle, { force: true });
  }
  if (typeof component !== "function") throw new UsageError(`The React template has no default export component: ${file}`);
  const { createElement } = await import("react");
  const { render } = await import("@react-email/render");
  return render(createElement(component as FunctionComponent<Record<string, unknown>>, props));
}

// `paridad config show`: the effective configuration, with the key masked (§5.1).
function configShow(args: string[], io: IO, json: boolean): number {
  parse(args, { json: { type: "boolean" } });
  const key = io.env["RESEND_API_KEY"];
  const config = {
    api_key: key === undefined || key === "" ? null : maskKey(key),
    base_url: (io.env["RESEND_BASE_URL"] || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeout_ms: Number(io.env["RESEND_TIMEOUT_MS"] || DEFAULT_TIMEOUT_MS),
    user_agent: USER_AGENT,
    debug: io.env["PARIDAD_DEBUG"] === "1",
  };
  if (json) io.stdout(`${JSON.stringify(config, null, 2)}\n`);
  else io.stdout(Object.entries(config).map(([name, value]) => `${name}: ${value ?? "(not set)"}\n`).join(""));
  return 0;
}

// `paridad contract-check <base> <revision> [--json]` runs compat/, which prints its
// own output and exit code: 0 compatible, 1 breaking, 2 on a usage or loading error.
// Its output is JSON whenever the CLI's is. compat/ lives in the paridad repository,
// not in the published CLI package.
function contractCheck(args: string[], io: IO, json: boolean): number {
  if (!existsSync(COMPAT_MAIN)) {
    return fail(io, json, new ParidadError("compat_missing", `contract-check runs compat/ of the paridad repository, and ${COMPAT_MAIN} does not exist.`, null));
  }
  const forwarded = [...args.filter((arg) => arg !== "--json"), ...(json ? ["--json"] : [])];
  // The report of a pair with many changes can pass the 1 MiB default of spawnSync.
  const child = spawnSync(process.execPath, [COMPAT_MAIN, ...forwarded], { env: io.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  io.stdout(child.stdout ?? "");
  io.stderr(child.stderr ?? "");
  return child.status ?? 1;
}

// The readable form of a response body is the same JSON, indented.
function succeed(io: IO, data: unknown): number {
  io.stdout(`${JSON.stringify(data ?? null, null, 2)}\n`);
  return 0;
}

function fail(io: IO, json: boolean, error: unknown): number {
  const shown =
    error instanceof ParidadError
      ? { message: error.message, code: error.code, statusCode: error.statusCode }
      : { message: error instanceof Error ? error.message : String(error), code: error instanceof UsageError ? "invalid_usage" : "cli_error", statusCode: null };
  if (json) io.stdout(`${JSON.stringify({ error: shown }, null, 2)}\n`);
  else io.stderr(`Error: ${shown.message} (${shown.code}${shown.statusCode === null ? "" : `, ${shown.statusCode}`})\n`);
  return 1;
}

// Same format as the SDK: re_... and the last 4 characters.
function maskKey(key: string): string {
  return `re_...${key.length > 4 ? key.slice(-4) : ""}`;
}

function usage(): string {
  const width = Math.max(...COMMANDS.map((command) => `${command.resource} ${command.action}`.length));
  const lines = COMMANDS.map((command) => `  paridad ${`${command.resource} ${command.action}`.padEnd(width)}  ${command.operationId}${command.summary === null ? "" : `  ${command.summary}`}`);
  return [
    "Usage: paridad <resource> <action> [flags]",
    "",
    "Commands (operationId and summary):",
    ...lines,
    `  paridad ${"config show".padEnd(width)}  effective configuration, with the API key masked`,
    `  paridad ${"contract-check".padEnd(width)}  compare two OpenAPI files: <base.yaml> <revision.yaml> [--json]`,
    "",
    "Configuration: RESEND_API_KEY, RESEND_BASE_URL, RESEND_TIMEOUT_MS; PARIDAD_DEBUG=1 writes each attempt to stderr.",
    "Output: JSON on stdout when stdout is not a terminal, CI is set or --json is given; exit 0 on success, 1 on error.",
    "",
  ].join("\n");
}

function commandUsage(command: Command): string {
  const line = (flag: Flag, value: string): string =>
    `  --${flag.flag} <${value}>${flag.required ? " (required)" : ""}${flag.description === null ? "" : `  ${flag.description}`}`;
  const value = (flag: Flag): string => (flag.kind === "binary" ? "file" : flag.kind === "string" ? "text" : flag.kind);
  const lines = [
    `Usage: paridad ${command.resource} ${command.action} [flags]`,
    "",
    `operationId: ${command.operationId} (${command.method} ${command.path})`,
    ...(command.summary === null ? [] : [command.summary]),
    "",
    "Flags:",
    ...command.pathParams.map((flag) => line(flag, "text")),
    ...command.queryParams.map((flag) => line(flag, value(flag))),
    ...command.headerParams.map((flag) => line(flag, value(flag))),
  ];
  if (command.body !== null) {
    lines.push("  --body <json>  the whole request body; the flags below replace its top-level properties");
    lines.push(...command.body.flags.map((flag) => line(flag, value(flag))));
  }
  if (command.idempotency) lines.push("  --idempotency-key <text>  sent as Idempotency-Key, the same on every attempt (1 to 256 characters)");
  if (command.paginated) lines.push("  --all  every item of every page");
  if (command.react) {
    lines.push("  --react <file.tsx>  React Email template rendered to the html property");
    lines.push("  --react-props <json>  props of the template");
  }
  lines.push("  --timeout-ms <ms>  maximum time of each attempt", "  --json  JSON output", "");
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
