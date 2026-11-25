// node verify/c30.ts <run dir>   (make verify C=c30)
// C30 (contract §9, D17): `go tool scc --format json` inside tools/ (scc v3.7.0 of
// tools/go.mod; see sccArgs in verify/oss.ts) over the product paths (generator,
// compat, release, cli, mcp) and the support paths (harness, verify), each side once
// without tests (directories test/tests, *.test.ts, *_test.go, test_*.py) and once
// with them; the test lines are the difference and are reported apart. Lines of code
// are scc's `Code` (no comments, no blanks). Writes the raw outputs to out/ and
// summary.json, prints both totals and their ratio, and exits 1 if support >= product.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./command.ts";
import { PRODUCT_PATHS, sccArgs, SUPPORT_PATHS } from "./oss.ts";

const ROOT = resolve(import.meta.dirname, "..");

interface SccLanguage {
  Name: string;
  Code: number;
}

const runDir = process.argv[2]!;
const out = join(runDir, "out");

async function count(side: string, paths: string[], withTests: boolean): Promise<{ total: number; languages: Record<string, number> }> {
  const name = `${side}${withTests ? "-with-tests" : ""}`;
  const absolute = paths.map((path) => join(ROOT, path));
  const result = await runCommand(["go", ...sccArgs(absolute, withTests)], { cwd: join(ROOT, "tools"), out: join(out, name) });
  if (result.code !== 0) throw new Error(`scc for ${name} exited ${result.code}`);
  const languages: Record<string, number> = {};
  for (const language of JSON.parse(result.stdout) as SccLanguage[]) languages[language.Name] = language.Code;
  return { total: Object.values(languages).reduce((sum, code) => sum + code, 0), languages };
}

const product = await count("product", PRODUCT_PATHS, false);
const support = await count("support", SUPPORT_PATHS, false);
const productTests = (await count("product", PRODUCT_PATHS, true)).total - product.total;
const supportTests = (await count("support", SUPPORT_PATHS, true)).total - support.total;
const ratio = support.total === 0 ? null : product.total / support.total;

writeFileSync(
  join(runDir, "summary.json"),
  `${JSON.stringify({ product, support, tests: { product: productTests, support: supportTests }, ratio }, null, 2)}\n`,
);
process.stdout.write(`c30: product=${product.total} (${PRODUCT_PATHS.join(", ")})\n`);
process.stdout.write(`c30: support=${support.total} (${SUPPORT_PATHS.join(", ")})\n`);
process.stdout.write(`c30: tests apart: product=${productTests} support=${supportTests}\n`);
process.stdout.write(`c30: product/support=${ratio === null ? "inf" : ratio.toFixed(3)}\n`);
process.exit(support.total >= product.total ? 1 : 0);
