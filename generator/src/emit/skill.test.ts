import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parse } from "yaml";
import type { IR } from "../ir.ts";
import { CONTRACT_CHECK, exampleCommand, emitSkill, shellWord } from "./skill.ts";

const ROOT = join(import.meta.dirname, "../../..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function emit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paridad-skill-"));
  dirs.push(dir);
  emitSkill(ir, dir);
  return readFileSync(join(dir, "skill/paridad-resend/SKILL.md"), "utf8");
}

const skill = emit();

// The lines of every ```bash block.
function bashLines(markdown: string): string[] {
  return [...markdown.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].flatMap((match) => match[1]!.split("\n"));
}

// Text without the string values of the operation's first example, in the forms
// the command line writes them.
function withoutExampleValues(text: string, values: string[]): string {
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    for (const form of [shellWord(value), JSON.stringify(value).slice(1, -1), value]) text = text.split(form).join("");
  }
  return text;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("the frontmatter has a valid Agent Skills name equal to the directory and a 1 to 1024 character description", () => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(match !== null, "SKILL.md starts with a frontmatter");
  const frontmatter = parse(match[1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(frontmatter).sort(), ["description", "name"]);
  const name = frontmatter["name"];
  assert.equal(name, "paridad-resend");
  // Agent Skills specification: 1 to 64 characters, lowercase letters, digits and
  // hyphens, no hyphen at either end and no two hyphens in a row.
  assert.ok(typeof name === "string" && name.length >= 1 && name.length <= 64);
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  const description = frontmatter["description"];
  assert.ok(typeof description === "string" && description.length >= 1 && description.length <= 1024);
});

test("every operation has its command, with its first example, in a bash block, and its operationId", () => {
  const lines = new Set(bashLines(skill));
  for (const op of ir.operations) {
    assert.ok(skill.includes(`### ${op.names.cli}\n`), `${op.id}: section`);
    assert.ok(skill.includes(`\`${op.id}\``), `${op.id}: operationId`);
    assert.ok(lines.has(exampleCommand(op, ir)), `${op.id}: ${exampleCommand(op, ir)}`);
  }
});

test("config show, and contract-check once compat/ exists, have their own bash blocks", () => {
  const lines = bashLines(skill);
  assert.equal(lines.includes("paridad contract-check spec/resend.yaml spec/resend.yaml"), CONTRACT_CHECK);
  assert.ok(lines.includes("paridad config show"));
});

test("every bash line is a paridad command with no placeholder", () => {
  const values = ir.operations.flatMap((op) => strings(op.examples[0]));
  for (const line of bashLines(skill)) {
    assert.match(line, /^paridad /);
    const rest = withoutExampleValues(line, values);
    assert.doesNotMatch(rest, /<[^<>\s]*>|\.\.\.|\bTODO\b|\bYOUR_/i, line);
  }
});

test("the output is deterministic", () => {
  assert.equal(emit(), skill);
});
