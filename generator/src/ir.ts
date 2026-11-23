// Builds the intermediate representation (contract §4) from a loaded spec and
// ir/overlay.yaml, and serializes it with sorted keys.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  SCHEMAS_REF,
  componentSchemas,
  isObject,
  operations,
  resolvePointer,
  type JsonObject,
  type JsonSchema,
  type Pin,
  type Spec,
  type SpecOperation,
  type SpecParameter,
} from "./spec.ts";

export const IR_FORMAT = "paridad-ir/1";

export interface Names {
  ts: string;
  python: string;
  go: string;
  cli: string;
  mcp: string;
}

export interface Pagination {
  style: "cursor";
  limit: "limit";
  after: "after";
  before: "before";
  items: "data";
  hasMore: "has_more";
}

export interface IRParameter {
  name: string;
  required: boolean;
  description: string | null;
  style: string;
  explode: boolean;
  schema: JsonSchema;
}

export interface IRExample {
  path: JsonObject;
  query: JsonObject;
  headers: JsonObject;
  body: unknown;
}

export interface IROperation {
  id: string;
  resource: string;
  action: string;
  method: string;
  path: string;
  tag: string | null;
  summary: string | null;
  pathParams: IRParameter[];
  queryParams: IRParameter[];
  headerParams: IRParameter[];
  requestBody: JsonSchema | null;
  response: { status: number; schema: JsonSchema | null };
  pagination: Pagination | null;
  idempotency: boolean;
  readOnly: boolean;
  destructive: boolean;
  names: Names;
  examples: IRExample[];
}

export interface IRError {
  status: number;
  name: string;
  retryable: boolean;
}

export interface IR {
  format: typeof IR_FORMAT;
  spec: { repository: string | null; commit: string | null; sha256: string; openapi: string; version: string };
  project: { repository: string; go_module: string };
  policy: JsonObject;
  errors: IRError[];
  operations: IROperation[];
  schemas: Record<string, JsonSchema>;
}

export interface OverlayOperation {
  names?: Partial<Names>;
  destructive?: true;
  examples?: Partial<IRExample>[];
}

export interface Overlay {
  project: { repository: string; go_module: string };
  policy: JsonObject;
  errors: { source: string; catalog: { status: number; name: string }[] };
  operations: Record<string, OverlayOperation>;
}

export interface BuildOptions {
  spec: Spec;
  overlay: Overlay;
  // Pinned origin of the spec; null for any other spec (compatibility corpus).
  pin: Pin | null;
  // With --spec, overlay entries for operations the spec lacks are skipped instead of failing.
  ignoreMissingOverlayOperations: boolean;
}

const PAGINATION: Pagination = {
  style: "cursor",
  limit: "limit",
  after: "after",
  before: "before",
  items: "data",
  hasMore: "has_more",
};
const IDEMPOTENCY_HEADER = "idempotency-key";
const OPERATION_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const NAME_KEYS = ["ts", "python", "go", "cli", "mcp"] as const;
const OVERLAY_OPERATION_KEYS = new Set(["names", "destructive", "examples"]);
const EXAMPLE_KEYS = new Set(["path", "query", "headers", "body"]);
const AJV_ID = "urn:paridad:ir";

// Deterministic values for string formats when the schema gives no usable example.
const UUID_EXAMPLE = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const STRING_EXAMPLE = "example";
const FORMAT_EXAMPLES: Record<string, string> = {
  uuid: UUID_EXAMPLE,
  "date-time": "2026-11-24T09:00:00.000Z",
  email: "delivered@resend.dev",
};
const FORMATS: Record<string, RegExp | true> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "date-time":
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/,
  email: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/,
  binary: true,
};

export function loadOverlay(file: string): Overlay {
  return checkOverlay(parse(readFileSync(file, "utf8")), file);
}

export function checkOverlay(value: unknown, source: string): Overlay {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (!isObject(value)) return fail("not a mapping");
  const { project, policy, errors } = value;
  const operations = value["operations"] ?? {};
  if (!isObject(project) || !nonEmpty(project["repository"]) || !nonEmpty(project["go_module"])) {
    return fail("project.repository and project.go_module are required");
  }
  if (!isObject(policy) || !Number.isInteger(policy["max_attempts"])) return fail("policy.max_attempts is required");
  for (const group of ["retry_always", "retry_if_safe"]) {
    const rules = policy[group];
    if (!isObject(rules) || !Array.isArray(rules["responses"])) return fail(`policy.${group}.responses is required`);
  }
  if (!isObject(errors) || !nonEmpty(errors["source"]) || !Array.isArray(errors["catalog"])) {
    return fail("errors.source and errors.catalog are required");
  }
  const catalog = errors["catalog"].map((entry: unknown) => {
    if (!isObject(entry) || !Number.isInteger(entry["status"]) || !nonEmpty(entry["name"])) {
      return fail(`errors.catalog entry ${JSON.stringify(entry)} needs status and name`);
    }
    return { status: entry["status"] as number, name: entry["name"] as string };
  });
  if (!isObject(operations)) return fail("operations is not a mapping");
  return {
    project: { repository: project["repository"] as string, go_module: project["go_module"] as string },
    policy,
    errors: { source: errors["source"] as string, catalog },
    operations: operations as Record<string, OverlayOperation>,
  };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export function buildIR(options: BuildOptions): IR {
  const { spec, overlay, pin } = options;
  if (pin !== null && pin.sha256 !== spec.sha256) {
    throw new Error(`spec: sha256 ${spec.sha256} does not match the pinned ${pin.sha256}`);
  }
  const schemas = componentSchemas(spec);
  const specOperations = operations(spec);
  const byId = new Map<string, SpecOperation>();
  for (const op of specOperations) {
    if (!OPERATION_ID.test(op.operationId)) {
      throw new Error(`spec: operationId ${op.operationId} of ${op.method} ${op.path} is not of the form resource/action`);
    }
    if (byId.has(op.operationId)) throw new Error(`spec: operationId ${op.operationId} is declared twice`);
    byId.set(op.operationId, op);
  }
  for (const [id, entry] of Object.entries(overlay.operations)) {
    if (!byId.has(id)) {
      if (options.ignoreMissingOverlayOperations) continue;
      throw new Error(`overlay: operationId ${id} does not exist in the spec`);
    }
    checkOverlayOperation(id, entry);
  }

  const built = [...byId.values()]
    .sort((a, b) => compare(a.operationId, b.operationId))
    .map((op) => buildOperation(op, overlay.operations[op.operationId] ?? {}, schemas));

  const validate = createValidator(schemas, built);
  const synthesize = createSynthesizer(schemas, validate);
  for (const op of built) {
    const overlayExamples = overlay.operations[op.id]?.examples;
    const source = overlayExamples ? "ir/overlay.yaml" : "synthesized";
    op.examples = overlayExamples ? overlayExamples.map(normalizeExample) : [synthesizeExample(op, synthesize, validate)];
    const requestSchema = requestSchemaOf(op);
    op.examples.forEach((example, index) => {
      const problem = validate(requestSchema, example);
      if (problem !== null) {
        throw new Error(`example ${index} of ${op.id} (${source}) does not validate against its request schema: ${problem}`);
      }
    });
  }

  return {
    format: IR_FORMAT,
    spec: {
      repository: pin?.repository ?? null,
      commit: pin?.commit ?? null,
      sha256: spec.sha256,
      openapi: spec.openapi,
      version: spec.version,
    },
    project: overlay.project,
    policy: overlay.policy,
    errors: overlay.errors.catalog.map(({ status, name }) => ({ status, name, retryable: retryable(overlay.policy, status, name) })),
    operations: built,
    schemas,
  };
}

function checkOverlayOperation(id: string, entry: unknown): void {
  const fail = (message: string): never => {
    throw new Error(`overlay: operations.${id}: ${message}`);
  };
  if (!isObject(entry)) return fail("not a mapping");
  for (const key of Object.keys(entry)) if (!OVERLAY_OPERATION_KEYS.has(key)) fail(`unknown key ${key}`);
  if (entry["destructive"] !== undefined && entry["destructive"] !== true) fail("destructive may only be true");
  const names = entry["names"];
  if (names !== undefined) {
    if (!isObject(names)) return fail("names is not a mapping");
    for (const [key, value] of Object.entries(names)) {
      if (!(NAME_KEYS as readonly string[]).includes(key)) fail(`unknown name key ${key}`);
      if (!nonEmpty(value)) fail(`names.${key} is not a string`);
    }
  }
  const examples = entry["examples"];
  if (examples !== undefined) {
    if (!Array.isArray(examples) || examples.length === 0) return fail("examples is not a non-empty list");
    for (const example of examples) {
      if (!isObject(example)) return fail("an example is not a mapping");
      for (const key of Object.keys(example)) if (!EXAMPLE_KEYS.has(key)) fail(`unknown example key ${key}`);
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildOperation(op: SpecOperation, entry: OverlayOperation, schemas: Record<string, JsonSchema>): IROperation {
  const [resource, action] = op.operationId.split("/") as [string, string];
  const params = (location: SpecParameter["in"]): IRParameter[] =>
    op.parameters
      .filter((parameter) => parameter.in === location)
      .map(({ name, required, description, style, explode, schema }) => ({ name, required, description, style, explode, schema }));
  const pathParams = params("path");
  const templateNames = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  for (const parameter of pathParams) {
    if (!templateNames.includes(parameter.name)) {
      throw new Error(`spec: path parameter ${parameter.name} of ${op.operationId} is not in ${op.path}`);
    }
  }
  for (const name of templateNames) {
    if (!pathParams.some((parameter) => parameter.name === name)) {
      throw new Error(`spec: ${op.path} of ${op.operationId} has no parameter for {${name}}`);
    }
  }
  pathParams.sort((a, b) => templateNames.indexOf(a.name) - templateNames.indexOf(b.name));
  const queryParams = params("query");
  const headerParams = params("header");

  const success = op.responses.filter((response) => response.status >= 200 && response.status < 300).sort((a, b) => a.status - b.status)[0];
  if (success === undefined) throw new Error(`spec: ${op.operationId} has no 2xx response`);

  const queryNames = new Set(queryParams.map((parameter) => parameter.name));
  const paginated =
    op.method === "GET" &&
    ["limit", "after", "before"].every((name) => queryNames.has(name)) &&
    success.schema !== null &&
    ["data", "has_more"].every((name) => propertyNames(success.schema!, schemas).has(name));

  let requestBody: JsonSchema | null = null;
  if (op.requestBody !== null) {
    requestBody = op.requestBody.schema;
    // A non-JSON body keeps its media type as a JSON Schema annotation on the body schema.
    if (op.requestBody.contentType !== "application/json") {
      requestBody = { ...(isObject(requestBody) ? requestBody : {}), contentMediaType: op.requestBody.contentType };
    }
  }

  return {
    id: op.operationId,
    resource,
    action,
    method: op.method,
    path: op.path,
    tag: op.tags[0] ?? null,
    summary: op.summary,
    pathParams,
    queryParams,
    headerParams,
    requestBody,
    response: { status: success.status, schema: success.schema },
    pagination: paginated ? { ...PAGINATION } : null,
    idempotency: headerParams.some((parameter) => parameter.name.toLowerCase() === IDEMPOTENCY_HEADER),
    readOnly: op.method === "GET",
    destructive: op.method === "DELETE" || entry.destructive === true,
    names: { ...derivedNames(resource, action), ...entry.names },
    examples: [],
  };
}

function derivedNames(resource: string, action: string): Names {
  const words = (value: string): string[] => value.split("-");
  const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  const camel = (value: string): string => words(value).map((word, index) => (index === 0 ? word : capital(word))).join("");
  const pascal = (value: string): string => words(value).map(capital).join("");
  const snake = (value: string): string => words(value).join("_");
  return {
    ts: `${camel(resource)}.${camel(action)}`,
    python: `${snake(resource)}.${snake(action)}`,
    go: `${pascal(resource)}.${pascal(action)}`,
    cli: `paridad ${resource} ${action}`,
    mcp: `${resource}_${action}`,
  };
}

// Top-level property names of a schema, following $ref and allOf.
function propertyNames(schema: JsonSchema, schemas: Record<string, JsonSchema>, depth = 0): Set<string> {
  const names = new Set<string>();
  if (!isObject(schema) || depth > 32) return names;
  if (typeof schema["$ref"] === "string") {
    for (const name of propertyNames(resolveSchemaRef(schemas, schema["$ref"]), schemas, depth + 1)) names.add(name);
  }
  if (isObject(schema["properties"])) for (const name of Object.keys(schema["properties"])) names.add(name);
  if (Array.isArray(schema["allOf"])) {
    for (const member of schema["allOf"]) for (const name of propertyNames(member as JsonSchema, schemas, depth + 1)) names.add(name);
  }
  return names;
}

function resolveSchemaRef(schemas: Record<string, JsonSchema>, ref: string): JsonSchema {
  if (!ref.startsWith(SCHEMAS_REF)) throw new Error(`ir: $ref ${ref} does not point into ${SCHEMAS_REF}`);
  const target = resolvePointer({ schemas }, ref);
  if (typeof target === "boolean" || isObject(target)) return target;
  throw new Error(`ir: $ref ${ref} is not a schema`);
}

function retryable(policy: JsonObject, status: number, name: string): boolean {
  return ["retry_always", "retry_if_safe"].some((group) => {
    const rules = policy[group];
    const responses = isObject(rules) && Array.isArray(rules["responses"]) ? rules["responses"] : [];
    return responses.some((rule: unknown) => isObject(rule) && rule["status"] === status && (!("name" in rule) || rule["name"] === name));
  });
}

function normalizeExample(example: Partial<IRExample>): IRExample {
  return {
    path: example.path ?? {},
    query: example.query ?? {},
    headers: example.headers ?? {},
    body: example.body === undefined ? null : example.body,
  };
}

// The request as one instance: {path, query, headers, body}, each part checked against the spec.
function requestSchemaOf(op: IROperation): JsonObject {
  const group = (parameters: IRParameter[]): JsonObject => ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema])),
    required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["path", "query", "headers", "body"],
    properties: {
      path: group(op.pathParams),
      query: group(op.queryParams),
      headers: group(op.headerParams),
      body: op.requestBody ?? { type: "null" },
    },
  };
}

export type Validate = (schema: JsonSchema, value: unknown) => string | null;

export function createValidator(schemas: Record<string, JsonSchema>, built: IROperation[]): Validate {
  const formats: Record<string, RegExp | true> = {};
  collectFormats([schemas, built], formats);
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    formats,
  });
  ajv.addSchema({ $id: AJV_ID, $defs: toAjvRefs(schemas) });
  const cache = new WeakMap<JsonObject, ValidateFunction>();
  return (schema, value) => {
    if (typeof schema === "boolean") return schema ? null : "the schema is false";
    let validate = cache.get(schema);
    if (validate === undefined) {
      validate = ajv.compile(toAjvRefs(schema) as JsonObject);
      cache.set(schema, validate);
    }
    return validate(value) ? null : ajv.errorsText(validate.errors, { dataVar: "example" });
  };
}

// Known formats are checked; any other format found in the schemas is accepted as is.
function collectFormats(value: unknown, formats: Record<string, RegExp | true>): void {
  if (Array.isArray(value)) for (const item of value) collectFormats(item, formats);
  else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "format" && typeof child === "string") formats[child] = FORMATS[child] ?? true;
      else collectFormats(child, formats);
    }
  }
}

function toAjvRefs<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toAjvRefs) as T;
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$ref" && typeof child === "string" && child.startsWith(SCHEMAS_REF)
        ? `${AJV_ID}#/$defs/${child.slice(SCHEMAS_REF.length)}`
        : toAjvRefs(child),
    ]),
  ) as T;
}

function synthesizeExample(op: IROperation, synthesize: (schema: JsonSchema) => unknown, validate: Validate): IRExample {
  const values = (parameters: IRParameter[]): JsonObject =>
    Object.fromEntries(parameters.filter((parameter) => parameter.required).map((parameter) => [parameter.name, synthesize(parameter.schema)]));
  // Path parameters identify a resource, and Resend identifiers are UUIDs: a bare
  // string path parameter gets a UUID instead of the generic string.
  const path = Object.fromEntries(
    op.pathParams.map((parameter) => {
      const value = synthesize(parameter.schema);
      const id = value === STRING_EXAMPLE && validate(parameter.schema, UUID_EXAMPLE) === null;
      return [parameter.name, id ? UUID_EXAMPLE : value];
    }),
  );
  return {
    path,
    query: values(op.queryParams),
    headers: values(op.headerParams),
    body: op.requestBody === null ? null : synthesize(op.requestBody),
  };
}

// Deterministic example values from a schema: const, enum, a valid `examples[0]` or
// `default`, the first branch of oneOf/anyOf that validates, merged allOf, and
// otherwise a value built from type and format. Objects carry their required
// properties, or their first property when none is required.
export function createSynthesizer(schemas: Record<string, JsonSchema>, validate: Validate): (schema: JsonSchema) => unknown {
  const deref = (schema: JsonSchema): JsonSchema => {
    let current = schema;
    for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth++) {
      if (depth > 32) throw new Error("ir: $ref chain is too deep");
      const { $ref, ...rest } = current;
      const target = resolveSchemaRef(schemas, $ref as string);
      current = Object.keys(rest).length === 0 ? target : merge(target, rest);
    }
    return current;
  };

  const synthesize = (schema: JsonSchema, depth: number): unknown => {
    if (depth > 32) throw new Error("ir: example synthesis is too deep (recursive schema?)");
    const s = deref(schema);
    if (s === false) throw new Error("ir: cannot synthesize a value for the schema false");
    if (s === true) return STRING_EXAMPLE;
    if ("const" in s) return s["const"];
    if (Array.isArray(s["enum"]) && s["enum"].length > 0) return s["enum"].find((value: unknown) => value !== null) ?? s["enum"][0];
    const candidates = [Array.isArray(s["examples"]) ? s["examples"][0] : undefined, s["default"]];
    for (const candidate of candidates) if (candidate !== undefined && validate(s, candidate) === null) return candidate;

    const branchKey = Array.isArray(s["oneOf"]) ? "oneOf" : Array.isArray(s["anyOf"]) ? "anyOf" : null;
    if (branchKey !== null) {
      const base = omit(s, branchKey, "examples", "default");
      const branches = (s[branchKey] as JsonSchema[]).map(deref);
      // Non-null branches first, so an optional value is shown filled in.
      branches.sort((a, b) => Number(isNullSchema(a)) - Number(isNullSchema(b)));
      let first: unknown;
      for (const branch of branches) {
        const value = synthesize(merge(base, branch), depth + 1);
        if (validate(s, value) === null) return value;
        if (first === undefined) first = value;
      }
      return first;
    }
    if (Array.isArray(s["allOf"])) {
      const members = (s["allOf"] as JsonSchema[]).map(deref);
      return synthesize(members.reduce(merge, omit(s, "allOf", "examples", "default")), depth + 1);
    }

    switch (primaryType(s)) {
      case "object": {
        const properties = isObject(s["properties"]) ? s["properties"] : {};
        const required = Array.isArray(s["required"]) ? s["required"].filter((key: unknown): key is string => typeof key === "string") : [];
        const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 1);
        const additional = s["additionalProperties"];
        const fallback: JsonSchema = typeof additional === "boolean" || isObject(additional) ? additional : true;
        const value: JsonObject = {};
        for (const key of keys) value[key] = synthesize((properties[key] as JsonSchema | undefined) ?? fallback, depth + 1);
        return value;
      }
      case "array": {
        const count = Math.max(1, typeof s["minItems"] === "number" ? s["minItems"] : 0);
        const items = (s["items"] as JsonSchema | undefined) ?? true;
        return Array.from({ length: count }, () => synthesize(items, depth + 1));
      }
      case "string": {
        let value = (typeof s["format"] === "string" ? FORMAT_EXAMPLES[s["format"]] : undefined) ?? STRING_EXAMPLE;
        if (typeof s["minLength"] === "number" && value.length < s["minLength"]) value = value.padEnd(s["minLength"], "x");
        if (typeof s["maxLength"] === "number" && value.length > s["maxLength"]) value = value.slice(0, s["maxLength"]);
        return value;
      }
      case "integer":
      case "number": {
        let value =
          typeof s["minimum"] === "number" ? s["minimum"] : typeof s["exclusiveMinimum"] === "number" ? s["exclusiveMinimum"] + 1 : 1;
        if (typeof s["maximum"] === "number" && value > s["maximum"]) value = s["maximum"];
        return primaryType(s) === "integer" ? Math.ceil(value) : value;
      }
      case "boolean":
        return true;
      case "null":
        return null;
      default:
        return STRING_EXAMPLE;
    }
  };

  return (schema) => synthesize(schema, 0);
}

function primaryType(schema: JsonObject): string | undefined {
  const type = schema["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((value: unknown) => value !== "null") ?? "null";
  if (schema["properties"] !== undefined || schema["required"] !== undefined || schema["additionalProperties"] !== undefined) return "object";
  if (schema["items"] !== undefined || schema["prefixItems"] !== undefined) return "array";
  return undefined;
}

function isNullSchema(schema: JsonSchema): boolean {
  return isObject(schema) && (schema["type"] === "null" || schema["const"] === null);
}

function omit(schema: JsonObject, ...keys: string[]): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}

// Merges two schemas for synthesis only: properties and required are joined,
// types are intersected, every other keyword of `b` wins.
function merge(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (a === false || b === false) return false;
  if (a === true) return b;
  if (b === true) return a;
  const out: JsonObject = { ...a, ...b };
  if (isObject(a["properties"]) || isObject(b["properties"])) {
    out["properties"] = { ...(isObject(a["properties"]) ? a["properties"] : {}), ...(isObject(b["properties"]) ? b["properties"] : {}) };
  }
  const required = [...new Set([...stringList(a["required"]), ...stringList(b["required"])])];
  if (required.length > 0) out["required"] = required;
  if (a["type"] !== undefined && b["type"] !== undefined) {
    const types = stringList(a["type"]).filter((type) => stringList(b["type"]).includes(type));
    if (types.length > 0) out["type"] = types.length === 1 ? types[0] : types;
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string") : [];
}

export function serializeIR(ir: IR): string {
  return `${stringify(ir, "")}\n`;
}

// JSON with keys sorted by code unit at every level and 2-space indentation.
function stringify(value: unknown, indent: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`ir: cannot serialize the number ${value}`);
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item: unknown) => inner + stringify(item ?? null, inner)).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compare);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${stringify(value[key], inner)}`).join(",\n")}\n${indent}}`;
  }
  throw new Error(`ir: cannot serialize a value of type ${typeof value}`);
}
