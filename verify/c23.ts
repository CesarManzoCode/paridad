// node verify/c23.ts <run dir>   (make verify C=c23)
// C23 (contract §9, §10): a series of four releases of this tree with new registries in
// <run dir>/registries and the queue in <run dir>/release:
//   1. a release without interruptions;
//   2. a release whose service is killed with SIGKILL at `built` and restarted;
//   3. a release with pypiserver stopped, so the job fails at pypi_published;
//   4. with pypiserver back on the same port, a release whose service is killed with
//      SIGKILL at `npm_published` and restarted.
// Then it scrapes /metrics of a running service into metrics.txt, stops it, copies the
// queue with `VACUUM INTO` into queue.sqlite, runs `promtool check metrics` on
// metrics.txt (out/promtool.stdout|stderr) and compares
// paridad_release_jobs_enqueued_total, _completed_total and _failed_total with the
// jobs table of the copy. Writes jobs.jsonl (that table), out/ and failures.jsonl.
// Exits 0 only if promtool exits 0, the three counters match the table, and the table
// has at least one failed job.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { releaseOnce, ServiceProcess, startPypiserver, startRegistries, type Release } from "./registries.ts";

const runDir = process.argv[2]!;
const out = join(runDir, "out");
mkdirSync(out, { recursive: true });
const failures: string[] = [];
const COUNTERS = { enqueued: "paridad_release_jobs_enqueued_total", completed: "paridad_release_jobs_completed_total", failed: "paridad_release_jobs_failed_total" } as const;

function expectDone(label: string, job: { id: number; version: string | null; error: string | null }): void {
  if (job.version === null) failures.push(`${label}: job ${job.id} failed: ${job.error}`);
}

async function main(): Promise<void> {
  const registries = await startRegistries(join(runDir, "registries"), out);
  const release: Release = { workdir: join(runDir, "release"), registries };
  try {
    expectDone("release 1", await releaseOnce(release, out));
    const second = await releaseOnce(release, out, "built");
    expectDone("release 2", second);
    if (!second.killed) failures.push("release 2: the service never paused at built");

    await registries.pypi.stop();
    const third = await releaseOnce(release, out);
    if (third.version !== null) failures.push(`release 3: job ${third.id} ended done with pypiserver stopped`);
    registries.pypi = await startPypiserver(registries.dir, join(out, "pypiserver.log"), registries.pypi.port);

    const fourth = await releaseOnce(release, out, "npm_published");
    expectDone("release 4", fourth);
    if (!fourth.killed) failures.push("release 4: the service never paused at npm_published");

    // A service with no job left to run serves the counters of the final table.
    const service = new ServiceProcess(release, "serve", join(out, "release.log"));
    try {
      const response = await fetch(await service.metricsUrl());
      const text = await response.text();
      writeFileSync(join(runDir, "metrics.txt"), text);
      if (response.status !== 200) failures.push(`/metrics answered ${response.status}`);
    } finally {
      await service.stop();
    }
  } finally {
    await registries.stop();
  }

  const copy = join(runDir, "queue.sqlite");
  rmSync(copy, { force: true });
  const source = new DatabaseSync(join(release.workdir, "queue.sqlite"));
  try {
    source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }

  const metrics = readFileSync(join(runDir, "metrics.txt"));
  const promtool = spawnSync("promtool", ["check", "metrics"], { input: metrics });
  writeFileSync(join(out, "promtool.stdout"), promtool.stdout ?? "");
  writeFileSync(join(out, "promtool.stderr"), `${promtool.stderr ?? ""}${promtool.error === undefined ? "" : `${promtool.error.message}\n`}`);
  if (promtool.status !== 0) failures.push(`promtool check metrics exited ${promtool.status ?? promtool.signal ?? promtool.error?.message}; see out/promtool.stderr`);

  const db = new DatabaseSync(copy);
  let table: Record<keyof typeof COUNTERS, number>;
  try {
    const jobs = db.prepare("SELECT * FROM jobs ORDER BY id").all();
    writeFileSync(join(runDir, "jobs.jsonl"), jobs.map((job) => `${JSON.stringify(job)}\n`).join(""));
    const row = db.prepare("SELECT count(*) AS enqueued, coalesce(sum(state = 'done'), 0) AS completed, coalesce(sum(state = 'failed'), 0) AS failed FROM jobs").get() as unknown as Record<string, number>;
    table = { enqueued: Number(row.enqueued), completed: Number(row.completed), failed: Number(row.failed) };
  } finally {
    db.close();
  }
  const scraped = new Map<string, number>();
  for (const line of metrics.toString("utf8").split("\n")) {
    const match = /^(paridad_release_jobs_[a-z]+_total) (\S+)$/.exec(line);
    if (match !== null) scraped.set(match[1]!, Number(match[2]));
  }
  for (const [key, name] of Object.entries(COUNTERS) as [keyof typeof COUNTERS, string][]) {
    const value = scraped.get(name);
    if (value !== table[key]) failures.push(`${name} is ${value ?? "missing"} in metrics.txt; the jobs table gives ${table[key]}`);
  }
  if (table.failed < 1) failures.push("the jobs table has no failed job");
  process.stdout.write(`c23: jobs enqueued=${table.enqueued} completed=${table.completed} failed=${table.failed}, failures=${failures.length}\n`);
}

try {
  await main();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}
writeFileSync(join(runDir, "failures.jsonl"), failures.map((reason) => `${JSON.stringify({ reason })}\n`).join(""));
for (const reason of failures) process.stderr.write(`c23: ${reason}\n`);
process.exit(failures.length === 0 ? 0 : 1);
