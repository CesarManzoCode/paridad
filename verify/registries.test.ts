import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { goModuleDir, pypiserverArgs, registryState, VERDACCIO_CONFIG, verdaccioArgs, versions } from "./registries.ts";

const NAMES = { npm: "paridad-resend", pypi: "paridad_resend", module: "github.com/CesarManzoCode/paridad/sdks/go" };

test("the Verdaccio configuration has no uplinks and listens only on 127.0.0.1", () => {
  const config = parse(readFileSync(VERDACCIO_CONFIG, "utf8")) as { listen: string; uplinks?: unknown; packages: Record<string, Record<string, unknown>> };
  assert.equal(config.uplinks, undefined);
  for (const [pattern, rule] of Object.entries(config.packages)) assert.equal(rule.proxy, undefined, `packages['${pattern}'] proxies to an uplink`);
  assert.match(config.listen, /^127\.0\.0\.1:\d+$/);
  const args = verdaccioArgs("/tmp/config.yaml", 4999);
  assert.equal(args[args.indexOf("--listen") + 1], "127.0.0.1:4999");
  const pypi = pypiserverArgs("/tmp/packages", 8999);
  assert.equal(pypi[pypi.indexOf("--host") + 1], "127.0.0.1");
});

test("the Go module path escapes each upper-case letter as ! and its lower case", () => {
  assert.equal(goModuleDir("/proxy", NAMES.module), "/proxy/github.com/!cesar!manzo!code/paridad/sdks/go/@v");
  assert.equal(goModuleDir("/proxy", "example.com/lower"), "/proxy/example.com/lower/@v");
});

function writeRegistries(dir: string): void {
  const storage = join(dir, "verdaccio/storage/paridad-resend");
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "package.json"), JSON.stringify({ name: "paridad-resend", versions: { "0.1.0": {} } }));
  writeFileSync(join(storage, "paridad-resend-0.1.0.tgz"), "npm");
  const packages = join(dir, "pypi/packages");
  mkdirSync(packages, { recursive: true });
  writeFileSync(join(packages, "paridad_resend-0.1.0.tar.gz"), "sdist");
  writeFileSync(join(packages, "paridad_resend-0.1.0-py3-none-any.whl"), "wheel");
  const go = goModuleDir(join(dir, "goproxy"), NAMES.module);
  mkdirSync(go, { recursive: true });
  for (const file of ["v0.1.0.info", "v0.1.0.mod", "v0.1.0.zip"]) writeFileSync(join(go, file), file);
  writeFileSync(join(go, "list"), "v0.1.0\n");
}

test("a complete registries directory has one version everywhere and no problems", () => {
  const dir = mkdtempSync(join(tmpdir(), "paridad-registries-"));
  try {
    writeRegistries(dir);
    const state = registryState(dir, NAMES);
    assert.deepEqual(state.problems, []);
    assert.equal(state.entries.length, 6);
    assert.deepEqual(versions(state), { npm: ["0.1.0"], pypi: ["0.1.0"], go: ["0.1.0"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the state reports a version without its tarball and a temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "paridad-registries-"));
  try {
    writeRegistries(dir);
    const storage = join(dir, "verdaccio/storage/paridad-resend");
    writeFileSync(join(storage, "package.json"), JSON.stringify({ name: "paridad-resend", versions: { "0.1.0": {}, "0.1.1": {} } }));
    writeFileSync(join(goModuleDir(join(dir, "goproxy"), NAMES.module), ".tmp-v0.1.1.zip-1234"), "half");
    const { problems } = registryState(dir, NAMES);
    assert.ok(problems.includes("npm paridad-resend@0.1.1 has no tarball paridad-resend-0.1.1.tgz"), problems.join("\n"));
    assert.ok(problems.includes("temporary file goproxy/github.com/!cesar!manzo!code/paridad/sdks/go/@v/.tmp-v0.1.1.zip-1234"), problems.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
