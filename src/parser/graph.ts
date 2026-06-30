import { PitstopError } from "../errors.js";
import type { Workflow, WorkflowJob, WorkflowStep } from "./types.js";

/**
 * Produce a topologically-sorted list of job ids honouring `needs`. Throws a
 * plain-language error on dependency cycles or references to unknown jobs.
 *
 * v0.1 runs a single job, but the ordering is what lets us tell a user that a
 * job they picked has upstream dependencies we won't run for them yet.
 */
export function topologicalJobOrder(workflow: Workflow): string[] {
  const jobs = workflow.jobs;
  const ids = Object.keys(jobs);
  const idSet = new Set(ids);

  for (const job of Object.values(jobs)) {
    for (const need of job.needs) {
      if (!idSet.has(need)) {
        throw new PitstopError(
          `Job "${job.id}" needs "${need}", but no such job exists.`,
          { hint: `Available jobs: ${ids.join(", ")}` },
        );
      }
    }
  }

  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const order: string[] = [];
  const stack: string[] = [];

  const visit = (id: string): void => {
    const s = state.get(id);
    if (s === DONE) return;
    if (s === VISITING) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(" → ");
      throw new PitstopError(`Dependency cycle detected between jobs: ${cycle}.`, {
        hint: "Jobs cannot depend on each other in a loop. Break the cycle in `needs:`.",
      });
    }
    state.set(id, VISITING);
    stack.push(id);
    // Deterministic order: visit needs in declaration order.
    for (const need of jobs[id]!.needs) {
      visit(need);
    }
    stack.pop();
    state.set(id, DONE);
    order.push(id);
  };

  for (const id of ids) visit(id);
  return order;
}

/** Look up a job by id, with a helpful error listing valid choices. */
export function getJob(workflow: Workflow, jobId: string): WorkflowJob {
  const job = workflow.jobs[jobId];
  if (!job) {
    const available = Object.keys(workflow.jobs);
    throw new PitstopError(`No job named "${jobId}" in this workflow.`, {
      hint:
        available.length > 0
          ? `Available jobs: ${available.join(", ")}`
          : "This workflow has no jobs.",
    });
  }
  return job;
}

/**
 * The set of jobs that must run before `jobId`, in execution order (excluding
 * `jobId` itself). Used to warn that prerequisites won't run in v0.1.
 */
export function upstreamJobs(workflow: Workflow, jobId: string): string[] {
  getJob(workflow, jobId); // validate existence
  const order = topologicalJobOrder(workflow);

  const required = new Set<string>();
  const collect = (id: string): void => {
    for (const need of workflow.jobs[id]!.needs) {
      if (!required.has(need)) {
        required.add(need);
        collect(need);
      }
    }
  };
  collect(jobId);

  return order.filter((id) => required.has(id));
}

/** Find a step within a job by its id, with helpful suggestions. */
export function getStep(job: WorkflowJob, stepId: string): WorkflowStep {
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) {
    const ids = job.steps.map((s) => s.id);
    throw new PitstopError(
      `Job "${job.id}" has no step with id "${stepId}".`,
      {
        hint:
          ids.length > 0
            ? `Steps in this job: ${ids.join(", ")}`
            : "This job has no steps.",
      },
    );
  }
  return step;
}

/** Human-readable label for a step, preferring its name. */
export function stepLabel(step: WorkflowStep): string {
  if (step.name) return step.name;
  if (step.uses) return step.uses;
  if (step.run) {
    const firstLine = step.run.split("\n")[0]!.trim();
    return firstLine.length > 50 ? `${firstLine.slice(0, 47)}...` : firstLine;
  }
  return step.id;
}
