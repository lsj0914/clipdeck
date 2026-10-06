import { spawn } from "node:child_process";
export interface ProcessOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string;
  onStdout?: (chunk: string) => void;
  /** Raw binary transport. Callbacks are synchronous so callers can enforce a
   * byte ceiling before each write without buffering the entire native output. */
  onStdoutBytes?: (chunk: Buffer) => void;
  maxBytes?: number;
}
/** No shell; cancellation waits for process exit and force-kills after a short grace. */
export function runProcess(
  executable: string,
  argv: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    if (options.onStdout && options.onStdoutBytes)
      throw new Error("Choose one native output transport");
    const child = spawn(executable, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      timer.unref();
    };
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      failure = error;
    });
    if (!options.onStdoutBytes) child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string | Buffer) => {
      if (failure) return;
      try {
        if (options.onStdoutBytes) {
          options.onStdoutBytes(data as Buffer);
          return;
        }
        const chunk = data as string;
        if (options.onStdout) options.onStdout(chunk);
        else {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > (options.maxBytes ?? 4 * 1024 * 1024))
            throw new Error("Native output limit exceeded");
        }
      } catch (error) {
        failure =
          error instanceof Error ? error : new Error("Invalid worker output");
        stop();
      }
    });
    child.stderr.on("data", (data: string) => {
      stderr = (stderr + data).slice(-65536);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(new Error("Job cancelled"));
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            "Native process failed; source or local runtime is invalid",
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
export function offlineWorkerCommand(
  python: string,
  worker: string,
): { executable: string; argv: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform !== "darwin")
    throw new Error("Offline worker network denial is verified only on macOS");
  return {
    executable: "/usr/bin/sandbox-exec",
    argv: [
      "-p",
      "(version 1)(allow default)(deny network-outbound)",
      python,
      worker,
    ],
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      ORT_DISABLE_TELEMETRY: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  };
}
