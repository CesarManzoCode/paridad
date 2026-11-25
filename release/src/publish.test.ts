// Publication to the file GOPROXY: atomic writes, cleanup of temporary files and
// idempotency. The npm and PyPI steps, which need a registry, are in service.test.ts.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { escapeModule, publishGo, writeAtomic } from "./publish.ts";

const MODULE = "github.com/CesarManzoCode/paridad/sdks/go";
const dir = mkdtempSync(join(tmpdir(), "paridad-publish-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let runs = 0;
function setup(version: string): { goproxy: string; buildDir: string; files: string[]; atV: string } {
  const root = join(dir, `run-${++runs}`);
  const buildDir = join(root, "build");
  mkdirSync(buildDir, { recursive: true });
  const files = [`v${version}.mod`, `v${version}.zip`, `v${version}.info`];
  writeFileSync(join(buildDir, files[0]!), `module ${MODULE}\n\ngo 1.23\n`);
  writeFileSync(join(buildDir, files[1]!), `zip of ${version}`);
  writeFileSync(join(buildDir, files[2]!), `{"Version":"v${version}","Time":"2026-11-25T20:52:51Z"}\n`);
  const goproxy = join(root, "goproxy");
  return { goproxy, buildDir, files, atV: join(goproxy, "github.com/!cesar!manzo!code/paridad/sdks/go/@v") };
}

function temporaries(path: string): string[] {
  return readdirSync(path, { recursive: true, encoding: "utf8" }).filter((entry) => /(^|\/)\.tmp|\.tmp$|\.partial$/.test(entry));
}

test("module paths escape upper-case letters", () => {
  assert.equal(escapeModule(MODULE), "github.com/!cesar!manzo!code/paridad/sdks/go");
});

test("a version is published with its files, then the list, without temporary files", () => {
  const { goproxy, buildDir, files, atV } = setup("0.1.0");
  const outcomes = publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files });
  assert.deepEqual(outcomes, { "v0.1.0.mod": "published", "v0.1.0.zip": "published", "v0.1.0.info": "published", list: "published" });
  for (const file of files) assert.deepEqual(readFileSync(join(atV, file)), readFileSync(join(buildDir, file)));
  assert.equal(readFileSync(join(atV, "list"), "utf8"), "v0.1.0\n");
  assert.deepEqual(temporaries(goproxy), []);
});

test("publishing the same build again changes nothing", () => {
  const { goproxy, buildDir, files, atV } = setup("0.1.0");
  publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files });
  const outcomes = publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files });
  assert.deepEqual(outcomes, { "v0.1.0.mod": "existing", "v0.1.0.zip": "existing", "v0.1.0.info": "existing", list: "existing" });
  assert.equal(readFileSync(join(atV, "list"), "utf8"), "v0.1.0\n");
});

test("a published file with another sha256 fails and stays as it was", () => {
  const { goproxy, buildDir, files, atV } = setup("0.1.0");
  publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files });
  writeFileSync(join(buildDir, "v0.1.0.zip"), "another zip");
  assert.throws(() => publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files }), /v0\.1\.0\.zip is already published with sha256/);
  assert.equal(readFileSync(join(atV, "v0.1.0.zip"), "utf8"), "zip of 0.1.0");
});

test("temporary files left by a killed process are removed and a half publication completes", () => {
  const { goproxy, buildDir, files, atV } = setup("0.1.0");
  mkdirSync(atV, { recursive: true });
  // Killed after the .mod and in the middle of writing the .zip.
  writeFileSync(join(atV, "v0.1.0.mod"), readFileSync(join(buildDir, "v0.1.0.mod")));
  writeFileSync(join(atV, ".tmp-v0.1.0.zip-4242"), "zip o");
  const outcomes = publishGo({ goproxy, module: MODULE, version: "0.1.0", buildDir, files });
  assert.deepEqual(outcomes, { "v0.1.0.mod": "existing", "v0.1.0.zip": "published", "v0.1.0.info": "published", list: "published" });
  assert.equal(readFileSync(join(atV, "v0.1.0.zip"), "utf8"), "zip of 0.1.0");
  assert.deepEqual(temporaries(goproxy), []);
});

test("the list keeps the earlier versions in semver order", () => {
  const { goproxy, buildDir, files, atV } = setup("0.9.0");
  mkdirSync(atV, { recursive: true });
  writeFileSync(join(atV, "list"), "v0.10.0\nv0.2.0\n");
  publishGo({ goproxy, module: MODULE, version: "0.9.0", buildDir, files });
  assert.equal(readFileSync(join(atV, "list"), "utf8"), "v0.2.0\nv0.9.0\nv0.10.0\n");
});

test("writeAtomic renames a new file over the old one instead of writing into it", () => {
  const target = join(dir, "atomic", "list");
  mkdirSync(join(dir, "atomic"), { recursive: true });
  writeFileSync(target, "v0.1.0\n");
  // A hard link keeps the old inode: an in-place write would change it too.
  linkSync(target, join(dir, "atomic", "old"));
  writeAtomic(target, "v0.1.0\nv0.2.0\n");
  assert.equal(readFileSync(target, "utf8"), "v0.1.0\nv0.2.0\n");
  assert.equal(readFileSync(join(dir, "atomic", "old"), "utf8"), "v0.1.0\n");
  assert.deepEqual(temporaries(join(dir, "atomic")), []);
  assert.ok(!existsSync(join(dir, "atomic", `.tmp-list-${process.pid}`)));
});
