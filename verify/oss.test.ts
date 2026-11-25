import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { addedOperationIds, EXCLUDED_DIRS, PRODUCT_PATHS, sccArgs, SUPPORT_PATHS, TEST_FILE_PATTERN } from "./oss.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PATCH = join(ROOT, "verify/c26/add-operation.patch");
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function operationIds(specFile: string): string[] {
  const spec = parse(readFileSync(specFile, "utf8")) as { paths: Record<string, Record<string, { operationId?: string }>> };
  return Object.values(spec.paths).flatMap((item) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([, op]) => op.operationId!),
  );
}

test("the C26 patch applies cleanly on a copy of spec/ and adds exactly one operation", () => {
  const work = mkdtempSync(join(tmpdir(), "paridad-oss-"));
  try {
    cpSync(join(ROOT, "spec"), join(work, "spec"), { recursive: true });
    // After `git apply` of the patch (C26), spec/PIN carries a `patch:` line: the copy
    // goes back to the pinned spec first.
    if (/^patch: /m.test(readFileSync(join(work, "spec/PIN"), "utf8"))) {
      const reverted = spawnSync("git", ["apply", "--reverse", PATCH], { cwd: work, encoding: "utf8" });
      assert.equal(reverted.status, 0, reverted.stderr);
    }
    const before = operationIds(join(work, "spec/resend.yaml"));
    const applied = spawnSync("git", ["apply", PATCH], { cwd: work, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    const after = operationIds(join(work, "spec/resend.yaml"));

    assert.equal(after.length, before.length + 1);
    const added = after.filter((id) => !before.includes(id));
    assert.equal(added.length, 1);
    assert.deepEqual(addedOperationIds(readFileSync(PATCH, "utf8")), added);
    assert.ok(before.every((id) => after.includes(id)));

    const pin = readFileSync(join(work, "spec/PIN"), "utf8");
    const sha256 = createHash("sha256").update(readFileSync(join(work, "spec/resend.yaml"))).digest("hex");
    assert.match(pin, new RegExp(`^sha256: ${sha256}$`, "m"));
    assert.match(pin, /^patch: local/m);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the C26 patch touches only spec/resend.yaml and spec/PIN", () => {
  const files = [...readFileSync(PATCH, "utf8").matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => {
    assert.equal(match[1], match[2]);
    return match[1];
  });
  assert.deepEqual(files.sort(), ["spec/PIN", "spec/resend.yaml"]);
});

test("the product and support paths of C30 are those of D17", () => {
  const contract = readFileSync(join(ROOT, "vault/CONTRACT.md"), "utf8");
  const d17 = contract.slice(contract.indexOf("**D17."), contract.indexOf("**D18."));
  const paths = (label: string): string[] => {
    const list = new RegExp(`${label} = ([^;]+);`).exec(d17);
    assert.ok(list, `D17 has no list for ${label}`);
    return [...list[1]!.matchAll(/`([^`]+)\/`/g)].map((match) => match[1]!);
  };
  assert.deepEqual(PRODUCT_PATHS, paths("producto"));
  assert.deepEqual(SUPPORT_PATHS, paths("apoyo"));
});

test("the test exclusion recognizes the test files of TypeScript, Go and Python", () => {
  const pattern = new RegExp(TEST_FILE_PATTERN);
  for (const name of ["ir.test.ts", "verify/oss.test.ts", "operations_test.go", "sdks/go/operations_test.go", "test_operations.py", "sdks/python/tests/test_operations.py"]) {
    assert.ok(pattern.test(name), name);
  }
  for (const name of ["ir.ts", "test.ts", "testing.go", "contest_rules.py", "sdks/python/src/paridad_resend/client.py"]) {
    assert.ok(!pattern.test(name), name);
  }
  assert.ok(EXCLUDED_DIRS.includes("test") && EXCLUDED_DIRS.includes("tests"));
  const args = sccArgs(["/repo/verify"], false);
  assert.equal(args[args.indexOf("--not-match") + 1], TEST_FILE_PATTERN);
  assert.equal(args[args.indexOf("--exclude-dir") + 1], EXCLUDED_DIRS.join(","));
  assert.ok(!sccArgs(["/repo/verify"], true).includes("--not-match"));
});
