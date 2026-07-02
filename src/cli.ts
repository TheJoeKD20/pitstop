#!/usr/bin/env node
import { Command } from "commander";
import { isPitstopError } from "./errors.js";
import { ui } from "./ui.js";
import { runCommand, listCommand, doctorCommand, type RunArgs } from "./commands.js";

const program = new Command();

program
  .name("pitstop")
  .description("Debug your CI in the pit, not on the track.")
  .version("0.1.0");

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("run")
  .argument("[job]", "id of the job to run")
  .description("Run a job locally, optionally pausing at a breakpoint")
  .option("-w, --workflow <path>", "path to a workflow file (default: auto-discover)")
  .option("-b, --break <step-id>", "pause before this step id (repeatable)", collect, [])
  .option("-s, --secrets <path>", "path to a secrets file (default: .secrets)")
  .option("-i, --image <image>", "override the container image")
  .option("--keep", "leave the container running after the job finishes", false)
  .option("--dry-run", "show the execution plan without starting a container", false)
  .action(async (job: string | undefined, opts: Record<string, unknown>) => {
    const args: RunArgs = {
      job,
      workflow: opts.workflow as string | undefined,
      break: opts.break as string[],
      secrets: opts.secrets as string | undefined,
      image: opts.image as string | undefined,
      keep: Boolean(opts.keep),
      dryRun: Boolean(opts.dryRun),
    };
    process.exitCode = await runCommand(args);
  });

program
  .command("list")
  .description("List jobs and steps in a workflow")
  .option("-w, --workflow <path>", "path to a workflow file (default: auto-discover)")
  .action(async (opts: Record<string, unknown>) => {
    process.exitCode = await listCommand(opts.workflow as string | undefined);
  });

program
  .command("doctor")
  .description("Check that Docker and workflows are ready to use")
  .action(async () => {
    process.exitCode = await doctorCommand();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isPitstopError(err)) {
      ui.error(err.message, err.hint);
      process.exitCode = err.exitCode;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      ui.error(`Unexpected error: ${message}`);
      process.exitCode = 1;
    }
  }
}

void main();
