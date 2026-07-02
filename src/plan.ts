import { PitstopError } from "./errors.js";
import { getJob, stepLabel, upstreamJobs } from "./parser/graph.js";
import type { Workflow } from "./parser/types.js";
import { resolveImage, type ResolvedImage } from "./runner/images.js";
import { isSupportedShell, SUPPORTED_SHELLS } from "./runner/shell.js";

export interface PlannedStep {
  position: number | null; // 1-based among runnable steps, null for skipped steps
  id: string;
  label: string;
  kind: "run" | "uses";
  willRun: boolean;
  isBreak: boolean;
  /** Raw `if:` condition when present. Not evaluated in v0.1 — the step is skipped. */
  condition?: string;
}

export interface JobPlan {
  jobId: string;
  jobName?: string;
  runsOn: string | string[];
  image: ResolvedImage;
  upstream: string[];
  steps: PlannedStep[];
  breakSteps: string[];
  unknownBreaks: string[];
}

/**
 * Build a render-ready plan for running a job: the image we'd use, upstream
 * jobs we won't run, and the ordered steps with breakpoints marked. Throws a
 * {@link PitstopError} for jobs/steps Pitstop can't execute faithfully:
 * reusable-workflow jobs, unsupported shells, and breakpoints on steps that
 * will never run (a breakpoint that can't fire is worse than an error).
 */
export function planJob(opts: {
  workflow: Workflow;
  jobId: string;
  breakSteps: string[];
  imageOverride?: string;
}): JobPlan {
  const job = getJob(opts.workflow, opts.jobId);

  if (job.uses !== undefined) {
    throw new PitstopError(
      `Job "${job.id}" calls a reusable workflow (uses: ${job.uses}), which Pitstop v0.1 can't run.`,
      {
        hint: "Reusable-workflow jobs are skipped. Run `pitstop list` to see the runnable jobs in this file.",
      },
    );
  }

  const breakSet = new Set(opts.breakSteps);
  const known = new Set(job.steps.map((s) => s.id));
  const unknownBreaks = opts.breakSteps.filter((id) => !known.has(id));

  let position = 0;
  const steps: PlannedStep[] = job.steps.map((s) => {
    const isRun = s.run !== undefined;
    const willRun = isRun && s.if === undefined;
    if (willRun) position += 1;

    if (willRun && s.shell !== undefined && !isSupportedShell(s.shell)) {
      throw new PitstopError(
        `Step "${s.id}" sets \`shell: ${s.shell}\`, which Pitstop v0.1 can't run.`,
        {
          hint: `Supported shells: ${SUPPORTED_SHELLS.join(", ")} (bash is the default). Remove \`shell:\` or switch the step to one of those.`,
        },
      );
    }

    if (breakSet.has(s.id) && !isRun) {
      throw new PitstopError(
        `--break ${s.id} targets a \`uses:\` step (${s.uses}), which never runs in v0.1.`,
        {
          hint: "That's a marketplace action step — Pitstop skips those. Pick the next run: step instead.",
        },
      );
    }
    if (breakSet.has(s.id) && !willRun) {
      throw new PitstopError(
        `--break ${s.id} targets a step guarded by \`if: ${s.if}\`, which Pitstop v0.1 skips.`,
        {
          hint: "Conditions aren't evaluated yet, so that step never runs. Pick an unguarded run: step instead.",
        },
      );
    }

    return {
      position: willRun ? position : null,
      id: s.id,
      label: stepLabel(s),
      kind: isRun ? ("run" as const) : ("uses" as const),
      willRun,
      isBreak: breakSet.has(s.id),
      condition: s.if,
    };
  });

  return {
    jobId: job.id,
    jobName: job.name,
    runsOn: job.runsOn ?? "",
    image: resolveImage({
      override: opts.imageOverride,
      jobContainer: job.container,
      runsOn: job.runsOn ?? "",
    }),
    upstream: upstreamJobs(opts.workflow, opts.jobId),
    steps,
    breakSteps: opts.breakSteps.filter((id) => known.has(id)),
    unknownBreaks,
  };
}
