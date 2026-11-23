import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const PINNED_COMMIT = "8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce";

function readPin(): Map<string, string> {
  const pin = new Map<string, string>();
  for (const line of readFileSync(join(import.meta.dirname, "PIN"), "utf8").split("\n")) {
    const match = /^([a-z0-9]+): (.+)$/.exec(line);
    if (match) pin.set(match[1]!, match[2]!);
  }
  return pin;
}

test("spec/resend.yaml matches the sha256 declared in spec/PIN", () => {
  const actual = createHash("sha256")
    .update(readFileSync(join(import.meta.dirname, "resend.yaml")))
    .digest("hex");
  assert.equal(actual, readPin().get("sha256"));
});

test("spec/PIN declares the pinned repository and commit", () => {
  const pin = readPin();
  assert.equal(pin.get("repository"), "https://github.com/resend/resend-openapi");
  assert.equal(pin.get("commit"), PINNED_COMMIT);
});
