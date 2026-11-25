// What the C26 and C30 runners share with their test (verify/oss.test.ts): the
// surfaces where the operation added by verify/c26/add-operation.patch must appear,
// and the paths and test exclusions of the line count of D17.

// C26 (contract §9): the five surfaces and the documentation.
export const C26_SURFACES = ["sdks/typescript", "sdks/python", "sdks/go", "cli", "mcp", "docs"];

// The operationIds that a patch adds, read from its added lines.
export function addedOperationIds(patch: string): string[] {
  return [...patch.matchAll(/^\+\s+operationId:\s*(\S+)\s*$/gm)].map((match) => match[1]!);
}

// D17: product and support paths of C30; generated SDKs count in neither.
export const PRODUCT_PATHS = ["generator", "compat", "release", "cli", "mcp"];
export const SUPPORT_PATHS = ["harness", "verify"];

// Test files of the three languages, as a regular expression valid in JavaScript and
// in Go (scc --not-match), on a file name or a path.
export const TEST_FILE_PATTERN = String.raw`\.test\.ts$|_test\.go$|(^|/)test_[^/]*\.py$`;
// Test directories, plus the ones scc must never walk.
export const EXCLUDED_DIRS = [".git", "node_modules", "test", "tests"];

// Arguments of `go tool scc …` run inside tools/ (scc v3.7.0 of tools/go.mod), over
// absolute paths; without tests unless `withTests`. `go tool -modfile=tools/go.mod`
// from the root does not work: with no go.mod there, go answers "cannot find main
// module, but -modfile was set".
export function sccArgs(paths: string[], withTests: boolean): string[] {
  const args = ["tool", "scc", "--format", "json"];
  if (withTests) args.push("--exclude-dir", ".git,node_modules");
  else args.push("--exclude-dir", EXCLUDED_DIRS.join(","), "--not-match", TEST_FILE_PATTERN);
  return [...args, ...paths];
}
