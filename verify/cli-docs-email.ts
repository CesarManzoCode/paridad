// Pieces shared by the runners of the CLI against the official one, of the
// documentation and of React Email (C16, C17, C24; contract §5.6, §6, §9, D08, D14):
// the reader of verify/official-cli-map.json, the extractor of the examples of docs/,
// the checker of its internal links, and the loader and renderer of the templates of
// verify/react-email/.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FunctionComponent } from "react";

const ROOT = resolve(import.meta.dirname, "..");

// ------------------------------------------------------------ C16 official map

// A pair of equivalent commands: the arguments after `paridad` and after `resend`.
// With `respond`, the fault proxy answers every attempt of the pair with that error
// of the catalog (§5.2); without it, the request reaches the capture server.
export interface OfficialPair {
  id: string;
  ours: string[];
  official: string[];
  respond?: { status: number; name: string };
}

export const MIN_OFFICIAL_PAIRS = 20;

export function readOfficialMap(text: string): OfficialPair[] {
  const pairs = JSON.parse(text) as unknown;
  if (!Array.isArray(pairs)) throw new Error("verify/official-cli-map.json is not a JSON array");
  return pairs as OfficialPair[];
}

// What is wrong with the map: fewer than 20 pairs, a repeated or malformed id, an
// empty or non-string argument list, or a malformed forced error.
export function officialMapProblems(pairs: OfficialPair[]): string[] {
  const problems: string[] = [];
  if (pairs.length < MIN_OFFICIAL_PAIRS) problems.push(`${pairs.length} pairs, at least ${MIN_OFFICIAL_PAIRS} needed`);
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (typeof pair.id !== "string" || !/^[a-z0-9-]+$/.test(pair.id)) problems.push(`id ${JSON.stringify(pair.id)} is not [a-z0-9-]+`);
    if (seen.has(pair.id)) problems.push(`${pair.id} is listed twice`);
    seen.add(pair.id);
    for (const side of ["ours", "official"] as const) {
      const argv = pair[side];
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string")) problems.push(`${pair.id}: ${side} is not a non-empty list of strings`);
    }
    if (pair.respond !== undefined && (!Number.isInteger(pair.respond.status) || pair.respond.status < 400 || typeof pair.respond.name !== "string")) {
      problems.push(`${pair.id}: respond needs an error status and a name`);
    }
  }
  return problems;
}

// The sorted top-level keys of a JSON output; null when it is not a JSON object.
export function topLevelKeys(text: string): string[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).sort() : null;
  } catch {
    return null;
  }
}

// The C16 rule for one output: exit 0 with valid JSON, or exit 1 with JSON whose
// error.message is a string. Returns the problem, or null.
export function outputProblem(exitCode: number | null, text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `exit ${exitCode} without valid JSON`;
  }
  if (exitCode === 0) return null;
  if (exitCode !== 1) return `exit ${exitCode}, expected 0 or 1`;
  const error = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["error"] : undefined;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>)["message"] : undefined;
  return typeof message === "string" ? null : "exit 1 without error.message";
}

// ---------------------------------------------------------- C17 documentation

export const DOC_LANGUAGES = ["typescript", "python", "go", "bash"] as const;
export type DocLanguage = (typeof DOC_LANGUAGES)[number];

export interface DocExample {
  operation: string;
  language: DocLanguage;
  // Text of the example with the HTML escapes undone.
  code: string;
}

const EXAMPLE = /<code class="language-([a-z]+)" data-operation-id="([^"]+)">([\s\S]*?)<\/code>/g;

// Every `<code class="language-…" data-operation-id="…">` of a page, in order.
export function docExamples(html: string): DocExample[] {
  const examples: DocExample[] = [];
  for (const match of html.matchAll(EXAMPLE)) {
    const language = match[1]!;
    if (!(DOC_LANGUAGES as readonly string[]).includes(language)) throw new Error(`unknown example language ${language}`);
    examples.push({ operation: unescape(match[2]!), language: language as DocLanguage, code: unescape(match[3]!) });
  }
  return examples;
}

// Undoes the four escapes of the documentation emitter (& < > ").
function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export interface BrokenLink {
  file: string;
  href: string;
}

// Internal links of a set of pages (file name relative to the site root -> HTML) that
// point to a missing page or to a fragment without an element of that id. Links with
// a scheme or starting with // are external and not checked.
export function brokenLinks(pages: Map<string, string>): BrokenLink[] {
  const ids = new Map<string, Set<string>>();
  for (const [file, html] of pages) ids.set(file, new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((match) => unescape(match[1]!))));
  const broken: BrokenLink[] = [];
  for (const [file, html] of pages) {
    for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
      const href = unescape(match[1]!);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
      const mark = href.indexOf("#");
      const target = mark === -1 ? href : href.slice(0, mark);
      const fragment = mark === -1 ? null : decodeURIComponent(href.slice(mark + 1));
      const page = target === "" ? file : posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(target)));
      const found = ids.get(page);
      if (found === undefined || (fragment !== null && fragment !== "" && !found.has(fragment))) broken.push({ file, href });
    }
  }
  return broken;
}

// ------------------------------------------------------------ C24 React Email

export const TEMPLATE_DIR = join(ROOT, "verify/react-email");
export const TEMPLATES = ["welcome", "reset-password", "receipt"] as const;

export function templateFile(name: string): string {
  return join(TEMPLATE_DIR, `${name}.tsx`);
}

export function templateProps(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TEMPLATE_DIR, `${name}.props.json`), "utf8")) as Record<string, unknown>;
}

// The default export of a .tsx template, loaded as §5.6 says the CLI does: bundled by
// esbuild (JSX automatic, packages external) next to the template, so its packages
// resolve from there, and imported.
export async function loadTemplate(file: string): Promise<FunctionComponent<Record<string, unknown>>> {
  const { build } = await import("esbuild");
  const output = await build({ entryPoints: [file], bundle: true, format: "esm", platform: "node", jsx: "automatic", packages: "external", write: false, logLevel: "silent" });
  const bundle = join(dirname(file), `.${basename(file)}.${randomUUID()}.mjs`);
  writeFileSync(bundle, output.outputFiles[0]!.contents);
  try {
    const component = ((await import(pathToFileURL(bundle).href)) as { default?: unknown }).default;
    if (typeof component !== "function") throw new Error(`${file} has no default export component`);
    return component as FunctionComponent<Record<string, unknown>>;
  } finally {
    rmSync(bundle, { force: true });
  }
}

// The output of `render` of @react-email/render for a template with its example props.
export async function renderTemplate(name: string): Promise<string> {
  const component = await loadTemplate(templateFile(name));
  const { createElement } = await import("react");
  const { render } = await import("@react-email/render");
  return render(createElement(component, templateProps(name)));
}
