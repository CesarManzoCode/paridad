// Compatibility corpus (vault/CONTRACT.md §10, D04, D11): every synthetic patch applies
// to the pinned spec and gives parseable YAML, history.json names commits of the
// bundle, and the materializer writes both sides of a history and a synthetic pair.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { parse } from "yaml";
import { parseSpec } from "../../generator/src/spec.ts";
import { applyPatch, materialize, readHistory, readPatch, readSynthetic, syntheticPair } from "./materialize.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLE = join(ROOT, "verify/corpus/resend-openapi.bundle");
const scratch = mkdtempSync(join(tmpdir(), "paridad-corpus-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The bytes of the pinned spec. spec/PIN carries a `patch:` line when the local patch of
// C26 (verify/c26/add-operation.patch) changed spec/resend.yaml: then they come from a
// copy of spec/ with that patch reverted.
function pinnedSpec(file: string): Buffer {
  if (!/^patch: /m.test(readFileSync(join(ROOT, "spec/PIN"), "utf8"))) return readFileSync(join(ROOT, file));
  const copy = mkdtempSync(join(scratch, "pinned-"));
  cpSync(join(ROOT, "spec"), join(copy, "spec"), { recursive: true });
  execFileSync("git", ["apply", "--reverse", join(ROOT, "verify/c26/add-operation.patch")], { cwd: copy });
  return readFileSync(join(copy, file));
}

test("synthetic.json lists at least 24 patches over the pinned spec", () => {
  const synthetic = readSynthetic();
  const spec = pinnedSpec(synthetic.spec);
  assert.equal(createHash("sha256").update(spec).digest("hex"), synthetic.sha256);
  assert.ok(synthetic.patches.length >= 24, `${synthetic.patches.length} patches`);
  assert.equal(new Set(synthetic.patches.map((patch) => patch.id)).size, synthetic.patches.length);
  for (const patch of synthetic.patches) assert.equal(patch.file, `synthetic/${patch.id}.json`);
});

test("every synthetic patch applies to the pinned spec and gives parseable YAML that changes it", () => {
  const synthetic = readSynthetic();
  const spec = readFileSync(join(ROOT, synthetic.spec), "utf8");
  const original = JSON.stringify(parse(spec));
  for (const patch of synthetic.patches) {
    const text = `${JSON.stringify(applyPatch(parse(spec), readPatch(patch)), null, 2)}\n`;
    const document: unknown = parse(text);
    assert.notEqual(JSON.stringify(document), original, patch.id);
    assert.doesNotThrow(() => parseSpec(text), patch.id);
  }
});

test("applyPatch follows RFC 6902 for add, remove, replace, move, copy and test", () => {
  const document = { a: { b: [1, 2] }, "c/d": "x" };
  applyPatch(document, [
    { op: "add", path: "/a/b/-", value: 3 },
    { op: "add", path: "/a/b/0", value: 0 },
    { op: "remove", path: "/a/b/1" },
    { op: "replace", path: "/c~1d", value: "y" },
    { op: "copy", from: "/a/b", path: "/e" },
    { op: "move", from: "/c~1d", path: "/f" },
    { op: "test", path: "/f", value: "y" },
  ]);
  assert.deepEqual(document, { a: { b: [0, 2, 3] }, e: [0, 2, 3], f: "y" });
  assert.throws(() => applyPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }]));
  assert.throws(() => applyPatch({ a: 1 }, [{ op: "remove", path: "/b" }]));
  assert.throws(() => applyPatch({ a: [] }, [{ op: "replace", path: "/a/0", value: 1 }]));
});

test("history.json names commits present in the bundle", () => {
  const history = readHistory();
  const heads = execFileSync("git", ["bundle", "list-heads", BUNDLE], { encoding: "utf8" });
  assert.ok(heads.includes(`${history.head} ${history.ref}`), heads);
  const clone = join(scratch, "bundle.git");
  execFileSync("git", ["clone", "--quiet", "--bare", BUNDLE, clone]);
  const commits = new Set(execFileSync("git", ["--git-dir", clone, "rev-list", history.ref], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n"));
  for (const entry of history.pairs) {
    assert.ok(commits.has(entry.base), `${entry.pair}: base ${entry.base}`);
    assert.ok(commits.has(entry.revision), `${entry.pair}: revision ${entry.revision}`);
    assert.equal(entry.reason === null, entry.status === "included", entry.pair);
  }
  for (let index = 1; index < history.pairs.length; index++) {
    assert.equal(history.pairs[index]!.base, history.pairs[index - 1]!.revision, history.pairs[index]!.pair);
  }
  assert.ok(history.pairs.filter((entry) => entry.status === "included").length >= 85);
});

test("the materializer writes both sides of a history pair and of a synthetic pair", () => {
  const history = readHistory().pairs.find((entry) => entry.status === "included")!;
  const synthetic = syntheticPair(readSynthetic().patches[0]!);
  for (const pair of [history.pair, synthetic]) {
    const files = materialize(pair);
    assert.equal(files.base, join(ROOT, ".paridad/corpus", pair, "base.yaml"));
    assert.equal(files.revision, join(ROOT, ".paridad/corpus", pair, "revision.yaml"));
    for (const file of [files.base, files.revision]) {
      assert.ok(existsSync(file), file);
      assert.doesNotThrow(() => parse(readFileSync(file, "utf8")), file);
    }
    assert.notEqual(readFileSync(files.base, "utf8"), readFileSync(files.revision, "utf8"), pair);
  }
  const clone = join(scratch, "show.git");
  execFileSync("git", ["clone", "--quiet", "--bare", BUNDLE, clone]);
  const expected = execFileSync("git", ["--git-dir", clone, "show", `${history.revision}:${readHistory().path}`]);
  assert.deepEqual(readFileSync(join(ROOT, ".paridad/corpus", history.pair, "revision.yaml")), expected);
});
