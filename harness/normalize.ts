// Request normalization (contract §7.1) and the difference fields between two
// normalized requests, shared by the criteria runners.
import { createHash } from "node:crypto";

// A request as captured (captures.jsonl, contract §8).
export interface RawRequest {
  method: string;
  target: string;
  headers: [string, string][];
  body_b64: string;
}

export interface NormalizedRequest {
  method: string;
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  body: string | null;
}

export const COUNTED_HEADERS = ["authorization", "content-type", "idempotency-key"] as const;

export function normalize(request: RawRequest): NormalizedRequest {
  const bytes = Buffer.from(request.body_b64, "base64");
  const mark = request.target.indexOf("?");
  const path = mark === -1 ? request.target : request.target.slice(0, mark);
  const query = [...new URLSearchParams(mark === -1 ? "" : request.target.slice(mark + 1))].sort(
    ([keyA, valueA], [keyB, valueB]) => compare(keyA, keyB) || compare(valueA, valueB),
  );

  const found: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (!(COUNTED_HEADERS as readonly string[]).includes(key)) continue;
    found[key] = found[key] === undefined ? value.trim() : `${found[key]}, ${value.trim()}`;
  }
  const contentType = found["content-type"];
  const mediaType = contentType === undefined ? null : contentType.split(";")[0]!.trim().toLowerCase();
  const headers: Record<string, string> = {};
  for (const name of COUNTED_HEADERS) {
    // content-type counts only with a body: resend-node also sends it without one.
    if (name === "content-type") {
      if (mediaType !== null && bytes.length > 0) headers[name] = mediaType;
    } else if (found[name] !== undefined) headers[name] = found[name];
  }

  return {
    method: request.method.toUpperCase(),
    path: decodePath(path),
    query,
    headers,
    body: normalizeBody(bytes, mediaType),
  };
}

// Difference fields (contract §7.1) in which two normalized requests differ.
export function differences(a: NormalizedRequest, b: NormalizedRequest): string[] {
  const fields: string[] = [];
  if (a.method !== b.method) fields.push("method");
  if (a.path !== b.path) fields.push("path");
  if (JSON.stringify(a.query) !== JSON.stringify(b.query)) fields.push("query");
  for (const name of COUNTED_HEADERS) if (a.headers[name] !== b.headers[name]) fields.push(`header:${name}`);
  if (a.body !== b.body) fields.push("body");
  return fields;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed percent sequence is kept as received.
    return path;
  }
}

// Empty -> null; JSON -> canonical text; anything else, or JSON that does not
// parse, -> sha256 of the bytes.
function normalizeBody(bytes: Buffer, mediaType: string | null): string | null {
  if (bytes.length === 0) return null;
  if (mediaType !== null && (mediaType === "application/json" || mediaType.endsWith("+json"))) {
    try {
      return canonical(JSON.parse(bytes.toString("utf8")));
    } catch {
      // Falls through to the hash.
    }
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Sorted keys, no whitespace, numbers with a zero fractional part as integers.
function canonical(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compare);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
