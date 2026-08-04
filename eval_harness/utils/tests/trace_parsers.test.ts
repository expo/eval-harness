import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  parseTranscript,
  reconstructClaudeTranscripts,
} from "../telemetry/tracing/cc_transcript.ts";
import {
  parseRollout,
  reconstructCodexRollouts,
} from "../telemetry/tracing/codex_rollout.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CC_SCRIPT = resolve(import.meta.dir, "../telemetry/tracing/cc_transcript.ts");
const CODEX_SCRIPT = resolve(import.meta.dir, "../telemetry/tracing/codex_rollout.ts");

type JsonRecord = Record<string, unknown>;
type CliResult = { exitCode: number; stdout: string; stderr: string };

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "trace-parsers-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeJsonl(path: string, records: Array<JsonRecord | string>): Promise<void> {
  const lines = records.map((record) =>
    typeof record === "string" ? record : JSON.stringify(record),
  );
  await writeFile(path, `${lines.join("\n")}\n`);
}

function claudePrompt(text: string, uuid = "user-1"): JsonRecord {
  return {
    type: "user",
    sessionId: "session-1",
    cwd: "/workspace/app",
    version: "1.2.3",
    gitBranch: "main",
    uuid,
    message: { role: "user", content: text },
  };
}

function codexTaskStarted(turnId = "turn-1"): JsonRecord {
  return { type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

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

test("[CHAR] Claude transcript normalizes turns, tools, usage, and metadata", async () => {
  await withTempDir(async (directory) => {
    const transcript = join(directory, "session.jsonl");
    await writeJsonl(transcript, [
      claudePrompt("Build the app"),
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "Plan first." },
            { type: "text", text: "I will inspect files." },
            { type: "tool_use", id: "call-a", name: "Read", input: { path: "a.txt" } },
            { type: "tool_use", id: "call-b", name: "Read", input: { path: "b.txt" } },
          ],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-b", content: { value: 2 } },
            { type: "tool_result", tool_use_id: "call-a", content: "failed", is_error: true },
            { type: "tool_result", tool_use_id: "unknown", content: "ignored" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-test",
          content: [{ type: "text", text: "Finished." }],
          usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 5 },
        },
      },
    ]);

    const [turns, metadata] = await parseTranscript(transcript);
    expect(metadata).toEqual({
      id: "session-1",
      cwd: "/workspace/app",
      cli_version: "1.2.3",
      git_branch: "main",
    });
    expect(turns).toEqual([
      {
        turn_id: "user-1",
        turn_index: 1,
        user_input: "Build the app",
        steps: [
          {
            text: "I will inspect files.",
            reasoning: "Plan first.",
            tool_calls: [
              { call_id: "call-a", name: "Read", args: { path: "a.txt" }, output: "failed", error: "failed" },
              { call_id: "call-b", name: "Read", args: { path: "b.txt" }, output: '{"value": 2}' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, tokens: 14, cache_read_input_tokens: 2 },
          },
          {
            text: "Finished.",
            reasoning: "",
            tool_calls: [],
            usage: { prompt_tokens: 3, completion_tokens: 1, tokens: 4, cache_creation_input_tokens: 5 },
          },
        ],
        model: "claude-test",
        total_usage: {
          prompt_tokens: 13,
          completion_tokens: 5,
          tokens: 18,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 5,
        },
        final_output: "Finished.",
      },
    ]);
  });
});

test("[CHAR] Claude parser skips malformed lines and opens assistant-first turns", async () => {
  await withTempDir(async (directory) => {
    const transcript = join(directory, "session.jsonl");
    await writeJsonl(transcript, [
      "",
      "not-json",
      {
        type: "assistant",
        sessionId: "session-a",
        uuid: "assistant-a",
        message: { model: "claude-test", content: "hello" },
      },
    ]);

    const [turns, metadata] = await parseTranscript(transcript);
    expect(metadata).toEqual({ id: "session-a", cwd: null, cli_version: null, git_branch: null });
    expect(turns[0]).toMatchObject({
      turn_id: "assistant-a",
      turn_index: 1,
      user_input: null,
      final_output: "hello",
    });
  });
});

const jsonPrimitive = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.string({ maxLength: 24 }),
);
const structuredJson = fc.oneof(
  fc.array(jsonPrimitive, { maxLength: 4 }),
  fc.dictionary(fc.string({ maxLength: 12 }), jsonPrimitive, { maxKeys: 4 }),
);
const toolContent = fc.oneof(fc.string({ maxLength: 24 }), structuredJson);
const callRow = fc.record({
  callId: fc.stringMatching(/^[a-z0-9]{1,6}$/).map((suffix) => `call-${suffix}`),
  includeResult: fc.boolean(),
  content: toolContent,
  isError: fc.boolean(),
  order: fc.integer(),
});

test("[SPEC TRACE-001] Claude tool results attach only to matching calls", async () => {
  // Property: a Claude tool result affects only its matching call ID.
  // Oracle: a dictionary built directly from generated results, keyed by ID;
  // structured outputs are parsed back to semantic JSON before comparison.
  // Catches: positional association, unknown-result leakage, dropped matches,
  // and attaching an error to the wrong tool call.
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(callRow, { minLength: 1, maxLength: 6, selector: (row) => row.callId }),
      fc.array(fc.record({ content: toolContent, isError: fc.boolean(), order: fc.integer() }), {
        maxLength: 3,
      }),
      async (callRows, unknownRows) => {
        const expected = new Map(
          callRows
            .filter((row) => row.includeResult)
            .map((row) => [row.callId, { content: row.content, isError: row.isError }]),
        );
        const results = [
          ...callRows
            .filter((row) => row.includeResult)
            .map((row) => ({
              type: "tool_result",
              tool_use_id: row.callId,
              content: row.content,
              is_error: row.isError,
              order: row.order,
            })),
          ...unknownRows.map((row, index) => ({
            type: "tool_result",
            tool_use_id: `unknown-${index}`,
            content: row.content,
            is_error: row.isError,
            order: row.order,
          })),
        ]
          .sort((left, right) => left.order - right.order)
          .map(({ order: _order, ...result }) => result);

        await withTempDir(async (directory) => {
          const transcript = join(directory, "session.jsonl");
          await writeJsonl(transcript, [
            claudePrompt("Run tools"),
            {
              type: "assistant",
              message: {
                content: callRows.map((row) => ({
                  type: "tool_use",
                  id: row.callId,
                  name: "Generated",
                  input: {},
                })),
              },
            },
            { type: "user", message: { content: results } },
          ]);

          const [turns] = await parseTranscript(transcript);
          const actualCalls = turns[0]?.steps[0]?.tool_calls;
          expect(actualCalls?.map((call) => call.call_id)).toEqual(callRows.map((row) => row.callId));
          for (const call of actualCalls ?? []) {
            const expectedResult = expected.get(String(call.call_id));
            if (expectedResult === undefined) {
              expect(call).not.toHaveProperty("output");
              expect(call).not.toHaveProperty("error");
              continue;
            }

            if (typeof expectedResult.content === "string") {
              expect(call.output).toBe(expectedResult.content);
            } else {
              expect(JSON.parse(String(call.output))).toEqual(expectedResult.content);
            }
            if (expectedResult.isError) {
              expect(call.error).toBe(call.output);
            } else {
              expect(call).not.toHaveProperty("error");
            }
          }
        });
      },
    ),
    {
      examples: [
        [
          [
            { callId: "call-a", includeResult: true, content: "failed", isError: true, order: 2 },
            { callId: "call-b", includeResult: true, content: { value: 2 }, isError: false, order: 1 },
          ],
          [{ content: "ignored", isError: true, order: 0 }],
        ],
      ],
    },
  );
});

test("[CHAR] Claude reconstruction filters mtimes and writes its envelope", async () => {
  await withTempDir(async (directory) => {
    const projects = join(directory, "projects");
    await mkdir(projects);
    const old = join(projects, "old.jsonl");
    const selected = join(projects, "selected.jsonl");
    const upper = join(projects, "upper.jsonl");
    const empty = join(projects, "empty.jsonl");
    await writeJsonl(old, [claudePrompt("old")]);
    await writeJsonl(selected, [claudePrompt("selected")]);
    await writeJsonl(upper, [claudePrompt("upper")]);
    await writeFile(empty, "");
    await utimes(old, 10, 10);
    await utimes(selected, 20, 20);
    await utimes(empty, 25, 25);
    await utimes(upper, 30, 30);
    const out = join(directory, "out", "trace.json");

    const payload = await reconstructClaudeTranscripts({
      projectsDir: projects,
      outPath: out,
      sinceMtime: 20,
      beforeMtime: 30,
      runId: "run-1",
      source: "claude-code-authoring",
      sessionName: "Authoring",
    });

    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(payload);
    expect(payload).toMatchObject({
      agent: "claude-code",
      run_id: "run-1",
      source: "claude-code-authoring",
      session_name: "Authoring",
      n_sessions: 1,
    });
    expect(basename(String(payload.sessions[0]?.transcript))).toBe("selected.jsonl");
  });
});

test("[CHAR] Codex rollout preserves its state-machine output", async () => {
  await withTempDir(async (directory) => {
    const rollout = join(directory, "rollout-test.jsonl");
    await writeJsonl(rollout, [
      { type: "session_meta", payload: { id: "codex-session", cli_version: "1.0" } },
      codexTaskStarted(),
      { type: "turn_context", payload: { model: "gpt-test", effort: "high" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: "<environment_context>ignored</environment_context>" },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "fallback prompt" }] },
      },
      { type: "event_msg", payload: { type: "user_message", message: "explicit prompt" } },
      {
        type: "event_msg",
        payload: { type: "exec_command_end", call_id: "call-b", status: "failed", aggregated_output: "boom", exit_code: 7 },
      },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "call-a", name: "read_file", arguments: '{"path":"a.txt"}' },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "call-b", name: "shell", input: "raw command" },
      },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call-a", output: { value: 1 } } },
      {
        type: "response_item",
        payload: { type: "web_search_call", id: "web-1", action: { query: "Expo", queries: ["Expo", "Bun"] } },
      },
      { type: "response_item", payload: { type: "reasoning", content: "Think." } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 2 },
            last_token_usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "model final" } },
      { type: "event_msg", payload: { type: "agent_message", message: "event final" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    const [turns, metadata] = await parseRollout(rollout);
    expect(metadata).toEqual({ id: "codex-session", cli_version: "1.0" });
    expect(turns).toEqual([
      {
        turn_id: "turn-1",
        turn_index: 1,
        steps: [
          {
            text: "",
            reasoning: "Think.",
            tool_calls: [
              { call_id: "call-a", name: "read_file", args: { path: "a.txt" }, output: { value: 1 } },
              { call_id: "call-b", name: "shell", args: "raw command", error: "boom", output: "boom" },
              {
                call_id: "web-1",
                name: "web_search",
                args: { query: "Expo", queries: ["Expo", "Bun"], action: { query: "Expo", queries: ["Expo", "Bun"] } },
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, tokens: 6 },
          },
          { text: "model final", reasoning: "", tool_calls: [] },
        ],
        model: "gpt-test",
        invocation_params: { model: "gpt-test", effort: "high" },
        final_output: "event final",
        completed: true,
        aborted: false,
        total_usage: { prompt_tokens: 10, completion_tokens: 5, tokens: 15, cache_read_input_tokens: 2 },
        user_input_fallback: "fallback prompt",
        user_input: "explicit prompt",
      },
    ]);
  });
});

test("[CHAR] Codex parser skips malformed lines and flushes an incomplete turn", async () => {
  await withTempDir(async (directory) => {
    const rollout = join(directory, "rollout-test.jsonl");
    await writeJsonl(rollout, [
      "not-json",
      codexTaskStarted("turn-open"),
      { type: "response_item", payload: { type: "message", role: "assistant", content: "unfinished" } },
    ]);

    const [turns, metadata] = await parseRollout(rollout);
    expect(metadata).toEqual({});
    expect(turns).toEqual([
      {
        turn_id: "turn-open",
        turn_index: 1,
        steps: [{ text: "unfinished", reasoning: "", tool_calls: [] }],
        completed: false,
        aborted: false,
        final_output: "unfinished",
        user_input: null,
      },
    ]);
  });
});

test("[CHAR] Codex reconstruction filters mtimes and writes its envelope", async () => {
  await withTempDir(async (directory) => {
    const sessions = join(directory, "sessions");
    await mkdir(sessions);
    const files = [
      ["rollout-old.jsonl", "old", 10],
      ["rollout-selected.jsonl", "selected", 20],
      ["rollout-upper.jsonl", "upper", 30],
    ] as const;
    for (const [name, turnId, mtime] of files) {
      const path = join(sessions, name);
      await writeJsonl(path, [codexTaskStarted(turnId)]);
      await utimes(path, mtime, mtime);
    }
    const empty = join(sessions, "rollout-empty.jsonl");
    await writeFile(empty, "");
    await utimes(empty, 25, 25);
    const out = join(directory, "out", "trace.json");

    const payload = await reconstructCodexRollouts({
      sessionsDir: sessions,
      outPath: out,
      sinceMtime: 20,
      beforeMtime: 30,
      runId: "run-2",
      source: "codex-authoring",
      sessionName: "Codex Authoring",
    });

    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(payload);
    expect(payload).toMatchObject({
      agent: "codex",
      run_id: "run-2",
      source: "codex-authoring",
      session_name: "Codex Authoring",
      n_sessions: 1,
    });
    expect(basename(String(payload.sessions[0]?.rollout))).toBe("rollout-selected.jsonl");
  });
});

test("[CHAR] both parse-only CLIs emit the stable session envelope", async () => {
  await withTempDir(async (directory) => {
    const cases = [
      { script: CC_SCRIPT, records: [claudePrompt("hello")], expectedId: "session-1" },
      {
        script: CODEX_SCRIPT,
        records: [{ type: "session_meta", payload: { id: "codex-1" } }, codexTaskStarted()],
        expectedId: "codex-1",
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const trace = join(directory, `trace-${index}.jsonl`);
      await writeJsonl(trace, fixture.records);
      const result = await runCli([process.execPath, fixture.script, "--parse-only", trace]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as JsonRecord;
      expect(Object.keys(payload).sort()).toEqual(["session_meta", "turns"]);
      expect((payload.session_meta as JsonRecord).id).toBe(fixture.expectedId);
      expect((payload.turns as unknown[]).length).toBe(1);
    }
  });
});
