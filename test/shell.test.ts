import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellInvocation, isSupportedShell } from "../src/runner/shell.js";
import { PitstopError } from "../src/errors.js";

/**
 * Run `script` with the exact argv Pitstop hands to `docker exec`, but against
 * the local shell — the flag semantics are identical, so this catches any
 * regression to a non-fail-fast invocation (the old `bash -lc`).
 */
function runScript(shell: string | undefined, script: string): Promise<number> {
  const [bin, ...flags] = shellInvocation(shell);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin!, [...flags, script], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? -1));
  });
}

describe("shellInvocation", () => {
  it("runs bash like GitHub: no login shell, fail-fast, pipefail", () => {
    expect(shellInvocation("bash")).toEqual([
      "bash",
      "--noprofile",
      "--norc",
      "-eo",
      "pipefail",
      "-c",
    ]);
    expect(shellInvocation(undefined)).toEqual(shellInvocation("bash"));
  });

  it("runs sh with -e", () => {
    expect(shellInvocation("sh")).toEqual(["sh", "-e", "-c"]);
  });

  it("rejects unsupported shells with an actionable error", () => {
    expect(() => shellInvocation("pwsh")).toThrow(PitstopError);
    expect(() => shellInvocation("pwsh")).toThrow(/Unsupported shell/);
  });

  it("knows which shells are supported", () => {
    expect(isSupportedShell("bash")).toBe(true);
    expect(isSupportedShell("sh")).toBe(true);
    expect(isSupportedShell("pwsh")).toBe(false);
  });

  // Regression: under the old `bash -lc` invocation this script exited 0
  // because only the final command's status was reported.
  it("fails a multi-line bash script whose first line fails", async () => {
    const code = await runScript("bash", "false\necho ok");
    expect(code).not.toBe(0);
  });

  it("fails a bash pipeline whose left side fails (pipefail)", async () => {
    const code = await runScript(undefined, "false | cat");
    expect(code).not.toBe(0);
  });

  it("fails a multi-line sh script whose first line fails", async () => {
    const code = await runScript("sh", "false\necho ok");
    expect(code).not.toBe(0);
  });

  it("still succeeds for a healthy multi-line script", async () => {
    const code = await runScript("bash", "true\necho ok");
    expect(code).toBe(0);
  });
});
