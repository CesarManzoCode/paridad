// Semver of the generated SDKs (vault/CONTRACT.md §10, D10, C19): an own comparison of
// the public API of the TypeScript, Python and Go SDKs, built from the IR of the base
// and of the revision, and the bump of a release as the maximum of the contract bump
// (rules.ts) and the SDK bump.
//
// Each language gets a map of API elements, keyed by what a caller writes: the client
// methods (names.ts, names.python, names.go, plus <method>All / <method>_all on a
// paginated operation), their parameters, and the types they take and return, with
// object types flattened into one element per property, item, branch or map value.
// An element that disappears or changes is major; one that appears is minor, except a
// required query parameter or a required property of an inline request type, which the
// caller must now send: major. A component schema is flattened once, whatever uses it,
// so a required property added to it is minor here and major in the contract (rules.ts).
//
// What differs by language, following how each SDK is consumed:
// - TypeScript and Python: path parameter names are public (the line of the method in
//   the api-extractor report; keyword arguments in Python). In Go they are not.
// - TypeScript: whether a component schema is documented or deprecated, because the
//   api-extractor report writes `// @public (undocumented)` or `@deprecated` above it.
import type { IR, IROperation, IRParameter } from "../../generator/src/ir.ts";
import { SCHEMAS_REF, isObject, type JsonObject, type JsonSchema } from "../../generator/src/spec.ts";

export type Bump = "major" | "minor" | "patch";
export const LANGUAGES = ["ts", "python", "go"] as const;
export type Language = (typeof LANGUAGES)[number];

interface Element {
  value: string;
  // The bump when the element only exists in the revision.
  added: "major" | "minor";
}

export interface ApiChange {
  language: Language;
  element: string;
  change: "removed" | "changed" | "added";
  bump: "major" | "minor";
}

export interface SdkReport {
  bumps: Record<Language, Bump>;
  bump: Bump;
  changes: ApiChange[];
}

const ORDER: Bump[] = ["patch", "minor", "major"];

export function maxBump(...bumps: Bump[]): Bump {
  return bumps.reduce<Bump>((max, bump) => (ORDER.indexOf(bump) > ORDER.indexOf(max) ? bump : max), "patch");
}

// The bump of a release: the maximum of the contract and of every SDK (§10).
export function releaseBump(contract: Bump, sdks: SdkReport): Bump {
  return maxBump(contract, sdks.bump);
}

export function compareSdks(base: IR, revision: IR): SdkReport {
  const changes: ApiChange[] = [];
  const bumps = {} as Record<Language, Bump>;
  for (const language of LANGUAGES) {
    const before = publicApi(base, language);
    const after = publicApi(revision, language);
    const own: ApiChange[] = [];
    for (const [element, { value }] of before) {
      const next = after.get(element);
      if (next === undefined) own.push({ language, element, change: "removed", bump: "major" });
      else if (next.value !== value) own.push({ language, element, change: "changed", bump: "major" });
    }
    for (const [element, { added }] of after) {
      if (!before.has(element)) own.push({ language, element, change: "added", bump: added });
    }
    bumps[language] = maxBump(...own.map((change) => change.bump));
    changes.push(...own);
  }
  return { bumps, bump: maxBump(...Object.values(bumps)), changes };
}

export function publicApi(ir: IR, language: Language): Map<string, Element> {
  const api = new Map<string, Element>();
  const add = (element: string, value: string, added: Element["added"] = "minor"): void => {
    if (api.has(element)) throw new Error(`semver: ${language} element ${element} appears twice`);
    api.set(element, { value, added });
  };
  for (const [name, schema] of Object.entries(ir.schemas)) {
    flatten(add, `type ${name}`, schema, "response", null);
    if (language === "ts") add(`doc ${name}`, isObject(schema) ? documentation(schema) : "none");
  }
  for (const op of ir.operations) operationApi(add, op, language);
  return api;
}

type Add = (element: string, value: string, added?: Element["added"]) => void;
// Request schemas are what the caller builds; a required property added there breaks it.
type Direction = "request" | "response";

function operationApi(add: Add, op: IROperation, language: Language): void {
  const method = op.names[language];
  const pathNames = language === "go" ? op.pathParams.map(() => "_") : op.pathParams.map((parameter) => parameter.name);
  const signature = [
    `path(${pathNames.join(",")})`,
    `body:${bodyKind(op)}`,
    `query:${queryKind(op.queryParams)}`,
    `idempotency:${op.idempotency}`,
    `response:${op.response.schema === null ? "none" : "some"}`,
  ];
  add(`method ${method}`, signature.join(" "));
  for (const parameter of op.pathParams) flatten(add, `method ${method} path ${language === "go" ? op.pathParams.indexOf(parameter) : parameter.name}`, parameter.schema, "request", null);
  if (op.requestBody !== null) flatten(add, `method ${method} body`, withoutMedia(op.requestBody), "request", null);
  for (const parameter of op.queryParams) queryElement(add, `method ${method} query`, parameter);
  if (op.response.schema !== null) flatten(add, `method ${method} response`, op.response.schema, "response", null);

  if (op.pagination === null) return;
  const pagination = op.pagination;
  const pageQuery = op.queryParams.filter((parameter) => parameter.name !== pagination.after && parameter.name !== pagination.before);
  const all = language === "python" ? `${method}_all` : `${method}All`;
  add(`method ${all}`, [`path(${pathNames.join(",")})`, `query:${queryKind(pageQuery)}`, `items:${pagination.items}`].join(" "));
  for (const parameter of pageQuery) queryElement(add, `method ${all} query`, parameter);
}

function queryElement(add: Add, prefix: string, parameter: IRParameter): void {
  flatten(add, `${prefix}.${parameter.name}`, parameter.schema, "request", parameter.required);
}

function queryKind(parameters: IRParameter[]): string {
  if (parameters.length === 0) return "none";
  return parameters.some((parameter) => parameter.required) ? "required" : "optional";
}

function bodyKind(op: IROperation): string {
  if (op.requestBody === null) return "none";
  const media = isObject(op.requestBody) ? op.requestBody["contentMediaType"] : undefined;
  return typeof media === "string" ? media : "json";
}

// The media type annotation is not part of the value the caller passes.
function withoutMedia(schema: JsonSchema): JsonSchema {
  return isObject(schema) && "contentMediaType" in schema ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "contentMediaType")) : schema;
}

function documentation(schema: JsonObject): string {
  const parts = [typeof schema["description"] === "string" ? "described" : "none"];
  if (schema["deprecated"] === true) parts.push("deprecated");
  return parts.join(",");
}

// One element for the schema at `element` and one for each property, array item, map
// value and allOf/oneOf/anyOf branch below it. `required` is null at a root, where
// presence is decided by the method signature.
function flatten(add: Add, element: string, schema: JsonSchema, direction: Direction, required: boolean | null): void {
  const presence = required === null ? "" : required ? "required " : "optional ";
  add(element, presence + shape(schema), direction === "request" && required === true ? "major" : "minor");
  if (typeof schema === "boolean" || typeof schema["$ref"] === "string" || "const" in schema || Array.isArray(schema["enum"])) return;
  const properties = isObject(schema["properties"]) ? schema["properties"] : {};
  const requiredNames = new Set(Array.isArray(schema["required"]) ? schema["required"] : []);
  for (const [name, property] of Object.entries(properties)) flatten(add, `${element}.${name}`, property as JsonSchema, direction, requiredNames.has(name));
  if (schema["items"] !== undefined) flatten(add, `${element}[]`, schema["items"] as JsonSchema, direction, null);
  if (isObject(schema["additionalProperties"])) flatten(add, `${element}{}`, schema["additionalProperties"], direction, null);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) (schema[key] as JsonSchema[]).forEach((branch, index) => flatten(add, `${element}<${key}:${index}>`, branch, direction, null));
  }
}

// What the generated type of a schema node depends on, without its children.
function shape(schema: JsonSchema): string {
  if (typeof schema === "boolean") return `schema:${schema}`;
  if (typeof schema["$ref"] === "string") return `ref:${schema["$ref"].startsWith(SCHEMAS_REF) ? schema["$ref"].slice(SCHEMAS_REF.length) : schema["$ref"]}`;
  if ("const" in schema) return `const:${JSON.stringify(schema["const"])}`;
  if (Array.isArray(schema["enum"])) return `enum:${JSON.stringify(schema["enum"])}`;
  const parts: string[] = [];
  const type = schema["type"];
  parts.push(`type:${typeof type === "string" ? type : Array.isArray(type) ? type.join("|") : "-"}`);
  if (schema["format"] === "binary") parts.push("binary");
  if (schema["properties"] !== undefined) parts.push("properties");
  const additional = schema["additionalProperties"];
  if (additional !== undefined) parts.push(`additional:${isObject(additional) ? "schema" : String(additional)}`);
  if (schema["items"] !== undefined) parts.push("items");
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) parts.push(`${key}:${(schema[key] as unknown[]).length}`);
  }
  return parts.join(" ");
}
