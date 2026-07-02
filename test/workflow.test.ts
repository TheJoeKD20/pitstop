import { describe, expect, it } from "vitest";
import { parseWorkflowDocument, parseWorkflowFile } from "../src/parser/workflow.js";
import { PitstopError } from "../src/errors.js";

const doc = (jobs: unknown, extra: Record<string, unknown> = {}) => ({
  name: "CI",
  ...extra,
  jobs,
});

describe("parseWorkflowDocument", () => {
  it("parses jobs, steps, and env", () => {
    const wf = parseWorkflowDocument(
      doc(
        {
          build: {
            "runs-on": "ubuntu-latest",
            env: { JOB_LEVEL: "1" },
            steps: [
              { name: "Checkout", uses: "actions/checkout@v4" },
              { id: "install", name: "Install", run: "npm ci", env: { NODE_ENV: "test" } },
            ],
          },
        },
        { env: { GLOBAL: "yes" } },
      ),
      "/repo/.github/workflows/ci.yml",
    );

    expect(wf.name).toBe("CI");
    expect(wf.env).toEqual({ GLOBAL: "yes" });
    expect(Object.keys(wf.jobs)).toEqual(["build"]);

    const build = wf.jobs.build!;
    expect(build.env).toEqual({ JOB_LEVEL: "1" });
    expect(build.steps).toHaveLength(2);
    expect(build.steps[0]!.uses).toBe("actions/checkout@v4");
    expect(build.steps[1]!.id).toBe("install");
    expect(build.steps[1]!.hasExplicitId).toBe(true);
    expect(build.steps[1]!.env).toEqual({ NODE_ENV: "test" });
  });

  it("generates stable ids from step names when none is declared", () => {
    const wf = parseWorkflowDocument(
      doc({
        t: {
          "runs-on": "ubuntu-latest",
          steps: [{ name: "Run Unit Tests!", run: "npm test" }],
        },
      }),
      "wf.yml",
    );
    expect(wf.jobs.t!.steps[0]!.id).toBe("run-unit-tests");
    expect(wf.jobs.t!.steps[0]!.hasExplicitId).toBe(false);
  });

  it("falls back to step-N ids for unnamed steps", () => {
    const wf = parseWorkflowDocument(
      doc({ t: { "runs-on": "ubuntu-latest", steps: [{ run: "echo hi" }] } }),
      "wf.yml",
    );
    expect(wf.jobs.t!.steps[0]!.id).toBe("step-1");
  });

  it("disambiguates colliding step ids", () => {
    const wf = parseWorkflowDocument(
      doc({
        t: {
          "runs-on": "ubuntu-latest",
          steps: [
            { name: "Build", run: "a" },
            { name: "Build", run: "b" },
          ],
        },
      }),
      "wf.yml",
    );
    expect(wf.jobs.t!.steps.map((s) => s.id)).toEqual(["build", "build-2"]);
  });

  it("coerces non-string env values to strings", () => {
    const wf = parseWorkflowDocument(
      doc({ t: { "runs-on": "ubuntu-latest", env: { PORT: 8080, FLAG: true }, steps: [] } }),
      "wf.yml",
    );
    expect(wf.jobs.t!.env).toEqual({ PORT: "8080", FLAG: "true" });
  });

  it("parses needs as a string or array", () => {
    const wf = parseWorkflowDocument(
      doc({
        a: { "runs-on": "ubuntu-latest", steps: [] },
        b: { "runs-on": "ubuntu-latest", needs: "a", steps: [] },
        c: { "runs-on": "ubuntu-latest", needs: ["a", "b"], steps: [] },
      }),
      "wf.yml",
    );
    expect(wf.jobs.b!.needs).toEqual(["a"]);
    expect(wf.jobs.c!.needs).toEqual(["a", "b"]);
  });

  it("reads a container image from a string or object", () => {
    const wf = parseWorkflowDocument(
      doc({
        a: { "runs-on": "ubuntu-latest", container: "node:20", steps: [] },
        b: { "runs-on": "ubuntu-latest", container: { image: "node:18" }, steps: [] },
      }),
      "wf.yml",
    );
    expect(wf.jobs.a!.container).toBe("node:20");
    expect(wf.jobs.b!.container).toBe("node:18");
  });

  describe("errors", () => {
    it("rejects a document with no jobs key", () => {
      expect(() => parseWorkflowDocument({ name: "x" }, "wf.yml")).toThrow(PitstopError);
    });

    it("rejects an empty jobs map", () => {
      expect(() => parseWorkflowDocument({ jobs: {} }, "wf.yml")).toThrow(/empty/);
    });

    it("rejects a job missing runs-on", () => {
      expect(() => parseWorkflowDocument(doc({ a: { steps: [] } }), "wf.yml")).toThrow(
        /missing `runs-on`/,
      );
    });

    it("rejects non-mapping env", () => {
      expect(() =>
        parseWorkflowDocument(doc({ a: { "runs-on": "x", env: ["nope"], steps: [] } }), "wf.yml"),
      ).toThrow(PitstopError);
    });

    it("rejects steps that are not a list", () => {
      expect(() =>
        parseWorkflowDocument(doc({ a: { "runs-on": "x", steps: "nope" } }), "wf.yml"),
      ).toThrow(/not a list/);
    });
  });
});

describe("parseWorkflowFile", () => {
  it("gives a plain-language error when the file is missing", () => {
    try {
      parseWorkflowFile("/definitely/not/here.yml");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PitstopError);
      expect((err as PitstopError).message).toMatch(/not found/);
    }
  });
});
