import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseWorkflowDocument } from "../src/parser/workflow.js";
import { registerSignalCleanup, runJob, type ExecutorReporter } from "../src/runner/executor.js";
import type { ContainerEngine, EngineStatus, ExecOptions } from "../src/runner/engine.js";
import type { Prompter, PromptChoice } from "../src/ui.js";

interface ExecCall {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/** A scriptable container engine that records calls and returns queued exit codes. */
class FakeEngine implements ContainerEngine {
  execCalls: ExecCall[] = [];
  shellCalls: { cwd: string; env: Record<string, string> }[] = [];
  removed = false;
  started = false;
  /** Map from command -> queue of exit codes (shift each call; default 0). */
  private codes: Map<string, number[]>;

  constructor(codes: Record<string, number[]> = {}) {
    this.codes = new Map(Object.entries(codes));
  }

  async status(): Promise<EngineStatus> {
    return { installed: true, daemonReachable: true, version: "test" };
  }

  async start(): Promise<string> {
    this.started = true;
    return "container-123";
  }

  async exec(_handle: string, command: string, opts: ExecOptions): Promise<number> {
    this.execCalls.push({ command, cwd: opts.cwd, env: opts.env ?? {} });
    const queue = this.codes.get(command);
    if (queue && queue.length > 0) return queue.shift()!;
    return 0;
  }

  async shell(_handle: string, opts: ExecOptions): Promise<void> {
    this.shellCalls.push({ cwd: opts.cwd, env: opts.env ?? {} });
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

/** A prompter that returns queued answers in order. */
class ScriptedPrompter implements Prompter {
  constructor(private answers: string[]) {}
  async choose(_q: string, choices: PromptChoice[]): Promise<string> {
    const next = this.answers.shift();
    if (next === undefined) throw new Error("ScriptedPrompter ran out of answers");
    if (!choices.some((c) => c.key === next)) {
      throw new Error(`Answer "${next}" is not a valid choice: ${choices.map((c) => c.key).join(",")}`);
    }
    return next;
  }
}

const noopReporter: ExecutorReporter = {
  step: () => {},
  breakpoint: () => {},
  info: () => {},
  dim: () => {},
  success: () => {},
  warn: () => {},
};

/** A reporter that records warnings so tests can assert on notices. */
function recordingReporter(): ExecutorReporter & { warnings: string[] } {
  const warnings: string[] = [];
  return { ...noopReporter, warnings, warn: (msg: string) => warnings.push(msg) };
}

const wf = parseWorkflowDocument(
  {
    env: { WF: "1" },
    jobs: {
      build: {
        "runs-on": "ubuntu-latest",
        env: { JOB: "2" },
        steps: [
          { name: "Checkout", uses: "actions/checkout@v4" },
          { id: "install", name: "Install", run: "npm ci" },
          { id: "test", name: "Test", run: "npm test", env: { STEP: "3" } },
        ],
      },
    },
  },
  "wf.yml",
);

function baseOpts(engine: FakeEngine, prompter: Prompter, over: Partial<Parameters<typeof runJob>[0]> = {}) {
  return {
    workflow: wf,
    jobId: "build",
    breakSteps: new Set<string>(),
    engine,
    prompter,
    reporter: noopReporter,
    secrets: {} as Record<string, string>,
    workspaceHost: "/host/repo",
    image: "test:latest",
    containerName: "pitstop-test",
    keepContainer: false,
    ...over,
  };
}

describe("runJob", () => {
  it("runs all run-steps, skips uses, and removes the container", async () => {
    const engine = new FakeEngine();
    const result = await runJob(baseOpts(engine, new ScriptedPrompter([])));

    expect(result.status).toBe("completed");
    expect(result.executedSteps).toEqual(["install", "test"]);
    expect(engine.execCalls.map((c) => c.command)).toEqual(["npm ci", "npm test"]);
    expect(engine.removed).toBe(true);
  });

  it("layers env: workflow/job on the container, step+secrets per exec", async () => {
    const engine = new FakeEngine();
    await runJob(
      baseOpts(engine, new ScriptedPrompter([]), { secrets: { TOKEN: "xyz" } }),
    );
    const testCall = engine.execCalls.find((c) => c.command === "npm test")!;
    // Per-step env carries the step env and secrets.
    expect(testCall.env).toEqual({ STEP: "3", TOKEN: "xyz" });
  });

  it("keeps the container when asked", async () => {
    const engine = new FakeEngine();
    await runJob(baseOpts(engine, new ScriptedPrompter([]), { keepContainer: true }));
    expect(engine.removed).toBe(false);
  });

  it("pauses at a breakpoint, opens a shell, then runs on 'run'", async () => {
    const engine = new FakeEngine();
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter(["shell", "run"]), {
        breakSteps: new Set(["test"]),
      }),
    );
    expect(engine.shellCalls).toHaveLength(1);
    expect(engine.shellCalls[0]!.cwd).toBe("/github/workspace");
    expect(result.status).toBe("completed");
    expect(result.executedSteps).toContain("test");
  });

  it("skips a step from the breakpoint menu", async () => {
    const engine = new FakeEngine();
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter(["skip"]), { breakSteps: new Set(["test"]) }),
    );
    expect(engine.execCalls.map((c) => c.command)).toEqual(["npm ci"]);
    expect(result.executedSteps).toEqual(["install"]);
    expect(result.status).toBe("completed");
  });

  it("aborts from the breakpoint menu", async () => {
    const engine = new FakeEngine();
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter(["abort"]), { breakSteps: new Set(["install"]) }),
    );
    expect(result.status).toBe("aborted");
    expect(engine.execCalls).toHaveLength(0);
    expect(engine.removed).toBe(true);
  });

  it("retries a failing step until it passes", async () => {
    const engine = new FakeEngine({ "npm test": [1, 0] });
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter(["retry"])),
    );
    expect(engine.execCalls.filter((c) => c.command === "npm test")).toHaveLength(2);
    expect(result.status).toBe("completed");
  });

  it("continues past a failure when chosen", async () => {
    const engine = new FakeEngine({ "npm ci": [1] });
    const result = await runJob(baseOpts(engine, new ScriptedPrompter(["continue"])));
    expect(result.status).toBe("completed");
    expect(result.executedSteps).toEqual(["install", "test"]);
  });

  it("aborts on a failure when chosen and reports the failed step", async () => {
    const engine = new FakeEngine({ "npm ci": [1] });
    const result = await runJob(baseOpts(engine, new ScriptedPrompter(["abort"])));
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("install");
    expect(engine.removed).toBe(true);
  });

  it("opens a shell from the failure menu before deciding", async () => {
    const engine = new FakeEngine({ "npm test": [1] });
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter(["shell", "continue"])),
    );
    expect(engine.shellCalls).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  it("skips an if-guarded step with a notice instead of running it", async () => {
    const guarded = parseWorkflowDocument(
      {
        jobs: {
          build: {
            "runs-on": "ubuntu-latest",
            steps: [
              { id: "always", name: "Always", run: "npm ci" },
              {
                id: "deploy",
                name: "Deploy",
                run: "npm run deploy",
                if: "github.ref == 'refs/heads/main'",
              },
            ],
          },
        },
      },
      "wf.yml",
    );
    const engine = new FakeEngine();
    const reporter = recordingReporter();
    const result = await runJob(
      baseOpts(engine, new ScriptedPrompter([]), {
        workflow: guarded,
        reporter,
        secrets: { TOKEN: "real-secret" },
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.executedSteps).toEqual(["always"]);
    expect(engine.execCalls.map((c) => c.command)).toEqual(["npm ci"]);
    const notice = reporter.warnings.find((w) => w.includes("if:"));
    expect(notice).toBeDefined();
    expect(notice).toContain("github.ref == 'refs/heads/main'");
  });
});

describe("registerSignalCleanup", () => {
  function setup(over: { keepContainer?: boolean } = {}) {
    const engine = new FakeEngine();
    const proc = new EventEmitter();
    let exitCode: number | undefined;
    let resolveExit!: () => void;
    const exited = new Promise<void>((res) => (resolveExit = res));
    const release = registerSignalCleanup({
      engine,
      handle: "container-123",
      containerName: "pitstop-test",
      keepContainer: over.keepContainer ?? false,
      reporter: noopReporter,
      proc,
      exit: (code) => {
        exitCode = code;
        resolveExit();
      },
    });
    return { engine, proc, exited, getExitCode: () => exitCode, release };
  }

  it("removes the container and exits 130 on SIGINT", async () => {
    const { engine, proc, exited, getExitCode } = setup();
    proc.emit("SIGINT");
    await exited;
    expect(getExitCode()).toBe(130);
    expect(engine.removed).toBe(true);
  });

  it("exits 143 on SIGTERM", async () => {
    const { engine, proc, exited, getExitCode } = setup();
    proc.emit("SIGTERM");
    await exited;
    expect(getExitCode()).toBe(143);
    expect(engine.removed).toBe(true);
  });

  it("honours --keep: leaves the container but still exits", async () => {
    const { engine, proc, exited, getExitCode } = setup({ keepContainer: true });
    proc.emit("SIGINT");
    await exited;
    expect(getExitCode()).toBe(130);
    expect(engine.removed).toBe(false);
  });

  it("does nothing after the handlers are released", async () => {
    const { engine, proc, release, getExitCode } = setup();
    release();
    proc.emit("SIGINT");
    // Give any (buggy) async cleanup a chance to run.
    await new Promise((res) => setImmediate(res));
    expect(getExitCode()).toBeUndefined();
    expect(engine.removed).toBe(false);
  });
});
