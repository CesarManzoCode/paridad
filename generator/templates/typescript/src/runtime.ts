// Runtime of paridad-resend (vault/CONTRACT.md §5): configuration, authentication,
// typed errors, the retry and idempotency policy of §5.3, per-attempt timeouts,
// cursor pagination, debug output and React Email rendering. Static template copied
// by the generator; the policy constants come from the IR (policy.ts) and the
// resources and methods are generated from its operations (resources.ts).
import { POLICY, VERSION } from "./policy.ts";

export const USER_AGENT = `paridad-ts/${VERSION}`;
const DEFAULT_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 30000;
// Connection failures that happen before the request leaves the client.
const BEFORE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export interface RetryRules {
  // A rule without `name` matches any name; `name: null` matches a body without `name`.
  responses: { status: number; name?: string | null }[];
  transport: string[];
}

// `policy` of the IR (ir/overlay.yaml).
export interface Policy {
  max_attempts: number;
  safe_methods: string[];
  safe_with_idempotency_key: boolean;
  retry_always: RetryRules;
  retry_if_safe: RetryRules;
  backoff: { retry_after_jitter_ms: number; retry_after_max_seconds: number; base_ms: number; cap_ms: number };
  idempotency_key: { header: string; min_length: number; max_length: number; error_code: string; error_message: string };
}

export class ParidadError extends Error {
  readonly code: string;
  readonly statusCode: number | null;

  constructor(code: string, message: string, statusCode: number | null) {
    super(message);
    this.name = "ParidadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type Result<T> = { data: T; error: null } | { data: null; error: ParidadError };

export interface ClientOptions {
  // Default: RESEND_BASE_URL, then https://api.resend.com.
  baseUrl?: string;
  // Maximum time of each attempt. Default: RESEND_TIMEOUT_MS, then 30000.
  timeoutMs?: number;
}

export interface IdempotentRequestOptions {
  // Sent as Idempotency-Key, the same on every attempt; 1 to 256 characters.
  idempotencyKey?: string;
}

export interface QueryParameter {
  name: string;
  explode: boolean;
}

// What a generated method knows about its operation.
export interface Operation {
  id: string;
  method: string;
  path: string;
  query: readonly QueryParameter[];
  body: "json" | "multipart" | null;
  // emails/send: a `react` element is rendered to `html` before sending.
  react?: true;
}

type Transport = "timeout" | "connection_error_before_send" | "connection_error_after_send";

interface Attempt {
  result: Result<unknown>;
  status: number | null;
  name: string | null;
  transport: Transport | null;
  retryAfter: string | null;
}

export class Core {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #debug: boolean;

  constructor(apiKey?: string, options: ClientOptions = {}) {
    const env = process.env;
    const key = nonEmpty(apiKey) ?? nonEmpty(env["RESEND_API_KEY"]);
    if (key === undefined) throw new Error("Missing API key. Pass it to the constructor or set RESEND_API_KEY.");
    this.#apiKey = key;
    this.#baseUrl = (nonEmpty(options.baseUrl) ?? nonEmpty(env["RESEND_BASE_URL"]) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeout = options.timeoutMs ?? nonEmpty(env["RESEND_TIMEOUT_MS"]) ?? DEFAULT_TIMEOUT_MS;
    this.#timeoutMs = Number(timeout);
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("The timeout must be a positive integer of milliseconds.");
    this.#debug = env["PARIDAD_DEBUG"] === "1";
    if (this.#debug) {
      debug(`config base_url=${this.#baseUrl} timeout_ms=${this.#timeoutMs} api_key=${maskKey(key)} user_agent=${USER_AGENT}`);
    }
  }

  async request<T>(
    op: Operation,
    path: readonly string[],
    query: object | undefined,
    body: unknown,
    options?: IdempotentRequestOptions,
  ): Promise<Result<T>> {
    const rules = POLICY.idempotency_key;
    const key = options?.idempotencyKey;
    if (key !== undefined) {
      const length = [...key].length;
      if (length < rules.min_length || length > rules.max_length) return failure(new ParidadError(rules.error_code, rules.error_message, null));
    }
    const url = this.#url(op, path, query);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}`, "User-Agent": USER_AGENT };
    if (key !== undefined) headers[rules.header] = key;
    // The body is serialized once, so every attempt sends the same bytes.
    let payload: string | Uint8Array<ArrayBuffer> | undefined;
    if (op.body === "json") {
      payload = JSON.stringify(op.react === true ? await renderReact(body) : body);
      headers["Content-Type"] = "application/json";
    } else if (op.body === "multipart") {
      [payload, headers["Content-Type"]] = await multipart(body);
    }
    const safe = POLICY.safe_methods.includes(op.method) || (POLICY.safe_with_idempotency_key && key !== undefined);
    const pathname = new URL(url).pathname;

    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#attempt(op.method, url, headers, payload);
      const wait = attempt < POLICY.max_attempts ? retryDelay(outcome, safe, attempt) : null;
      if (this.#debug) {
        const result = outcome.status ?? outcome.result.error?.code;
        const next = wait === null ? "none" : String(Math.round(wait));
        debug(`operation=${op.id} method=${op.method} path=${pathname} attempt=${attempt} result=${result} wait_ms=${next}`);
      }
      if (wait === null) return outcome.result as Result<T>;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  // Every item of every page, asking for the next page with after = id of the last
  // item while has_more is true. Each page follows the retry policy; an error that
  // remains is thrown as ParidadError.
  async *paginate<T>(op: Operation, path: readonly string[], query: object | undefined): AsyncGenerator<T, void, undefined> {
    let after: string | undefined;
    for (;;) {
      const result = await this.request<unknown>(op, path, { ...query, after }, undefined);
      if (result.error !== null) throw result.error;
      const page = isRecord(result.data) ? result.data : {};
      const items: unknown[] = Array.isArray(page["data"]) ? page["data"] : [];
      for (const item of items) yield item as T;
      const last = items[items.length - 1];
      if (page["has_more"] !== true || !isRecord(last) || typeof last["id"] !== "string") return;
      after = last["id"];
    }
  }

  #url(op: Operation, path: readonly string[], query: object | undefined): string {
    let index = 0;
    const pathname = op.path.replace(/\{[^}]+\}/g, () => encodeURIComponent(path[index++] ?? ""));
    const values = (query ?? {}) as Record<string, unknown>;
    const search = new URLSearchParams();
    for (const { name, explode } of op.query) {
      const value = values[name];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) search.append(name, String(value));
      else if (explode) for (const item of value) search.append(name, String(item));
      else search.append(name, value.map(String).join(","));
    }
    const encoded = search.toString();
    return `${this.#baseUrl}${pathname}${encoded === "" ? "" : `?${encoded}`}`;
  }

  async #attempt(method: string, url: string, headers: Record<string, string>, payload: string | Uint8Array<ArrayBuffer> | undefined): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return this.#transport("timeout");
        return this.#transport(beforeSend(error) ? "connection_error_before_send" : "connection_error_after_send");
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        // The connection closed in the middle of the response.
        return this.#transport(controller.signal.aborted ? "timeout" : "connection_error_after_send");
      }
      return fromResponse(response, text);
    } finally {
      clearTimeout(timer);
    }
  }

  #transport(transport: Transport): Attempt {
    const error =
      transport === "timeout"
        ? new ParidadError("timeout", `The request timed out after ${this.#timeoutMs} ms.`, null)
        : new ParidadError(
            "connection_error",
            transport === "connection_error_before_send" ? "Could not connect to the API." : "The connection closed before the response was complete.",
            null,
          );
    return { result: failure(error), status: null, name: null, transport, retryAfter: null };
  }
}

function fromResponse(response: Response, text: string): Attempt {
  const status = response.status;
  const retryAfter = response.headers.get("retry-after");
  let parsed: unknown = null;
  let json = true;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      json = false;
    }
  }
  if (status >= 200 && status < 300) {
    const result: Result<unknown> = json
      ? { data: parsed, error: null }
      : failure(new ParidadError("invalid_response", "The response body is not valid JSON.", status));
    return { result, status, name: null, transport: null, retryAfter };
  }
  const name = isRecord(parsed) && typeof parsed["name"] === "string" ? parsed["name"] : null;
  const message = isRecord(parsed) && typeof parsed["message"] === "string" ? parsed["message"] : `Request failed with status ${status}.`;
  return { result: failure(new ParidadError(name ?? `http_${status}`, message, status)), status, name, transport: null, retryAfter };
}

// Milliseconds to wait before the next attempt, or null when the outcome is final (§5.3).
function retryDelay(outcome: Attempt, safe: boolean, attempt: number): number | null {
  if (outcome.result.error === null) return null;
  const matches = (rules: RetryRules): boolean =>
    outcome.transport !== null
      ? rules.transport.includes(outcome.transport)
      : rules.responses.some((rule) => rule.status === outcome.status && (rule.name === undefined || rule.name === outcome.name));
  if (!matches(POLICY.retry_always) && !(safe && matches(POLICY.retry_if_safe))) return null;
  const { backoff } = POLICY;
  const retryAfter = outcome.retryAfter?.trim();
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (seconds > backoff.retry_after_max_seconds) return null;
    return seconds * 1000 + Math.random() * backoff.retry_after_jitter_ms;
  }
  return Math.min(backoff.cap_ms, backoff.base_ms * 2 ** (attempt - 1)) * (0.5 + 0.5 * Math.random());
}

function beforeSend(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const causes = cause instanceof AggregateError ? [cause, ...cause.errors] : [cause];
  return causes.some((item) => isRecord(item) && typeof item["code"] === "string" && BEFORE_SEND_CODES.has(item["code"]));
}

// Same as resend-node: `react` is rendered with @react-email/render (optional peer
// dependency) and sent as `html`.
async function renderReact(body: unknown): Promise<unknown> {
  if (!isRecord(body) || body["react"] === undefined) return body;
  const { react, ...rest } = body;
  const specifier = "@react-email/render";
  let render: (element: unknown) => Promise<string>;
  try {
    ({ render } = (await import(specifier)) as { render: (element: unknown) => Promise<string> });
  } catch {
    throw new Error("Sending `react` needs the optional dependency @react-email/render; install it next to paridad-resend.");
  }
  return { ...rest, html: await render(react) };
}

// Parts sorted by field name and a boundary derived from their data, so the three
// SDKs send the same bytes for the same body: a Blob as a file named like the
// field, strings as they are, anything else as JSON.
async function multipart(body: unknown): Promise<[Uint8Array<ArrayBuffer>, string]> {
  const text = new TextEncoder();
  const parts: [string, Uint8Array][] = [];
  const fields = Object.entries(isRecord(body) ? body : {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    const field = name.replaceAll('"', "%22");
    if (value instanceof Blob) {
      parts.push([`Content-Disposition: form-data; name="${field}"; filename="${field}"\r\nContent-Type: application/octet-stream`, new Uint8Array(await value.arrayBuffer())]);
    } else {
      parts.push([`Content-Disposition: form-data; name="${field}"`, text.encode(typeof value === "string" ? value : JSON.stringify(value))]);
    }
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(parts.map(([, data]) => data))));
  const boundary = `paridad-${[...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const chunks = parts.flatMap(([head, data]) => [text.encode(`--${boundary}\r\n${head}\r\n\r\n`), data, text.encode("\r\n")]);
  return [concat([...chunks, text.encode(`--${boundary}--\r\n`)]), `multipart/form-data; boundary=${boundary}`];
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// The key is never shown: re_... and its last 4 characters.
export function maskKey(key: string): string {
  return `re_...${key.length > 4 ? key.slice(-4) : ""}`;
}

function debug(line: string): void {
  process.stderr.write(`[paridad] ${line}\n`);
}

function failure(error: ParidadError): Result<never> {
  return { data: null, error };
}

function nonEmpty<T>(value: T | undefined | ""): T | undefined {
  return value === "" ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
