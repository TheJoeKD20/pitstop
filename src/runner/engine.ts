/** Abstraction over a container runtime so the executor is testable without Docker. */

export interface ContainerStartOptions {
  image: string;
  /** Container name (for friendly `docker exec`/cleanup). */
  name: string;
  /** Host directory to mount as the workspace. */
  workspaceHost: string;
  /** Mount point inside the container. */
  workspaceContainer: string;
  /** Environment variables available to every command in the container. */
  env: Record<string, string>;
}

export interface ExecOptions {
  /** Working directory inside the container. */
  cwd: string;
  /** Per-command environment (layered on top of the container env). */
  env?: Record<string, string>;
  /** Shell to run the command with (default `bash`). */
  shell?: string;
}

export interface EngineStatus {
  /** The runtime binary is installed and on PATH. */
  installed: boolean;
  /** The daemon is reachable (a container can actually be started). */
  daemonReachable: boolean;
  /** Version string, if obtainable. */
  version?: string;
  /** Human-readable detail when something is wrong. */
  detail?: string;
}

/**
 * Minimal container lifecycle the executor depends on. A real implementation
 * shells out to Docker; tests provide a fake.
 */
export interface ContainerEngine {
  /** Check whether the runtime is usable. Never throws. */
  status(): Promise<EngineStatus>;
  /** Start a detached container and return its id/handle. */
  start(opts: ContainerStartOptions): Promise<string>;
  /** Run a command, streaming its output. Resolves with the exit code. */
  exec(handle: string, command: string, opts: ExecOptions): Promise<number>;
  /** Open an interactive shell attached to the terminal. Resolves when it exits. */
  shell(handle: string, opts: ExecOptions): Promise<void>;
  /** Stop and remove the container. Never throws. */
  remove(handle: string): Promise<void>;
}
