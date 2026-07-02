/**
 * Map a GitHub `runs-on` label to a local Docker image that approximates the
 * hosted runner. We default to the community `catthehacker` images that `act`
 * popularised, because they ship the toolchain most workflows assume.
 *
 * This is a best-effort approximation, not a byte-for-byte runner clone — which
 * we say plainly in the docs and in `doctor`.
 */

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
    return { image: opts.override, reason: "from --image", approximate: false };
  }
  if (opts.jobContainer) {
    return {
      image: opts.jobContainer,
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
