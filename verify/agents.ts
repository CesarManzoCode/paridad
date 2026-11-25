// Pieces shared by the runners for agents (C13, C14, C15; contract §9, D21 to D23):
// the reader of the conformance baseline, the corpus of C14 (the example of an
// operation and its invalid variants, as a request of the spec and as tool
// arguments) and the extractor of `paridad …` invocations from the skill.
import { CONTRACT_CHECK } from "../generator/src/emit/skill.ts";
import type { IRExample, IROperation } from "../generator/src/ir.ts";
import { SCHEMAS_REF, isObject, type JsonObject, type JsonSchema } from "../generator/src/spec.ts";

// ---------------------------------------------------------------- C13 baseline

// Scenarios that the baseline may never list (D23).
export const FORBIDDEN_SCENARIOS = ["server-initialize", "ping", "dns-rebinding-protection"];

export interface BaselineEntry {
  scenario: string;
  // Text of the `#` comment on the same line; "" when there is none.
  reason: string;
}

// The entries of the `server:` list, one `- <scenario>  # <reason>` per line.
export function readBaseline(text: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  let inServer = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inServer = /^server:\s*(#.*)?$/.test(line);
    const item = inServer ? /^\s+-\s+([^\s#]+)\s*(?:#\s*(.*))?$/.exec(line) : null;
    if (item !== null) entries.push({ scenario: item[1]!, reason: (item[2] ?? "").trim() });
  }
  return entries;
}

// What is wrong with the baseline: forbidden scenarios, entries without a reason
// and repeated entries.
export function baselineProblems(entries: BaselineEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (FORBIDDEN_SCENARIOS.includes(entry.scenario)) problems.push(`${entry.scenario} may never be an expected failure`);
    if (entry.reason === "") problems.push(`${entry.scenario} has no # reason`);
    if (seen.has(entry.scenario)) problems.push(`${entry.scenario} is listed twice`);
    seen.add(entry.scenario);
  }
  return problems;
}

// ------------------------------------------------------------------ C14 corpus

export interface CorpusExample {
  // "example", or <kind>:<part>[.<name>] with kind missing, type or unknown.
  label: string;
  request: IRExample;
}

const UNKNOWN_PROPERTY = "paridad_unknown";

// The example of the IR and its invalid variants: each required parameter, the body
// and each required top-level body property removed; a value of a type that its
// schema does not allow in each path and query parameter, the body and each body
// property (only where the schema declares `type`); and an unknown query parameter,
// plus an unknown body property when the body schema forbids additional properties.
export function corpusOf(op: IROperation, schemas: Record<string, JsonSchema>): CorpusExample[] {
  const example = op.examples[0];
  if (example === undefined) throw new Error(`${op.id} has no example`);
  const corpus: CorpusExample[] = [{ label: "example", request: example }];
  const variant = (label: string, change: (request: IRExample) => void): void => {
    const request = structuredClone(example);
    change(request);
    corpus.push({ label, request });
  };
  const body = op.requestBody === null ? null : deref(op.requestBody, schemas);
  const bodyObject = isObject(example.body) ? example.body : null;
  const bodyProperties = body !== null && isObject(body["properties"]) ? body["properties"] : {};

  for (const parameter of op.pathParams) variant(`missing:path.${parameter.name}`, (request) => delete request.path[parameter.name]);
  for (const parameter of op.queryParams) {
    if (parameter.required) variant(`missing:query.${parameter.name}`, (request) => delete request.query[parameter.name]);
  }
  for (const parameter of op.headerParams) {
    if (parameter.required) variant(`missing:headers.${parameter.name}`, (request) => delete request.headers[parameter.name]);
  }
  if (op.requestBody !== null) variant("missing:body", (request) => delete (request as Partial<IRExample>).body);
  if (body !== null && bodyObject !== null && Array.isArray(body["required"])) {
    for (const name of body["required"] as string[]) {
      if (name in bodyObject) variant(`missing:body.${name}`, (request) => delete (request.body as JsonObject)[name]);
    }
  }

  const wrongType = (label: string, schema: JsonSchema, set: (request: IRExample, value: unknown) => void): void => {
    const value = wrongValue(deref(schema, schemas));
    if (value !== undefined) variant(label, (request) => set(request, value));
  };
  for (const parameter of op.pathParams) wrongType(`type:path.${parameter.name}`, parameter.schema, (request, value) => (request.path[parameter.name] = value));
  for (const parameter of op.queryParams) {
    if (parameter.name in example.query) wrongType(`type:query.${parameter.name}`, parameter.schema, (request, value) => (request.query[parameter.name] = value));
  }
  if (op.requestBody !== null) wrongType("type:body", op.requestBody, (request, value) => (request.body = value));
  if (bodyObject !== null) {
    for (const [name, schema] of Object.entries(bodyProperties)) {
      if (name in bodyObject) wrongType(`type:body.${name}`, schema as JsonSchema, (request, value) => ((request.body as JsonObject)[name] = value));
    }
  }

  variant("unknown:query", (request) => (request.query[UNKNOWN_PROPERTY] = "paridad"));
  if (body !== null && bodyObject !== null && body["additionalProperties"] === false) {
    variant("unknown:body", (request) => ((request.body as JsonObject)[UNKNOWN_PROPERTY] = "paridad"));
  }
  return corpus;
}

// Values of each JSON type, in the order they are tried.
const TYPED_VALUES: [string[], unknown][] = [
  [["integer", "number"], 12345],
  [["string"], "paridad"],
  [["boolean"], true],
  [["array"], ["paridad"]],
  [["object"], { paridad: true }],
  [["null"], null],
];

// A value whose JSON type the schema does not allow; undefined when the schema
// declares no `type` (its type is decided by oneOf, anyOf, enum or nothing).
function wrongValue(schema: JsonSchema): unknown {
  if (!isObject(schema)) return undefined;
  const declared = schema["type"];
  const allowed = typeof declared === "string" ? [declared] : Array.isArray(declared) ? (declared as string[]) : null;
  if (allowed === null) return undefined;
  const found = TYPED_VALUES.find(([types]) => !types.some((type) => allowed.includes(type)));
  return found === undefined ? undefined : found[1];
}

function deref(schema: JsonSchema, schemas: Record<string, JsonSchema>): JsonObject {
  let current = schema;
  for (let depth = 0; isObject(current) && typeof current["$ref"] === "string" && depth < 32; depth++) {
    const ref = current["$ref"] as string;
    if (!ref.startsWith(SCHEMAS_REF)) throw new Error(`$ref ${ref} does not point into ${SCHEMAS_REF}`);
    current = schemas[ref.slice(SCHEMAS_REF.length)] ?? {};
  }
  return isObject(current) ? current : {};
}

// The tool arguments of a request, as the MCP server takes them (contract §6): path
// and query parameters by name, Idempotency-Key as idempotency_key and the body as
// body. Any other header keeps its name, so a tool without it rejects it.
export function toolArguments(op: IROperation, request: Partial<IRExample>): JsonObject {
  const args: JsonObject = { ...request.path, ...request.query };
  for (const [name, value] of Object.entries(request.headers ?? {})) args[name.toLowerCase() === "idempotency-key" ? "idempotency_key" : name] = value;
  if (op.requestBody !== null && "body" in request) args["body"] = request.body;
  return args;
}

// ------------------------------------------------------------------- C15 skill

export interface SkillCommand {
  // Language of the fenced block ("" when it has none) and 1-based line of the command.
  language: string;
  line: number;
  command: string;
}

// Every `paridad …` invocation of the fenced code blocks of a SKILL.md; a line that
// ends in a backslash continues on the next one.
export function skillCommands(markdown: string): SkillCommand[] {
  const commands: SkillCommand[] = [];
  const lines = markdown.split("\n");
  let language: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^\s*```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      language = language === null ? fence[1]! : null;
      continue;
    }
    if (language === null) continue;
    const start = index;
    let command = line.trim();
    while (command.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      command = `${command.slice(0, -1).trimEnd()} ${lines[index]!.trim()}`;
    }
    if (command === "paridad" || command.startsWith("paridad ")) commands.push({ language, line: start + 1, command });
  }
  return commands;
}

// The commands of the CLI (contract §6): one per operation, config show and
// contract-check, which counts once compat/ (K3) implements it.
export function cliCommands(operations: IROperation[]): string[] {
  return [...operations.map((op) => op.names.cli), "paridad config show", ...(CONTRACT_CHECK ? ["paridad contract-check"] : [])];
}
