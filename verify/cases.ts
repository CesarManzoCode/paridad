// Neutral cases (contract §8) and the comparison of the requests that each surface
// sent for a case (§7.1), shared by the criteria runners.
import type { IR } from "../generator/src/ir.ts";
import { differences, normalize, type RawRequest } from "../harness/normalize.ts";

// What a driver executes: the operation, its parameters, body and idempotency key,
// and whether to walk every page with the idiomatic iterator.
export interface Case {
  case: string;
  operation: string;
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  idempotency_key: string | null;
  iterate: boolean;
}

// A captured request with the case and surface it was attributed to (captures.jsonl).
export interface CaseCapture extends RawRequest {
  case: string | null;
  surface: string | null;
  seq: number;
}

export interface Difference {
  case: string;
  // Difference fields of §7.1, plus `count` when the number of requests differs.
  fields: string[];
  // Surfaces whose requests differ from those of the first surface.
  surfaces: string[];
}

export const TEST_KEY = "re_paridad_test_9f8e7d6c5b4a39281706";

// `<operationId>#example` for every operation, from examples[0] of the IR.
export function exampleCases(ir: IR): Case[] {
  return ir.operations.map((op) => {
    const example = op.examples[0];
    if (example === undefined) throw new Error(`${op.id} has no example in the IR`);
    return {
      case: `${op.id}#example`,
      operation: op.id,
      path: example.path,
      query: example.query,
      headers: example.headers,
      body: example.body,
      idempotency_key: null,
      iterate: false,
    };
  });
}

// `#` and `/` of a case id become `_` in file names (contract §8).
export function caseFile(id: string): string {
  return id.replace(/[#/]/g, "_");
}

// Cases whose normalized requests are not identical in every surface. A surface
// without requests for a case counts as a difference.
export function compareCaptures(caseIds: string[], surfaces: string[], captures: CaseCapture[]): Difference[] {
  const found = new Map<string, CaseCapture[]>();
  for (const capture of captures) {
    if (capture.case === null || capture.surface === null) continue;
    const key = `${capture.case}\n${capture.surface}`;
    found.set(key, [...(found.get(key) ?? []), capture]);
  }
  const requests = (id: string, surface: string) =>
    (found.get(`${id}\n${surface}`) ?? []).sort((a, b) => a.seq - b.seq).map((capture) => normalize(capture));

  const result: Difference[] = [];
  for (const id of caseIds) {
    const [first, ...others] = surfaces;
    if (first === undefined) break;
    const reference = requests(id, first);
    const fields = new Set<string>();
    const differing = new Set<string>();
    if (reference.length === 0) {
      fields.add("count");
      differing.add(first);
    }
    for (const surface of others) {
      const current = requests(id, surface);
      const seen = new Set<string>();
      if (current.length !== reference.length) seen.add("count");
      for (let index = 0; index < Math.min(current.length, reference.length); index++) {
        for (const field of differences(reference[index]!, current[index]!)) seen.add(field);
      }
      if (seen.size > 0) differing.add(surface);
      for (const field of seen) fields.add(field);
    }
    if (fields.size > 0) result.push({ case: id, fields: [...fields].sort(), surfaces: [...differing] });
  }
  return result;
}
