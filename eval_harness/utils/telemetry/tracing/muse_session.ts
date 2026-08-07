#!/usr/bin/env bun

/** Reconstruct durable Muse Code session JSONL into normalized agent traces. */

import { readdir, readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  emitBraintrustSession,
  parsePythonFloat,
  parsePythonJson,
  stringifyPythonJson,
  type JsonRecord,
  type ToolCall,
  type TraceStep,
  type TraceTurn,
} from "./cc_transcript.ts";

type MuseReconstructionOptions = {
  dataRoot: string;
  outPath: string;
  sinceMtime?: number;
  beforeMtime?: number;
  braintrust?: boolean;
  runId?: string | null;
  source?: string;
  sessionName?: string | null;
};

type TurnState = {
  turn: TraceTurn;
  step: TraceStep | undefined;
  toolsById: Map<unknown, ToolCall>;
  pendingResults: Map<unknown, { output: unknown; error: unknown }>;
};

function optionalRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && value !== false && value !== 0;
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return parsePythonJson(value);
  } catch {
    return value;
  }
}

function usage(value: unknown): JsonRecord {
  const source = optionalRecord(value);
  const result: JsonRecord = {};
  if (source.input_tokens !== undefined && source.input_tokens !== null) {
    result.prompt_tokens = source.input_tokens;
  }
  if (source.output_tokens !== undefined && source.output_tokens !== null) {
    result.completion_tokens = source.output_tokens;
  }
  if (
    typeof source.input_tokens === "number" &&
    typeof source.output_tokens === "number"
  ) {
    result.tokens = source.input_tokens + source.output_tokens;
  }
  if (source.cache_read_tokens !== undefined && source.cache_read_tokens !== null) {
    result.cache_read_input_tokens = source.cache_read_tokens;
  }
  if (source.cache_write_tokens !== undefined && source.cache_write_tokens !== null) {
    result.cache_creation_input_tokens = source.cache_write_tokens;
  }
  return result;
}

function addUsage(turn: TraceTurn, stepUsage: JsonRecord): void {
  const total = optionalRecord(turn.total_usage);
  turn.total_usage = total;
  for (const [key, value] of Object.entries(stepUsage)) {
    if (typeof value !== "number" && typeof value !== "bigint") continue;
    const previous = total[key];
    if (typeof previous === "number" && typeof value === "number") total[key] = previous + value;
    else if (typeof previous === "bigint" && typeof value === "bigint") total[key] = previous + value;
    else if (typeof previous === "bigint") total[key] = Number(previous) + Number(value);
    else total[key] = Number(previous ?? 0) + Number(value);
  }
}

function newStep(): TraceStep {
  return { text: "", reasoning: "", tool_calls: [] };
}

function ensureStep(state: TurnState): TraceStep {
  if (state.step === undefined) state.step = newStep();
  return state.step;
}

function finishStep(state: TurnState): void {
  if (state.step !== undefined) {
    state.turn.steps.push(state.step);
    state.step = undefined;
  }
}

function finishTurn(state: TurnState, completed: boolean, aborted: boolean): TraceTurn {
  finishStep(state);
  state.turn.completed = completed;
  state.turn.aborted = aborted;
  if (!truthy(state.turn.final_output)) {
    for (const step of [...state.turn.steps].reverse()) {
      if (truthy(step.text)) {
        state.turn.final_output = step.text;
        break;
      }
    }
  }
  return state.turn;
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const rawLine of (await readFile(path, "utf8")).split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      const parsed = parsePythonJson(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as JsonRecord);
      }
    } catch {
      // A partially-written durable JSONL record is not evidence against siblings.
    }
  }
  return records;
}

export async function parseMuseSession(path: string): Promise<[TraceTurn[], JsonRecord]> {
  const records = await readJsonl(path);
  const metadata: JsonRecord = {};
  const turns: TraceTurn[] = [];
  const active = new Map<string, TurnState>();
  const observedSkills = new Set<string>();
  let turnIndex = 0;

  const start = (runId: unknown, prompt: unknown): TurnState => {
    const key = String(runId ?? `unknown-${turnIndex + 1}`);
    const previous = active.get(key);
    if (previous !== undefined) turns.push(finishTurn(previous, false, false));
    turnIndex += 1;
    const state: TurnState = {
      turn: {
        turn_id: runId ?? null,
        turn_index: turnIndex,
        user_input: prompt ?? null,
        steps: [],
      },
      step: undefined,
      toolsById: new Map(),
      pendingResults: new Map(),
    };
    active.set(key, state);
    return state;
  };

  for (const record of records) {
    const payload = optionalRecord(record.payload);
    if (record.payload_type === "runtime.session.metadata") {
      const source = optionalRecord(payload.record);
      if (metadata.cwd === undefined) metadata.cwd = source.workspace_root ?? null;
      if (metadata.provider === undefined) metadata.provider = source.provider_id ?? null;
      if (metadata.model === undefined) metadata.model = source.model_id ?? null;
      const build = optionalRecord(source.build);
      if (metadata.cli_version === undefined) metadata.cli_version = build.semver ?? null;
      continue;
    }
    if (record.payload_type === "session.opened.observed") {
      const source = optionalRecord(payload.record);
      if (metadata.id === undefined) metadata.id = source.session_id ?? null;
      continue;
    }

    const isDirectSkill = record.payload_type === "agent.skill_read.observed";
    const event = isDirectSkill ? payload : optionalRecord(payload.event);
    const kind = isDirectSkill ? "skill_read_observed" : event.kind;
    if (kind === "skill_read_observed" && record.durability !== undefined && record.durability !== "durable") {
      continue;
    }
    const runId = payload.run_id;
    const state = active.get(String(runId)) ?? (isDirectSkill && active.size === 1
      ? active.values().next().value
      : undefined);

    if (kind === "started") {
      start(runId, event.prompt);
      continue;
    }
    if (state === undefined) continue;

    if (kind === "model_completed") {
      if (state.step !== undefined && truthy(state.step.text)) {
        const stepUsage = usage(event.usage);
        if (Object.keys(stepUsage).length > 0) {
          state.step.usage = stepUsage;
          addUsage(state.turn, stepUsage);
        }
        if (truthy(event.model)) state.turn.model = event.model;
        continue;
      }
      if (state.step !== undefined && (state.step.tool_calls.length > 0 || state.step.usage !== undefined)) {
        finishStep(state);
      }
      const step = ensureStep(state);
      const stepUsage = usage(event.usage);
      if (Object.keys(stepUsage).length > 0) {
        step.usage = stepUsage;
        addUsage(state.turn, stepUsage);
      }
      if (truthy(event.model)) state.turn.model = event.model;
      continue;
    }

    if (kind === "assistant_tool_calls_committed") {
      const step = ensureStep(state);
      for (const rawTool of Array.isArray(event.tool_calls) ? event.tool_calls : []) {
        const tool = optionalRecord(rawTool);
        const call: ToolCall = {
          call_id: tool.call_id ?? tool.id ?? null,
          name: tool.name ?? null,
          args: maybeJson(tool.args),
        };
        step.tool_calls.push(call);
        if (truthy(call.call_id)) {
          state.toolsById.set(call.call_id, call);
          const pending = state.pendingResults.get(call.call_id);
          if (pending !== undefined) {
            state.pendingResults.delete(call.call_id);
            if (truthy(pending.error)) call.error = pending.error;
            if (pending.output !== undefined && pending.output !== null) call.output = pending.output;
          }
        }
      }
      continue;
    }

    if (kind === "tool_result_batch_committed") {
      for (const rawResult of Array.isArray(event.results) ? event.results : []) {
        const result = optionalRecord(rawResult);
        const callId = result.tool_call_id ?? result.call_id;
        if (!truthy(callId)) continue;
        const output = result.text ?? result.output ?? null;
        const error = result.error ?? (result.status === "failed" ? output : null);
        const call = state.toolsById.get(callId);
        if (call !== undefined) {
          if (output !== null && output !== undefined) call.output = output;
          if (truthy(error)) call.error = error;
        } else {
          state.pendingResults.set(callId, { output, error });
        }
      }
      continue;
    }

    if (kind === "skill_read_observed") {
      const skillId = typeof event.skill_id === "string" ? event.skill_id : "";
      if (skillId === "" || observedSkills.has(skillId)) continue;
      observedSkills.add(skillId);
      ensureStep(state).tool_calls.push({
        call_id: `skill:${skillId}`,
        name: "Skill",
        args: {
          skill: skillId,
          observed_at_sequence: event.observed_at_sequence ?? null,
          evidence_kind: event.evidence_kind ?? null,
          evidence_hash: event.evidence_hash ?? null,
        },
      });
      continue;
    }

    if (kind === "assistant_message_committed") {
      if (state.step !== undefined && state.step.tool_calls.length > 0) finishStep(state);
      ensureStep(state).text += typeof event.text === "string" ? event.text : "";
      continue;
    }

    if (kind === "terminal") {
      const completed = event.terminal === "completed";
      turns.push(finishTurn(state, completed, !completed));
      active.delete(String(runId));
    }
  }

  for (const state of active.values()) turns.push(finishTurn(state, false, false));
  if (Object.keys(metadata).length > 0) {
    for (const key of ["id", "cwd", "cli_version", "provider", "model"]) {
      if (!(key in metadata)) metadata[key] = null;
    }
  }
  return [turns, metadata];
}

async function walkSessions(
  directory: string,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  let resolved: string;
  let entries: Dirent<string>[];
  try {
    resolved = await realpath(directory);
    if (ancestors.has(resolved)) return [];
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const next = new Set(ancestors);
  next.add(resolved);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const target = await stat(path);
      if (target.isDirectory()) paths.push(...(await walkSessions(path, next)));
      else if (target.isFile() && entry.name === "session.jsonl") paths.push(path);
    } catch {
      // Preserve readable siblings when a session path disappears mid-walk.
    }
  }
  return paths;
}

export async function findMuseSessions(
  dataRoot: string,
  sinceMtime = 0,
  beforeMtime?: number,
): Promise<string[]> {
  const candidates = await walkSessions(join(dataRoot, "muse", "sessions"));
  const selected: Array<{ path: string; mtime: number }> = [];
  for (const path of candidates) {
    try {
      const mtime = (await stat(path)).mtimeMs / 1_000;
      if (mtime >= sinceMtime && (beforeMtime === undefined || mtime < beforeMtime)) {
        selected.push({ path, mtime });
      }
    } catch {
      // Ignore a session that is concurrently removed.
    }
  }
  selected.sort((left, right) => left.mtime - right.mtime);
  return selected.map(({ path }) => path);
}

export async function reconstructMuseSessions(
  options: MuseReconstructionOptions,
): Promise<JsonRecord & { sessions: JsonRecord[] }> {
  const sinceMtime = options.sinceMtime ?? 0;
  const source = options.source ?? "muse-code-authoring";
  const runId = options.runId ?? null;
  const sessionName = options.sessionName ?? null;
  const sessions: JsonRecord[] = [];
  for (const session of await findMuseSessions(options.dataRoot, sinceMtime, options.beforeMtime)) {
    try {
      const [turns, metadata] = await parseMuseSession(session);
      if (turns.length === 0) continue;
      sessions.push({ session, session_meta: metadata, turns });
      if (options.braintrust) {
        await emitBraintrustSession(turns, metadata, runId, source, sessionName, "muse_session");
      }
    } catch (error) {
      console.log(`[muse_session] skip ${session}: ${String(error)}`);
    }
  }
  const payload = {
    agent: "muse-code",
    run_id: runId,
    source,
    session_name: sessionName,
    n_sessions: sessions.length,
    data_root: options.dataRoot,
    since_mtime: sinceMtime,
    before_mtime: options.beforeMtime ?? null,
    sessions,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, stringifyPythonJson(payload, 2));
  console.log(`[muse_session] ${sessions.length} session(s) -> ${options.outPath}`);
  return payload;
}

type ParsedArguments = Omit<MuseReconstructionOptions, "outPath"> & { outPath?: string; sinceMtime: number; braintrust: boolean; runId: string | null; source: string; sessionName: string | null };

const MUSE_HELP = `usage: muse_session.py [-h] [--data-root DATA_ROOT] --out OUT
                        [--since-mtime SINCE_MTIME]
                        [--before-mtime BEFORE_MTIME] [--braintrust]
                        [--run-id RUN_ID] [--source SOURCE]
                        [--session-name SESSION_NAME]

Reconstruct Muse Code agent traces from durable sessions.

options:
  -h, --help            show this help message and exit
  --data-root DATA_ROOT
  --out OUT
  --since-mtime SINCE_MTIME
  --before-mtime BEFORE_MTIME
  --braintrust
  --run-id RUN_ID
  --source SOURCE
  --session-name SESSION_NAME`;

const OPTIONS = ["--help", "--data-root", "--out", "--since-mtime", "--before-mtime", "--braintrust", "--run-id", "--source", "--session-name"] as const;

function resolveOption(name: string): (typeof OPTIONS)[number] {
  const candidates = OPTIONS.filter((option) => option === name || option.startsWith(name));
  if (candidates.length !== 1) throw new Error(candidates.length === 0 ? `unrecognized argument: ${name}` : `ambiguous option: ${name} could match ${candidates.join(", ")}`);
  return candidates[0] as (typeof OPTIONS)[number];
}

function parseArguments(args: string[]): ParsedArguments | "help" {
  const parsed: ParsedArguments = {
    dataRoot: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    sinceMtime: 0,
    braintrust: false,
    runId: null,
    source: process.env.TRACE_SOURCE ?? "muse-code-authoring",
    sessionName: process.env.TRACE_SESSION_NAME ?? null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h") return "help";
    if (argument === undefined || !argument.startsWith("--")) throw new Error(`unrecognized argument: ${argument ?? ""}`);
    const equals = argument.indexOf("=");
    const option = resolveOption(equals === -1 ? argument : argument.slice(0, equals));
    const attached = equals === -1 ? undefined : argument.slice(equals + 1);
    if (option === "--help") return "help";
    if (option === "--braintrust") {
      if (attached !== undefined) throw new Error("argument --braintrust: ignored explicit argument");
      parsed.braintrust = true;
      continue;
    }
    const value = attached ?? args[index + 1];
    if (value === undefined) throw new Error(`argument ${option}: expected one argument`);
    if (option === "--data-root") parsed.dataRoot = value;
    else if (option === "--out") parsed.outPath = value;
    else if (option === "--since-mtime" || option === "--before-mtime") {
      const numeric = parsePythonFloat(value);
      if (numeric === undefined) throw new Error(`argument ${option}: invalid float value: '${value}'`);
      if (option === "--since-mtime") parsed.sinceMtime = numeric;
      else parsed.beforeMtime = numeric;
    } else if (option === "--run-id") parsed.runId = value;
    else if (option === "--source") parsed.source = value;
    else if (option === "--session-name") parsed.sessionName = value;
    if (attached === undefined) index += 1;
  }
  return parsed;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args[0] === "--parse-only" && args[1] !== undefined) {
    const [turns, metadata] = await parseMuseSession(args[1]);
    console.log(stringifyPythonJson({ session_meta: metadata, turns }, 2));
    return 0;
  }
  try {
    const parsed = parseArguments(args);
    if (parsed === "help") {
      console.log(MUSE_HELP);
      return 0;
    }
    if (parsed.outPath === undefined) throw new Error("the following arguments are required: --out");
    await reconstructMuseSessions(parsed as MuseReconstructionOptions);
    return 0;
  } catch (error) {
    console.error(`muse_session.ts: error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main());
