import { describe, expect, it } from "vitest";
import { resolveImage, FALLBACK_IMAGE } from "../src/runner/images.js";

describe("resolveImage", () => {
  it("honours an explicit override above everything", () => {
    const r = resolveImage({ override: "my/img:1", jobContainer: "node:20", runsOn: "ubuntu-latest" });
    expect(r.image).toBe("my/img:1");
    expect(r.approximate).toBe(false);
  });

  it("uses the job container when there's no override", () => {
    const r = resolveImage({ jobContainer: "node:20", runsOn: "ubuntu-latest" });
    expect(r.image).toBe("node:20");
  });

  it("maps known ubuntu runners", () => {
    expect(resolveImage({ runsOn: "ubuntu-latest" }).image).toContain("catthehacker/ubuntu");
    expect(resolveImage({ runsOn: "ubuntu-22.04" }).image).toContain("22.04");
  });

  it("takes the first label from an array", () => {
    const r = resolveImage({ runsOn: ["ubuntu-latest", "self-hosted"] });
    expect(r.image).toContain("catthehacker/ubuntu");
  });

  it("falls back and flags approximate for windows/macos and unknown runners", () => {
    const win = resolveImage({ runsOn: "windows-latest" });
    expect(win.image).toBe(FALLBACK_IMAGE);
    expect(win.approximate).toBe(true);

    const unknown = resolveImage({ runsOn: "some-custom-runner" });
    expect(unknown.image).toBe(FALLBACK_IMAGE);
    expect(unknown.approximate).toBe(true);
  });
});
