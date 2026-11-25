#!/usr/bin/env node
// node release/src/main.ts serve --port <p> | enqueue | status [options]
// (vault/CONTRACT.md §9.3, §10)
//
//   serve    processes the queue and serves /metrics on 127.0.0.1:<p>
//   enqueue  enqueues a release of the current tree of this repository
//   status   prints the jobs table, one JSON object per line
//
// Each option falls back to its environment variable and then to the default:
//   --workdir       PARIDAD_RELEASE_WORKDIR       .paridad/release (queue.sqlite and jobs/)
//   --npm-registry  PARIDAD_RELEASE_NPM_REGISTRY  http://127.0.0.1:4873/ (Verdaccio)
//   --pypi-url      PARIDAD_RELEASE_PYPI_URL      http://127.0.0.1:8080/ (pypiserver)
//   --goproxy-dir   PARIDAD_RELEASE_GOPROXY_DIR   .paridad/registries/goproxy
//   --python        PARIDAD_RELEASE_PYTHON        .venv/bin/python (with build and twine)
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { enqueue, openQueue, serve, type Config } from "./service.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const USAGE = "Usage: node release/src/main.ts serve --port <p> | enqueue | status [--workdir <dir>] [--npm-registry <url>] [--pypi-url <url>] [--goproxy-dir <dir>] [--python <file>]";

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string" },
        workdir: { type: "string" },
        "npm-registry": { type: "string" },
        "pypi-url": { type: "string" },
        "goproxy-dir": { type: "string" },
        python: { type: "string" },
      },
    });
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

const { values, positionals } = parse();
const env = process.env;
const config: Config = {
  workdir: resolve(values.workdir ?? env.PARIDAD_RELEASE_WORKDIR ?? resolve(ROOT, ".paridad/release")),
  npmRegistry: values["npm-registry"] ?? env.PARIDAD_RELEASE_NPM_REGISTRY ?? "http://127.0.0.1:4873/",
  pypiUrl: values["pypi-url"] ?? env.PARIDAD_RELEASE_PYPI_URL ?? "http://127.0.0.1:8080/",
  goproxy: resolve(values["goproxy-dir"] ?? env.PARIDAD_RELEASE_GOPROXY_DIR ?? resolve(ROOT, ".paridad/registries/goproxy")),
  python: resolve(values.python ?? env.PARIDAD_RELEASE_PYTHON ?? resolve(ROOT, ".venv/bin/python")),
};

const command = positionals[0];
if (positionals.length !== 1) usage("Expected one command.");
if (command === "serve") {
  if (values.port === undefined || !/^\d+$/.test(values.port) || Number(values.port) > 65535) usage("serve needs --port <0-65535>.");
  await serve(config, Number(values.port));
} else if (command === "enqueue") {
  const job = enqueue(config, ROOT);
  process.stdout.write(`${JSON.stringify(job)}\n`);
} else if (command === "status") {
  const queue = openQueue(config);
  for (const job of queue.list()) process.stdout.write(`${JSON.stringify(job)}\n`);
  queue.close();
} else {
  usage(`Unknown command: ${String(command)}`);
}
