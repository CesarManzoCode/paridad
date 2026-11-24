import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { IR } from "../ir.ts";
import { LANGUAGES, emitDocs, pageFile } from "./docs.ts";

const ROOT = join(import.meta.dirname, "../../..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "paridad-docs-"));
  dirs.push(dir);
  emitDocs(ir, dir);
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(dir, "docs")).sort()) files[name] = readFileSync(join(dir, "docs", name), "utf8");
  return files;
}

const docs = emit();

function unescape(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function ids(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => unescape(match[1]!));
}

// Code of every example of the operation, by language.
function examples(html: string, operationId: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of html.matchAll(/<pre><code class="language-([a-z]+)" data-operation-id="([^"]*)">([\s\S]*?)<\/code><\/pre>/g)) {
    if (unescape(match[2]!) !== operationId) continue;
    found.set(match[1]!, [...(found.get(match[1]!) ?? []), unescape(match[3]!)]);
  }
  return found;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("there is index.html and one page per resource, and nothing else", () => {
  const resources = [...new Set(ir.operations.map((op) => op.resource))].sort();
  assert.deepEqual(Object.keys(docs), ["index.html", ...resources.map(pageFile)].sort());
});

test("every page is HTML5 in Spanish with charset and title, and has no script or external resource", () => {
  for (const [name, html] of Object.entries(docs)) {
    assert.ok(html.startsWith("<!DOCTYPE html>\n"), name);
    assert.match(html, /<html lang="es">/, name);
    assert.match(html, /<meta charset="utf-8">/, name);
    assert.match(html, /<title>[^<]+<\/title>/, name);
    assert.doesNotMatch(html, /<script|<link|<img|<iframe|\ssrc=/i, name);
    assert.doesNotMatch(html, /\shref="(?:[a-z]+:|\/\/)/i, name);
  }
});

test("every operation is one element with its operationId and four examples, one per language", () => {
  for (const op of ir.operations) {
    const html = docs[pageFile(op.resource)]!;
    const elements = [...html.matchAll(/<section id="([^"]*)" data-operation-id="([^"]*)">/g)].filter((match) => unescape(match[2]!) === op.id);
    assert.equal(elements.length, 1, op.id);
    const found = examples(html, op.id);
    assert.deepEqual([...found.keys()].sort(), [...LANGUAGES].sort(), op.id);
    for (const language of LANGUAGES) assert.equal(found.get(language)!.length, 1, `${op.id} ${language}`);
  }
});

test("the examples are complete programs that read the key and the URL from the environment", () => {
  for (const op of ir.operations) {
    const found = examples(docs[pageFile(op.resource)]!, op.id);
    const [property, method] = op.names.ts.split(".");
    assert.match(found.get("typescript")![0]!, new RegExp(`new Resend\\(\\);[\\s\\S]*resend\\.${property}\\.${method}\\(`), op.id);
    assert.match(found.get("python")![0]!, new RegExp(`from paridad_resend import Resend[\\s\\S]*Resend\\(\\)[\\s\\S]*resend\\.${op.names.python.replace(".", "\\.")}\\(`), op.id);
    const go = found.get("go")![0]!;
    assert.ok(go.startsWith("package main\n"), op.id);
    assert.match(go, /func main\(\) \{[\s\S]*resend\.NewClient\(\)/, op.id);
    assert.ok(go.includes(`resend "${ir.project.go_module}"`), op.id);
    assert.ok(go.includes(`c.${op.names.go}(ctx`), op.id);
    const bash = found.get("bash")![0]!;
    assert.ok(bash.startsWith("#!/usr/bin/env bash\n"), op.id);
    assert.ok(bash.split("\n").some((line) => line === op.names.cli || line.startsWith(`${op.names.cli} `)), op.id);
  }
});

test("no example has a placeholder without a value", () => {
  for (const op of ir.operations) {
    const values = strings(op.examples[0]).sort((a, b) => b.length - a.length);
    for (const [language, codes] of examples(docs[pageFile(op.resource)]!, op.id)) {
      let rest = codes.join("\n");
      for (const value of values) {
        const json = JSON.stringify(value).slice(1, -1);
        for (const form of [JSON.stringify(json).slice(1, -1), json, `'${value.replace(/'/g, `'\\''`)}'`, value]) rest = rest.split(form).join("");
      }
      assert.doesNotMatch(rest, /<[^<>\s]*>|\.\.\.|\bTODO\b|\bYOUR_/i, `${op.id} ${language}`);
    }
  }
});

test("ids are unique in each page", () => {
  for (const [name, html] of Object.entries(docs)) {
    const all = ids(html);
    assert.equal(new Set(all).size, all.length, name);
  }
});

test("every internal link points to an emitted file and an emitted id", () => {
  let links = 0;
  for (const [name, html] of Object.entries(docs)) {
    for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
      links++;
      const href = unescape(match[1]!);
      const hash = href.indexOf("#");
      const file = hash === -1 ? href : href.slice(0, hash);
      const target = file === "" ? name : file;
      assert.ok(docs[target] !== undefined, `${name}: ${href}`);
      if (hash !== -1) assert.ok(ids(docs[target]!).includes(href.slice(hash + 1)), `${name}: ${href}`);
    }
  }
  assert.ok(links >= ir.operations.length * 2);
});

test("the generated docs/ of the repository is the output of the emitter", () => {
  for (const [name, html] of Object.entries(docs)) {
    const file = join(ROOT, "docs", name);
    assert.ok(existsSync(file), name);
    assert.equal(readFileSync(file, "utf8"), html, name);
  }
});

test("the output is deterministic", () => {
  assert.deepEqual(emit(), docs);
});
