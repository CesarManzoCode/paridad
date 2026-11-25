// The release service (vault/CONTRACT.md §9.3, §10): takes jobs from the queue and
// walks each one through the points of §9.3, confirming every point in the queue
// before the next. A job left running by a killed process resumes after its last
// confirmed point; every step after it is idempotent, so redoing the interrupted one
// gives the same registries.
//
// PARIDAD_RELEASE_PAUSE_AT=<point> stops the process right after that point is
// confirmed: it writes `paused <point>` to stderr and blocks until it is killed.
import { mkdirSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { artifacts, build, jobDir, nextVersion, snapshot } from "./build.ts";
import { publishGo, publishNpm, publishPypi } from "./publish.ts";
import { POINTS, Queue, type Counts, type Job, type Point } from "./queue.ts";

export interface Config {
  // Holds queue.sqlite and jobs/<id>/{source,build}.
  workdir: string;
  npmRegistry: string;
  pypiUrl: string;
  goproxy: string;
  python: string;
}

export function openQueue(config: Config): Queue {
  mkdirSync(config.workdir, { recursive: true });
  return new Queue(join(config.workdir, "queue.sqlite"));
}

function log(line: string): void {
  writeSync(2, `${line}\n`);
}

export function pauseAt(point: Point): void {
  if (process.env.PARIDAD_RELEASE_PAUSE_AT !== point) return;
  log(`paused ${point}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

// Enqueues a release of the tree at `root`: the job row and its snapshot commit together.
export function enqueue(config: Config, root: string): Job {
  const queue = openQueue(config);
  const job = queue.enqueue((id) => snapshot(root, jobDir(config.workdir, id)));
  pauseAt("enqueued");
  queue.close();
  return job;
}

// Runs a running job from the point after its last confirmed one to `done`, or marks
// it failed with the error of the step that threw.
export async function runJob(queue: Queue, config: Config, job: Job): Promise<Job> {
  const dir = jobDir(config.workdir, job.id);
  const source = join(dir, "source");
  const out = join(dir, "build");
  let current = job;
  try {
    for (const point of POINTS.slice(POINTS.indexOf(job.step) + 1)) {
      if (point === "versioned") {
        const last = queue.lastDone();
        const version = nextVersion(last === null ? null : { version: last.version!, source: join(jobDir(config.workdir, last.id), "source") }, source);
        current = queue.advance(job.id, point, version);
      } else {
        const version = current.version!;
        const names = artifacts(source, version);
        if (point === "built") {
          await build(dir, version, { python: config.python });
        } else if (point === "npm_published") {
          const outcome = await publishNpm({ registry: config.npmRegistry, name: names.npm.name, version, tarball: join(out, names.npm.file), userconfig: join(dir, "npmrc") });
          log(`job ${job.id} npm ${names.npm.file} ${outcome}`);
        } else if (point === "pypi_published") {
          for (const file of names.pypi.files) {
            const outcome = await publishPypi({ url: config.pypiUrl, file: join(out, file), python: config.python });
            log(`job ${job.id} pypi ${file} ${outcome}`);
          }
        } else if (point === "go_published") {
          const outcomes = publishGo({ goproxy: config.goproxy, module: names.go.module, version, buildDir: out, files: names.go.files });
          for (const [file, outcome] of Object.entries(outcomes)) log(`job ${job.id} go ${file} ${outcome}`);
        }
        current = queue.advance(job.id, point);
      }
      log(`job ${job.id} ${point}${point === "versioned" ? ` ${current.version!}` : ""}`);
      pauseAt(point);
    }
    current = queue.complete(job.id);
    log(`job ${job.id} done ${current.version!}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    current = queue.fail(job.id, message);
    log(`job ${job.id} failed: ${message}`);
  }
  return current;
}

// Takes the job a killed process left running, otherwise claims the oldest queued one.
export function nextJob(queue: Queue): Job | null {
  const running = queue.running();
  if (running !== null) return running;
  const claimed = queue.claim();
  if (claimed !== null) {
    log(`job ${claimed.id} claimed`);
    pauseAt("claimed");
  }
  return claimed;
}

const COUNTERS: { name: string; key: keyof Counts; help: string }[] = [
  { name: "paridad_release_jobs_enqueued_total", key: "enqueued", help: "Release jobs enqueued, one per row of the jobs table." },
  { name: "paridad_release_jobs_completed_total", key: "completed", help: "Release jobs in state done." },
  { name: "paridad_release_jobs_failed_total", key: "failed", help: "Release jobs in state failed." },
];

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// Prometheus text exposition of the counters, read from the jobs table.
export function metrics(counts: Counts): string {
  return COUNTERS.map(({ name, key, help }) => `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${counts[key]}\n`).join("");
}

export function metricsServer(queue: Queue): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/metrics" || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
      return;
    }
    response.writeHead(200, { "content-type": METRICS_CONTENT_TYPE }).end(metrics(queue.counts()));
  });
}

// Serves /metrics on 127.0.0.1:<port> and processes the queue until the process ends.
export async function serve(config: Config, port: number): Promise<never> {
  const queue = openQueue(config);
  const server = metricsServer(queue);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  log(`metrics http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : port}/metrics`);
  for (;;) {
    const job = nextJob(queue);
    if (job === null) await delay(200);
    else await runJob(queue, config, job);
  }
}
