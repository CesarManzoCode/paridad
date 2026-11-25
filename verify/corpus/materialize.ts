// node verify/corpus/materialize.ts [pair…]
// Writes .paridad/corpus/<pair>/base.yaml and revision.yaml for the compatibility
// corpus (vault/CONTRACT.md §10, D04, D11), every included pair when none is named.
// It needs no network: a history pair reads both sides of resend.yaml from
// verify/corpus/resend-openapi.bundle, cloned once into .paridad/corpus/resend-openapi.git;
// a synthetic pair applies its RFC 6902 patch (verify/corpus/synthetic/<id>.json) to
// spec/resend.yaml. History sides are the bytes of the commit as they are; both sides
// of a synthetic pair are the parsed spec written as JSON, which is YAML, so the only
// difference between them is the patch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const CORPUS = join(ROOT, "verify/corpus");
const OUT = join(ROOT, ".paridad/corpus");
const CLONE = join(OUT, "resend-openapi.git");

export interface HistoryPair {
  pair: string;
  base: string;
  revision: string;
  status: "included" | "excluded";
  reason: string | null;
  complete_operation_ids: boolean;
}

export interface History {
  repository: string;
  bundle: string;
  ref: string;
  head: string;
  path: string;
  pairs: HistoryPair[];
}

export interface SyntheticPatch {
  id: string;
  mutation: string;
  file: string;
}

export interface Synthetic {
  spec: string;
  sha256: string;
  patches: SyntheticPatch[];
}

export type Operation =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

export interface CorpusPair {
  pair: string;
  kind: "history" | "synthetic";
}

export function readHistory(): History {
  return JSON.parse(readFileSync(join(CORPUS, "history.json"), "utf8")) as History;
}

export function readSynthetic(): Synthetic {
  return JSON.parse(readFileSync(join(CORPUS, "synthetic.json"), "utf8")) as Synthetic;
}

export function readPatch(patch: SyntheticPatch): Operation[] {
  return JSON.parse(readFileSync(join(CORPUS, patch.file), "utf8")) as Operation[];
}

// Synthetic pairs are named s-<id>, so they never collide with the hNN-… history pairs.
export function syntheticPair(patch: SyntheticPatch): string {
  return `s-${patch.id}`;
}

// The included history pairs, then the synthetic ones, in file order.
export function corpusPairs(): CorpusPair[] {
  return [
    ...readHistory()
      .pairs.filter((entry) => entry.status === "included")
      .map((entry): CorpusPair => ({ pair: entry.pair, kind: "history" })),
    ...readSynthetic().patches.map((patch): CorpusPair => ({ pair: syntheticPair(patch), kind: "synthetic" })),
  ];
}

// --- RFC 6902 -----------------------------------------------------------------------

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON patch: ${JSON.stringify(pointer)} is not a JSON pointer`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

function container(value: unknown, pointer: string): Container {
  if (typeof value !== "object" || value === null) throw new Error(`JSON patch: ${pointer} is not inside an object or array`);
  return value as Container;
}

// The parent of the last token of `pointer` and that token.
function locate(document: unknown, pointer: string): { parent: Container; key: string } {
  const path = tokens(pointer);
  if (path.length === 0) throw new Error("JSON patch: operations on the whole document are not supported");
  let node: unknown = document;
  for (const token of path.slice(0, -1)) {
    const current = container(node, pointer);
    if (Array.isArray(current) ? !/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length : !Object.hasOwn(current, token)) {
      throw new Error(`JSON patch: ${pointer} does not exist`);
    }
    node = Array.isArray(current) ? current[Number(token)] : current[token];
  }
  return { parent: container(node, pointer), key: path.at(-1)! };
}

function index(array: unknown[], key: string, pointer: string, adding: boolean): number {
  if (adding && key === "-") return array.length;
  if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) > array.length || (!adding && Number(key) === array.length)) {
    throw new Error(`JSON patch: ${pointer} is out of bounds`);
  }
  return Number(key);
}

function get(document: unknown, pointer: string): unknown {
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) return parent[index(parent, key, pointer, false)];
  if (!Object.hasOwn(parent, key)) throw new Error(`JSON patch: ${pointer} does not exist`);
  return parent[key];
}

function add(document: unknown, pointer: string, value: unknown): void {
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) parent.splice(index(parent, key, pointer, true), 0, value);
  else parent[key] = value;
}

function remove(document: unknown, pointer: string): unknown {
  const value = get(document, pointer);
  const { parent, key } = locate(document, pointer);
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
  return value;
}

// Applies the operations in order to `document`, in place, and returns it.
export function applyPatch(document: unknown, operations: Operation[]): unknown {
  for (const operation of operations) {
    switch (operation.op) {
      case "add":
        add(document, operation.path, structuredClone(operation.value));
        break;
      case "remove":
        remove(document, operation.path);
        break;
      case "replace":
        get(document, operation.path);
        remove(document, operation.path);
        add(document, operation.path, structuredClone(operation.value));
        break;
      case "move":
        add(document, operation.path, remove(document, operation.from));
        break;
      case "copy":
        add(document, operation.path, structuredClone(get(document, operation.from)));
        break;
      case "test":
        if (JSON.stringify(get(document, operation.path)) !== JSON.stringify(operation.value)) {
          throw new Error(`JSON patch: test failed at ${operation.path}`);
        }
        break;
      default:
        throw new Error(`JSON patch: unknown operation ${JSON.stringify(operation)}`);
    }
  }
  return document;
}

// --- Materialization ----------------------------------------------------------------

function gitShow(commit: string, path: string): Buffer {
  if (!existsSync(CLONE)) {
    mkdirSync(OUT, { recursive: true });
    execFileSync("git", ["clone", "--quiet", "--bare", join(CORPUS, "resend-openapi.bundle"), CLONE], { stdio: ["ignore", "ignore", "inherit"] });
  }
  return execFileSync("git", ["--git-dir", CLONE, "show", `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

// Writes both sides of `pair` and returns their absolute paths.
export function materialize(pair: string): { base: string; revision: string } {
  let base: string | Buffer;
  let revision: string | Buffer;
  const history = readHistory();
  const entry = history.pairs.find((candidate) => candidate.pair === pair);
  const patch = readSynthetic().patches.find((candidate) => syntheticPair(candidate) === pair);
  if (entry !== undefined) {
    base = gitShow(entry.base, history.path);
    revision = gitShow(entry.revision, history.path);
  } else if (patch !== undefined) {
    const spec = readFileSync(join(ROOT, readSynthetic().spec), "utf8");
    base = `${JSON.stringify(parse(spec), null, 2)}\n`;
    revision = `${JSON.stringify(applyPatch(parse(spec), readPatch(patch)), null, 2)}\n`;
  } else {
    throw new Error(`corpus: there is no pair ${pair}`);
  }
  const dir = join(OUT, pair);
  mkdirSync(dir, { recursive: true });
  const files = { base: join(dir, "base.yaml"), revision: join(dir, "revision.yaml") };
  writeFileSync(files.base, base);
  writeFileSync(files.revision, revision);
  return files;
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const named = process.argv.slice(2);
  for (const pair of named.length > 0 ? named : corpusPairs().map((entry) => entry.pair)) {
    const { base, revision } = materialize(pair);
    process.stdout.write(`${pair}\t${base}\t${revision}\n`);
  }
}
