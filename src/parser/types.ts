/**
 * Typed model of a GitHub Actions workflow, reduced to the subset Pitstop v0.1
 * understands. We intentionally do not model the full Actions schema — only the
 * pieces needed to run and breakpoint a single job locally.
 */

/** A single step inside a job. */
export interface WorkflowStep {
  /**
   * Stable identifier used to target a breakpoint. This is the step's own `id`
   * if it declares one, otherwise a generated `step-<n>` slug (1-based).
   */
  id: string;
  /** Whether `id` was explicitly declared in YAML (vs. generated). */
  hasExplicitId: boolean;
  /** The step's `name`, if any. */
  name?: string;
  /** Shell command(s) for a `run` step. */
  run?: string;
  /** Action reference for a `uses` step (e.g. `actions/checkout@v4`). */
  uses?: string;
  /** Explicit shell override (`bash`, `sh`, `pwsh`, ...). */
  shell?: string;
  /** Per-step environment variables. */
  env: Record<string, string>;
  /** `with:` inputs for a `uses` step. */
  with: Record<string, string>;
  /** `working-directory` override, relative to the workspace. */
  workingDirectory?: string;
  /** Raw `if:` condition string, if present (not evaluated in v0.1). */
  if?: string;
  /** 0-based position of this step within the job. */
  index: number;
}

/** A single job inside a workflow. */
export interface WorkflowJob {
  /** The job's key in the `jobs:` map. */
  id: string;
  /** The job's `name`, if any. */
  name?: string;
  /** Raw `runs-on` value. */
  runsOn: string | string[];
  /** Job ids this job depends on (`needs`). */
  needs: string[];
  /** Job-level environment variables. */
  env: Record<string, string>;
  /** Ordered steps. */
  steps: WorkflowStep[];
  /** Explicit container image override from `container:`. */
  container?: string;
}

/** A parsed workflow file. */
export interface Workflow {
  /** The workflow's `name`, if any. */
  name?: string;
  /** Absolute path to the source file. */
  path: string;
  /** Workflow-level environment variables. */
  env: Record<string, string>;
  /** Jobs keyed by id, in declaration order. */
  jobs: Record<string, WorkflowJob>;
}
