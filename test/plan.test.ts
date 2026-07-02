import { describe, expect, it } from "vitest";
import { PitstopError } from "../src/errors.js";
import { parseWorkflowDocument } from "../src/parser/workflow.js";
import { planJob } from "../src/plan.js";

const workflow = parseWorkflowDocument(
  {
    jobs: {
      build: { "runs-on": "ubuntu-latest", steps: [] },
      test: {
        "runs-on": "ubuntu-latest",
        needs: ["build"],
        steps: [
          { name: "Checkout", uses: "actions/checkout@v4" },
          { id: "install", name: "Install", run: "npm ci" },
          { id: "unit", name: "Unit tests", run: "npm test" },
        ],
      },
    },
  },
  "wf.yml",
);

describe("planJob", () => {
  it("numbers only runnable steps and marks breakpoints", () => {
    const plan = planJob({ workflow, jobId: "test", breakSteps: ["unit"] });

    expect(plan.jobId).toBe("test");
    expect(plan.upstream).toEqual(["build"]);
    expect(plan.steps).toHaveLength(3);

    const [checkout, install, unit] = plan.steps;
    expect(checkout!.willRun).toBe(false);
    expect(checkout!.position).toBeNull();
    expect(install!.position).toBe(1);
    expect(unit!.position).toBe(2);
    expect(unit!.isBreak).toBe(true);
    expect(plan.breakSteps).toEqual(["unit"]);
  });

  it("collects unknown breakpoints separately", () => {
    const plan = planJob({ workflow, jobId: "test", breakSteps: ["nope"] });
    expect(plan.unknownBreaks).toEqual(["nope"]);
    expect(plan.breakSteps).toEqual([]);
  });

  it("resolves the image from runs-on", () => {
    const plan = planJob({ workflow, jobId: "test", breakSteps: [] });
    expect(plan.image.image).toContain("catthehacker/ubuntu");
  });

  it("marks if-guarded steps as skipped and surfaces the condition", () => {
    const wf = parseWorkflowDocument(
      {
        jobs: {
          build: {
            "runs-on": "ubuntu-latest",
            steps: [
              { id: "always", run: "npm ci" },
              { id: "deploy", run: "npm run deploy", if: "github.ref == 'refs/heads/main'" },
            ],
          },
        },
      },
      "wf.yml",
    );
    const plan = planJob({ workflow: wf, jobId: "build", breakSteps: [] });
    const [always, deploy] = plan.steps;
    expect(always!.willRun).toBe(true);
    expect(always!.position).toBe(1);
    expect(deploy!.willRun).toBe(false);
    expect(deploy!.position).toBeNull();
    expect(deploy!.condition).toBe("github.ref == 'refs/heads/main'");
  });

  it("rejects --break on a uses: step, which would never fire", () => {
    const attempt = () => planJob({ workflow, jobId: "test", breakSteps: ["checkout"] });
    expect(attempt).toThrow(PitstopError);
    expect(attempt).toThrow(/uses:/);
    try {
      attempt();
    } catch (err) {
      expect((err as PitstopError).hint).toMatch(/marketplace action/);
    }
  });

  it("rejects --break on an if-guarded step, which would never fire", () => {
    const wf = parseWorkflowDocument(
      {
        jobs: {
          build: {
            "runs-on": "ubuntu-latest",
            steps: [{ id: "deploy", run: "npm run deploy", if: "success()" }],
          },
        },
      },
      "wf.yml",
    );
    expect(() => planJob({ workflow: wf, jobId: "build", breakSteps: ["deploy"] })).toThrow(
      /guarded by `if: success\(\)`/,
    );
  });

  it("rejects unsupported shells at plan time", () => {
    const wf = parseWorkflowDocument(
      {
        jobs: {
          build: {
            "runs-on": "ubuntu-latest",
            steps: [{ id: "win", run: "Get-ChildItem", shell: "pwsh" }],
          },
        },
      },
      "wf.yml",
    );
    const attempt = () => planJob({ workflow: wf, jobId: "build", breakSteps: [] });
    expect(attempt).toThrow(PitstopError);
    expect(attempt).toThrow(/shell: pwsh/);
  });

  it("accepts bash and sh shells", () => {
    const wf = parseWorkflowDocument(
      {
        jobs: {
          build: {
            "runs-on": "ubuntu-latest",
            steps: [
              { id: "a", run: "echo a", shell: "bash" },
              { id: "b", run: "echo b", shell: "sh" },
            ],
          },
        },
      },
      "wf.yml",
    );
    expect(() => planJob({ workflow: wf, jobId: "build", breakSteps: [] })).not.toThrow();
  });

  it("rejects planning a reusable-workflow (job-level uses:) job", () => {
    const wf = parseWorkflowDocument(
      {
        jobs: {
          build: { "runs-on": "ubuntu-latest", steps: [{ id: "a", run: "echo a" }] },
          release: { uses: "org/repo/.github/workflows/release.yml@main" },
        },
      },
      "wf.yml",
    );
    // The rest of the file stays plannable...
    expect(() => planJob({ workflow: wf, jobId: "build", breakSteps: [] })).not.toThrow();
    // ...but the reusable job itself is rejected with a clear message.
    expect(() => planJob({ workflow: wf, jobId: "release", breakSteps: [] })).toThrow(
      /reusable workflow/,
    );
  });
});
