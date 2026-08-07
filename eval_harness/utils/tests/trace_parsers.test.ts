import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  emitBraintrustSession,
  findTranscripts,
  parseTranscript,
  reconstructClaudeTranscripts,
  stringifyPythonJson,
} from "../telemetry/tracing/cc_transcript.ts";
import {
  findRollouts,
  parseRollout,
  reconstructCodexRollouts,
} from "../telemetry/tracing/codex_rollout.ts";
import {
  findMuseSessions,
  parseMuseSession,
  reconstructMuseSessions,
} from "../telemetry/tracing/muse_session.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CC_SCRIPT = resolve(import.meta.dir, "../telemetry/tracing/cc_transcript.ts");
const CODEX_SCRIPT = resolve(import.meta.dir, "../telemetry/tracing/codex_rollout.ts");
const MUSE_SCRIPT = resolve(import.meta.dir, "../telemetry/tracing/muse_session.ts");

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

function museEvent(
  sequence: number,
  kind: string,
  event: JsonRecord,
  runId = "muse-run-1",
): JsonRecord {
  return {
    sequence,
    payload_type: "runtime.session",
    payload: { kind: "run", run_id: runId, event: { kind, ...event } },
  };
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

test("[CHAR] parsed trace fields preserve number spelling and large integers", async () => {
  // Scope: values that pass through their parsed JSON holder. Newly derived
  // numeric values preserve meaning but can use JavaScript's number spelling.
  await withTempDir(async (directory) => {
    const transcript = join(directory, "session.jsonl");
    const numbers =
      '{"whole":1.0,"negative":-0.0,"small":1e-7,"huge":1208925819614629174706176}';
    await writeFile(
      transcript,
      [
        JSON.stringify(claudePrompt("Keep numeric spellings")),
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"numbers","name":"Numbers","input":${numbers}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"numbers","content":${numbers}}]}}`,
      ].join("\n") + "\n",
    );

    const [turns] = await parseTranscript(transcript);
    const call = turns[0]?.steps[0]?.tool_calls[0];
    const expected =
      '{"whole": 1.0, "negative": -0.0, "small": 1e-07, "huge": 1208925819614629174706176}';
    expect(stringifyPythonJson(call?.args)).toBe(expected);
    expect(call?.output).toBe(expected);
  });
});

test("[CHAR] truthy malformed message and payload records reject their session", async () => {
  await withTempDir(async (directory) => {
    const claude = join(directory, "claude.jsonl");
    const codex = join(directory, "rollout-malformed.jsonl");
    await writeJsonl(claude, [{ type: "assistant", message: "not-an-object" }]);
    await writeJsonl(codex, [{ type: "event_msg", payload: "not-an-object" }]);

    await expect(parseTranscript(claude)).rejects.toThrow();
    await expect(parseRollout(codex)).rejects.toThrow();
  });
});

test("[REGRESSION] Claude ignores unknown record types before validating message", async () => {
  await withTempDir(async (directory) => {
    const transcript = join(directory, "session.jsonl");
    await writeJsonl(transcript, [
      claudePrompt("Keep this turn"),
      { type: "future-record", message: "externally-owned payload" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Still parsed." }] },
      },
    ]);

    const [turns] = await parseTranscript(transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      user_input: "Keep this turn",
      final_output: "Still parsed.",
    });
  });
});

test("[REGRESSION] Codex ignores unknown record types before validating payload", async () => {
  await withTempDir(async (directory) => {
    const rollout = join(directory, "rollout-test.jsonl");
    await writeJsonl(rollout, [
      codexTaskStarted("turn-kept"),
      { type: "future-record", payload: "externally-owned payload" },
      { type: "event_msg", payload: { type: "agent_message", message: "Still parsed." } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);

    const [turns] = await parseRollout(rollout);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turn_id: "turn-kept",
      final_output: "Still parsed.",
      completed: true,
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

test("[CHAR] Muse session normalizes durable turns, tools, usage, and skill reads", async () => {
  await withTempDir(async (directory) => {
    const session = join(directory, "session.jsonl");
    await writeJsonl(session, [
      {
        sequence: 1,
        payload_type: "runtime.session.metadata",
        payload: {
          record: {
            workspace_root: "/workspace/muse-app",
            provider_id: "meta",
            model_id: "muse-spark-1.2",
            build: { semver: "0.1.0" },
          },
        },
      },
      {
        sequence: 2,
        payload_type: "session.opened.observed",
        payload: { record: { session_id: "muse-session-1" } },
      },
      museEvent(3, "started", { prompt: "Build the app" }),
      museEvent(4, "model_completed", {
        model: "muse-spark-1.2",
        usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
      }),
      museEvent(5, "assistant_tool_calls_committed", {
        tool_calls: [
          { call_id: "call-a", name: "bash", args: '{"command":"echo app"}' },
          { call_id: "call-b", name: "read_file", args: { path: "a.txt" } },
        ],
      }),
      museEvent(6, "tool_result_batch_committed", {
        results: [
          { tool_call_id: "call-b", text: "contents" },
          { tool_call_id: "call-a", text: "ok" },
        ],
      }),
      museEvent(7, "skill_read_observed", {
        skill_id: "expo-router",
        observed_at_sequence: 5,
        evidence_kind: "read_skill_tool",
        evidence_hash: "sha256:router",
      }),
      museEvent(8, "skill_read_observed", {
        skill_id: "expo-router",
        observed_at_sequence: 5,
        evidence_kind: "read_skill_tool",
        evidence_hash: "sha256:router",
      }),
      {
        durability: "ephemeral",
        ...museEvent(8.5, "skill_read_observed", {
          skill_id: "expo-transient",
          observed_at_sequence: 5,
          evidence_kind: "read_skill_tool",
          evidence_hash: "sha256:transient",
        }),
      },
      {
        sequence: 9,
        payload_type: "agent.skill_read.observed",
        payload: {
          skill_id: "bundled:read-session",
          observed_at_sequence: 9,
          evidence_kind: "read_skill_tool",
          evidence_hash: "sha256:bundled",
        },
      },
      museEvent(10, "assistant_message_committed", { text: "Finished." }),
      museEvent(11, "model_completed", {
        model: "muse-spark-1.2",
        usage: { input_tokens: 3, output_tokens: 1, cache_write_tokens: 5 },
      }),
      museEvent(12, "terminal", { terminal: "completed" }),
    ]);

    const [turns, metadata] = await parseMuseSession(session);
    expect(metadata).toEqual({
      id: "muse-session-1",
      cwd: "/workspace/muse-app",
      cli_version: "0.1.0",
      provider: "meta",
      model: "muse-spark-1.2",
    });
    expect(turns).toEqual([
      {
        turn_id: "muse-run-1",
        turn_index: 1,
        user_input: "Build the app",
        steps: [
          {
            text: "",
            reasoning: "",
            tool_calls: [
              { call_id: "call-a", name: "bash", args: { command: "echo app" }, output: "ok" },
              { call_id: "call-b", name: "read_file", args: { path: "a.txt" }, output: "contents" },
              {
                call_id: "skill:expo-router",
                name: "Skill",
                args: {
                  skill: "expo-router",
                  observed_at_sequence: 5,
                  evidence_kind: "read_skill_tool",
                  evidence_hash: "sha256:router",
                },
              },
              {
                call_id: "skill:bundled:read-session",
                name: "Skill",
                args: {
                  skill: "bundled:read-session",
                  observed_at_sequence: 9,
                  evidence_kind: "read_skill_tool",
                  evidence_hash: "sha256:bundled",
                },
              },
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
        model: "muse-spark-1.2",
        total_usage: {
          prompt_tokens: 13,
          completion_tokens: 5,
          tokens: 18,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 5,
        },
        final_output: "Finished.",
        completed: true,
        aborted: false,
      },
    ]);
  });
});

test("[CHAR] Muse parser skips malformed records and flushes an incomplete turn", async () => {
  await withTempDir(async (directory) => {
    const session = join(directory, "session.jsonl");
    await writeJsonl(session, [
      "not-json",
      museEvent(1, "started", { prompt: "unfinished" }, "open-run"),
      museEvent(2, "assistant_message_committed", { text: "still working" }, "open-run"),
    ]);

    const [turns, metadata] = await parseMuseSession(session);
    expect(metadata).toEqual({});
    expect(turns).toEqual([
      {
        turn_id: "open-run",
        turn_index: 1,
        user_input: "unfinished",
        steps: [{ text: "still working", reasoning: "", tool_calls: [] }],
        final_output: "still working",
        completed: false,
        aborted: false,
      },
    ]);
  });
});

test("[REGRESSION] Muse ignores interleaved task events while pairing run tool results", async () => {
  await withTempDir(async (directory) => {
    const session = join(directory, "session.jsonl");
    await writeJsonl(session, [
      museEvent(1, "started", { prompt: "Build the app" }),
      museEvent(2, "assistant_tool_calls_committed", {
        tool_calls: [{ call_id: "call-1", name: "read_file", args: { path: "app.json" } }],
      }),
      {
        sequence: 3,
        payload_type: "runtime.session",
        payload: {
          kind: "task",
          run_id: "muse-run-1",
          event: { kind: "started", task_id: "task-1", tool_call_id: "call-1" },
        },
      },
      museEvent(4, "tool_result_batch_committed", {
        results: [{ tool_call_id: "call-1", text: "contents" }],
      }),
      museEvent(5, "terminal", { terminal: "completed" }),
    ]);

    const [turns] = await parseMuseSession(session);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user_input).toBe("Build the app");
    expect(turns[0]?.steps[0]?.tool_calls).toEqual([
      {
        call_id: "call-1",
        name: "read_file",
        args: { path: "app.json" },
        output: "contents",
      },
    ]);
  });
});

test("[REGRESSION] Muse skill observations deduplicate across session turns", async () => {
  await withTempDir(async (directory) => {
    const session = join(directory, "session.jsonl");
    await writeJsonl(session, [
      museEvent(1, "started", { prompt: "first" }, "turn-one"),
      museEvent(2, "skill_read_observed", {
        skill_id: "expo-router",
        observed_at_sequence: 2,
        evidence_kind: "read_skill_tool",
        evidence_hash: "sha256:first",
      }, "turn-one"),
      museEvent(3, "terminal", { terminal: "completed" }, "turn-one"),
      museEvent(4, "started", { prompt: "second" }, "turn-two"),
      museEvent(5, "skill_read_observed", {
        skill_id: "expo-router",
        observed_at_sequence: 5,
        evidence_kind: "read_skill_tool",
        evidence_hash: "sha256:second",
      }, "turn-two"),
      museEvent(6, "terminal", { terminal: "completed" }, "turn-two"),
    ]);

    const [turns] = await parseMuseSession(session);
    expect(turns.map((turn) => turn.steps.flatMap((step) => step.tool_calls))).toEqual([
      [{ call_id: "skill:expo-router", name: "Skill", args: {
        skill: "expo-router",
        observed_at_sequence: 2,
        evidence_kind: "read_skill_tool",
        evidence_hash: "sha256:first",
      } }],
      [],
    ]);
  });
});

test("[CHAR] Muse reconstruction filters session files and writes its envelope", async () => {
  await withTempDir(async (directory) => {
    const dataRoot = join(directory, "data");
    const sessions = join(dataRoot, "muse", "sessions", "2026", "08", "07");
    await mkdir(sessions, { recursive: true });
    const old = join(sessions, "old", "session.jsonl");
    const selected = join(sessions, "selected", "session.jsonl");
    const upper = join(sessions, "upper", "session.jsonl");
    await Promise.all([mkdir(dirname(old), { recursive: true }), mkdir(dirname(selected), { recursive: true }), mkdir(dirname(upper), { recursive: true })]);
    await writeJsonl(old, [museEvent(1, "started", { prompt: "old" }, "old")]);
    await writeJsonl(selected, [museEvent(1, "started", { prompt: "selected" }, "selected")]);
    await writeJsonl(upper, [museEvent(1, "started", { prompt: "upper" }, "upper")]);
    await utimes(old, 10, 10);
    await utimes(selected, 20, 20);
    await utimes(upper, 30, 30);
    const out = join(directory, "out", "trace.json");

    expect(await findMuseSessions(dataRoot, 20, 30)).toEqual([selected]);
    const payload = await reconstructMuseSessions({
      dataRoot,
      outPath: out,
      sinceMtime: 20,
      beforeMtime: 30,
      runId: "run-muse",
      source: "muse-code-authoring",
      sessionName: "Muse Code Authoring Session",
    });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(payload);
    expect(payload).toMatchObject({
      agent: "muse-code",
      run_id: "run-muse",
      source: "muse-code-authoring",
      session_name: "Muse Code Authoring Session",
      n_sessions: 1,
    });
    expect(basename(String(payload.sessions[0]?.session))).toBe("session.jsonl");
  });
});

test("[REGRESSION] Muse reconstruction API and CLI default to authoring source", async () => {
  await withTempDir(async (directory) => {
    const dataRoot = join(directory, "data");
    const session = join(dataRoot, "muse", "sessions", "2026", "08", "07", "selected", "session.jsonl");
    await mkdir(dirname(session), { recursive: true });
    await writeJsonl(session, [museEvent(1, "started", { prompt: "selected" }, "selected")]);
    const apiOut = join(directory, "api.json");
    expect((await reconstructMuseSessions({ dataRoot, outPath: apiOut })).source).toBe("muse-code-authoring");

    const cliOut = join(directory, "cli.json");
    const result = await runCli([
      process.execPath,
      MUSE_SCRIPT,
      "--data-root", dataRoot,
      "--out", cliOut,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(cliOut, "utf8"))).toMatchObject({
      source: "muse-code-authoring",
    });
  });
});

test("[CHAR] discovery follows symlinks and keeps readable siblings", async () => {
  await withTempDir(async (directory) => {
    const claudeRoot = join(directory, "claude");
    const claudeTarget = join(directory, "claude-target");
    const codexRoot = join(directory, "codex");
    const codexTarget = join(directory, "codex-target");
    const blocked = join(claudeRoot, "blocked");
    await Promise.all([
      mkdir(claudeRoot),
      mkdir(claudeTarget),
      mkdir(codexRoot),
      mkdir(codexTarget),
    ]);
    await mkdir(blocked);

    const claudeFile = join(claudeTarget, "session.jsonl");
    const codexFile = join(codexTarget, "rollout-session.jsonl");
    await writeJsonl(claudeFile, [claudePrompt("linked")]);
    await writeJsonl(codexFile, [codexTaskStarted("linked")]);
    await writeJsonl(join(blocked, "hidden.jsonl"), [claudePrompt("hidden")]);
    await symlink(claudeFile, join(claudeRoot, "linked-file.jsonl"));
    await symlink(claudeTarget, join(claudeRoot, "linked-directory"));
    await symlink(codexFile, join(codexRoot, "rollout-linked-file.jsonl"));
    await symlink(codexTarget, join(codexRoot, "linked-directory"));
    await chmod(blocked, 0o000);

    try {
      const claude = await findTranscripts(claudeRoot);
      const codex = await findRollouts(codexRoot);
      expect(claude).toContain(join(claudeRoot, "linked-file.jsonl"));
      expect(claude).toContain(join(claudeRoot, "linked-directory", "session.jsonl"));
      expect(codex).toContain(join(codexRoot, "rollout-linked-file.jsonl"));
      expect(codex).toContain(join(codexRoot, "linked-directory", "rollout-session.jsonl"));
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});

test("[CHAR] Braintrust bridge forwards its payload and remains fail-open", async () => {
  await withTempDir(async (directory) => {
    const fakeUv = join(directory, "uv");
    const capture = join(directory, "braintrust-input.json");
    await writeFile(
      fakeUv,
      '#!/bin/sh\n/bin/cat > "$TRACE_BRIDGE_CAPTURE"\nexit "${TRACE_BRIDGE_EXIT:-0}"\n',
    );
    await chmod(fakeUv, 0o755);

    const previousPath = process.env.PATH;
    const previousCapture = process.env.TRACE_BRIDGE_CAPTURE;
    const previousExit = process.env.TRACE_BRIDGE_EXIT;
    const previousLog = console.log;
    const logs: string[] = [];
    process.env.PATH = directory;
    process.env.TRACE_BRIDGE_CAPTURE = capture;
    console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
    try {
      await emitBraintrustSession(
        [{ turn_id: "turn-1", turn_index: 1, user_input: "Build", steps: [] }],
        { id: "session-1" },
        "run-1",
        "claude-code-authoring",
        "Authoring",
      );
      expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
        turns: [{ turn_id: "turn-1", turn_index: 1, user_input: "Build", steps: [] }],
        session_meta: { id: "session-1" },
        run_id: "run-1",
        source: "claude-code-authoring",
        name: "Authoring",
      });

      process.env.TRACE_BRIDGE_EXIT = "7";
      await expect(
        emitBraintrustSession([], {}, null, "codex-authoring", null, "codex_rollout"),
      ).resolves.toBeUndefined();
      expect(logs).toContain("[codex_rollout] braintrust push failed: exit 7");
    } finally {
      console.log = previousLog;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.TRACE_BRIDGE_CAPTURE;
      else process.env.TRACE_BRIDGE_CAPTURE = previousCapture;
      if (previousExit === undefined) delete process.env.TRACE_BRIDGE_EXIT;
      else process.env.TRACE_BRIDGE_EXIT = previousExit;
    }
  });
});

test("[REGRESSION] real Braintrust bridge imports from the repository root", async () => {
  const previousApiKey = process.env.BRAINTRUST_API_KEY;
  const previousLog = console.log;
  const logs: string[] = [];
  delete process.env.BRAINTRUST_API_KEY;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  try {
    await emitBraintrustSession([], {}, null, "claude-code-authoring", null);
    expect(logs).toEqual([]);
  } finally {
    console.log = previousLog;
    if (previousApiKey === undefined) delete process.env.BRAINTRUST_API_KEY;
    else process.env.BRAINTRUST_API_KEY = previousApiKey;
  }
});

test("[CHAR] all parse-only CLIs emit the stable session envelope", async () => {
  await withTempDir(async (directory) => {
    const cases = [
      { script: CC_SCRIPT, records: [claudePrompt("hello")], expectedId: "session-1" },
      {
        script: CODEX_SCRIPT,
        records: [{ type: "session_meta", payload: { id: "codex-1" } }, codexTaskStarted()],
        expectedId: "codex-1",
      },
      {
        script: MUSE_SCRIPT,
        records: [
          { payload_type: "session.opened.observed", payload: { record: { session_id: "muse-1" } } },
          museEvent(1, "started", { prompt: "hello" }),
        ],
        expectedId: "muse-1",
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

test("[CHAR] parser CLIs preserve argparse help and accepted option forms", async () => {
  await withTempDir(async (directory) => {
    const cases = [
      {
        script: CC_SCRIPT,
        rootOption: `--proj=${directory}`,
        usage: "usage: cc_transcript.py [-h] [--projects-dir PROJECTS_DIR] --out OUT",
      },
      {
        script: CODEX_SCRIPT,
        rootOption: `--sessions=${directory}`,
        usage: "usage: codex_rollout.py [-h] [--sessions-dir SESSIONS_DIR] --out OUT",
      },
      {
        script: MUSE_SCRIPT,
        rootOption: `--data=${directory}`,
        usage: "usage: muse_session.py [-h] [--data-root DATA_ROOT] --out OUT",
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const help = await runCli([process.execPath, fixture.script, "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toStartWith(fixture.usage);

      const out = join(directory, `out-${index}.json`);
      const accepted = await runCli([
        process.execPath,
        fixture.script,
        fixture.rootOption,
        `--out=${out}`,
        "--since=0_0",
        "--before=inf",
        "--run=run-cli",
        "--source=source-cli",
        "--session-n=Session CLI",
      ]);
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stderr).toBe("");
      const output = await readFile(out, "utf8");
      expect(output).toContain('"run_id": "run-cli"');
      expect(output).toContain('"source": "source-cli"');
      expect(output).toContain('"session_name": "Session CLI"');
      expect(output).toContain('"before_mtime": Infinity');
    }
  });
});
