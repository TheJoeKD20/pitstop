import { getJob, stepLabel } from "../parser/graph.js";
import type { Workflow, WorkflowJob, WorkflowStep } from "../parser/types.js";
import { layerEnv } from "../secrets.js";
import type { Prompter } from "../ui.js";
import type { ContainerEngine } from "./engine.js";

/** Mount point for the repo inside the container — mirrors GitHub's layout. */
export const WORKSPACE_CONTAINER = "/github/workspace";

/** Reporter surface the executor needs. Defaults to the real terminal UI. */
export interface ExecutorReporter {
  step(index: number, total: number, label: string): void;
  breakpoint(label: string): void;
  info(msg: string): void;
  dim(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
}

export interface RunJobOptions {
  workflow: Workflow;
  jobId: string;
  /** Step ids to pause before. */
  breakSteps: Set<string>;
  engine: ContainerEngine;
  prompter: Prompter;
  reporter: ExecutorReporter;
  secrets: Record<string, string>;
  /** Host path to mount as the workspace. */
  workspaceHost: string;
  image: string;
  containerName: string;
  /** Leave the container running after the job finishes. */
  keepContainer: boolean;
}

export type RunStatus = "completed" | "failed" | "aborted";

export interface RunJobResult {
  status: RunStatus;
  executedSteps: string[];
  failedStep?: string;
}

function ghDefaultEnv(): Record<string, string> {
  return {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: WORKSPACE_CONTAINER,
    PITSTOP: "true",
  };
}

function stepCwd(step: WorkflowStep): string {
  if (!step.workingDirectory) return WORKSPACE_CONTAINER;
  const wd = step.workingDirectory.replace(/^\/+/, "");
  return `${WORKSPACE_CONTAINER}/${wd}`;
}

/** The subset of `process` the signal cleanup needs — swappable in tests. */
export interface SignalTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface SignalCleanupOptions {
  engine: ContainerEngine;
  /** Container handle returned by {@link ContainerEngine.start}. */
  handle: string;
  containerName: string;
  /** When true, mirror `--keep`: leave the container running on interrupt. */
  keepContainer: boolean;
  reporter: ExecutorReporter;
  /** Signal source; defaults to the real `process`. */
  proc?: SignalTarget;
  /** Called with the exit code once cleanup finishes; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Remove the job container if the user interrupts the run (Ctrl-C / SIGTERM) —
 * without this, the `sleep infinity` container leaks because the executor's
 * `finally` never runs when the process is killed. Exits 130 for SIGINT and
 * 143 for SIGTERM, matching shell convention. Returns a function that detaches
 * the handlers (call it once the normal cleanup path owns the container again).
 */
export function registerSignalCleanup(opts: SignalCleanupOptions): () => void {
  const proc: SignalTarget = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let triggered = false;

  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (triggered) return;
    triggered = true;
    const code = signal === "SIGINT" ? 130 : 143;
    opts.reporter.warn(`Received ${signal} — stopping.`);
    const cleanup = (async () => {
      if (opts.keepContainer) {
        opts.reporter.info(`Container left running: ${opts.containerName}`);
        opts.reporter.dim(`Remove with:  docker rm -f ${opts.containerName}`);
        return;
      }
      await opts.engine.remove(opts.handle);
    })();
    void cleanup.catch(() => undefined).then(() => exit(code));
  };

  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);
  return () => {
    proc.removeListener("SIGINT", onInt);
    proc.removeListener("SIGTERM", onTerm);
  };
}

/**
 * The interactive menu shown at a breakpoint (before a step runs). Returns the
 * user's decision about whether to run the step.
 */
async function breakpointMenu(
  step: WorkflowStep,
  ctx: { engine: ContainerEngine; handle: string; env: Record<string, string>; prompter: Prompter; reporter: ExecutorReporter },
): Promise<"run" | "skip" | "abort"> {
  for (;;) {
    const choice = await ctx.prompter.choose("What now?", [
      { key: "run", hotkey: "r", label: "un this step" },
      { key: "shell", hotkey: "s", label: "hell" },
      { key: "skip", hotkey: "k", label: "(skip this step)" },
      { key: "abort", hotkey: "a", label: "bort" },
    ]);
    if (choice === "shell") {
      ctx.reporter.dim(`Opening a shell in the container. Type 'exit' to come back.`);
      await ctx.engine.shell(ctx.handle, { cwd: stepCwd(step), env: ctx.env });
      continue;
    }
    return choice as "run" | "skip" | "abort";
  }
}

/**
 * The menu shown after a step fails. Returns whether to retry, continue past the
 * failure, or abort.
 */
async function failureMenu(
  step: WorkflowStep,
  ctx: { engine: ContainerEngine; handle: string; env: Record<string, string>; prompter: Prompter; reporter: ExecutorReporter },
): Promise<"retry" | "continue" | "abort"> {
  for (;;) {
    const choice = await ctx.prompter.choose("Step failed — what now?", [
      { key: "shell", hotkey: "s", label: "hell to investigate" },
      { key: "retry", hotkey: "r", label: "etry the step" },
      { key: "continue", hotkey: "c", label: "ontinue anyway" },
      { key: "abort", hotkey: "a", label: "bort" },
    ]);
    if (choice === "shell") {
      ctx.reporter.dim(`Opening a shell. Edit files or env, then 'exit' to return.`);
      await ctx.engine.shell(ctx.handle, { cwd: stepCwd(step), env: ctx.env });
      continue;
    }
    return choice as "retry" | "continue" | "abort";
  }
}

/**
 * Run a single job to completion (or to a breakpoint/abort), orchestrating the
 * container lifecycle, step execution, breakpoints, and failure handling.
 */
export async function runJob(opts: RunJobOptions): Promise<RunJobResult> {
  const job: WorkflowJob = getJob(opts.workflow, opts.jobId);
  const executed: string[] = [];

  const containerEnv = {
    ...ghDefaultEnv(),
    ...layerEnv({ workflow: opts.workflow.env, job: job.env }),
  };

  const handle = await opts.engine.start({
    image: opts.image,
    name: opts.containerName,
    workspaceHost: opts.workspaceHost,
    workspaceContainer: WORKSPACE_CONTAINER,
    env: containerEnv,
  });

  // From here the container exists — make sure Ctrl-C / SIGTERM can't leak it.
  const releaseSignals = registerSignalCleanup({
    engine: opts.engine,
    handle,
    containerName: opts.containerName,
    keepContainer: opts.keepContainer,
    reporter: opts.reporter,
  });

  const runnable = job.steps.filter((s) => s.run !== undefined && s.if === undefined);
  const total = runnable.length;

  try {
    let position = 0;
    for (const step of job.steps) {
      // v0.1 does not resolve marketplace `uses:` actions. Say so and move on.
      if (step.run === undefined) {
        if (step.uses) {
          opts.reporter.warn(`Skipping uses: ${step.uses} (action resolution is on the roadmap, not in v0.1).`);
        }
        continue;
      }

      // v0.1 has no expression engine, so `if:` can't be evaluated. Running a
      // guarded step anyway (with secrets injected) is the dangerous choice —
      // skip it loudly instead.
      if (step.if !== undefined) {
        opts.reporter.warn(
          `Skipping ${stepLabel(step)} — guarded by \`if: ${step.if}\`, and Pitstop v0.1 does not evaluate conditions.`,
        );
        continue;
      }

      position += 1;
      const label = stepLabel(step);
      const perStepEnv = layerEnv({ step: step.env, secrets: opts.secrets });
      const ctx = {
        engine: opts.engine,
        handle,
        env: perStepEnv,
        prompter: opts.prompter,
        reporter: opts.reporter,
      };

      if (opts.breakSteps.has(step.id)) {
        opts.reporter.breakpoint(label);
        opts.reporter.dim(`step id: ${step.id}   cwd: ${stepCwd(step)}`);
        const decision = await breakpointMenu(step, ctx);
        if (decision === "abort") return { status: "aborted", executedSteps: executed };
        if (decision === "skip") {
          opts.reporter.dim(`Skipped ${step.id}.`);
          continue;
        }
      }

      opts.reporter.step(position, total, label);

      // Run, with a retry loop driven by the failure menu.
      for (;;) {
        const code = await opts.engine.exec(handle, step.run, {
          cwd: stepCwd(step),
          env: perStepEnv,
          shell: step.shell,
        });

        if (code === 0) {
          opts.reporter.success(`${label}`);
          executed.push(step.id);
          break;
        }

        opts.reporter.warn(`${label} exited with code ${code}.`);
        const decision = await failureMenu(step, ctx);
        if (decision === "abort") {
          return { status: "failed", executedSteps: executed, failedStep: step.id };
        }
        if (decision === "continue") {
          executed.push(step.id);
          break;
        }
        // retry: loop again
        opts.reporter.dim(`Retrying ${step.id}...`);
      }
    }

    return { status: "completed", executedSteps: executed };
  } finally {
    releaseSignals();
    if (opts.keepContainer) {
      opts.reporter.info(`Container left running: ${opts.containerName}`);
      opts.reporter.dim(`Attach with:  docker exec -it ${opts.containerName} bash`);
      opts.reporter.dim(`Remove with:  docker rm -f ${opts.containerName}`);
    } else {
      await opts.engine.remove(handle);
    }
  }
}
