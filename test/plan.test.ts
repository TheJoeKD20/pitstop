import { describe, expect, it } from "vitest";
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
});
