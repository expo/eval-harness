#!/usr/bin/env bun

/**
 * Reconstruct Codex rollout JSONL into the harness's normalized
 * turns -> steps -> tool_calls trace shape.
 */

import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  emitBraintrustSession,
  hasMeaningfulValue,
  parsePythonFloat,
  parsePythonJson,
  readJsonlRecords,
  stringifyPythonJson,
  type JsonRecord,
  type ToolCall,
  type TraceStep,
  type TraceTurn,
} from "./cc_transcript.ts";

type CodexReconstructionOptions = {
  sessionsDir: string;
  outPath: string;
  sinceMtime?: number;
  beforeMtime?: number;
  braintrust?: boolean;
  runId?: string | null;
  source?: string;
  sessionName?: string | null;
};

type PendingOutput = { output: unknown; error: unknown };

function optionalRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function recordOrPythonFallback(value: unknown, field: string): JsonRecord {
  if (!hasMeaningfulValue(value)) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new TypeError(`${field} must be an object when present`);
}

function firstMeaningfulValue(...values: unknown[]): unknown {
  return values.find((value) => hasMeaningfulValue(value));
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const output: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      output.push(part);
      continue;
    }
    const record = optionalRecord(part);
    const value = firstMeaningfulValue(record.text, record.output_text, record.input_text, "");
    output.push(typeof value === "string" ? value : "");
  }
  return output.join("");
}

function extractReasoning(payload: JsonRecord): string {
  if (hasMeaningfulValue(payload.content)) return extractText(payload.content);
  if (Array.isArray(payload.summary)) {
    return payload.summary.map((part) => extractText(part)).join(" ");
  }
  return "";
}

function isWrapper(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<user_instructions>");
}

function maybeJson(value: unknown): unknown {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string") {
    try {
      return parsePythonJson(value);
    } catch {
      return value;
    }
  }
  return value;
}

function usage(value: unknown): JsonRecord {
  const source = optionalRecord(value);
  const result: JsonRecord = {};
  if (source.input_tokens !== null && source.input_tokens !== undefined) {
    result.prompt_tokens = source.input_tokens;
  }
  if (source.output_tokens !== null && source.output_tokens !== undefined) {
    result.completion_tokens = source.output_tokens;
  }
  if (source.total_tokens !== null && source.total_tokens !== undefined) {
    result.tokens = source.total_tokens;
  }
  if (source.cached_input_tokens !== null && source.cached_input_tokens !== undefined) {
    result.cache_read_input_tokens = source.cached_input_tokens;
  }
  return result;
}

function toolError(payload: JsonRecord): unknown {
  return firstMeaningfulValue(
    payload.error,
    payload.codex_error_info,
    payload.stderr,
    payload.aggregated_output,
    hasMeaningfulValue(payload.exit_code) ? `Exit code: ${String(payload.exit_code)}` : "failed",
  );
}

function toolOutput(payload: JsonRecord): unknown {
  const direct = firstMeaningfulValue(
    payload.aggregated_output,
    payload.stdout,
    payload.result,
    payload.output,
  );
  if (direct !== undefined) return direct;
  const fallback: JsonRecord = {};
  for (const key of ["status", "query", "action", "call_id"]) {
    if (payload[key] !== null && payload[key] !== undefined) fallback[key] = payload[key];
  }
  return fallback;
}

export async function parseRollout(path: string): Promise<[TraceTurn[], JsonRecord]> {
  let sessionMeta: JsonRecord = {};
  const turns: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  let currentStep: TraceStep | undefined;
  let toolsById = new Map<unknown, ToolCall>();
  let pendingOutputs = new Map<unknown, PendingOutput>();
  let turnIndex = 0;

  const finishStep = (): void => {
    if (current !== undefined && currentStep !== undefined) {
      current.steps.push(currentStep);
      currentStep = undefined;
    }
  };

  const finishTurn = (completed: boolean, aborted: boolean): void => {
    if (current === undefined) return;
    finishStep();
    current.completed = completed;
    current.aborted = aborted;
    if (!hasMeaningfulValue(current.final_output)) {
      for (const step of [...current.steps].reverse()) {
        if (hasMeaningfulValue(step.text)) {
          current.final_output = step.text;
          break;
        }
      }
    }
    if (!hasMeaningfulValue(current.user_input)) {
      current.user_input = current.user_input_fallback ?? null;
    }
    turns.push(current);
    current = undefined;
    toolsById = new Map();
    pendingOutputs = new Map();
  };

  const attachPending = (toolCall: ToolCall): void => {
    const callId = toolCall.call_id;
    if (!hasMeaningfulValue(callId) || !pendingOutputs.has(callId)) return;
    const pending = pendingOutputs.get(callId);
    pendingOutputs.delete(callId);
    if (pending === undefined) return;
    if (hasMeaningfulValue(pending.error)) toolCall.error = pending.error;
    if (pending.output !== null && pending.output !== undefined) toolCall.output = pending.output;
  };

  for await (const record of readJsonlRecords(path)) {
    const type = record.type;
    if (
      type !== "session_meta" &&
      type !== "turn_context" &&
      type !== "response_item" &&
      type !== "event_msg"
    ) {
      continue;
    }
    const payload = recordOrPythonFallback(record.payload, "payload");

    if (type === "session_meta") {
      sessionMeta = payload;
      continue;
    }
    if (type === "turn_context" && current !== undefined) {
      current.model = firstMeaningfulValue(payload.model, current.model) ?? null;
      current.invocation_params = payload;
      continue;
    }
    if (type === "response_item") {
      if (current === undefined) continue;
      if (currentStep === undefined) {
        currentStep = { text: "", reasoning: "", tool_calls: [] };
      }
      const payloadType = payload.type;
      if (payloadType === "message") {
        const role = payload.role;
        const text = extractText(payload.content);
        if (role === "assistant") {
          currentStep.text += text;
        } else if ((role === "user" || role === "developer") && !isWrapper(text)) {
          if (!("user_input_fallback" in current)) current.user_input_fallback = text;
        }
      } else if (payloadType === "reasoning") {
        currentStep.reasoning += extractReasoning(payload);
      } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const argumentSource =
          payload.arguments !== null && payload.arguments !== undefined
            ? payload.arguments
            : payload.input;
        const toolCall: ToolCall = {
          call_id: payload.call_id ?? null,
          name: payload.name ?? null,
          args: maybeJson(argumentSource ?? null),
        };
        currentStep.tool_calls.push(toolCall);
        if (hasMeaningfulValue(toolCall.call_id)) {
          toolsById.set(toolCall.call_id, toolCall);
          attachPending(toolCall);
        }
      } else if (payloadType === "web_search_call") {
        const action = recordOrPythonFallback(payload.action, "action");
        const toolCall: ToolCall = {
          call_id: payload.id ?? null,
          name: "web_search",
          args: {
            query: action.query ?? null,
            queries: action.queries ?? null,
            action,
          },
        };
        currentStep.tool_calls.push(toolCall);
        if (hasMeaningfulValue(toolCall.call_id)) {
          toolsById.set(toolCall.call_id, toolCall);
          attachPending(toolCall);
        }
      } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const toolCall = toolsById.get(payload.call_id);
        if (toolCall !== undefined) toolCall.output = payload.output ?? null;
      }
      continue;
    }
    if (type !== "event_msg") continue;

    const payloadType = payload.type;
    if (payloadType === "task_started") {
      if (current !== undefined) finishTurn(false, false);
      turnIndex += 1;
      current = {
        turn_id: payload.turn_id ?? null,
        turn_index: turnIndex,
        steps: [],
        user_input: undefined,
      };
      currentStep = undefined;
      toolsById = new Map();
      pendingOutputs = new Map();
    } else if (payloadType === "user_message" && current !== undefined) {
      current.user_input = payload.message ?? null;
    } else if (payloadType === "agent_message" && current !== undefined) {
      current.final_output = payload.message ?? null;
    } else if (payloadType === "token_count" && current !== undefined) {
      const info = recordOrPythonFallback(payload.info, "info");
      current.total_usage = usage(info.total_token_usage);
      if (currentStep !== undefined) currentStep.usage = usage(info.last_token_usage);
      finishStep();
    } else if (payloadType === "task_complete") {
      finishTurn(true, false);
    } else if (payloadType === "turn_aborted") {
      finishTurn(true, true);
    } else if (
      typeof payloadType === "string" &&
      payloadType.endsWith("_end") &&
      hasMeaningfulValue(payload.call_id)
    ) {
      const toolCall = toolsById.get(payload.call_id);
      const output = toolOutput(payload);
      const error =
        payload.status === "failed" || payload.status === "declined"
          ? toolError(payload)
          : null;
      if (toolCall !== undefined) {
        if (hasMeaningfulValue(error)) toolCall.error = error;
        if (!hasMeaningfulValue(toolCall.output)) toolCall.output = output;
      } else {
        pendingOutputs.set(payload.call_id, { output, error });
      }
    }
  }

  if (current !== undefined) finishTurn(false, false);
  return [turns, sessionMeta];
}

async function walkRollouts(
  directory: string,
  ancestorDirectories: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const paths: string[] = [];
  let resolvedDirectory: string;
  let entries: Dirent<string>[];
  try {
    resolvedDirectory = await realpath(directory);
    if (ancestorDirectories.has(resolvedDirectory)) return [];
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nextAncestors = new Set(ancestorDirectories);
  nextAncestors.add(resolvedDirectory);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const target = await stat(path);
      if (target.isDirectory()) paths.push(...(await walkRollouts(path, nextAncestors)));
      else if (
        target.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        paths.push(path);
      }
    } catch {
      // A broken/inaccessible entry does not discard readable siblings.
    }
  }
  return paths;
}

export async function findRollouts(
  sessionsDir: string,
  sinceMtime = 0,
  beforeMtime?: number,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await walkRollouts(sessionsDir);
  } catch {
    return [];
  }
  const selected: Array<{ path: string; mtime: number }> = [];
  for (const path of candidates) {
    try {
      const mtime = (await stat(path)).mtimeMs / 1_000;
      if (mtime >= sinceMtime && (beforeMtime === undefined || mtime < beforeMtime)) {
        selected.push({ path, mtime });
      }
    } catch {
      // Ignore files that disappear during collection.
    }
  }
  selected.sort((left, right) => left.mtime - right.mtime);
  return selected.map(({ path }) => path);
}

export async function reconstructCodexRollouts(
  options: CodexReconstructionOptions,
): Promise<JsonRecord & { sessions: JsonRecord[] }> {
  const sinceMtime = options.sinceMtime ?? 0;
  const source = options.source ?? "codex";
  const runId = options.runId ?? null;
  const sessionName = options.sessionName ?? null;
  const rollouts = await findRollouts(options.sessionsDir, sinceMtime, options.beforeMtime);
  const sessions: JsonRecord[] = [];
  for (const rollout of rollouts) {
    try {
      const [turns, metadata] = await parseRollout(rollout);
      if (turns.length === 0) continue;
      sessions.push({ rollout, session_meta: metadata, turns });
      if (options.braintrust) {
        await emitBraintrustSession(
          turns,
          metadata,
          runId,
          source,
          sessionName,
          "codex_rollout",
        );
      }
    } catch (error) {
      console.log(`[codex_rollout] skip ${rollout}: ${String(error)}`);
    }
  }
  const payload = {
    agent: "codex",
    run_id: runId,
    source,
    session_name: sessionName,
    n_sessions: sessions.length,
    sessions_dir: options.sessionsDir,
    since_mtime: sinceMtime,
    before_mtime: options.beforeMtime ?? null,
    sessions,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, stringifyPythonJson(payload, 2));
  console.log(`[codex_rollout] ${sessions.length} session(s) -> ${options.outPath}`);
  return payload;
}

type ParsedArguments = {
  sessionsDir: string;
  outPath?: string;
  sinceMtime: number;
  beforeMtime?: number;
  braintrust: boolean;
  runId: string | null;
  source: string;
  sessionName: string | null;
};

const CODEX_HELP = `usage: codex_rollout.py [-h] [--sessions-dir SESSIONS_DIR] --out OUT
                        [--since-mtime SINCE_MTIME]
                        [--before-mtime BEFORE_MTIME] [--braintrust]
                        [--run-id RUN_ID] [--source SOURCE]
                        [--session-name SESSION_NAME]

Reconstruct Codex agent traces from rollouts.

options:
  -h, --help            show this help message and exit
  --sessions-dir SESSIONS_DIR
  --out OUT
  --since-mtime SINCE_MTIME
                        epoch seconds; only rollouts modified at/after are
                        included
  --before-mtime BEFORE_MTIME
                        epoch seconds; only rollouts modified before this time
                        are included
  --braintrust
  --run-id RUN_ID
  --source SOURCE
  --session-name SESSION_NAME`;

const CODEX_OPTIONS = [
  "--help",
  "--sessions-dir",
  "--out",
  "--since-mtime",
  "--before-mtime",
  "--braintrust",
  "--run-id",
  "--source",
  "--session-name",
] as const;

function resolveOption(name: string): (typeof CODEX_OPTIONS)[number] {
  const candidates = CODEX_OPTIONS.filter(
    (option) => option === name || option.startsWith(name),
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `unrecognized argument: ${name}`
        : `ambiguous option: ${name} could match ${candidates.join(", ")}`,
    );
  }
  return candidates[0] as (typeof CODEX_OPTIONS)[number];
}

function parseArguments(args: string[]): ParsedArguments | "help" {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const parsed: ParsedArguments = {
    sessionsDir: join(codexHome, "sessions"),
    sinceMtime: 0,
    braintrust: false,
    runId: null,
    source: process.env.TRACE_SOURCE ?? "codex",
    sessionName: process.env.TRACE_SESSION_NAME ?? null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h") return "help";
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`unrecognized argument: ${argument ?? ""}`);
    }
    const equalsIndex = argument.indexOf("=");
    const optionText = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const attachedValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const option = resolveOption(optionText);
    if (option === "--help") return "help";
    if (option === "--braintrust") {
      if (attachedValue !== undefined) throw new Error("argument --braintrust: ignored explicit argument");
      parsed.braintrust = true;
      continue;
    }
    const value = attachedValue ?? args[index + 1];
    if (value === undefined) {
      throw new Error(`argument ${option}: expected one argument`);
    }
    if (option === "--sessions-dir") parsed.sessionsDir = value;
    else if (option === "--out") parsed.outPath = value;
    else if (option === "--since-mtime" || option === "--before-mtime") {
      const numeric = parsePythonFloat(value);
      if (numeric === undefined) throw new Error(`argument ${option}: invalid float value: '${value}'`);
      if (option === "--since-mtime") parsed.sinceMtime = numeric;
      else parsed.beforeMtime = numeric;
    } else if (option === "--run-id") parsed.runId = value;
    else if (option === "--source") parsed.source = value;
    else if (option === "--session-name") parsed.sessionName = value;
    if (attachedValue === undefined) index += 1;
  }
  return parsed;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args[0] === "--parse-only" && args[1] !== undefined) {
    const [turns, metadata] = await parseRollout(args[1]);
    console.log(stringifyPythonJson({ session_meta: metadata, turns }, 2));
    return 0;
  }
  try {
    const parsed = parseArguments(args);
    if (parsed === "help") {
      console.log(CODEX_HELP);
      return 0;
    }
    if (parsed.outPath === undefined) throw new Error("the following arguments are required: --out");
    await reconstructCodexRollouts(parsed as CodexReconstructionOptions & { outPath: string });
    return 0;
  } catch (error) {
    console.error(`codex_rollout.ts: error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
