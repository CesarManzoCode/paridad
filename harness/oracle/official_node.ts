// node harness/oracle/official_node.ts '<case JSON>' | --plan '<case JSON>' | --methods
// Driver of the official Node SDK, npm resend@6.39.0 (contract §7, D08): runs a
// neutral case (§8) with the method and arguments that official-map.json gives,
// against RESEND_BASE_URL with RESEND_API_KEY, and prints one results.jsonl line.
// --plan prints the translated call {method, args} without running it; --methods
// prints every public method of the SDK, found by introspection of the client.
// Run from the repository root.
import { Resend } from "resend";
import { loadOfficialMap, officialCall, type CaseInput } from "./official-map.ts";

interface Case extends CaseInput {
  case: string;
  iterate: boolean;
}

type Method = (...args: unknown[]) => unknown;

// Methods of the objects reachable from the client, by property path. The
// back-reference of every resource to the client (`resend`) and the default
// headers (a standard Headers object) are not part of the SDK surface.
function publicMethods(client: object): string[] {
  const found: string[] = [];
  const clientMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((name) => name !== "constructor");
  for (const name of clientMethods) found.push(name);
  const walk = (value: object, prefix: string, stack: object[]): void => {
    for (const [key, child] of Object.entries(value)) {
      if (key === "resend" || key === "headers" || child === null || typeof child !== "object" || stack.includes(child)) continue;
      const proto = Object.getPrototypeOf(child) as object | null;
      if (proto === null || proto === Object.prototype) continue;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== "constructor" && typeof (child as Record<string, unknown>)[name] === "function") found.push(`${prefix}${key}.${name}`);
      }
      walk(child, `${prefix}${key}.`, [...stack, child]);
    }
  };
  walk(client, "", [client]);
  return found.sort();
}

async function main(): Promise<void> {
  const [first, second] = process.argv.slice(2);
  if (first === "--methods") {
    process.stdout.write(`${JSON.stringify(publicMethods(new Resend("re_methods")))}\n`);
    return;
  }
  const plan = first === "--plan";
  const input = JSON.parse((plan ? second : first) ?? "") as Case;
  if (input.iterate) throw new Error("the official SDKs have no iterator; cases with an oracle do not iterate");
  const call = officialCall(loadOfficialMap(process.cwd()), "ts", input);
  if (call === null) throw new Error(`official-map.json has no Node method for ${input.operation}`);
  if (plan) {
    process.stdout.write(`${JSON.stringify(call)}\n`);
    return;
  }

  const segments = call.method.split(".");
  const name = segments.pop()!;
  let owner: Record<string, unknown> = new Resend() as unknown as Record<string, unknown>;
  for (const segment of segments) owner = owner[segment] as Record<string, unknown>;
  const method = owner[name];
  if (typeof method !== "function") throw new Error(`the Node SDK has no method ${call.method}`);
  const result = (await (method as Method).apply(owner, call.args)) as { error: { name?: string; message?: string; statusCode?: number | null } | null };
  const error = result.error;
  const line = {
    case: input.case,
    surface: "official-node",
    outcome: error === null ? "ok" : "error",
    error: error === null ? null : { code: error.name ?? null, message: error.message ?? null, statusCode: error.statusCode ?? null },
    items: null,
    exit_code: null,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`official node driver: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
