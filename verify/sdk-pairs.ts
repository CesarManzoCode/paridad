// Shared by C19 and C20 (contract §9, §10, D11): the pairs of the corpus that generate
// SDKs (the history pairs with a complete operationId on both sides, and every
// synthetic pair), the generation of each side with `node generator/src/main.ts --spec
// <file> --out <dir>`, and the release bump that compat/ proposes for a pair.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareSdks, releaseBump, type Bump, type SdkReport } from "../compat/src/semver.ts";
import { compareSpecs, report } from "../compat/src/rules.ts";
import type { IR } from "../generator/src/ir.ts";
import { loadSpec } from "../generator/src/spec.ts";
import { runCommand } from "./command.ts";
import { corpusPairs, readHistory, type CorpusPair } from "./corpus/materialize.ts";

const ROOT = resolve(import.meta.dirname, "..");

export function sdkPairs(): CorpusPair[] {
  const complete = new Set(readHistory().pairs.filter((entry) => entry.complete_operation_ids).map((entry) => entry.pair));
  return corpusPairs().filter((entry) => entry.kind === "synthetic" || complete.has(entry.pair));
}

// A generated side: `dir` holds ir/ and sdks/ as `make generate` writes them.
export type Side = { dir: string; ir: IR; rejected: null } | { dir: string; ir: null; rejected: string };

// Generates each distinct spec once (sides are keyed by the sha256 of the file), under
// `work`. A side whose spec the generator rejects (`generator: spec: …`, for example an
// operationId that is not resource/action) is returned with the reason; any other
// failure of the generator throws.
export function sideGenerator(work: string, out: string): (file: string) => Promise<Side> {
  const sides = new Map<string, Side>();
  return async (file) => {
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    const known = sides.get(sha);
    if (known !== undefined) return known;
    const dir = join(work, "sides", sha);
    const result = await runCommand([process.execPath, join(ROOT, "generator/src/main.ts"), "--spec", file, "--out", dir], { cwd: ROOT, out: join(out, `generate-${sha}`) });
    let side: Side;
    if (result.code === 0) side = { dir, ir: JSON.parse(readFileSync(join(dir, "ir/ir.json"), "utf8")) as IR, rejected: null };
    else if (result.stderr.startsWith("generator: spec: ")) side = { dir, ir: null, rejected: result.stderr.trim() };
    else throw new Error(`the generator exited ${result.code} on ${file}: ${result.stderr.trim()}`);
    sides.set(sha, side);
    return side;
  };
}

export interface Proposal {
  contract: Bump;
  sdks: SdkReport;
  proposed: Bump;
}

// The release bump of compat/: the maximum of the contract bump and of the SDK bump.
export function propose(baseFile: string, revisionFile: string, base: IR, revision: IR): Proposal {
  const contract = report(compareSpecs(loadSpec(baseFile), loadSpec(revisionFile))).bump;
  const sdks = compareSdks(base, revision);
  return { contract, sdks, proposed: releaseBump(contract, sdks) };
}
