import { expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TIMEOUT_EXEC = resolve(import.meta.dir, "../shell/timeout_exec.ts");
const PYTHON_TIMEOUT_EXEC = resolve(import.meta.dir, "../shell/timeout_exec.py");

function findPython(): string {
  const python = Bun.which("python3");
  if (python === null) {
    throw new Error("python3 is required for transitional differential tests");
  }
  return python;
}

const PYTHON = findPython();

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

async function runPythonTimeoutCli(...args: string[]): Promise<CliResult> {
  return runCli([PYTHON, PYTHON_TIMEOUT_EXEC, ...args]);
}

test("[CHAR] missing arguments preserve Python usage response", async () => {
  // Characterization: preserve Python's observed exit code and stderr.
  const result = await runTimeoutCli();

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "usage: timeout_exec.py <seconds> <cmd> [args...]\n",
  );
});

test("[CHAR] non-numeric timeout preserves Python response", async () => {
  // Characterization: preserve Python's observed exit code and stderr.
  const result = await runTimeoutCli("not-a-number", "true");

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("invalid timeout: not-a-number\n");
});

test("[CHAR] child exit code passes through", async () => {
  // Characterization: the literal child exit code is the independent oracle.
  const result = await runTimeoutCli(
    "2",
    process.execPath,
    "-e",
    "process.exit(7)",
  );

  expect(result.exitCode).toBe(7);
});

test("[CHAR] child stdout and stderr pass through", async () => {
  // Characterization: literal child output is the independent oracle.
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

test("[CHAR] timeout returns 124 and preserves Python diagnostic", async () => {
  // Characterization: preserve Python's observed timeout exit and stderr.
  const result = await runTimeoutCli(
    "0.05",
    process.execPath,
    "-e",
    "await Bun.sleep(30_000)",
  );

  expect(result.exitCode).toBe(124);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "timeout_exec.py: command exceeded 0.05s; " +
      "terminating process group\n",
  );
}, 5_000);

const DIFFERENTIAL_CASES: ReadonlyArray<{
  name: string;
  args: string[];
}> = [
  { name: "missing arguments", args: [] },
  { name: "non-numeric timeout", args: ["not-a-number", "true"] },
  {
    name: "child exit code",
    args: ["2", process.execPath, "-e", "process.exit(7)"],
  },
  {
    name: "child stdout and stderr",
    args: [
      "2",
      process.execPath,
      "-e",
      'console.log("child-out"); console.error("child-err");',
    ],
  },
  {
    name: "timeout response",
    args: ["0.05", process.execPath, "-e", "await Bun.sleep(30_000)"],
  },
];

for (const { name, args } of DIFFERENTIAL_CASES) {
  test(`[DIFF] ${name} matches Python`, async () => {
    // Differential oracle: Python and TypeScript receive the same arguments
    // and child command, then must return the same observable CLI result.
    const [pythonResult, typeScriptResult] = await Promise.all([
      runPythonTimeoutCli(...args),
      runTimeoutCli(...args),
    ]);

    expect(typeScriptResult).toEqual(pythonResult);
  }, 5_000);
}

// DEFECT-001 remains executable as an expected failure in the Python suite.
// Its TypeScript disposition must be decided explicitly before final cutover.
test.todo("[SPEC DEFECT-001] timed-out descendants do not survive", () => {
  throw new Error("DEFECT-001 has not been resolved for TypeScript");
});
