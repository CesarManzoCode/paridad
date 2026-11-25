// Snapshot, version and build of a release (vault/CONTRACT.md §10).
//
// `enqueue` copies what a release needs from the tree into <job>/source: the pinned
// spec and the IR (to compute the next bump against this release) and the three SDKs.
// The build works on a copy of that snapshot, writes the version only there and leaves
// in <job>/build the seven artifacts that the publish steps upload unchanged:
// paridad-resend-<v>.tgz, paridad_resend-<v>.tar.gz, paridad_resend-<v>-py3-none-any.whl,
// v<v>.mod, v<v>.zip and v<v>.info. A build cut halfway is redone from scratch, and
// every artifact depends only on the snapshot and the version, so it gives the same bytes.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { compareSdks, releaseBump, type Bump } from "../../compat/src/semver.ts";
import { compareSpecs, report } from "../../compat/src/rules.ts";
import type { IR } from "../../generator/src/ir.ts";
import { loadSpec } from "../../generator/src/spec.ts";

const DEV_VERSION = '"0.0.0-dev"';

// Files of the build copy where the generator writes 0.0.0-dev: the manifests and the
// version that each SDK sends in its User-Agent.
const VERSION_FILES = [
  "sdks/typescript/package.json",
  "sdks/typescript/src/policy.ts",
  "sdks/python/pyproject.toml",
  "sdks/python/src/paridad_resend/_policy.py",
  "sdks/go/policy.go",
];

// Never copied into the snapshot: installed packages, caches and build outputs.
const SKIPPED = new Set(["node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", "dist", "build", ".git"]);

export function jobDir(workdir: string, id: number): string {
  return join(workdir, "jobs", String(id));
}

// Copies the release inputs of `root` into <job>/source, replacing whatever an earlier
// attempt with the same id left. SOURCE_DATE_EPOCH is the commit time of HEAD: the
// .info time and the timestamps that hatchling writes in the sdist and the wheel.
export function snapshot(root: string, dir: string): void {
  const source = join(dir, "source");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  for (const path of ["spec/resend.yaml", "ir/ir.json", "sdks/typescript", "sdks/python", "sdks/go"]) {
    cpSync(join(root, path), join(source, path), { recursive: true, filter: (from) => !SKIPPED.has(from.split(sep).at(-1)!) && !from.endsWith(".pyc") });
  }
  const epoch = execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^\d+$/.test(epoch)) throw new Error(`git log gave no commit time in ${root}`);
  writeFileSync(join(source, "SOURCE_DATE_EPOCH"), `${epoch}\n`);
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`not a release version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// The version of a release (§10): 0.1.0 when nothing was published, otherwise the last
// published version plus the larger of the contract bump and the SDK bump between that
// release's snapshot and this one.
export function nextVersion(last: { version: string; source: string } | null, source: string): string {
  if (last === null) return "0.1.0";
  const contract = report(compareSpecs(loadSpec(join(last.source, "spec/resend.yaml")), loadSpec(join(source, "spec/resend.yaml")))).bump;
  const sdks = compareSdks(readIR(join(last.source, "ir/ir.json")), readIR(join(source, "ir/ir.json")));
  return bumpVersion(last.version, releaseBump(contract, sdks));
}

function readIR(file: string): IR {
  return JSON.parse(readFileSync(file, "utf8")) as IR;
}

export interface Artifacts {
  npm: { name: string; file: string };
  pypi: { files: string[] };
  go: { module: string; files: string[] };
}

// The artifact names of a version, all under <job>/build.
export function artifacts(source: string, version: string): Artifacts {
  const name = (JSON.parse(readFileSync(join(source, "sdks/typescript/package.json"), "utf8")) as { name: string }).name;
  return {
    npm: { name, file: `${name}-${version}.tgz` },
    pypi: { files: [`paridad_resend-${version}.tar.gz`, `paridad_resend-${version}-py3-none-any.whl`] },
    go: { module: goModule(readFileSync(join(source, "sdks/go/go.mod"), "utf8")), files: [`v${version}.mod`, `v${version}.zip`, `v${version}.info`] },
  };
}

function goModule(goMod: string): string {
  const match = /^module\s+(\S+)\s*$/m.exec(goMod);
  if (match === null) throw new Error("go.mod has no module line");
  return match[1]!;
}

export interface Tools {
  python: string;
}

// Builds every artifact of `version` into <job>/build. The work happens in
// <job>/building, renamed to <job>/build only when complete.
export async function build(dir: string, version: string, tools: Tools): Promise<void> {
  const source = join(dir, "source");
  const building = join(dir, "building");
  const out = join(building, "out");
  const done = join(dir, "build");
  rmSync(building, { recursive: true, force: true });
  rmSync(done, { recursive: true, force: true });
  cpSync(join(source, "sdks"), join(building, "sdks"), { recursive: true });
  mkdirSync(out, { recursive: true });
  for (const file of VERSION_FILES) writeVersion(join(building, file), version);
  const epoch = readFileSync(join(source, "SOURCE_DATE_EPOCH"), "utf8").trim();
  const env = { ...process.env, SOURCE_DATE_EPOCH: epoch };
  const names = artifacts(source, version);

  await run("npm", ["pack", "--pack-destination", out, "--ignore-scripts"], { cwd: join(building, "sdks/typescript"), env });
  // Without isolation, so the build uses the pinned hatchling of .venv and needs no network.
  await run(tools.python, ["-m", "build", "--no-isolation", "--outdir", out, "."], { cwd: join(building, "sdks/python"), env });

  const goDir = join(building, "sdks/go");
  writeFileSync(join(out, `v${version}.mod`), readFileSync(join(goDir, "go.mod")));
  writeFileSync(join(out, `v${version}.zip`), moduleZip(goDir, `${names.go.module}@v${version}`));
  const time = new Date(Number(epoch) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(join(out, `v${version}.info`), `${JSON.stringify({ Version: `v${version}`, Time: time })}\n`);

  const expected = [names.npm.file, ...names.pypi.files, ...names.go.files].sort();
  const built = readdirSync(out).sort();
  if (JSON.stringify(built) !== JSON.stringify(expected)) throw new Error(`build produced ${built.join(", ")}, expected ${expected.join(", ")}`);
  renameSync(out, done);
  rmSync(building, { recursive: true, force: true });
}

function writeVersion(file: string, version: string): void {
  const text = readFileSync(file, "utf8");
  if (text.split(DEV_VERSION).length !== 2) throw new Error(`${file} must contain ${DEV_VERSION} exactly once`);
  writeFileSync(file, text.replace(DEV_VERSION, `"${version}"`));
}

// Runs a command and rejects with its output when it fails. Asynchronous, so /metrics
// keeps answering during a build or an upload.
export function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [];
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const text = Buffer.concat(output).toString("utf8");
      if (code === 0) resolve(text);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}: ${text.trim()}`));
    });
  });
}

// The module zip of the Go modules reference: every regular file of the module root
// under `<module>@<version>/`, without version-control directories, vendor directories
// or nested modules, sorted by path, deflated, with a fixed timestamp.
export function moduleZip(dir: string, prefix: string): Buffer {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if ([".git", ".hg", ".svn", ".bzr", "vendor"].includes(entry.name) || existsSync(join(path, "go.mod"))) continue;
        walk(path);
      } else if (entry.isFile()) {
        files.push(relative(dir, path).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  files.sort();
  return zip(files.map((file) => ({ name: `${prefix}/${file}`, data: readFileSync(join(dir, file)) })));
}

// 1980-01-01 00:00:00 in MS-DOS format.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0, MS-DOS attributes
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
