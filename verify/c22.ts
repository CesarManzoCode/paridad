// node verify/c22.ts <run dir>   (make verify C=c22)
// C22 (contract §9, §9.3, §10): one reference release of this tree with new registries
// in reference/registries/, and then, for every point of §9.3, the same release with new
// registries in <point>/registries/ where the process that reaches the point runs with
// PARIDAD_RELEASE_PAUSE_AT=<point>, is killed with SIGKILL when it prints
// `paused <point>`, and a service without the variable finishes the job (see
// releaseOnce in verify/registries.ts). Each run keeps its queue in <label>/release, its
// logs in <label>/out and its registries state in <label>/state.json. Writes
// results.jsonl ({"point","differences","problems"}: the lines that differ from the
// reference and the number of problems, null when the job did not end done) and
// failures.jsonl. Exits 0 only if every run ends with the job done and a state
// (package, version, sha256 of each artifact) equal to the reference one, without
// problems (a version without one of its files, a file without its version, a
// duplicated version or a temporary file).
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POINTS } from "../release/src/queue.ts";
import { compareStates, registryState, releaseNames, releaseOnce, startRegistries, type State } from "./registries.ts";

const runDir = process.argv[2]!;
const resultsFile = join(runDir, "results.jsonl");
writeFileSync(resultsFile, "");
const failures: string[] = [];

// One release in <run dir>/<label>; the state of its registries, or null when the job
// did not end done.
async function run(label: string, point?: string): Promise<State | null> {
  const dir = join(runDir, label);
  const out = join(dir, "out");
  const registries = await startRegistries(join(dir, "registries"), out);
  try {
    const job = await releaseOnce({ workdir: join(dir, "release"), registries }, out, point);
    const state = registryState(registries.dir, releaseNames());
    writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    for (const problem of state.problems) failures.push(`${label}: ${problem}`);
    if (job.version === null) {
      failures.push(`${label}: job ${job.id} failed: ${job.error}`);
      return null;
    }
    if (point !== undefined && !job.killed) failures.push(`${label}: the service never paused at ${point}`);
    return state;
  } finally {
    await registries.stop();
  }
}

async function main(): Promise<void> {
  const reference = await run("reference");
  appendFileSync(resultsFile, `${JSON.stringify({ point: "reference", differences: reference === null ? null : [], problems: reference?.problems.length ?? null })}\n`);
  if (reference === null) return;
  if (reference.entries.length === 0) {
    failures.push("reference: the registries are empty");
    return;
  }
  for (const point of POINTS) {
    let differences: string[] | null = null;
    let problems: number | null = null;
    try {
      const state = await run(point, point);
      if (state !== null) {
        differences = compareStates(reference, state);
        problems = state.problems.length;
        for (const difference of differences) failures.push(`${point}: ${difference}`);
      }
    } catch (error) {
      failures.push(`${point}: ${error instanceof Error ? error.message : String(error)}`);
    }
    appendFileSync(resultsFile, `${JSON.stringify({ point, differences, problems })}\n`);
  }
  process.stdout.write(`c22: ${POINTS.length} points against a reference of ${reference.entries.length} artifacts, failures=${failures.length}\n`);
}

try {
  await main();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}
writeFileSync(join(runDir, "failures.jsonl"), failures.map((reason) => `${JSON.stringify({ reason })}\n`).join(""));
for (const reason of failures) process.stderr.write(`c22: ${reason}\n`);
process.exit(failures.length === 0 ? 0 : 1);
