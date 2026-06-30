import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PitstopError } from "../errors.js";

const WORKFLOW_DIR = join(".github", "workflows");
const WORKFLOW_EXT = /\.ya?ml$/i;

/**
 * Find workflow files under `<cwd>/.github/workflows`. Returns absolute paths,
 * sorted for stable output.
 */
export function discoverWorkflows(cwd: string = process.cwd()): string[] {
  const dir = resolve(cwd, WORKFLOW_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => WORKFLOW_EXT.test(name))
    .map((name) => join(dir, name))
    .sort();
}

/**
 * Resolve the workflow file to operate on. If `explicitPath` is given, use it.
 * Otherwise auto-discover; require exactly one match, or guide the user to
 * disambiguate.
 */
export function resolveWorkflowPath(
  explicitPath: string | undefined,
  cwd: string = process.cwd(),
): string {
  if (explicitPath) return resolve(cwd, explicitPath);

  const found = discoverWorkflows(cwd);
  if (found.length === 0) {
    throw new PitstopError("No workflow files found under .github/workflows/.", {
      hint: "Run Pitstop from your repo root, or point it at a file with --workflow <path>.",
    });
  }
  if (found.length > 1) {
    const list = found.map((p) => `  - ${p}`).join("\n");
    throw new PitstopError("Found more than one workflow file.", {
      hint: `Pick one with --workflow <path>:\n${list}`,
    });
  }
  return found[0]!;
}
