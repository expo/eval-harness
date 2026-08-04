#!/usr/bin/env bun

/**
 * Reconstruct Claude Code JSONL transcripts into the harness's normalized
 * turns -> steps -> tool_calls trace shape. Human messages delimit turns;
 * tool-result blocks attach to tool-use blocks only through their matching ID.
 */

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type JsonRecord = Record<string, unknown>;
export type ToolCall = JsonRecord & {
  call_id: unknown;
  name: unknown;
  args: unknown;
};
export type TraceStep = JsonRecord & {
  text: string;
  reasoning: string;
  tool_calls: ToolCall[];
};
export type TraceTurn = JsonRecord & {
  turn_id: unknown;
  turn_index: number;
  user_input: unknown;
  steps: TraceStep[];
};

type ClaudeReconstructionOptions = {
  projectsDir: string;
  outPath: string;
  sinceMtime?: number;
  beforeMtime?: number;
  braintrust?: boolean;
  runId?: string | null;
  source?: string;
  sessionName?: string | null;
};

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a JSON object record");
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function blocks(content: unknown): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function isRealUser(message: JsonRecord): boolean {
  return !blocks(message.content).some((block) => {
    const record = optionalRecord(block);
    return record.type === "tool_result";
  });
}

function userText(message: JsonRecord): string {
  const parts: string[] = [];
  for (const block of blocks(message.content)) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const record = optionalRecord(block);
    if (record.type === "text") {
      parts.push(typeof record.text === "string" ? record.text : "");
    }
  }
  return parts.join("");
}

function addTokenValues(left: unknown, right: unknown): unknown {
  if (typeof left === "number" && typeof right === "number") {
    return left + right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left + right;
  }
  throw new TypeError("token values cannot be added");
}

function usage(value: unknown): JsonRecord {
  const source = optionalRecord(value);
  const result: JsonRecord = {};
  const inputTokens = source.input_tokens;
  const outputTokens = source.output_tokens;
  if (inputTokens !== null && inputTokens !== undefined) {
    result.prompt_tokens = inputTokens;
  }
  if (outputTokens !== null && outputTokens !== undefined) {
    result.completion_tokens = outputTokens;
  }
  if (
    inputTokens !== null &&
    inputTokens !== undefined &&
    outputTokens !== null &&
    outputTokens !== undefined
  ) {
    result.tokens = addTokenValues(inputTokens, outputTokens);
  }
  if (source.cache_read_input_tokens !== null && source.cache_read_input_tokens !== undefined) {
    result.cache_read_input_tokens = source.cache_read_input_tokens;
  }
  if (
    source.cache_creation_input_tokens !== null &&
    source.cache_creation_input_tokens !== undefined
  ) {
    result.cache_creation_input_tokens = source.cache_creation_input_tokens;
  }
  return result;
}

function pythonString(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "\\\\";
    else if (character === "\b") result += "\\b";
    else if (character === "\f") result += "\\f";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (codePoint >= 0x20 && codePoint <= 0x7e) result += character;
    else if (codePoint <= 0xffff) result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else {
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return `${result}"`;
}

function pythonJsonDumps(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return pythonString(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonDumps(item)).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${pythonString(key)}: ${pythonJsonDumps(item)}`)
      .join(", ")}}`;
  }
  return pythonString(String(value));
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const rawLine of (await readFile(path, "utf8")).split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      records.push(asRecord(JSON.parse(line)));
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return records;
}

export async function parseTranscript(path: string): Promise<[TraceTurn[], JsonRecord]> {
  const records = await readJsonl(path);
  let sessionMeta: JsonRecord = {};
  const turns: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  let toolsById = new Map<unknown, ToolCall>();
  let turnIndex = 0;

  const finishTurn = (): void => {
    if (current === undefined) return;
    if (!current.final_output) {
      for (const step of [...current.steps].reverse()) {
        if (step.text) {
          current.final_output = step.text;
          break;
        }
      }
    }
    turns.push(current);
    current = undefined;
    toolsById = new Map();
  };

  for (const record of records) {
    const type = record.type;
    if ((type === "user" || type === "assistant") && Object.keys(sessionMeta).length === 0) {
      sessionMeta = {
        id: record.sessionId ?? null,
        cwd: record.cwd ?? null,
        cli_version: record.version ?? null,
        git_branch: record.gitBranch ?? null,
      };
    }
    const message = optionalRecord(record.message);

    if (type === "user") {
      if (isRealUser(message)) {
        finishTurn();
        turnIndex += 1;
        current = {
          turn_id: record.uuid ?? null,
          turn_index: turnIndex,
          user_input: userText(message),
          steps: [],
        };
        toolsById = new Map();
      } else if (current !== undefined) {
        for (const block of blocks(message.content)) {
          const result = optionalRecord(block);
          if (result.type !== "tool_result") continue;
          const toolCall = toolsById.get(result.tool_use_id);
          if (toolCall === undefined) continue;
          const content = result.content;
          toolCall.output = typeof content === "string" ? content : pythonJsonDumps(content);
          if (result.is_error) toolCall.error = toolCall.output;
        }
      }
      continue;
    }

    if (type !== "assistant") continue;
    if (current === undefined) {
      turnIndex += 1;
      current = {
        turn_id: record.uuid ?? null,
        turn_index: turnIndex,
        user_input: null,
        steps: [],
      };
      toolsById = new Map();
    }
    const step: TraceStep = {
      text: "",
      reasoning: "",
      tool_calls: [],
      usage: usage(message.usage),
    };
    if (message.model) current.model = message.model;
    for (const block of blocks(message.content)) {
      const item = optionalRecord(block);
      if (item.type === "text") {
        step.text += typeof item.text === "string" ? item.text : "";
      } else if (item.type === "thinking") {
        step.reasoning += typeof item.thinking === "string" ? item.thinking : "";
      } else if (item.type === "tool_use") {
        const toolCall: ToolCall = {
          call_id: item.id ?? null,
          name: item.name ?? null,
          args: item.input ?? null,
        };
        step.tool_calls.push(toolCall);
        if (toolCall.call_id) toolsById.set(toolCall.call_id, toolCall);
      }
    }
    current.steps.push(step);
    const totalUsage = optionalRecord(current.total_usage);
    current.total_usage = totalUsage;
    for (const [key, value] of Object.entries(optionalRecord(step.usage))) {
      if (typeof value === "number") {
        const previous = totalUsage[key];
        totalUsage[key] = (typeof previous === "number" ? previous : 0) + value;
      }
    }
  }

  finishTurn();
  return [turns, sessionMeta];
}

async function walkJsonl(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walkJsonl(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
  }
  return paths;
}

export async function findTranscripts(
  projectsDir: string,
  sinceMtime = 0,
  beforeMtime?: number,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await walkJsonl(projectsDir);
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
      // A disappearing transcript is ignored just like Python's glob/stat loop.
    }
  }
  selected.sort((left, right) => left.mtime - right.mtime);
  return selected.map(({ path }) => path);
}

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const BRAINTRUST_BRIDGE = `
import json, sys
from eval_harness.utils.telemetry.tracing import bt_emit
payload = json.load(sys.stdin)
bt_emit.log_session(payload["turns"], payload["session_meta"], run_id=payload.get("run_id"), source=payload.get("source", "agent"), name=payload.get("name"))
`;

export async function emitBraintrustSession(
  turns: TraceTurn[],
  metadata: JsonRecord,
  runId: string | null,
  source: string,
  name: string | null,
  caller = "cc_transcript",
): Promise<void> {
  const uv = Bun.which("uv");
  const python = Bun.which("python3") ?? Bun.which("python");
  const command = uv
    ? [uv, "run", "python", "-c", BRAINTRUST_BRIDGE]
    : python
      ? [python, "-c", BRAINTRUST_BRIDGE]
      : undefined;
  if (command === undefined) {
    console.log(`[${caller}] braintrust push failed: no Python interpreter found`);
    return;
  }
  try {
    const child = Bun.spawn(command, {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    child.stdin.write(JSON.stringify({ turns, session_meta: metadata, run_id: runId, source, name }));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (stdout) process.stdout.write(stdout);
    if (exitCode !== 0) {
      console.log(`[${caller}] braintrust push failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
  } catch (error) {
    console.log(`[${caller}] braintrust push failed: ${String(error)}`);
  }
}

export async function reconstructClaudeTranscripts(
  options: ClaudeReconstructionOptions,
): Promise<JsonRecord & { sessions: JsonRecord[] }> {
  const sinceMtime = options.sinceMtime ?? 0;
  const source = options.source ?? "claude-code";
  const runId = options.runId ?? null;
  const sessionName = options.sessionName ?? null;
  const transcripts = await findTranscripts(options.projectsDir, sinceMtime, options.beforeMtime);
  const sessions: JsonRecord[] = [];
  for (const transcript of transcripts) {
    try {
      const [turns, metadata] = await parseTranscript(transcript);
      if (turns.length === 0) continue;
      sessions.push({ transcript, session_meta: metadata, turns });
      if (options.braintrust) {
        await emitBraintrustSession(turns, metadata, runId, source, sessionName);
      }
    } catch (error) {
      console.log(`[cc_transcript] skip ${transcript}: ${String(error)}`);
    }
  }
  const payload = {
    agent: "claude-code",
    run_id: runId,
    source,
    session_name: sessionName,
    n_sessions: sessions.length,
    projects_dir: options.projectsDir,
    since_mtime: sinceMtime,
    before_mtime: options.beforeMtime ?? null,
    sessions,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, JSON.stringify(payload, null, 2));
  console.log(`[cc_transcript] ${sessions.length} session(s) -> ${options.outPath}`);
  return payload;
}

type ParsedArguments = {
  projectsDir: string;
  outPath?: string;
  sinceMtime: number;
  beforeMtime?: number;
  braintrust: boolean;
  runId: string | null;
  source: string;
  sessionName: string | null;
};

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    projectsDir: join(homedir(), ".claude", "projects"),
    sinceMtime: 0,
    braintrust: false,
    runId: null,
    source: process.env.TRACE_SOURCE ?? "claude-code",
    sessionName: process.env.TRACE_SESSION_NAME ?? null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--braintrust") {
      parsed.braintrust = true;
      continue;
    }
    const value = args[index + 1];
    if (argument === undefined || value === undefined) {
      throw new Error(`unrecognized or incomplete argument: ${argument ?? ""}`);
    }
    if (argument === "--projects-dir") parsed.projectsDir = value;
    else if (argument === "--out") parsed.outPath = value;
    else if (argument === "--since-mtime") {
      parsed.sinceMtime = Number(value);
      if (Number.isNaN(parsed.sinceMtime)) throw new Error(`invalid number for ${argument}: ${value}`);
    } else if (argument === "--before-mtime") {
      parsed.beforeMtime = Number(value);
      if (Number.isNaN(parsed.beforeMtime)) throw new Error(`invalid number for ${argument}: ${value}`);
    } else if (argument === "--run-id") parsed.runId = value;
    else if (argument === "--source") parsed.source = value;
    else if (argument === "--session-name") parsed.sessionName = value;
    else throw new Error(`unrecognized argument: ${argument}`);
    index += 1;
  }
  return parsed;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args[0] === "--parse-only" && args[1] !== undefined) {
    const [turns, metadata] = await parseTranscript(args[1]);
    console.log(JSON.stringify({ session_meta: metadata, turns }, null, 2));
    return 0;
  }
  try {
    const parsed = parseArguments(args);
    if (parsed.outPath === undefined) throw new Error("the following arguments are required: --out");
    await reconstructClaudeTranscripts(parsed as ClaudeReconstructionOptions & { outPath: string });
    return 0;
  } catch (error) {
    console.error(`cc_transcript.ts: error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
