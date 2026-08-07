import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { main } from "../shell/timeout_exec.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TIMEOUT_EXEC = resolve(import.meta.dir, "../shell/timeout_exec.ts");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCli(command: string[]): Promise<CliResult> {
  const child = Bun.spawn(command, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

async function runTimeoutCli(...args: string[]): Promise<CliResult> {
  return runCli([process.execPath, TIMEOUT_EXEC, ...args]);
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    throw error;
  }
}

test("[REGRESSION] missing arguments print stable usage response", async () => {
  // Regression oracle: accepted compatibility exit code and stderr.
  const result = await runTimeoutCli();

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "usage: timeout_exec.ts <seconds> <cmd> [args...]\n",
  );
});

test("[REGRESSION] non-numeric timeout returns stable response", async () => {
  // Regression oracle: accepted compatibility exit code and stderr.
  const result = await runTimeoutCli("not-a-number", "true");

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("invalid timeout: not-a-number\n");
});

test("[REGRESSION] child exit code passes through", async () => {
  // Regression oracle: the literal child exit code requested by the test.
  const result = await runTimeoutCli(
    "2",
    process.execPath,
    "-e",
    "process.exit(7)",
  );

  expect(result.exitCode).toBe(7);
});

test("[REGRESSION] child stdout and stderr pass through", async () => {
  // Regression oracle: literal child output written by the test command.
  const result = await runTimeoutCli(
    "2",
    process.execPath,
    "-e",
    'console.log("child-out"); console.error("child-err");',
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("child-out\n");
  expect(result.stderr).toBe("child-err\n");
});

test("[REGRESSION] timeout returns 124 and stable diagnostic", async () => {
  // Regression oracle: accepted compatibility timeout exit and diagnostic.
  const result = await runTimeoutCli(
    "0.05",
    process.execPath,
    "-e",
    "await Bun.sleep(30_000)",
  );

  expect(result.exitCode).toBe(124);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "timeout_exec.ts: command exceeded 0.05s; " +
      "terminating process group\n",
  );
}, 5_000);

test("[REGRESSION] signal-terminated child preserves Python status", async () => {
  // Regression oracle: Python returned -SIGTERM through SystemExit, which the
  // operating system exposed as status 241.
  const result = await runTimeoutCli(
    "2",
    "/bin/sh",
    "-c",
    "kill -TERM $$",
  );

  expect(result.exitCode).toBe(241);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

for (const timeoutText of ["-1", "nan", "inf", "1_0", "0x1", "1e20", "١٢"]) {
  test(`[SPEC] rejects unsupported timeout text ${timeoutText}`, async () => {
    // Contract oracle: callers supply finite, non-negative decimal seconds.
    const result = await runTimeoutCli(
      timeoutText,
      process.execPath,
      "-e",
      "process.exit(0)",
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`invalid timeout: ${timeoutText}\n`);
  });
}

test("[SPEC] accepts finite decimal scientific notation", async () => {
  const result = await runTimeoutCli(
    "2e0",
    process.execPath,
    "-e",
    "process.exit(0)",
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("[REGRESSION] forced cleanup errors do not escape", async () => {
  // Regression oracle: process-group cleanup is best-effort after a timeout;
  // an unsignalable or already-gone group must not replace exit code 124.
  const permissionError = Object.assign(new Error("not permitted"), {
    code: "EPERM",
  });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw permissionError;
  });
  const errorOutput = spyOn(console, "error").mockImplementation(() => {});
  try {
    const exitCode = await main([
      "0",
      process.execPath,
      "-e",
      "await Bun.sleep(25)",
    ]);
    expect(exitCode).toBe(124);
    await Bun.sleep(50);
  } finally {
    errorOutput.mockRestore();
    kill.mockRestore();
  }
});

test.failing("[SPEC DEFECT-001] timed-out descendants do not survive", async () => {
  // Property: a timed-out process group leaves no descendant running.
  // Oracle: the recorded descendant PID no longer exists after wrapper exit.
  // Catches: orphaned processes and incomplete process-group cleanup.
  const tempDir = await mkdtemp(join(tmpdir(), "timeout-exec-"));
  const pidPath = join(tempDir, "descendant.pid");
  const descendantCode = `
    process.on("SIGTERM", () => {});
    await Bun.sleep(30_000);
  `;
  const parentCode = `
    const descendant = Bun.spawn(
      [process.execPath, "-e", ${JSON.stringify(descendantCode)}],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    await Bun.write(${JSON.stringify(pidPath)}, String(descendant.pid));
    await Bun.sleep(30_000);
  `;

  let descendantPid: number | undefined;
  try {
    let result: CliResult;
    let pidText: string;
    try {
      result = await runTimeoutCli("1", process.execPath, "-e", parentCode);
      pidText = await readFile(pidPath, "utf8");
    } catch {
      // Returning from test.failing is an unexpected pass, so a broken test
      // setup fails the suite instead of masquerading as the known defect.
      return;
    }

    const parsedPid = Number(pidText);
    if (
      result.exitCode !== 124 ||
      !Number.isInteger(parsedPid) ||
      parsedPid <= 0
    ) {
      return;
    }
    descendantPid = parsedPid;

    const deadline = performance.now() + 500;
    while (pidExists(descendantPid) && performance.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(pidExists(descendantPid)).toBeFalse();
  } finally {
    if (descendantPid !== undefined && pidExists(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort cleanup must not become the expected test failure.
      }
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}, 15_000);
