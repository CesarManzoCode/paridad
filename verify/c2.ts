// node verify/c2.ts <run dir>   (make verify C=c2)
// C2 (contract §9): every operationId of the spec must appear in the captures of C5
// of ts, python, go, cli and mcp, matched by method and path template, and as a
// data-operation-id in docs/. Uses .paridad/runs/c5/captures.jsonl, running
// `make verify C=c5` first (output in out/c5.stdout|stderr) when it does not exist or
// lacks one of the five surfaces, and copies it to captures.jsonl. Writes missing.jsonl
// ({"operation","where"}, where is a surface or docs); prints faltantes=<n> and exits 0
// only if n = 0.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR, IROperation } from "../generator/src/ir.ts";
import { normalize } from "../harness/normalize.ts";
import type { CaseCapture } from "./cases.ts";
import { runCommand } from "./command.ts";
import { ALL_SURFACES } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");
const C5_CAPTURES = join(ROOT, ".paridad/runs/c5/captures.jsonl");

const runDir = process.argv[2]!;
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

// Captures of an earlier `make verify C=c5 SURFACES=…` lack some surface: C2 runs c5 again.
function capturedSurfaces(): Set<string> {
  const surfaces = new Set<string>();
  for (const text of readFileSync(C5_CAPTURES, "utf8").split("\n")) {
    if (text !== "") surfaces.add(String((JSON.parse(text) as CaseCapture).surface));
  }
  return surfaces;
}

if (!existsSync(C5_CAPTURES) || !ALL_SURFACES.every((surface) => capturedSurfaces().has(surface))) {
  // Every surface, whatever SURFACES says: C2 needs the five.
  const env = { ...process.env };
  delete env["SURFACES"];
  await runCommand([process.execPath, "verify/run.ts", "c5"], { cwd: ROOT, env, out: join(runDir, "out/c5") });
}
if (!existsSync(C5_CAPTURES)) {
  process.stderr.write("c2: .paridad/runs/c5/captures.jsonl does not exist after running c5; see out/c5.stderr\n");
  process.exit(1);
}
copyFileSync(C5_CAPTURES, join(runDir, "captures.jsonl"));

// Method and path template: a literal segment beats a parameter, so /emails/batch is
// not taken for /emails/{email_id}.
const routes = ir.operations.map((op) => ({ op, segments: op.path.split("/").map((segment) => (/^\{[^}]+\}$/.test(segment) ? null : segment)) }));
function operationOf(method: string, path: string): IROperation | null {
  const segments = path.split("/");
  let best: { op: IROperation; literals: number } | null = null;
  for (const route of routes) {
    if (route.op.method !== method || route.segments.length !== segments.length) continue;
    if (!route.segments.every((segment, index) => (segment === null ? segments[index] !== "" : segment === segments[index]))) continue;
    const literals = route.segments.filter((segment) => segment !== null).length;
    if (best === null || literals > best.literals) best = { op: route.op, literals };
  }
  return best?.op ?? null;
}

const seen = new Set<string>();
for (const text of readFileSync(C5_CAPTURES, "utf8").split("\n")) {
  if (text === "") continue;
  const capture = JSON.parse(text) as CaseCapture;
  if (capture.surface === null) continue;
  const request = normalize(capture);
  const op = operationOf(request.method, request.path);
  if (op !== null) seen.add(`${op.id}\n${capture.surface}`);
}

const documented = new Set<string>();
for (const name of readdirSync(join(ROOT, "docs"))) {
  if (!name.endsWith(".html")) continue;
  for (const match of readFileSync(join(ROOT, "docs", name), "utf8").matchAll(/data-operation-id="([^"]*)"/g)) documented.add(match[1]!);
}

const missing: { operation: string; where: string }[] = [];
for (const op of ir.operations) {
  for (const surface of ALL_SURFACES) if (!seen.has(`${op.id}\n${surface}`)) missing.push({ operation: op.id, where: surface });
  if (!documented.has(op.id)) missing.push({ operation: op.id, where: "docs" });
}
writeFileSync(join(runDir, "missing.jsonl"), missing.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
for (const entry of missing) process.stdout.write(`c2: ${entry.operation} is missing in ${entry.where}\n`);
process.stdout.write(`c2: operations=${ir.operations.length} surfaces=${ALL_SURFACES.join(",")},docs\n`);
process.stdout.write(`faltantes=${missing.length}\n`);
process.exit(missing.length === 0 ? 0 : 1);
