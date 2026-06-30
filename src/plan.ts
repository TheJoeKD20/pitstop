import { getJob, stepLabel, upstreamJobs } from "./parser/graph.js";
import type { Workflow } from "./parser/types.js";
import { resolveImage, type ResolvedImage } from "./runner/images.js";

export interface PlannedStep {
  position: number | null; // 1-based among runnable steps, null for skipped uses:
  id: string;
  label: string;
  kind: "run" | "uses";
  willRun: boolean;
  isBreak: boolean;
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
 * jobs we won't run, and the ordered steps with breakpoints marked.
 */
export function planJob(opts: {
  workflow: Workflow;
  jobId: string;
  breakSteps: string[];
  imageOverride?: string;
}): JobPlan {
  const job = getJob(opts.workflow, opts.jobId);
  const breakSet = new Set(opts.breakSteps);
  const known = new Set(job.steps.map((s) => s.id));
  const unknownBreaks = opts.breakSteps.filter((id) => !known.has(id));

  let position = 0;
  const steps: PlannedStep[] = job.steps.map((s) => {
    const isRun = s.run !== undefined;
    if (isRun) position += 1;
    return {
      position: isRun ? position : null,
      id: s.id,
      label: stepLabel(s),
      kind: isRun ? "run" : "uses",
      willRun: isRun,
      isBreak: breakSet.has(s.id),
    };
  });

  return {
    jobId: job.id,
    jobName: job.name,
    runsOn: job.runsOn,
    image: resolveImage({
      override: opts.imageOverride,
      jobContainer: job.container,
      runsOn: job.runsOn,
    }),
    upstream: upstreamJobs(opts.workflow, opts.jobId),
    steps,
    breakSteps: opts.breakSteps.filter((id) => known.has(id)),
    unknownBreaks,
  };
}
