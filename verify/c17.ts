// node verify/c17.ts <run dir>   (make verify C=c17)
// C17 (contract §6, §9): extracts every `<code class="language-…" data-operation-id="…">`
// of docs/ and runs it, unedited, against the capture server with case
// docs:<operationId>#<language>: TypeScript with Node and the SDK of the workspace
// (the file lives in a temporary directory under verify/, where paridad-resend
// resolves), Python with .venv and sdks/python/src on PYTHONPATH, Go in a temporary
// module with a replace to sdks/go, and bash with `paridad` on PATH as the CLI. To
// have the reference of each operation it also runs the case <operationId>#example
// with the TypeScript driver, as C5 does. Writes captures.jsonl, results.jsonl
// ({"operation","language","exit_code"}), reference.jsonl (result lines of the
// reference), failures.jsonl and out/ (docs_<operationId>_<language>.stdout|stderr,
// vnu.stdout|stderr, vnu.json, links.jsonl); runs `java -jar
// node_modules/vnu-jar/build/dist/vnu.jar --errors-only --skip-non-html docs` and
// checks the internal links. Exits 0 only if every example exits 0 and sends the same
// normalized requests as the reference of its operation, vnu exits 0 and no internal
// link is broken.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { differences, normalize } from "../harness/normalize.ts";
import { caseFile, exampleCases, TEST_KEY, type CaseCapture } from "./cases.ts";
import { brokenLinks, docExamples, type DocExample } from "./cli-docs-email.ts";
import { runCommand } from "./command.ts";
import { runBattery } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs");

interface Failure {
  case: string;
  reason: string;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const pages = new Map(
  readdirSync(DOCS)
    .filter((file) => file.endsWith(".html"))
    .sort()
    .map((file) => [file, readFileSync(join(DOCS, file), "utf8")]),
);
const examples = [...pages.values()].flatMap((html) => docExamples(html));
const failures: Failure[] = [];
const docCase = (example: DocExample): string => `docs:${example.operation}#${example.language}`;

// The temporary places of the examples: TypeScript under verify/ so that the bare
// import of paridad-resend resolves; a Go module that replaces the SDK module with
// sdks/go; a bin directory with `paridad` for the bash examples.
const tsDir = mkdtempSync(join(ROOT, "verify/.c17-"));
const work = mkdtempSync(join(tmpdir(), "paridad-c17-"));
const goDir = join(work, "go");
const binDir = join(work, "bin");
mkdirSync(goDir);
mkdirSync(binDir);
writeFileSync(
  join(goDir, "go.mod"),
  `module paridad.local/docs\n\ngo 1.23\n\nrequire ${ir.project.go_module} v0.0.0\n\nreplace ${ir.project.go_module} => ${join(ROOT, "sdks/go")}\n`,
);
writeFileSync(join(binDir, "paridad"), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "cli/src/main.ts")}" "$@"\n`);
chmodSync(join(binDir, "paridad"), 0o755);

// Writes an example where its language runs it and returns the command that does.
function exampleCommand(example: DocExample, env: NodeJS.ProcessEnv): { argv: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  switch (example.language) {
    case "typescript": {
      const file = join(tsDir, "example.mts");
      writeFileSync(file, example.code);
      return { argv: [process.execPath, file], cwd: ROOT, env };
    }
    case "python": {
      const file = join(work, "example.py");
      writeFileSync(file, example.code);
      return { argv: [join(ROOT, ".venv/bin/python"), file], cwd: work, env: { ...env, PYTHONPATH: join(ROOT, "sdks/python/src") } };
    }
    case "go":
      writeFileSync(join(goDir, "main.go"), example.code);
      return { argv: ["go", "run", "."], cwd: goDir, env: { ...env, GOWORK: "off", GOFLAGS: "-mod=mod" } };
    case "bash": {
      const file = join(work, "example.sh");
      writeFileSync(file, example.code);
      return { argv: ["bash", file], cwd: ROOT, env: { ...env, PATH: `${binDir}:${env["PATH"] ?? ""}` } };
    }
  }
}

const results: { operation: string; language: string; exit_code: number | null }[] = [];
const capturesFile = join(runDir, "captures.jsonl");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
try {
  const env: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` };

  writeFileSync(join(runDir, "reference.jsonl"), "");
  await runBattery({
    run: "c17",
    cases: exampleCases(ir),
    surfaces: ["ts"],
    out,
    results: join(runDir, "reference.jsonl"),
    env,
    controlPorts: [server.controlPort],
    goDriver: "",
  });

  for (const example of examples) {
    const id = docCase(example);
    const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: "c17", case: id, surface: example.language }),
    });
    if (session.status !== 200) throw new Error(`session for ${id}: ${session.status} ${await session.text()}`);
    const command = exampleCommand(example, env);
    const result = await runCommand(command.argv, { cwd: command.cwd, env: command.env, out: join(out, caseFile(id)) });
    results.push({ operation: example.operation, language: example.language, exit_code: result.code });
    if (result.code !== 0) failures.push({ case: id, reason: `exit ${result.code}; see out/${caseFile(id)}.stderr` });
  }
} finally {
  await server.close();
  rmSync(tsDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(runDir, "results.jsonl"), results.map((line) => `${JSON.stringify(line)}\n`).join(""));

// The normalized requests of each docs case against those of <operationId>#example in ts.
const captures = readFileSync(capturesFile, "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as CaseCapture);
const requestsOf = (id: string, surface: string) =>
  captures
    .filter((capture) => capture.case === id && capture.surface === surface)
    .sort((a, b) => a.seq - b.seq)
    .map((capture) => normalize(capture));
for (const example of examples) {
  const id = docCase(example);
  const reference = requestsOf(`${example.operation}#example`, "ts");
  const sent = requestsOf(id, example.language);
  if (reference.length === 0) failures.push({ case: id, reason: `the reference ${example.operation}#example sent no request` });
  if (sent.length !== reference.length) failures.push({ case: id, reason: `${sent.length} requests, the reference sent ${reference.length}` });
  const fields = new Set<string>();
  for (let index = 0; index < Math.min(sent.length, reference.length); index++) for (const field of differences(reference[index]!, sent[index]!)) fields.add(field);
  if (fields.size > 0) failures.push({ case: id, reason: `differs from ${example.operation}#example in ${[...fields].sort().join(", ")}` });
}
const missing = ir.operations.flatMap((op) =>
  (["typescript", "python", "go", "bash"] as const).filter((language) => !examples.some((example) => example.operation === op.id && example.language === language)).map((language) => `docs:${op.id}#${language}`),
);
for (const id of missing) failures.push({ case: id, reason: "docs/ has no such example" });

const vnu = await runCommand(["java", "-jar", "node_modules/vnu-jar/build/dist/vnu.jar", "--errors-only", "--skip-non-html", "docs"], { cwd: ROOT, out: join(out, "vnu") });
writeFileSync(join(out, "vnu.json"), `${JSON.stringify({ exit_code: vnu.code })}\n`);
if (vnu.code !== 0) failures.push({ case: "vnu", reason: `exit ${vnu.code}; see out/vnu.stderr` });

const broken = brokenLinks(pages);
writeFileSync(join(out, "links.jsonl"), broken.map((link) => `${JSON.stringify(link)}\n`).join(""));
for (const link of broken) failures.push({ case: `link:${link.file}`, reason: `broken internal link ${link.href}` });

writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stdout.write(`c17: ${failure.case}: ${failure.reason}\n`);
process.stdout.write(`c17: examples=${examples.length} failures=${failures.length} vnu=${vnu.code} broken-links=${broken.length}\n`);
process.exit(examples.length > 0 && failures.length === 0 ? 0 : 1);
