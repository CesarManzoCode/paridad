// node harness/oracle/ts.ts '<case JSON>'
// Driver of the own TypeScript SDK (contract §7): runs a neutral case (§8) with the
// method that names.ts of the IR gives, against RESEND_BASE_URL with RESEND_API_KEY,
// and prints one results.jsonl line. Run from the repository root.
import { readFileSync } from "node:fs";
import type { IR } from "../../generator/src/ir.ts";

// The SDK is imported by URL so that the harness type check does not pull the
// generated SDK under its stricter tsconfig; C4 checks the SDK with its own.
interface ParidadError extends Error {
  code: string;
  statusCode: number | null;
}
const sdk = (await import(new URL("../../sdks/typescript/src/index.ts", import.meta.url).href)) as {
  Resend: new () => unknown;
  ParidadError: new (...args: never[]) => ParidadError;
};

interface Case {
  case: string;
  operation: string;
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  idempotency_key: string | null;
  iterate: boolean;
}

type Method = (...args: unknown[]) => unknown;

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "") as Case;
  const ir = JSON.parse(readFileSync("ir/ir.json", "utf8")) as IR;
  const op = ir.operations.find((candidate) => candidate.id === input.operation);
  if (op === undefined) throw new Error(`unknown operation ${input.operation}`);

  const [property, name] = op.names.ts.split(".") as [string, string];
  const resource = (new sdk.Resend() as Record<string, Record<string, Method>>)[property]!;
  const args: unknown[] = op.pathParams.map((parameter) => String(input.path[parameter.name]));
  let error: ParidadError | null = null;
  let items: unknown[] | null = null;

  if (input.iterate) {
    if (op.pagination === null) throw new Error(`${op.id} does not paginate`);
    const pageQuery = op.queryParams.filter((parameter) => parameter.name !== op.pagination!.after && parameter.name !== op.pagination!.before);
    if (pageQuery.length > 0) args.push(input.query);
    items = [];
    try {
      for await (const item of resource[`${name}All`]!.apply(resource, args) as AsyncIterable<unknown>) items.push(item);
    } catch (thrown) {
      if (!(thrown instanceof sdk.ParidadError)) throw thrown;
      error = thrown;
    }
  } else {
    if (op.requestBody !== null) args.push(input.body);
    if (op.queryParams.length > 0) args.push(input.query);
    if (op.idempotency) args.push(input.idempotency_key === null ? undefined : { idempotencyKey: input.idempotency_key });
    const result = (await resource[name]!.apply(resource, args)) as { error: ParidadError | null };
    error = result.error;
  }

  const line = {
    case: input.case,
    surface: "ts",
    outcome: error === null ? "ok" : "error",
    error: error === null ? null : { code: error.code, message: error.message, statusCode: error.statusCode },
    items,
    exit_code: null,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`ts driver: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
