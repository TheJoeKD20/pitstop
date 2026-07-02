import { describe, expect, it } from "vitest";
import { parseWorkflowDocument } from "../src/parser/workflow.js";
import {
  getJob,
  getStep,
  stepLabel,
  topologicalJobOrder,
  upstreamJobs,
} from "../src/parser/graph.js";
import { PitstopError } from "../src/errors.js";
import type { Workflow } from "../src/parser/types.js";

function wf(jobs: Record<string, unknown>): Workflow {
  return parseWorkflowDocument({ jobs }, "wf.yml");
}

const job = (extra: Record<string, unknown> = {}) => ({
  "runs-on": "ubuntu-latest",
  steps: [],
  ...extra,
});

describe("topologicalJobOrder", () => {
  it("orders dependencies before dependents", () => {
    const order = topologicalJobOrder(
      wf({
        deploy: job({ needs: ["test"] }),
        test: job({ needs: ["build"] }),
        build: job(),
      }),
    );
    expect(order.indexOf("build")).toBeLessThan(order.indexOf("test"));
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("deploy"));
  });

  it("detects dependency cycles", () => {
    expect(() =>
      topologicalJobOrder(wf({ a: job({ needs: ["b"] }), b: job({ needs: ["a"] }) })),
    ).toThrow(/cycle/i);
  });

  it("rejects needs that reference unknown jobs", () => {
    expect(() => topologicalJobOrder(wf({ a: job({ needs: ["ghost"] }) }))).toThrow(/no such job/);
  });
});

describe("upstreamJobs", () => {
  it("returns transitive prerequisites in execution order", () => {
    const w = wf({
      build: job(),
      test: job({ needs: ["build"] }),
      deploy: job({ needs: ["test"] }),
    });
    expect(upstreamJobs(w, "deploy")).toEqual(["build", "test"]);
    expect(upstreamJobs(w, "build")).toEqual([]);
  });
});

describe("getJob / getStep", () => {
  it("throws a helpful error for an unknown job", () => {
    expect(() => getJob(wf({ a: job() }), "b")).toThrow(/No job named "b"/);
  });

  it("finds steps by id and errors helpfully otherwise", () => {
    const w = wf({
      a: job({ steps: [{ id: "compile", run: "make" }] }),
    });
    expect(getStep(getJob(w, "a"), "compile").run).toBe("make");
    expect(() => getStep(getJob(w, "a"), "nope")).toThrow(PitstopError);
  });
});

describe("stepLabel", () => {
  it("prefers name, then uses, then first run line, then id", () => {
    const w = wf({
      a: job({
        steps: [
          { name: "Named", run: "x" },
          { uses: "actions/checkout@v4" },
          { run: "echo hello\necho world" },
        ],
      }),
    });
    const steps = getJob(w, "a").steps;
    expect(stepLabel(steps[0]!)).toBe("Named");
    expect(stepLabel(steps[1]!)).toBe("actions/checkout@v4");
    expect(stepLabel(steps[2]!)).toBe("echo hello");
  });

  it("truncates very long run commands", () => {
    const w = wf({ a: job({ steps: [{ run: "x".repeat(100) }] }) });
    expect(stepLabel(getJob(w, "a").steps[0]!).length).toBeLessThanOrEqual(50);
  });
});
