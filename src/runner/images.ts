/**
 * Map a GitHub `runs-on` label to a local Docker image that approximates the
 * hosted runner. We default to the community `catthehacker` images that `act`
 * popularised, because they ship the toolchain most workflows assume.
 *
 * This is a best-effort approximation, not a byte-for-byte runner clone — which
 * we say plainly in the docs and in `doctor`.
 */

import { PitstopError } from "../errors.js";

const RUNNER_IMAGE_MAP: Record<string, string> = {
  "ubuntu-latest": "catthehacker/ubuntu:act-latest",
  "ubuntu-24.04": "catthehacker/ubuntu:act-24.04",
  "ubuntu-22.04": "catthehacker/ubuntu:act-22.04",
  "ubuntu-20.04": "catthehacker/ubuntu:act-20.04",
};

/** A small, dependency-light fallback for unknown Linux runners. */
export const FALLBACK_IMAGE = "ubuntu:22.04";

export interface ResolvedImage {
  image: string;
  /** Why this image was chosen — surfaced to the user for transparency. */
  reason: string;
  /** True when we could not closely match the requested runner. */
  approximate: boolean;
}

function firstLabel(runsOn: string | string[]): string {
  return Array.isArray(runsOn) ? (runsOn[0] ?? "") : runsOn;
}

/**
 * Reject image references that could be misread as docker flags when spliced
 * into a `docker run` argv (leading `-`) or that are plainly not image refs
 * (empty, embedded whitespace). Returns the value unchanged when it's safe.
 */
export function assertSafeImageRef(image: string, source: string): string {
  if (image.trim() === "" || image.startsWith("-") || /\s/.test(image)) {
    throw new PitstopError(`Invalid container image ${source}: "${image}".`, {
      hint: "An image reference can't be empty, start with '-', or contain whitespace — docker would read a value like that as a flag, not an image.",
    });
  }
  return image;
}

/**
 * Resolve the image to use for a job. Precedence:
 *   1. an explicit `--image` override
 *   2. the job's `container:` image
 *   3. a mapped image for the `runs-on` label
 *   4. a Linux fallback (with a warning)
 */
export function resolveImage(opts: {
  override?: string;
  jobContainer?: string;
  runsOn: string | string[];
}): ResolvedImage {
  if (opts.override) {
    return {
      image: assertSafeImageRef(opts.override, "from --image"),
      reason: "from --image",
      approximate: false,
    };
  }
  if (opts.jobContainer) {
    return {
      image: assertSafeImageRef(opts.jobContainer, "from the job's `container:`"),
      reason: "from the job's container: image",
      approximate: false,
    };
  }

  const label = firstLabel(opts.runsOn).toLowerCase();
  const mapped = RUNNER_IMAGE_MAP[label];
  if (mapped) {
    return { image: mapped, reason: `mapped from runs-on: ${label}`, approximate: false };
  }

  if (label.startsWith("windows") || label.startsWith("macos")) {
    return {
      image: FALLBACK_IMAGE,
      reason: `runs-on: ${label} can't run in a Linux container`,
      approximate: true,
    };
  }

  return {
    image: FALLBACK_IMAGE,
    reason: `no image mapping for runs-on: ${label || "(empty)"}`,
    approximate: true,
  };
}
