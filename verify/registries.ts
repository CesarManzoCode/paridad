// Local registries of C21, C22 and C23 (vault/CONTRACT.md §9, §10) and the release
// service processes that publish to them.
//
// A registries directory has the shape of §10: verdaccio/ (config.yaml copied from
// verify/registries/verdaccio.yaml, htpasswd and storage/), pypi/packages/ and
// goproxy/. Verdaccio 7.1.2 and pypiserver 2.4.3 listen only on 127.0.0.1, on a free
// port, with their output in a log file; the GOPROXY is a plain directory that the
// service writes and `GOPROXY=file://…` reads.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { escapeModule } from "../release/src/publish.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const VERDACCIO_CONFIG = join(ROOT, "verify/registries/verdaccio.yaml");
const VERDACCIO_BIN = join(ROOT, "node_modules/verdaccio/bin/verdaccio");
const PYPI_SERVER = join(ROOT, ".venv/bin/pypi-server");
const READY_MS = 60_000;
// Limit of one wait for a line of the release service, so a stuck run fails instead of
// reaching the anti-hang limit of the whole criterion.
const WAIT_MS = 10 * 60_000;

// The package names that the release service publishes: npm and PyPI from the generated
// manifests, the Go module from the IR.
export interface Names {
  npm: string;
  pypi: string;
  module: string;
}

export function releaseNames(): Names {
  const ir = JSON.parse(readFileSync(join(ROOT, "ir/ir.json"), "utf8")) as { project: { go_module: string } };
  const npm = (JSON.parse(readFileSync(join(ROOT, "sdks/typescript/package.json"), "utf8")) as { name: string }).name;
  return { npm, pypi: "paridad_resend", module: ir.project.go_module };
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

// A child process with stdout and stderr appended to one log file.
function spawnLogged(argv: string[], log: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    return spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once("exit", () => done()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited(child);
  clearTimeout(timer);
}

// Polls `url` until it answers 200; fails if the process ends first or after READY_MS.
async function ready(child: ChildProcess, url: string, label: string, log: string): Promise<void> {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited with ${child.exitCode ?? child.signalCode} before answering; see ${log}`);
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  await stopChild(child);
  throw new Error(`${label} did not answer ${url} within ${READY_MS} ms; see ${log}`);
}

export interface RegistryServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function verdaccioArgs(config: string, port: number): string[] {
  return [process.execPath, VERDACCIO_BIN, "--config", config, "--listen", `127.0.0.1:${port}`];
}

// Verdaccio with its storage in <dir>/verdaccio/storage.
export async function startVerdaccio(dir: string, log: string, port?: number): Promise<RegistryServer> {
  const home = join(dir, "verdaccio");
  mkdirSync(join(home, "storage"), { recursive: true });
  const config = join(home, "config.yaml");
  copyFileSync(VERDACCIO_CONFIG, config);
  const bound = port ?? (await freePort());
  const child = spawnLogged(verdaccioArgs(config, bound), log);
  const url = `http://127.0.0.1:${bound}/`;
  await ready(child, `${url}-/ping`, "verdaccio", log);
  return { url, port: bound, stop: () => stopChild(child) };
}

// pypiserver serving <dir>/pypi/packages: uploads without authentication (`-a . -P .`),
// and no redirect to pypi.org for a package it does not have.
export function pypiserverArgs(packages: string, port: number): string[] {
  return [PYPI_SERVER, "run", "--host", "127.0.0.1", "--port", String(port), "--authenticate", ".", "--passwords", ".", "--disable-fallback", "--log-stream", "stderr", packages];
}

export async function startPypiserver(dir: string, log: string, port?: number): Promise<RegistryServer> {
  const packages = join(dir, "pypi/packages");
  mkdirSync(packages, { recursive: true });
  const bound = port ?? (await freePort());
  const child = spawnLogged(pypiserverArgs(packages, bound), log);
  const url = `http://127.0.0.1:${bound}/`;
  await ready(child, `${url}health`, "pypiserver", log);
  return { url, port: bound, stop: () => stopChild(child) };
}

export interface Registries {
  dir: string;
  verdaccio: RegistryServer;
  pypi: RegistryServer;
  goproxy: string;
  stop(): Promise<void>;
}

// New registries in `dir` (whatever was there is removed), logs in <logDir>/verdaccio.log
// and <logDir>/pypiserver.log.
export async function startRegistries(dir: string, logDir: string): Promise<Registries> {
  rmSync(dir, { recursive: true, force: true });
  const goproxy = join(dir, "goproxy");
  mkdirSync(goproxy, { recursive: true });
  const verdaccio = await startVerdaccio(dir, join(logDir, "verdaccio.log"));
  let pypi: RegistryServer;
  try {
    pypi = await startPypiserver(dir, join(logDir, "pypiserver.log"));
  } catch (error) {
    await verdaccio.stop();
    throw error;
  }
  // stop() reads the fields, so a server replaced after a restart is the one it stops.
  const registries: Registries = {
    dir,
    verdaccio,
    pypi,
    goproxy,
    stop: async () => {
      await Promise.all([registries.verdaccio.stop(), registries.pypi.stop()]);
    },
  };
  return registries;
}

// <goproxy>/<module with escaped upper case>/@v
export function goModuleDir(goproxy: string, module: string): string {
  return join(goproxy, escapeModule(module), "@v");
}

// State of a registries directory: one entry per published artifact, and the problems
// that make it not comparable (a version without one of its files, a file without its
// version, a duplicated version, a temporary file).
export interface Entry {
  registry: "npm" | "pypi" | "go";
  package: string;
  version: string;
  file: string;
  sha256: string;
}

export interface State {
  entries: Entry[];
  problems: string[];
}

function fileSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function isTemporary(name: string): boolean {
  return name.endsWith(".tmp") || name.endsWith(".partial") || name.startsWith(".tmp");
}

function temporaryFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (isTemporary(entry.name)) found.push(relative(dir, path).split(sep).join("/"));
      if (entry.isDirectory()) walk(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

function npmState(dir: string, name: string, entries: Entry[], problems: string[]): void {
  const storage = join(dir, "verdaccio/storage", name);
  if (!existsSync(storage)) return;
  const manifest = join(storage, "package.json");
  const versions = existsSync(manifest) ? Object.keys((JSON.parse(readFileSync(manifest, "utf8")) as { versions?: Record<string, unknown> }).versions ?? {}) : [];
  const tarballs = new Set(readdirSync(storage).filter((file) => file.endsWith(".tgz")));
  for (const version of versions) {
    const file = `${name}-${version}.tgz`;
    if (!tarballs.has(file)) {
      problems.push(`npm ${name}@${version} has no tarball ${file}`);
      continue;
    }
    tarballs.delete(file);
    entries.push({ registry: "npm", package: name, version, file, sha256: fileSha256(join(storage, file)) });
  }
  for (const file of tarballs) problems.push(`npm tarball ${file} has no version in package.json`);
}

function pypiState(dir: string, name: string, entries: Entry[], problems: string[]): void {
  const packages = join(dir, "pypi/packages");
  if (!existsSync(packages)) return;
  const files = new Map<string, string[]>();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}-(.+?)(\\.tar\\.gz|-py3-none-any\\.whl)$`);
  for (const file of readdirSync(packages)) {
    if (isTemporary(file)) continue;
    const match = pattern.exec(file);
    if (match === null) {
      problems.push(`pypi file ${file} is not a distribution of ${name}`);
      continue;
    }
    files.set(match[1]!, [...(files.get(match[1]!) ?? []), file]);
  }
  for (const [version, found] of files) {
    for (const file of [`${name}-${version}.tar.gz`, `${name}-${version}-py3-none-any.whl`]) {
      if (found.includes(file)) entries.push({ registry: "pypi", package: name, version, file, sha256: fileSha256(join(packages, file)) });
      else problems.push(`pypi ${name} ${version} has no ${file}`);
    }
  }
}

function goState(dir: string, module: string, entries: Entry[], problems: string[]): void {
  const versionDir = goModuleDir(join(dir, "goproxy"), module);
  if (!existsSync(versionDir)) return;
  const listFile = join(versionDir, "list");
  const listed = existsSync(listFile) ? readFileSync(listFile, "utf8").split("\n").filter((line) => line !== "") : [];
  const files = new Set(readdirSync(versionDir).filter((file) => file !== "list" && !isTemporary(file)));
  const seen = new Set<string>();
  for (const tag of listed) {
    if (seen.has(tag)) {
      problems.push(`go ${module} lists ${tag} more than once`);
      continue;
    }
    seen.add(tag);
    for (const file of [`${tag}.info`, `${tag}.mod`, `${tag}.zip`]) {
      if (!files.has(file)) {
        problems.push(`go ${module} ${tag} is listed but has no ${file}`);
        continue;
      }
      files.delete(file);
      entries.push({ registry: "go", package: module, version: tag.replace(/^v/, ""), file, sha256: fileSha256(join(versionDir, file)) });
    }
  }
  for (const file of files) problems.push(`go ${module} file ${file} has no version in list`);
}

export function registryState(dir: string, names: Names): State {
  const entries: Entry[] = [];
  const problems: string[] = [];
  npmState(dir, names.npm, entries, problems);
  pypiState(dir, names.pypi, entries, problems);
  goState(dir, names.module, entries, problems);
  for (const file of temporaryFiles(dir)) problems.push(`temporary file ${file}`);
  const key = (entry: Entry): string => `${entry.registry} ${entry.package} ${entry.version} ${entry.file}`;
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { entries, problems };
}

// The versions that each registry holds.
export function versions(state: State): Record<Entry["registry"], string[]> {
  const of = (registry: Entry["registry"]): string[] => [...new Set(state.entries.filter((entry) => entry.registry === registry).map((entry) => entry.version))].sort();
  return { npm: of("npm"), pypi: of("pypi"), go: of("go") };
}

// Differences between two states, one line per artifact present or different on one side.
export function compareStates(reference: State, actual: State): string[] {
  const line = (entry: Entry): string => `${entry.registry} ${entry.package} ${entry.version} ${entry.file} ${entry.sha256}`;
  const want = new Set(reference.entries.map(line));
  const got = new Set(actual.entries.map(line));
  return [...[...want].filter((item) => !got.has(item)).map((item) => `missing ${item}`), ...[...got].filter((item) => !want.has(item)).map((item) => `extra ${item}`)];
}

// --- Release service processes (release/src/main.ts) ---

export interface Release {
  workdir: string;
  registries: Registries;
}

// One process of the release service whose stderr lines are kept in memory and in a log.
export class ServiceProcess {
  readonly child: ChildProcess;
  readonly command: "serve" | "enqueue";
  readonly lines: string[] = [];
  stdout = "";
  #partial = "";

  constructor(release: Release, command: "serve" | "enqueue", log: string, pauseAt?: string) {
    this.command = command;
    const env = { ...process.env };
    delete env.PARIDAD_RELEASE_PAUSE_AT;
    if (pauseAt !== undefined) env.PARIDAD_RELEASE_PAUSE_AT = pauseAt;
    const argv = [
      process.execPath,
      join(ROOT, "release/src/main.ts"),
      command,
      ...(command === "serve" ? ["--port", "0"] : []),
      "--workdir",
      release.workdir,
      "--npm-registry",
      release.registries.verdaccio.url,
      "--pypi-url",
      release.registries.pypi.url,
      "--goproxy-dir",
      release.registries.goproxy,
    ];
    mkdirSync(dirname(log), { recursive: true });
    this.child = spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const fd = openSync(log, "a");
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.stdout += chunk.toString("utf8");
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      writeAll(fd, chunk);
      const text = this.#partial + chunk.toString("utf8");
      const parts = text.split("\n");
      this.#partial = parts.pop()!;
      this.lines.push(...parts);
    });
    this.child.once("close", () => closeSync(fd));
  }

  // The first stderr line matching `pattern`; fails if the process ends first.
  async waitFor(pattern: RegExp): Promise<RegExpExecArray> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      for (const line of this.lines) {
        const match = pattern.exec(line);
        if (match !== null) return match;
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`release ${this.command} exited with ${this.child.exitCode ?? this.child.signalCode} before printing ${String(pattern)}`);
      }
      if (Date.now() > deadline) throw new Error(`release ${this.command} did not print ${String(pattern)} within ${WAIT_MS} ms`);
      await delay(100);
    }
  }

  // The metrics URL that `serve` prints once it listens.
  async metricsUrl(): Promise<string> {
    return (await this.waitFor(/^metrics (http:\/\/127\.0\.0\.1:\d+\/metrics)$/))[1]!;
  }

  async exit(): Promise<number | null> {
    await exited(this.child);
    return this.child.exitCode;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await exited(this.child);
  }

  stop(): Promise<void> {
    return stopChild(this.child);
  }
}

// Synchronous, so a SIGKILL of this runner never loses a line already received.
function writeAll(fd: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
}

// The line that ends job `id`: `job <id> done <version>` or `job <id> failed: <error>`.
export function jobEnd(id: number): RegExp {
  return new RegExp(`^job ${id} (done (\\S+)|failed: (.*))$`);
}

// Enqueues a release of this tree and returns its job id.
export async function enqueueJob(release: Release, log: string): Promise<number> {
  const enqueue = new ServiceProcess(release, "enqueue", log);
  const code = await enqueue.exit();
  if (code !== 0) throw new Error(`release enqueue exited with ${code}; see ${log}`);
  return (JSON.parse(enqueue.stdout) as { id: number }).id;
}

export interface JobResult {
  id: number;
  // The version of a done job, null when it failed.
  version: string | null;
  error: string | null;
}

export async function waitJob(service: ServiceProcess, id: number): Promise<JobResult> {
  const match = await service.waitFor(jobEnd(id));
  return { id, version: match[2] ?? null, error: match[3] ?? null };
}

// One release of this tree from enqueue to the end of its job. With `pauseAt` (a point
// of §9.3), the process that reaches that point is killed with SIGKILL as soon as it
// prints `paused <point>`, and a service without the variable finishes the job. The
// service is stopped before returning.
export async function releaseOnce(release: Release, logDir: string, pauseAt?: string): Promise<JobResult & { killed: boolean }> {
  const log = join(logDir, "release.log");
  let id: number;
  let killed = false;
  if (pauseAt === "enqueued") {
    const enqueue = new ServiceProcess(release, "enqueue", log, pauseAt);
    await enqueue.waitFor(/^paused enqueued$/);
    await enqueue.kill();
    killed = true;
    // The killed process committed the job before pausing, so it is the newest one.
    id = lastJobId(release.workdir);
  } else {
    id = await enqueueJob(release, log);
  }
  if (pauseAt !== undefined && pauseAt !== "enqueued") {
    const paused = new ServiceProcess(release, "serve", log, pauseAt);
    try {
      await paused.waitFor(new RegExp(`^paused ${pauseAt}$`));
    } finally {
      await paused.kill();
    }
    killed = true;
  }
  const service = new ServiceProcess(release, "serve", log);
  try {
    return { ...(await waitJob(service, id)), killed };
  } finally {
    await service.stop();
  }
}

// The id of the newest job of the queue in `workdir`.
export function lastJobId(workdir: string): number {
  const db = new DatabaseSync(join(workdir, "queue.sqlite"));
  try {
    const row = db.prepare("SELECT max(id) AS id FROM jobs").get() as { id: number | null } | undefined;
    if (row?.id == null) throw new Error(`the queue in ${workdir} has no job`);
    return Number(row.id);
  } finally {
    db.close();
  }
}
