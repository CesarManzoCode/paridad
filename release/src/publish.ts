// Idempotent publication to the three local registries (vault/CONTRACT.md §10).
//
// Before uploading, each step asks the registry for the version: present with the same
// sha256, it moves on; present with another, the job fails. After uploading it asks
// again, so an upload that a killed process left running (the child outlives a SIGKILL
// of the service) and that wins the race counts as published when its bytes match.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "./build.ts";

export type Outcome = "published" | "existing";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function ensurePublished(label: string, built: Buffer, existing: () => Promise<Buffer | null>, publish: () => Promise<void>): Promise<Outcome> {
  const want = sha256(built);
  const present = async (): Promise<boolean> => {
    const found = await existing();
    if (found === null) return false;
    const got = sha256(found);
    if (got !== want) throw new Error(`${label} is already published with sha256 ${got}; the build has ${want}`);
    return true;
  };
  if (await present()) return "existing";
  try {
    await publish();
  } catch (error) {
    if (await present()) return "existing";
    throw error;
  }
  if (!(await present())) throw new Error(`${label} is missing from the registry after publishing it`);
  return "published";
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function download(url: string | URL): Promise<Buffer | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${String(url)} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The tarball of name@version in an npm registry, or null if that version is absent.
export async function npmTarball(registry: string, name: string, version: string): Promise<Buffer | null> {
  const response = await fetch(new URL(encodeURIComponent(name), withSlash(registry)));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${name} from ${registry} answered ${response.status}`);
  const document = (await response.json()) as { versions?: Record<string, { dist?: { tarball?: string } }> };
  const entry = document.versions?.[version];
  if (entry === undefined) return null;
  const tarball = entry.dist?.tarball;
  if (tarball === undefined) throw new Error(`${name}@${version} in ${registry} has no dist.tarball`);
  const data = await download(tarball);
  if (data === null) throw new Error(`${name}@${version} is listed in ${registry} but its tarball is missing`);
  return data;
}

// A token from the registry's user endpoint (what `npm adduser` uses), which in
// Verdaccio creates the local user or logs it in.
async function npmToken(registry: string): Promise<string> {
  const user = "paridad";
  const response = await fetch(new URL(`-/user/org.couchdb.user:${user}`, withSlash(registry)), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _id: `org.couchdb.user:${user}`, name: user, password: "paridad-release", type: "user", roles: [], date: new Date().toISOString() }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: unknown };
  if (!response.ok || typeof body.token !== "string") throw new Error(`login to ${registry} answered ${response.status}`);
  return body.token;
}

export async function publishNpm(options: { registry: string; name: string; version: string; tarball: string; userconfig: string }): Promise<Outcome> {
  const registry = withSlash(options.registry);
  return ensurePublished(
    `npm ${options.name}@${options.version}`,
    readFileSync(options.tarball),
    () => npmTarball(registry, options.name, options.version),
    async () => {
      const token = await npmToken(registry);
      // The token goes in a userconfig of the job, keyed by the registry without protocol.
      writeTextSync(options.userconfig, `${registry.replace(/^https?:/, "")}:_authToken=${token}\n`);
      await run("npm", ["publish", options.tarball, "--registry", registry, "--userconfig", options.userconfig, "--ignore-scripts"], { cwd: dirname(options.tarball) });
    },
  );
}

export async function publishPypi(options: { url: string; file: string; python: string }): Promise<Outcome> {
  const url = withSlash(options.url);
  const name = basename(options.file);
  return ensurePublished(
    `pypi ${name}`,
    readFileSync(options.file),
    () => download(new URL(`packages/${encodeURIComponent(name)}`, url)),
    async () => {
      // pypiserver accepts anonymous uploads from 127.0.0.1; twine still asks for credentials.
      await run(options.python, ["-m", "twine", "upload", "--non-interactive", "--disable-progress-bar", "--repository-url", url, "-u", "paridad", "-p", "paridad", options.file], {
        cwd: dirname(options.file),
      });
    },
  );
}

// Module path as a GOPROXY path: each upper-case letter becomes `!` and its lower case.
export function escapeModule(module: string): string {
  return module.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

// Writes `data` to a temporary file next to `file`, syncs it and renames it over `file`.
export function writeAtomic(file: string, data: string | Uint8Array): void {
  const dir = dirname(file);
  const temp = join(dir, `.tmp-${basename(file)}-${process.pid}`);
  writeTextSync(temp, data);
  renameSync(temp, file);
  const handle = openSync(dir, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeTextSync(file: string, data: string | Uint8Array): void {
  const handle = openSync(file, "w");
  try {
    writeSync(handle, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.replace(/^v/, "").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Publishes .mod, .zip and .info of a version into a file GOPROXY, each with
// writeAtomic, and adds the version to `list` at the end. Temporary files that a killed
// process left in the module's @v directory are removed first.
export function publishGo(options: { goproxy: string; module: string; version: string; buildDir: string; files: string[] }): Record<string, Outcome> {
  const dir = join(options.goproxy, escapeModule(options.module), "@v");
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".tmp")) rmSync(join(dir, entry), { force: true });
  }
  const outcomes: Record<string, Outcome> = {};
  for (const file of options.files) {
    const built = readFileSync(join(options.buildDir, file));
    const target = join(dir, file);
    if (existsSync(target)) {
      const got = sha256(readFileSync(target));
      if (got !== sha256(built)) throw new Error(`go ${options.module} ${file} is already published with sha256 ${got}; the build has ${sha256(built)}`);
      outcomes[file] = "existing";
    } else {
      writeAtomic(target, built);
      outcomes[file] = "published";
    }
  }
  const list = join(dir, "list");
  const versions = existsSync(list) ? readFileSync(list, "utf8").split("\n").filter((line) => line !== "") : [];
  const version = `v${options.version}`;
  if (versions.includes(version)) {
    outcomes.list = "existing";
  } else {
    writeAtomic(list, `${[...versions, version].sort(compareVersions).join("\n")}\n`);
    outcomes.list = "published";
  }
  return outcomes;
}
