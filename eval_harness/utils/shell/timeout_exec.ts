#!/usr/bin/env bun

import { constants } from "node:os";

const USAGE = "usage: timeout_exec.ts <seconds> <cmd> [args...]";
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const TIMEOUT_PATTERN = /^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

type ExitOrTimeout =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" };

function parseTimeout(text: string): { seconds: number; milliseconds: number } | undefined {
  const stripped = text.trim();
  if (!TIMEOUT_PATTERN.test(stripped)) return undefined;
  const seconds = Number(stripped);
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds > MAX_TIMER_MILLISECONDS) {
    return undefined;
  }
  return { seconds, milliseconds };
}

async function waitForExitOrTimeout(
  exited: Promise<number>,
  timeoutMilliseconds: number,
): Promise<ExitOrTimeout> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExitOrTimeout>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeoutMilliseconds);
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

function forceKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Best-effort: Bun may already have reaped the group, and macOS can report
    // either ESRCH or EPERM for this race. Cleanup must not replace exit 124.
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

  const timeout = parseTimeout(timeoutText);
  if (timeout === undefined) {
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

  const outcome = await waitForExitOrTimeout(child.exited, timeout.milliseconds);
  if (outcome.kind === "exit") {
    if (child.signalCode !== null) {
      return -constants.signals[child.signalCode];
    }
    return outcome.exitCode;
  }

  console.error(
    `timeout_exec.ts: command exceeded ${timeout.seconds}s; terminating process group`,
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
