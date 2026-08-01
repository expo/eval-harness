#!/usr/bin/env bun

import { constants } from "node:os";

const USAGE = "usage: timeout_exec.py <seconds> <cmd> [args...]";
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const PYTHON_GENERAL_PRECISION = 6;
const DIGIT_PART = String.raw`[0-9](?:_?[0-9])*`;
const FINITE_FLOAT_PATTERN = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGIT_PART}(?:\.(?:${DIGIT_PART})?)?)|(?:\.${DIGIT_PART}))(?:[eE][+-]?${DIGIT_PART})?$`,
);
const NON_FINITE_FLOAT_PATTERN = /^[+-]?(?:inf(?:inity)?|nan)$/i;

type ExitOrTimeout =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" };

function parsePythonFloat(text: string): number | undefined {
  const stripped = text.trim();
  if (stripped === "") {
    return undefined;
  }

  if (NON_FINITE_FLOAT_PATTERN.test(stripped)) {
    const unsigned = stripped.replace(/^[+-]/, "").toLowerCase();
    if (unsigned === "nan") {
      return Number.NaN;
    }
    return stripped.startsWith("-")
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }

  if (!FINITE_FLOAT_PATTERN.test(stripped)) {
    return undefined;
  }
  return Number(stripped.replaceAll("_", ""));
}

function trimFractionZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function formatPythonGeneral(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-inf";
  }

  const negative = value < 0 || Object.is(value, -0);
  const absolute = Math.abs(value);
  if (absolute === 0) {
    return negative ? "-0" : "0";
  }

  const exponential = absolute.toExponential(PYTHON_GENERAL_PRECISION - 1);
  const [mantissa = "", exponentText = "0"] = exponential.split("e");
  const exponent = Number(exponentText);
  const sign = negative ? "-" : "";

  if (exponent < -4 || exponent >= PYTHON_GENERAL_PRECISION) {
    const exponentSign = exponent < 0 ? "-" : "+";
    const exponentDigits = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${trimFractionZeros(mantissa)}e${exponentSign}${exponentDigits}`;
  }

  const fractionDigits = Math.max(
    PYTHON_GENERAL_PRECISION - exponent - 1,
    0,
  );
  return `${sign}${trimFractionZeros(absolute.toFixed(fractionDigits))}`;
}

async function waitForExitOrTimeout(
  exited: Promise<number>,
  timeoutMilliseconds: number,
): Promise<ExitOrTimeout> {
  if (Number.isNaN(timeoutMilliseconds) || timeoutMilliseconds === Infinity) {
    return { kind: "exit", exitCode: await exited };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const timeout = new Promise<ExitOrTimeout>((resolve) => {
    const schedule = (remainingMilliseconds: number): void => {
      if (cancelled) {
        return;
      }

      if (remainingMilliseconds <= 0) {
        timeoutId = setTimeout(() => resolve({ kind: "timeout" }), 0);
        return;
      }

      const delay = Math.min(
        remainingMilliseconds,
        MAX_TIMER_MILLISECONDS,
      );
      timeoutId = setTimeout(() => {
        if (remainingMilliseconds <= MAX_TIMER_MILLISECONDS) {
          resolve({ kind: "timeout" });
        } else {
          schedule(remainingMilliseconds - MAX_TIMER_MILLISECONDS);
        }
      }, delay);
    };

    schedule(timeoutMilliseconds);
  });

  const outcome = await Promise.race([
    exited.then((exitCode) => ({ kind: "exit", exitCode }) as const),
    timeout,
  ]);

  cancelled = true;
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

  const seconds = parsePythonFloat(timeoutText);
  if (seconds === undefined) {
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
    if (child.signalCode !== null) {
      return -constants.signals[child.signalCode];
    }
    return outcome.exitCode;
  }

  console.error(
    `timeout_exec.py: command exceeded ${formatPythonGeneral(seconds)}s; terminating process group`,
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
