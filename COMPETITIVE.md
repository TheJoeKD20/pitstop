# Competitive landscape — where Pitstop's wedge is

**One-line thesis:** every tool below can *run* CI locally. **None of them can
pause before a step and drop you into an interactive shell at that state.**
That step-level breakpoint is Pitstop's headline feature and the whole reason to
build it. (v0.1 approximates the runner's state — see the README's
supported-features table for what's faithfully reproduced and what isn't yet,
e.g. `GITHUB_ENV` file commands and GitHub's fail-fast shell flags.)

---

## The validated demand

The pain is named and someone said they'd pay for it — an Ask HN
"What developer tool do you wish existed?" thread surfaced exactly this:
inspect and fix CI scripts locally without the commit → push → wait → read-logs
loop. <https://news.ycombinator.com/item?id=46345827>

The meta-ask in the same conversation: **good defaults and plain-language
output**, not another tool with cryptic errors. Pitstop treats that as a feature
(`pitstop doctor`, `--dry-run`, and a `PitstopError` type whose whole job is to
print a message *and a next step*).

---

## The field

| Tool | What it does | Pause mid-run? | Shell at a step's exact state? | Reuses your YAML? |
| --- | --- | :---: | :---: | :---: |
| **Pitstop** | Run a job locally **and breakpoint any step** | ✅ | ✅ | ✅ (v0.1 subset — see the README's supported-features table; reusable-workflow jobs are skipped with a notice) |
| [`act`](https://github.com/nektos/act) | Runs GitHub Actions locally | ❌ | ❌ | ✅ |
| [Dagger](https://dagger.io) | Programmable CI engine / SDK | ❌ | ⚠️ (terminal in a Dagger pipeline, not your YAML) | ❌ (rewrite required) |
| [`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local) | Runs GitLab pipelines locally | ❌ | ❌ | ✅ (GitLab) |
| Re-run on CI with SSH (e.g. tmate) | SSH into a *hosted* runner mid-job | ⚠️ (needs a pushed run) | ✅ | ✅ | 
| `docker run` by hand | Manual container, copy commands across | ⚠️ (manual) | ✅ (you rebuild the state yourself) | ❌ |

---

## Tool-by-tool

### `act` (nektos/act) — the closest neighbour
The category leader for running GitHub Actions locally, and the project Pitstop
most obviously sits next to. It executes a workflow top to bottom in a
runner-like container. What it **cannot** do is stop before a step and hand you a
shell — when a step fails you're back to adding `echo`/`set -x`, re-running the
whole job, and reading logs. **That gap is the wedge.** Pitstop deliberately
reuses the same community runner images `act` popularised, so it feels familiar.

### Dagger — powerful, different mental model
Dagger is a programmable CI engine: you express your pipeline in its SDK and it
runs anywhere. It's genuinely strong and even exposes an interactive terminal —
but only inside a *Dagger* pipeline you've rewritten. Pitstop's bet is the
opposite: **meet people at the YAML they already have**, with zero migration.

### `gitlab-ci-local` — the GitLab analogue
Excellent for running `.gitlab-ci.yml` locally, and proof the "run my real CI
locally" demand exists across providers. Same structural limitation: it runs
jobs, it doesn't breakpoint steps. (GitLab support is on Pitstop's roadmap,
behind the same container-engine interface.)

### SSH-into-the-runner (tmate & friends)
Gives you a real shell at the real state — but on a **hosted** runner, which
means you've already paid the push → queue → wait cost to get there. Pitstop
gives you the same shell *locally*, before you commit anything.

### Plain `docker run`
The honest baseline: spin up a container and paste your commands in. It works,
but you rebuild the env, secrets and working directory by hand every time and
keep them in sync with your YAML yourself. Pitstop is that workflow, automated
and tied to your actual pipeline.

---

## Why the wedge holds

1. **It's a named, unmet need**, not a guess — the gap is specifically in `act`,
   the most popular tool in the space.
2. **It demos in 30 seconds** — breakpoint → shell → resume is a single GIF, the
   kind of artefact that reaches a front page and earns organic stars.
3. **It's honestly scoped** — v0.1 ships one job, `run` steps, real secrets, and
   the breakpoint. Matrix builds, the expression engine and other providers are
   on the roadmap, not pretended-at.

**Conclusion:** as of writing, no widely-used local-CI tool ships a step-level
interactive breakpoint with a shell at the exact runner state. That is the one
thing Pitstop leads with.
