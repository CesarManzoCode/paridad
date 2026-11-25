import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { bumpVersion, moduleZip, nextVersion } from "./build.ts";

const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "paridad-build-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the first release is 0.1.0 and the next ones add the bump", () => {
  assert.equal(nextVersion(null, ROOT), "0.1.0");
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("0.1.7", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.9.3", "major"), "1.0.0");
  assert.throws(() => bumpVersion("0.0.0-dev", "patch"), /not a release version/);
});

test("the same spec and IR as the last release give a patch", () => {
  assert.equal(nextVersion({ version: "0.3.0", source: ROOT }, ROOT), "0.3.1");
});

// Reads the central directory of a zip: names in order and inflated contents.
function entries(data: Buffer): { name: string; content: string }[] {
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const result: { name: string; content: string }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50);
    const size = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    result.push({ name, content: inflateRawSync(data.subarray(start, start + size)).toString("utf8") });
    offset += 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
  return result;
}

test("the module zip has the module root under module@version/ and nothing else", () => {
  const module = join(dir, "module");
  const files: Record<string, string> = {
    "go.mod": "module example.com/M\n\ngo 1.23\n",
    "client.go": "package m\n",
    "sub/types.go": "package sub\n",
    "nested/go.mod": "module example.com/M/nested\n",
    "nested/n.go": "package nested\n",
    "vendor/v.go": "package v\n",
    ".git/HEAD": "ref: refs/heads/main\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(module, path, ".."), { recursive: true });
    writeFileSync(join(module, path), content);
  }
  const data = moduleZip(module, "example.com/M@v0.1.0");
  assert.deepEqual(entries(data), [
    { name: "example.com/M@v0.1.0/client.go", content: "package m\n" },
    { name: "example.com/M@v0.1.0/go.mod", content: "module example.com/M\n\ngo 1.23\n" },
    { name: "example.com/M@v0.1.0/sub/types.go", content: "package sub\n" },
  ]);
  assert.deepEqual(moduleZip(module, "example.com/M@v0.1.0"), data, "the same tree gives the same bytes");
});
