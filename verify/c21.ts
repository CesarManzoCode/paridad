// node verify/c21.ts <run dir>   (make verify C=c21)
// C21 (contract §9, §10): new registries in .paridad/registries/ (Verdaccio, pypiserver
// and the file GOPROXY of verify/registries.ts), one complete release of this tree with
// the release service (its queue in <run dir>/release), and then one smoke test per
// language from an isolated environment without caches, which installs the released
// version from the local registry and calls domains/list against a capture server
// (harness/capture):
// - typescript: `npm install paridad-resend@<v> --registry <verdaccio>` with a temporary
//   cache and an empty userconfig, then `node smoke.mjs`.
// - python: a new venv, `pip install --no-cache-dir --index-url <pypiserver>/simple/
//   paridad-resend==<v>`, then `python -I smoke.py`.
// - go: `go get <module>@v<v>` with GOPROXY=file://…, GOSUMDB=off and temporary
//   GOMODCACHE and GOCACHE, then `go run .`.
// Writes smoke.jsonl ({"language","version","exit_code"}), state.json (the registries
// state), captures.jsonl, out/ and failures.jsonl. Exits 0 only if the release is done,
// the three registries hold that same version and nothing else, the state has no
// problem, and every smoke test exits 0 and reaches the capture server.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IR } from "../generator/src/ir.ts";
import { startCaptureServer } from "../harness/capture/server.ts";
import { runCommand } from "./command.ts";
import { registryState, releaseNames, releaseOnce, startRegistries, versions, type Names, type Registries } from "./registries.ts";

const ROOT = resolve(import.meta.dirname, "..");
const KEY = "re_paridad_test_9f8e7d6c5b4a39281706";
const LANGUAGES = ["typescript", "python", "go"] as const;
type Language = (typeof LANGUAGES)[number];
const SURFACE: Record<Language, string> = { typescript: "ts", python: "python", go: "go" };

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const smokeFile = join(runDir, "smoke.jsonl");
writeFileSync(smokeFile, "");
const failures: string[] = [];
const work = mkdtempSync(join(tmpdir(), "paridad-c21-"));

const SMOKE_TS = `import { Resend } from "paridad-resend";
const resend = new Resend(process.env.RESEND_API_KEY, { baseUrl: process.env.RESEND_BASE_URL });
const { error } = await resend.domains.list();
if (error !== null) {
  console.error(JSON.stringify(error));
  process.exit(1);
}
console.log("ok");
`;

const SMOKE_PY = `import os

from paridad_resend import Resend

Resend(os.environ["RESEND_API_KEY"], base_url=os.environ["RESEND_BASE_URL"]).domains.list()
print("ok")
`;

function smokeGo(module: string): string {
  return `package main

import (
	"context"
	"fmt"
	"os"

	resend "${module}"
)

func main() {
	client, err := resend.NewClient(resend.WithAPIKey(os.Getenv("RESEND_API_KEY")), resend.WithBaseURL(os.Getenv("RESEND_BASE_URL")))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err := client.Domains.List(context.Background(), nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("ok")
}
`;
}

// The environment of this runner without the variables that would point an installer
// at another registry, index, proxy or cache.
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(npm_config_|NPM_CONFIG_|PIP_|GO|PYTHON|VIRTUAL_ENV$|PARIDAD_)/.test(name)) continue;
    env[name] = value;
  }
  return env;
}

// The steps of the smoke test of `language`, run in a new directory under the temporary one.
function smokeSteps(language: Language, dir: string, registries: Registries, names: Names, version: string, base: NodeJS.ProcessEnv): { steps: string[][]; env: NodeJS.ProcessEnv } {
  if (language === "typescript") {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "paridad-smoke", private: true, type: "module" })}\n`);
    writeFileSync(join(dir, "npmrc"), "");
    writeFileSync(join(dir, "smoke.mjs"), SMOKE_TS);
    const npm = ["--registry", registries.verdaccio.url, "--cache", join(dir, "npm-cache"), "--userconfig", join(dir, "npmrc"), "--no-audit", "--no-fund"];
    return { steps: [["npm", "install", `${names.npm}@${version}`, ...npm], [process.execPath, "smoke.mjs"]], env: base };
  }
  if (language === "python") {
    writeFileSync(join(dir, "smoke.py"), SMOKE_PY);
    const venv = join(dir, "venv");
    const pip = [join(venv, "bin/python"), "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "--index-url", `${registries.pypi.url}simple/`, `paridad-resend==${version}`];
    return { steps: [["python3", "-m", "venv", venv], pip, [join(venv, "bin/python"), "-I", "smoke.py"]], env: { ...base, PIP_CONFIG_FILE: devNull } };
  }
  writeFileSync(join(dir, "main.go"), smokeGo(names.module));
  const env = {
    ...base,
    GOPROXY: `file://${registries.goproxy}`,
    GOSUMDB: "off",
    GOMODCACHE: join(dir, "gomodcache"),
    GOCACHE: join(dir, "gocache"),
    GOPATH: join(dir, "gopath"),
    GOFLAGS: "-modcacherw",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
  };
  return { steps: [["go", "mod", "init", "paridad.local/smoke"], ["go", "get", `${names.module}@v${version}`], ["go", "run", "."]], env };
}

async function main(): Promise<void> {
  const names = releaseNames();
  const registries = await startRegistries(join(ROOT, ".paridad/registries"), out);
  try {
    const job = await releaseOnce({ workdir: join(runDir, "release"), registries }, out);
    if (job.version === null) {
      failures.push(`release job ${job.id} failed: ${job.error}`);
      return;
    }
    const version = job.version;
    const state = registryState(registries.dir, names);
    writeFileSync(join(runDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    for (const problem of state.problems) failures.push(`registries: ${problem}`);
    for (const [registry, held] of Object.entries(versions(state))) {
      if (held.length !== 1 || held[0] !== version) failures.push(`${registry} holds ${held.join(", ") || "nothing"}, expected only ${version}`);
    }

    const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as IR;
    const capturesFile = join(runDir, "captures.jsonl");
    const server = await startCaptureServer({ port: 0, controlPort: 0, out: capturesFile, ir });
    try {
      const base = { ...cleanEnv(), RESEND_API_KEY: KEY, RESEND_BASE_URL: `http://127.0.0.1:${server.port}` };
      for (const language of LANGUAGES) {
        const session = await fetch(`http://127.0.0.1:${server.controlPort}/__paridad/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: "c21", case: "smoke", surface: SURFACE[language] }),
        });
        if (session.status !== 200) throw new Error(`session for ${language}: ${session.status} ${await session.text()}`);
        const dir = join(work, language);
        mkdirSync(dir, { recursive: true });
        const { steps, env } = smokeSteps(language, dir, registries, names, version, base);
        let exitCode: number | null = 0;
        for (const [index, step] of steps.entries()) {
          const result = await runCommand(step, { cwd: dir, out: join(out, `smoke.${language}.${index}`), env });
          if (result.code !== 0) {
            exitCode = result.code;
            break;
          }
        }
        appendFileSync(smokeFile, `${JSON.stringify({ language, version, exit_code: exitCode })}\n`);
        if (exitCode !== 0) failures.push(`smoke test of ${language} exited ${exitCode}; see out/smoke.${language}.*`);
      }
    } finally {
      await server.close();
    }
    const captured = readFileSync(capturesFile, "utf8").split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { surface: string | null }).surface);
    for (const language of LANGUAGES) {
      if (!captured.includes(SURFACE[language])) failures.push(`the smoke test of ${language} sent no request to the capture server`);
    }
    process.stdout.write(`c21: version ${version}, ${state.entries.length} artifacts, failures=${failures.length}\n`);
  } finally {
    await registries.stop();
  }
}

try {
  await main();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(runDir, "failures.jsonl"), failures.map((reason) => `${JSON.stringify({ reason })}\n`).join(""));
for (const reason of failures) process.stderr.write(`c21: ${reason}\n`);
process.exit(failures.length === 0 ? 0 : 1);
