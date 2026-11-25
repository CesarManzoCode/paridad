// Documentation emitter (vault/CONTRACT.md §6, D16): writes docs/ as static HTML5,
// index.html and one page per resource, with no JavaScript and no external
// resources. Each operation is an element with its operationId and four complete
// programs (TypeScript, Python, Go, bash) that run its first example reading the
// key and the base URL from the environment.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IR, IROperation } from "../ir.ts";
import { isObject } from "../spec.ts";
import { command, exampleArgv, flagText } from "./cli.ts";
import { goExampleCalls, goString, type GoExampleCall } from "./go.ts";
import { pyLiteral } from "./python.ts";
import { exampleCommand, shellWord } from "./skill.ts";
import { TS_PACKAGE } from "./typescript.ts";

export const LANGUAGES = ["typescript", "python", "go", "bash"] as const;
export type Language = (typeof LANGUAGES)[number];
const LANGUAGE_NAMES: Record<Language, string> = { typescript: "TypeScript", python: "Python", go: "Go", bash: "CLI (bash)" };
const STYLE = `body{font-family:system-ui,sans-serif;max-width:60rem;margin:0 auto;padding:1rem;line-height:1.5}
pre{background:#f4f4f4;padding:.75rem;overflow-x:auto}
section{border-top:1px solid #ccc;margin-top:2rem}
code{font-family:ui-monospace,monospace}`;

export function emitDocs(ir: IR, outDir: string): void {
  const root = join(outDir, "docs");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const resources = groupResources(ir);
  const goCalls = goExampleCalls(ir);
  writeFileSync(join(root, "index.html"), indexPage(ir, resources));
  for (const [resource, ops] of resources) writeFileSync(join(root, pageFile(resource)), resourcePage(ir, resource, ops, goCalls));
}

export function pageFile(resource: string): string {
  if (resource === "index") throw new Error("docs: resource index collides with index.html");
  return `${resource}.html`;
}

function groupResources(ir: IR): Map<string, IROperation[]> {
  const grouped = new Map<string, IROperation[]>();
  for (const op of ir.operations) grouped.set(op.resource, [...(grouped.get(op.resource) ?? []), op]);
  return new Map([...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function indexPage(ir: IR, resources: Map<string, IROperation[]>): string {
  const list = [...resources].map(([resource, ops]) => {
    const items = ops.map((op) => `<li><a href="${escape(pageFile(resource))}#${escape(op.id)}"><code>${escape(op.id)}</code></a>${op.summary === null ? "" : ` — ${escape(op.summary)}`}</li>`);
    return `<li><a href="${escape(pageFile(resource))}">${escape(resource)}</a>\n<ul>\n${items.join("\n")}\n</ul>\n</li>`;
  });
  return page(
    "paridad — API de Resend",
    `<header>
<h1>paridad — API de Resend</h1>
</header>
<main>
<p>Referencia de las ${ir.operations.length} operaciones de la especificación OpenAPI fijada de Resend (OpenAPI ${escape(ir.spec.openapi)}, versión ${escape(ir.spec.version)}) en los SDKs de TypeScript (<code>${escape(TS_PACKAGE)}</code>), Python (<code>paridad_resend</code>) y Go (<code>${escape(ir.project.go_module)}</code>) y en el CLI <code>paridad</code>. Generada por paridad desde <code>ir/ir.json</code>; no se edita a mano.</p>
<h2>Configuración</h2>
<p>Todos los ejemplos leen la clave de <code>RESEND_API_KEY</code> y la URL base de <code>RESEND_BASE_URL</code> (por defecto <code>https://api.resend.com</code>); el tiempo máximo de cada intento sale de <code>RESEND_TIMEOUT_MS</code> (por defecto 30000). Cada ejemplo es un programa completo que imprime la respuesta en JSON y termina con un código distinto de 0 si la API devuelve un error.</p>
<h2>Recursos</h2>
<ul>
${list.join("\n")}
</ul>
</main>`,
  );
}

function resourcePage(ir: IR, resource: string, ops: IROperation[], goCalls: Map<string, GoExampleCall>): string {
  const toc = ops.map((op) => `<li><a href="#${escape(op.id)}"><code>${escape(op.id)}</code></a></li>`);
  const sections = ops.map((op) => {
    const goCall = goCalls.get(op.id);
    if (goCall === undefined) throw new Error(`docs: ${op.id} has no Go example`);
    const examples: Record<Language, string> = {
      typescript: typescriptExample(op, ir),
      python: pythonExample(op, ir),
      go: goExample(ir, goCall),
      bash: bashExample(op, ir),
    };
    const traits = [op.pagination !== null ? "paginada" : null, op.idempotency ? "acepta clave de idempotencia" : null, op.destructive ? "destructiva" : null].filter((trait) => trait !== null);
    const blocks = LANGUAGES.map(
      (language) =>
        `<h3>${LANGUAGE_NAMES[language]}</h3>\n<pre><code class="language-${language}" data-operation-id="${escape(op.id)}">${escape(examples[language])}</code></pre>`,
    );
    return `<section id="${escape(op.id)}" data-operation-id="${escape(op.id)}">
<h2><code>${escape(op.id)}</code></h2>
${op.summary === null ? "" : `<p>${escape(op.summary)}</p>\n`}<p><code>${escape(op.method)} ${escape(op.path)}</code>${traits.length === 0 ? "" : ` — ${traits.join(", ")}`}</p>
${blocks.join("\n")}
</section>`;
  });
  return page(
    `${resource} — paridad`,
    `<header>
<p><a href="index.html">Índice</a></p>
<h1>${escape(resource)}</h1>
</header>
<main>
<ul>
${toc.join("\n")}
</ul>
${sections.join("\n")}
</main>`,
  );
}

// ---------------------------------------------------------------------- examples

function exampleOf(op: IROperation) {
  const example = op.examples[0];
  if (example === undefined) throw new Error(`docs: ${op.id} has no example`);
  return example;
}

function pathArgs(op: IROperation): string[] {
  const example = exampleOf(op);
  return op.pathParams.map((parameter) => String(example.path[parameter.name]));
}

// The file fields of a multipart body (binary flags of the CLI) that the example
// gives as text; the SDKs take them as Blob or bytes and send them as a file part.
function fileFields(op: IROperation, ir: IR): Set<string> {
  const body = exampleOf(op).body;
  const flags = command(op, ir.schemas).body?.flags ?? [];
  return new Set(flags.filter((flag) => flag.kind === "binary" && isObject(body) && typeof body[flag.name] === "string").map((flag) => flag.name));
}

// The body as a literal, with each file field written by `file` from its text.
function bodyLiteral(op: IROperation, ir: IR, literal: (value: unknown) => string, file: (text: string) => string, indent: string): string {
  const body = exampleOf(op).body;
  const files = fileFields(op, ir);
  if (files.size === 0 || !isObject(body)) return literal(body);
  const entries = Object.entries(body).map(([name, value]) => `${indent}${JSON.stringify(name)}: ${files.has(name) ? file(value as string) : literal(value).replace(/\n/g, `\n${indent}`)},`);
  return `{\n${entries.join("\n")}\n}`;
}

export function typescriptExample(op: IROperation, ir: IR): string {
  const example = exampleOf(op);
  const [property, method] = op.names.ts.split(".") as [string, string];
  const args = pathArgs(op).map((arg) => JSON.stringify(arg));
  if (op.requestBody !== null) {
    args.push(bodyLiteral(op, ir, (value) => JSON.stringify(value, null, 2), (text) => `new Blob([${JSON.stringify(text)}])`, "  ").replace(/,\n\}$/, "\n}"));
  }
  if (op.queryParams.length > 0) args.push(JSON.stringify(example.query, null, 2));
  return `import { Resend } from "${TS_PACKAGE}";

// new Resend() reads RESEND_API_KEY and RESEND_BASE_URL.
const resend = new Resend();
const { data, error } = await resend.${property}.${method}(${args.join(", ")});
if (error !== null) {
  console.error(\`\${error.code}: \${error.message}\`);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
`;
}

export function pythonExample(op: IROperation, ir: IR): string {
  const example = exampleOf(op);
  const [attribute, method] = op.names.python.split(".") as [string, string];
  const args = pathArgs(op).map((arg) => JSON.stringify(arg));
  if (op.requestBody !== null) args.push(bodyLiteral(op, ir, (value) => pyLiteral(value, ""), (text) => `${JSON.stringify(text)}.encode()`, "    "));
  if (op.queryParams.length > 0) args.push(pyLiteral(example.query, ""));
  return `import json

from paridad_resend import Resend

# Resend() reads RESEND_API_KEY and RESEND_BASE_URL; an API error raises ParidadError.
resend = Resend()
result = resend.${attribute}.${method}(${args.join(", ")})
print(json.dumps(result, indent=2))
`;
}

// Type names of package resend, qualified for package main.
function qualify(type: string): string {
  return type.replace(/\b[A-Z][A-Za-z0-9]*/g, (name) => `resend.${name}`);
}

export function goExample(ir: IR, call: GoExampleCall): string {
  const decls = call.decls.map(
    (decl) => `	var ${decl.name} ${qualify(decl.type)}
	if err := json.Unmarshal([]byte(${goString(decl.json)}), &${decl.name}); err != nil {
		fail(err)
	}
`,
  );
  return `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	resend "${ir.project.go_module}"
)

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	// NewClient reads RESEND_API_KEY and RESEND_BASE_URL.
	c, err := resend.NewClient()
	if err != nil {
		fail(err)
	}
	ctx := context.Background()
${decls.join("")}	result, err := ${call.call}
	if err != nil {
		fail(err)
	}
	out, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(out))
}
`;
}

export function bashExample(op: IROperation, ir: IR): string {
  return `#!/usr/bin/env bash
# paridad reads RESEND_API_KEY and RESEND_BASE_URL; it exits 1 on error.
set -euo pipefail
${bashCommand(op, ir)}
`;
}

// With file fields the body goes as flags, and a file flag reads the text of the
// example through process substitution; otherwise the command of the skill.
function bashCommand(op: IROperation, ir: IR): string {
  const files = fileFields(op, ir);
  if (files.size === 0) return exampleCommand(op, ir);
  const cmd = command(op, ir.schemas);
  const flags = new Map(cmd.body!.flags.map((flag) => [flag.name, flag]));
  const words = exampleArgv({ ...cmd, body: null }, op).map(shellWord);
  for (const [name, value] of Object.entries(exampleOf(op).body as Record<string, unknown>)) {
    const flag = flags.get(name);
    const text = flag === undefined ? null : files.has(name) ? (value as string) : flagText(flag.kind, value);
    if (flag === undefined || text === null) throw new Error(`docs: the example of ${op.id} cannot give ${name} as a flag`);
    words.push(`--${flag.flag}`, files.has(name) ? `<(printf '%s' ${shellWord(text)})` : shellWord(text));
  }
  return ["paridad", ...words].join(" ");
}
