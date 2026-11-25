#!/usr/bin/env node
// `node compat/src/main.ts <base.yaml> <revision.yaml> [--json]`, also run as
// `paridad contract-check` (vault/CONTRACT.md §10, C25). Prints the affected operations,
// their surfaces, the semver bump of the contract and every change with the oasdiff
// checks it follows; exits 0 when the revision is compatible, 1 when it breaks and 2
// on a usage or loading error.
import { loadSpec } from "../../generator/src/spec.ts";
import { compareSpecs, report, type Report } from "./rules.ts";

const USAGE = "Usage: node compat/src/main.ts <base.yaml> <revision.yaml> [--json]";

function text(result: Report): string {
  const lines = [`${result.classification} (bump: ${result.bump})`];
  lines.push(result.operations.length === 0 ? "Affected operations: none" : "Affected operations:");
  for (const { operation, operationId, surfaces } of result.surfaces) {
    lines.push(`  ${operation}${operationId === null ? "" : ` (${operationId})`}: ${surfaces.join(", ")}`);
  }
  if (result.changes.length > 0) lines.push("Changes:");
  for (const change of result.changes) {
    lines.push(`  ${change.level.padEnd(4)} ${change.rule}  ${change.operation ?? "-"}  ${change.detail}  [oasdiff: ${change.oasdiff.join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const files = args.filter((arg) => arg !== "--json");
if (files.length !== 2 || files.some((file) => file.startsWith("-"))) {
  if (json) process.stdout.write(`${JSON.stringify({ error: { message: USAGE, code: "invalid_usage", statusCode: null } }, null, 2)}\n`);
  else process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
} else {
  try {
    const result = report(compareSpecs(loadSpec(files[0]!), loadSpec(files[1]!)));
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : text(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: { message, code: "invalid_spec", statusCode: null } }, null, 2)}\n`);
    else process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 2;
  }
}
