// Translation of a neutral case (contract §8) into the call of an official SDK, by
// harness/oracle/official-map.json, and the JSON pointer check of the justified
// divergences (§7.2). The Python and Go official drivers implement the same
// template rules; official-map.test.ts checks that the three translate alike.
//
// An entry gives, per language (ts, python, go), the method as a dotted path from
// the client (Node `new Resend()`, the Python `resend` module, the Go `*Client`)
// and its arguments as templates:
// - "$path.<name>", "$query", "$query.<name>", "$body", "$body.<name>",
//   "$idempotency_key", "$item", "$item.<name>": a value of the case; null or a
//   missing key is absent.
// - {"$with": <ref>, ...}: the object of <ref> plus the other keys.
// - {"$camel": <ref>, ...}: the same, with the top-level keys of <ref> in camelCase.
// - {"$each": <ref>, "as": <template>}: <template> for every element of the array
//   of <ref>, with that element as "$item".
// - Any other object or array is resolved member by member; absent members are
//   dropped. Other values are literals.
// An absent argument is undefined in Node, None in Python and the zero value of the
// parameter in Go. In Go a context.Context first parameter is supplied by the
// driver, and a key that names a Go field tagged `json:"-"` is set on that field.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePointer } from "../../generator/src/spec.ts";

export const LANGUAGES = ["ts", "python", "go"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface MapEntry {
  method: string;
  args: unknown[];
}

export interface OfficialMap {
  format: "paridad-official-map/1";
  operations: Record<string, Partial<Record<Language, MapEntry>>>;
}

// The part of a neutral case that templates read.
export interface CaseInput {
  operation: string;
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  idempotency_key: string | null;
}

export interface OfficialCall {
  method: string;
  args: unknown[];
}

export function loadOfficialMap(root: string): OfficialMap {
  return JSON.parse(readFileSync(join(root, "harness/oracle/official-map.json"), "utf8")) as OfficialMap;
}

// The official call for a case, or null if that SDK has no method for the operation.
export function officialCall(map: OfficialMap, language: Language, input: CaseInput): OfficialCall | null {
  const entry = map.operations[input.operation]?.[language];
  if (entry === undefined) return null;
  return { method: entry.method, args: entry.args.map((template) => resolve(template, input, undefined)) };
}

function resolve(template: unknown, input: CaseInput, item: unknown): unknown {
  if (typeof template === "string") return template.startsWith("$") ? reference(template, input, item) : template;
  if (Array.isArray(template)) return template.map((member) => resolve(member, input, item)).filter((member) => member !== undefined);
  if (template === null || typeof template !== "object") return template;

  const object = template as Record<string, unknown>;
  if ("$each" in object) {
    const list = resolve(object["$each"], input, item);
    return Array.isArray(list) ? list.map((element) => resolve(object["as"], input, element)) : undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === "$with" || key === "$camel") {
      const base = resolve(value, input, item);
      if (base === null || typeof base !== "object" || Array.isArray(base)) continue;
      for (const [baseKey, baseValue] of Object.entries(base)) result[key === "$camel" ? camel(baseKey) : baseKey] = baseValue;
      continue;
    }
    const resolved = resolve(value, input, item);
    if (resolved !== undefined) result[key] = resolved;
  }
  return result;
}

function reference(text: string, input: CaseInput, item: unknown): unknown {
  const [root, name] = text.slice(1).split(".", 2) as [string, string | undefined];
  const scope: Record<string, unknown> = { path: input.path, query: input.query, body: input.body, idempotency_key: input.idempotency_key, item };
  if (!(root in scope)) throw new Error(`unknown template reference ${text}`);
  let value = scope[root];
  if (name !== undefined) value = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
  return value === null ? undefined : value;
}

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

// Whether the spec_ref of a divergence (§7.2), a JSON pointer "#/…", names a value
// of the spec document.
export function specRefResolves(document: unknown, ref: string): boolean {
  if (!ref.startsWith("#/")) return false;
  try {
    resolvePointer(document, ref);
    return true;
  } catch {
    return false;
  }
}
