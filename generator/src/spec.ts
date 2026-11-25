// Loads an OpenAPI 3.0.x or 3.1.x document, resolves its internal $refs and
// hands out operations whose schemas are JSON Schema 2020-12 (contract §4, D30).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = boolean | JsonObject;

export interface Spec {
  document: JsonObject;
  openapi: string;
  version: string;
  sha256: string;
}

export interface Pin {
  repository: string;
  commit: string;
  sha256: string;
}

export interface SpecParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description: string | null;
  style: string;
  explode: boolean;
  schema: JsonSchema;
}

export interface SpecOperation {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  summary: string | null;
  parameters: SpecParameter[];
  requestBody: { contentType: string; schema: JsonSchema } | null;
  responses: { status: number; schema: JsonSchema | null }[];
}

// An operation with or without operationId (older versions of the spec in the
// compatibility corpus lack them), and its raw object for what SpecOperation
// leaves out: deprecation, security, every media type and response headers.
export interface SpecEndpoint extends Omit<SpecOperation, "operationId"> {
  operationId: string | null;
  source: JsonObject;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const COMPONENT_SCHEMAS = "#/components/schemas/";
// Converted schemas point at the `schemas` map of the document they are written into (ir.json).
export const SCHEMAS_REF = "#/schemas/";

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
const SCHEMA_VALUES = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
// OpenAPI keywords that are not JSON Schema 2020-12; `example` becomes `examples`
// and 3.0 `nullable` becomes a `null` type below.
const OPENAPI_ONLY = new Set(["discriminator", "xml", "externalDocs", "nullable", "example"]);
// OpenAPI ignores header parameters with these names (OpenAPI 3.1 §4.8.12.1).
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadSpec(file: string): Spec {
  return parseSpec(readFileSync(file));
}

export function parseSpec(source: string | Uint8Array): Spec {
  const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : source;
  const document: unknown = parse(Buffer.from(bytes).toString("utf8"));
  if (!isObject(document)) throw new Error("spec: the document is not a mapping");
  const openapi = document["openapi"];
  if (typeof openapi !== "string" || !/^3\.[01]\.\d+$/.test(openapi)) {
    throw new Error(`spec: unsupported OpenAPI version ${JSON.stringify(openapi)}; only 3.0.x and 3.1.x are supported`);
  }
  const info = document["info"];
  const version = isObject(info) ? info["version"] : undefined;
  if (typeof version !== "string") throw new Error("spec: info.version is missing");
  return { document, openapi, version, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function readPin(file: string): Pin {
  const fields = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([a-z0-9]+): (.+)$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const repository = fields.get("repository");
  const commit = fields.get("commit");
  const sha256 = fields.get("sha256");
  if (!repository || !commit || !sha256) throw new Error(`${file}: repository, commit and sha256 are required`);
  return { repository, commit, sha256 };
}

// Resolves a local JSON pointer reference (`#/a/b`) against `root`.
export function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) throw new Error(`spec: external $ref ${ref} is not supported`);
  const fragment = decodeURIComponent(ref.slice(1));
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) throw new Error(`spec: $ref ${ref} is not a JSON pointer`);
  let node = root;
  for (const token of fragment.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node) && /^\d+$/.test(key) && Number(key) < node.length) node = node[Number(key)];
    else if (isObject(node) && Object.hasOwn(node, key)) node = node[key];
    else throw new Error(`spec: $ref ${ref} does not resolve`);
  }
  return node;
}

// Follows $ref chains of non-schema objects (path items, parameters, bodies, responses).
export function deref(spec: Spec, value: unknown, what: string): JsonObject {
  let current = value;
  const seen = new Set<string>();
  while (isObject(current) && typeof current["$ref"] === "string") {
    const ref = current["$ref"];
    if (seen.has(ref)) throw new Error(`spec: circular $ref ${ref}`);
    seen.add(ref);
    current = resolvePointer(spec.document, ref);
  }
  if (!isObject(current)) throw new Error(`spec: ${what} is not an object`);
  return current;
}

export function toJsonSchema(spec: Spec, schema: unknown): JsonSchema {
  return convert(spec, schema, spec.openapi.startsWith("3.0."));
}

function convert(spec: Spec, schema: unknown, legacy: boolean): JsonSchema {
  if (typeof schema === "boolean") return schema;
  if (!isObject(schema)) throw new Error(`spec: schema ${JSON.stringify(schema)} is not an object`);
  const ref = schema["$ref"];
  // OpenAPI 3.0 ignores the siblings of $ref; 3.1 keeps them.
  if (legacy && typeof ref === "string") return { $ref: convertRef(spec, ref) };
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    // additionalItems only has meaning next to tuple `items`, handled there.
    if (key.startsWith("x-") || OPENAPI_ONLY.has(key) || key === "additionalItems") continue;
    if (key === "$ref" && typeof value === "string") out[key] = convertRef(spec, value);
    else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(spec, child, legacy)]));
    } else if (key === "items" && Array.isArray(value)) {
      // Tuple form of draft 2019 and earlier.
      out["prefixItems"] = value.map((child) => convert(spec, child, legacy));
      if (schema["additionalItems"] !== undefined) out["items"] = convert(spec, schema["additionalItems"], legacy);
    } else if (SCHEMA_VALUES.has(key)) out[key] = convert(spec, value, legacy);
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map((child) => convert(spec, child, legacy));
    else out[key] = structuredClone(value);
  }
  if (schema["example"] !== undefined && out["examples"] === undefined) out["examples"] = [structuredClone(schema["example"])];
  if (!legacy) return out;
  for (const [bound, exclusive] of [
    ["minimum", "exclusiveMinimum"],
    ["maximum", "exclusiveMaximum"],
  ] as const) {
    const flag = schema[exclusive];
    if (typeof flag !== "boolean") continue;
    delete out[exclusive];
    if (flag && typeof out[bound] === "number") {
      out[exclusive] = out[bound];
      delete out[bound];
    }
  }
  return schema["nullable"] === true ? allowNull(out) : out;
}

function allowNull(schema: JsonObject): JsonObject {
  const type = schema["type"];
  if (typeof type === "string") schema["type"] = type === "null" ? type : [type, "null"];
  else if (Array.isArray(type)) schema["type"] = type.includes("null") ? type : [...type, "null"];
  else return { anyOf: [schema, { type: "null" }] };
  const values = schema["enum"];
  if (Array.isArray(values) && !values.includes(null)) schema["enum"] = [...values, null];
  return schema;
}

function convertRef(spec: Spec, ref: string): string {
  if (!ref.startsWith(COMPONENT_SCHEMAS)) throw new Error(`spec: schema $ref ${ref} does not point into ${COMPONENT_SCHEMAS}`);
  resolvePointer(spec.document, ref);
  return SCHEMAS_REF + ref.slice(COMPONENT_SCHEMAS.length);
}

export function componentSchemas(spec: Spec): Record<string, JsonSchema> {
  const components = spec.document["components"];
  const schemas = isObject(components) ? components["schemas"] : undefined;
  if (schemas === undefined) return {};
  if (!isObject(schemas)) throw new Error("spec: components.schemas is not a mapping");
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, toJsonSchema(spec, schema)]));
}

export function operations(spec: Spec): SpecOperation[] {
  return endpoints(spec).map(({ operationId, source: _source, ...op }) => {
    if (operationId === null) throw new Error(`spec: ${op.method} ${op.path} has no operationId`);
    return { operationId, ...op };
  });
}

export function endpoints(spec: Spec): SpecEndpoint[] {
  const paths = spec.document["paths"];
  if (!isObject(paths)) throw new Error("spec: paths is missing");
  const result: SpecEndpoint[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec, rawItem, `path item ${path}`);
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      const where = `${method.toUpperCase()} ${path}`;
      if (!isObject(op)) throw new Error(`spec: ${where} is not an object`);
      const operationId = typeof op["operationId"] === "string" ? op["operationId"] : null;
      const parameters = new Map<string, SpecParameter>();
      for (const raw of [...list(item["parameters"]), ...list(op["parameters"])]) {
        const parameter = toParameter(spec, raw, where);
        if (parameter) parameters.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
      }
      result.push({
        operationId,
        method: method.toUpperCase(),
        path,
        tags: list(op["tags"]).filter((tag): tag is string => typeof tag === "string"),
        summary: typeof op["summary"] === "string" ? op["summary"] : null,
        parameters: [...parameters.values()],
        requestBody: op["requestBody"] === undefined ? null : toRequestBody(spec, op["requestBody"], where),
        responses: toResponses(spec, op["responses"], where),
        source: op,
      });
    }
  }
  return result;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toParameter(spec: Spec, raw: unknown, where: string): SpecParameter | null {
  const parameter = deref(spec, raw, `a parameter of ${where}`);
  const name = parameter["name"];
  const location = parameter["in"];
  if (typeof name !== "string") throw new Error(`spec: a parameter of ${where} has no name`);
  if (location === "cookie") throw new Error(`spec: cookie parameter ${name} of ${where} is not supported`);
  if (location !== "path" && location !== "query" && location !== "header") {
    throw new Error(`spec: parameter ${name} of ${where} has an unknown location ${JSON.stringify(location)}`);
  }
  if (location === "header" && IGNORED_HEADERS.has(name.toLowerCase())) return null;
  let schema = toJsonSchema(spec, parameter["schema"] ?? mediaSchema(parameter["content"]) ?? {});
  const example = parameter["example"] ?? firstExampleValue(parameter["examples"]);
  if (example !== undefined && isObject(schema) && schema["examples"] === undefined) {
    schema = { ...schema, examples: [structuredClone(example)] };
  }
  const style = typeof parameter["style"] === "string" ? parameter["style"] : location === "query" ? "form" : "simple";
  return {
    name,
    in: location,
    required: location === "path" || parameter["required"] === true,
    description: typeof parameter["description"] === "string" ? parameter["description"] : null,
    style,
    explode: typeof parameter["explode"] === "boolean" ? parameter["explode"] : style === "form",
    schema,
  };
}

function mediaSchema(content: unknown): unknown {
  if (!isObject(content)) return undefined;
  const media = Object.values(content)[0];
  return isObject(media) ? media["schema"] : undefined;
}

function firstExampleValue(examples: unknown): unknown {
  if (!isObject(examples)) return undefined;
  const first = Object.values(examples)[0];
  return isObject(first) ? first["value"] : undefined;
}

// Picks application/json when present, otherwise the first declared media type.
function pickMedia(content: unknown, where: string): [string, JsonObject] | null {
  if (!isObject(content)) return null;
  const type = Object.hasOwn(content, "application/json") ? "application/json" : Object.keys(content)[0];
  if (type === undefined) return null;
  const media = content[type];
  if (!isObject(media)) throw new Error(`spec: media type ${type} of ${where} is not an object`);
  return [type, media];
}

function toRequestBody(spec: Spec, raw: unknown, where: string): SpecOperation["requestBody"] {
  const body = deref(spec, raw, `the request body of ${where}`);
  const picked = pickMedia(body["content"], `the request body of ${where}`);
  if (picked === null) return null;
  const [contentType, media] = picked;
  let schema = toJsonSchema(spec, media["schema"] ?? {});
  const example = media["example"] ?? firstExampleValue(media["examples"]);
  if (example !== undefined && isObject(schema) && schema["examples"] === undefined) {
    schema = { ...schema, examples: [structuredClone(example)] };
  }
  return { contentType, schema };
}

function toResponses(spec: Spec, raw: unknown, where: string): SpecOperation["responses"] {
  if (!isObject(raw)) throw new Error(`spec: ${where} has no responses`);
  const responses: SpecOperation["responses"] = [];
  for (const [code, value] of Object.entries(raw)) {
    if (!/^\d{3}$/.test(code)) continue;
    const response = deref(spec, value, `response ${code} of ${where}`);
    const picked = pickMedia(response["content"], `response ${code} of ${where}`);
    responses.push({
      status: Number(code),
      schema: picked === null ? null : toJsonSchema(spec, picked[1]["schema"] ?? {}),
    });
  }
  return responses;
}
