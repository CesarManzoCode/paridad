// node verify/c24.ts <run dir>   (make verify C=c24)
// C24 (contract §5.6, §9, D14): for each template of verify/react-email/ with its
// example props (<template>.props.json), writes the output of `render` of
// @react-email/render in reference/<template>.html, and sends the same template, with
// case react-email:<template>, to the capture server with the TypeScript SDK
// (emails.send with `react`, surface ts) and with the CLI (`paridad emails send
// --react <file.tsx> --react-props <json>`, surface cli). Writes captures.jsonl,
// results.jsonl (§8), failures.jsonl and
// out/react-email_<template>.cli.stdout|stderr. Exits 0 only if the `html` field
// that each surface sent is byte for byte the reference.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { caseFile, TEST_KEY, type CaseCapture } from "./cases.ts";
import { loadTemplate, renderTemplate, TEMPLATES, templateFile, templateProps } from "./cli-docs-email.ts";
import { runCommand } from "./command.ts";
import type { ResultLine } from "./surfaces.ts";

const ROOT = resolve(import.meta.dirname, "..");

// The SDK is imported by URL so that the type check of verify/ does not pull the
// generated SDK under its own tsconfig (as harness/oracle/ts.ts does).
interface SendResult {
  data: unknown;
  error: { code: string; message: string; statusCode: number | null } | null;
}
const sdk = (await import(new URL("../sdks/typescript/src/index.ts", import.meta.url).href)) as {
  Resend: new (key: string, options: { baseUrl: string }) => { emails: { send(body: Record<string, unknown>): Promise<SendResult> } };
};

interface Failure {
  case: string;
  surface: string;
  reason: string;
}

// The rest of the emails/send body; the template fills `html`.
const MESSAGE = { from: "Acme <onboarding@resend.dev>", to: ["delivered@resend.dev"], subject: "paridad C24" };

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(join(runDir, "reference"), { recursive: true });
const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
const failures: Failure[] = [];
const results: ResultLine[] = [];

const references = new Map<string, string>();
for (const name of TEMPLATES) {
  const html = await renderTemplate(name);
  references.set(name, html);
  writeFileSync(join(runDir, "reference", `${name}.html`), html);
}

const capturesFile = join(runDir, "captures.jsonl");
const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const session = async (id: string, surface: string): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: "c24", case: id, surface }),
    });
    if (response.status !== 200) throw new Error(`session for ${id} ${surface}: ${response.status} ${await response.text()}`);
  };
  const { createElement } = await import("react");
  const resend = new sdk.Resend(TEST_KEY, { baseUrl });

  for (const name of TEMPLATES) {
    const id = `react-email:${name}`;
    await session(id, "ts");
    const component = await loadTemplate(templateFile(name));
    const sent = await resend.emails.send({ ...MESSAGE, react: createElement(component, templateProps(name)) });
    const error = sent.error === null ? null : { code: sent.error.code, message: sent.error.message, statusCode: sent.error.statusCode };
    results.push({ case: id, surface: "ts", outcome: error === null ? "ok" : "error", error, items: null, exit_code: null });
    if (sent.error !== null) failures.push({ case: id, surface: "ts", reason: `${sent.error.code}: ${sent.error.message}` });

    await session(id, "cli");
    const cli = await runCommand(
      [process.execPath, "cli/src/main.ts", "emails", "send", "--body", JSON.stringify(MESSAGE), "--react", templateFile(name), "--react-props", JSON.stringify(templateProps(name))],
      { cwd: ROOT, env: { ...process.env, RESEND_API_KEY: TEST_KEY, RESEND_BASE_URL: baseUrl }, out: join(out, `${caseFile(id)}.cli`) },
    );
    const shown = cli.code === 0 ? null : cliError(cli.stdout);
    results.push({ case: id, surface: "cli", outcome: cli.code === 0 ? "ok" : "error", error: shown, items: null, exit_code: cli.code });
    if (cli.code !== 0) failures.push({ case: id, surface: "cli", reason: `exit ${cli.code}; see out/${caseFile(id)}.cli.stderr` });
  }
} finally {
  await server.close();
}
writeFileSync(join(runDir, "results.jsonl"), results.map((line) => `${JSON.stringify(line)}\n`).join(""));

const captures = readFileSync(capturesFile, "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as CaseCapture);
for (const name of TEMPLATES) {
  const id = `react-email:${name}`;
  for (const surface of ["ts", "cli"]) {
    const sent = captures.filter((capture) => capture.case === id && capture.surface === surface);
    if (sent.length !== 1) {
      failures.push({ case: id, surface, reason: `${sent.length} requests, expected 1` });
      continue;
    }
    let html: unknown;
    try {
      html = (JSON.parse(Buffer.from(sent[0]!.body_b64, "base64").toString("utf8")) as Record<string, unknown>)["html"];
    } catch {
      html = undefined;
    }
    if (html !== references.get(name)) failures.push({ case: id, surface, reason: `the html sent is not the output of render (reference/${name}.html)` });
  }
}

writeFileSync(join(runDir, "failures.jsonl"), failures.map((failure) => `${JSON.stringify(failure)}\n`).join(""));
for (const failure of failures) process.stdout.write(`c24: ${failure.case} ${failure.surface}: ${failure.reason}\n`);
process.stdout.write(`c24: templates=${TEMPLATES.length} failures=${failures.length}\n`);
process.exit(failures.length === 0 ? 0 : 1);

// The error object that paridad prints on stdout (§5.2), or a placeholder when there is none.
function cliError(stdout: string): ResultLine["error"] {
  try {
    const error = (JSON.parse(stdout) as { error?: { code?: unknown; message?: unknown; statusCode?: unknown } }).error;
    if (error !== undefined) return { code: error.code, message: error.message, statusCode: error.statusCode ?? null };
  } catch {
    // Not JSON; reported below as cli_output.
  }
  return { code: "cli_output", message: "paridad printed no error object on stdout", statusCode: null };
}
