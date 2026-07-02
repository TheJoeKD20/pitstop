import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import yaml from "js-yaml";
import { PitstopError } from "../errors.js";
import type { Workflow, WorkflowJob, WorkflowStep } from "./types.js";

/**
 * Coerce a YAML scalar map (`env:`, `with:`) into a string→string record.
 * GitHub allows numbers and booleans as values; we stringify them so the
 * container sees consistent env values.
 */
function toStringRecord(input: unknown, context: string): Record<string, string> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new PitstopError(`Expected ${context} to be a mapping of key: value.`, {
      hint: `Check the indentation and shape of ${context} in your workflow file.`,
    });
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value == null) {
      out[key] = "";
    } else if (typeof value === "object") {
      throw new PitstopError(
        `Value of ${context}.${key} is not a simple value.`,
        { hint: "Pitstop v0.1 only supports scalar env/with values." },
      );
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function parseStep(raw: unknown, index: number): WorkflowStep {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PitstopError(`Step ${index + 1} is not a mapping.`, {
      hint: "Each list item under `steps:` must be a `- key: value` block.",
    });
  }
  const step = raw as Record<string, unknown>;

  const explicitId = typeof step.id === "string" && step.id.trim() !== "";
  const name = typeof step.name === "string" ? step.name : undefined;

  // Generate a stable, human-targetable id when none is declared.
  let id: string;
  if (explicitId) {
    id = (step.id as string).trim();
  } else if (name) {
    const slug = slugifyName(name);
    id = slug ? `${slug}` : `step-${index + 1}`;
  } else {
    id = `step-${index + 1}`;
  }

  const run = typeof step.run === "string" ? step.run : undefined;
  const uses = typeof step.uses === "string" ? step.uses : undefined;
  if (run === undefined && uses === undefined) {
    const label = name ? `Step "${name}"` : `Step ${index + 1}`;
    throw new PitstopError(`${label} has no \`run:\` command and no \`uses:\` action.`, {
      hint:
        step.run !== undefined
          ? "`run:` must be a string of shell commands. Quote the value if YAML parsed it as a number or boolean."
          : "Every step needs either a `run:` command or a `uses:` action reference.",
    });
  }

  return {
    id,
    hasExplicitId: explicitId,
    name,
    run,
    uses,
    shell: typeof step.shell === "string" ? step.shell : undefined,
    env: toStringRecord(step.env, `steps[${index}].env`),
    with: toStringRecord(step.with, `steps[${index}].with`),
    workingDirectory:
      typeof step["working-directory"] === "string"
        ? (step["working-directory"] as string)
        : undefined,
    if: typeof step.if === "string" ? step.if : undefined,
    index,
  };
}

function ensureUniqueStepIds(steps: WorkflowStep[], jobId: string): void {
  const seen = new Map<string, number>();
  for (const step of steps) {
    const count = (seen.get(step.id) ?? 0) + 1;
    seen.set(step.id, count);
    // Disambiguate collisions (e.g. two unnamed `run` steps slugging the same)
    // by suffixing later occurrences, keeping the first stable.
    if (count > 1) {
      step.id = `${step.id}-${count}`;
    }
  }
  void jobId;
}

function parseJob(jobId: string, raw: unknown): WorkflowJob {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PitstopError(`Job "${jobId}" is not a mapping.`, {
      hint: "Each job under `jobs:` must be a block of keys like `runs-on:` and `steps:`.",
    });
  }
  const job = raw as Record<string, unknown>;

  // A job-level `uses:` calls a reusable workflow. Pitstop v0.1 can't run it,
  // but it must not make the rest of the file unusable — represent it as a
  // non-runnable job so `list` shows it and other jobs still run.
  if (typeof job.uses === "string") {
    let needs: string[] = [];
    if (typeof job.needs === "string") {
      needs = [job.needs];
    } else if (Array.isArray(job.needs)) {
      needs = job.needs.map(String);
    }
    return {
      id: jobId,
      name: typeof job.name === "string" ? job.name : undefined,
      uses: job.uses,
      needs,
      env: {},
      steps: [],
    };
  }

  const runsOn = job["runs-on"];
  if (runsOn == null) {
    throw new PitstopError(`Job "${jobId}" is missing \`runs-on\`.`, {
      hint: `Add a runner label, e.g.\n    ${jobId}:\n      runs-on: ubuntu-latest`,
    });
  }

  const rawSteps = job.steps;
  if (rawSteps != null && !Array.isArray(rawSteps)) {
    throw new PitstopError(`Job "${jobId}" has a \`steps\` value that is not a list.`, {
      hint: "`steps:` must be a YAML list of `- run:` / `- uses:` items.",
    });
  }
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((s, i) => parseStep(s, i))
    : [];
  ensureUniqueStepIds(steps, jobId);

  let needs: string[] = [];
  if (typeof job.needs === "string") {
    needs = [job.needs];
  } else if (Array.isArray(job.needs)) {
    needs = job.needs.map(String);
  }

  let container: string | undefined;
  if (typeof job.container === "string") {
    container = job.container;
  } else if (job.container && typeof job.container === "object") {
    const image = (job.container as Record<string, unknown>).image;
    if (typeof image === "string") container = image;
  }

  return {
    id: jobId,
    name: typeof job.name === "string" ? job.name : undefined,
    runsOn: runsOn as string | string[],
    needs,
    env: toStringRecord(job.env, `jobs.${jobId}.env`),
    steps,
    container,
  };
}

/** Parse already-loaded YAML content into a {@link Workflow}. */
export function parseWorkflowDocument(doc: unknown, path: string): Workflow {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PitstopError(`${basename(path)} does not look like a workflow file.`, {
      hint: "A workflow is a YAML mapping with a top-level `jobs:` key.",
    });
  }
  const root = doc as Record<string, unknown>;

  const rawJobs = root.jobs;
  if (rawJobs == null) {
    throw new PitstopError(`${basename(path)} has no \`jobs:\` section.`, {
      hint: "Pitstop runs jobs, so the file needs at least one job to run.",
    });
  }
  if (typeof rawJobs !== "object" || Array.isArray(rawJobs)) {
    throw new PitstopError(`The \`jobs:\` section in ${basename(path)} must be a mapping.`, {
      hint: "Each job is a key under `jobs:`, e.g. `jobs:\\n  build:\\n    ...`.",
    });
  }

  const jobs: Record<string, WorkflowJob> = {};
  for (const [jobId, rawJob] of Object.entries(rawJobs as Record<string, unknown>)) {
    jobs[jobId] = parseJob(jobId, rawJob);
  }

  if (Object.keys(jobs).length === 0) {
    throw new PitstopError(`${basename(path)} declares \`jobs:\` but it is empty.`, {
      hint: "Add at least one job to run.",
    });
  }

  return {
    name: typeof root.name === "string" ? root.name : undefined,
    path,
    env: toStringRecord(root.env, "env"),
    jobs,
  };
}

/** Read and parse a workflow file from disk. */
export function parseWorkflowFile(filePath: string): Workflow {
  const abs = resolve(filePath);
  let contents: string;
  try {
    contents = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PitstopError(`Workflow file not found: ${filePath}`, {
        hint: "Pass a path with --workflow, or run from a repo that has files under .github/workflows/.",
      });
    }
    throw new PitstopError(`Could not read workflow file: ${filePath}`, {
      hint: code ? `The filesystem reported: ${code}` : undefined,
    });
  }

  let doc: unknown;
  try {
    doc = yaml.load(contents);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new PitstopError(`${basename(abs)} is not valid YAML.`, {
      hint: reason,
    });
  }

  return parseWorkflowDocument(doc, abs);
}
