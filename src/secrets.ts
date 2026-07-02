import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PitstopError } from "./errors.js";

export interface LoadSecretsResult {
  /** Parsed key→value pairs. */
  values: Record<string, string>;
  /** Absolute path that was read, or null if no file was present. */
  path: string | null;
}

/**
 * Parse a dotenv-style secrets file. Supports:
 *   - `KEY=value`
 *   - blank lines and `#` comments
 *   - optional `export ` prefix
 *   - single- or double-quoted values (quotes stripped)
 *   - inline `#` comments on unquoted values
 *
 * This is intentionally small and dependency-free. It is not a full dotenv
 * implementation — multiline values are not supported in v0.1.
 */
export function parseSecrets(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new PitstopError(`Malformed secrets line ${i + 1}: "${lines[i]!.trim()}".`, {
        hint: "Each line must be KEY=value, a # comment, or blank.",
      });
    }

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new PitstopError(`Invalid secret name on line ${i + 1}: "${key}".`, {
        hint: "Names must start with a letter or underscore and contain only letters, digits, and underscores.",
      });
    }

    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip an inline comment from an unquoted value.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Load secrets from `filePath` (default `.secrets` in `cwd`). A missing file is
 * not an error — secrets are optional — but a present-and-unreadable or
 * malformed file is.
 */
export function loadSecrets(
  filePath: string | undefined,
  cwd: string = process.cwd(),
): LoadSecretsResult {
  const explicit = filePath !== undefined;
  const path = resolve(cwd, filePath ?? ".secrets");

  if (!existsSync(path)) {
    if (explicit) {
      throw new PitstopError(`Secrets file not found: ${filePath}`, {
        hint: "Check the path, or omit --secrets to use the default .secrets file.",
      });
    }
    return { values: {}, path: null };
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new PitstopError(`Could not read secrets file: ${path}`);
  }

  return { values: parseSecrets(contents), path };
}

/**
 * Layer environment variables in GitHub Actions precedence order (later wins):
 *   workflow env  <  job env  <  step env  <  secrets
 *
 * Secrets are injected last so a debugging session always sees real values,
 * even if a workflow defines a placeholder env var with the same name.
 */
export function layerEnv(
  layers: {
    workflow?: Record<string, string>;
    job?: Record<string, string>;
    step?: Record<string, string>;
    secrets?: Record<string, string>;
  },
): Record<string, string> {
  return {
    ...(layers.workflow ?? {}),
    ...(layers.job ?? {}),
    ...(layers.step ?? {}),
    ...(layers.secrets ?? {}),
  };
}
