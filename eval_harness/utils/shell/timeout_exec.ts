#!/usr/bin/env bun

const USAGE = "usage: timeout_exec.py <seconds> <cmd> [args...]";

type ExitOrTimeout =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" };

async function waitForExitOrTimeout(
  exited: Promise<number>,
  timeoutMilliseconds: number,
): Promise<ExitOrTimeout> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExitOrTimeout>((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ kind: "timeout" }),
      timeoutMilliseconds,
    );
  });

  const outcome = await Promise.race([
    exited.then((exitCode) => ({ kind: "exit", exitCode }) as const),
    timeout,
  ]);

  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return outcome;
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ESRCH"
  );
}

function forceKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw error;
    }
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.length < 2) {
    console.error(USAGE);
    return 2;
  }

  const timeoutText = args[0];
  if (timeoutText === undefined) {
    console.error(USAGE);
    return 2;
  }

  const seconds = Number(timeoutText);
  if (timeoutText.trim() === "" || Number.isNaN(seconds)) {
    console.error(`invalid timeout: ${timeoutText}`);
    return 2;
  }

  const command = args.slice(1);
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });

  const outcome = await waitForExitOrTimeout(child.exited, seconds * 1_000);
  if (outcome.kind === "exit") {
    return outcome.exitCode;
  }

  console.error(
    `timeout_exec.py: command exceeded ${seconds}s; terminating process group`,
  );

  let forceKill = false;
  try {
    process.kill(-child.pid, "SIGTERM");
    const termination = await waitForExitOrTimeout(child.exited, 10_000);
    forceKill = termination.kind === "timeout";
  } catch {
    forceKill = true;
  }

  if (forceKill) {
    forceKillProcessGroup(child.pid);
  }
  return 124;
}

if (import.meta.main) {
  process.exit(await main());
}
