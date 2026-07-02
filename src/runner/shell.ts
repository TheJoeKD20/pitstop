import { PitstopError } from "../errors.js";

/** Shells Pitstop v0.1 can run `run:` steps with. */
export const SUPPORTED_SHELLS = ["bash", "sh"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** Whether a step's `shell:` value is one Pitstop can execute. */
export function isSupportedShell(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

/**
 * The argv used to execute a step script, mirroring GitHub's own invocations:
 * fail-fast flags, no profile/rc files, no login shell. GitHub runs bash steps
 * with `bash --noprofile --norc -e -o pipefail {0}`, so a multi-line script
 * whose non-final command fails must fail the step — a login shell without
 * `-e` (the old `bash -lc`) would report the last command's exit code only.
 */
export function shellInvocation(shell: string | undefined): string[] {
  const resolved = shell ?? "bash";
  switch (resolved) {
    case "bash":
      return ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c"];
    case "sh":
      return ["sh", "-e", "-c"];
    default:
      throw new PitstopError(`Unsupported shell: "${resolved}".`, {
        hint: `Pitstop v0.1 runs steps with ${SUPPORTED_SHELLS.join(" or ")}. Remove \`shell:\` (bash is the default) or switch the step to one of those.`,
      });
  }
}
