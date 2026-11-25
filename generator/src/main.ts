// node generator/src/main.ts [--spec <file>] [--out <dir>]
// Without arguments: spec/resend.yaml + ir/overlay.yaml -> ir/ir.json, then every emitter.
// With --spec (compatibility corpus) the spec is not the pinned one: overlay entries
// for operations it lacks are skipped, and overlay examples that do not validate
// against it are replaced by synthesized ones.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emitCli } from "./emit/cli.ts";
import { emitDocs } from "./emit/docs.ts";
import { emitGo } from "./emit/go.ts";
import { emitMcp } from "./emit/mcp.ts";
import { emitPython } from "./emit/python.ts";
import { emitSkill } from "./emit/skill.ts";
import { emitTypescript } from "./emit/typescript.ts";
import { buildIR, loadOverlay, serializeIR, type IR } from "./ir.ts";
import { loadSpec, readPin } from "./spec.ts";

const ROOT = resolve(import.meta.dirname, "../..");

// An emitter writes one surface under `outDir` from the IR.
type Emitter = (ir: IR, outDir: string) => void;

// In this order: TypeScript SDK, Python SDK, Go SDK, CLI, MCP, skill, docs.
const emitters: Emitter[] = [emitTypescript, emitPython, emitGo, emitCli, emitMcp, emitSkill, emitDocs];

function main(): void {
  const { values } = parseArgs({ options: { spec: { type: "string" }, out: { type: "string" } }, strict: true });
  const specFile = values.spec === undefined ? join(ROOT, "spec/resend.yaml") : resolve(values.spec);
  const outDir = values.out === undefined ? ROOT : resolve(values.out);
  const ir = buildIR({
    spec: loadSpec(specFile),
    overlay: loadOverlay(join(ROOT, "ir/overlay.yaml")),
    pin: values.spec === undefined ? readPin(join(ROOT, "spec/PIN")) : null,
    lenientOverlay: values.spec !== undefined,
  });
  const irFile = join(outDir, "ir/ir.json");
  mkdirSync(dirname(irFile), { recursive: true });
  writeFileSync(irFile, serializeIR(ir));
  for (const emit of emitters) emit(ir, outDir);
}

try {
  main();
} catch (error) {
  process.stderr.write(`generator: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
