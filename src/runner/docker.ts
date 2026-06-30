import { spawn } from "node:child_process";
import { PitstopError } from "../errors.js";
import type {
  ContainerEngine,
  ContainerStartOptions,
  EngineStatus,
  ExecOptions,
} from "./engine.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a docker command, capturing output. Used for control-plane calls. */
function dockerCapture(args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolvePromise({ code: 127, stdout, stderr: "spawn-error" }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run a docker command with the user's terminal attached (streaming/interactive). */
function dockerInherit(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

/** A {@link ContainerEngine} backed by the local Docker CLI. */
export class DockerEngine implements ContainerEngine {
  async status(): Promise<EngineStatus> {
    const version = await dockerCapture(["version", "--format", "{{.Server.Version}}"]);
    if (version.stderr === "spawn-error" || version.code === 127) {
      return {
        installed: false,
        daemonReachable: false,
        detail: "The `docker` command was not found on your PATH.",
      };
    }
    if (version.code !== 0) {
      const firstLine = version.stderr.split("\n").find((l) => l.trim() !== "");
      return {
        installed: true,
        daemonReachable: false,
        detail: firstLine?.trim() ?? "The Docker daemon is not reachable.",
      };
    }
    return {
      installed: true,
      daemonReachable: true,
      version: version.stdout.trim(),
    };
  }

  async start(opts: ContainerStartOptions): Promise<string> {
    const args = [
      "run",
      "--detach",
      "--name",
      opts.name,
      "--workdir",
      opts.workspaceContainer,
      "--volume",
      `${opts.workspaceHost}:${opts.workspaceContainer}`,
      ...envFlags(opts.env),
      opts.image,
      // Keep the container alive so we can exec steps and open shells into it.
      "sleep",
      "infinity",
    ];
    const result = await dockerCapture(args);
    if (result.code !== 0) {
      const detail = result.stderr.split("\n").find((l) => l.trim() !== "")?.trim();
      throw new PitstopError(`Could not start a container from image "${opts.image}".`, {
        hint: detail ?? "Run `pitstop doctor` to check your Docker setup.",
      });
    }
    return result.stdout.trim();
  }

  exec(handle: string, command: string, opts: ExecOptions): Promise<number> {
    const shell = opts.shell ?? "bash";
    const args = [
      "exec",
      "--workdir",
      opts.cwd,
      ...envFlags(opts.env ?? {}),
      handle,
      shell,
      "-lc",
      command,
    ];
    return dockerInherit(args);
  }

  shell(handle: string, opts: ExecOptions): Promise<void> {
    const shell = opts.shell ?? "bash";
    const args = [
      "exec",
      "--interactive",
      "--tty",
      "--workdir",
      opts.cwd,
      ...envFlags(opts.env ?? {}),
      handle,
      shell,
      "-l",
    ];
    return dockerInherit(args).then(() => undefined);
  }

  async remove(handle: string): Promise<void> {
    await dockerCapture(["rm", "--force", handle]);
  }
}
