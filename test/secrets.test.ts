import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layerEnv, loadSecrets, parseSecrets } from "../src/secrets.js";
import { PitstopError } from "../src/errors.js";

describe("parseSecrets", () => {
  it("parses simple KEY=value pairs", () => {
    expect(parseSecrets("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and comments", () => {
    expect(parseSecrets("# comment\n\nFOO=bar\n   # indented\n")).toEqual({ FOO: "bar" });
  });

  it("strips matching quotes and the export prefix", () => {
    expect(parseSecrets('export TOKEN="secret value"\nP=\'p@ss\'')).toEqual({
      TOKEN: "secret value",
      P: "p@ss",
    });
  });

  it("strips inline comments from unquoted values but not quoted ones", () => {
    expect(parseSecrets("A=plain # note\nB=\"keep # this\"")).toEqual({
      A: "plain",
      B: "keep # this",
    });
  });

  it("rejects malformed lines and invalid names", () => {
    expect(() => parseSecrets("NO_EQUALS")).toThrow(PitstopError);
    expect(() => parseSecrets("1BAD=x")).toThrow(/Invalid secret name/);
  });
});

describe("loadSecrets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pitstop-secrets-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty values when the default file is absent", () => {
    const result = loadSecrets(undefined, dir);
    expect(result.values).toEqual({});
    expect(result.path).toBeNull();
  });

  it("loads the default .secrets file when present", () => {
    writeFileSync(join(dir, ".secrets"), "TOKEN=abc123\n");
    const result = loadSecrets(undefined, dir);
    expect(result.values).toEqual({ TOKEN: "abc123" });
    expect(result.path).toContain(".secrets");
  });

  it("errors when an explicit secrets path is missing", () => {
    expect(() => loadSecrets("nope.env", dir)).toThrow(/not found/);
  });
});

describe("layerEnv", () => {
  it("applies precedence workflow < job < step < secrets", () => {
    const merged = layerEnv({
      workflow: { A: "wf", SHARED: "wf" },
      job: { B: "job", SHARED: "job" },
      step: { C: "step", SHARED: "step" },
      secrets: { SHARED: "secret" },
    });
    expect(merged).toEqual({ A: "wf", B: "job", C: "step", SHARED: "secret" });
  });

  it("handles missing layers", () => {
    expect(layerEnv({ job: { X: "1" } })).toEqual({ X: "1" });
    expect(layerEnv({})).toEqual({});
  });
});
