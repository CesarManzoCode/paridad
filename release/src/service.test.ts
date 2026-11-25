// The service over HTTP, against fake npm and PyPI registries hosted in this process:
// idempotent publication with the same and another sha256, resumption of a service
// killed at a pause point, and the /metrics exposition.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { publishNpm, publishPypi, sha256 } from "./publish.ts";
import { Queue } from "./queue.ts";
import { METRICS_CONTENT_TYPE, metricsServer } from "./service.ts";

const ROOT = join(import.meta.dirname, "../..");
const MAIN = join(import.meta.dirname, "main.ts");
const PYTHON = join(ROOT, ".venv/bin/python");
const dir = mkdtempSync(join(tmpdir(), "paridad-service-"));
const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  rmSync(dir, { recursive: true, force: true });
});

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return `http://127.0.0.1:${address.port}/`;
}

interface FakeNpm {
  url: string;
  // name@version of every accepted `npm publish`.
  publishes: string[];
  add(name: string, version: string, tarball: Buffer): void;
  tarball(name: string, version: string): Buffer | undefined;
}

// The part of the npm registry protocol that the service and `npm publish` use.
async function fakeNpm(): Promise<FakeNpm> {
  const packages = new Map<string, Map<string, Buffer>>();
  let url = "";
  const fake: FakeNpm = {
    url,
    publishes: [],
    add(name, version, tarball) {
      if (!packages.has(name)) packages.set(name, new Map());
      packages.get(name)!.set(version, tarball);
    },
    tarball: (name, version) => packages.get(name)?.get(version),
  };
  const server = createServer(async (request, response) => {
    const data = await body(request);
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (request.method === "PUT" && path.startsWith("/-/user/")) return json(201, { ok: true, token: "fake-token" });
    const tarball = /^\/(.+)\/-\/(.+)-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
    if (request.method === "GET" && tarball !== null) {
      const found = fake.tarball(tarball[1]!, tarball[3]!);
      if (found === undefined) return json(404, { error: "not found" });
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(found);
      return;
    }
    const name = path.slice(1);
    if (request.method === "GET") {
      const versions = packages.get(name);
      if (versions === undefined) return json(404, { error: "not found" });
      return json(200, {
        name,
        versions: Object.fromEntries([...versions.keys()].map((version) => [version, { name, version, dist: { tarball: `${url}${name}/-/${name}-${version}.tgz` } }])),
      });
    }
    if (request.method === "PUT") {
      const document = JSON.parse(data.toString("utf8")) as { versions: Record<string, unknown>; _attachments: Record<string, { data: string }> };
      const version = Object.keys(document.versions)[0]!;
      if (packages.get(name)?.has(version)) return json(409, { error: "this package is already present" });
      fake.add(name, version, Buffer.from(Object.values(document._attachments)[0]!.data, "base64"));
      fake.publishes.push(`${name}@${version}`);
      return json(201, { ok: "created new package" });
    }
    json(405, { error: "method not allowed" });
  });
  url = await listen(server);
  fake.url = url;
  return fake;
}

interface FakePypi {
  url: string;
  // File names of every accepted upload.
  uploads: string[];
  files: Map<string, Buffer>;
}

// The file named in the `content` part of a multipart/form-data body.
function uploadedFile(data: Buffer, contentType: string): { name: string; content: Buffer } {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  assert.ok(boundary !== undefined, "multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  let start = data.indexOf(delimiter);
  while (start !== -1) {
    const next = data.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = data.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const file = /name="content"; filename="([^"]+)"/.exec(part.subarray(0, split).toString("utf8"));
    if (file !== null) return { name: file[1]!, content: part.subarray(split + 4) };
    start = next;
  }
  throw new Error("no content part in the upload");
}

// The two pypiserver routes the service uses: upload to / and download from /packages/.
async function fakePypi(): Promise<FakePypi> {
  const fake: FakePypi = { url: "", uploads: [], files: new Map() };
  const server = createServer(async (request, response) => {
    const data = await body(request);
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (request.method === "POST" && path === "/") {
      const file = uploadedFile(data, request.headers["content-type"] ?? "");
      if (fake.files.has(file.name)) {
        response.writeHead(409).end("File already exists");
        return;
      }
      fake.files.set(file.name, Buffer.from(file.content));
      fake.uploads.push(file.name);
      response.writeHead(200).end("");
      return;
    }
    const download = /^\/packages\/(.+)$/.exec(path);
    const found = request.method === "GET" && download !== null ? fake.files.get(download[1]!) : undefined;
    if (found === undefined) response.writeHead(404).end("Not Found");
    else response.writeHead(200, { "content-type": "application/octet-stream" }).end(found);
  });
  fake.url = await listen(server);
  return fake;
}

test("npm: the same tarball already published is not uploaded again", async () => {
  const npm = await fakeNpm();
  const tarball = join(dir, "same.tgz");
  writeFileSync(tarball, "tarball 0.1.0");
  npm.add("paridad-resend", "0.1.0", readFileSync(tarball));
  const outcome = await publishNpm({ registry: npm.url, name: "paridad-resend", version: "0.1.0", tarball, userconfig: join(dir, "npmrc-same") });
  assert.equal(outcome, "existing");
  assert.deepEqual(npm.publishes, []);
});

test("npm: the same version with another sha256 fails the step", async () => {
  const npm = await fakeNpm();
  const tarball = join(dir, "other.tgz");
  writeFileSync(tarball, "tarball 0.1.0, rebuilt");
  npm.add("paridad-resend", "0.1.0", Buffer.from("tarball 0.1.0"));
  await assert.rejects(
    publishNpm({ registry: npm.url, name: "paridad-resend", version: "0.1.0", tarball, userconfig: join(dir, "npmrc-other") }),
    new RegExp(`npm paridad-resend@0\\.1\\.0 is already published with sha256 ${sha256(Buffer.from("tarball 0.1.0"))}`),
  );
  assert.deepEqual(npm.publishes, []);
});

test("pypi: the same file already published is not uploaded again", async () => {
  const pypi = await fakePypi();
  const wheel = join(dir, "paridad_resend-0.1.0-py3-none-any.whl");
  writeFileSync(wheel, "wheel 0.1.0");
  pypi.files.set("paridad_resend-0.1.0-py3-none-any.whl", readFileSync(wheel));
  assert.equal(await publishPypi({ url: pypi.url, file: wheel, python: PYTHON }), "existing");
  assert.deepEqual(pypi.uploads, []);
});

test("pypi: the same file name with another sha256 fails the step", async () => {
  const pypi = await fakePypi();
  const sdist = join(dir, "paridad_resend-0.1.0.tar.gz");
  writeFileSync(sdist, "sdist 0.1.0, rebuilt");
  pypi.files.set("paridad_resend-0.1.0.tar.gz", Buffer.from("sdist 0.1.0"));
  await assert.rejects(publishPypi({ url: pypi.url, file: sdist, python: PYTHON }), /pypi paridad_resend-0\.1\.0\.tar\.gz is already published with sha256/);
  assert.deepEqual(pypi.uploads, []);
});

test("/metrics exposes the three counters of the jobs table in the Prometheus text format", async () => {
  const queue = new Queue(join(dir, "metrics.sqlite"));
  for (let i = 0; i < 3; i++) queue.enqueue(() => {});
  queue.complete(queue.claim()!.id);
  queue.fail(queue.claim()!.id, "boom");
  const url = await listen(metricsServer(queue));

  const response = await fetch(new URL("metrics", url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), METRICS_CONTENT_TYPE);
  const text = await response.text();
  assert.equal(
    text,
    [
      "# HELP paridad_release_jobs_enqueued_total Release jobs enqueued, one per row of the jobs table.",
      "# TYPE paridad_release_jobs_enqueued_total counter",
      "paridad_release_jobs_enqueued_total 3",
      "# HELP paridad_release_jobs_completed_total Release jobs in state done.",
      "# TYPE paridad_release_jobs_completed_total counter",
      "paridad_release_jobs_completed_total 1",
      "# HELP paridad_release_jobs_failed_total Release jobs in state failed.",
      "# TYPE paridad_release_jobs_failed_total counter",
      "paridad_release_jobs_failed_total 1",
      "",
    ].join("\n"),
  );
  // Every sample agrees with a direct count of the table.
  const samples = Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(" ") as [string, string]),
  );
  const count = (where: string): number => Number((queue.db.prepare(`SELECT count(*) AS n FROM jobs ${where}`).get() as { n: number }).n);
  assert.equal(Number(samples.paridad_release_jobs_enqueued_total), count(""));
  assert.equal(Number(samples.paridad_release_jobs_completed_total), count("WHERE state = 'done'"));
  assert.equal(Number(samples.paridad_release_jobs_failed_total), count("WHERE state = 'failed'"));

  queue.enqueue(() => {});
  assert.match(await (await fetch(new URL("metrics", url))).text(), /^paridad_release_jobs_enqueued_total 4$/m, "read from the table on every request");
  assert.equal((await fetch(new URL("other", url))).status, 404);
});

// Runs `node release/src/main.ts <args>` and collects its stderr lines.
function start(args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; lines: string[]; waitFor(pattern: RegExp, timeoutMs: number): Promise<string> } {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: { pattern: RegExp; done: (line: string) => void }[] = [];
  createInterface({ input: child.stderr! }).on("line", (line) => {
    lines.push(line);
    for (const waiter of waiters.filter((candidate) => candidate.pattern.test(line))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.done(line);
    }
  });
  child.stdout!.resume();
  return {
    child,
    lines,
    waitFor: (pattern, timeoutMs) => {
      const seen = lines.find((line) => pattern.test(line));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${String(pattern)} in ${timeoutMs} ms; stderr:\n${lines.join("\n")}`)), timeoutMs);
        waiters.push({ pattern, done: (line) => (clearTimeout(timer), resolve(line)) });
        child.once("exit", (code, signal) => (clearTimeout(timer), reject(new Error(`exited with ${code ?? signal} before ${String(pattern)}; stderr:\n${lines.join("\n")}`))));
      });
    },
  };
}

async function stop(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill(signal);
  await exited;
}

test("a service killed at npm_published resumes from that point without publishing twice", { timeout: 600_000 }, async () => {
  const npm = await fakeNpm();
  const pypi = await fakePypi();
  const workdir = join(dir, "resume");
  const goproxy = join(workdir, "goproxy");
  const options = ["--workdir", workdir, "--npm-registry", npm.url, "--pypi-url", pypi.url, "--goproxy-dir", goproxy, "--python", PYTHON];
  const env = { ...process.env };
  delete env.PARIDAD_RELEASE_PAUSE_AT;

  const enqueue = start(["enqueue", ...options], env);
  assert.equal(await new Promise((done) => enqueue.child.once("exit", done)), 0, enqueue.lines.join("\n"));

  const first = start(["serve", "--port", "0", ...options], { ...env, PARIDAD_RELEASE_PAUSE_AT: "npm_published" });
  await first.waitFor(/^paused npm_published$/, 300_000);
  await stop(first.child, "SIGKILL");

  const queue = new Queue(join(workdir, "queue.sqlite"));
  const killed = queue.list();
  assert.equal(killed.length, 1);
  assert.equal(killed[0]!.state, "running");
  assert.equal(killed[0]!.step, "npm_published");
  assert.equal(killed[0]!.version, "0.1.0");
  assert.deepEqual(npm.publishes, ["paridad-resend@0.1.0"]);
  assert.deepEqual(pypi.uploads, []);

  const second = start(["serve", "--port", "0", ...options], env);
  try {
    await second.waitFor(/^job 1 (done|failed)/, 300_000);
  } finally {
    await stop(second.child, "SIGTERM");
  }
  assert.ok(!second.lines.some((line) => line.startsWith("paused")));
  const [job] = queue.list();
  queue.close();
  assert.equal(job!.state, "done", job!.error ?? "");
  assert.equal(job!.version, "0.1.0");

  // One publication per registry file, each with the bytes of the build.
  const build = join(workdir, "jobs/1/build");
  assert.deepEqual(npm.publishes, ["paridad-resend@0.1.0"]);
  assert.deepEqual(npm.tarball("paridad-resend", "0.1.0"), readFileSync(join(build, "paridad-resend-0.1.0.tgz")));
  assert.deepEqual(pypi.uploads, ["paridad_resend-0.1.0.tar.gz", "paridad_resend-0.1.0-py3-none-any.whl"]);
  for (const file of pypi.uploads) assert.deepEqual(pypi.files.get(file), readFileSync(join(build, file)));
  const atV = join(goproxy, "github.com/!cesar!manzo!code/paridad/sdks/go/@v");
  assert.deepEqual(readdirSync(atV).sort(), ["list", "v0.1.0.info", "v0.1.0.mod", "v0.1.0.zip"]);
  for (const file of ["v0.1.0.info", "v0.1.0.mod", "v0.1.0.zip"]) assert.deepEqual(readFileSync(join(atV, file)), readFileSync(join(build, file)));
  assert.equal(readFileSync(join(atV, "list"), "utf8"), "v0.1.0\n");
  assert.deepEqual(readdirSync(goproxy, { recursive: true, encoding: "utf8" }).filter((entry) => /\.tmp|\.partial/.test(entry)), []);

  // The version is written only in the build copy.
  assert.match(readFileSync(join(ROOT, "sdks/typescript/package.json"), "utf8"), /"version": "0\.0\.0-dev"/);
  assert.match(readFileSync(join(ROOT, "sdks/python/pyproject.toml"), "utf8"), /^version = "0\.0\.0-dev"$/m);
});
