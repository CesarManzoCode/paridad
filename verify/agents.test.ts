// The pieces of the runners for agents: the conformance baseline of C13, the
// invalid variants of the corpus of C14 and the extractor of skill commands of C15.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { createValidator, requestSchemaOf, type IR } from "../generator/src/ir.ts";
import { FORBIDDEN_SCENARIOS, baselineProblems, cliCommands, corpusOf, readBaseline, skillCommands, toolArguments } from "./agents.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;

test("the baseline lists no forbidden scenario and gives a reason for each entry", () => {
  const text = readFileSync(join(ROOT, "verify/mcp-conformance-baseline.yml"), "utf8");
  const entries = readBaseline(text);
  assert.ok(entries.length > 0);
  assert.deepEqual(baselineProblems(entries), []);
  for (const entry of entries) {
    assert.ok(!FORBIDDEN_SCENARIOS.includes(entry.scenario), entry.scenario);
    assert.notEqual(entry.reason, "", `${entry.scenario} has no reason`);
  }
  // The reader sees the same list as a YAML parser, like the framework does.
  assert.deepEqual(entries.map((entry) => entry.scenario), (parse(text) as { server: string[] }).server);
});

test("the baseline reader flags forbidden scenarios, missing reasons and repeated entries", () => {
  const entries = readBaseline("server:\n  - ping  # reason\n  - tools-call-image\n  - tools-call-image  # again\nclient:\n  - initialize  # not a server scenario\n");
  assert.deepEqual(entries.map((entry) => entry.scenario), ["ping", "tools-call-image", "tools-call-image"]);
  assert.deepEqual(baselineProblems(entries), [
    "ping may never be an expected failure",
    "tools-call-image has no # reason",
    "tools-call-image is listed twice",
  ]);
});

test("every invalid variant of every operation is rejected by the request schema of the spec", () => {
  const validate = createValidator(ir.schemas, ir.operations);
  const kinds = new Set<string>();
  for (const op of ir.operations) {
    const [example, ...variants] = corpusOf(op, ir.schemas);
    assert.equal(example!.label, "example");
    assert.equal(validate(requestSchemaOf(op), example!.request), null, `${op.id} example`);
    assert.ok(variants.length > 0, `${op.id} has no invalid variant`);
    for (const variant of variants) {
      kinds.add(variant.label.split(":")[0]!);
      assert.notEqual(validate(requestSchemaOf(op), variant.request), null, `${op.id} ${variant.label} is accepted by the spec`);
    }
  }
  assert.deepEqual([...kinds].sort(), ["missing", "type", "unknown"]);
});

test("the variants of emails/send remove the body and a required property and add an unknown query parameter", () => {
  const op = ir.operations.find((candidate) => candidate.id === "emails/send")!;
  const labels = corpusOf(op, ir.schemas).map((variant) => variant.label);
  for (const label of ["example", "missing:body", "missing:body.from", "type:body", "unknown:query"]) assert.ok(labels.includes(label), label);
  const missingBody = corpusOf(op, ir.schemas).find((variant) => variant.label === "missing:body")!;
  assert.equal("body" in toolArguments(op, missingBody.request), false);
});

test("tool arguments carry path, query, the idempotency key and the body", () => {
  const op = ir.operations.find((candidate) => candidate.id === "emails/send")!;
  const args = toolArguments(op, { path: {}, query: { extra: 1 }, headers: { "Idempotency-Key": "k" }, body: { a: 1 } });
  assert.deepEqual(args, { extra: 1, idempotency_key: "k", body: { a: 1 } });
});

test("the skill extractor finds the bash blocks and joins continued lines", () => {
  const markdown = [
    "# Skill",
    "",
    "Text that mentions paridad emails send outside a block.",
    "",
    "```bash",
    "paridad config show",
    "```",
    "",
    "```bash",
    "paridad emails send --from 'a@b.c' \\",
    "  --to '[\"d@e.f\"]'",
    "echo not a command",
    "```",
    "",
    "```json",
    "{\"paridad\": true}",
    "```",
  ].join("\n");
  assert.deepEqual(skillCommands(markdown), [
    { language: "bash", line: 6, command: "paridad config show" },
    { language: "bash", line: 10, command: "paridad emails send --from 'a@b.c' --to '[\"d@e.f\"]'" },
  ]);
});

test("the extractor finds a command in every bash block of the generated skill, and every CLI command is there", () => {
  const markdown = readFileSync(join(ROOT, "skill/paridad-resend/SKILL.md"), "utf8");
  const commands = skillCommands(markdown);
  const bashBlocks = markdown.split("\n").filter((line) => line.trim() === "```bash").length;
  assert.ok(bashBlocks > 0);
  assert.equal(new Set(commands.filter((item) => item.language === "bash").map((item) => item.line)).size >= bashBlocks, true);
  for (const name of cliCommands(ir.operations)) {
    assert.ok(commands.some((item) => item.command === name || item.command.startsWith(`${name} `)), name);
  }
});
