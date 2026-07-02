import { resolveWorkflowPath, discoverWorkflows } from "./parser/discover.js";
import { getJob, stepLabel } from "./parser/graph.js";
import { parseWorkflowFile } from "./parser/workflow.js";
import { PitstopError } from "./errors.js";
import { planJob, type JobPlan } from "./plan.js";
import { runJob } from "./runner/executor.js";
import { DockerEngine } from "./runner/docker.js";
import { loadSecrets } from "./secrets.js";
import { ui, TerminalPrompter } from "./ui.js";

export interface RunArgs {
  job?: string;
  workflow?: string;
  break: string[];
  secrets?: string;
  image?: string;
  keep: boolean;
  dryRun: boolean;
}

function renderPlan(plan: JobPlan): void {
  ui.info(`${ui.raw.bold("Job:")} ${plan.jobId}${plan.jobName ? ui.raw.dim(`  (${plan.jobName})`) : ""}`);
  ui.info(`${ui.raw.bold("Runs on:")} ${Array.isArray(plan.runsOn) ? plan.runsOn.join(", ") : plan.runsOn}`);
  ui.info(`${ui.raw.bold("Image:")} ${plan.image.image} ${ui.raw.dim(`(${plan.image.reason})`)}`);
  if (plan.image.approximate) {
    ui.warn("This image only approximates the requested runner. Some tooling may differ.");
  }
  if (plan.upstream.length > 0) {
    ui.warn(`This job needs: ${plan.upstream.join(", ")} — Pitstop v0.1 will NOT run those first.`);
  }

  ui.info("");
  ui.info(ui.raw.bold("Steps:"));
  for (const step of plan.steps) {
    const marker = step.isBreak ? ui.raw.magenta("⏸ ") : "  ";
    const num = step.willRun ? ui.raw.dim(`${String(step.position).padStart(2)}.`) : ui.raw.dim(" — ");
    let skipNote = "";
    if (!step.willRun) {
      skipNote =
        step.kind === "uses"
          ? ui.raw.dim("  (uses: — skipped in v0.1)")
          : ui.raw.dim(`  (if: ${step.condition} — skipped, conditions not evaluated in v0.1)`);
    }
    ui.info(`${marker}${num} ${step.label} ${ui.raw.dim(`[${step.id}]`)}${skipNote}`);
  }

  if (plan.unknownBreaks.length > 0) {
    ui.info("");
    ui.warn(`Unknown --break target(s): ${plan.unknownBreaks.join(", ")}`);
    ui.dim(`Valid step ids: ${plan.steps.map((s) => s.id).join(", ")}`);
  }
}

/** `pitstop run <job>` */
export async function runCommand(args: RunArgs): Promise<number> {
  const workflowPath = resolveWorkflowPath(args.workflow);
  const workflow = parseWorkflowFile(workflowPath);

  if (!args.job) {
    const jobs = Object.keys(workflow.jobs);
    throw new PitstopError("No job specified.", {
      hint: `Pick one:  pitstop run <job>\nJobs in ${workflowPath}: ${jobs.join(", ")}`,
    });
  }

  const plan = planJob({
    workflow,
    jobId: args.job,
    breakSteps: args.break,
    imageOverride: args.image,
  });

  if (plan.unknownBreaks.length > 0) {
    throw new PitstopError(
      `--break target(s) not found in job "${args.job}": ${plan.unknownBreaks.join(", ")}`,
      { hint: `Valid step ids: ${plan.steps.map((s) => s.id).join(", ")}` },
    );
  }

  ui.info(ui.raw.dim(`workflow: ${workflowPath}`));
  renderPlan(plan);
  ui.info("");

  if (args.dryRun) {
    ui.success("Dry run — nothing was executed.");
    return 0;
  }

  const engine = new DockerEngine();
  const status = await engine.status();
  if (!status.daemonReachable) {
    throw new PitstopError(
      status.installed ? "Docker is installed but the daemon isn't reachable." : "Docker is not installed.",
      {
        hint: `${status.detail ?? ""}\nStart Docker (or run \`pitstop doctor\`), or preview with --dry-run.`.trim(),
      },
    );
  }

  const secrets = loadSecrets(args.secrets);
  if (secrets.path) {
    ui.dim(`Loaded ${Object.keys(secrets.values).length} secret(s) from ${secrets.path}`);
  } else {
    ui.dim("No .secrets file found — continuing without injected secrets.");
  }

  const result = await runJob({
    workflow,
    jobId: args.job,
    breakSteps: new Set(plan.breakSteps),
    engine,
    prompter: new TerminalPrompter(),
    reporter: ui,
    secrets: secrets.values,
    workspaceHost: process.cwd(),
    image: plan.image.image,
    containerName: `pitstop-${args.job}-${process.pid}`,
    keepContainer: args.keep,
  });

  ui.info("");
  switch (result.status) {
    case "completed":
      ui.success(`Job "${args.job}" completed — ${result.executedSteps.length} step(s) ran.`);
      return 0;
    case "failed":
      ui.warn(`Job "${args.job}" failed at step "${result.failedStep}".`);
      return 1;
    case "aborted":
      ui.warn(`Aborted. ${result.executedSteps.length} step(s) ran before stopping.`);
      return 130;
  }
}

/** `pitstop list` */
export async function listCommand(workflowOpt?: string): Promise<number> {
  if (!workflowOpt) {
    const found = discoverWorkflows();
    if (found.length === 0) {
      throw new PitstopError("No workflow files found under .github/workflows/.", {
        hint: "Run from your repo root, or pass --workflow <path>.",
      });
    }
    if (found.length > 1) {
      ui.info(ui.raw.bold("Workflows found:"));
      for (const f of found) ui.info(`  - ${f}`);
      ui.info("");
      ui.dim("Pass one with --workflow <path> to list its jobs and steps.");
    }
    if (found.length > 1) return 0;
  }

  const workflowPath = resolveWorkflowPath(workflowOpt);
  const workflow = parseWorkflowFile(workflowPath);
  ui.info(`${ui.raw.bold("Workflow:")} ${workflow.name ?? "(unnamed)"} ${ui.raw.dim(workflowPath)}`);

  for (const jobId of Object.keys(workflow.jobs)) {
    const job = getJob(workflow, jobId);
    const needs = job.needs.length > 0 ? ui.raw.dim(`  needs: ${job.needs.join(", ")}`) : "";
    ui.info(`\n${ui.raw.cyan(ui.raw.bold(jobId))}${job.name ? ui.raw.dim(`  (${job.name})`) : ""}${needs}`);
    if (job.uses !== undefined) {
      ui.warn(`    uses ${job.uses} — reusable-workflow jobs are skipped in v0.1.`);
      continue;
    }
    for (const step of job.steps) {
      const kind = step.run !== undefined ? ui.raw.green("run ") : ui.raw.yellow("uses");
      ui.info(`    ${kind} ${ui.raw.dim(`[${step.id}]`)} ${stepLabel(step)}`);
    }
  }
  ui.info("");
  ui.dim("Set a breakpoint with:  pitstop run <job> --break <step-id>");
  return 0;
}

/** `pitstop doctor` */
export async function doctorCommand(): Promise<number> {
  ui.info(ui.raw.bold("Pitstop environment check\n"));

  const engine = new DockerEngine();
  const status = await engine.status();
  if (status.daemonReachable) {
    ui.success(`Docker daemon reachable (server ${status.version ?? "?"}).`);
  } else if (status.installed) {
    ui.warn("Docker is installed, but the daemon isn't reachable.");
    if (status.detail) ui.dim(status.detail);
    ui.dim("Start Docker Desktop or the docker service, then re-run `pitstop doctor`.");
  } else {
    ui.warn("Docker was not found on your PATH.");
    ui.dim("Install Docker: https://docs.docker.com/get-docker/");
  }

  ui.info("");
  const workflows = discoverWorkflows();
  if (workflows.length === 0) {
    ui.warn("No workflows found under .github/workflows/.");
    ui.dim("Run Pitstop from a repo that has GitHub Actions workflows.");
  } else {
    ui.success(`Found ${workflows.length} workflow file(s):`);
    for (const w of workflows) ui.dim(`  ${w}`);
  }

  ui.info("");
  return status.daemonReachable ? 0 : 1;
}
