#!/usr/bin/env node
// Entry point of the `paridad` binary: node cli/src/main.ts <resource> <action> [flags].
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
